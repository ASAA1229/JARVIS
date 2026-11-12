# JARVIS Cross-Platform Architecture

**Status:** Target architecture approved for implementation planning; current platform support is partial.  
**Active implementation branch:** `new`  
**Target families:** Windows, macOS, Linux, Android and iOS.

## Product requirement

JARVIS must be a platform-independent product across the three major desktop operating-system families and both major mobile operating-system families. It must not depend on Windows as its only host or Android as its only mobile client.

“Platform-independent” means a consistent product identity, account/device model, permission model, task model, AI orchestration, memory policy, synchronization protocol and user experience contract across supported platforms. It does **not** mean forcing one binary or one implementation onto every operating system.

## Target platform matrix

| Platform | Target OS | Implementation approach | Current evidence |
|---|---|---|---|
| Desktop | Windows 10/11 (x64; ARM64 assessed separately) | Shared TypeScript/Node core with Windows-native adapters; desktop shell/UI kept separate from OS control | Existing Windows host and adapters; Windows-focused |
| Desktop | macOS (supported current releases; Intel/Apple Silicon assessed separately) | Shared TypeScript/Node core with macOS-native adapters and packaging | Not implemented/validated |
| Desktop | Linux (supported mainstream distributions; x64 first, ARM64 assessed separately) | Shared TypeScript/Node core with Linux-native adapters and packaging | Not implemented/validated |
| Mobile | Android (API 28+ baseline pending device compatibility review) | Native Kotlin client, Android Keystore and Android-specific capability adapters | Android source exists; APK build/installation/phone acceptance pending |
| Mobile | iOS (minimum deployment target to be selected against supported devices) | Native Swift/SwiftUI client, Keychain/Secure Enclave where available, iOS-specific capability adapters | Not implemented |

The minimum supported OS versions, CPU architectures and distribution formats must be finalized through a compatibility decision and real-device/VM evidence. “All OS versions” is not a safe or testable promise; support means a documented, maintained compatibility range.

## Layered architecture

1. **Shared product contracts:** versioned API schemas, event/task models, capability descriptors, canonical approval payloads, error/outcome states and sync envelopes. Language-neutral OpenAPI/JSON Schema contracts are authoritative.
2. **Shared JARVIS core:** identity and session services, policy gateway, approvals, audit, task orchestration/recovery, memory policy, AI provider routing and integration contracts. Keep business logic platform-neutral and avoid importing OS-specific modules into core.
3. **Desktop host runtime:** TypeScript/Node service and shared desktop UI. A platform adapter is selected at runtime for Windows, macOS or Linux. OS-specific process, window, accessibility, input, notification, filesystem and secure-storage operations stay behind narrow interfaces.
4. **Native platform adapters:** separate implementations for Windows UI Automation/Win32, macOS Accessibility/AppleScript/approved APIs, and Linux accessibility/desktop portals/window-system interfaces. Capability availability depends on OS, desktop environment, permissions and user consent.
5. **Native mobile clients:** Kotlin Android and Swift iOS apps implement the same versioned device/session/protocol contracts while using each OS's secure storage, lifecycle, permissions, notifications, audio and background execution APIs.
6. **Cross-device services:** independently enrolled devices, signed requests, short-lived sessions, scoped approvals, replay defense, revocation, encrypted sync and offline queues. No device inherits another device's key or permission.
7. **Presentation:** common design system and interaction semantics, with platform-native navigation, accessibility and system permission prompts where required.

## Non-negotiable invariants

- One owner-controlled JARVIS identity; every device has a distinct cryptographic identity.
- Default-deny policy and server-side authorization for every state-changing operation.
- Approval binds exact device, task, capability, target, parameters and expiry.
- OS adapters cannot bypass the central policy gateway.
- No automatic replay of uncertain side effects.
- No financial/payment automation, credential entry, unrestricted shell or silent privilege escalation.
- Microphone, camera, screen capture, accessibility and background execution require platform-compliant disclosure and consent.
- No weakening of TLS validation or security controls to make cross-device connectivity convenient.
- Unsupported capabilities return explicit unsupported/partial outcomes; never pretend an OS capability is universal.
- Local-first and zero recurring cost remain defaults; optional cloud providers are explicit and task-scoped.

## Capability portability model

Every capability declares:
- supported platform(s), OS version range and CPU architecture;
- required OS permission/entitlement and user-visible consent;
- adapter implementation and version;
- whether it works foreground/background/offline;
- risk tier and approval requirement;
- verification method and known limitations;
- automated and real-device acceptance evidence.

A feature is not “cross-platform complete” merely because its API exists. It must either have a tested adapter on every target platform or clearly show platform-specific availability.

## Build, package and release strategy

- **Windows:** signed installer/package (MSIX or reviewed installer), x64 first; ARM64 only after compatibility evidence.
- **macOS:** signed and notarized universal or architecture-specific app package; permissions and accessibility onboarding documented.
- **Linux:** reproducible packages for selected distributions (AppImage/Flatpak/deb/rpm chosen after dependency review); desktop portals and distribution differences tested.
- **Android:** signed APK for direct/internal installation and AAB for Play distribution if later approved. Debug APKs are internal testing artifacts only.
- **iOS:** signed archive/IPA via Xcode on macOS; installation through development provisioning/TestFlight/App Store as appropriate. iOS distribution cannot be produced by an Android/Linux-only runner.
- Release artifacts include commit provenance, version, platform/architecture, signing identity and SHA-256 checksum. Production signing keys are stored only in protected release infrastructure, never in Git.

## CI and acceptance matrix

- Shared core: lint, build, unit/integration/security tests on Linux, macOS and Windows runners.
- Desktop: compile/package and adapter tests on each OS; real accessibility/process/window tests on the actual OS and supported desktop environments.
- Android: Gradle build, APK artifact and emulator tests; physical device acceptance for secure storage, enrollment, notifications, lifecycle and battery behavior.
- iOS: Xcode build, simulator tests and physical iPhone acceptance; validate Keychain, permissions, background limits, push-notification entitlements if used, and lifecycle.
- Cross-device: Android↔Windows, Android↔macOS/Linux, iOS↔Windows/macOS/Linux, and mixed mobile pairs; validate independent enrollment, permissions, offline recovery and revocation isolation.
- No platform is marked accepted based solely on a shared-core unit test or a successful package build.

## Current implementation boundary

- Existing desktop execution is Windows-specific. The Node/TypeScript core is a candidate for reuse on macOS/Linux, not proof of those hosts being supported.
- Existing native mobile implementation is Android-only. There is no iOS application implementation yet.
- The Android APK workflow packages a debug build only. It does not make the Windows host reachable from phones; a private trusted HTTPS connectivity design is still required.
- Do not change the existing Windows and Android adapters into fake cross-platform shims. Implement and validate each native adapter against the same contracts.
