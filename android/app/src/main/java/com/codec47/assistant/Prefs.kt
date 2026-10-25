package com.codec47.assistant

import android.content.Context

object Prefs {
    private fun sp(c: Context) = c.getSharedPreferences("codec47", Context.MODE_PRIVATE)

    fun server(c: Context) = sp(c).getString("server", "") ?: ""
    fun key(c: Context) = sp(c).getString("key", "") ?: ""
    fun handsFree(c: Context) = sp(c).getBoolean("handsFree", false)
    fun autoStart(c: Context) = sp(c).getBoolean("autoStart", true)

    fun save(c: Context, server: String, key: String) =
        sp(c).edit().putString("server", server.trim().trimEnd('/')).putString("key", key.trim()).apply()

    fun setHandsFree(c: Context, v: Boolean) = sp(c).edit().putBoolean("handsFree", v).apply()
}
