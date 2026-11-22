package com.jarvis.companion

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : Activity() {
    private lateinit var server: EditText
    private lateinit var transactionId: EditText
    private lateinit var enrollmentCode: EditText
    private lateinit var phoneName: EditText
    private lateinit var request: EditText
    private lateinit var targetDeviceId: EditText
    private lateinit var status: TextView
    private lateinit var column: LinearLayout
    private lateinit var appList: LinearLayout
    private lateinit var keys: DeviceKeyStore
    private lateinit var session: CompanionSession
    private var client: JarvisApiClient? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        session = CompanionSession(this)
        keys = session.keys
        val prefs = getSharedPreferences("jarvis_ui", MODE_PRIVATE)
        column = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(24, 28, 24, 24) }
        val scroll = ScrollView(this).apply { addView(column) }
        column.addView(TextView(this).apply { text = "JARVIS COMPANION"; textSize = 24f }, params())
        column.addView(TextView(this).apply {
            text = "Independent phone identity • Owner-approved enrollment • HTTPS only"
        }, params())
        server = field("Trusted HTTPS URL", prefs.getString("server", "https://") ?: "https://", column)
        transactionId = field("Enrollment transaction ID from owner device", "", column)
        enrollmentCode = field("One-time enrollment code from owner device", "", column)
        phoneName = field("Phone name", android.os.Build.MODEL ?: "Android phone", column)
        request = field("Request for JARVIS", "What can you help me with?", column)
        status = TextView(this).apply {
            text = "Not connected. Enrollment codes expire quickly and require explicit approval on an owner device."
        }
        column.addView(status, params())
        column.addView(Button(this).apply {
            text = "Use pasted enrollment link (jarvis://enroll...)"
            setOnClickListener { applyEnrollmentLink(transactionId.text.toString().trim()) }
        }, params())
        column.addView(Button(this).apply {
            text = "Request enrollment"
            setOnClickListener { background {
                val api = JarvisApiClient(server.text.toString(), keys)
                val result = api.enroll(transactionId.text.toString().trim(),
                    enrollmentCode.text.toString().trim(), phoneName.text.toString().trim())
                prefs.edit().putString("server", server.text.toString().trim()).apply()
                client = api
                result
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Check approval & connect"
            setOnClickListener { background {
                val api = JarvisApiClient(server.text.toString(), keys)
                session.serverUrl = server.text.toString()
                val result = session.guard { api.checkEnrollment(transactionId.text.toString().trim(),
                    enrollmentCode.text.toString().trim()) }
                client = api
                if (api.hasSession()) {
                    session.enrolled = true
                    runOnUiThread { status.text = "Phone enrolled. Approval notifications remain off until you enable them below." }
                }
                result
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Reconnect session"
            setOnClickListener { background {
                session.serverUrl = server.text.toString()
                client = session.connect()
                "Authenticated session established for " + keys.deviceId()
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Send request"
            setOnClickListener { background {
                val api = client ?: error("Reconnect the authenticated session first.")
                val reply = session.guard { api.sendRequest(request.text.toString()) }
                reply.state + ": " + reply.message
            } }
        }, params())
        column.addView(TextView(this).apply {
            text = "APPROVAL NOTIFICATIONS"; textSize = 18f
        }, params())
        column.addView(TextView(this).apply {
            text = "Optional background polling checks for pending approvals at Android's minimum periodic interval (about 15 minutes). Notification text never includes the directive."
        }, params())
        column.addView(Button(this).apply {
            text = "Enable approval notifications"
            setOnClickListener { requestApprovalAlerts() }
        }, params())
        column.addView(Button(this).apply {
            text = "Disable approval notifications"
            setOnClickListener { disableApprovalAlerts() }
        }, params())

        column.addView(TextView(this).apply {
            text = "PHONE APPS"; textSize = 18f
        }, params())
        column.addView(TextView(this).apply {
            text = "Local discovery only. Tap an app to open it; JARVIS does not silently control other apps."
        }, params())
        column.addView(Button(this).apply {
            text = "Discover launchable phone apps"
            setOnClickListener { discoverPhoneApps() }
        }, params())
        targetDeviceId = field("Target Android device ID (owner phone only)", "", column)
        column.addView(Button(this).apply {
            text = "Request app inventory from target phone"
            setOnClickListener { background {
                val api = client ?: error("Reconnect the authenticated owner session first.")
                api.requestAndroidInventory(targetDeviceId.text.toString().trim())
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Check for laptop command (this phone)"
            setOnClickListener { background {
                val api = client ?: error("Reconnect the authenticated session first.")
                api.pollAndroidInventory { buildAppInventory() }
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Sync live events from laptop"
            setOnClickListener { background {
                val api = client ?: error("Reconnect the authenticated session first.")
                val batch = api.events(session.eventCursor)
                // Advance only past events actually delivered; a gap means the laptop's buffer rolled over.
                session.eventCursor = batch.events.lastOrNull()?.seq ?: batch.latestSeq
                (if (batch.gap) "Some events were missed; refresh task lists.
" else "") +
                    (if (batch.events.isEmpty()) "No new events." else batch.events.joinToString("
") { it.type + " " + it.summary })
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "Stop all activity from this phone"
            setOnClickListener { background {
                val api = client ?: error("Reconnect the authenticated session first.")
                api.stopAll()
            } }
        }, params())
        column.addView(Button(this).apply {
            text = "View recent remote inventory results"
            setOnClickListener { background {
                val api = client ?: error("Reconnect the authenticated session first.")
                api.androidInventoryResults()
            } }
        }, params())
        appList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        column.addView(appList, params())
        OwnerPanels(this, session, { activeClient() }) { _, action -> background(action) }.attach(column)
        setContentView(scroll)
        handleEnrollmentIntent(intent)
        if (session.enrolled && session.notificationsEnabled) ApprovalPollWorker.schedule(this)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleEnrollmentIntent(intent)
    }

    /** Reuse the open session, or open one (wiping local state if the laptop reports revocation). */
    private fun activeClient(): JarvisApiClient {
        val existing = client
        if (existing != null && existing.hasSession()) return existing
        return session.connect().also { client = it }
    }

    /** A phone camera scanning the laptop's enrollment QR opens jarvis://enroll?transaction=..&code=.. */
    private fun handleEnrollmentIntent(intent: Intent?) {
        val data = intent?.data ?: return
        applyEnrollmentLink(data.toString())
    }

    private fun applyEnrollmentLink(link: String) {
        val uri = try { android.net.Uri.parse(link) } catch (_: Exception) { null }
        if (uri == null || uri.scheme != "jarvis" || uri.host != "enroll") {
            status.text = "Paste the full jarvis://enroll link from the laptop QR code into the transaction field first."
            return
        }
        val transaction = uri.getQueryParameter("transaction").orEmpty()
        val code = uri.getQueryParameter("code").orEmpty()
        if (!transaction.matches(Regex("enr-[a-fA-F0-9]{32}")) || code.length !in 40..50) {
            status.text = "That enrollment link is not valid."
            return
        }
        transactionId.setText(transaction)
        enrollmentCode.setText(code)
        status.text = "Enrollment details filled from the QR link. Enter the laptop URL, then tap Request enrollment."
    }

    private fun requestApprovalAlerts() {
        if (!session.enrolled || !keys.hasIdentity()) {
            status.text = "Enroll this phone with owner approval before enabling notifications."
            return
        }
        if (android.os.Build.VERSION.SDK_INT >= 33 &&
            checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 41)
            return
        }
        session.notificationsEnabled = true
        ApprovalPollWorker.schedule(this)
        status.text = "Approval notifications enabled. Android checks periodically; delivery is not real-time."
    }

    private fun disableApprovalAlerts() {
        session.notificationsEnabled = false
        ApprovalPollWorker.cancel(this)
        status.text = "Approval notifications disabled. No background approval polling will run."
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != 41) return
        val granted = grantResults.isNotEmpty() &&
            grantResults[0] == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted && session.enrolled && keys.hasIdentity()) {
            session.notificationsEnabled = true
            ApprovalPollWorker.schedule(this)
            status.text = "Approval notifications enabled. Android checks periodically; delivery is not real-time."
        } else {
            session.notificationsEnabled = false
            ApprovalPollWorker.cancel(this)
            status.text = "Notification permission was not granted. Background approval polling remains disabled."
        }
    }

    private fun discoverPhoneApps() {
        appList.removeAllViews()
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcherIntent, 0)
            .filter { it.activityInfo.packageName != packageName }
            .filterNot { PaymentExclusion.isExcluded(it.loadLabel(packageManager).toString(), it.activityInfo.packageName) }
            .distinctBy { it.activityInfo.packageName }
            .sortedBy { it.loadLabel(packageManager).toString().lowercase() }
        if (apps.isEmpty()) {
            appList.addView(TextView(this).apply { text = "No launchable apps were returned by Android." }, params())
            return
        }
        appList.addView(TextView(this).apply {
            text = "Found ${apps.size} launchable apps on this phone."
        }, params())
        for (app in apps) {
            val label = app.loadLabel(packageManager).toString()
            val packageName = app.activityInfo.packageName
            appList.addView(Button(this).apply {
                text = label
                contentDescription = "Open $label"
                setOnClickListener {
                    val launch = packageManager.getLaunchIntentForPackage(packageName)
                    if (launch == null) {
                        status.text = "Android did not provide a launch intent for $label."
                    } else {
                        try {
                            startActivity(launch)
                            status.text = "Opened $label at your request."
                        } catch (_: Exception) {
                            status.text = "Android blocked launching $label."
                        }
                    }
                }
            }, params())
        }
    }

    private fun buildAppInventory(): JSONArray {
        val result = JSONArray()
        val launcherIntent = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val apps = packageManager.queryIntentActivities(launcherIntent, 0)
            .filter { it.activityInfo.packageName != packageName }
            .filterNot { PaymentExclusion.isExcluded(it.loadLabel(packageManager).toString(), it.activityInfo.packageName) }
            .distinctBy { it.activityInfo.packageName }
            .sortedBy { it.loadLabel(packageManager).toString().lowercase() }
            .take(300)
        for (app in apps) {
            result.put(JSONObject()
                .put("label", app.loadLabel(packageManager).toString().take(120))
                .put("packageName", app.activityInfo.packageName.take(240)))
        }
        return result
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
        status.text = "Working securely…"
        Thread {
            val result = try { action() } catch (revoked: SessionRevokedException) {
                client = null
                // Covers calls made outside CompanionSession.guard (wipe is idempotent).
                session.wipe()
                "This phone is no longer authorized (" + (revoked.message ?: "revoked") +
                    "). Its local identity and offline queue were wiped; enroll it again from an owner device."
            } catch (error: Exception) {
                "Not completed: " + (error.message ?: "unexpected error")
            }
            runOnUiThread { status.text = result }
        }.start()
    }
}
