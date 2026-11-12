# JARVIS Android Companion (initial implementation)

This native Android companion supports device-key creation, owner-approved enrollment, signed text requests, local launcher-app discovery/user-tap launch, bounded read-only app inventory, encrypted offline sync queue storage, and optional background approval polling.

## Security behavior

- Requires a trusted HTTPS URL; cleartext HTTP is rejected by both the app and Android manifest.
- Creates an Ed25519 identity on each phone independently.
- Encrypts the private-key encoding at rest using AES-GCM and an AES wrapping key held by Android Keystore.
- Encrypts the offline sync queue (which can contain memory text and held commands) at rest with a separate AES-GCM key held by Android Keystore. Legacy plaintext queues are migrated on first read; authentication or format failures stop sync rather than resetting or overwriting the queue.
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
- The app can discover launchable apps locally and open one only after the user taps it. A bounded read-only inventory request can be queued by the laptop for a specific active phone and claimed manually in the app; the server queue is volatile and supports no remote app launch or arbitrary phone actions.
- Optional approval notifications use Android WorkManager polling at the platform's minimum periodic interval (about 15 minutes). They are explicitly opt-in after enrollment and OS notification permission; notification text does not include directive contents. This is not real-time push and depends on Android scheduling, network availability and battery policy.
- SMS/call actions, notification-list access, wake-on-LAN, remote arbitrary app control, and a general background task service are not implemented.
- Use a trusted certificate chain on the phones. Do not disable TLS validation or use a permissive trust manager.
- Install only on test devices until Android build and two-phone revocation/permission tests pass.
