# JARVIS — User Stories and Acceptance Criteria

**Repository:** `ASAA1229/JARVIS`  
**Branch:** `new`  
**Updated:** 2026-11-07  
**Rule:** Every story remains OPEN until its acceptance criteria are evidenced on the exact branch revision.

Epic mapping: [EPICS.md](EPICS.md)  
Project overview and implemented baseline: [../POC.md](../POC.md)  
Detailed remaining-work register: [../POC2.md](../POC2.md)

## Owner pause and evidence boundary — 2026-11-07

Development is stopped and testing is paused. This register classifies source implementation only; no test/build/lint/CI/device result is implied. Recent source increments include AI context-budget selection, Whisper process cancellation, transcription cancellation on disconnect, and immediate wake-triggered speech capture. The last item addresses the same-utterance capture-ordering race, but end-to-end voice recognition, policy dispatch, Windows app launch and verified outcome remain untested. All affected stories remain OPEN until evidence is recorded.

## Current story status — 2026-11-07

**Important:** This is an implementation inventory, not an acceptance report. All stories remain open until their acceptance criteria are evidenced on the exact branch revision. No tests/build/lint/CI/device checks were run for this documentation update.

| Epic / story range | Current implementation summary |
|---|---|
| E01 / US-001–005 | Identity, policy, approvals and audit foundations are implemented; recovery/device lifecycle has partial gaps. All require current-head verification. |
| E02 / US-006–011 | Wake phrase, consent, transcript review and speech adapters exist; local runtime/device acceptance is pending and voice-to-app dispatch remains incomplete. |
| E03 / US-012–016 | App launch and guarded Windows UI Automation helpers exist; launch reliability and independent application outcome proof remain incomplete. |
| E04 / US-017–020, US-034–040 | Journal, reconciliation, scheduling, stop/cancel, task history and transition safeguards are implemented in part/source; crash/restart and real workflow acceptance remain open. |
| E05 / US-021–024 | Android app/API/queue foundations exist; both physical phones are not yet independently enrolled and accepted. |
| E06 / US-025–027 | Encrypted local memory and basic owner controls exist; cross-device consistency is not implemented and verified deletion/retention remains open. |
| E07 / US-028–031, US-041–048 | Conversational AI, prompt contracts, structured agent responses, routing, capability validation and bounded history are implemented in source; end-to-end AI and integration acceptance remains open. |
| Release / US-032–033 | Exact-head release evidence and resource/compatibility acceptance are not complete. |
| E08 / US-049–053 | Provenance, SHA-256/archive/customer verification, SBOM/signing and release disposition foundations are in source; exact-head CI/Jenkins and artifact acceptance are pending. |

### Story identifier clarification

Earlier versions reused `JARVIS-US-041` through `JARVIS-US-045` for both E07 AI-agent stories and E08 DevOps stories. To make references unambiguous, the E08 DevOps stories are identified in this refreshed register as `JARVIS-E08-US-049` through `JARVIS-E08-US-053`. The E07 story identifiers remain unchanged.

### Status definitions

- **IMPLEMENTED — NOT VERIFIED:** source exists; acceptance evidence is missing.
- **PARTIALLY IMPLEMENTED — NOT VERIFIED:** some required behavior exists, but the story still has material implementation gaps.
- **NOT IMPLEMENTED / NOT COMPLETE:** required capability is absent or materially incomplete.
- **NOT VERIFIED:** implementation may exist, but there is no current evidence to claim acceptance.
- No story is marked **VERIFIED** in this refresh.


## JARVIS-E01 — Security, Identity & Approval Foundation
## JARVIS-E01 — Security, Identity & Approval Foundation

### JARVIS-US-001 — Trusted device identity

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Device identity and signed-session foundations are present; exact-head security and device acceptance remain pending.

**As the owner,** I want every connected device to have its own cryptographic identity, so that one device cannot impersonate another.

**Acceptance criteria**
- Each device has a distinct key pair and device identifier.
- Requests are signed and validated against the enrolled public key.
- Invalid signatures, unknown devices, expired sessions and replayed nonces are rejected.
- Device enrollment requires owner-authorized proof of possession.
- No private key is returned through APIs, logs or audit records.

### JARVIS-US-002 — Policy-gated execution

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Default-deny policy and guarded execution boundaries are present; complete path coverage is not currently accepted.

**As the owner,** I want every state-changing action to pass one default-deny policy gateway, so that no adapter or endpoint can bypass authorization.

**Acceptance criteria**
- Every execution path checks device permission, operation allowlist and policy decision.
- Unknown operations and malformed parameters fail closed.
- Direct adapter access cannot execute a protected action.
- Financial/payment actions, credential entry, admin elevation and unrestricted shell remain blocked.

### JARVIS-US-003 — Scoped single-use approval

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Scoped approval and single-use handling are present; current-head security validation is pending.

**As the owner,** I want approvals bound to the exact task and action, so that approval cannot be reused for a different operation.

**Acceptance criteria**
- Approval is bound to task, device, operation, canonical parameters and expiry.
- Approval is consumed at most once.
- Duplicate, concurrent, stale, expired and revoked approvals are rejected.
- A task outside the pending-approval state cannot be approved or rejected through a stale record.

### JARVIS-US-004 — Tamper-evident audit and fail-closed persistence

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Audit integrity, redaction and fail-closed persistence foundations are present; current-head verification is pending.

**As the owner,** I want security-relevant actions recorded in a tamper-evident audit trail, so that failures and misuse can be investigated.

**Acceptance criteria**
- Audit entries are hash chained and integrity is verified.
- Sensitive values, credentials, tokens and signatures are redacted.
- Audit/security persistence failure blocks dependent execution.
- Tampering is detected and recovery behavior is documented.

### JARVIS-US-005 — Owner recovery and device revocation

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Revocation/recovery foundations exist; complete owner recovery and device lifecycle acceptance remains open.

**As the owner,** I want to recover account control and revoke a lost device, so that device loss does not compromise JARVIS.

**Acceptance criteria**
- Owner recovery covers authenticator/TOTP loss and device-management loss.
- Revocation takes effect for new requests immediately.
- Revoked devices cannot replay old requests or regain access without fresh enrollment.
- Recovery events are audited without exposing secrets.

## JARVIS-E02 — Voice Interaction & Cinematic HUD

### JARVIS-US-006 — Local wake phrase

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Local wake-word integration/setup exists; runtime assets and actual MSI wake detection have not been accepted.

**As the owner,** I want to say “Hey Jarvis” and wake JARVIS locally, so that routine wake detection does not require continuous cloud audio upload.

**Acceptance criteria**
- Wake detection uses the configured local engine/model.
- Microphone listening is visibly indicated and can be muted/stopped immediately.
- Wake accuracy, false triggers, startup, sleep/resume and resource use are measured on the MSI.
- Wake detection is disabled until the owner explicitly enables it.
- No continuous cloud audio upload is used for wake detection.

### JARVIS-US-007 — Clear wake acknowledgement

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — The requested acknowledgement is wired into supported wake paths; audible timing and device behavior remain unverified.

**As the owner,** I want JARVIS to respond with “Hi sir, I am ready to work.” after a valid wake, so that I know it is ready.

**Acceptance criteria**
- The acknowledgement is played only after a confirmed wake event.
- Playback state and failures are visible.
- Cancellation/mute stops output promptly.
- No acknowledgement is reported as played unless playback actually starts.

### JARVIS-US-008 — Consent-controlled speech capture

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Explicit speech consent and cancellation/revocation safeguards are present; browser/device acceptance is pending.

**As the owner,** I want separate, explicit consent for any browser/vendor speech recognition, so that I understand when audio may leave the device.

**Acceptance criteria**
- Browser speech recognition is off until the owner opts in.
- Consent is session-scoped and revocation cancels active capture.
- Provider/network behavior is disclosed before activation.
- Late callbacks after cancellation are ignored.
- Local-only processing is claimed only when verified.

### JARVIS-US-009 — Review-before-execute push-to-talk

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Push-to-talk transcript review and explicit execute flow exist; physical microphone/browser acceptance is pending.

**As the owner,** I want to review and edit a recognized transcript before submission, so that speech errors do not trigger unintended actions.

**Acceptance criteria**
- Transcript appears in an editable review area.
- No request is submitted before explicit execute action.
- Cancel, timeout, no-speech and recognition errors discard or retain the transcript according to a clear user-visible rule.
- Duplicate completion callbacks cannot submit the same capture twice.

### JARVIS-US-010 — Voice action policy and result feedback

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Voice directives use the authenticated policy path; same-utterance capture ordering is improved in source, but end-to-end recognition, dispatch, app launch and outcome feedback have not been verified.

**As the owner,** I want spoken commands to use the same authenticated policy and approval path as typed commands, so that voice cannot bypass security.

**Acceptance criteria**
- Voice text is normalized and submitted through authenticated request signing.
- Policy denial and required approval are respected.
- The HUD distinguishes received, planned, awaiting approval, executed, partial, failed and verified outcomes.
- Acknowledgement alone is never presented as proof of successful execution.

### JARVIS-US-011 — Local speech output and HUD usability

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Piper TTS and local STT adapters exist; local binaries/models, audible output and MSI end-to-end behavior remain unverified.

**As the owner,** I want local speech output and an accessible HUD, so that I can use JARVIS comfortably without mandatory cloud services.

**Acceptance criteria**
- Configured local TTS binary/model works on the MSI and audible output is verified.
- Stop/mute, timeout, hidden-tab and playback-error paths clean up resources.
- HUD supports keyboard access, readable status, responsive layout and visible privacy controls.
- Browser speech-synthesis fallback is clearly identified as a fallback.

## JARVIS-E03 — Windows Desktop Control

### JARVIS-US-012 — Safe allowlisted app launch

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Allowlisted application launch and voice capture/dispatch foundations exist; end-to-end voice-to-intent launch and real MSI app acceptance remain unverified.

**As the owner,** I want JARVIS to launch supported Windows apps, so that routine desktop tasks can be delegated safely.

**Acceptance criteria**
- Launch requests are limited to an explicit allowlist or trusted discovery result.
- Target process identity is verified independently of a matching title alone.
- Unknown or ambiguous apps are reported as unsupported/partial.
- Real MSI tests cover Notepad, Calculator and Paint.

### JARVIS-US-013 — Correct foreground-window targeting

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Foreground/process targeting safeguards exist; wrong-window and focus-change acceptance on Windows remains pending.

**As the owner,** I want JARVIS to verify the active window before interaction, so that text is never entered into the wrong application.

**Acceptance criteria**
- Target process/window identity is checked immediately before each action.
- Focus change or ambiguous identity aborts the action.
- No text is typed after target mismatch.
- The user receives a clear stopped/uncertain result.

### JARVIS-US-014 — Safe UI Automation controls

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — UI Automation discovery and guarded actions exist; custom/inaccessible controls and application coverage remain limited.

**As the owner,** I want JARVIS to inspect and operate supported UI controls, so that I can automate common desktop interactions.

**Acceptance criteria**
- Controls are selected by exact unique name or trusted AutomationId.
- Ambiguous or inaccessible controls fail closed.
- Read/click/set operations are constrained by policy and sensitive-field deny rules.
- Real-app evidence records the control, action and outcome.

### JARVIS-US-015 — Clipboard, keyboard and zoom helpers

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Clipboard, keyboard and zoom helper paths exist; full real-app verification remains pending.

**As the owner,** I want bounded clipboard, hotkey and zoom actions, so that JARVIS can assist with common desktop workflows.

**Acceptance criteria**
- Only allowlisted hotkeys and supported operations are accepted.
- Target window is verified before input.
- Cancellation and unexpected focus changes stop further input.
- Acknowledgement is distinguished from destination acceptance or persistence.

### JARVIS-US-016 — Independent outcome verification

**Current implementation status:** **NOT COMPLETE** — Control readback and verification foundations exist, but independent application-specific proof of saved/completed outcomes is not generally available.

**As the owner,** I want JARVIS to verify whether an application accepted or saved a change, so that it does not claim success based on an input event alone.

**Acceptance criteria**
- Verification uses independent observable evidence where available.
- Missing evidence yields partial/uncertain status.
- Unsupported verification is disclosed.
- No false success is returned for title-only or acknowledgement-only evidence.

## JARVIS-E04 — Multi-Step Execution & Recovery

### JARVIS-US-017 — Durable task lifecycle

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Encrypted task journal/checkpointing is integrated for key transitions; full lifecycle and crash/restart acceptance remain open.

**As the owner,** I want workflow state persisted before dependent side effects, so that crashes do not silently lose task progress.

**Acceptance criteria**
- Task creation, step transitions, approvals, cancellation and terminal outcomes are checkpointed.
- A failed checkpoint blocks the next side effect.
- Journal content is encrypted, bounded and schema-validated.
- Persistence failure marks the task uncertain/recovery-required.

### JARVIS-US-018 — Safe restart recovery

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Interrupted tasks are moved to recovery-required states and automatic replay is disabled; full restart scenarios remain unverified.

**As the owner,** I want interrupted tasks to be restored for review, so that JARVIS never blindly repeats an action after restart.

**Acceptance criteria**
- Non-terminal tasks restore to a recovery state.
- Stale approvals are cleared.
- No state-changing task automatically resumes or replays.
- Terminal task states remain terminal.

### JARVIS-US-019 — Human-reviewed reconciliation

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Human-reviewed reconciliation endpoint and companion/HUD workflow exist; operational behavior is untested.

**As the owner,** I want to review uncertain task outcomes and record what happened, so that recovery is explicit and auditable.

**Acceptance criteria**
- Only authorized devices/users can reconcile eligible tasks.
- `confirmed_no_effect` closes the task as failed without replay.
- `effect_observed` remains partial unless independently verified.
- `still_unknown` remains awaiting recovery.
- Notes are encrypted; audit records contain no raw sensitive note.
- No reconciliation disposition starts dependent workflow steps.

### JARVIS-US-020 — Safe scheduling and cancellation

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Scheduling, listing and cancellation foundations exist; complete delivery/recovery behavior is not accepted.

**As the owner,** I want scheduled tasks to persist and cancel safely, so that recurring work behaves predictably.

**Acceptance criteria**
- Schedule creation/list/cancel is authenticated and permission-gated.
- Recurrence and timezone behavior are explicit.
- Failed persistence prevents execution.
- Cancellation and revocation prevent future execution.
- Restart behavior is tested.

## JARVIS-E05 — Android Companion & Cross-Device Control

### JARVIS-US-021 — Independent Android enrollment

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Native Android app and identity/enrollment foundations exist; independent installation/enrollment on both phones is outstanding.

**As the owner,** I want to enroll each of my two Android phones separately, so that each phone has its own trusted identity.

**Acceptance criteria**
- Both phones use distinct Android Keystore-backed keys.
- Enrollment requires owner authorization and proof of possession.
- Device identity, session and permissions are independently visible.
- One phone cannot impersonate the other.

### JARVIS-US-022 — Secure phone-to-laptop command channel

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Companion API/command-queue foundations exist; secure end-to-end phone-to-laptop transport is not accepted.

**As the owner,** I want my phones to send authenticated requests to the laptop, so that companion actions remain secure across the network.

**Acceptance criteria**
- Requests are signed, replay-protected and expiry-checked.
- Transport and laptop reachability errors are handled safely.
- The phone cannot expand its own permission scope.
- Stale queued state-changing commands are rejected on reconnect.

### JARVIS-US-023 — Phone approvals and revocation

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Approval/revocation concepts and APIs exist; physical-device approval and revocation acceptance is outstanding.

**As the owner,** I want to approve eligible tasks from either phone and revoke a lost phone, so that I retain control while away from the laptop.

**Acceptance criteria**
- Approval displays the exact task/action/parameters and risk.
- Phone approval obeys the same single-use policy as laptop approval.
- Revoking phone A leaves phone B independently usable.
- Revoked phone A cannot act or replay commands.

### JARVIS-US-024 — Offline queue and recovery

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — A bounded inventory queue exists; durable offline delivery and physical two-phone recovery are not complete.

**As the owner,** I want safe handling when the laptop or phone is offline, so that queued work cannot execute unexpectedly later.

**Acceptance criteria**
- Queue items have bounded payloads and explicit TTL.
- Informational requests may be handled according to policy.
- State-changing commands are revalidated and re-approved as required after reconnect.
- Duplicate completion, timeout and cancellation are handled idempotently.

## JARVIS-E06 — Memory, Privacy & Personalization

### JARVIS-US-025 — Private local memory

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Encrypted local personal-memory storage and authenticated access foundations exist; privacy lifecycle acceptance remains pending.

**As the owner,** I want JARVIS to remember useful preferences and context locally, so that it can assist without sending all personal data to a cloud service.

**Acceptance criteria**
- Memory is encrypted at rest and integrity-checked.
- Categories, TTL and data restrictions are enforced.
- Credentials, payment data and other prohibited secrets are rejected.
- Reads are permission-aware and bounded.

### JARVIS-US-026 — Owner-controlled memory lifecycle

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Memory review/save/correction/deletion controls exist; verified retention and deletion behavior is not accepted.

**As the owner,** I want to review, correct, export and delete memories, so that I control what JARVIS retains.

**Acceptance criteria**
- Create/read/update/delete operations use signed, policy-gated routes.
- Deletion is confirmed and auditable.
- Retention and backup behavior are documented.
- Deletion evidence covers primary data and all configured secondary stores.

### JARVIS-US-027 — Cross-device memory consistency

**Current implementation status:** **NOT IMPLEMENTED** — Reliable cross-device memory synchronization and conflict resolution are still outstanding.

**As the owner,** I want memory to remain consistent across my laptop and phones, so that companion devices share only authorized context.

**Acceptance criteria**
- Sync is authenticated and encrypted.
- Conflicts are surfaced or resolved deterministically.
- Device permissions determine which memory categories can be read.
- Offline changes cannot silently overwrite newer owner data.

## JARVIS-E07 — AI, Integrations & Productivity Automation

### JARVIS-US-028 — Local-first conversational AI

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Authenticated conversational AI and local-first/advisory agent foundations exist; exact-head provider/workflow validation is pending.

**As the owner,** I want JARVIS to answer ordinary questions using a local model by default, so that routine assistance works without paid cloud usage.

**Acceptance criteria**
- Local endpoint/model configuration is explicit.
- Unavailable local inference returns an honest fallback.
- AI output is treated as untrusted content and cannot execute actions directly.
- No secret is committed to the repository.

### JARVIS-US-029 — Explicit cloud AI opt-in

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Remote/cloud provider use is configuration/opt-in gated; end-to-end privacy and provider behavior remain unverified.

**As the owner,** I want cloud AI to be used only when I authorize a task, so that cost and data exposure remain under my control.

**Acceptance criteria**
- Cloud endpoint is not selected by default.
- Each cloud use is task-scoped and clearly disclosed.
- API keys are supplied through local environment configuration only.
- No continuous audio upload or unrestricted memory transfer occurs.

### JARVIS-US-030 — Existing productivity workflows

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Selected companion, memory, schedule and desktop workflows exist; broad productivity workflow coverage remains incomplete.

**As the owner,** I want existing schedule, notification and companion workflows to work end to end, so that JARVIS can assist with routine organization.

**Acceptance criteria**
- Create/list/cancel and notification flows use authenticated APIs.
- Persistence, recurrence, timezone, restart and cancellation behavior are verified.
- Errors are visible and do not create duplicate tasks.
- Unsupported integrations are explicitly labelled unsupported.

### JARVIS-US-031 — Explicit integration boundaries

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Capability boundaries and guarded integration foundations exist; the planned integration set is not fully delivered.

**As the owner,** I want each third-party integration to disclose its permissions and limits, so that JARVIS does not silently access accounts or send communications.

**Acceptance criteria**
- Integration access is opt-in and least-privilege.
- Sending messages, emails, calls, calendar invitations or other external side effects requires explicit user intent and applicable approval.
- Unsupported services are not represented as implemented.
- Financial/payment workflows remain excluded.

## JARVIS-G01 — Release, Compatibility & Resource Acceptance

### JARVIS-US-032 — Evidence-based release readiness

**Current implementation status:** **NOT COMPLETE** — Release readiness requires exact-head CI and target-device evidence, which have not been produced for the current revision.

**As the owner,** I want one exact-head verification report, so that I know which capabilities are genuinely ready.

**Acceptance criteria**
- Build, typecheck, unit/integration, browser smoke, Python and Android checks are recorded where applicable.
- CI evidence points to the exact commit being evaluated.
- Target-device evidence identifies device/OS, scenario, expected result, actual result and limitations.
- Dependency/security audit output is recorded.
- No unverified feature is marked accepted or release-ready.

### JARVIS-US-033 — Balanced resource and compatibility behavior

**Current implementation status:** **NOT VERIFIED** — Balanced resource and compatibility targets are defined; measurements and target-device acceptance have not been performed.

**As the owner,** I want JARVIS to run smoothly on my existing laptop and phones, so that I do not need new hardware for the planned baseline.

**Acceptance criteria**
- Idle and active CPU/RAM/disk/network/battery usage are measured.
- Unsupported OS/browser/device combinations fail clearly and safely.
- HUD is keyboard-accessible and responsive.
- No admin privileges or always-on cloud dependency is introduced to meet resource goals.

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

### JARVIS-US-034 — Bounded transcription and recovery

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Bounded local transcription and cancellation lifecycle are implemented, including the latest Whisper subprocess and disconnect cancellation changes.

**As the owner,** I want stalled speech transcription to time out safely, so that voice input cannot remain locked indefinitely and partial text is never executed without review.

**Acceptance criteria**
- Transcription has a configurable, validated maximum duration independent of microphone capture duration.
- A stalled transcription transitions to transcript review when partial text exists, otherwise returns to idle.
- Partial transcripts are never automatically dispatched when the timeout fires.
- Completing, cancelling, muting or disposing transcription clears its timeout.
- A stale timeout cannot change the state of a later capture.
- Invalid transcription timeout configuration fails closed and allows a later fresh capture.

### JARVIS-US-035 — Reuse and verify an already-open application

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Existing application-window reuse and target checks are present; real Windows behavior remains untested.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Duplicate approval resolution and uncertain-outcome safeguards are present; exact-head security validation remains pending.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Task history and manual recovery review are surfaced in the HUD/companion; user/device acceptance remains pending.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Task details and explicit recovery transition explanations are implemented; runtime validation remains pending.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Stop/cancel controls and dependent-step interruption boundaries are implemented; runtime validation remains pending.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Asynchronous cancellation/expiry/checkpoint transition guards are implemented; no current-head validation has been run.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 role-separated prompt contracts and versioning are implemented; current-head AI behavior is untested.

**As the owner,** I want JARVIS to construct prompts using explicit system, developer and user roles with versioned templates, so that agent behavior is consistent, reviewable and safely maintainable.

**Acceptance criteria**
- Each supported prompt has a stable identifier, explicit version and declared message roles.
- System instructions, application/developer rules and user/task data remain separate.
- Required template variables are validated; missing or unexpected variables fail safely.
- User content, conversation history, retrieved memory and tool results are treated as untrusted data, never as instructions that override higher-priority policy.
- Prompt changes are traceable to a version; no hidden reasoning or secrets are exposed in outputs or logs.

### JARVIS-US-042 — Validate structured agent responses

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 structured response/schema validation is implemented; current-head validation is pending.

**As the owner,** I want each agent profile to return a strict, machine-readable response contract, so that malformed or unexpected model output cannot flow into JARVIS workflows.

**Acceptance criteria**
- Each profile has a versioned schema with required fields, types, bounds and no undeclared properties where strictness is required.
- Responses are parsed and validated locally before use.
- Invalid, refused, oversized or incomplete output is rejected or handled through a safe fallback.
- Confidence, clarification and safety fields have documented semantics.
- Raw model text is never treated as an executable instruction.

### JARVIS-US-043 — Route requests to the appropriate advisory agent

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 advisory-agent routing is implemented; end-to-end routing behavior is untested.

**As the owner,** I want JARVIS to route planning, tool-selection, summarization and developer-assistance requests to the appropriate agent profile, so that each task receives focused behavior.

**Acceptance criteria**
- Routing is deterministic, bounded and observable through safe metadata.
- Ambiguous requests ask for clarification or use a safe general response.
- Advisory agents cannot call desktop/device adapters or perform state changes.
- Requests with execution intent continue through the existing planner and policy gateway.
- Agent timeout, unavailable model and invalid output produce an honest fallback without bypassing authorization.

### JARVIS-US-044 — Prefer local AI inference and gate remote providers

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 local-first model adapter and remote-provider gating are implemented; provider acceptance remains pending.

**As the owner,** I want local inference to be the default and remote AI to require explicit configuration, so that routine assistance does not incur mandatory cloud cost or disclose personal context unexpectedly.

**Acceptance criteria**
- Local endpoint and model selection are explicit and configurable.
- Remote endpoints remain blocked unless the owner deliberately enables them.
- Remote requests receive only task-authorized, minimum-necessary context.
- API keys are supplied through local environment configuration and never committed or returned.
- Timeout, refusal, network failure and unavailable-model cases fail safely without pretending a model response was generated.

### JARVIS-US-045 — Maintain bounded device-isolated conversation history

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 bounded device-isolated conversation history is implemented; current-head persistence/authorization checks are pending.

**As the owner,** I want JARVIS to preserve recent conversation turns for continuity while isolating sessions by authenticated device, so that follow-up requests have relevant context without unbounded retention.

**Acceptance criteria**
- A conversation session is bound to the authenticated device identity.
- History contains only visible user and assistant turns; system/developer prompts and hidden reasoning are excluded.
- Message count, individual message size, total history size and session lifetime are bounded.
- History trimming preserves complete user/assistant turns.
- Session expiry, capacity eviction and device revocation cannot expose another device's conversation.
- Clear-conversation requests are authenticated, ownership-checked and serialized against in-flight messages.

### JARVIS-US-046 — Preserve conversation ordering and truthful persistence

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 per-conversation ordering and truthful persistence handling are implemented; runtime validation remains pending.

**As the owner,** I want concurrent messages to be processed in order and fallback responses handled honestly, so that conversation context is not corrupted or misleading.

**Acceptance criteria**
- Requests for the same conversation are serialized.
- Clearing a conversation cannot race with an in-flight turn and recreate stale history.
- Only responses eligible for persistence are appended to history.
- Model-unavailable/configuration fallbacks are not stored as if they were substantive assistant answers.
- Session limits and eviction are enforced without leaking locks or unbounded state.

### JARVIS-US-047 — Validate tool-selection candidates against trusted capabilities

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 tool candidates are checked against the trusted capability catalogue; current-head validation remains pending.

**As the owner,** I want tool-selection agents to choose only capabilities that JARVIS actually supports, so that invented or restricted tool names cannot enter an execution plan.

**Acceptance criteria**
- Every candidate identifier resolves to the authoritative capability catalogue.
- Unknown and restricted capabilities are rejected.
- Risk, approval requirements, platform support and device-agent requirements are sourced from the server-side catalogue, not trusted from model output.
- Candidate selection remains advisory and does not itself invoke a capability.
- Final execution still requires planner validation and policy-gateway authorization.

### JARVIS-US-048 — Validate task-plan dependency graphs

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 task-plan dependency graph validation is implemented; current-head validation remains pending.

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

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Build provenance manifest and deterministic release identity are present; exact-head workflow/artifact evidence is pending.


**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 role-separated prompt contracts and versioning are implemented; current-head AI behavior is untested.

**As a release maintainer,** I want each build artifact to carry a machine-readable provenance manifest, so that its project, source revision and CI origin can be traced.

**Acceptance criteria**
- The manifest identifies project, repository, normalized branch, full source commit, build number and CI provider/run.
- Required provenance fields are explicit, non-placeholder and validated.
- In CI, manifest identity agrees with available environment metadata.
- A deterministic release identity binds the manifest to its project/source/build identity.
- Missing or inconsistent required provenance fails closed.

### JARVIS-E08-US-050 — Verify artifact contents and checksums

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Manifest inventory, SHA-256 and archive-member verification are implemented in source; execution and package acceptance are pending.


**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 structured response/schema validation is implemented; current-head validation is pending.

**As a release maintainer,** I want manifest inventory and SHA-256 metadata validated before accepting an artifact, so that malformed or modified packages are rejected.

**Acceptance criteria**
- Manifest schema version and checksum algorithm are supported and validated.
- File inventory is an array whose entry count matches the declared file count.
- Each entry has a safe relative path, unique normalized path, non-negative safe-integer size and canonical SHA-256 digest.
- Malformed inventory metadata is rejected before checksum verification.
- Archive-member comparison verifies packaged files against the declared inventory; until implemented and evidenced, archive-content verification remains open.

### JARVIS-E08-US-051 — Verify customer-delivered packages against a release

**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — Customer package verification order and structured failure reports are implemented; exact-head operator/CI acceptance is pending.


**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 advisory-agent routing is implemented; end-to-end routing behavior is untested.

**As a customer-support or release operator,** I want a deterministic verification sequence and actionable report, so that delivery failures can be diagnosed without accepting an untrusted artifact.

**Acceptance criteria**
- The verifier authenticates and evaluates manifest-ignore policy before processing the manifest.
- It validates manifest schema, provenance and release identity before package acceptance.
- It verifies package checksum against trusted release metadata.
- Failure output identifies the failed stage and reason without leaking secrets or private key material.
- Legacy compatibility is explicit and does not weaken strict-provenance mode.

### JARVIS-E08-US-052 — Produce signed, SBOM-backed build artifacts through controlled CI

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — SBOM and signing pipeline foundations exist; exact-head signatures, SBOM and artifact inspection have not been accepted.


**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 local-first model adapter and remote-provider gating are implemented; provider acceptance remains pending.

**As a release maintainer,** I want GitHub Actions and Jenkins to produce consistent integrity metadata, signatures and dependency SBOMs, so that artifacts are traceable across supported CI providers.

**Acceptance criteria**
- Configured pipelines package artifact, manifest, checksum, signature metadata and CycloneDX SBOM as configured.
- Signing secrets are scoped to signing operations and temporary private-key files are removed.
- Pipeline commands fail immediately on tool errors and do not continue with incomplete outputs.
- Required CI configuration is documented by variable name only; no secret values are committed.
- Exact-head workflow execution and artifact inspection are recorded before acceptance.
- Nexus publishing remains disabled until separately approved.

### JARVIS-E08-US-053 — Control release promotion and recovery

**Current implementation status:** **PARTIALLY IMPLEMENTED — NOT VERIFIED** — Release quarantine/recovery evidence controls exist; operational exercise and owner-approved release handling remain pending.


**Current implementation status:** **IMPLEMENTED — NOT VERIFIED** — E07 bounded device-isolated conversation history is implemented; current-head persistence/authorization checks are pending.

**As the owner,** I want artifact promotion and rollback to require explicit authorization and recorded evidence, so that unverified builds cannot reach production.

**Acceptance criteria**
- Development artifacts remain on authorized development branches and do not automatically promote to production.
- Invalid/incomplete packages can be rejected or quarantined with a recorded reason.
- Recovery guidance identifies the failed stage and safe re-run boundary.
- No production merge, deployment or Nexus publication occurs without explicit owner approval.
- Validation and operational evidence remain pending while testing is paused.
