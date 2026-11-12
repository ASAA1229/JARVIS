# JARVIS Android Companion

The native Android companion is an installable internal-testing app for JARVIS. It currently supports per-phone device identity, owner-approved enrollment, signed text requests, local launchable-app discovery and user-tap launch, bounded read-only app inventory, encrypted offline sync queue storage, owner panels, and optional background approval polling.

**Delivery status:** APK packaging is automated on branch `new`. A successful Android CI build produces a downloadable debug APK artifact. Physical installation, secure host reachability, enrollment, and two-phone acceptance remain separate gates.

## Security behavior

- Requires a trusted HTTPS URL; cleartext HTTP is rejected by the app and Android manifest.
- Creates an Ed25519 identity independently on each phone.
- Encrypts the private-key encoding at rest using AES-GCM and an AES wrapping key held by Android Keystore.
- Encrypts the offline sync queue at rest with a separate AES-GCM key held by Android Keystore. Authentication or format failures stop sync rather than resetting or overwriting the queue.
- Uses the JARVIS signed-request contract: session ID, timestamp, one-time nonce, HTTP method/path, and SHA-256 body hash.
- Enrollment creates a pending request. A currently authorized owner device must approve it before the phone can establish a session.
- No owner control token is stored in the app.
- Each phone has its own cryptographic identity; do not clone app data between phones.

## Build an installable APK

Local requirements: Android Studio with Android SDK Platform 35 and JDK 17, or Gradle 8.9 with the Android SDK installed.

From the repository root:

```sh
gradle -p android-app :app:assembleDebug
```

Output: `android-app/app/build/outputs/apk/debug/app-debug.apk`.

### Download the CI-built APK

1. Open the repository's **Actions** tab.
2. Select **JARVIS Android APK** and run **Run workflow** on branch `new`, or let it run after an Android source/workflow change is pushed to `new`.
3. Open the successful workflow run.
4. Under **Artifacts**, download `jarvis-android-debug-...`.
5. Extract the ZIP. Keep `app-debug.apk`, `app-debug.apk.sha256`, and `android-apk-build.txt` together.
6. Verify the APK checksum before installation. On Windows PowerShell:

```powershell
Get-FileHash .\app-debug.apk -Algorithm SHA256
Get-Content .\app-debug.apk.sha256
```

Compare the 64-character SHA-256 value from PowerShell with the value in the checksum file.

The artifact is retained for 30 days. It is a **debug-signed internal-testing APK**, not a production release. Do not distribute it publicly. A production release needs a separately managed signing key and a reviewed release-signing process; no signing key belongs in this repository.

## Install on your Android phone

### Option A — install from the phone

1. Transfer the verified `app-debug.apk` to the phone using a trusted USB cable or private file-transfer method.
2. Open the APK using the phone's file manager.
3. If Android asks, allow that file manager to install unknown apps for this one installation.
4. Review the package name (`com.jarvis.companion`) and install.
5. Open **JARVIS Companion**.

### Option B — install with ADB

With Android Platform-Tools installed and USB debugging authorized for your own workstation:

```powershell
adb devices -l
adb install -r .\app-debug.apk
```

`adb devices -l` lists connected devices; `adb install -r` installs or updates the APK while retaining app data where Android permits. Repeat for the second phone. Each phone creates its own identity during enrollment.

## Connect the phone to the JARVIS host

**This is a required dependency before the app can be used end-to-end.** The current JARVIS Node host intentionally binds to loopback and does not terminate TLS. The phone app rejects plain HTTP. Therefore, entering the laptop's loopback URL or a plain LAN HTTP URL will not work.

Before enrollment, provide a private, trusted HTTPS endpoint that securely forwards to the loopback-bound JARVIS host. The endpoint must be reachable from the phone and present a certificate chain trusted by Android. Do not disable TLS validation, use a permissive trust manager, expose the host publicly, or create an unapproved public tunnel. The private HTTPS bridge and its owner-approved network configuration are not yet delivered by APK packaging itself.

Once that secure endpoint is available:

1. Enter its trusted HTTPS URL in **Trusted HTTPS URL**.
2. On an already enrolled owner device, create a short-lived enrollment transaction using the existing owner device-management flow. Complete any required authenticator step-up.
3. Scan the owner-generated QR/deep link if your camera supports opening the `jarvis://enroll` link, or manually enter its transaction ID and one-time code. The app does not include an in-app QR scanner.
4. Tap **Request enrollment**.
5. Approve the exact pending phone and requested permissions on the owner device.
6. Return to the phone and tap **Check approval & connect**.
7. Tap **Reconnect session**, then start with a harmless read-only request.
8. Repeat enrollment separately on the second phone. Never copy the first phone's app data or private identity to the second.

## What works today vs. what remains

- Local app discovery and launch are user-tap actions on the phone; JARVIS does not silently control other apps.
- The laptop can queue a bounded read-only app-inventory request for a specific active phone; the user manually claims it in the companion app.
- Optional approval notifications use WorkManager polling at Android's minimum periodic interval (about 15 minutes). This is not real-time push and depends on Android scheduling, network availability and battery policy.
- SMS/call actions, notification-list access, wake-on-LAN, arbitrary remote phone control, and a general background task service are not implemented.
- The server-side queued inventory path is volatile; it is not a durable remote command channel.
- Android build success does not prove installation, TLS reachability, enrollment, session continuity, offline recovery, notification behavior, or two-phone revocation isolation.

## Acceptance sequence

1. Android CI APK build succeeds for the exact `new` commit.
2. Verify the downloaded artifact checksum.
3. Install on phone 1 and phone 2 independently.
4. Confirm the app launches on both phones.
5. Complete secure HTTPS connectivity and owner-approved enrollment separately for each phone.
6. Verify each phone has a distinct device ID and permissions.
7. Exercise a read-only request, app inventory, offline queue, reconnect, approval notification opt-in, and one-phone revocation without affecting the other.
8. Record phone model, Android version, commit SHA, scenario, expected/actual result and sanitized evidence.

## Known build configuration

- Android Gradle Plugin 8.7.3
- Kotlin 2.0.21
- compileSdk 35 / targetSdk 35 / minSdk 28
- Java/Kotlin target 17
- Gradle 8.9 in CI
- Application ID: `com.jarvis.companion`
- Version: `0.1.0` (`versionCode 1`)
- The repository does not currently include a Gradle Wrapper; CI uses a pinned Gradle 8.9 installation.
