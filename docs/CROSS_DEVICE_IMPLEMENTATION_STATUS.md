# Cross-Device Agent Protocol and Implementation Status

**Updated:** 2026-10-30  
**Status:** Windows local POC foundation present; native Android agents and secure remote operation are not yet accepted.

## Architecture target

The server is the planner and policy authority; it is not itself a universal device controller. Each target device must run a device-side agent that advertises capabilities and executes only authenticated, policy-authorized requests.

1. User submits a voice/text goal from an enrolled device.
2. Planner produces a bounded list of typed operations; model output is advisory.
3. Policy gateway validates every operation and parameter.
4. State-changing steps obtain task-scoped approval when required. Approval binds device, task, operation, canonical parameter hash and expiry.
5. Authenticated device-side adapter executes with cancellation and timeout.
6. Adapter returns structured evidence; verifier evaluates the result and audit records the outcome.
7. Each following workflow step is checked independently. Unexpected state or uncertain outcome stops dependent actions.

## Current repository evidence

The current source includes:
- Ed25519 device identity/session foundations and signed request validation.
- Timestamp/nonce replay protection and device revocation.
- Enrollment transactions with owner approval and TOTP step-up.
- Default-deny policy checks and task/device/operation/parameter-bound approval logic.
- Hash-chained audit records and encrypted local memory.
- A bounded Windows foreground-window adapter and selected application launch.
- A browser-based companion/HUD.

The source tree contains an initial native Android companion under `android-app/`. Hosted Gradle compilation passes, but this is not a complete Android agent and has not passed physical-device acceptance. The web companion does not provide native Android Keystore, unrestricted app control, or background telephony authority.

## Signed request requirements

Native clients must use the device-bound session and signed-request protocol. Signatures bind HTTP method, request path, session ID, timestamp, nonce and SHA-256 body digest. Nonces are single-use. Never embed owner control tokens or shared server secrets in mobile apps. Device revocation and session expiry must be checked at execution time.

## Windows agent

The current Windows adapter targets the foreground window and supports bounded actions such as explicit text paste, selected-text copy, allowlisted hotkeys, zoom shortcuts, foreground-window inspection, unique-name control invocation and value-setting. The app launcher has a small static allowlist and constrained Start-menu discovery.

Recent Windows desktop-control increment — 2026-10-30:
- Added an explicit `desktop:read_control` operation through the existing planner → policy → execution pipeline.
- It resolves an exact, unique UI Automation control name in the foreground app and reads only the control's ValuePattern value when available.
- Password controls and labels matching credential/payment identifiers return a redacted value instead of content.
- The operation requires task-scoped approval, uses the existing foreground financial-app guard and optional expected-process binding, and is covered by script-shape and planner-routing tests.
- This remains accessibility-based automation, not universal control. The newest commit must pass CI and be exercised on the actual Windows laptop before this increment is accepted.

Limitations:
- It is not universal control of every installed Windows app.
- UI Automation requires accessible controls and exact unique names; custom-rendered apps may not expose usable controls.
- Clipboard/keyboard acknowledgements do not prove that destination content was accepted or saved.
- Financial/payment protection based on process/window names is defense in depth, not complete detection.
- Physical target-Windows acceptance is still required.

## Android requirements

- Native companion/agent with Android Keystore-backed device key.
- Independent enrollment, identity, sessions, permissions and revocation for each phone.
- Signed requests, replay protection, secure authenticated transport and run-time authorization.
- Local launchable-app discovery and user-tap launch are implemented in the Android companion using permitted launcher queries. Remote app discovery/control, notifications, messaging and telephony remain unimplemented.
- AccessibilityService only after explicit user enablement, with transparent disclosure and narrow permissions.
- Real two-phone acceptance: enroll both, verify independent keys/permissions, revoke one, and prove the other remains usable.
- Remote control must remain disabled until transport, authorization and physical-device acceptance are proven.

## Laptop reachability and recovery

- Check authenticated reachability and current session before execution.
- If the laptop is asleep, attempt wake only through an explicitly supported and configured mechanism.
- If unavailable, queue harmless informational tasks only. Reject or revalidate state-changing tasks on reconnection.
- On unexpected state, stop dependent operations, reconcile what happened, and retry/roll back only when safe.
- Do not report success without evidence.

## Universal app discovery and integrations

The target is to discover installed and built-in apps on Windows and both Android phones, identify available official APIs and accessible UI capabilities, then select the safest authorized adapter. Unsupported capabilities must be reported explicitly.

Email, WhatsApp, SMS, normal cellular calls, supported VoIP calls, Teams, Microsoft 365, calendar scheduling and other application integrations remain incomplete until their end-to-end adapters and acceptance tests exist. Official-store search currently generates official search destinations; it does not install apps.

## Memory and AI privacy

The encrypted local memory store is an initial foundation, not a complete user-facing memory system. Rich retrieval, conflict resolution, source visibility, cross-device sync, retention workflows and verified deletion across backups remain open.

Prefer local AI for private data. Before cloud sharing when required, disclose the data and purpose, minimize the payload, and obtain authorization. The planner/model never bypasses the policy gateway.

## Validation boundary

Hosted CI can validate TypeScript, planner/policy behavior, encrypted memory and adapter tests. It cannot prove that an actual Windows application received/saved text, that zoom changed visually, or that native Android controls work on physical devices. Keep universal application control, always-ready local wake-word behavior, two-phone remote operation, communications integrations and recurring unattended workflows marked partial/planned until target acceptance evidence exists.


## Native Android companion implementation — 2026-10-30

A first native Android application foundation now exists under `android-app/`:

- Kotlin launcher UI for one-time enrollment transaction/code exchange, explicit owner approval, session reconnect, and signed text requests.
- Per-install Ed25519 device identity; private-key bytes are encrypted at rest with AES-GCM and a wrapping key held by Android Keystore.
- Session proof and signed-request payloads follow the existing server canonical protocol, including timestamp, one-time nonce, session binding, and body SHA-256.
- Enrollment identifies the platform as Android so the server's device list can distinguish native phones from browser companions.
- Cleartext traffic and Android app backups are disabled. The client refuses non-HTTPS URLs and disables redirects.

Important limitations and acceptance gates:

- This is an initial native client, not a release-ready or physically verified Android agent. A separate Android Gradle assembleDebug CI job has been added; until it passes on the latest branch head, Android compilation is not verified. Install and acceptance tests on both physical phones remain required.
- The current JARVIS Node server exposes HTTP directly. The Android client deliberately requires a trusted HTTPS endpoint; until a TLS reverse proxy or native TLS server is configured and its certificate is trusted on the phones, remote connection is expected to fail closed.
- Each phone must use a short-lived enrollment transaction created by an authenticated owner device, then receive explicit owner approval before it can open a session. The app accepts the transaction ID and one-time code from the owner-generated QR/manual copy; never put the owner control token into the Android app.
- This initial vertical slice submits text requests only. Native notifications, app discovery/control, SMS/call actions, background execution, push notifications, and remote wake are not implemented by this slice.
- Before enabling remote state-changing actions, add integration tests for two independent Android identities, session replay, request replay, revocation during an active session, TLS failure, and operation-specific permission denial.

No physical-device success is claimed until build, install, and acceptance evidence is recorded for both phones.


## Cross-device epic progress — 2026-10-30

- Fixed the authenticated device-list response to report each device's stored platform instead of hardcoding every device as Browser.
- Added Android local launcher-app discovery and user-tap launching. This intentionally does not silently launch/control apps remotely.
- Added `deploy/Caddyfile.example` and `docs/SECURE_PHONE_CONNECTIVITY.md` for a loopback-only Node server behind HTTPS, with access restricted to a private network/VPN.
- CI at commit `b1f6ee11a796b25be5567e54d31f44597fafb6ed` passed the Node audit/build/type-check/tests/browser smoke test and Android `assembleDebug`, and published the debug APK artifact. New changes after that commit require their own CI result.
- Added a bounded laptop-to-Android command channel for one read-only operation: `android.app.list`. An enrolled owner device with device-management permission can queue an inventory request for an active Android target; only that target can claim it and submit a capped list of app labels/package names. Requests expire after 60 seconds, claim once, are signed with the device session, and produce audit events. The queue is deliberately in-memory: a server restart drops outstanding commands rather than replaying them.
- The Android UI now has manual controls to request inventory from a target device, check for a command on the current phone, and view recent results. This is a narrow vertical slice, not background push or general remote phone control. It does not remotely launch apps, read notifications, send SMS, place calls, or use AccessibilityService.
- Automated queue tests cover target isolation, one-time claim/completion, requester result isolation and expiry. Latest CI must pass after this change before treating it as build-verified.
- Still open: verify TLS connectivity from the actual phones; owner-approved enrollment on both phones; revocation isolation; device-specific Android acceptance; broader policy-bound command/approval integration; laptop reachability/offline recovery; native notifications and selected phone integrations.


## Windows application control follow-up (2026-10-30)

A further safety improvement binds UI Automation control inspection/read/write/click scripts to the same foreground-window handle that was captured by the desktop guard before the action. This reduces (but cannot entirely eliminate) focus-race risk. Regression tests cover script construction and natural-language routing for named-field writes.

Current boundaries:
- Control operations require a unique accessible control name and the corresponding UI Automation pattern.
- Value writes reject password and heuristic credential/financial labels, then verify the exposed control value.
- Value readback is not proof that a document was saved or a form submitted.
- The automated CI run must pass, and actual interactive acceptance on the MSI laptop is still needed before calling the Windows-control epic complete.
- Applications with custom-rendered or inaccessible controls require app-specific adapters; universal coverage is not claimed.


### Target binding and remaining acceptance gate (2026-10-30)

Named-control reads, clicks, and value updates now accept optional `expectProcess`. Natural-language requests can specify a target process using an `in <process>` suffix. The desktop guard rejects a process mismatch before the operation executes. This is a foreground-process check, not a guarantee that every application exposes controls or that a window remains unchanged for the entire workflow.

**Epic completion gate:** CI must pass on the latest commit, and the MSI acceptance checklist in `POC.md` must be run interactively. In particular, test Notepad and a browser, duplicate names, focus changes, blocked sensitive fields, and durable file-save verification. Apps that expose neither usable UI Automation patterns nor stable accessible controls still require dedicated adapters; they must be reported as unsupported instead of silently falling back to unsafe input.


## Android inventory queue hardening — 2026-10-30

The `new` branch now hardens the bounded in-memory `android.app.list` command queue: device IDs are checked at create/claim/result lookup; invalid TTLs fall back to a finite default; app inventory entries with empty, oversized or control-character fields are rejected; inventories above 300 entries are rejected; and result snapshots are defensive copies. An invalid result leaves the command claimed rather than marking it complete. Added unit tests cover these cases plus expiry and one-time claim/completion.

This is a narrow safety improvement, not an accepted native Android agent. Hosted CI has not yet been confirmed for the resulting head, and no physical-device test has been performed here. The queue is still volatile and only supports read-only app inventory. Transport, lifecycle/reconnect, per-phone permission/revocation acceptance and two-phone testing remain release blockers.


## Advanced workflow checkpoint foundation — 2026-10-30

`src/core/taskJournal.ts` now provides an encrypted, atomic task-checkpoint journal prototype. It uses AES-256-GCM, a per-write random salt/IV, bounded records/file size, validated record shape, defensive-copy reads and fail-closed loading. Non-terminal records encountered on restart are marked `AWAITING_RECOVERY`; stale approval references are removed and automatic replay is prohibited. `test/task_journal.test.ts` adds regression cases for encryption, restart recovery, terminal records, tampering, wrong token, invalid records and copy isolation.

`JarvisCoreService` is now wired to the encrypted journal when an owner control token is configured. It restores persisted tasks into the task list, checkpoints task creation, execution start, step results and workflow advancement, and stops dependent workflow execution if a checkpoint write fails. Restarted non-terminal tasks are held in `AWAITING_RECOVERY`; no automatic replay or stale approval reuse is permitted. Lifecycle coverage is not yet complete: early planning/error, expiry, and revocation transitions still need a full audit, and there is no explicit reconcile-and-resume command. Exact-head CI is pending; do not mark the epic accepted until CI and crash/restart/reconciliation tests pass.


## Voice and HUD privacy hardening — 2026-10-30

The HUD now requires explicit, per-page-session consent before push-to-talk starts browser speech recognition; consent is not stored. Finalized transcripts are review-only until the user explicitly presses **EXECUTE DIRECTIVE**. Both hands-free/wake-detection controls fail closed until a local audio-level wake-word engine is configured, so the current browser recognizer is not used for continuous wake listening. Text input remains available. This improves the privacy boundary but does not deliver the requested local wake-word engine. Browser push-to-talk may still use a remote provider after consent; Piper TTS and physical MSI acceptance remain unverified.

### Voice/HUD lifecycle hardening — 2026-10-30 follow-up

- Browser-speech consent can be revoked during capture; the recognizer is cancelled and pending transcript discarded. Late recognition callbacks are ignored.
- Hiding the HUD cancels capture, stops the microphone level meter, and stops standby recognition.
- Browser smoke test added for consent revocation and late-result rejection.
- This does not close the voice epic by itself. A real local wake-word engine/model, validated local TTS/Piper and audible output, and physical MSI/browser/microphone acceptance are still outstanding. Keep wake detection disabled until local inference is actually present and measured.

### Local wake-word runtime integration — 2026-10-30

- Added an optional local-only browser wake-word integration using the open-source onnx-wakeword engine and English “Hey Jarvis” model package. `scripts/setup-local-wake-word.ps1` installs `onnxruntime-web@1.20.1` and `jszip@3.10.1` into an ignored local runtime folder with a persisted local npm lockfile, and downloads engine/model assets from immutable upstream commit `8002ba9a14d80c0f71447920d3f1c8ee986b1432`; downloaded model/runtime files are ignored by Git. The upstream commit is unsigned, but each downloaded source/model file is now checked against its expected Git blob SHA-1 before use; the script also reports a SHA-256 inventory.
- Server routes expose only a strict allowlist of wake-word asset filenames. Missing runtime/model assets fail closed without falling back to continuous browser speech recognition.
- Added a separate session-only consent for browser/vendor speech recognition after local wake detection. All recognized commands remain review-only until explicit execution.
- Still pending: setup/install on the target MSI, validate model asset compatibility and microphone permissions, test false triggers and CPU/memory usage, verify local Piper TTS audible output, and pass exact-head CI. Until those checks pass, do not mark always-ready local wake as accepted.


### Exact-head CI runner blocker — 2026-10-30

The latest hosted workflow attempts terminate within roughly 2–3 seconds before checkout. The GitHub Jobs API reports `runner_id: 0`, empty `runner_name`, and no executed steps for both `windows-latest` validation and `ubuntu-latest` Android build. Downloaded job logs return `BlobNotFound`. This does not prove a source-level test failure; it means current-head build/test/Android acceptance cannot be established. Investigate hosted-runner availability, Actions usage/billing limits, and repository Actions settings, then rerun CI on the latest `new` head. Keep the voice epic open until that result and target-MSI hardware acceptance are complete.


## Workflow recovery companion follow-up — 2026-10-30

The browser companion now exposes a Recovery Review panel for tasks in AWAITING_RECOVERY or INTERRUPTED. It reads the task list through the signed session flow and posts a manual disposition/note to /api/task/reconcile. The API requires a configured durable encrypted task journal and rejects malformed notes or tasks that are not eligible for recovery review. The UI explicitly states that review does not retry the operation.

A stale-approval guard was also added: approval resolution now requires the associated task to remain in AWAITING_APPROVAL. This prevents an orphaned approval record from authorizing execution after a task has moved to recovery/cancelled/another state.

**Not yet accepted:** exact-head CI, browser interaction against a completed run, crash/restart and partial-side-effect tests, and target MSI interaction remain unverified. This does not change the Android limitations above; both physical phones still require secure HTTPS connectivity, independent enrollment, revocation-isolation and reconnect tests.
