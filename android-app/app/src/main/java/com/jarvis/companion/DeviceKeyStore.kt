package com.jarvis.companion

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import net.i2p.crypto.eddsa.EdDSASecurityProvider
import net.i2p.crypto.eddsa.spec.EdDSAGenParameterSpec
import java.security.*
import java.security.spec.PKCS8EncodedKeySpec
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Ed25519 device identity; private-key bytes are AES-GCM wrapped by Android Keystore. */
class DeviceKeyStore(context: Context) {
    private val prefs = context.getSharedPreferences("jarvis_identity", Context.MODE_PRIVATE)
    private val alias = "jarvis_ed25519_wrapping_key"

    init { if (Security.getProvider("EdDSA") == null) Security.addProvider(EdDSASecurityProvider()) }

    @Synchronized fun publicKeyPem(): String {
        val saved = prefs.getString("public", null)
        if (saved != null && prefs.getString("private", null) != null) return saved
        val generator = KeyPairGenerator.getInstance("EdDSA", "EdDSA")
        generator.initialize(EdDSAGenParameterSpec("Ed25519"))
        val pair = generator.generateKeyPair()
        val pem = "-----BEGIN PUBLIC KEY-----\n" +
            Base64.encodeToString(pair.public.encoded, Base64.NO_WRAP) +
            "\n-----END PUBLIC KEY-----"
        prefs.edit().putString("public", pem).putString("private", encrypt(pair.private.encoded)).apply()
        return pem
    }

    @Synchronized fun sign(payload: String): String {
        publicKeyPem()
        val packed = Base64.decode(prefs.getString("private", null) ?: error("Device key unavailable"), Base64.NO_WRAP)
        require(packed.size > 12) { "Stored device key is corrupt" }
        val iv = packed.copyOfRange(0, 12)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, wrappingKey(), GCMParameterSpec(128, iv))
        val privateBytes = cipher.doFinal(packed.copyOfRange(12, packed.size))
        val privateKey = KeyFactory.getInstance("EdDSA", "EdDSA").generatePrivate(PKCS8EncodedKeySpec(privateBytes))
        val signer = Signature.getInstance("EdDSA", "EdDSA")
        signer.initSign(privateKey)
        signer.update(payload.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(signer.sign(), Base64.NO_WRAP)
    }

    fun deviceId(): String {
        val bytes = MessageDigest.getInstance("SHA-256").digest(publicKeyPem().toByteArray(Charsets.UTF_8))
        val hex = bytes.joinToString("") { String.format("%02x", it.toInt() and 0xff) }
        return "dev-" + hex.take(16)
    }

    private fun wrappingKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(alias,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true).build())
        return generator.generateKey()
    }

    private fun encrypt(data: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, wrappingKey())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(data), Base64.NO_WRAP)
    }
}
