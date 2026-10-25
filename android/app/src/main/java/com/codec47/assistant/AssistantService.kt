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
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
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
import java.util.Locale
import android.media.MediaPlayer
import java.io.File
import java.util.concurrent.TimeUnit
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import kotlin.math.abs

/**
 * Servicio principal: mantiene la conexión con el servidor, muestra la burbuja flotante,
 * escucha tu voz y habla las respuestas (bajando el volumen de la música mientras tanto).
 */
class AssistantService : Service(), Hub.Listener {
    companion object {
        @Volatile var instance: AssistantService? = null
        private const val CHANNEL = "codec47"
        private val WAKE_WORDS = listOf("oye codec", "oye códec", "codec", "códec", "kodak", "codex", "kodek")

        fun start(ctx: Context, fromBoot: Boolean = false) {
            val i = Intent(ctx, AssistantService::class.java).putExtra("fromBoot", fromBoot)
            ctx.startForegroundService(i)
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, AssistantService::class.java))
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var executor: CommandExecutor
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var speaking = false
    private var focusRequest: AudioFocusRequest? = null

    private var bubble: LinearLayout? = null
    private var bubbleText: TextView? = null
    private var orb: TextView? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        instance = this
        executor = CommandExecutor(this)
        createChannel()
        // Motor de Google si está instalado: sus voces neuronales suenan mucho más naturales
        val googleTts = try { packageManager.getPackageInfo("com.google.android.tts", 0); "com.google.android.tts" } catch (e: Exception) { null }
        tts = TextToSpeech(this, { st ->
            if (st == TextToSpeech.SUCCESS) {
                setupVoice()
                ttsReady = true
            }
        }, googleTts)
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
        // Micrófono y cámara solo se pueden declarar si el usuario abrió la app (no desde el arranque)
        if (!fromBoot) {
            if (has(Manifest.permission.RECORD_AUDIO)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            if (has(Manifest.permission.CAMERA)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            if (has(Manifest.permission.ACCESS_FINE_LOCATION)) types = types or ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
        }
        try {
            startForeground(1, buildNotification("Conectando…"), types)
        } catch (e: Exception) {
            startForeground(1, buildNotification("Conectando…"), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
        }
        showBubble()
        Hub.start(this)
        if (Prefs.handsFree(this)) main.postDelayed({ listen(handsFree = true) }, 1500)
        // Busca actualizaciones al iniciar y cada 6 horas
        main.removeCallbacks(updateCheck)
        main.postDelayed(updateCheck, 20_000)
        return START_STICKY
    }

    override fun onDestroy() {
        Hub.listeners.remove(this)
        Hub.commandHandler = null
        Hub.stop()
        recognizer?.destroy()
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

    /** Elige la voz en español de mejor calidad (latina primero) y un ritmo natural. */
    private fun setupVoice() {
        val t = tts ?: return
        t.language = Locale.forLanguageTag("es-MX")
        val latam = setOf("MX", "US", "CO", "AR", "PE", "CL", "419")
        val best = t.voices
            ?.filter { it.locale.language == "es" && !it.features.contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED) }
            ?.sortedWith(
                compareByDescending<android.speech.tts.Voice> { it.quality }
                    .thenByDescending { it.locale.country in latam }
                    .thenByDescending { it.locale.country == "MX" }
            )
            ?.firstOrNull()
        if (best != null) t.voice = best
        t.setSpeechRate(1.07f)
        t.setPitch(1.0f)
    }

    // ---------------- Notificación ----------------
    private fun createChannel() {
        val ch = NotificationChannel(CHANNEL, "CODEC 47", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun buildNotification(text: String): Notification {
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val talk = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java).putExtra("listen", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        return Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_logo)
            .setContentTitle("CODEC 47")
            .setContentText(text)
            .setContentIntent(open)
            .addAction(Notification.Action.Builder(null, "Hablar", talk).build())
            .setOngoing(true)
            .build()
    }

    override fun onStatus(status: String) {
        getSystemService(NotificationManager::class.java).notify(1, buildNotification(status.replaceFirstChar { it.uppercase() }))
        orb?.alpha = if (status == "conectado") 1f else 0.5f
    }

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
            textSize = 16f
            setTextColor(0xFF0B0F17.toInt())
            gravity = Gravity.CENTER
            background = GradientDrawable(GradientDrawable.Orientation.TL_BR, intArrayOf(0xFF3AD1FF.toInt(), 0xFF76B900.toInt())).apply {
                shape = GradientDrawable.OVAL
            }
            layoutParams = LinearLayout.LayoutParams((56 * dp).toInt(), (56 * dp).toInt())
            elevation = 8 * dp
        }
        val t = TextView(this).apply {
            setTextColor(0xFFE6EBF5.toInt())
            textSize = 14f
            maxWidth = (240 * dp).toInt()
            setPadding((12 * dp).toInt(), (8 * dp).toInt(), (12 * dp).toInt(), (8 * dp).toInt())
            background = GradientDrawable().apply { setColor(0xEE121826.toInt()); cornerRadius = 16 * dp }
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

        // Arrastrar la burbuja; toque corto = hablar; toque largo = abrir la app
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
                    if (System.currentTimeMillis() - down > 600) {
                        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    } else if (speaking) { stopPlayback(); speaking = false; pendingFollowUp = false; releaseFocus() } else if (listening) stopListening() else listen()
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

    // ---------------- Audio: bajar la música mientras hablamos ----------------
    private fun duck() {
        val am = getSystemService(AudioManager::class.java)
        val req = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ASSISTANT).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build())
            .build()
        focusRequest = req
        am.requestAudioFocus(req)
    }

    private fun releaseFocus() {
        focusRequest?.let { getSystemService(AudioManager::class.java).abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    // ---------------- Voz: NVIDIA Magpie desde el servidor (igual que en la web) ----------------
    private val http = OkHttpClient.Builder().callTimeout(25, TimeUnit.SECONDS).build()
    private var player: MediaPlayer? = null
    private var pendingFollowUp = false
    private var expectVoiceReply = false

    private fun stopPlayback() {
        player?.let { try { it.stop() } catch (_: Exception) {}; it.release() }
        player = null
        tts?.stop()
    }

    /** Habla el texto. Si followUp = true, al terminar vuelve a escuchar (conversación continua). */
    fun speak(text: String, followUp: Boolean = false) {
        val clean = text.replace(Regex("[\\p{So}\\p{Sk}*_#`]"), "").replace(Regex("\\s+"), " ").trim()
        if (clean.isBlank()) return
        main.post {
            if (listening) { listening = false; recognizer?.cancel(); orb?.text = "47" }
            stopPlayback()
            speaking = true
            pendingFollowUp = followUp
            duck()
        }
        Thread {
            val file = try { fetchVoice(clean) } catch (e: Exception) { null }
            main.post { if (file != null) playFile(file) else localSpeak(clean) }
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
            if (again) main.postDelayed({ if (!speaking && !listening) listen(followUp = true) }, 250)
            else { releaseFocus(); maybeResumeHandsFree() }
        }
    }

    // ---------------- Reconocimiento de voz ----------------
    private var handsFreeSession = false

    private var followUpSession = false

    fun listen(handsFree: Boolean = false, followUp: Boolean = false) {
        main.post {
            if (!has(Manifest.permission.RECORD_AUDIO)) {
                showText("Necesito permiso de micrófono. Ábreme para concederlo.")
                return@post
            }
            if (!SpeechRecognizer.isRecognitionAvailable(this)) {
                showText("Este teléfono no tiene reconocimiento de voz (instala la app de Google).")
                return@post
            }
            stopPlayback()
            speaking = false
            handsFreeSession = handsFree
            followUpSession = followUp
            recognizer?.destroy()
            recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply { setRecognitionListener(recListener) }
            val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                .putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-MX")
                .putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
                .putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
            if (!handsFree) duck()
            listening = true
            orb?.text = "🎙"
            recognizer?.startListening(intent)
        }
    }

    fun stopListening() {
        listening = false
        orb?.text = "47"
        recognizer?.cancel()
        if (!speaking) releaseFocus()
    }

    private fun maybeResumeHandsFree() {
        if (Prefs.handsFree(this) && !listening && !speaking) main.postDelayed({ if (!listening && !speaking) listen(handsFree = true) }, 400)
    }

    private val recListener = object : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) { if (!handsFreeSession) showText(if (followUpSession) "¿Algo más?…" else "Te escucho…", 15000) }
        override fun onBeginningOfSpeech() {}
        override fun onRmsChanged(rmsdB: Float) { orb?.scaleX = 1f + (rmsdB.coerceIn(0f, 10f) / 40f); orb?.scaleY = orb?.scaleX ?: 1f }
        override fun onBufferReceived(buffer: ByteArray?) {}
        override fun onEndOfSpeech() { orb?.scaleX = 1f; orb?.scaleY = 1f }
        override fun onEvent(eventType: Int, params: Bundle?) {}

        override fun onPartialResults(partial: Bundle?) {
            val t = partial?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
            if (!handsFreeSession && t.isNotBlank()) showText(t, 15000)
        }

        override fun onError(error: Int) {
            listening = false
            orb?.text = "47"
            if (!handsFreeSession && !followUpSession && error != SpeechRecognizer.ERROR_CLIENT) showText("No te escuché bien. Toca la burbuja para intentar otra vez.", 4000)
            if (followUpSession) bubbleText?.visibility = TextView.GONE
            if (!speaking) releaseFocus()
            maybeResumeHandsFree()
        }

        override fun onResults(results: Bundle?) {
            listening = false
            orb?.text = "47"
            var text = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull()?.trim().orEmpty()
            if (handsFreeSession) {
                // En modo manos libres solo respondemos si dices "Codec ..."
                val lower = text.lowercase()
                val w = WAKE_WORDS.firstOrNull { lower.contains(it) }
                if (w == null) { maybeResumeHandsFree(); return }
                text = text.substring(lower.indexOf(w) + w.length).trim(' ', ',', '.')
                if (text.isBlank()) { speak("¿Sí?"); main.postDelayed({ listen(handsFree = false) }, 900); return }
            }
            if (text.isBlank()) { releaseFocus(); maybeResumeHandsFree(); return }
            sendToAssistant(text)
        }
    }

    private val BYE = Regex("^(ad[ií]os|chao|eso es todo|gracias,? eso es todo|para|detente|silencio|nada m[aá]s|ya est[aá])\\b", RegexOption.IGNORE_CASE)

    fun sendToAssistant(text: String, fromVoice: Boolean = true) {
        showText("“$text”", 15000)
        expectVoiceReply = fromVoice && !BYE.containsMatchIn(text.trim())
        MainActivity.onUserSaid(text)
        if (!Hub.sendChat(text)) {
            showText("Sin conexión con el servidor (${Hub.status}).")
            releaseFocus()
        }
    }
}
