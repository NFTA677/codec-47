package com.codec47.assistant

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED && Prefs.autoStart(context) && Prefs.key(context).isNotBlank()) {
            AssistantService.start(context, fromBoot = true)
        }
    }
}
