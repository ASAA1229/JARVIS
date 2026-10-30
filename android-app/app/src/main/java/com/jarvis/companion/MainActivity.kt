package com.jarvis.companion

import android.app.Activity
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var server: EditText
    private lateinit var challenge: EditText
    private lateinit var phoneName: EditText
    private lateinit var request: EditText
    private lateinit var status: TextView
    private lateinit var keys: DeviceKeyStore
    private var client: JarvisApiClient? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        keys = DeviceKeyStore(this)
        val prefs = getSharedPreferences("jarvis_ui", MODE_PRIVATE)
        val column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 28, 24, 24) }
        val scroll = ScrollView(this).apply { addView(column) }
        column.addView(TextView(this).apply { text = "JARVIS COMPANION"; textSize = 24f }, params())
        column.addView(TextView(this).apply {
            text = "Independent phone identity • Signed requests • HTTPS only"
        }, params())
        server = field("Trusted HTTPS URL", prefs.getString("server", "https://") ?: "https://", column)
        challenge = field("Owner-approved enrollment challenge token", "", column)
        phoneName = field("Phone name", android.os.Build.MODEL ?: "Android phone", column)
        request = field("Request for JARVIS", "What can you help me with?", column)
        status = TextView(this).apply { text = "Not connected. Use a short-lived challenge created by the owner session." }
        column.addView(status, params())
        column.addView(Button(this).apply {
            text = "Enroll phone and connect"
            setOnClickListener { background {
                val api = JarvisApiClient(server.text.toString(), keys)
                val result = api.enroll(challenge.text.toString().trim(), phoneName.text.toString().trim())
                prefs.edit().putString("server", server.text.toString().trim()).apply()
                client = api
                result
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Reconnect session"
            setOnClickListener { background {
                val api = JarvisApiClient(server.text.toString(), keys)
                api.openSession()
                client = api
                "Authenticated session ready for " + keys.deviceId()
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Send request"
            setOnClickListener { background {
                val api = client ?: error("Enroll or reconnect first.")
                val reply = api.sendRequest(request.text.toString())
                reply.state + ": " + reply.message
            } }
        }, params())
        setContentView(scroll)
    }

    private fun field(hintText: String, value: String, root: LinearLayout): EditText {
        val edit = EditText(this).apply { hint = hintText; setText(value); textSize = 15f }
        root.addView(edit, params())
        return edit
    }

    private fun params() = LinearLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT
    ).apply { bottomMargin = 10 }

    private fun background(action: () -> String) {
        status.text = "Working…"
        Thread {
            val result = try { action() } catch (error: Exception) {
                "Not completed: " + (error.message ?: "unexpected error")
            }
            runOnUiThread { status.text = result }
        }.start()
    }
}
