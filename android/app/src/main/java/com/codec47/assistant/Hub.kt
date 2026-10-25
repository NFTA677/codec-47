package com.codec47.assistant

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.TimeUnit

/** Conexión WebSocket con el servidor CODEC 47 (reconecta sola). */
object Hub {
    interface Listener {
        fun onStatus(status: String) {}
        fun onChatReply(text: String) {}
    }

    val listeners = CopyOnWriteArraySet<Listener>()
    var commandHandler: ((id: String, action: String, params: JSONObject) -> Unit)? = null

    @Volatile var status = "desconectado"
        private set

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var running = false
    private var backoff = 2000L
    private lateinit var appCtx: Context

    fun start(ctx: Context) {
        appCtx = ctx.applicationContext
        running = true
        if (ws == null) connect()
    }

    fun stop() {
        running = false
        ws?.close(1000, "bye")
        ws = null
        setStatus("desconectado")
    }

    fun restart(ctx: Context) {
        ws?.close(1000, "restart")
        ws = null
        start(ctx)
    }

    private fun setStatus(s: String) {
        status = s
        main.post { listeners.forEach { it.onStatus(s) } }
    }

    private fun connect() {
        val server = Prefs.server(appCtx)
        val key = Prefs.key(appCtx)
        if (server.isBlank() || key.isBlank()) return setStatus("sin configurar")

        val url = server.replaceFirst(Regex("^http"), "ws") + "/ws"
        val req = try {
            Request.Builder().url(url).build()
        } catch (e: Exception) {
            return setStatus("URL inválida")
        }
        setStatus("conectando")

        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(JSONObject().put("type", "auth").put("key", key).toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (e: Exception) { return }
                when (msg.optString("type")) {
                    "auth_ok" -> {
                        backoff = 2000L
                        setStatus("conectado")
                        val info = JSONObject()
                            .put("os", "Android ${Build.VERSION.RELEASE}")
                            .put("model", "${Build.MANUFACTURER} ${Build.MODEL}")
                        webSocket.send(
                            JSONObject().put("type", "hello").put("info", info)
                                .put("capabilities", JSONArray(CommandExecutor.ACTIONS)).toString()
                        )
                    }
                    "auth_error" -> {
                        running = false
                        setStatus("clave inválida")
                    }
                    "command" -> commandHandler?.invoke(
                        msg.optString("id"), msg.optString("action"), msg.optJSONObject("params") ?: JSONObject()
                    )
                    "chat_reply" -> {
                        val reply = msg.optString("text")
                        main.post { listeners.forEach { it.onChatReply(reply) } }
                    }
                }
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = onDrop(webSocket)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = onDrop(webSocket)
        })
    }

    private fun onDrop(socket: WebSocket) {
        if (socket != ws) return
        ws = null
        if (status != "clave inválida") setStatus("desconectado")
        if (running) {
            main.postDelayed({ if (running && ws == null) connect() }, backoff)
            backoff = (backoff * 2).coerceAtMost(60_000L)
        }
    }

    fun sendChat(text: String): Boolean {
        val s = ws ?: return false
        return s.send(JSONObject().put("type", "chat").put("id", UUID.randomUUID().toString()).put("text", text).toString())
    }

    fun sendResult(id: String, ok: Boolean, output: Any?, error: String?) {
        val o = JSONObject().put("type", "result").put("id", id).put("ok", ok)
        if (output != null) o.put("output", output)
        if (error != null) o.put("error", error)
        ws?.send(o.toString())
    }
}
