package com.jarvis.companion

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom

data class JarvisReply(val state: String, val message: String)

class JarvisApiClient(private val baseUrl: String, private val keys: DeviceKeyStore) {
    private var sessionId: String? = null

    init {
        val url = URL(baseUrl.trim().trimEnd('/'))
        require(url.protocol.equals("https", true)) { "JARVIS remote access requires a trusted HTTPS endpoint." }
        require(url.userInfo == null) { "Do not embed credentials in the server URL." }
    }

    /** Submit a phone enrollment request using a one-time transaction created by an owner device. */
    fun enroll(transactionId: String, code: String, deviceName: String): String {
        require(transactionId.matches(Regex("enr-[a-fA-F0-9]{32}"))) { "Enrollment transaction ID format is invalid." }
        require(code.matches(Regex("[A-Za-z0-9_-]{40,50}"))) { "Enrollment code format is invalid." }
        require(deviceName.isNotBlank() && deviceName.length <= 80) { "Phone name must be 1-80 characters." }

        val details = post("/api/enrollment/details",
            JSONObject().put("transactionId", transactionId).put("code", code))
        val permissions = details.optJSONArray("permissions") ?: error("Enrollment permissions are missing.")
        val expiresAt = details.optLong("expiresAt", 0L)
        check(expiresAt > System.currentTimeMillis()) { "Enrollment transaction has expired." }

        val publicKey = keys.publicKeyPem()
        val binding = JSONObject()
            .put("transactionId", transactionId)
            .put("name", deviceName.trim())
            .put("platform", "Android")
            .put("publicKey", publicKey)
            .put("permissions", permissions)
            .put("expiresAt", expiresAt)
        val requestHash = sha256(stableJson(binding))
        val proofPayload = "JARVIS_ENROLLMENT_V1:" + transactionId + ":" + requestHash + ":" + code
        val exchange = JSONObject()
            .put("transactionId", transactionId)
            .put("code", code)
            .put("name", deviceName.trim())
            .put("platform", "Android")
            .put("publicKey", publicKey)
            .put("proofSignature", keys.sign(proofPayload))
        val response = post("/api/enrollment/exchange", exchange)
        val state = response.optString("state", "UNKNOWN")
        check(state == "AWAITING_OWNER_AUTHORIZATION") { "Enrollment request was not accepted: " + state }
        return "Request submitted. Approve this phone on your owner device, then select Check approval."
    }

    /** Only opens a session after the owner has approved the exact enrollment request. */
    fun checkEnrollment(transactionId: String, code: String): String {
        val status = post("/api/enrollment/status",
            JSONObject().put("transactionId", transactionId).put("code", code))
        val state = status.optString("state", "UNKNOWN")
        if (state != "ENROLLED") return "Enrollment state: " + state + ". No session has been opened."
        check(status.optString("deviceId") == keys.deviceId()) {
            "The approved device identity does not match this phone."
        }
        openSession()
        return "Owner approval confirmed. Authenticated session established."
    }

    fun openSession() {
        val timestamp = System.currentTimeMillis()
        val nonce = nonce()
        val body = JSONObject().put("deviceId", keys.deviceId()).put("timestamp", timestamp)
            .put("nonce", nonce).put("signature", keys.sign("SESSION_REQUEST:" + timestamp + ":" + nonce))
        val response = post("/api/session", body)
        check(response.optBoolean("success") && response.optString("sessionId").isNotBlank()) {
            "Session denied. The device may be unregistered or revoked."
        }
        sessionId = response.getString("sessionId")
    }

    fun sendRequest(text: String): JarvisReply {
        require(text.isNotBlank() && text.length <= 4000) { "Request must be 1-4000 characters." }
        val session = sessionId ?: error("Reconnect the authenticated session first.")
        val path = "/api/request"
        val body = JSONObject().put("text", text)
        val timestamp = System.currentTimeMillis()
        val nonce = nonce()
        val bodyHash = sha256(stableJson(body))
        val signature = keys.sign("POST:" + path + ":" + session + ":" + timestamp + ":" + nonce + ":" + bodyHash)
        val response = post(path, body, session, timestamp, nonce, signature)
        return JarvisReply(response.optString("state", "UNKNOWN"),
            response.optString("message", response.optString("error", "No response message.")))
    }

    private fun post(path: String, body: JSONObject, session: String? = null,
        timestamp: Long? = null, nonce: String? = null, signature: String? = null): JSONObject {
        val url = URL(baseUrl.trim().trimEnd('/') + path)
        require(url.protocol.equals("https", true)) { "HTTPS is required." }
        val connection = url.openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.connectTimeout = 8000
            connection.readTimeout = 15000
            connection.doOutput = true
            connection.instanceFollowRedirects = false
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            if (session != null) connection.setRequestProperty("X-Session-Id", session)
            if (timestamp != null) connection.setRequestProperty("X-Request-Timestamp", timestamp.toString())
            if (nonce != null) connection.setRequestProperty("X-Request-Nonce", nonce)
            if (signature != null) connection.setRequestProperty("X-Request-Signature", signature)
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            val result = try { JSONObject(text) } catch (_: Exception) {
                JSONObject().put("error", "Invalid server response (HTTP " + status + ").")
            }
            if (status !in 200..299) throw IllegalStateException(result.optString("error", "HTTP " + status))
            return result
        } finally { connection.disconnect() }
    }

    private fun nonce(): String {
        val bytes = ByteArray(16)
        SecureRandom().nextBytes(bytes)
        return bytes.joinToString("") { String.format("%02x", it.toInt() and 0xff) }
    }

    private fun sha256(value: String): String =
        MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
            .joinToString("") { String.format("%02x", it.toInt() and 0xff) }

    private fun stableJson(value: Any?): String = when (value) {
        null, JSONObject.NULL -> "null"
        is JSONObject -> value.keys().asSequence().toList().sorted().joinToString(",", "{", "}") { key ->
            JSONObject.quote(key) + ":" + stableJson(value.get(key))
        }
        is JSONArray -> (0 until value.length()).joinToString(",", "[", "]") { stableJson(value.get(it)) }
        is String -> JSONObject.quote(value)
        is Number, is Boolean -> value.toString()
        else -> JSONObject.quote(value.toString())
    }
}
