# JARVIS — User Stories and Acceptance Criteria

**Updated:** 2026-11-05  
**Planning branch:** `new`  
**Status convention:** Stories are **OPEN** until their acceptance criteria are evidenced. Existing source code may partially satisfy a story; that does not make it accepted.

Epic mapping: [EPICS.md](EPICS.md)  
Implementation baseline: [../POC.md](../POC.md)  
Detailed gap register: [../POC2.md](../POC2.md)

## JARVIS-E01 — Security, Identity & Approval Foundation

### JARVIS-US-001 — Trusted device identity
**As the owner,** I want every connected device to have its own cryptographic identity, so that one device cannot impersonate another.

**Acceptance criteria**
- Each device has a distinct key pair and device identifier.
- Requests are signed and validated against the enrolled public key.
- Invalid signatures, unknown devices, expired sessions and replayed nonces are rejected.
- Device enrollment requires owner-authorized proof of possession.
- No private key is returned through APIs, logs or audit records.

### JARVIS-US-002 — Policy-gated execution
**As the owner,** I want every state-changing action to pass one default-deny policy gateway, so that no adapter or endpoint can bypass authorization.

**Acceptance criteria**
- Every execution path checks device permission, operation allowlist and policy decision.
- Unknown operations and malformed parameters fail closed.
- Direct adapter access cannot execute a protected action.
- Financial/payment actions, credential entry, admin elevation and unrestricted shell remain blocked.

### JARVIS-US-003 — Scoped single-use approval
**As the owner,** I want approvals bound to the exact task and action, so that approval cannot be reused for a different operation.

**Acceptance criteria**
- Approval is bound to task, device, operation, canonical parameters and expiry.
- Approval is consumed at most once.
- Duplicate, concurrent, stale, expired and revoked approvals are rejected.
- A task outside the pending-approval state cannot be approved or rejected through a stale record.

### JARVIS-US-004 — Tamper-evident audit and fail-closed persistence
**As the owner,** I want security-relevant actions recorded in a tamper-evident audit trail, so that failures and misuse can be investigated.

**Acceptance criteria**
- Audit entries are hash chained and integrity is verified.
- Sensitive values, credentials, tokens and signatures are redacted.
- Audit/security persistence failure blocks dependent execution.
- Tampering is detected and recovery behavior is documented.

### JARVIS-US-005 — Owner recovery and device revocation
**As the owner,** I want to recover account control and revoke a lost device, so that device loss does not compromise JARVIS.

**Acceptance criteria**
- Owner recovery covers authenticator/TOTP loss and device-management loss.
- Revocation takes effect for new requests immediately.
- Revoked devices cannot replay old requests or regain access without fresh enrollment.
- Recovery events are audited without exposing secrets.

## JARVIS-E02 — Voice Interaction & Cinematic HUD

### JARVIS-US-006 — Local wake phrase
**As the owner,** I want to say “Hey Jarvis” and wake JARVIS locally, so that routine wake detection does not require continuous cloud audio upload.

**Acceptance criteria**
- Wake detection uses the configured local engine/model.
- Microphone listening is visibly indicated and can be muted/stopped immediately.
- Wake accuracy, false triggers, startup, sleep/resume and resource use are measured on the MSI.
- Wake detection is disabled until the owner explicitly enables it.
- No continuous cloud audio upload is used for wake detection.

### JARVIS-US-007 — Clear wake acknowledgement
**As the owner,** I want JARVIS to respond with “Hi sir, I am ready to work.” after a valid wake, so that I know it is ready.

**Acceptance criteria**
- The acknowledgement is played only after a confirmed wake event.
- Playback state and failures are visible.
- Cancellation/mute stops output promptly.
- No acknowledgement is reported as played unless playback actually starts.

### JARVIS-US-008 — Consent-controlled speech capture
**As the owner,** I want separate, explicit consent for any browser/vendor speech recognition, so that I understand when audio may leave the device.

**Acceptance criteria**
- Browser speech recognition is off until the owner opts in.
- Consent is session-scoped and revocation cancels active capture.
- Provider/network behavior is disclosed before activation.
- Late callbacks after cancellation are ignored.
- Local-only processing is claimed only when verified.

### JARVIS-US-009 — Review-before-execute push-to-talk
**As the owner,** I want to review and edit a recognized transcript before submission, so that speech errors do not trigger unintended actions.

**Acceptance criteria**
- Transcript appears in an editable review area.
- No request is submitted before explicit execute action.
- Cancel, timeout, no-speech and recognition errors discard or retain the transcript according to a clear user-visible rule.
- Duplicate completion callbacks cannot submit the same capture twice.

### JARVIS-US-010 — Voice action policy and result feedback
**As the owner,** I want spoken commands to use the same authenticated policy and approval path as typed commands, so that voice cannot bypass security.

**Acceptance criteria**
- Voice text is normalized and submitted through authenticated request signing.
- Policy denial and required approval are respected.
- The HUD distinguishes received, planned, awaiting approval, executed, partial, failed and verified outcomes.
- Acknowledgement alone is never presented as proof of successful execution.

### JARVIS-US-011 — Local speech output and HUD usability
**As the owner,** I want local speech output and an accessible HUD, so that I can use JARVIS comfortably without mandatory cloud services.

**Acceptance criteria**
- Configured local TTS binary/model works on the MSI and audible output is verified.
- Stop/mute, timeout, hidden-tab and playback-error paths clean up resources.
- HUD supports keyboard access, readable status, responsive layout and visible privacy controls.
- Browser speech-synthesis fallback is clearly identified as a fallback.

## JARVIS-E03 — Windows Desktop Control

### JARVIS-US-012 — Safe allowlisted app launch
**As the owner,** I want JARVIS to launch supported Windows apps, so that routine desktop tasks can be delegated safely.

**Acceptance criteria**
- Launch requests are limited to an explicit allowlist or trusted discovery result.
- Target process identity is verified independently of a matching title alone.
- Unknown or ambiguous apps are reported as unsupported/partial.
- Real MSI tests cover Notepad, Calculator and Paint.

### JARVIS-US-013 — Correct foreground-window targeting
**As the owner,** I want JARVIS to verify the active window before interaction, so that text is never entered into the wrong application.

**Acceptance criteria**
- Target process/window identity is checked immediately before each action.
- Focus change or ambiguous identity aborts the action.
- No text is typed after target mismatch.
- The user receives a clear stopped/uncertain result.

### JARVIS-US-014 — Safe UI Automation controls
**As the owner,** I want JARVIS to inspect and operate supported UI controls, so that I can automate common desktop interactions.

**Acceptance criteria**
- Controls are selected by exact unique name or trusted AutomationId.
- Ambiguous or inaccessible controls fail closed.
- Read/click/set operations are constrained by policy and sensitive-field deny rules.
- Real-app evidence records the control, action and outcome.

### JARVIS-US-015 — Clipboard, keyboard and zoom helpers
**As the owner,** I want bounded clipboard, hotkey and zoom actions, so that JARVIS can assist with common desktop workflows.

**Acceptance criteria**
- Only allowlisted hotkeys and supported operations are accepted.
- Target window is verified before input.
- Cancellation and unexpected focus changes stop further input.
- Acknowledgement is distinguished from destination acceptance or persistence.

### JARVIS-US-016 — Independent outcome verification
**As the owner,** I want JARVIS to verify whether an application accepted or saved a change, so that it does not claim success based on an input event alone.

**Acceptance criteria**
- Verification uses independent observable evidence where available.
- Missing evidence yields partial/uncertain status.
- Unsupported verification is disclosed.
- No false success is returned for title-only or acknowledgement-only evidence.

## JARVIS-E04 — Multi-Step Execution & Recovery

### JARVIS-US-017 — Durable task lifecycle
**As the owner,** I want workflow state persisted before dependent side effects, so that crashes do not silently lose task progress.

**Acceptance criteria**
- Task creation, step transitions, approvals, cancellation and terminal outcomes are checkpointed.
- A failed checkpoint blocks the next side effect.
- Journal content is encrypted, bounded and schema-validated.
- Persistence failure marks the task uncertain/recovery-required.

### JARVIS-US-018 — Safe restart recovery
**As the owner,** I want interrupted tasks to be restored for review, so that JARVIS never blindly repeats an action after restart.

**Acceptance criteria**
- Non-terminal tasks restore to a recovery state.
- Stale approvals are cleared.
- No state-changing task automatically resumes or replays.
- Terminal task states remain terminal.

### JARVIS-US-019 — Human-reviewed reconciliation
**As the owner,** I want to review uncertain task outcomes and record what happened, so that recovery is explicit and auditable.

**Acceptance criteria**
- Only authorized devices/users can reconcile eligible tasks.
- `confirmed_no_effect` closes the task as failed without replay.
- `effect_observed` remains partial unless independently verified.
- `still_unknown` remains awaiting recovery.
- Notes are encrypted; audit records contain no raw sensitive note.
- No reconciliation disposition starts dependent workflow steps.

### JARVIS-US-020 — Safe scheduling and cancellation
**As the owner,** I want scheduled tasks to persist and cancel safely, so that recurring work behaves predictably.

**Acceptance criteria**
- Schedule creation/list/cancel is authenticated and permission-gated.
- Recurrence and timezone behavior are explicit.
- Failed persistence prevents execution.
- Cancellation and revocation prevent future execution.
- Restart behavior is tested.

## JARVIS-E05 — Android Companion & Cross-Device Control

### JARVIS-US-021 — Independent Android enrollment
**As the owner,** I want to enroll each of my two Android phones separately, so that each phone has its own trusted identity.

**Acceptance criteria**
- Both phones use distinct Android Keystore-backed keys.
- Enrollment requires owner authorization and proof of possession.
- Device identity, session and permissions are independently visible.
- One phone cannot impersonate the other.

### JARVIS-US-022 — Secure phone-to-laptop command channel
**As the owner,** I want my phones to send authenticated requests to the laptop, so that companion actions remain secure across the network.

**Acceptance criteria**
- Requests are signed, replay-protected and expiry-checked.
- Transport and laptop reachability errors are handled safely.
- The phone cannot expand its own permission scope.
- Stale queued state-changing commands are rejected on reconnect.

### JARVIS-US-023 — Phone approvals and revocation
**As the owner,** I want to approve eligible tasks from either phone and revoke a lost phone, so that I retain control while away from the laptop.

**Acceptance criteria**
- Approval displays the exact task/action/parameters and risk.
- Phone approval obeys the same single-use policy as laptop approval.
- Revoking phone A leaves phone B independently usable.
- Revoked phone A cannot act or replay commands.

### JARVIS-US-024 — Offline queue and recovery
**As the owner,** I want safe handling when the laptop or phone is offline, so that queued work cannot execute unexpectedly later.

**Acceptance criteria**
- Queue items have bounded payloads and explicit TTL.
- Informational requests may be handled according to policy.
- State-changing commands are revalidated and re-approved as required after reconnect.
- Duplicate completion, timeout and cancellation are handled idempotently.

## JARVIS-E06 — Memory, Privacy & Personalization

### JARVIS-US-025 — Private local memory
**As the owner,** I want JARVIS to remember useful preferences and context locally, so that it can assist without sending all personal data to a cloud service.

**Acceptance criteria**
- Memory is encrypted at rest and integrity-checked.
- Categories, TTL and data restrictions are enforced.
- Credentials, payment data and other prohibited secrets are rejected.
- Reads are permission-aware and bounded.

### JARVIS-US-026 — Owner-controlled memory lifecycle
**As the owner,** I want to review, correct, export and delete memories, so that I control what JARVIS retains.

**Acceptance criteria**
- Create/read/update/delete operations use signed, policy-gated routes.
- Deletion is confirmed and auditable.
- Retention and backup behavior are documented.
- Deletion evidence covers primary data and all configured secondary stores.

### JARVIS-US-027 — Cross-device memory consistency
**As the owner,** I want memory to remain consistent across my laptop and phones, so that companion devices share only authorized context.

**Acceptance criteria**
- Sync is authenticated and encrypted.
- Conflicts are surfaced or resolved deterministically.
- Device permissions determine which memory categories can be read.
- Offline changes cannot silently overwrite newer owner data.

## JARVIS-E07 — AI, Integrations & Productivity Automation

### JARVIS-US-028 — Local-first conversational AI
**As the owner,** I want JARVIS to answer ordinary questions using a local model by default, so that routine assistance works without paid cloud usage.

**Acceptance criteria**
- Local endpoint/model configuration is explicit.
- Unavailable local inference returns an honest fallback.
- AI output is treated as untrusted content and cannot execute actions directly.
- No secret is committed to the repository.

### JARVIS-US-029 — Explicit cloud AI opt-in
**As the owner,** I want cloud AI to be used only when I authorize a task, so that cost and data exposure remain under my control.

**Acceptance criteria**
- Cloud endpoint is not selected by default.
- Each cloud use is task-scoped and clearly disclosed.
- API keys are supplied through local environment configuration only.
- No continuous audio upload or unrestricted memory transfer occurs.

### JARVIS-US-030 — Existing productivity workflows
**As the owner,** I want existing schedule, notification and companion workflows to work end to end, so that JARVIS can assist with routine organization.

**Acceptance criteria**
- Create/list/cancel and notification flows use authenticated APIs.
- Persistence, recurrence, timezone, restart and cancellation behavior are verified.
- Errors are visible and do not create duplicate tasks.
- Unsupported integrations are explicitly labelled unsupported.

### JARVIS-US-031 — Explicit integration boundaries
**As the owner,** I want each third-party integration to disclose its permissions and limits, so that JARVIS does not silently access accounts or send communications.

**Acceptance criteria**
- Integration access is opt-in and least-privilege.
- Sending messages, emails, calls, calendar invitations or other external side effects requires explicit user intent and applicable approval.
- Unsupported services are not represented as implemented.
- Financial/payment workflows remain excluded.

## JARVIS-G01 — Release, Compatibility & Resource Acceptance

### JARVIS-US-032 — Evidence-based release readiness
**As the owner,** I want one exact-head verification report, so that I know which capabilities are genuinely ready.

**Acceptance criteria**
- Build, typecheck, unit/integration, browser smoke, Python and Android checks are recorded where applicable.
- CI evidence points to the exact commit being evaluated.
- Target-device evidence identifies device/OS, scenario, expected result, actual result and limitations.
- Dependency/security audit output is recorded.
- No unverified feature is marked accepted or release-ready.

### JARVIS-US-033 — Balanced resource and compatibility behavior
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
