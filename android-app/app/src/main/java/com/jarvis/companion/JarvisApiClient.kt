package com.jarvis.companion

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

    fun enroll(challengeToken: String, deviceName: String): String {
        require(challengeToken.matches(Regex("[a-fA-F0-9]{16,128}"))) { "Enrollment token format is invalid." }
        require(deviceName.isNotBlank() && deviceName.length <= 80) { "Phone name must be 1-80 characters." }
        val publicKey = keys.publicKeyPem()
        val proof = "ENROLLMENT_PROOF:" + challengeToken + ":" + deviceName + ":" + sha256(publicKey)
        val body = JSONObject().put("challengeToken", challengeToken).put("deviceName", deviceName)
            .put("publicKey", publicKey).put("proofSignature", keys.sign(proof))
        val response = post("/api/enrollment/redeem", body)
        check(response.optBoolean("success") && response.optString("deviceId") == keys.deviceId()) {
            "Server did not confirm enrollment for this device."
        }
        openSession()
        return "Enrolled and authenticated as " + keys.deviceId()
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
        val canonicalJson = "{\"text\":" + JSONObject.quote(text) + "}"
        val bodyHash = sha256(canonicalJson)
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
}
