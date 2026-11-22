package com.jarvis.companion

import android.content.Context
import java.io.File

/**
 * Phone-side session settings and the revocation wipe.
 *
 * The phone holds no authority of its own: every action is a signed request that the
 * laptop authorizes. When the laptop reports this device as revoked (HTTP 401 or a
 * revocation error), the phone wipes its identity, its offline queue (which may hold
 * memory text) and its settings, so a lost or revoked phone cannot keep acting.
 */
class CompanionSession(private val context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_ui", Context.MODE_PRIVATE)

    val keys: DeviceKeyStore = DeviceKeyStore(context)

    var serverUrl: String
        get() = prefs.getString("server", "https://") ?: "https://"
        set(value) { prefs.edit().putString("server", value.trim()).apply() }

    /** True once the owner approved this phone and a session was opened at least once. */
    var enrolled: Boolean
        get() = prefs.getBoolean("enrolled", false)
        set(value) { prefs.edit().putBoolean("enrolled", value).apply() }

    var notificationsEnabled: Boolean
        get() = prefs.getBoolean("approval_notifications", false)
        set(value) { prefs.edit().putBoolean("approval_notifications", value).apply() }

    /** Approval ids already notified, so the poller does not repeat the same alert. */
    var notifiedApprovals: Set<String>
        get() = prefs.getStringSet("notified_approvals", emptySet()) ?: emptySet()
        set(value) { prefs.edit().putStringSet("notified_approvals", value.toList().takeLast(200).toSet()).apply() }

    /** Last cross-module event sequence number this phone has seen. */
    var eventCursor: Long
        get() = prefs.getLong("event_cursor", 0L)
        set(value) { prefs.edit().putLong("event_cursor", value).apply() }

    val syncQueueFile: File get() = File(context.filesDir, "jarvis-sync-queue.json")

    fun newClient(): JarvisApiClient = JarvisApiClient(serverUrl, keys)

    /** Open an authenticated session, wiping local state if the laptop says the phone is revoked. */
    fun connect(): JarvisApiClient {
        val client = newClient()
        guard { client.openSession() }
        enrolled = true
        return client
    }

    /** Run a laptop call; on revocation wipe everything locally and rethrow. */
    fun <T> guard(action: () -> T): T = try {
        action()
    } catch (revoked: SessionRevokedException) {
        wipe()
        throw revoked
    }

    fun wipe() {
        keys.reset()
        syncQueueFile.delete()
        java.io.File(syncQueueFile.parentFile, syncQueueFile.name + ".tmp").delete()
        val server = serverUrl
        prefs.edit().clear().putString("server", server).apply()
        ApprovalPollWorker.cancel(context)
    }
}
