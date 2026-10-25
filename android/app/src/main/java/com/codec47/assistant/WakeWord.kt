package com.codec47.assistant

import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.vosk.Model
import org.vosk.Recognizer
import org.vosk.android.RecognitionListener
import org.vosk.android.SpeechService
import java.io.File
import java.util.concurrent.TimeUnit
import java.util.zip.ZipInputStream

/**
 * Palabra de activación "Codec" 100 % offline con Vosk.
 * No usa el reconocedor de Google en bucle (no hace pitidos ni corta la música) y funciona
 * con la pantalla apagada. Solo despierta a CODEC 47 cuando la frase EMPIEZA con "Codec"
 * u "Oye Codec", para no activarse con conversaciones normales.
 */
class WakeWord(private val svc: AssistantService) : RecognitionListener {
    companion object {
        private const val MODEL_URL = "https://alphacephei.com/vosk/models/vosk-model-small-es-0.42.zip"
        // El modelo español no conoce "codec": lo oye como codex / code / kodak
        private val WAKE = Regex("^(c[oó]dec|c[oó]dex|codes?|kodak|kodek|c[oó]dek)$")
        private val PREFIX = setOf("oye", "hey", "ey", "ok", "okey", "hola")

        fun modelDir(svc: AssistantService) = File(svc.filesDir, "vosk-es")
        fun isModelReady(svc: AssistantService) = File(modelDir(svc), "am").exists() && File(modelDir(svc), "conf").exists()
    }

    private val main = Handler(Looper.getMainLooper())
    private var model: Model? = null
    private var service: SpeechService? = null
    private var loading = false
    @Volatile var enabled = false
        private set
    private var awaitUntil = 0L

    /** Activa la escucha de la palabra (descarga el modelo la primera vez). */
    fun start() {
        enabled = true
        if (model != null) return resume()
        if (loading) return
        loading = true
        Thread {
            try {
                if (!isModelReady(svc)) {
                    svc.setStatusText("Descargando el modelo de voz (40 MB, solo una vez)…")
                    download()
                }
                val m = Model(modelDir(svc).absolutePath)
                main.post {
                    model = m
                    loading = false
                    svc.setStatusText(null)
                    if (enabled) resume()
                }
            } catch (e: Throwable) {
                android.util.Log.e("CODEC47", "WakeWord: ${e}", e)
                main.post {
                    loading = false
                    svc.setStatusText("No pude preparar la activación por voz: ${e.message}")
                }
            }
        }.start()
    }

    /** Desactiva por completo. */
    fun stop() {
        enabled = false
        pause()
    }

    /** Libera el micrófono temporalmente (mientras CODEC 47 habla o usa el reconocedor de Google). */
    fun pause() {
        service?.let {
            try { it.stop(); it.shutdown() } catch (_: Exception) {}
        }
        service = null
    }

    fun resume() {
        val m = model ?: return
        if (!enabled || service != null) return
        try {
            service = SpeechService(Recognizer(m, 16000f), 16000f).also { it.startListening(this) }
            android.util.Log.i("CODEC47", "WakeWord escuchando")
        } catch (e: Throwable) {
            service = null
            main.postDelayed({ resume() }, 3000) // el micrófono estaba ocupado: reintenta
        }
    }

    val isListening get() = service != null

    /** Después de "Codec" (con pantalla apagada), la siguiente frase es la orden. */
    fun awaitCommand(ms: Long) {
        awaitUntil = System.currentTimeMillis() + ms
    }

    private fun handle(hyp: String?) {
        val text = try { JSONObject(hyp ?: "{}").optString("text").trim() } catch (e: Exception) { "" }
        if (text.isBlank()) return
        android.util.Log.i("CODEC47", "WakeWord oyó: $text")
        if (System.currentTimeMillis() < awaitUntil) {
            awaitUntil = 0
            svc.onWakeCommand(text)
            return
        }
        val words = text.lowercase().split(Regex("\\s+"))
        val idx = when {
            WAKE.matches(words[0]) -> 0
            words.size > 1 && words[0] in PREFIX && WAKE.matches(words[1]) -> 1
            else -> -1
        }
        if (idx < 0) return
        svc.onWake(words.drop(idx + 1).joinToString(" "))
    }

    override fun onResult(hypothesis: String?) = handle(hypothesis)
    override fun onFinalResult(hypothesis: String?) = handle(hypothesis)
    override fun onPartialResult(hypothesis: String?) {}
    override fun onTimeout() {}
    override fun onError(exception: Exception?) {
        pause()
        main.postDelayed({ resume() }, 2000)
    }

    private fun download() {
        val http = OkHttpClient.Builder().callTimeout(10, TimeUnit.MINUTES).build()
        val dir = modelDir(svc)
        val tmp = File(svc.filesDir, "vosk-tmp").apply { deleteRecursively(); mkdirs() }
        android.util.Log.i("CODEC47", "WakeWord: descargando modelo")
        http.newCall(Request.Builder().url(MODEL_URL).build()).execute().use { r ->
            android.util.Log.i("CODEC47", "WakeWord: respuesta ${r.code} ${r.body?.contentLength()} bytes")
            if (!r.isSuccessful) throw Exception("descarga ${r.code}")
            ZipInputStream(r.body!!.byteStream()).use { zip ->
                var e = zip.nextEntry
                while (e != null) {
                    // Quita la carpeta raíz del zip ("vosk-model-small-es-0.42/...")
                    val rel = e.name.substringAfter('/', "")
                    if (rel.isNotEmpty() && !rel.contains("..")) {
                        val f = File(tmp, rel)
                        if (e.isDirectory) f.mkdirs() else {
                            f.parentFile?.mkdirs()
                            f.outputStream().use { zip.copyTo(it) }
                        }
                    }
                    e = zip.nextEntry
                }
            }
        }
        dir.deleteRecursively()
        if (!tmp.renameTo(dir)) throw Exception("no pude guardar el modelo")
    }
}
