package com.codec47.assistant

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.PixelFormat
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.ToneGenerator
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.view.Gravity
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.TextView
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/**
 * Servicio principal de CODEC 47:
 *  - conexión en tiempo real con el servidor,
 *  - activación por voz diciendo "Codec" (offline, también con la pantalla apagada),
 *  - reconocimiento de la orden, voz de respuesta (la misma que en la web) y conversación continua,
 *  - burbuja flotante.
 */
class AssistantService : Service(), Hub.Listener {
    companion object {
        @Volatile var instance: AssistantService? = null
        private const val CHANNEL = "codec47"

        fun start(ctx: Context, fromBoot: Boolean = false) {
            ctx.startForegroundService(Intent(ctx, AssistantService::class.java).putExtra("fromBoot", fromBoot))
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, AssistantService::class.java))
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var executor: CommandExecutor
    private lateinit var wake: WakeWord
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var speaking = false
    private var focusRequest: AudioFocusRequest? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private var statusOverride: String? = null
    private var currentTypes = 0

    private var bubble: LinearLayout? = null
    private var bubbleText: TextView? = null
    private var orb: TextView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        executor = CommandExecutor(this)
        wake = WakeWord(this)
        createChannel()
        val googleTts = try { packageManager.getPackageInfo("com.google.android.tts", 0); "com.google.android.tts" } catch (e: Exception) { null }
        tts = TextToSpeech(this, { st -> if (st == TextToSpeech.SUCCESS) { setupLocalVoice(); ttsReady = true } }, googleTts)
        tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(id: String?) {}
            override fun onDone(id: String?) = onSpeechDone()
            @Deprecated("Deprecated in Java")
            override fun onError(id: String?) = onSpeechDone()
        })
        Hub.commandHandler = { id, action, params -> executor.handle(id, action, params) }
        Hub.listeners.add(this)
        Hub.start(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val fromBoot = intent?.getBooleanExtra("fromBoot", false) == true
        var types = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        // Micrófono/cámara/ubicación solo se pueden declarar si el usuario abrió la app (no desde el arranque)
        if (!fromBoot) {
            if (has(Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (has(Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            if (has(Manifest.permission.ACCESS_FINE_LOCATION)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        // Nunca bajar permisos a un servicio que ya corre con micrófono (p. ej. un BOOT_COMPLETED tardío)
        if (fromBoot && currentTypes != 0) types = currentTypes
        android.util.Log.i("CODEC47", "onStartCommand fromBoot=$fromBoot types=$types")
        try {
            startForeground(1, buildNotification(), types)
            currentTypes = types
        } catch (e: Exception) {
            android.util.Log.w("CODEC47", "startForeground con micrófono falló: ${e.message}")
            startForeground(1, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            currentTypes = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
        }
        showBubble()
        Hub.start(this)
        if (!fromBoot) applyWakeMode()
        main.removeCallbacks(updateCheck)
        main.postDelayed(updateCheck, 20_000)
        return START_STICKY
    }

    override fun onDestroy() {
        Hub.listeners.remove(this)
        Hub.commandHandler = null
        Hub.stop()
        wake.stop()
        releaseWakeLock()
        recognizer?.destroy()
        stopPlayback()
        tts?.shutdown()
        bubble?.let { getSystemService(WindowManager::class.java).removeView(it) }
        instance = null
        super.onDestroy()
    }

    private val updateCheck = object : Runnable {
        override fun run() {
            Updater.checkInBackground(this@AssistantService)
            main.postDelayed(this, 6 * 3600_000L)
        }
    }

    private fun has(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED
    private fun screenOn() = getSystemService(PowerManager::class.java).isInteractive

    // ---------------- Activación por voz ("Codec") ----------------

    /** Enciende o apaga la escucha de la palabra según la preferencia del usuario. */
    fun applyWakeMode() {
        if (Prefs.handsFree(this) && has(Manifest.permission.RECORD_AUDIO)) {
            acquireWakeLock()
            if (!listening && !speaking) wake.start()
        } else {
            wake.stop()
            releaseWakeLock()
        }
        refreshNotification()
    }

    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        if (wakeLock?.isHeld == true) return
        // Mantiene la CPU despierta (no la pantalla) para escuchar "Codec" con la pantalla apagada
        wakeLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "codec47:wake")
            .apply { setReferenceCounted(false); acquire() }
    }

    private fun releaseWakeLock() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
    }

    private fun resumeWake() {
        if (Prefs.handsFree(this) && !listening && !speaking) wake.start()
    }

    /** Llamado por WakeWord al oír "Codec …". [rest] = lo que dijo después en la misma frase. */
    fun onWake(rest: String) {
        beep()
        if (rest.split(" ").count { it.isNotBlank() } >= 2) sendToAssistant(rest) // "Codec, pon música"
        else captureCommand(followUp = false) // solo "Codec": escucha la orden
    }

    /** Orden capturada por Vosk (pantalla apagada). */
    fun onWakeCommand(text: String) = sendToAssistant(text)

    /** Escucha la orden: con pantalla encendida usa el reconocedor de Google (más preciso); apagada, Vosk. */
    fun captureCommand(followUp: Boolean) {
        if (screenOn()) {
            wake.pause()
            listen(followUp)
        } else {
            if (!Prefs.handsFree(this)) return // pantalla apagada sin activación por voz: nada que escuchar
            showText(if (followUp) "¿Algo más?" else "Te escucho…", 8000)
            wake.awaitCommand(if (followUp) 7000 else 9000)
            wake.start()
        }
    }

    private fun beep() {
        try {
            val tg = ToneGenerator(AudioManager.STREAM_MUSIC, 60)
            tg.startTone(ToneGenerator.TONE_PROP_ACK, 120)
            main.postDelayed({ tg.release() }, 400)
        } catch (_: Exception) {}
    }

    // ---------------- Notificación ----------------
    private fun createChannel() {
        getSystemService(NotificationManager::class.java)
            .createNotificationChannel(NotificationChannel(CHANNEL, "CODEC 47", NotificationManager.IMPORTANCE_LOW))
    }

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val talk = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java).putExtra("listen", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val text = statusOverride ?: when {
            Hub.status != "conectado" -> Hub.status.replaceFirstChar { it.uppercase() }
            Prefs.handsFree(this) -> "Di “Codec” para hablar"
            else -> "Conectado"
        }
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_logo)
            .setContentTitle("CODEC 47")
            .setContentText(text)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Hablar", talk).build())
            .setOngoing(true)
            .build()
    }

    private fun refreshNotification() =
        getSystemService(NotificationManager::class.java).notify(1, buildNotification())

    /** Texto temporal en la notificación (ej. descargando el modelo). null = normal. */
    fun setStatusText(text: String?) {
        main.post {
            statusOverride = text
            refreshNotification()
            if (text != null) showText(text, 6000)
        }
    }

    override fun onStatus(status: String) {
        refreshNotification()
        orb?.alpha = if (status == "conectado") 1f else 0.45f
    }

    // Respuesta del servidor
    private var expectVoiceReply = false

    override fun onChatReply(text: String) {
        showText(text)
        speak(text, followUp = expectVoiceReply)
        expectVoiceReply = false
    }

    // ---------------- Burbuja flotante ----------------
    @SuppressLint("ClickableViewAccessibility")
    private fun showBubble() {
        if (bubble != null || !Settings.canDrawOverlays(this)) return
        val wm = getSystemService(WindowManager::class.java)
        val dp = resources.displayMetrics.density

        val o = TextView(this).apply {
            text = "47"
            textSize = 15f
            typeface = Typeface.DEFAULT_BOLD
            setTextColor(0xFFFFFFFF.toInt())
            gravity = Gravity.CENTER
            background = GradientDrawable().apply {
                shape = GradientDrawable.OVAL
                setColor(0xF00A0A0A.toInt())
                setStroke((2 * dp).toInt(), 0xFFFFFFFF.toInt())
            }
            layoutParams = LinearLayout.LayoutParams((52 * dp).toInt(), (52 * dp).toInt())
            elevation = 8 * dp
        }
        val t = TextView(this).apply {
            setTextColor(0xFFEDEDED.toInt())
            textSize = 14f
            maxWidth = (250 * dp).toInt()
            setPadding((14 * dp).toInt(), (10 * dp).toInt(), (14 * dp).toInt(), (10 * dp).toInt())
            background = GradientDrawable().apply {
                setColor(0xF2111111.toInt())
                cornerRadius = 14 * dp
                setStroke((1 * dp).toInt(), 0xFF262626.toInt())
            }
            visibility = TextView.GONE
        }
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(o)
            addView(t, LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
                marginStart = (8 * dp).toInt()
            })
        }
        val lp = WindowManager.LayoutParams(
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = (8 * dp).toInt()
            y = (200 * dp).toInt()
        }

        // Arrastrar; toque corto = hablar / detener; toque largo = abrir la app
        var sx = 0; var sy = 0; var tx = 0f; var ty = 0f; var down = 0L; var moved = false
        o.setOnTouchListener { _, e ->
            when (e.action) {
                MotionEvent.ACTION_DOWN -> { sx = lp.x; sy = lp.y; tx = e.rawX; ty = e.rawY; down = System.currentTimeMillis(); moved = false }
                MotionEvent.ACTION_MOVE -> {
                    val dx = e.rawX - tx; val dy = e.rawY - ty
                    if (abs(dx) > 10 || abs(dy) > 10) moved = true
                    lp.x = sx + dx.toInt(); lp.y = sy + dy.toInt()
                    wm.updateViewLayout(layout, lp)
                }
                MotionEvent.ACTION_UP -> if (!moved) {
                    when {
                        System.currentTimeMillis() - down > 600 ->
                            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                        speaking -> { pendingFollowUp = false; stopPlayback(); onSpeechDone() }
                        listening -> stopListening()
                        else -> captureCommand(followUp = false)
                    }
                }
            }
            true
        }
        t.setOnClickListener { t.visibility = TextView.GONE }

        wm.addView(layout, lp)
        bubble = layout
        bubbleText = t
        orb = o
    }

    private val hideText = Runnable { bubbleText?.visibility = TextView.GONE }

    fun showText(text: String, ms: Long = 8000) {
        main.post {
            bubbleText?.let {
                it.text = text
                it.visibility = TextView.VISIBLE
                main.removeCallbacks(hideText)
                main.postDelayed(hideText, ms)
            }
        }
    }

    private fun setOrb(state: String) = main.post {
        val o = orb ?: return@post
        val bg = o.background as? GradientDrawable ?: return@post
        when (state) {
            "listening" -> { bg.setColor(0xFFFFFFFF.toInt()); o.setTextColor(0xFF0A0A0A.toInt()) }
            else -> { bg.setColor(0xF00A0A0A.toInt()); o.setTextColor(0xFFFFFFFF.toInt()); o.scaleX = 1f; o.scaleY = 1f }
        }
    }

    // ---------------- Audio: baja la música mientras hablamos ----------------
    private fun duck() {
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .build()
        focusRequest = req
        getSystemService(AudioManager::class.java).requestAudioFocus(req)
    }

    private fun releaseFocus() {
        focusRequest?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    // ---------------- Voz de respuesta (NVIDIA, igual que en la web) ----------------
    private val http = OkHttpClient.Builder().callTimeout(25, TimeUnit.SECONDS).build()
    private var player: MediaPlayer? = null
    private var pendingFollowUp = false

    private fun stopPlayback() {
        player?.let { try { it.stop() } catch (_: Exception) {}; it.release() }
        player = null
        tts?.stop()
    }

    /** Habla el texto. followUp = true: al terminar vuelve a escuchar (conversación continua). */
    fun speak(text: String, followUp: Boolean = false) {
        val clean = text.replace(Regex("[\\p{So}\\p{Sk}*_#`]"), "").replace(Regex("\\s+"), " ").trim()
        if (clean.isBlank()) return
        main.post {
            wake.pause() // que no se escuche a sí mismo diciendo "CODEC"
            if (listening) { listening = false; recognizer?.cancel(); setOrb("idle") }
            stopPlayback()
            speaking = true
            pendingFollowUp = followUp
            duck()
        }
        Thread {
            val file = try { fetchVoice(clean) } catch (e: Exception) { null }
            main.post {
                if (!speaking) { file?.delete(); return@post }
                if (file != null) playFile(file) else localSpeak(clean)
            }
        }.start()
    }

    private fun fetchVoice(text: String): File? {
        val server = Prefs.server(this).trimEnd('/')
        val key = Prefs.key(this)
        if (server.isBlank() || key.isBlank()) return null
        val body = JSONObject().put("text", text).toString().toRequestBody("application/json".toMediaType())
        val req = Request.Builder().url("$server/api/tts").header("X-Device-Key", key).post(body).build()
        http.newCall(req).execute().use { res ->
            if (!res.isSuccessful) return null
            val f = File(cacheDir, "voz-${System.currentTimeMillis()}.wav")
            f.outputStream().use { out -> res.body!!.byteStream().copyTo(out) }
            return f
        }
    }

    private fun playFile(f: File) {
        try {
            player = MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
                setWakeMode(this@AssistantService, PowerManager.PARTIAL_WAKE_LOCK)
                setDataSource(f.path)
                setOnCompletionListener { release(); if (player === this) player = null; f.delete(); onSpeechDone() }
                setOnErrorListener { mp, _, _ -> mp.release(); if (player === mp) player = null; f.delete(); onSpeechDone(); true }
                prepare()
                start()
            }
        } catch (e: Exception) {
            f.delete()
            onSpeechDone()
        }
    }

    private fun setupLocalVoice() {
        val t = tts ?: return
        t.language = Locale.forLanguageTag("es-US")
        val male = t.voices?.filter { it.locale.language == "es" && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
            ?.sortedWith(compareByDescending<android.speech.tts.Voice> { it.name.contains("male", true) && !it.name.contains("female", true) }.thenByDescending { it.quality })
            ?.firstOrNull()
        if (male != null) t.voice = male
        t.setPitch(0.9f)
        t.setSpeechRate(1.05f)
    }

    private fun localSpeak(text: String) {
        if (!ttsReady) return onSpeechDone()
        val params = Bundle().apply { putInt(TextToSpeech.Engine.KEY_PARAM_STREAM, AudioManager.STREAM_MUSIC) }
        tts?.speak(text, TextToSpeech.QUEUE_FLUSH, params, "reply-${System.currentTimeMillis()}")
    }

    private fun onSpeechDone() {
        main.post {
            if (!speaking) return@post
            speaking = false
            val again = pendingFollowUp && Prefs.conversation(this)
            pendingFollowUp = false
            if (again) main.postDelayed({ if (!speaking && !listening) captureCommand(followUp = true) }, 250)
            else { releaseFocus(); resumeWake() }
        }
    }

    // ---------------- Reconocimiento de la orden (Google, pantalla encendida) ----------------
    private var followUpSession = false

    fun listen(followUp: Boolean = false) {
        main.post {
            if (!has(Manifest.permission.RECORD_AUDIO)) {
                showText("Necesito permiso de micrófono. Abre CODEC 47 para concederlo.")
                return@post
            }
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                showText("Este teléfono no tiene reconocimiento de voz de Google.")
                return@post
            }
            wake.pause()
            stopPlayback()
            speaking = false
            followUpSession = followUp
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply { setRecognitionListener(recListener) }
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-PE")
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            duck()
            listening = true
            setOrb("listening")
            recognizer?.startListening(intent)
        }
    }

    fun stopListening() {
        listening = false
        setOrb("idle")
        recognizer?.cancel()
        if (!speaking) { releaseFocus(); resumeWake() }
    }

    private val recListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) { showText(if (followUpSession) "¿Algo más?" else "Te escucho…", 15000) }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) { orb?.let { val s = 1f + (rmsdB.coerceIn(0f, 10f) / 50f); it.scaleX = s; it.scaleY = s } }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() { orb?.scaleX = 1f; orb?.scaleY = 1f }
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partial: Bundle?) {
            val t = partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            if (t.isNotBlank()) showText(t, 15000)
        }

        override fun onError(error: Int) {
            listening = false
            setOrb("idle")
            // En conversación continua, el silencio simplemente termina la conversación
            if (followUpSession) bubbleText?.visibility = TextView.GONE
            else if (error != SpeechRecognizer.ERROR_CLIENT) showText("No te escuché bien.", 3000)
            if (!speaking) { releaseFocus(); resumeWake() }
        }

        override fun onResults(results: Bundle?) {
            listening = false
            setOrb("idle")
            val text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
            if (text.isBlank()) { releaseFocus(); resumeWake(); return }
            sendToAssistant(text)
        }
    }

    private val BYE = Regex("^(ad[ií]os|chao|eso es todo|gracias,? eso es todo|para|detente|silencio|nada m[aá]s|ya est[aá]|nada)\\b", RegexOption.IGNORE_CASE)

    fun sendToAssistant(text: String, fromVoice: Boolean = true) {
        showText("“$text”", 15000)
        expectVoiceReply = fromVoice && !BYE.containsMatchIn(text.trim())
        MainActivity.onUserSaid(text)
        if (!Hub.sendChat(text)) {
            showText("Sin conexión con el servidor (${Hub.status}).")
            releaseFocus()
            resumeWake()
        } else {
            resumeWake() // mientras llega la respuesta, sigue atento a "Codec"
        }
    }
}
