# JARVIS POC — Current Implemented Baseline

**Updated:** 2026-10-24  
**Source reviewed:** application source baseline 6222e1964774c78e6853d6113335b1a3f0284881; documentation reconciliation head 6dd9d8d62ccf2610fb458da159fc1dd11f47079c. PR #14 status-refresh documentation was merged to dev at d5fc9cc42e0476dcf24d85ea6d95815fb592497e.  
**Overall acceptance:** **INCOMPLETE / NOT RELEASE-READY**

This document records repository-visible implementation and hosted CI evidence. A green CI run does not establish real Windows, microphone, telephony, or Android-device acceptance.

## Implemented repository baseline

- Node.js 24 + TypeScript modular-monolith backend.
- Browser-based companion/HUD with text fallback and explicit push-to-talk flow.
- Device identity/session protocol using Ed25519, signed requests, timestamp/nonce replay protection, enrollment proof-of-possession, owner approval, TOTP step-up, and device/session revocation paths.
- Default-deny PolicyGateway, operation allowlist, permission checks, task-scoped approvals, single-use approval handling, and parameter/task/device binding checks.
- Hash-chained audit records, redaction, integrity verification, persistence handling, and fail-closed behavior when required security state is unhealthy.
- Read-only Windows system information for selected OS, memory, battery, and disk queries.
- Windows application launch adapter with a small static allowlist (Notepad, Calculator, Paint) and constrained Start-menu discovery.
- Windows foreground-window interaction adapter for text paste, selected-text copy, allowlisted hotkeys, zoom shortcuts, window/control inspection, and InvokePattern/ValuePattern actions selected by a unique control name or UI Automation AutomationId.
- Encrypted local personal-memory store with categories, TTL, integrity validation, and conservative rejection of credential/payment-like content.
- Optional local Piper TTS endpoint and browser speech-synthesis fallback.
- Official-store search-link generation; this is discovery/handoff, not silent app installation.
- Capability registry distinguishing implemented, partial, planned, and restricted features.
- Automated unit/integration tests and a browser smoke harness.

## Current hosted CI evidence

- new documentation head f82ff59da540cc011bf0ac77b93d4e75263d3445: [CI run 40099759927](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099759927) completed successfully.
- dev integration head d5fc9cc42e0476dcf24d85ea6d95815fb592497e: [CI run 40099889438](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099889438) completed successfully.
- The same integration commit passed CI on fix ([run 40099901244](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099901244)) and test ([run 40099904367](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099904367)). enhancement points to the same commit.
- PR #14 (status/documentation refresh) merged into dev at d5fc9cc42e0476dcf24d85ea6d95815fb592497e.
- These are repository automation results, not physical-device acceptance. npm audit remains unverified.

## Capability boundaries — do not overstate

### Voice and HUD
- The browser companion provides explicit push-to-talk and text fallback.
- Browser speech recognition may use browser/vendor or cloud processing; local-only recognition is not guaranteed.
- Always-ready local wake-word listening is a target requirement, not an accepted current capability. The voice manager defaults wake-word listening off.
- Piper TTS is optional and requires a compatible executable and model; actual audible playback and voice quality on the target laptop remain unverified.

### Windows desktop
- Start-menu discovery now uses conservative process-and-title identity hints for selected inbox apps (Settings, Microsoft Store, Photos, Clock); unknown discovered apps remain partial rather than being reported as independently verified.
- Desktop interaction targets the current foreground window.
- UI Automation depends on accessible controls. Read/click/set can use an exact control name or a discovered AutomationId, and the chosen selector must resolve to exactly one control. Custom-rendered or inaccessible controls may not be operable.
- Paste, hotkey and zoom acknowledgements do not prove the destination accepted or saved content; those outcomes remain partial unless independently verified.
- Foreground process/window-name checks for financial/payment apps are defense in depth, not complete semantic detection.
- This is not yet a universal desktop agent for every installed application.

### Android, communications and productivity
- The repository contains a browser companion, not a completed native Android device agent.
- Physical enrollment and revocation on both Android phones are not accepted.
- WhatsApp, SMS, normal cellular calls, VoIP calls, Teams messaging/meetings, email sending, calendar scheduling, and general Microsoft 365 workflows do not have complete end-to-end integrations in this POC.
- No native iOS implementation is in current scope.
- Store search produces official destinations; it does not silently install applications.

### Memory and automation
- The encrypted memory store is a foundation, not the complete user-facing lifecycle. Cross-device sync, semantic retrieval, conflict-resolution UI, retention workflows, and verified deletion across backups remain incomplete.
- Durable long-running workflow orchestration, recurring schedules, unattended recovery, and conditional automation are not complete.
- AI planning is deterministic/advisory in this version; planner output has no direct execution authority and must pass policy checks.

## Security properties to preserve

- No administrator privileges, unrestricted shell execution, security-control bypass, or voice-only high-risk authentication.
- Payment/financial application automation remains restricted.
- Every state-changing operation must pass the policy gateway and its applicable approval rules.
- Approval must remain bound to the task, device, operation, canonical parameters and expiry.
- Stop dependent workflow steps on failure or uncertainty; retry/rollback only when safe.
- Do not report success without outcome evidence.
- Keep main protected; development changes use non-main branches and PRs to dev.

## POC completion gate

The POC remains **NOT COMPLETE** until the blockers in [POC2.md](POC2.md) have acceptance evidence, target Windows interaction and voice behavior are verified, both Android devices pass required security tests, the application-integration boundaries are demonstrated, and exact-source CI is green. Move a capability to accepted status only after its real action and verification path pass.


## Conversational response layer — 2026-10-25

- Added an authenticated conversational route before the action planner. It handles stable identity answers and selected common AI questions in natural English.
- General questions can use an OpenAI-compatible chat-completions endpoint. The default endpoint is local Ollama at `http://127.0.0.1:11434/v1`; model defaults to `llama3.2`. Configure `JARVIS_AI_BASE_URL`, `JARVIS_AI_MODEL`, and optionally `JARVIS_AI_API_KEY` as appropriate.
- No cloud endpoint is selected by default. If the local/configured endpoint is unavailable, JARVIS returns a clear fallback instead of pretending that an AI answer was generated.
- Owner memories are supplied only when the authenticated device has device-management permission, and only a bounded set of records is included.
- The HUD now handles `state: ANSWERED` separately from action execution outcomes, displays the conversational message, and sends that message to speech output.
- The HUD requires explicit, per-session consent before starting browser speech recognition for push-to-talk or post-wake command capture. Consent is not persisted between page sessions because the browser recognition provider may process audio remotely.
- Push-to-talk speech is displayed in the editable transcript review panel and is not transmitted until the user explicitly selects **EXECUTE DIRECTIVE**. After local wake detection, if the separate post-wake browser-speech consent is enabled, the HUD captures the command and submits it through the existing policy gateway without a separate transcript-review click; this does not bypass policy denial or required approval.
- Continuous hands-free/browser wake detection is now blocked until a true local audio wake-word engine is configured; the current transcript matcher is not an audio-level local detector. The requested wake acknowledgement is `Hi sir, I am ready to work.` when a supported wake path is available.
- **Not yet verified on physical hardware:** browser recognition behavior, audible TTS timing, and end-to-end local model inference. No local wake-word capability is claimed.


## Implementation status refresh — 2026-10-26

A review of hosted run [40216510796](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40216510796) found that the TypeScript build and typecheck passed, but the automated suite had 3 stale HTTP-test expectations (127 tests passed). The affected tests were corrected on branch `new`: public status assertions now validate the measured, non-secret response schema, and the expired-approval test expects the terminal `EXPIRED` task state. Both remembered-approval tests passed in that run. The corrected source commit still requires a fresh completed CI result before the baseline can be described as green.

Remembered app-launch approval is currently configured for **30 minutes by default**, can be disabled with `JARVIS_REMEMBER_LAUNCH_MINUTES=0`, and can be set to 1–240 minutes. It applies only to the exact same app launch on the same device and never grants approval for typing, file changes, terminal execution, or other operations. Persistence across restarts requires the owner control token and a consistent state path. This policy is not a replacement for task-scoped, single-use approvals for other state-changing actions.


## Companion additions pending acceptance — 2026-10-27

Recent source changes on `new` add browser-companion notification polling, owner-scoped schedule management, and personal-memory review controls. The memory panel supports category-aware save, correction, and deletion requests; mutations continue through the signed policy-gated request path. The schedule panel supports one-time/recurring requests, listing, and cancellation. The delayed-recurring schedule grammar's regular expression has been corrected.

These additions are **implemented and pass hosted CI** on commit `9371ed3dba6a416cbd03ac5da105bc60a3a0fee9`: TypeScript build, typecheck, all 144 automated tests, and browser security smoke passed in run 40543314073. They are not yet accepted for full product release because physical Windows voice/UI tests and Android-device acceptance remain outstanding. Browser polling is not native Android push delivery. `main` remains untouched.


## Windows desktop control — completion increment (2026-10-30)

JARVIS supports a guarded Windows UI Automation path for inspecting accessible controls, reading a uniquely named control, invoking a uniquely named control, and setting a uniquely named non-sensitive value. The value-setting operation checks the value after writing; it is not considered successful merely because input was sent.

**Safety boundary:** desktop actions are limited to the current foreground window, go through the policy gateway, and require approval for state-changing actions. Credential/payment-related fields are blocked or redacted using Windows password metadata and label heuristics. Those heuristics are a defence-in-depth measure, not a guarantee that every sensitive field is detected. Actions must stop when a control name is ambiguous or the required UI Automation pattern is unavailable.

**Verification limitation:** UI Automation value readback confirms the control's exposed value, not necessarily that an application saved or submitted it. JARVIS must not claim a form was saved or a transaction completed without application-specific evidence. Real interactive acceptance on the target MSI laptop remains required.


### Target-process binding and acceptance requirements (2026-10-30)

Control-read, control-click and control-value requests can include an explicit process target (for example, `read control Document title in notepad`). JARVIS checks that the foreground process matches this target before executing the operation. Omitting the target means the operation applies to the current foreground process, still subject to the foreground guard and approval policy.

Acceptance on the actual MSI laptop remains a required release gate:
1. Open Notepad and a browser; test that a target-bound request is rejected when the wrong app is foreground.
2. Inspect the foreground window and verify that duplicate control names fail closed.
3. Test reading a harmless field, setting a harmless field, and invoking a harmless button; verify values and outcomes.
4. Confirm password and financial-labelled controls are redacted or blocked.
5. Test focus changes during a request and confirm no action is redirected to a different app.
6. Verify a saved test document by reopening/reading its file content; a control-value readback alone is not proof of persistence.
7. Record Windows version, app versions, pass/fail results, and sanitized evidence without recording document contents or secrets.

Automated CI covers the planner, policy, script construction, build, and regression tests. It cannot substitute for this interactive hardware acceptance.


## Android companion — inventory queue hardening (2026-10-30)

The read-only cross-device Android app-inventory queue now validates device identifiers, handles non-finite TTL values safely, rejects malformed/control-character app records and inventories above 300 entries, and avoids exposing internal result objects through returned references. Invalid inventory results do not transition a claimed command to completed. Regression tests were added for malformed input, queue expiry, oversize inventories and defensive-copy isolation.

**Acceptance status remains partial:** these are source-level safeguards for the in-memory inventory command path, not proof of secure end-to-end remote operation. The queue is volatile and limited to `android.app.list`; it does not provide durable delivery, background push, arbitrary phone control or physical two-phone acceptance. Exact-head CI and Android device testing remain required before acceptance.


## Advanced multi-step execution — encrypted checkpoint foundation (2026-10-30)

Added `src/core/taskJournal.ts` with AES-256-GCM encrypted task checkpoints, authenticated encryption, bounded journal size/count, atomic temporary-file replacement, defensive-copy reads, and fail-closed handling for unreadable/tampered state. On restart, non-terminal records are converted to `AWAITING_RECOVERY`; stale approval IDs are cleared and automatic resume is explicitly disabled. Added focused regression tests in `test/task_journal.test.ts`. The journal now also rolls back the in-memory record and marks itself unhealthy if a checkpoint write fails, preventing the running process from exposing an undurable task as current state; a regression test covers this failure path.

**Status: partial integration; not yet accepted as an end-to-end workflow feature.** A security follow-up also closes a stale-rejection path: `rejectTask` now requires the associated task to exist and remain in `AWAITING_APPROVAL` before resolving the approval. Rejection attempts against recovery/interrupted/cancelled tasks are audited and denied without consuming the approval; a regression test covers the recovery-state case. Exact-head execution remains unverified. `JarvisCoreService` now loads the encrypted journal when an owner control token is configured, restores persisted tasks, and checkpoints task creation, execution start, step results and workflow advancement. A failed checkpoint moves the live task to recovery-required and prevents the next dependent step from starting. Some early planning/error, expiry and revocation transitions still need full lifecycle coverage, and explicit reconcile/resume UX is not implemented. Exact-head CI and integration acceptance for crash/restart, partial side effects and safe reconciliation remain required. External side effects must be reconciled before retry; state-changing operations must never be automatically replayed after an uncertain outcome.

## Voice/HUD lifecycle hardening — 2026-10-30

The browser voice path now also stops and discards an in-flight capture immediately when the user unchecks browser-speech consent. Hiding the HUD stops active voice capture, clears the pending transcript, releases the audio meter, and stops any standby listener. Browser smoke coverage exercises mid-capture consent revocation and verifies that late recognition results cannot repopulate the discarded transcript.

**Acceptance boundary:** these are software lifecycle safeguards, not proof of always-ready local voice. The local wake-word engine/model is still not installed; hands-free wake detection must remain unavailable. Browser push-to-talk may send audio to a vendor service after explicit session consent. Local Piper TTS and audible playback, and physical MSI/browser/microphone acceptance, remain unverified.

## Local wake-word engine integration — 2026-10-30

Added an opt-in local wake-word runtime path for the HUD using the open-source onnx-wakeword browser engine, the English “Hey Jarvis” model package, and a one-time Windows setup script at `scripts/setup-local-wake-word.ps1`. The setup installs exact `onnxruntime-web@1.20.1` / `jszip@3.10.1` versions in an ignored local folder with a local npm lockfile, and downloads engine/model assets from immutable upstream commit `8002ba9a14d80c0f71447920d3f1c8ee986b1432`. Each downloaded upstream file is checked against its pinned Git blob hash before use. Assets remain ignored by Git; audio inference is performed in-browser on the device after setup. The server serves only a strict allowlist of local wake assets. If the assets are missing or fail to load, the HUD fails closed and keeps text and consent-gated push-to-talk available.

Wake-triggered browser speech recognition requires a separate, session-only checkbox from push-to-talk consent. Push-to-talk transcripts remain review-only until the user explicitly selects **EXECUTE DIRECTIVE**. After local wake detection, consented post-wake speech is submitted through the existing policy gateway; this does not bypass policy denial or required approval. If the browser rejects speech-recognition startup, the HUD clears pending capture state, reports that no command was sent, and schedules local wake standby recovery. The model/runtime is not bundled in Git and has not yet been installed or exercised on the target MSI. Therefore local wake detection is implemented as an integration path but is **not yet accepted as operational**. Exact-head CI and target-device microphone, false-trigger, resource-use and local TTS playback checks are required. As of the latest recorded attempt, hosted Actions jobs failed before runner assignment (`runner_id: 0`, no runner name, no steps), so source build/test status remains unknown until runner availability is restored.


## Task recovery review — implementation status (2026-10-30)

The new branch now exposes an authenticated POST /api/task/reconcile route for tasks already in AWAITING_RECOVERY or INTERRUPTED. The task owner can review their task; an active device with device-management permission can review another device's task. A review note and one of three explicit dispositions are required.

- **Confirmed no effect:** closes the original task as failed; the user must submit a new request if appropriate.
- **Effect observed:** records a partial outcome. It never marks the task completed from a user note alone.
- **Still unknown:** leaves the task awaiting recovery.
- All dispositions avoid automatic replay and do not start the next workflow step. The note is stored in the encrypted task journal; audit records contain only its length, disposition, reviewer and previous state.

The browser companion now includes a Recovery Review panel: it loads recovery tasks through the signed session and submits the selected disposition and note through the signed API. A browser smoke assertion checks the panel and authenticated task-list flow. Automated regression tests have been added, but they have not been executed in this chat environment. The exact-head CI result is not yet available. This feature is **implemented, pending automated validation**, and does not satisfy the real-application recovery acceptance gate by itself.

The follow-up lifecycle audit also adds checkpoint writes for early planning/denial paths, skipped workflow steps, rejection/expiry/cancellation, and final outcomes. A failed final checkpoint is returned as uncertain/recovery-required instead of verified completion. The HTTP recovery endpoint fails closed when the encrypted task journal is not configured.

**Release acceptance remains incomplete:** run build/typecheck/unit tests/browser smoke on the exact new head; then perform the crash/restart and uncertain-side-effect checklist on the target MSI. Do not interpret a manual note as proof that an application saved or submitted anything.


## Voice input validation follow-up — 2026-10-31

The local speech-recognition provider now rejects malformed RIFF/WAV containers and truncated chunks before starting the local recognition process. Regression tests cover container/chunk bounds, PCM format requirements, wake phrase boundaries, and explicit cloud-provider opt-in. Exact-head execution and Windows microphone/model/TTS acceptance remain pending; this change does not claim end-to-end voice completion.

The local Piper TTS adapter now caps captured audio at 16 MiB, bounds retained stderr to 8 KiB, and validates RIFF/WAV size and chunk boundaries before returning generated audio. Added regression tests cover valid WAV output, inconsistent RIFF size, truncated chunks, empty samples, and oversized buffers. These are source-level safeguards only; exact-head CI and audible Piper playback on the MSI remain unverified. The HUD's legacy transcript wake/stop matcher also now requires complete normalized phrase boundaries rather than substring matches; direct HUD-level regression coverage remains to be added.


## Voice capture completion idempotency — 2026-11-01

The HUD now guards each speech-recognition capture's terminal `onend` handler so a repeated terminal event cannot dispatch the same post-wake command twice. Push-to-talk remains review-first; consented post-wake capture still passes through the policy gateway. Tests remain paused and exact-head CI/MSI acceptance are pending.


## Voice cancellation cleanup hardening — 2026-11-01

The HUD now detaches the active browser recognizer before aborting a cancelled capture, stops the audio meter, and relies on capture-generation invalidation to ignore late callbacks. Recognition startup failures also stop the meter. Tests remain paused and exact-head CI/MSI acceptance remain pending.
