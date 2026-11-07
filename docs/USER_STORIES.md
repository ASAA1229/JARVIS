# JARVIS — User Stories and Acceptance Criteria

**Repository:** `ASAA1229/JARVIS`  
**Branch:** `new`  
**Updated:** 2026-11-07  
**Rule:** Every story remains OPEN until its acceptance criteria are evidenced on the exact branch revision.

Epic mapping: [EPICS.md](EPICS.md)  
Project overview and implemented baseline: [../POC.md](../POC.md)  
Detailed remaining-work register: [../POC2.md](../POC2.md)

## Evidence boundary — testing resumed 2026-11-07

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

**Current implementation status:** **IMPLEMENTED — NEEDS TESTING** — Owner-token recovery on the JARVIS host (`npm run owner-recovery -- reset-authenticator | revoke-device <id> | revoke-all`, `POST /api/owner/recovery`): loopback-only, rate-limited, explicit confirmation, audited without secrets; revoke-all reopens bootstrap enrollment and old keys cannot re-enroll. Tests authored in `test/owner_recovery.test.ts`, not yet run (testing paused).

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

**Current implementation status:** **PARTIAL — NEEDS DEVELOPMENT** — Readback verification exists; app-specific proof of saved/submitted outcomes is not general.

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

**Current implementation status:** **NOT STARTED** — Cross-device memory sync and conflict handling not implemented.

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
- Validation and operational evidence remain pending while testing is paused.


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

**As the owner,** I want versioned plugins and reusable visual/AI-generated workflows, so that JARVIS can grow without weakening its security model.

**Acceptance criteria**
- Each plugin declares identity, version, capabilities, requested permissions and compatibility.
- Installation and permission grants require owner approval; permissions can be revoked.
- Workflows support templates, schedules, dependencies, checkpoints, cancellation and recovery.
- AI-generated plans remain advisory until validated by the planner and policy gateway.
- Unknown or over-scoped plugin capabilities fail closed.

### JARVIS-US-063 — Developer and coding assistant

**Priority:** P1, after personal AI/chat foundation

**As the owner,** I want JARVIS to assist with repository understanding, code explanation/generation, debugging, documentation, project planning and authorized Git/CI workflows, so that it can act as my developer assistant.

**Acceptance criteria**
- Repository and tool access is explicitly connected and scoped.
- Code suggestions and edits are distinguishable from committed changes.
- Branch, commit, PR, merge, push, CI and deployment actions require the appropriate explicit authorization.
- Existing branch policy and production protections remain enforced.
- Secrets are never included in prompts, generated artifacts or logs.