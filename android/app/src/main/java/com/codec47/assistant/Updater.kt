package com.codec47.assistant

import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Actualizaciones automáticas: revisa {servidor}/downloads/version.json y, si hay una versión
 * nueva, avisa con una notificación e instala la APK con el instalador de Android.
 */
object Updater {
    private const val CHANNEL = "codec47-updates"
    private val http = OkHttpClient.Builder().callTimeout(120, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())

    data class Info(val code: Long, val name: String, val url: String, val notes: String)

    fun currentCode(ctx: Context): Long = ctx.packageManager.getPackageInfo(ctx.packageName, 0).longVersionCode
    fun currentName(ctx: Context): String = ctx.packageManager.getPackageInfo(ctx.packageName, 0).versionName ?: "?"

    private fun fetch(ctx: Context): Info? {
        val server = Prefs.server(ctx).trimEnd('/')
        if (server.isBlank()) return null
        http.newCall(Request.Builder().url("$server/downloads/version.json?t=${System.currentTimeMillis()}").build()).execute().use { r ->
            if (!r.isSuccessful) return null
            val j = JSONObject(r.body!!.string())
            val url = j.optString("url", "/downloads/CODEC47.apk")
            return Info(j.getLong("versionCode"), j.optString("versionName"), if (url.startsWith("http")) url else server + url, j.optString("notes"))
        }
    }

    /** Revisa en segundo plano; si hay versión nueva muestra una notificación. */
    fun checkInBackground(ctx: Context, onResult: ((Info?) -> Unit)? = null) {
        val app = ctx.applicationContext
        Thread {
            val info = try { fetch(app) } catch (e: Exception) { null }
            val newer = info?.takeIf { it.code > currentCode(app) }
            if (newer != null) notify(app, newer)
            onResult?.let { cb -> main.post { cb(newer) } }
        }.start()
    }

    private fun notify(ctx: Context, info: Info) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CHANNEL, "Actualizaciones", NotificationManager.IMPORTANCE_DEFAULT))
        val pi = PendingIntent.getActivity(
            ctx, 7, Intent(ctx, MainActivity::class.java).putExtra("update", true).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        nm.notify(
            7, android.app.Notification.Builder(ctx, CHANNEL)
                .setSmallIcon(R.drawable.ic_logo)
                .setContentTitle("Actualización de CODEC 47 (v${info.name})")
                .setContentText(info.notes.ifBlank { "Toca para instalar la nueva versión" })
                .setStyle(android.app.Notification.BigTextStyle().bigText(info.notes.ifBlank { "Toca para instalar la nueva versión" }))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build()
        )
    }

    /** Descarga e instala (pide permiso de "instalar apps desconocidas" la primera vez). */
    fun downloadAndInstall(act: Activity) {
        if (!act.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(act, "Permite a CODEC 47 instalar actualizaciones y vuelve a tocar Actualizar", Toast.LENGTH_LONG).show()
            act.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${act.packageName}")))
            return
        }
        Toast.makeText(act, "Descargando actualización…", Toast.LENGTH_SHORT).show()
        val app = act.applicationContext
        Thread {
            try {
                val info = fetch(app) ?: throw Exception("No pude consultar la versión")
                val installer = app.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                val id = installer.createSession(params)
                installer.openSession(id).use { session ->
                    http.newCall(Request.Builder().url(info.url).build()).execute().use { r ->
                        if (!r.isSuccessful) throw Exception("Descarga falló (${r.code})")
                        session.openWrite("codec47.apk", 0, r.body!!.contentLength()).use { out ->
                            r.body!!.byteStream().copyTo(out)
                            session.fsync(out)
                        }
                    }
                    val pi = PendingIntent.getBroadcast(
                        app, id, Intent(app, InstallReceiver::class.java),
                        PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
                    )
                    session.commit(pi.intentSender)
                }
            } catch (e: Exception) {
                main.post { Toast.makeText(app, "Error al actualizar: ${e.message}", Toast.LENGTH_LONG).show() }
            }
        }.start()
    }
}

/** Recibe el resultado del instalador; si Android pide confirmación, muestra el diálogo. */
class InstallReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, -999)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return
                confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                ctx.startActivity(confirm)
            }
            PackageInstaller.STATUS_SUCCESS -> Unit
            else -> Toast.makeText(ctx, "No se instaló: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}", Toast.LENGTH_LONG).show()
        }
    }
}
