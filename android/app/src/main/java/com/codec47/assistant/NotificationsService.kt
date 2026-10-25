package com.codec47.assistant

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedDeque

/** Guarda las notificaciones recientes para poder leer correos y avisos por voz. */
class NotificationsService : NotificationListenerService() {
    data class Item(val pkg: String, val app: String, val title: String, val text: String, val time: Long) {
        fun toJson(): JSONObject = JSONObject().put("app", app).put("title", title).put("text", text).put("time", time)
    }

    companion object {
        val recent = ConcurrentLinkedDeque<Item>()
        @Volatile var connected = false

        val EMAIL_APPS = setOf(
            "com.google.android.gm",
            "com.microsoft.office.outlook",
            "com.samsung.android.email.provider",
            "com.yahoo.mobile.client.android.mail",
            "ch.protonmail.android",
            "com.google.android.gm.lite",
        )
    }

    override fun onListenerConnected() {
        connected = true
        activeNotifications?.forEach { add(it) }
    }

    override fun onListenerDisconnected() {
        connected = false
    }

    override fun onNotificationPosted(sbn: StatusBarNotification) = add(sbn)

    private fun add(sbn: StatusBarNotification) {
        if (sbn.packageName == packageName) return
        val ex = sbn.notification.extras
        val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return
        val text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
        // Ignorar resúmenes de grupo ("3 mensajes nuevos")
        if (sbn.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
        val app = try {
            packageManager.getApplicationLabel(packageManager.getApplicationInfo(sbn.packageName, 0)).toString()
        } catch (e: Exception) { sbn.packageName }
        recent.removeIf { it.pkg == sbn.packageName && it.title == title && it.text == text }
        recent.addFirst(Item(sbn.packageName, app, title, text.take(500), sbn.postTime))
        while (recent.size > 150) recent.removeLast()
    }
}
