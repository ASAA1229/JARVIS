package com.jarvis.companion

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/**
 * Offline-first sync with the laptop hub (JARVIS-US-060 / US-027).
 *
 * - Changes made while the hub is unreachable are queued on the phone with a
 *   monotonic sequence number and a bounded TTL; expired changes are dropped
 *   locally and would be rejected by the hub anyway.
 * - Memory changes carry the hub version (updatedAt) they were based on. The hub
 *   never applies them silently: they need the owner's approval, and stale bases
 *   become owner-reviewable conflicts, which are surfaced here.
 * - Queued commands are only held by the hub until the owner explicitly runs them.
 *
 * The queue file lives in the app's private storage. It contains memory text, so
 * keep the device encrypted and the app data excluded from cloud backup.
 */
class SyncClient(private val api: JarvisApiClient, private val queueFile: File, private val keys: DeviceKeyStore) {
    data class Conflict(val id: String, val memoryId: String, val kind: String)
    data class SyncReport(val pushed: Int, val outcomes: Map<String, Int>, val changedMemories: Int, val conflicts: List<Conflict>)

    private val maxQueued = 200
    private val defaultTtlSeconds = 24 * 60 * 60

    private fun load(): JSONObject {
        if (!queueFile.exists()) return JSONObject().put("seq", 0L).put("lastPull", 0L).put("queue", JSONArray())
        val packed = queueFile.readBytes()
        require(packed.size <= 2 * 1024 * 1024 + 64) { "Encrypted sync queue exceeds the size limit." }
        // One-time migration for queues created by older versions. Immediately rewrite
        // the parsed queue using Android Keystore encryption; never continue in plaintext.
        if (packed.isNotEmpty() && packed[0] == '{'.code.toByte()) {
            val legacy = JSONObject(String(packed, Charsets.UTF_8))
            save(legacy)
            return legacy
        }
        val plain = keys.decryptLocalData(packed)
        return JSONObject(String(plain, Charsets.UTF_8))
    }

    private fun save(state: JSONObject) {
        val plain = state.toString().toByteArray(Charsets.UTF_8)
        val encrypted = keys.encryptLocalData(plain)
        val temporary = File(queueFile.parentFile, queueFile.name + ".tmp")
        FileOutputStream(temporary).use { output ->
            output.write(encrypted)
            output.fd.sync()
        }
        check(temporary.renameTo(queueFile)) { "Could not atomically replace the encrypted sync queue." }
    }

    @Synchronized
    private fun enqueue(change: JSONObject) {
        val state = load()
        val queue = state.getJSONArray("queue")
        check(queue.length() < maxQueued) { "Too many offline changes are waiting; sync with the laptop first." }
        val seq = state.getLong("seq") + 1
        change.put("changeId", UUID.randomUUID().toString().replace("-", ""))
            .put("deviceSeq", seq)
            .put("createdAt", System.currentTimeMillis())
            .put("ttlSeconds", change.optInt("ttlSeconds", defaultTtlSeconds))
        queue.put(change)
        state.put("seq", seq)
        save(state)
    }

    fun queueMemoryCreate(category: String, content: String) {
        require(category in setOf("preference", "project", "routine", "general")) { "Unknown memory category." }
        require(content.isNotBlank() && content.length <= 4000) { "Memory text must be 1-4000 characters." }
        enqueue(JSONObject().put("op", "memory.create").put("category", category).put("content", content.trim()))
    }

    fun queueMemoryUpdate(memoryId: String, baseUpdatedAt: Long, content: String) {
        require(memoryId.matches(Regex("[a-f0-9]{32}"))) { "Invalid memory id." }
        require(content.isNotBlank() && content.length <= 4000) { "Memory text must be 1-4000 characters." }
        enqueue(JSONObject().put("op", "memory.update").put("memoryId", memoryId).put("baseUpdatedAt", baseUpdatedAt).put("content", content.trim()))
    }

    fun queueMemoryDelete(memoryId: String, baseUpdatedAt: Long) {
        require(memoryId.matches(Regex("[a-f0-9]{32}"))) { "Invalid memory id." }
        enqueue(JSONObject().put("op", "memory.delete").put("memoryId", memoryId).put("baseUpdatedAt", baseUpdatedAt))
    }

    /** Offline command: held by the hub until the owner explicitly runs it (never auto-executed). */
    fun queueCommand(text: String, ttlSeconds: Int = 4 * 60 * 60) {
        require(text.isNotBlank() && text.length <= 4000) { "Command text must be 1-4000 characters." }
        require(ttlSeconds in 60..(7 * 24 * 60 * 60)) { "TTL must be between 1 minute and 7 days." }
        enqueue(JSONObject().put("op", "command.queue").put("text", text.trim()).put("ttlSeconds", ttlSeconds))
    }

    fun pendingCount(): Int = load().getJSONArray("queue").length()

    /**
     * Push queued changes (in batches of 50), then pull. Changes the hub accepted,
     * rejected, deduplicated or turned into conflicts are removed from the queue;
     * on a network failure the queue is kept for the next attempt.
     */
    @Synchronized
    fun syncNow(): SyncReport {
        val state = load()
        val now = System.currentTimeMillis()
        val live = JSONArray()
        val queue = state.getJSONArray("queue")
        for (i in 0 until queue.length()) {
            val change = queue.getJSONObject(i)
            if (change.getLong("createdAt") + change.getInt("ttlSeconds") * 1000L > now) live.put(change)
        }
        val outcomes = mutableMapOf<String, Int>()
        val done = mutableSetOf<String>()
        var index = 0
        while (index < live.length()) {
            val batch = JSONArray()
            while (index < live.length() && batch.length() < 50) batch.put(live.getJSONObject(index++))
            val results = api.syncPush(batch).optJSONArray("results") ?: JSONArray()
            for (i in 0 until results.length()) {
                val result = results.getJSONObject(i)
                done.add(result.optString("changeId"))
                val outcome = result.optString("outcome", "unknown")
                outcomes[outcome] = (outcomes[outcome] ?: 0) + 1
            }
        }
        val remaining = JSONArray()
        for (i in 0 until live.length()) {
            val change = live.getJSONObject(i)
            if (change.optString("changeId") !in done) remaining.put(change)
        }
        state.put("queue", remaining)

        val pull = api.syncPull(state.optLong("lastPull", 0L))
        state.put("lastPull", pull.optLong("serverTime", now))
        save(state)
        val conflicts = mutableListOf<Conflict>()
        val conflictJson = pull.optJSONArray("conflicts") ?: JSONArray()
        for (i in 0 until conflictJson.length()) {
            val item = conflictJson.getJSONObject(i)
            conflicts.add(Conflict(item.optString("id"), item.optString("memoryId"), item.optString("kind")))
        }
        return SyncReport(live.length(), outcomes, pull.optJSONArray("changed")?.length() ?: 0, conflicts)
    }
}
