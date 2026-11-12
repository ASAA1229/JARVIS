# JARVIS — User Stories and Acceptance Criteria

## Owner-approved execution baseline — 2026-11-09

**Authority:** The owner has explicitly resumed development, testing and enhancement. This section supersedes prior statements in this document that testing/development is paused.

- **Active development branch:** `new` (baseline commit: `b669004bcad0278838c5edbe811eb90993009764`). Keep changes on this branch.
- **Testing:** ACTIVE. Run relevant automated checks and CI against each candidate commit; clearly separate automated results from owner-only laptop/Android acceptance.
- **Release boundary:** No merge to `dev` or `main`, no production deployment, public tunnel, Nexus publication, production-secret changes or paid service activation without separate explicit approval. Keep Nexus disabled.
- **Cost/privacy:** Zero recurring cost by default; local-first; optional cloud providers only when configured and explicitly authorized. Never commit credentials.
- **Safety:** Default-deny policy, least privilege, approval for sensitive operations, auditability, no unrestricted shell/admin elevation, no payment actions, and no automatic replay of uncertain side effects.
- **Target devices:** Windows 11 laptop first; two Android phones for companion/approval acceptance; iOS is future scope.

### Product decisions confirmed in the 50-question preference round

- Unified personal AI operating system with chat, voice, multimodal interaction, desktop control, task planning/execution, dashboard/HUD and background task monitoring.
- Hybrid local/cloud AI with automatic task-appropriate provider/model selection; extensible specialized agents under a central orchestrator.
- Owner-controlled short- and long-term memory, consent-based learning, extensible integrations, offline-first device synchronization and guarded autonomy.
- Adaptive cross-platform architecture, authentication options (MFA/passkeys/biometrics/device approval), risk-based authorization, audit logs and emergency shutdown.
- Complete long-term vision is a direction, not a requirement to defer a usable MVP until every feature exists. Deliver in dependency-ordered increments.

### Current branch evidence at authorization

- The `new` branch head is `b669004bcad0278838c5edbe811eb90993009764`.
- No CI status is attached to this exact SHA at the time of this documentation update. Historical local test counts and older CI runs are not proof for this commit.
- Known development/verification priorities remain: voice-to-command dispatch and independently verified Windows outcomes; owner-panel accessibility and API/UI contract alignment; memory lifecycle and cross-device recovery; multi-step partial-side-effect recovery; Android build/device acceptance; provider resilience and exact-head CI.
- Story states must be updated only from source inspection and executed evidence. Use **IMPLEMENTED — NEEDS TESTING**, **TEST FAILED**, **TEST PASSED (exact SHA)**, **OWNER ACCEPTANCE PENDING**, or **ACCEPTED** precisely; do not infer acceptance from file presence.

**Repository:** `ASAA1229/JARVIS`  
**Active branch:** `new`  
**Updated:** 2026-11-09  
**Rule:** Every story remains OPEN until its acceptance criteria are evidenced on the exact branch revision.

Epic mapping: [EPICS.md](EPICS.md)  
Project overview and implemented baseline: [../POC.md](../POC.md)  
Detailed remaining-work register: [../POC2.md](../POC2.md)

## Evidence boundary — 2026-11-09

Development and testing are ACTIVE on `new`. The current implementation increment is being validated by exact-head GitHub Actions; historical test results do not prove the current SHA. Owner panels, workflow composition and LAN peer management are present in source, but each story remains open until its own exact-head and owner-acceptance criteria are evidenced.

## Historical evidence boundary — 2026-11-07

Testing resumed on 2026-11-07: tsc, 249+3 Node tests (2 need an unlocked desktop), build, browser smoke, npm audit and 30 Python tests pass locally (see POC section 2). Device acceptance and exact-head CI are still outstanding, so no story is marked VERIFIED. Recent source increments include AI context-budget selection, Whisper process cancellation, transcription cancellation on disconnect, and immediate wake-triggered speech capture. The last item addresses the same-utterance capture-ordering race, but end-to-end voice recognition, policy dispatch, Windows app launch and verified outcome remain untested. All affected stories remain OPEN until evidence is recorded.

## Current story status — 2026-11-07

**Important:** “Verified” means the check was actually executed on 2026-11-07 (locally or on the target laptop); CI/Jenkins evidence is still pending because commits are not pushed. All stories remain open until their acceptance criteria are evidenced on the exact branch revision. No tests/build/lint/CI/device checks were run for this documentation update.

| Epic / story range | Status summary (2026-11-07) |
|---|---|
| E01 / US-001–005 | Core security DONE — VERIFIED LOCALLY; owner recovery (US-005) PARTIAL. |
| E02 / US-006–011 | HUD fixed and VERIFIED LOCALLY; wake runtime installed; live microphone test NEEDS TESTING; Piper PARTIAL. |
| E03 / US-012–016 | Launch/focus DONE — VERIFIED ON TARGET LAPTOP; UI Automation NEEDS TESTING; outcome proof PARTIAL. |
| E04 / US-017–020, US-034–040 | DONE — VERIFIED LOCALLY; crash/restart and scheduling drills NEED TESTING. |
| E05 / US-021–024 | Server side verified locally; phones NEED TESTING; offline queue PARTIAL. |
| E06 / US-025–027 | Memory privacy, deletion scrub and export DONE — VERIFIED LOCALLY; cross-device sync NOT STARTED. |
| E07 / US-028–031, US-041–048 | Local AI DONE — VERIFIED ON TARGET LAPTOP; agents verified locally; integrations PARTIAL. |
| Release / US-032–033 | Local checks pass; resources measured; CI run NEEDS TESTING. |
| E08 / US-049–053 | Integrity tooling VERIFIED LOCALLY; pipeline run NEEDS TESTING; Nexus disabled. |
| E09 / US-054–055 | Gateway DONE — VERIFIED ON TARGET LAPTOP; public tunnel NEEDS TESTING. |

### Story identifier clarification

Earlier versions reused `JARVIS-US-041` through `JARVIS-US-045` for both E07 AI-agent stories and E08 DevOps stories. To make references unambiguous, the E08 DevOps stories are identified in this refreshed register as `JARVIS-E08-US-049` through `JARVIS-E08-US-053`. The E07 story identifiers remain unchanged.

### Status definitions

- **DONE — VERIFIED ON TARGET LAPTOP:** executed on the owner's Windows 11 laptop with real apps/models.
- **DONE — VERIFIED LOCALLY (automated):** automated tests pass on the current head locally.
- **IMPLEMENTED — NEEDS TESTING:** code exists; the named manual/device test has not been run.
- **PARTIAL — NEEDS DEVELOPMENT:** material behaviour is still missing.
- **NOT STARTED:** no implementation yet.


## JARVIS-E01 — Security, Identity & Approval Foundation

### JARVIS-US-001 — Trusted device identity

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Ed25519 device identity, signed requests, replay/expiry rejection covered by the passing suite. Needs: exact-head CI run.

**As the owner,** I want every connected device to have its own cryptographic identity, so that one device cannot impersonate another.

**Acceptance criteria**
- Each device has a distinct key pair and device identifier.
- Requests are signed and validated against the enrolled public key.
- Invalid signatures, unknown devices, expired sessions and replayed nonces are rejected.
- Device enrollment requires owner-authorized proof of possession.
- No private key is returned through APIs, logs or audit records.

### JARVIS-US-002 — Policy-gated execution

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Default-deny policy paths covered by tests. Needs: exact-head CI run.

**As the owner,** I want every state-changing action to pass one default-deny policy gateway, so that no adapter or endpoint can bypass authorization.

**Acceptance criteria**
- Every execution path checks device permission, operation allowlist and policy decision.
- Unknown operations and malformed parameters fail closed.
- Direct adapter access cannot execute a protected action.
- Financial/payment actions, credential entry, admin elevation and unrestricted shell remain blocked.

### JARVIS-US-003 — Scoped single-use approval

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Single-use, task-bound approvals; expired approvals now return 409 (fixed 2026-11-07).

**As the owner,** I want approvals bound to the exact task and action, so that approval cannot be reused for a different operation.

**Acceptance criteria**
- Approval is bound to task, device, operation, canonical parameters and expiry.
- Approval is consumed at most once.
- Duplicate, concurrent, stale, expired and revoked approvals are rejected.
- A task outside the pending-approval state cannot be approved or rejected through a stale record.

### JARVIS-US-004 — Tamper-evident audit and fail-closed persistence

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Hash-chained audit, redaction and fail-closed persistence tested; audit chain stayed valid in device runs.

**As the owner,** I want security-relevant actions recorded in a tamper-evident audit trail, so that failures and misuse can be investigated.

**Acceptance criteria**
- Audit entries are hash chained and integrity is verified.
- Sensitive values, credentials, tokens and signatures are redacted.
- Audit/security persistence failure blocks dependent execution.
- Tampering is detected and recovery behavior is documented.

### JARVIS-US-005 — Owner recovery and device revocation

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Owner-token recovery on the JARVIS host (`npm run owner-recovery -- reset-authenticator | revoke-device <id> | revoke-all`, `POST /api/owner/recovery`): loopback-only, rate-limited, explicit confirmation, audited without secrets; revoke-all reopens bootstrap enrollment and old keys cannot re-enroll. Tests are authored in `test/owner_recovery.test.ts`; exact-head execution evidence is tracked by CI.

**As the owner,** I want to recover account control and revoke a lost device, so that device loss does not compromise JARVIS.

**Acceptance criteria**
- Owner recovery covers authenticator/TOTP loss and device-management loss.
- Revocation takes effect for new requests immediately.
- Revoked devices cannot replay old requests or regain access without fresh enrollment.
- Recovery events are audited without exposing secrets.

## JARVIS-E02 — Voice Interaction & Cinematic HUD

### JARVIS-US-006 — Local wake phrase

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Wake-word runtime and “Hey Jarvis” model installed and loading in Edge in 1.6 s. Test: owner speaks into the laptop microphone; measure false triggers and resource use.

**As the owner,** I want to say “Hey Jarvis” and wake JARVIS locally, so that routine wake detection does not require continuous cloud audio upload.

**Acceptance criteria**
- Wake detection uses the configured local engine/model.
- Microphone listening is visibly indicated and can be muted/stopped immediately.
- Wake accuracy, false triggers, startup, sleep/resume and resource use are measured on the MSI.
- Wake detection is disabled until the owner explicitly enables it.
- No continuous cloud audio upload is used for wake detection.

### JARVIS-US-007 — Clear wake acknowledgement

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Acknowledgement wired after captured wake command. Test: audible playback on the laptop.

**As the owner,** I want JARVIS to respond with “Hi sir, I am ready to work.” after a valid wake, so that I know it is ready.

**Acceptance criteria**
- The acknowledgement is played only after a confirmed wake event.
- Playback state and failures are visible.
- Cancellation/mute stops output promptly.
- No acknowledgement is reported as played unless playback actually starts.

### JARVIS-US-008 — Consent-controlled speech capture

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Session consent, revocation and late-callback discard covered by browser smoke.

**As the owner,** I want separate, explicit consent for any browser/vendor speech recognition, so that I understand when audio may leave the device.

**Acceptance criteria**
- Browser speech recognition is off until the owner opts in.
- Consent is session-scoped and revocation cancels active capture.
- Provider/network behavior is disclosed before activation.
- Late callbacks after cancellation are ignored.
- Local-only processing is claimed only when verified.

### JARVIS-US-009 — Review-before-execute push-to-talk

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Review-before-execute push-to-talk covered by browser smoke with a mock recognizer. Test: real microphone.

**As the owner,** I want to review and edit a recognized transcript before submission, so that speech errors do not trigger unintended actions.

**Acceptance criteria**
- Transcript appears in an editable review area.
- No request is submitted before explicit execute action.
- Cancel, timeout, no-speech and recognition errors discard or retain the transcript according to a clear user-visible rule.
- Duplicate completion callbacks cannot submit the same capture twice.

### JARVIS-US-010 — Voice action policy and result feedback

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — HUD SyntaxError that blocked all voice dispatch fixed; voice-style phrases (“Hey/OK Jarvis, open Notepad”) verified through the signed API on the laptop. Test: end to end from the real microphone.

**As the owner,** I want spoken commands to use the same authenticated policy and approval path as typed commands, so that voice cannot bypass security.

**Acceptance criteria**
- Voice text is normalized and submitted through authenticated request signing.
- Policy denial and required approval are respected.
- The HUD distinguishes received, planned, awaiting approval, executed, partial, failed and verified outcomes.
- Acknowledgement alone is never presented as proof of successful execution.

### JARVIS-US-011 — Local speech output and HUD usability

**Current implementation status:** **PARTIAL — NEEDS DEVELOPMENT** — Barge-in and output lifecycle tested; Piper binary/model not installed and audible output unverified.

**As the owner,** I want local speech output and an accessible HUD, so that I can use JARVIS comfortably without mandatory cloud services.

**Acceptance criteria**
- Configured local TTS binary/model works on the MSI and audible output is verified.
- Stop/mute, timeout, hidden-tab and playback-error paths clean up resources.
- HUD supports keyboard access, readable status, responsive layout and visible privacy controls.
- Browser speech-synthesis fallback is clearly identified as a fallback.

## JARVIS-E03 — Windows Desktop Control

### JARVIS-US-012 — Safe allowlisted app launch

**Current implementation status:** **DONE — VERIFIED ON TARGET LAPTOP** — Notepad, Calculator and Paint launched and verified via signed API + approval on the target laptop (2026-11-07).

**As the owner,** I want JARVIS to launch supported Windows apps, so that routine desktop tasks can be delegated safely.

**Acceptance criteria**
- Launch requests are limited to an explicit allowlist or trusted discovery result.
- Target process identity is verified independently of a matching title alone.
- Unknown or ambiguous apps are reported as unsupported/partial.
- Real MSI tests cover Notepad, Calculator and Paint.

### JARVIS-US-013 — Correct foreground-window targeting

**Current implementation status:** **DONE — VERIFIED ON TARGET LAPTOP** — Foreground targeting fixed for focus-lock and Store apps; verified on the laptop; desktop lock correctly blocks actions.

**As the owner,** I want JARVIS to verify the active window before interaction, so that text is never entered into the wrong application.

**Acceptance criteria**
- Target process/window identity is checked immediately before each action.
- Focus change or ambiguous identity aborts the action.
- No text is typed after target mismatch.
- The user receives a clear stopped/uncertain result.

### JARVIS-US-014 — Safe UI Automation controls

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — UI Automation read/click/set implemented with unit tests. Test: real apps on the laptop.

**As the owner,** I want JARVIS to inspect and operate supported UI controls, so that I can automate common desktop interactions.

**Acceptance criteria**
- Controls are selected by exact unique name or trusted AutomationId.
- Ambiguous or inaccessible controls fail closed.
- Read/click/set operations are constrained by policy and sensitive-field deny rules.
- Real-app evidence records the control, action and outcome.

### JARVIS-US-015 — Clipboard, keyboard and zoom helpers

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Clipboard/hotkey/zoom paths require a named target app (tests updated). Test: real apps on the laptop.

**As the owner,** I want bounded clipboard, hotkey and zoom actions, so that JARVIS can assist with common desktop workflows.

**Acceptance criteria**
- Only allowlisted hotkeys and supported operations are accepted.
- Target window is verified before input.
- Cancellation and unexpected focus changes stop further input.
- Acknowledgement is distinguished from destination acceptance or persistence.

### JARVIS-US-016 — Independent outcome verification

**Current implementation status:** **PARTIAL — NEEDS DEVELOPMENT / TARGET-DEVICE ACCEPTANCE** — The Windows launcher now uses conservative Start-menu AppID-to-process identity mapping, excludes shell-host identities, and requires a unique matching window before reporting verified launch; ambiguous or unknown targets remain partial. General app-specific proof that an application saved/submitted a change is still not available, and the complete voice-to-app flow has not been accepted on the target MSI laptop.

**As the owner,** I want JARVIS to verify whether an application accepted or saved a change, so that it does not claim success based on an input event alone.

**Acceptance criteria**
- Verification uses independent observable evidence where available.
- Missing evidence yields partial/uncertain status.
- Unsupported verification is disclosed.
- No false success is returned for title-only or acknowledgement-only evidence.

## JARVIS-E04 — Multi-Step Execution & Recovery

### JARVIS-US-017 — Durable task lifecycle

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Encrypted checkpoints, fail-closed persistence covered by tests.

**As the owner,** I want workflow state persisted before dependent side effects, so that crashes do not silently lose task progress.

**Acceptance criteria**
- Task creation, step transitions, approvals, cancellation and terminal outcomes are checkpointed.
- A failed checkpoint blocks the next side effect.
- Journal content is encrypted, bounded and schema-validated.
- Persistence failure marks the task uncertain/recovery-required.

### JARVIS-US-018 — Safe restart recovery

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Recovery-state restore tested in-process. Test: real crash/restart drill.

**As the owner,** I want interrupted tasks to be restored for review, so that JARVIS never blindly repeats an action after restart.

**Acceptance criteria**
- Non-terminal tasks restore to a recovery state.
- Stale approvals are cleared.
- No state-changing task automatically resumes or replays.
- Terminal task states remain terminal.

### JARVIS-US-019 — Human-reviewed reconciliation

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Reconciliation API and HUD review covered by tests and browser smoke.

**As the owner,** I want to review uncertain task outcomes and record what happened, so that recovery is explicit and auditable.

**Acceptance criteria**
- Only authorized devices/users can reconcile eligible tasks.
- `confirmed_no_effect` closes the task as failed without replay.
- `effect_observed` remains partial unless independently verified.
- `still_unknown` remains awaiting recovery.
- Notes are encrypted; audit records contain no raw sensitive note.
- No reconciliation disposition starts dependent workflow steps.

### JARVIS-US-020 — Safe scheduling and cancellation

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Scheduling/cancel tested in-process. Test: restart and timezone behaviour on the laptop.

**As the owner,** I want scheduled tasks to persist and cancel safely, so that recurring work behaves predictably.

**Acceptance criteria**
- Schedule creation/list/cancel is authenticated and permission-gated.
- Recurrence and timezone behavior are explicit.
- Failed persistence prevents execution.
- Cancellation and revocation prevent future execution.
- Restart behavior is tested.

## JARVIS-E05 — Android Companion & Cross-Device Control

### JARVIS-US-021 — Independent Android enrollment

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Server-side enrollment verified locally; APK not built here (no Android SDK). Test: install and enrol both phones.

**As the owner,** I want to enroll each of my two Android phones separately, so that each phone has its own trusted identity.

**Acceptance criteria**
- Both phones use distinct Android Keystore-backed keys.
- Enrollment requires owner authorization and proof of possession.
- Device identity, session and permissions are independently visible.
- One phone cannot impersonate the other.

### JARVIS-US-022 — Secure phone-to-laptop command channel

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Signed, replay-protected API verified locally. Test: phone-to-laptop over the network.

**As the owner,** I want my phones to send authenticated requests to the laptop, so that companion actions remain secure across the network.

**Acceptance criteria**
- Requests are signed, replay-protected and expiry-checked.
- Transport and laptop reachability errors are handled safely.
- The phone cannot expand its own permission scope.
- Stale queued state-changing commands are rejected on reconnect.

### JARVIS-US-023 — Phone approvals and revocation

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Approval/revocation API verified locally. Test: approve and revoke from each phone.

**As the owner,** I want to approve eligible tasks from either phone and revoke a lost phone, so that I retain control while away from the laptop.

**Acceptance criteria**
- Approval displays the exact task/action/parameters and risk.
- Phone approval obeys the same single-use policy as laptop approval.
- Revoking phone A leaves phone B independently usable.
- Revoked phone A cannot act or replay commands.

### JARVIS-US-024 — Offline queue and recovery

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Queue is read-only (state-changing phone actions are never queued), bounded and TTL ≤ 60 s; queued commands are revalidated (requester/target active and permitted) at claim and completion; duplicate results are acknowledged without overwrite; requester cancel is idempotent; revocation cancels. Tests authored, not yet run; physical two-phone check pending.

**As the owner,** I want safe handling when the laptop or phone is offline, so that queued work cannot execute unexpectedly later.

**Acceptance criteria**
- Queue items have bounded payloads and explicit TTL.
- Informational requests may be handled according to policy.
- State-changing commands are revalidated and re-approved as required after reconnect.
- Duplicate completion, timeout and cancellation are handled idempotently.

## JARVIS-E06 — Memory, Privacy & Personalization

### JARVIS-US-025 — Private local memory

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Encryption, TTL, category and secret/instruction rejection tested; documented in docs/MEMORY_PRIVACY.md.

**As the owner,** I want JARVIS to remember useful preferences and context locally, so that it can assist without sending all personal data to a cloud service.

**Acceptance criteria**
- Memory is encrypted at rest and integrity-checked.
- Categories, TTL and data restrictions are enforced.
- Credentials, payment data and other prohibited secrets are rejected.
- Reads are permission-aware and bounded.

### JARVIS-US-026 — Owner-controlled memory lifecycle

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Deletion scrubs task history and journal (re-decrypted from disk); owner export endpoint + companion button; retention/backup documented. Test: owner uses export/delete in the companion.

**As the owner,** I want to review, correct, export and delete memories, so that I control what JARVIS retains.

**Acceptance criteria**
- Create/read/update/delete operations use signed, policy-gated routes.
- Deletion is confirmed and auditable.
- Retention and backup behavior are documented.
- Deletion evidence covers primary data and all configured secondary stores.

### JARVIS-US-027 — Cross-device memory consistency

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Hub sync (`src/sync/*`, `/api/sync/*`): DEVICE_MANAGE-only memory categories, offline changes revalidated with TTL/sequence, conflict records for owner review, held offline commands, peer envelope signing, HUD Sync & conflicts, Android SyncClient, and Android owner-panel review/resolution for conflicts (keep laptop, keep phone, or merge) plus explicit run/discard decisions for held commands. Held-command execution remains laptop policy/approval-gated. Test: run `test/device_sync.test.ts`, HTTP push/pull/resolve, and a two-phone concurrent-edit + revocation drill (docs/DEVICE_SYNC.md).

**As the owner,** I want memory to remain consistent across my laptop and phones, so that companion devices share only authorized context.

**Acceptance criteria**
- Sync is authenticated and encrypted.
- Conflicts are surfaced or resolved deterministically.
- Device permissions determine which memory categories can be read.
- Offline changes cannot silently overwrite newer owner data.

## JARVIS-E07 — AI, Integrations & Productivity Automation

### JARVIS-US-028 — Local-first conversational AI

**Current implementation status:** **DONE — VERIFIED ON TARGET LAPTOP** — Local llama3.2 installed via Ollama and answering on the laptop; honest fallback tested.

**As the owner,** I want JARVIS to answer ordinary questions using a local model by default, so that routine assistance works without paid cloud usage.

**Acceptance criteria**
- Local endpoint/model configuration is explicit.
- Unavailable local inference returns an honest fallback.
- AI output is treated as untrusted content and cannot execute actions directly.
- No secret is committed to the repository.

### JARVIS-US-029 — Explicit cloud AI opt-in

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Remote AI blocked unless JARVIS_AI_ALLOW_REMOTE is set; tested.

**As the owner,** I want cloud AI to be used only when I authorize a task, so that cost and data exposure remain under my control.

**Acceptance criteria**
- Cloud endpoint is not selected by default.
- Each cloud use is task-scoped and clearly disclosed.
- API keys are supplied through local environment configuration only.
- No continuous audio upload or unrestricted memory transfer occurs.

### JARVIS-US-030 — Existing productivity workflows

**Current implementation status:** **PARTIAL — NEEDS DEVELOPMENT** — Schedule/notification/memory workflows exist; broader productivity integrations not built.

**As the owner,** I want existing schedule, notification and companion workflows to work end to end, so that JARVIS can assist with routine organization.

**Acceptance criteria**
- Create/list/cancel and notification flows use authenticated APIs.
- Persistence, recurrence, timezone, restart and cancellation behavior are verified.
- Errors are visible and do not create duplicate tasks.
- Unsupported integrations are explicitly labelled unsupported.

### JARVIS-US-031 — Explicit integration boundaries

**Current implementation status:** **PARTIAL — NEEDS DEVELOPMENT** — Unsupported channels labelled unsupported; no new third-party integrations.

**As the owner,** I want each third-party integration to disclose its permissions and limits, so that JARVIS does not silently access accounts or send communications.

**Acceptance criteria**
- Integration access is opt-in and least-privilege.
- Sending messages, emails, calls, calendar invitations or other external side effects requires explicit user intent and applicable approval.
- Unsupported services are not represented as implemented.
- Financial/payment workflows remain excluded.

## JARVIS-G01 — Release, Compatibility & Resource Acceptance

### JARVIS-US-032 — Evidence-based release readiness

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — All local checks pass on the current head. Test: CI/Jenkins run on the pushed commit and device evidence report.

**As the owner,** I want one exact-head verification report, so that I know which capabilities are genuinely ready.

**Acceptance criteria**
- Build, typecheck, unit/integration, browser smoke, Python and Android checks are recorded where applicable.
- CI evidence points to the exact commit being evaluated.
- Target-device evidence identifies device/OS, scenario, expected result, actual result and limitations.
- Dependency/security audit output is recorded.
- No unverified feature is marked accepted or release-ready.

### JARVIS-US-033 — Balanced resource and compatibility behavior

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Idle footprint measured on the laptop: 0 % CPU, 66 MB working set, 34 MB private, 12 threads, ~10 ms per status request; model adds ≈2.3 GB RAM. Test: battery, sleep/resume and active-load measurements.

**As the owner,** I want JARVIS to run smoothly on my existing laptop and phones, so that I do not need new hardware for the planned baseline.

**Acceptance criteria**
- Idle and active CPU/RAM/disk/network/battery usage are measured.
- Unsupported OS/browser/device combinations fail clearly and safely.
- HUD is keyboard-accessible and responsive.
- No admin privileges or always-on cloud dependency is introduced to meet resource goals.

### JARVIS-US-034 — Bounded transcription and recovery

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Bounded transcription and Whisper cancellation covered by tests.

**As the owner,** I want stalled speech transcription to time out safely, so that voice input cannot remain locked indefinitely and partial text is never executed without review.

**Acceptance criteria**
- Transcription has a configurable, validated maximum duration independent of microphone capture duration.
- A stalled transcription transitions to transcript review when partial text exists, otherwise returns to idle.
- Partial transcripts are never automatically dispatched when the timeout fires.
- Completing, cancelling, muting or disposing transcription clears its timeout.
- A stale timeout cannot change the state of a later capture.
- Invalid transcription timeout configuration fails closed and allows a later fresh capture.

### JARVIS-US-035 — Reuse and verify an already-open application

**Current implementation status:** **DONE — VERIFIED ON TARGET LAPTOP** — Existing-window reuse verified on the laptop for Notepad, Paint and Store-app Calculator.

**As the owner,** I want “open [application]” to bring an already-running application to the foreground when its window is uniquely identifiable, so that JARVIS does not create duplicate processes or report a launch that was not visibly completed.

**Acceptance criteria**
- Before spawning an allowlisted application, JARVIS takes a fresh visible-window snapshot.
- If exactly one window matches the allowlisted process identity and title constraints, JARVIS focuses that exact PID.
- Success is reported only when foreground focus is verified by Windows.
- If focus fails, JARVIS reports failure and does not claim that the application is ready.
- Multiple matching windows are never selected arbitrarily.
- If no unique existing window is found, the normal allowlisted launch and post-launch verification path remains in effect.
- Tests cover existing-window reuse and focus failure; target-Windows acceptance covers both already-open and cold-launch scenarios.



### JARVIS-US-036 — Prevent duplicate approval resolution and report uncertain outcomes

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Duplicate approval resolution and uncertain-outcome UI covered by browser smoke.

**As the owner,** I want approval controls to prevent overlapping submissions and clearly distinguish approval processing from verified task completion, so that a double-click or network interruption does not mislead me about whether an action ran.

**Acceptance criteria**
- Both approval-card actions are disabled while a resolution request for that approval ID is in flight.
- A second click for the same approval ID while the first request is pending is ignored.
- Controls are restored only after the request settles and only if the card remains present.
- A rejection is acknowledged only when the server confirms `success: true`.
- An approved task is labelled completed only when state is `COMPLETED`, success is true, outcome is `VERIFIED_SUCCESS`, and verified is true.
- Terminal failed/rejected/expired/cancelled/partial/recovery states are not presented as successful completion.
- Unknown or non-terminal outcomes remain visibly unresolved; communication ambiguity instructs the owner to refresh task status before retrying.
- No test or CI result is implied by implementation alone.


### JARVIS-US-037 — Review task history and reconcile interrupted work from the HUD

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Task history and recovery review covered by tests and browser smoke.

**As the owner,** I want to review recent task states and record a manual recovery decision from the companion HUD, so that interrupted or uncertain work can be reconciled without accidentally replaying an action.

**Acceptance criteria**
- The HUD retrieves recent task records through the authenticated task-list endpoint and supports manual refresh.
- Task history refreshes after directive submission and approval resolution, and periodically while the HUD is active.
- Task cards show operation, state, origin, timestamps, and expandable step summaries without exposing task parameters or result payloads.
- Only `AWAITING_RECOVERY` and `INTERRUPTED` tasks show the manual reconciliation form.
- The owner can submit only the server-supported dispositions: `confirmed_no_effect`, `effect_observed`, or `still_unknown`.
- A note of 8–500 characters is required and submission uses the signed API request.
- The UI clearly states that reconciliation is a human review/annotation and never retries, resumes, or replays the task.
- API authentication, task ownership, durable journal availability, and input validation remain enforced by the server.
- Tests and target-device acceptance are separate gates; implementation alone does not mark this story accepted.


### JARVIS-US-038 — Inspect task details and understand recovery transitions

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Task detail and recovery transition messaging covered by tests.

**As the owner,** I want a dedicated expandable task-detail view and precise recovery feedback, so that I can understand a task's lifecycle and the meaning of a manual reconciliation decision without confusing observation with verified completion.

**Acceptance criteria**
- Each recent task exposes an expandable detail view containing task reference, operation, current state, origin, creation/update timestamps, and available step status/message history.
- Only explicitly allowlisted metadata is displayed; raw task parameters and result payloads remain hidden.
- Recovery review submission is protected against duplicate in-flight requests for the same task.
- Successful reconciliation feedback names the selected disposition and displays the state returned by the server when available.
- `effect_observed` is not described as independently verified completion; `still_unknown` remains unresolved; `confirmed_no_effect` does not trigger replay.
- Task history refreshes after a confirmed review, and the UI never retries, resumes, or replays the task.
- Tests and target-device acceptance remain separate gates; implementation alone does not mark this story accepted.


### JARVIS-US-039 — Stop a workflow and prevent dependent steps from running

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Stop/cancel and dependent-step boundary covered by tests.

**As the owner,** I want to stop a running workflow or cancel a pending task from the companion HUD, so that no later dependent action starts after I request cancellation.

**Acceptance criteria**
- Executing tasks expose a stop/interruption control; created and approval-pending tasks expose cancellation.
- Requests use the authenticated signed cancellation endpoint and enforce task ownership/owner permissions server-side.
- Duplicate in-flight stop/cancel requests for the same task are suppressed.
- An interrupted current operation is treated as uncertain because its external effect may already have occurred.
- Remaining planned workflow steps are recorded as skipped and no later step is evaluated or executed.
- The HUD distinguishes interruption from rollback and directs the owner to reconcile uncertain effects.
- Tests, cancellation race/fault injection, and target-device acceptance remain separate gates.


### JARVIS-US-040 — Enforce lifecycle checkpoints across asynchronous workflow boundaries

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Asynchronous transition guards covered by tests.

**As the owner,** I want task state to be rechecked and durably checkpointed whenever planning or approval resumes, so that cancellation, expiry, revocation, or persistence failure cannot be bypassed by a delayed callback.

**Acceptance criteria**
- A task cancelled while planning is in progress cannot proceed to policy evaluation or execution when the planner later returns.
- Policy evaluation proceeds only for a newly created workflow step or an explicitly approved task state.
- Approval expiry moves the task to EXPIRED, records the skipped dependent steps, and returns without evaluating or executing the operation.
- A successful approval is durably checkpointed as APPROVED before policy evaluation can reach an adapter.
- If the approval checkpoint fails, execution is blocked and the task remains in recovery; the approval is invalidated where possible.
- Concurrent/stale approval, rejection, cancellation and revocation requests cannot move a task backwards into an executable state.
- Tests, fault injection and target-device acceptance remain separate gates; implementation alone does not mark this story accepted.

## Additional AI-agent and conversation stories — JARVIS-E07

### JARVIS-US-041 — Use versioned role-separated prompts

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Versioned role-separated prompts tested (type error fixed 2026-11-07).

**As the owner,** I want JARVIS to construct prompts using explicit system, developer and user roles with versioned templates, so that agent behavior is consistent, reviewable and safely maintainable.

**Acceptance criteria**
- Each supported prompt has a stable identifier, explicit version and declared message roles.
- System instructions, application/developer rules and user/task data remain separate.
- Required template variables are validated; missing or unexpected variables fail safely.
- User content, conversation history, retrieved memory and tool results are treated as untrusted data, never as instructions that override higher-priority policy.
- Prompt changes are traceable to a version; no hidden reasoning or secrets are exposed in outputs or logs.

### JARVIS-US-042 — Validate structured agent responses

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Structured response validation tested.

**As the owner,** I want each agent profile to return a strict, machine-readable response contract, so that malformed or unexpected model output cannot flow into JARVIS workflows.

**Acceptance criteria**
- Each profile has a versioned schema with required fields, types, bounds and no undeclared properties where strictness is required.
- Responses are parsed and validated locally before use.
- Invalid, refused, oversized or incomplete output is rejected or handled through a safe fallback.
- Confidence, clarification and safety fields have documented semantics.
- Raw model text is never treated as an executable instruction.

### JARVIS-US-043 — Route requests to the appropriate advisory agent

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Routing tested with fake models. Test: advisory agents against the live local model.

**As the owner,** I want JARVIS to route planning, tool-selection, summarization and developer-assistance requests to the appropriate agent profile, so that each task receives focused behavior.

**Acceptance criteria**
- Routing is deterministic, bounded and observable through safe metadata.
- Ambiguous requests ask for clarification or use a safe general response.
- Advisory agents cannot call desktop/device adapters or perform state changes.
- Requests with execution intent continue through the existing planner and policy gateway.
- Agent timeout, unavailable model and invalid output produce an honest fallback without bypassing authorization.

### JARVIS-US-044 — Prefer local AI inference and gate remote providers

**Current implementation status:** **DONE — VERIFIED ON TARGET LAPTOP** — Local model is the default and answered live on the laptop; remote gating tested.

**As the owner,** I want local inference to be the default and remote AI to require explicit configuration, so that routine assistance does not incur mandatory cloud cost or disclose personal context unexpectedly.

**Acceptance criteria**
- Local endpoint and model selection are explicit and configurable.
- Remote endpoints remain blocked unless the owner deliberately enables them.
- Remote requests receive only task-authorized, minimum-necessary context.
- API keys are supplied through local environment configuration and never committed or returned.
- Timeout, refusal, network failure and unavailable-model cases fail safely without pretending a model response was generated.

### JARVIS-US-045 — Maintain bounded device-isolated conversation history

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Device-isolated bounded history tested.

**As the owner,** I want JARVIS to preserve recent conversation turns for continuity while isolating sessions by authenticated device, so that follow-up requests have relevant context without unbounded retention.

**Acceptance criteria**
- A conversation session is bound to the authenticated device identity.
- History contains only visible user and assistant turns; system/developer prompts and hidden reasoning are excluded.
- Message count, individual message size, total history size and session lifetime are bounded.
- History trimming preserves complete user/assistant turns.
- Session expiry, capacity eviction and device revocation cannot expose another device's conversation.
- Clear-conversation requests are authenticated, ownership-checked and serialized against in-flight messages.

### JARVIS-US-046 — Preserve conversation ordering and truthful persistence

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Per-conversation ordering and truthful persistence tested.

**As the owner,** I want concurrent messages to be processed in order and fallback responses handled honestly, so that conversation context is not corrupted or misleading.

**Acceptance criteria**
- Requests for the same conversation are serialized.
- Clearing a conversation cannot race with an in-flight turn and recreate stale history.
- Only responses eligible for persistence are appended to history.
- Model-unavailable/configuration fallbacks are not stored as if they were substantive assistant answers.
- Session limits and eviction are enforced without leaking locks or unbounded state.

### JARVIS-US-047 — Validate tool-selection candidates against trusted capabilities

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Capability catalogue validation tested.

**As the owner,** I want tool-selection agents to choose only capabilities that JARVIS actually supports, so that invented or restricted tool names cannot enter an execution plan.

**Acceptance criteria**
- Every candidate identifier resolves to the authoritative capability catalogue.
- Unknown and restricted capabilities are rejected.
- Risk, approval requirements, platform support and device-agent requirements are sourced from the server-side catalogue, not trusted from model output.
- Candidate selection remains advisory and does not itself invoke a capability.
- Final execution still requires planner validation and policy-gateway authorization.

### JARVIS-US-048 — Validate task-plan dependency graphs

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Plan dependency graph validation tested.

**As the owner,** I want generated task plans to have valid dependency graphs, so that workflows cannot contain missing references, cycles or ambiguous ordering.

**Acceptance criteria**
- Step identifiers are unique and dependencies reference existing steps.
- Self-dependencies and duplicate dependencies are rejected.
- Cycles are rejected and valid plans have a deterministic topological order.
- A plan marked ready contains at least one actionable step.
- Plan size, step descriptions and dependency counts are bounded.
- Generated plans remain proposals until reviewed and authorized by the execution pipeline.


## JARVIS-E08 — Shared DevOps Pipeline, Provenance & Artifact Integrity

### JARVIS-E08-US-049 — Generate traceable build provenance

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Provenance manifest code and tests pass locally. Test: first CI run after push.

**As a release maintainer,** I want each build artifact to carry a machine-readable provenance manifest, so that its project, source revision and CI origin can be traced.

**Acceptance criteria**
- The manifest identifies project, repository, normalized branch, full source commit, build number and CI provider/run.
- Required provenance fields are explicit, non-placeholder and validated.
- In CI, manifest identity agrees with available environment metadata.
- A deterministic release identity binds the manifest to its project/source/build identity.
- Missing or inconsistent required provenance fails closed.

### JARVIS-E08-US-050 — Verify artifact contents and checksums

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Manifest/SHA-256/archive verification tested (Python + Node).

**As a release maintainer,** I want manifest inventory and SHA-256 metadata validated before accepting an artifact, so that malformed or modified packages are rejected.

**Acceptance criteria**
- Manifest schema version and checksum algorithm are supported and validated.
- File inventory is an array whose entry count matches the declared file count.
- Each entry has a safe relative path, unique normalized path, non-negative safe-integer size and canonical SHA-256 digest.
- Malformed inventory metadata is rejected before checksum verification.
- Archive-member comparison verifies packaged files against the declared inventory; until implemented and evidenced, archive-content verification remains open.

### JARVIS-E08-US-051 — Verify customer-delivered packages against a release

**Current implementation status:** **DONE — VERIFIED LOCALLY (automated)** — Customer package verification tested (30 Python tests).

**As a customer-support or release operator,** I want a deterministic verification sequence and actionable report, so that delivery failures can be diagnosed without accepting an untrusted artifact.

**Acceptance criteria**
- The verifier authenticates and evaluates manifest-ignore policy before processing the manifest.
- It validates manifest schema, provenance and release identity before package acceptance.
- It verifies package checksum against trusted release metadata.
- Failure output identifies the failed stage and reason without leaking secrets or private key material.
- Legacy compatibility is explicit and does not weaken strict-provenance mode.

### JARVIS-E08-US-052 — Produce signed, SBOM-backed build artifacts through controlled CI

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — SBOM/signing steps defined in CI/Jenkins. Test: run the pipeline and inspect artifacts.

**As a release maintainer,** I want GitHub Actions and Jenkins to produce consistent integrity metadata, signatures and dependency SBOMs, so that artifacts are traceable across supported CI providers.

**Acceptance criteria**
- Configured pipelines package artifact, manifest, checksum, signature metadata and CycloneDX SBOM as configured.
- Signing secrets are scoped to signing operations and temporary private-key files are removed.
- Pipeline commands fail immediately on tool errors and do not continue with incomplete outputs.
- Required CI configuration is documented by variable name only; no secret values are committed.
- Exact-head workflow execution and artifact inspection are recorded before acceptance.
- Nexus publishing remains disabled until separately approved.

### JARVIS-E08-US-053 — Control release promotion and recovery

**Current implementation status:** **PARTIAL — NEEDS DEVELOPMENT** — Quarantine/recovery records exist; promotion control is owner-manual; Nexus publishing disabled.

**As the owner,** I want artifact promotion and rollback to require explicit authorization and recorded evidence, so that unverified builds cannot reach production.

**Acceptance criteria**
- Development artifacts remain on authorized development branches and do not automatically promote to production.
- Invalid/incomplete packages can be rejected or quarantined with a recorded reason.
- Recovery guidance identifies the failed stage and safe re-run boundary.
- No production merge, deployment or Nexus publication occurs without explicit owner approval.
- Validation and operational evidence remain pending until the relevant exact-head and owner checks pass.


## JARVIS-E09 — Personal AI Gateway for Websites

### JARVIS-E09-US-054 — Serve my websites from my own AI

**Current implementation status:** **DONE — VERIFIED ON TARGET LAPTOP** — Gateway with per-site keys, limits and metadata-only audit (12 tests); live portfolio → gateway → llama3.2 answered in 14–24 s on the laptop.

**As the owner,** I want my websites to use JARVIS as their AI provider through an API key, so that the portfolio and future sites run on my personal AI instead of a paid third-party API.

**Acceptance criteria**
- An OpenAI-compatible `POST /v1/chat/completions` (stream and non-stream), `GET /v1/models` and `GET /v1/health` are served on a listener separate from the device/owner API.
- Each site has its own key, created only from the local CLI, stored only as a hash, shown once, and revocable without restart.
- Site keys grant text generation only: no planner, policy, memory, device or tool access; tool/function parameters are refused.
- Per-site rate limits, output-token caps and global concurrency limits protect the local model.
- Every request is audited with metadata only — never prompts or generated text.
- Model unavailability, timeouts and invalid keys return honest, non-leaking errors; sites fall back gracefully.
- The portfolio prefers JARVIS when configured, keeps keys server-side, and falls back to OpenAI or offline answers.

### JARVIS-E09-US-055 — Reach the gateway safely from deployed sites

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Documented in docs/SITE_AI_GATEWAY.md. Test: Cloudflare Tunnel to the gateway port and a chat from the deployed portfolio.

**As the owner,** I want deployed sites to reach JARVIS over HTTPS without exposing the rest of JARVIS, so that the gateway is usable from the internet but the device API stays private.

**Acceptance criteria**
- Only the gateway port is published through an HTTPS tunnel; the main JARVIS port is never tunnelled.
- A deployed site completes a chat request through the tunnel with its own key.
- Laptop sleep/offline produces a fast failure and the site's offline fallback.

---

## Definition of Done for every story

A story is done only when:
1. Implementation is present on the authorized working branch.
2. Applicable tests are authored and actually executed; results are recorded separately.
3. Exact-head CI passes where the workflow applies.
4. Required physical-device or external integration evidence is recorded.
5. Security/privacy restrictions remain satisfied.
6. POC.md, POC2.md and the relevant epic/story status are updated.
7. No claim exceeds the evidence.


## Owner-approved expanded product backlog — 2026-11-08

The stories below capture approved requirements from the 50-question exercise. They are **new backlog requirements**, not claims of implementation. Existing story IDs and acceptance criteria remain unchanged. These stories should be decomposed into implementation tasks under the existing epic structure before development begins.

### JARVIS-US-056 — Unified personal AI application

**Priority:** P0 — foundational product direction

**As the owner,** I want JARVIS to provide personal AI, chat, agents, memory and automation through one coherent application, so that it acts as the central interface for my personal AI ecosystem.

**Acceptance criteria**
- The owner can access chat, agent orchestration, memory, automation and connected capabilities from one application.
- Internal modules have explicit contracts and do not bypass shared identity, policy, audit or resource controls.
- The personal AI/chat experience is the first capability priority; developer/coding assistance is the next major capability priority.
- Long-running work exposes state, progress, checkpoints, cancellation and recovery.

### JARVIS-US-057 — Two-tier memory system

**Priority:** P0 — foundational dependency

**As the owner,** I want separate RAM-like Working Memory and durable Long-Term Memory, so that JARVIS can reason over current tasks while retaining useful approved knowledge over time.

**Acceptance criteria**
- Working Memory contains bounded, short-lived conversation, task and agent context with clear expiry and isolation.
- Long-Term Memory stores encrypted, categorized, searchable approved facts, preferences and project knowledge.
- A Memory Manager controls promotion, retrieval, summarization, correction, retention, deletion, export and backup.
- Memory access is permission-aware and context supplied to models is bounded and relevant.
- Deletion covers primary records and derived indexes/caches according to a documented retention boundary.
- Cross-device synchronization supports conflict detection and owner-reviewable resolution.

### JARVIS-US-058 — Consent-based adaptive learning

**Priority:** P1

**As the owner,** I want JARVIS to adapt using approved user feedback, preferences, chats and task outcomes, so that its assistance becomes more relevant over time without compromising privacy.

**Acceptance criteria**
- Learning inputs and resulting memory/behavior changes are inspectable and attributable to a source.
- The owner can correct, reject, disable or delete learned preferences and records.
- Private conversations are not silently used to train or fine-tune models.
- No private data is sent to a cloud provider without task-specific authorization.
- Any future model-training feature requires separate opt-in, data export/deletion rules and a clear cost/resource estimate.

### JARVIS-US-059 — Adaptive local and cloud provider routing

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING (2026-11-08)** — `src/ai/providerRouter.ts` + `providerClient.ts`: local Ollama default; OpenAI-compatible and Anthropic adapters only when configured via env; private data (memory/history) routes local-only; cloud requires per-task authorization or `JARVIS_CLOUD_ALLOWED_TASKS`; failures put a provider on a 60 s cooldown with reasons recorded; conversation, agents and site gateway use the router; owner status at `GET /api/ai/providers` (no URLs/keys). To test: run `test/provider_router.test.ts`; live local answer; stop Ollama and confirm honest fallback; configure a cloud key and confirm it is used only when authorized and never with memory.

**Priority:** P1

**As the owner,** I want JARVIS to select among configured local and cloud AI providers according to task, privacy, cost and availability, so that each request uses an appropriate provider.

**Acceptance criteria**
- Local inference is the default for private/offline/routine work.
- Cloud providers are disabled until explicitly configured and authorized by the owner.
- Routing decisions respect a zero-ongoing-cost baseline and never silently incur charges.
- Provider credentials are loaded from owner-managed secret configuration and never committed or logged.
- Provider failure, timeout, unavailable models and fallback choices are reported honestly.

### JARVIS-US-060 — Unified device connectivity and offline synchronization

**Priority:** P1

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Laptop-hub push/pull, offline queue (per-device sequence, ≤7-day TTL, revalidation, idempotent replays), offline commands held for explicit owner run, capability negotiation and signed peer-to-peer envelopes (LAN transport is future work), revoked-device discard. Test: unit tests, HTTP integration, Android build + two-phone offline/reconnect drill, P2P envelope exchange (docs/DEVICE_SYNC.md).

**As the owner,** I want the laptop to act as the primary hub while devices can optionally communicate peer-to-peer and synchronize offline changes, so that JARVIS remains useful across my laptop and Android phones.

**Acceptance criteria**
- Laptop-hub, peer-to-peer and offline-sync modes are supported through explicit device capabilities.
- Each device has an independent identity and scoped permissions.
- Offline changes are queued with bounded TTL and validated before application.
- Conflicts are detected and resolved deterministically or presented for owner review.
- Revoked devices and stale queued state-changing requests cannot regain authority on reconnect.

### JARVIS-US-061 — Adaptive resource and workload management

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING (2026-11-08)** — `src/resources/resourceManager.ts`: CPU/RAM/battery sampling (PowerShell CIM, 4 s timeout, 60 s cache), auto idle/normal/intensive selection or owner pin; profile drives site-gateway concurrency, advisory-agent budget and deferral of recurring scheduled jobs; heavy-work registry with stop; signed owner routes `GET /api/resources`, `POST /api/resources/profile`, `POST /api/resources/stop`; HUD “Resources & AI” panel. To test: run `test/resource_manager.test.ts`; on battery <30% confirm IDLE and deferred recurring jobs; pin INTENSIVE and confirm higher gateway concurrency; stop a running site request from the HUD.

**Priority:** P1

**As the owner,** I want JARVIS to adapt workload intensity to available CPU, RAM, battery and foreground activity, so that the application remains practical on my existing laptop.

**Acceptance criteria**
- Idle, normal and intensive workload profiles are available and can be selected automatically or manually.
- Heavy inference, indexing and background jobs are scheduled or reduced when resources are constrained.
- The owner can see active workload/resource impact and stop expensive work.
- No new hardware or paid infrastructure is assumed as a requirement.

### JARVIS-US-062 — Permissioned plugin and workflow ecosystem

**Priority:** P2

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Data-only plugin manifests (validate/install/grant/enable/disable/revoke/uninstall, over-scoped permissions refused), versioned append-only workflow templates (built-in, owner-created, AI-drafted drafts requiring approval, plugin-contributed), dependency validation, scheduling via the existing scheduler, and run-time expansion into the normal task lifecycle (per-step policy/approval, checkpoints, cancellation, recovery). Visual workflow composition is not built (planner phrases only). To test: manifest validation and fail-closed cases; grant/revoke effects on plugin workflows; `run workflow morning-brief` expansion and per-step approvals; cancel mid-workflow; AI draft cannot run before `approve workflow draft`; restart persistence of plugins/workflows. See `docs/PLUGINS_AND_WORKFLOWS.md`.

**As the owner,** I want versioned plugins and reusable visual/AI-generated workflows, so that JARVIS can grow without weakening its security model.

**Acceptance criteria**
- Each plugin declares identity, version, capabilities, requested permissions and compatibility.
- Installation and permission grants require owner approval; permissions can be revoked.
- Workflows support templates, schedules, dependencies, checkpoints, cancellation and recovery.
- AI-generated plans remain advisory until validated by the planner and policy gateway.
- Unknown or over-scoped plugin capabilities fail closed.

### JARVIS-US-063 — Developer and coding assistant

**Priority:** P1, after personal AI/chat foundation

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — `src/developer/*` adds explicit repo connections with scopes (read / suggest / git-write / ci), secret-redacted repo intelligence (tree, bounded read, search, git status/log/diff, CI status via `gh`), model-generated explanations and draft unified-diff suggestions kept separate from commits, and approval-gated apply / branch / commit / push / PR-draft operations that refuse main, master and dev and never force-push. Wired through planner, policy gateway (DEVICE_MANAGE; writes need approval), capability catalogue and service. To test: run `test/developer_assistant.test.ts`; then on a scratch clone connect a repo, read/search, request an explanation and a suggestion with the local model, apply it on a feature branch, commit, attempt commit/push on dev (must be refused), push a feature branch and draft a PR. See `docs/DEVELOPER_ASSISTANT.md`.

**As the owner,** I want JARVIS to assist with repository understanding, code explanation/generation, debugging, documentation, project planning and authorized Git/CI workflows, so that it can act as my developer assistant.

**Acceptance criteria**
- Repository and tool access is explicitly connected and scoped.
- Code suggestions and edits are distinguishable from committed changes.
- Branch, commit, PR, merge, push, CI and deployment actions require the appropriate explicit authorization.
- Existing branch policy and production protections remain enforced.
- Secrets are never included in prompts, generated artifacts or logs.

## JARVIS-E10 — Owner Control Panels & Visual Workflow Composition (added 2026-11-09)

### JARVIS-US-064 — Unified owner control panels

**Current implementation status:** IMPLEMENTED IN SOURCE — NEEDS TESTING. Panels are present for Plugins, Workflows, Composer, Developer, Memory and Gateway Sites. Signed requests and approval-aware task reporting are wired in the HUD panel client.

**As the owner,** I want one authenticated HUD workspace for managing JARVIS capabilities, so that I can inspect and control them without bypassing the governance model.

**Acceptance criteria**
- Every panel requires an authenticated device session and fails closed when unavailable.
- All mutations use signed requests and server-side authorization.
- Approval-required operations display the normal approval flow and never claim execution before approval.
- Untrusted values are rendered as text, bounded and validated server-side.
- Empty, loading, offline, forbidden and error states are distinguishable and accessible.

### JARVIS-US-065 — Visual workflow composition

**Current implementation status:** IMPLEMENTED IN SOURCE — NEEDS TESTING. The composer uses the backend operation catalogue, exposes allowed parameters/dependencies, requests server validation and saves through the workflow composition route.

**As the owner,** I want to compose multi-step workflows visually, so that I can review dependencies and risk before saving or running them.

**Acceptance criteria**
- Operation choices and allowed parameters come from the authoritative server catalogue.
- Missing, duplicate, cyclic, self-referential and invalid dependencies are rejected by server validation.
- Risk and approval requirements are derived server-side, not trusted from client badges.
- Saving creates a versioned workflow and cannot execute it implicitly.
- Runtime execution rechecks policy and obtains required approvals per step.

### JARVIS-US-066 — Owner-managed developer suggestions

**Current implementation status:** IMPLEMENTED IN SOURCE — NEEDS TESTING. HUD panel lists connected repositories and draft suggestions; applying a suggestion routes through approval-aware task handling.

**As the owner,** I want to inspect proposed repository changes as drafts, so that no model-generated code is silently applied or committed.

**Acceptance criteria**
- Repository access is scope-limited and read-only by default.
- Suggestions show target path, explanation and diff before application.
- Applying a suggestion requires explicit approval and validates the target repository/branch.
- No automatic commit, push, PR, merge or operation against `main`/`dev` occurs.

### JARVIS-US-067 — Owner memory and gateway administration

**Current implementation status:** IMPLEMENTED IN SOURCE — NEEDS TESTING. Memory panel exposes long-term memory management and learning candidates; gateway panel exposes site metadata, policy-scoped limits and one-time pending key reveals.

**As the owner,** I want to manage memory and website gateway clients from the protected HUD, so that I retain control over personal data and connected sites.

**Acceptance criteria**
- Memory reads/updates/deletes/imports remain encrypted, authorized, audited and policy-gated.
- Learning candidates require owner review before becoming long-term memory.
- Gateway site keys are stored hashed, revealed only through a short-lived one-time flow and never logged.
- Site rate/output limits and allowed profile scopes are enforced server-side.
- Revocation takes effect for subsequent requests and is auditable.



## Owner-directed status reconciliation — 2026-11-09 12:22 IST

**Inspected `new` branch head:** `92d1057f33877a3fa4ebca65c7c6b894bd23480b`. Development and testing are ACTIVE. The latest source includes E10 owner panels/composer and LAN peer management/discovery/pairing/revocation. These related stories remain **IMPLEMENTED — NEEDS TESTING**. Voice lifecycle and dispatch paths are present, but the target-MSI voice → app launch → independently verified outcome remains a development/acceptance gap.

### Current status rules
- Do not carry forward historical local test/build results as proof for this branch head.
- Automated test/build/lint/audit/browser/CI execution is authorized on `new`; physical Windows/Android acceptance still requires owner-device evidence.
- Continue implementation on `new`; authored regression tests are allowed but must remain unexecuted.
- Preserve story acceptance criteria and keep stories OPEN until exact-head evidence exists.

### Constraints applying to every story
Default-deny policy; device/task/parameter-scoped approval; audit integrity; fail-closed persistence; local-first/zero ongoing cost; explicit cloud/speech opt-in; no admin elevation, arbitrary shell, credential/payment or financial automation; no automatic replay of uncertain actions; no secrets in Git/logs. Windows 11 laptop is primary; both Android phones require independent enrollment; iOS is future scope. No PR, merge, push to `dev`/`main`, deployment, public tunnel, secret changes or Nexus publication without explicit authorization. Nexus stays disabled.

### Development sequence
1. E02/E03 voice dispatch and verified Windows outcomes.
2. E10 owner-panel validation, API/UI alignment and accessible failure states.
3. E06/E05 memory lifecycle, cross-device sync/conflict handling and Android software completion.
4. E04 partial-side-effect recovery.
5. E07 provider/integration completion within existing scope.


## Voice story implementation note — 2026-11-09

The voice-to-app development path received a narrow planner-side recovery for recognizer clipping: `pen <application>` is normalized to `open <application>` before heuristic planning. Regression cases were added for “pen Notepad” and “pen up Notepad”. **IMPLEMENTED — NEEDS TESTING**; tests require exact-head CI execution and evidence. This does not close the voice story: target-MSI wake, capture, consent, policy, approval, app launch and independently verified outcome remain acceptance requirements.

## Post-Claude story reconciliation — 2026-11-09 13:30 IST

- **JARVIS-US-016:** Windows Start-menu discovery now has a conservative AppID/process identity path and unique-window matching. This improves launch evidence but does not establish universal application outcome verification or complete target-MSI voice acceptance; keep the story PARTIAL.
- **JARVIS-US-027:** Android owner UI now includes sync conflict resolution and held-command review. The feature is implemented in source; Android build, install, two-phone conflict drills and exact-head checks remain pending.
- `test/windows-appid-identity.test.ts` was added and remains unexecuted. Testing is paused; no verification status was promoted.


## Test evidence and story-status reconciliation — 2026-11-09 (test branch)

**Current branch head:** `bbb1c1ffd1120087704daf7492d2e9f54ec3c2bb`.

Antigravity's Windows 11 report records **345/345 local test cases passed (100%)**. It lists 59 suites although its summary line says 58. The local report does not identify the tested commit SHA; therefore this is local execution evidence only and does not close stories by itself.

The exact-head [JARVIS CI run #42591404042](https://github.com/ASAA1229/JARVIS/actions/runs/42591404042) passed the Node automated suite, browser smoke, TypeScript check/build, SBOM generation and dependency audit, but the overall workflow failed:
- Python release tooling: one Windows temporary-path assertion fails on the runner's 8.3 path alias.
- Android companion: Kotlin recursive type-checking error at `OwnerPanels.kt:112:34`.
- Release package/provenance and APK artifact uploads were skipped.

### Story status policy after this run

- Automated stories covered by the local report may be labelled **LOCAL TEST REPORT PASS — EXACT SHA NOT RECORDED**; do not upgrade them to CI-VERIFIED or ACCEPTED.
- Release/customer-bundle stories remain **IMPLEMENTED — NEEDS CI FIX** until the Windows Python test passes and the release manifest/package/provenance artifacts are produced.
- Android companion and cross-device stories remain **IMPLEMENTED — NEEDS DEVICE TESTING** until Kotlin compilation succeeds and both physical phones pass enrollment, approval, revocation and sync/conflict drills.
- Voice, Windows desktop-control and outcome-verification stories remain **OPEN / PARTIAL** until the target MSI completes the full wake-to-command-to-independent-result path.
- Recovery, memory lifecycle and owner-panel stories remain OPEN until their corresponding exact-head and manual acceptance criteria are evidenced.

**Percentages:** local test pass rate = **100% (345/345)**. Overall story/development completion is not reduced to a single percentage because unexecuted device, CI, security and owner-acceptance gates are not represented by the local test count. No story is closed solely from the Antigravity summary.


---

# Exact-objective gap closure backlog — 2026-11-12

**Purpose:** This addendum converts the remaining gaps between the current repository and the complete JARVIS objective into explicit, testable stories. It supplements US-001–US-067; it does not replace existing stories or mark any feature complete.

**Objective:** JARVIS is to become a secure, local-first personal AI operating system across the Windows 11 laptop and two Android phones. It should understand natural voice/text/multimodal requests, plan and execute authorized tasks across supported applications and devices, maintain owner-controlled memory, coordinate specialized AI capabilities, monitor long-running work, and report independently verified outcomes. It must remain extensible rather than claim unrestricted control of every application.

## Consolidated gap register and first-work priority

| Priority | Gap | Current evidence / limitation | First closure target |
|---|---|---|---|
| P0 | Full voice-to-action acceptance | Local wake, consent, capture and signed dispatch exist in source; the complete real-microphone → policy/approval → Windows action → independent outcome path is not accepted on the MSI | Close US-006–011 and US-012–016 as one end-to-end vertical slice |
| P0 | Independent outcome verification | Launch identity has improved; app-specific proof that an action was accepted, saved or completed remains partial | Build a reusable verification contract and supported-app evidence matrix |
| P0 | Exact-head quality/security evidence | Historical/local test reports and older CI runs do not prove the latest branch head; owner/device checks are separate | Run exact-head checks and record commit-specific evidence; retain device acceptance gates |
| P1 | Universal capability discovery | The product goal requires discovery of installed apps, official APIs and accessible UI capabilities; current adapters are bounded and coverage is incomplete | Discover → assess capability → select adapter → authorize → verify; report unsupported actions |
| P1 | End-to-end productivity/communications integrations | Email, WhatsApp, SMS, supported calls/VoIP, Teams, Microsoft 365 and calendar workflows are not complete end-to-end integrations | Implement only supported/official integrations with per-connector permissions and confirmation |
| P1 | Full Android companion operation | Native app foundation and narrow inventory/sync paths exist; physical two-phone acceptance and broader permitted companion actions remain open | Compile/install, independent enrollment, approval/revocation, notifications and secure reconnect |
| P1 | Cross-device reachability and continuity | Sync/queue foundations exist; trusted HTTPS/LAN connectivity, offline recovery and both-phone acceptance remain incomplete | Prove laptop/phone connectivity, stale-command rejection and safe reconnect |
| P1 | Multimodal interaction | Chat/voice foundation exists; a complete privacy-governed image/document/screen-context workflow is not established in the current acceptance baseline | Add consented image/document input, extraction, context boundaries and actionable responses |
| P1 | Proactive monitoring and background supervision | Scheduling/notifications/resources have foundations; dependable long-running task supervision, event monitoring and verified alerting remain incomplete | Durable monitor lifecycle, bounded resource use, cancellation, alert delivery and recovery |
| P2 | Operational lifecycle and resilience | Local host/HUD exists; full startup/restart/update/backup/restore/health and recovery acceptance is not consolidated | Owner-controlled lifecycle, health diagnostics, safe update/rollback and backup/restore |
| P2 | Unified acceptance and capability transparency | Implemented/partial/planned/restricted catalogue exists, but end-to-end coverage and owner-facing evidence need consolidation | Publish per-device/per-app capability matrix with tested limitations and evidence |

## JARVIS-US-068 — Universal application and capability discovery

**Priority:** P1 — after P0 voice/Windows vertical slice.

**Current status:** PARTIAL — capability registry and bounded Windows/Android discovery foundations exist; universal discovery and adapter coverage are not complete.

**As the owner,** I want JARVIS to discover installed applications and their available official APIs, automation interfaces and accessible UI capabilities, so that it can choose the safest supported way to complete a task instead of relying on hard-coded app assumptions.

**Acceptance criteria**
- Discover installed/built-in applications on the Windows laptop and each enrolled Android phone using platform-permitted mechanisms.
- Inspect registered official APIs, deep links, command interfaces and accessibility/UI capabilities without bypassing platform security.
- Maintain a capability record per app, operation, device, permission, adapter and verification method.
- Select the least-privileged supported adapter; do not treat model suggestions or app names as authority.
- Unknown, ambiguous, inaccessible or unsupported capabilities fail closed and are explained to the owner.
- Discovery is refreshable, bounded, auditable and does not silently install apps or enable permissions.
- Adapter execution still passes the central policy gateway, scoped approval and independent result verification.

## JARVIS-US-069 — End-to-end productivity and communications integrations

**Priority:** P1 — staged by connector after the core execution and verification contract is stable.

**Current status:** PARTIAL / NOT ACCEPTED — schedule, notification and selected gateway foundations exist; the broader communications and productivity workflows are not established as end-to-end accepted integrations.

**As the owner,** I want JARVIS to work with the productivity and communication services I authorize, so that I can manage information and routine work through one assistant.

**Acceptance criteria**
- Maintain an explicit connector register for email, WhatsApp, SMS, supported cellular/VoIP calls, Microsoft Teams, Microsoft 365, calendars and other approved services.
- Prefer official APIs and supported platform integrations; use UI automation only where permitted and demonstrably reliable.
- Each connector declares scopes, data accessed, supported operations, local/cloud processing and revocation behavior.
- Reading, drafting, sending, editing, deleting, scheduling and calling are distinct capabilities with risk-appropriate approval.
- Never send a message, email, invitation or place a call merely because a model proposed it; show recipient/content/action for confirmation where required.
- Handle unavailable APIs, expired tokens, rate limits, duplicate requests and uncertain outcomes without claiming success or blindly retrying.
- Payment/financial operations and credential entry remain excluded.
- Each connector has automated contract tests and a documented owner acceptance scenario before being labelled supported.

## JARVIS-US-070 — Privacy-governed multimodal understanding

**Priority:** P1.

**Current status:** GAP — a complete accepted multimodal input workflow is not evidenced by the current story baseline.

**As the owner,** I want to provide images, screenshots, documents and other supported media as context for a request, so that JARVIS can understand more than plain text and voice.

**Acceptance criteria**
- Support explicitly declared media types and bounded file sizes; reject unsupported or malformed content safely.
- Explain when processing is local or when data would be sent to a configured cloud provider; obtain required consent before transmission.
- Extract and summarize content with source references/page or region context where available.
- Treat media content, OCR text, embedded instructions and metadata as untrusted input, never as system instructions or execution authority.
- Ask for clarification when the media is ambiguous or insufficient.
- Any action derived from media follows the same planner, policy, approval, execution and verification path as typed/voice requests.
- Provide cancellation, deletion/retention controls and clear processing/error states.

## JARVIS-US-071 — Proactive monitoring and background task supervision

**Priority:** P1.

**Current status:** PARTIAL — scheduler, notifications and resource management foundations exist; complete durable monitoring and alert lifecycle acceptance is outstanding.

**As the owner,** I want JARVIS to monitor authorized tasks, device health and workflow progress in the background, so that it can alert me to important changes and keep long-running work under control.

**Acceptance criteria**
- Owner can explicitly enable, configure, pause and revoke each monitor or scheduled job.
- Monitor definitions identify data sources, polling/event frequency, resource limits, retention and alert destinations.
- Background work is durable across restart where required, bounded by CPU/RAM/network budgets and visible in the HUD.
- Alerts distinguish observed facts, inferred risks and recommended actions; no alert implies an action was completed unless independently verified.
- Long-running tasks expose progress, cancellation, timeout, failure and recovery state.
- Quiet/disabled/offline states do not silently suppress critical security or task-integrity events.
- No remote monitoring or external data collection occurs without explicit authorization.

## JARVIS-US-072 — Native Android companion capability completion

**Priority:** P1.

**Current status:** PARTIAL — native enrollment, signed text requests, encrypted local sync queue, narrow app inventory, and owner-opt-in WorkManager approval polling are implemented in source; Android build and two-phone physical acceptance remain open.

**As the owner,** I want each Android phone to act as a secure, independently managed JARVIS companion, so that I can receive approvals, notifications and authorized task results on either device.

**Acceptance criteria**
- Build, install and upgrade the native app on both target phones with documented Android versions.
- Each phone has its own Keystore-backed identity, session, permissions and revocation state.
- Support privacy-preserving approval notifications and deep links without exposing secrets or granting broader authority. Current implementation is periodic WorkManager polling (minimum 15-minute interval), explicitly opt-in after enrollment and OS permission; real-time push is not claimed.
- Any phone-side app launch or supported device action is explicit, permission-scoped and visible to the phone owner.
- Accessibility, notification, microphone, camera and background permissions are requested only when a feature needs them and are individually revocable.
- Revoke one phone and prove the other remains usable; revoked devices cannot reconnect, replay or complete stale commands.
- Offline, battery restriction, process death, OS restart and network-change scenarios fail safely and recover without duplicate side effects.

## JARVIS-US-073 — Secure cross-device reachability and continuity

**Priority:** P1.

**Current status:** PARTIAL — signed sync/queue and secure-connectivity design exist; end-to-end network and two-phone acceptance remain outstanding.

**As the owner,** I want my laptop and both phones to communicate securely over an explicitly configured private connection, so that JARVIS can coordinate work without exposing the laptop service publicly.

**Acceptance criteria**
- Support a documented private connectivity mode such as trusted LAN/VPN with HTTPS and certificate validation.
- The main JARVIS server remains private; no public tunnel or internet exposure is enabled by default.
- Authenticate every device independently and authorize every operation at execution time.
- Detect laptop sleep/offline/restart and report reachability honestly.
- Queue only explicitly permitted work with bounded TTL; revalidate permissions, task state and approvals on reconnect.
- Reject stale, revoked, duplicate or uncertain state-changing commands; never auto-replay non-idempotent work.
- Record connectivity, synchronization and recovery outcomes without logging credentials or private payloads.

## JARVIS-US-074 — Verified outcome contract and application acceptance matrix

**Priority:** P0 — foundational to every execution epic.

**Current status:** PARTIAL — task result states and conservative Windows launch verification exist; app-specific outcome evidence is incomplete.

**As the owner,** I want JARVIS to prove what happened after each action using independent evidence, so that it never confuses an acknowledgement, an attempted input or an uncertain result with success.

**Acceptance criteria**
- Define a shared result contract covering received, planned, awaiting approval, executing, verified success, partial, failed, denied, cancelled and uncertain/recovery-required outcomes.
- Each adapter declares its independent verification method and evidence strength for each supported operation.
- Verify the real target process/window/device and observable postcondition, not merely a matching title or successful input call.
- For save/send/submit operations, use destination/application confirmation or read-back evidence where available; otherwise return partial/uncertain.
- Preserve redacted evidence, timestamps, device identity and task correlation in the audit trail.
- Stop dependent workflow steps after failed or uncertain outcomes.
- Maintain a tested matrix of app × operation × device × verification method × limitations.
- Automated tests, CI, physical-device acceptance and owner acceptance are separately recorded against the exact commit.

## JARVIS-US-075 — Owner-controlled JARVIS runtime lifecycle and resilience

**Priority:** P2.

**Current status:** GAP — the local server/HUD and recovery foundations exist, but a consolidated owner-controlled runtime lifecycle acceptance story is missing.

**As the owner,** I want JARVIS to start, monitor, recover and update its local services predictably, so that it behaves like a dependable personal operating environment rather than a manually started demo.

**Acceptance criteria**
- Provide an owner-controlled startup, shutdown, restart and health-status experience for supported local services.
- Detect crashes, dependency/model unavailability, storage exhaustion and unhealthy components; report the affected capability without falsely reporting the whole system as available.
- Restart only safe, idempotent services automatically; never replay uncertain user actions or workflows.
- Provide versioned configuration and migration checks with rollback/recovery guidance.
- Support encrypted backup and tested restore for owner-approved state, with explicit retention and key-handling rules.
- Keep diagnostics useful but redact tokens, keys, private prompts, transcripts and sensitive memory.
- Preserve local-first and zero-recurring-cost defaults; no background installation or paid service activation.

## First implementation order

1. **P0 — Close the voice-to-Windows vertical slice:** reconcile US-006–US-016, add deterministic regression coverage for local wake → same-utterance command → consent → signed request → policy/approval → Windows execution → independent result. Then obtain real MSI microphone and application acceptance.
2. **P0 — Close the shared outcome contract:** implement/complete US-074 and use its evidence model for every adapter and workflow. Do not claim app success without its declared postcondition evidence.
3. **P0 — Exact-head validation and security gate:** run the complete automated suite and CI against the candidate SHA; separately track MSI and Android owner acceptance. Fix failures before widening execution scope.
4. **P1 — Universal capability discovery:** implement US-068 and the app/operation capability matrix, starting with Windows apps already supported and Android's permitted launcher capabilities.
5. **P1 — Complete Android and private connectivity:** US-072 and US-073, including both phones, secure transport, approval delivery, revocation and offline recovery.
6. **P1 — Complete productivity connectors:** US-069 one connector at a time, using official APIs and explicit scopes/confirmation.
7. **P1 — Add multimodal and proactive capabilities:** US-070 and US-071 after privacy, resource and execution contracts are stable.
8. **P2 — Runtime lifecycle and release hardening:** US-075 plus the existing E08/G01 acceptance gates.

**Backlog rule:** These stories are OPEN. “Implemented in source” is not acceptance. Each must record exact branch/SHA, changed files, tests authored, tests executed, CI URL, device/environment evidence, remaining limitations and owner acceptance. Existing restrictions remain in force: default-deny policy, least privilege, scoped approvals, no payment/financial actions, credential entry, admin elevation, unrestricted shell, silent public exposure, paid activation or automatic replay of uncertain side effects.


## Android cross-device implementation note — 2026-11-12

For **JARVIS-US-072 (Native Android companion capability completion)** and **JARVIS-US-073 (Secure cross-device reachability and continuity)**, the Android offline sync queue is now encrypted at rest with a dedicated Android Keystore AES-GCM key. Legacy plaintext queues are migrated on first read; integrity/version failures fail closed; revocation wipes the queue and its local data key. This is a source-level security increment only. Android build, automated migration/tamper/revocation tests, trusted TLS connectivity and two-physical-phone acceptance remain outstanding. Both stories remain **OPEN / PARTIAL**.


### Android approval notification build increment — 2026-11-12

The native companion now exposes explicit **Enable approval notifications** and **Disable approval notifications** controls. Notification polling defaults off, can be enabled only after enrollment, requests Android 13+ notification permission at the point of use, and schedules/cancels the existing WorkManager poller according to the owner's choice. Notification content remains generic and does not include directive text. Polling is periodic (Android minimum interval, about 15 minutes), not real-time push.

Files: `MainActivity.kt`, `CompanionSession.kt`, `ApprovalPollWorker.kt` (existing worker), and `src/capabilities/registry.ts`; documentation updated in `android-app/README.md` and `docs/SECURE_PHONE_CONNECTIVITY.md`.

**Build status:** IMPLEMENTED IN SOURCE — NOT COMPILED. No tests, Gradle build, APK installation, ADB operation or phone acceptance was run in this build-first phase. US-072 remains OPEN / PARTIAL.


### Windows app discovery build increment — 2026-11-12

The existing `app:inventory` request now performs bounded Windows Start-menu discovery automatically when explicitly requested, rather than requiring the undocumented/local `JARVIS_ENABLE_START_MENU_INVENTORY=1` toggle. The query remains read-only and capped at 80 entries; financial/payment app names are excluded, and discovered entries do not imply UI automation or verified launch support. Planner feedback now accurately describes this behavior.

**Build status:** IMPLEMENTED IN SOURCE — NOT COMPILED OR TESTED. US-068 remains OPEN / PARTIAL; exact-head compilation and the later per-platform validation phase remain pending.

### Voice-driven app interaction and browser search increment — 2026-11-12

The planner now supports a combined request such as **“Open Notepad and write ------”** for any uniquely discovered installed Windows app, using the existing launch-and-type operation. Payment/financial app names remain blocked. The operation verifies the launched window identity before focusing and entering text.

A new `desktop:browser_search` composite operation supports commands such as **“Search for weather tomorrow on Chrome”**. It is bound to the selected browser process, requires task-scoped approval, focuses the verified browser window, targets the address bar, enters the exact query and submits it. It deliberately returns **PARTIAL** because the current adapter does not yet independently verify page load or the resulting search page.

The follow-up phrase **“write …”** is now bound to the most recently verified JARVIS-opened app for that device for up to 15 minutes. The target process is included in the approved operation and re-checked against the foreground window before text entry; switching to another app causes a safe refusal. This short-lived session context is in-memory only and is cleared on JARVIS restart. App-specific media playback (including selecting and verifying the requested song) remains a separate open capability; opening a media app or submitting a search is not playback proof.

**Build status:** source implemented on `new`; authored planner regressions added but not executed. No build, typecheck, lint, tests, browser launch or desktop interaction was performed.


### Media playback safety boundary — 2026-11-12

The planner now explicitly recognizes “play [track] on [app]” requests and safely declines execution until an app-specific adapter exists. It will not use a global play/pause shortcut, because that could control a different player and cannot prove which track started. The capability catalogue records app-scoped media playback as **PLANNED**. Remaining implementation: select the first owner-approved player, implement its official/deep-link or supported UI Automation adapter, bind the exact track and app into approval, and independently verify the active track/playback state. No media playback is claimed complete.


### Discovered-app follow-up target binding — 2026-11-12

The Windows Start-menu launcher now returns a normalized top-level `windowPid`, `windowProcess` and `windowTitle` only when a discovered app's window matches a trusted process identity. The already-running discovered-app path returns the same target binding after unique-window selection and verified focus. This allows the existing approved `desktop:launch_and_type` composite and short-lived per-device app session to continue into the correct discovered app instead of losing its verified target metadata. Unknown apps without a trusted process identity remain PARTIAL and cannot receive follow-up text input. This is not universal UI Automation support; each app still needs capability-specific operation and outcome coverage.
