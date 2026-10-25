package com.codec47.assistant

import android.Manifest
import android.app.SearchManager
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.os.SystemClock
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.MediaStore
import android.provider.Settings
import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.util.TimeZone
import java.util.concurrent.Executors

/** Ejecuta en el teléfono las órdenes que manda el servidor. */
class CommandExecutor(private val svc: AssistantService) {
    companion object {
        val ACTIONS = listOf(
            "flashlight", "take_photo", "open_camera", "play_music", "media", "volume", "bluetooth", "wifi",
            "add_calendar_event", "list_calendar_events", "read_emails", "read_notifications", "open_app",
            "call", "navigate", "set_alarm", "set_timer", "global", "battery", "speak",
        )
    }

    private val pool = Executors.newSingleThreadExecutor()
    private val audio get() = svc.getSystemService(AudioManager::class.java)

    fun handle(id: String, action: String, p: JSONObject) {
        pool.execute {
            try {
                if (action == "take_photo") {
                    requirePerm(Manifest.permission.CAMERA, "cámara")
                    PhotoCapture.take(svc, p.optBoolean("front")) { r ->
                        r.fold({ Hub.sendResult(id, true, it, null) }, { Hub.sendResult(id, false, null, it.message) })
                    }
                    return@execute
                }
                Hub.sendResult(id, true, run(action, p), null)
            } catch (e: Exception) {
                Hub.sendResult(id, false, null, e.message ?: e.toString())
            }
        }
    }

    private fun requirePerm(perm: String, label: String) {
        if (svc.checkSelfPermission(perm) != PackageManager.PERMISSION_GRANTED)
            throw Exception("Falta el permiso de $label. Ábreme y concédelo.")
    }

    private fun launch(i: Intent) {
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        svc.startActivity(i)
    }

    private fun installed(pkg: String) = try {
        svc.packageManager.getPackageInfo(pkg, 0); true
    } catch (e: PackageManager.NameNotFoundException) { false }

    private fun run(action: String, p: JSONObject): Any = when (action) {
        "flashlight" -> {
            val cm = svc.getSystemService(CameraManager::class.java)
            val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
                ?: throw Exception("Este teléfono no tiene linterna")
            val on = p.optBoolean("on", true)
            cm.setTorchMode(id, on)
            if (on) "Linterna encendida" else "Linterna apagada"
        }

        "open_camera" -> {
            launch(Intent(MediaStore.INTENT_ACTION_STILL_IMAGE_CAMERA)); "Cámara abierta"
        }

        "play_music" -> playMusic(p.optString("query"), p.optString("app"))

        "media" -> {
            val code = when (p.optString("cmd", "play")) {
                "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
                "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
                "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
                "previous" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
                else -> KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE
            }
            val t = SystemClock.uptimeMillis()
            audio.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_DOWN, code, 0))
            audio.dispatchMediaKeyEvent(KeyEvent(t, t, KeyEvent.ACTION_UP, code, 0))
            "ok"
        }

        "volume" -> {
            val s = AudioManager.STREAM_MUSIC
            when {
                p.has("level") -> {
                    val max = audio.getStreamMaxVolume(s)
                    audio.setStreamVolume(s, (p.optInt("level").coerceIn(0, 100) * max / 100), AudioManager.FLAG_SHOW_UI)
                }
                p.optString("cmd") == "mute" -> audio.adjustStreamVolume(s, AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI)
                p.optString("cmd") == "down" -> repeat(3) { audio.adjustStreamVolume(s, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI) }
                else -> repeat(3) { audio.adjustStreamVolume(s, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI) }
            }
            "Volumen: ${audio.getStreamVolume(s) * 100 / audio.getStreamMaxVolume(s)}%"
        }

        "bluetooth" -> {
            // Desde Android 13 las apps no pueden encender Bluetooth solas: abrimos el ajuste.
            launch(Intent(Settings.ACTION_BLUETOOTH_SETTINGS))
            "Abrí los ajustes de Bluetooth; Android no permite activarlo automáticamente"
        }

        "wifi" -> {
            launch(Intent(Settings.Panel.ACTION_WIFI)); "Abrí el panel de Wi-Fi"
        }

        "add_calendar_event" -> addEvent(p)
        "list_calendar_events" -> listEvents(p.optInt("days", 7))

        "read_emails" -> {
            if (!NotificationsService.connected) throw Exception("Activa el acceso a notificaciones de CODEC 47 para leer tus correos")
            val items = NotificationsService.recent.filter { it.pkg in NotificationsService.EMAIL_APPS }.take(p.optInt("limit", 5))
            if (items.isEmpty()) "No hay correos nuevos en tus notificaciones" else JSONArray(items.map { it.toJson() })
        }

        "read_notifications" -> {
            if (!NotificationsService.connected) throw Exception("Activa el acceso a notificaciones de CODEC 47")
            JSONArray(NotificationsService.recent.take(p.optInt("limit", 10)).map { it.toJson() })
        }

        "open_app" -> openApp(p.optString("name"))

        "call" -> {
            val num = p.optString("number").filter { it.isDigit() || it == '+' }
            if (num.isBlank()) throw Exception("Número no válido")
            val granted = svc.checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED
            launch(Intent(if (granted) Intent.ACTION_CALL else Intent.ACTION_DIAL, Uri.parse("tel:$num")))
            if (granted) "Llamando a $num" else "Abrí el marcador con $num"
        }

        "navigate" -> {
            launch(Intent(Intent.ACTION_VIEW, Uri.parse("google.navigation:q=" + Uri.encode(p.optString("destination")))))
            "Navegando a ${p.optString("destination")}"
        }

        "set_alarm" -> {
            launch(Intent(AlarmClock.ACTION_SET_ALARM)
                .putExtra(AlarmClock.EXTRA_HOUR, p.optInt("hour"))
                .putExtra(AlarmClock.EXTRA_MINUTES, p.optInt("minute"))
                .putExtra(AlarmClock.EXTRA_MESSAGE, p.optString("label", "CODEC 47"))
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true))
            "Alarma a las %02d:%02d".format(p.optInt("hour"), p.optInt("minute"))
        }

        "set_timer" -> {
            launch(Intent(AlarmClock.ACTION_SET_TIMER)
                .putExtra(AlarmClock.EXTRA_LENGTH, p.optInt("seconds", 60))
                .putExtra(AlarmClock.EXTRA_MESSAGE, p.optString("label", "CODEC 47"))
                .putExtra(AlarmClock.EXTRA_SKIP_UI, true))
            "Temporizador de ${p.optInt("seconds", 60)} s"
        }

        "global" -> {
            val a11y = ControlAccessibilityService.instance
                ?: throw Exception("Activa el servicio de accesibilidad de CODEC 47 para controlar el teléfono")
            if (!a11y.global(p.optString("action"))) throw Exception("Acción del sistema no válida")
            "ok"
        }

        "battery" -> {
            val bm = svc.getSystemService(BatteryManager::class.java)
            val lvl = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            "Batería al $lvl%" + if (bm.isCharging) " (cargando)" else ""
        }

        "speak" -> {
            svc.speak(p.optString("text")); "ok"
        }

        else -> throw Exception("Acción no soportada en Android: $action")
    }

    private fun playMusic(query: String, app: String): String {
        val pkg = when (app) {
            "spotify" -> "com.spotify.music"
            "youtube" -> "com.google.android.youtube"
            "youtube_music" -> "com.google.android.apps.youtube.music"
            else -> listOf("com.google.android.apps.youtube.music", "com.spotify.music", "com.google.android.youtube").firstOrNull { installed(it) }
        } ?: "com.google.android.youtube"

        if (pkg == "com.google.android.youtube" || !installed(pkg)) {
            // YouTube no admite "reproducir desde búsqueda": abrimos los resultados
            val i = Intent(Intent.ACTION_SEARCH).setPackage("com.google.android.youtube").putExtra(SearchManager.QUERY, query)
            if (installed("com.google.android.youtube")) launch(i)
            else launch(Intent(Intent.ACTION_VIEW, Uri.parse("https://www.youtube.com/results?search_query=" + Uri.encode(query))))
            return "Busqué \"$query\" en YouTube"
        }
        // Spotify y YouTube Music reproducen directamente
        launch(Intent(MediaStore.INTENT_ACTION_MEDIA_PLAY_FROM_SEARCH)
            .setPackage(pkg)
            .putExtra(SearchManager.QUERY, query)
            .putExtra(MediaStore.EXTRA_MEDIA_FOCUS, "vnd.android.cursor.item/*"))
        return "Reproduciendo \"$query\""
    }

    private fun openApp(name: String): String {
        val pm = svc.packageManager
        val q = name.lowercase().trim()
        val apps = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
        val match = apps.firstOrNull { it.loadLabel(pm).toString().lowercase() == q }
            ?: apps.firstOrNull { it.loadLabel(pm).toString().lowercase().contains(q) }
            ?: throw Exception("No encontré la app \"$name\"")
        launch(pm.getLaunchIntentForPackage(match.activityInfo.packageName)!!)
        return "Abrí ${match.loadLabel(pm)}"
    }

    private fun parseTime(s: String): Long {
        val zone = ZoneId.systemDefault()
        return try {
            OffsetDateTime.parse(s).toInstant().toEpochMilli()
        } catch (e: Exception) {
            LocalDateTime.parse(s.removeSuffix("Z")).atZone(zone).toInstant().toEpochMilli()
        }
    }

    private fun calendarId(): Long {
        requirePerm(Manifest.permission.WRITE_CALENDAR, "calendario")
        val proj = arrayOf(CalendarContract.Calendars._ID, CalendarContract.Calendars.IS_PRIMARY)
        val sel = "${CalendarContract.Calendars.CALENDAR_ACCESS_LEVEL} >= ${CalendarContract.Calendars.CAL_ACCESS_CONTRIBUTOR} AND ${CalendarContract.Calendars.VISIBLE} = 1"
        svc.contentResolver.query(CalendarContract.Calendars.CONTENT_URI, proj, sel, null, null)?.use { c ->
            var first: Long? = null
            while (c.moveToNext()) {
                if (first == null) first = c.getLong(0)
                if (c.getInt(1) == 1) return c.getLong(0)
            }
            if (first != null) return first
        }
        throw Exception("No encontré un calendario editable en el teléfono")
    }

    private fun addEvent(p: JSONObject): String {
        val start = parseTime(p.getString("start"))
        val end = if (p.has("end")) parseTime(p.getString("end")) else start + 60 * 60_000
        val values = ContentValues().apply {
            put(CalendarContract.Events.CALENDAR_ID, calendarId())
            put(CalendarContract.Events.TITLE, p.optString("title", "Evento"))
            put(CalendarContract.Events.DESCRIPTION, p.optString("description"))
            put(CalendarContract.Events.EVENT_LOCATION, p.optString("location"))
            put(CalendarContract.Events.DTSTART, start)
            put(CalendarContract.Events.DTEND, end)
            put(CalendarContract.Events.EVENT_TIMEZONE, TimeZone.getDefault().id)
        }
        val uri = svc.contentResolver.insert(CalendarContract.Events.CONTENT_URI, values) ?: throw Exception("No pude crear el evento")
        // Recordatorio 15 minutos antes
        svc.contentResolver.insert(CalendarContract.Reminders.CONTENT_URI, ContentValues().apply {
            put(CalendarContract.Reminders.EVENT_ID, ContentUris.parseId(uri))
            put(CalendarContract.Reminders.MINUTES, 15)
            put(CalendarContract.Reminders.METHOD, CalendarContract.Reminders.METHOD_ALERT)
        })
        return "Evento \"${p.optString("title")}\" agregado al calendario"
    }

    private fun listEvents(days: Int): JSONArray {
        requirePerm(Manifest.permission.READ_CALENDAR, "calendario")
        val now = System.currentTimeMillis()
        val uri = CalendarContract.Instances.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, now)
            ContentUris.appendId(it, now + days * 86_400_000L)
        }.build()
        val out = JSONArray()
        svc.contentResolver.query(
            uri, arrayOf(CalendarContract.Instances.TITLE, CalendarContract.Instances.BEGIN, CalendarContract.Instances.EVENT_LOCATION),
            null, null, "${CalendarContract.Instances.BEGIN} ASC"
        )?.use { c ->
            while (c.moveToNext() && out.length() < 30) {
                out.put(JSONObject().put("title", c.getString(0)).put("start", java.time.Instant.ofEpochMilli(c.getLong(1)).atZone(ZoneId.systemDefault()).toString()).put("location", c.getString(2) ?: ""))
            }
        }
        return out
    }
}
