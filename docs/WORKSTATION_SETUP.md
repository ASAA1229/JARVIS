# JARVIS workstation setup and controlled validation

**Target:** Windows 11 MSI laptop + two physical Android phones  
**Repository:** ASAA1229/JARVIS  
**Working branch:** new

This guide prepares a repeatable local workstation and produces evidence for the existing JARVIS epics. It does not grant ChatGPT direct access to USB devices or Android Studio. The owner runs the scripts locally and shares the generated, reviewed reports.

## 1. Required workstation components

- Git for Windows
- Node.js LTS and npm
- Android Studio (already installed)
- Android SDK Platform 35 and Android SDK Build-Tools 35.x
- Android SDK Platform-Tools (includes adb)
- JDK 17
- Gradle 8.9 or newer, compatible with Android Gradle Plugin 8.7.3 (or add a Gradle Wrapper in a separately reviewed change)
- Microsoft Edge for the existing browser smoke test

The Android project uses Android Gradle Plugin 8.7.3, Kotlin 2.0.21, compileSdk 35, minSdk 28, targetSdk 35, and Java/Kotlin target 17. The repository currently does not include android-app/gradlew.bat; the runner therefore requires system Gradle on PATH.

In Android Studio, open Settings → Languages & Frameworks → Android SDK and confirm:
- Android SDK Platform 35
- Android SDK Build-Tools 35.x
- Android SDK Platform-Tools
- Android SDK Command-line Tools (latest)

Set JAVA_HOME to a JDK 17 installation and ensure its bin directory is on PATH. Set ANDROID_HOME to the Android SDK directory; add its platform-tools directory to PATH so adb is available. Do not put credentials or signing keys in the repository.

## 2. Connect both physical phones safely

On each phone:
1. Open Settings → About phone and tap Build number seven times to enable Developer options (menu names vary by manufacturer).
2. Open Developer options and enable USB debugging.
3. Connect the phone directly by USB.
4. Unlock the phone and accept the RSA debugging prompt only for your own trusted workstation.
5. Keep USB debugging disabled when device testing is finished unless you actively need it.

In PowerShell, run:

    adb devices -l

adb is the Android Debug Bridge; devices lists connected devices and -l adds descriptive device details. Expect two entries with state device. unauthorized means the phone has not accepted the workstation's debugging key; offline means ADB cannot currently communicate with it. Do not expose ADB over the internet or an untrusted network.

## 3. Open the correct checkout and run preflight

Open PowerShell in the local JARVIS repository root, then:

    git switch new
    git status --short
    node --version
    npm --version
    java -version
    gradle --version
    adb devices -l

git switch new selects the active development branch. git status --short checks for local edits; preserve your own changes and do not overwrite them. The version commands report installed tool versions.

Run the read-only preflight:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\workstation-preflight.ps1

-NoProfile avoids loading personal PowerShell profile customizations; -ExecutionPolicy Bypass applies only to this process invocation and does not change the machine-wide policy. Review the Markdown report in %TEMP%\JARVIS-workstation-evidence.

If node_modules is missing, install project dependencies only after reviewing the lockfile and repository state:

    npm ci

npm ci installs the exact dependency versions in the lockfile and may replace the existing node_modules directory. Do not run it if you have local dependency modifications you need to preserve.

## 4. Run the controlled test runner

Run all available automated checks and Android compilation/unit-test tasks:

    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\workstation-test-runner.ps1 -Mode All

Modes:
- Preflight: tool and connected-device readiness only.
- Windows: Node tests, TypeScript build, and browser smoke.
- Android: Android Gradle unit-test and debug-APK build tasks.
- All: Windows and Android checks.

Use -SkipBrowserSmoke only when deliberately excluding the Edge browser test. The runner does not install the generated APK or change either phone. It stores JSON and Markdown summaries under %TEMP%\JARVIS-workstation-evidence; review them before sharing.

The current runner invokes:
- npm test
- npm run build
- npm run test:browser
- gradle -p android-app testDebugUnitTest
- gradle -p android-app assembleDebug

A missing tool or dependency is reported as BLOCKED, not as a test failure. A non-zero command exit is FAIL. A passing Android compile is not physical-device acceptance.

## 5. Controlled physical-device acceptance — separate owner-led stage

After the software checks pass, perform the phone drills manually with the JARVIS UI and record results. Start with read-only checks and test accounts/data. Do not revoke a real device, wipe app data, reset enrollment, or use personal/private memory content during the initial drill.

1. Confirm both phones are detected and individually identified in the JARVIS owner device panel.
2. Enroll one test phone through the documented owner approval flow; verify its device identity and signed session.
3. Repeat for the second phone.
4. Verify a read-only sync negotiation and status display.
5. Test offline queue creation using non-sensitive test data; disconnect/reconnect and confirm conflict handling.
6. Confirm revocation behavior only with a disposable test enrollment and explicit owner decision.
7. Capture app version, phone model/Android version, test date, expected result, actual result and sanitized logs.

The runner intentionally does not automate enrollment, approval, revocation, app installation, notification permission changes, SMS/calls, or arbitrary remote phone actions. Those require a separate, narrowly scoped test plan and owner approval.

## 6. Desktop-assisted ChatGPT workflow

A desktop-assisted workflow may help inspect files and navigate supported applications where the ChatGPT desktop/Work/Computer Use features are available and explicitly connected. It does not automatically expose USB/ADB, Android Studio internals, or unrestricted local shell access. Use the local runner as the authoritative source for command exit codes and device enumeration. Share the reviewed Markdown/JSON reports and selected sanitized logs in this chat for analysis.

Never share Windows passwords, Android PINs, Google credentials, private signing keys, authenticator seeds, session tokens, or unredacted personal data.

## 7. Evidence and status rules

For every epic/story, record:
- Repository branch and exact commit SHA
- Command or manual scenario
- Machine/OS or phone model/Android version
- Exit code and test result
- Expected versus actual behavior
- Sanitized log/report reference
- Remaining limitations and owner acceptance

Use these statuses accurately:
- PASS — AUTOMATED (exact SHA)
- PASS — DEVICE (named device and scenario)
- FAIL
- BLOCKED
- NOT RUN
- OWNER ACCEPTANCE PENDING

A test count or successful build does not mean JARVIS is complete. Physical microphone, Windows UI automation, two-phone enrollment/sync, offline recovery, background behavior, privacy/security and cross-device continuity each need their own evidence.

## 8. Current known boundaries

- The Android sync queue encryption increment is implemented in source but has not yet been compiled or exercised on phones.
- The local-wake browser regression is authored but has not yet been executed on the Windows/Edge workstation.
- The Android app currently supports limited, owner-mediated companion operations; it does not provide arbitrary remote phone control.
- The repository has no Gradle Wrapper at this checkpoint.
- No production deployment, public tunnel, Nexus publication, merge to dev/main, or secret changes are part of this setup.
