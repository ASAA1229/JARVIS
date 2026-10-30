# JARVIS Android Companion (initial implementation)

This is the first native Android companion slice. It supports device-key creation, owner-approved enrollment, session creation, and signed text requests. It does not yet control other Android apps or provide background execution.

## Security behavior

- Requires a trusted HTTPS URL; cleartext HTTP is rejected by both the app and Android manifest.
- Creates an Ed25519 identity on each phone independently.
- Encrypts the private-key encoding at rest using AES-GCM and an AES wrapping key held by Android Keystore.
- Uses the JARVIS signed-request contract: session ID, timestamp, one-time nonce, HTTP method/path, and SHA-256 body hash.
- Enrolling a phone creates a pending request. A currently authorized owner device must approve it before the phone can establish a session.
- No owner control token is stored in the app.

## Build

Requirements: Android Studio with Android SDK Platform 35 and JDK 17, or Gradle 8.9 with the Android SDK installed.

From the repository root:

```sh
gradle -p android-app :app:assembleDebug
```

The debug APK is written to `android-app/app/build/outputs/apk/debug/app-debug.apk`. CI is configured to publish this APK as a short-lived workflow artifact when the native build succeeds.

## Pairing flow

1. Configure a trusted HTTPS endpoint that forwards to the JARVIS server bound to loopback. The current Node server is intentionally loopback-only and does not itself terminate TLS.
2. On an already enrolled owner device, create a short-lived enrollment transaction using the existing enrollment flow. The owner must have device-management permission and complete any required authenticator step-up.
3. Copy the transaction ID and one-time code from the owner-generated QR/deep link into the phone app. Do not share the owner control token.
4. Tap **Request enrollment**. The phone signs the enrollment request with its own key.
5. Approve the exact pending phone and requested permissions on the owner device.
6. Return to the phone and tap **Check approval & connect**.
7. Send a harmless read-only request first. Keep state-changing operations subject to JARVIS policy and approvals.

## Current limits

- The initial implementation passed the hosted Android Gradle `assembleDebug` job on 2026-10-30. Physical-device acceptance is still outstanding.
- No QR scanner is included; the transaction ID and code are entered manually.
- The app can discover launchable apps locally and open one only after the user taps it. Remote phone app control, SMS/call actions, notification access, push delivery, wake-on-LAN, and a background task service are not implemented.
- Use a trusted certificate chain on the phones. Do not disable TLS validation or use a permissive trust manager.
- Install only on test devices until Android build and two-phone revocation/permission tests pass.
