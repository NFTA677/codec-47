package com.codec47.assistant

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.view.ViewGroup.LayoutParams.WRAP_CONTENT
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** Pantalla principal: configuración, permisos y chat. */
class MainActivity : Activity(), Hub.Listener {
    companion object {
        private var current: MainActivity? = null
        fun onUserSaid(text: String) = current?.runOnUiThread { current?.addMsg(text, true) }

        private val RUNTIME_PERMS = arrayOf(
            Manifest.permission.RECORD_AUDIO,
            Manifest.permission.CAMERA,
            Manifest.permission.READ_CALENDAR,
            Manifest.permission.WRITE_CALENDAR,
            Manifest.permission.CALL_PHONE,
            Manifest.permission.POST_NOTIFICATIONS,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
            Manifest.permission.READ_MEDIA_IMAGES,
        )
    }

    private lateinit var status: TextView
    private lateinit var log: LinearLayout
    private lateinit var scroll: ScrollView
    private lateinit var permBox: LinearLayout
    private val dp get() = resources.displayMetrics.density

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(buildUi())
        if (Prefs.key(this).isNotBlank()) startAssistant()
        handleIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(i: Intent?) {
        // Abierta desde "Hablar" en la notificación o como asistente del sistema
        if (i?.getBooleanExtra("update", false) == true) Updater.downloadAndInstall(this)
        if (i?.getBooleanExtra("listen", false) == true || i?.action == Intent.ACTION_ASSIST) {
            window.decorView.postDelayed({ AssistantService.instance?.listen() }, 400)
        }
    }

    override fun onResume() {
        super.onResume()
        current = this
        Hub.listeners.add(this)
        onStatus(Hub.status)
        refreshPermissions()
    }

    override fun onPause() {
        Hub.listeners.remove(this)
        if (current == this) current = null
        super.onPause()
    }

    override fun onStatus(status: String) {
        this.status.text = status.replaceFirstChar { it.uppercase() }
        this.status.setTextColor(if (status == "conectado") 0xFFFFFFFF.toInt() else 0xFF8F8F8F.toInt())
    }

    override fun onChatReply(text: String) = addMsg(text, false)

    private fun startAssistant() {
        val missing = RUNTIME_PERMS.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) requestPermissions(missing.toTypedArray(), 1)
        AssistantService.start(this)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Reinicia el servicio para que tome los permisos de micrófono/cámara recién concedidos
        AssistantService.stop(this)
        AssistantService.start(this)
        refreshPermissions()
    }

    // ---------------- UI ----------------
    private fun px(v: Int) = (v * dp).toInt()

    private fun styledButton(label: String, primary: Boolean = false, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setTextColor(if (primary) 0xFF0A0A0A.toInt() else 0xFFEDEDED.toInt())
        background = GradientDrawable().apply {
            setColor(if (primary) 0xFFFFFFFF.toInt() else 0xFF171717.toInt())
            if (!primary) setStroke(px(1), 0xFF262626.toInt())
            cornerRadius = 10 * dp
        }
        setOnClickListener { onClick() }
    }

    private fun input(hint: String, value: String, password: Boolean = false) = EditText(this).apply {
        this.hint = hint
        setText(value)
        setTextColor(0xFFEDEDED.toInt())
        setHintTextColor(0xFF8F8F8F.toInt())
        isSingleLine = true
        inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        background = GradientDrawable().apply { setColor(0xFF171717.toInt()); cornerRadius = 10 * dp }
        setPadding(px(12), px(10), px(12), px(10))
    }

    private fun lp(top: Int = 8) = LinearLayout.LayoutParams(MATCH_PARENT, WRAP_CONTENT).apply { topMargin = px(top) }

    private fun buildUi(): View {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF0A0A0A.toInt())
            setPadding(px(16), px(16), px(16), px(12))
            fitsSystemWindows = true
        }
        root.addView(TextView(this).apply { text = "CODEC 47"; textSize = 22f; typeface = android.graphics.Typeface.DEFAULT_BOLD; setTextColor(0xFFEDEDED.toInt()) })
        status = TextView(this).apply { textSize = 13f }
        root.addView(status)

        // Configuración
        val server = input("https://tu-app.onrender.com", Prefs.server(this))
        val key = input("Clave del dispositivo (c47_...)", Prefs.key(this), password = true)
        val config = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        config.addView(server, lp())
        config.addView(key, lp())
        config.addView(styledButton("Guardar y conectar", primary = true) {
            Prefs.save(this, server.text.toString(), key.text.toString())
            Hub.restart(this)
            startAssistant()
            config.visibility = View.GONE
        }, lp())
        if (Prefs.key(this).isNotBlank()) config.visibility = View.GONE
        root.addView(config)

        // Permisos especiales
        permBox = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(permBox, lp())

        val handsFree = CheckBox(this).apply {
            text = "Activación por voz: di “Codec” para hablarme, también con la pantalla apagada"
            setTextColor(0xFF8F8F8F.toInt())
            isChecked = Prefs.handsFree(this@MainActivity)
            setOnCheckedChangeListener { _, v ->
                Prefs.setHandsFree(this@MainActivity, v)
                AssistantService.instance?.applyWakeMode() ?: startAssistant()
            }
        }
        root.addView(handsFree, lp())

        val conversation = CheckBox(this).apply {
            text = "Conversación continua: después de responder, vuelve a escucharte"
            setTextColor(0xFF8F8F8F.toInt())
            isChecked = Prefs.conversation(this@MainActivity)
            setOnCheckedChangeListener { _, v -> Prefs.setConversation(this@MainActivity, v) }
        }
        root.addView(conversation, lp(0))

        // Versión + actualizaciones
        val ver = TextView(this).apply { textSize = 12f; setTextColor(0xFF8F8F8F.toInt()); text = "Versión ${Updater.currentName(this@MainActivity)}" }
        root.addView(ver, lp(4))
        Updater.checkInBackground(this) { info ->
            if (info != null) {
                ver.text = "Versión ${Updater.currentName(this)} → hay una nueva: v${info.name}"
                root.addView(styledButton("Actualizar a v${info.name}", primary = true) { Updater.downloadAndInstall(this) }, root.indexOfChild(ver) + 1, lp(4))
            }
        }

        val row = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        row.addView(styledButton("Configurar") { config.visibility = if (config.visibility == View.GONE) View.VISIBLE else View.GONE },
            LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginEnd = px(6) })
        row.addView(styledButton("Detener") { Hub.stop(); AssistantService.stop(this) }, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f))
        root.addView(row, lp())

        // Chat
        log = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        scroll = ScrollView(this).apply { addView(log) }
        root.addView(scroll, LinearLayout.LayoutParams(MATCH_PARENT, 0, 1f).apply { topMargin = px(10) })

        val composer = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        val msg = input("Escribe un mensaje", "").apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES }
        composer.addView(styledButton("Hablar") { AssistantService.instance?.listen() ?: startAssistant() }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        composer.addView(msg, LinearLayout.LayoutParams(0, WRAP_CONTENT, 1f).apply { marginStart = px(6); marginEnd = px(6) })
        composer.addView(styledButton("Enviar", primary = true) {
            val t = msg.text.toString().trim()
            if (t.isNotEmpty()) {
                addMsg(t, true)
                msg.setText("")
                if (!Hub.sendChat(t)) addMsg("Sin conexión (${Hub.status})", false)
            }
        }, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT))
        root.addView(composer, lp())
        return root
    }

    fun addMsg(text: String, user: Boolean) {
        val tv = TextView(this).apply {
            this.text = text
            setTextColor(if (user) 0xFF0A0A0A.toInt() else 0xFFEDEDED.toInt())
            textSize = 15f
            setPadding(px(12), px(8), px(12), px(8))
            background = GradientDrawable().apply { setColor(if (user) 0xFFFFFFFF.toInt() else 0xFF171717.toInt()); cornerRadius = 14 * dp }
        }
        log.addView(tv, LinearLayout.LayoutParams(WRAP_CONTENT, WRAP_CONTENT).apply {
            topMargin = px(6)
            gravity = if (user) Gravity.END else Gravity.START
        })
        scroll.post { scroll.fullScroll(View.FOCUS_DOWN) }
    }

    private fun refreshPermissions() {
        permBox.removeAllViews()
        val items = mutableListOf<Pair<String, () -> Unit>>()
        if (!Settings.canDrawOverlays(this))
            items += "Permitir burbuja flotante (superposición)" to {
                startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
            }
        if (ControlAccessibilityService.instance == null)
            items += "Activar control del teléfono (accesibilidad)" to { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        val listeners = Settings.Secure.getString(contentResolver, "enabled_notification_listeners") ?: ""
        if (!listeners.contains(ComponentName(this, NotificationsService::class.java).flattenToString()))
            items += "Permitir leer notificaciones (correos)" to { startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
        if (RUNTIME_PERMS.any { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED })
            items += "Conceder micrófono, cámara, calendario…" to { requestPermissions(RUNTIME_PERMS, 1) }

        val pm = getSystemService(android.os.PowerManager::class.java)
        if (!pm.isIgnoringBatteryOptimizations(packageName))
            items += "Permitir funcionar en segundo plano (batería)" to {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }

        // Honor, Xiaomi, Huawei, Oppo...: bloquean que las apps abran otras apps en segundo plano
        if (!Prefs.bgTipShown(this) && Build.MANUFACTURER.lowercase() in setOf("honor", "huawei", "xiaomi", "redmi", "poco", "oppo", "vivo", "realme", "oneplus"))
            items += "Permitir “abrir en segundo plano / ventanas emergentes” (${Build.MANUFACTURER})" to {
                Prefs.setBgTipShown(this)
                android.widget.Toast.makeText(this, "En Permisos activa: Mostrar ventanas emergentes / Inicio automático / Abrir en segundo plano", android.widget.Toast.LENGTH_LONG).show()
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }

        for ((label, action) in items) permBox.addView(styledButton(label, onClick = action), lp(6))
    }
}
