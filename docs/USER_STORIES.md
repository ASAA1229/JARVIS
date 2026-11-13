# JARVIS — User Stories and Acceptance Criteria

**Status date:** 2026-11-13  
**Source of truth:** this file plus [POC](POC.md), [Gap Analysis](GAP_ANALYSIS.md), [Requirements](REQUIREMENTS.md) and [Architecture](ARCHITECTURE.md).

## Status convention

- **Implemented — needs testing:** code is present; acceptance not demonstrated.
- **Test-authored:** automated test exists; execution is not implied.
- **Partial:** only part of the story is implemented or validated.
- **Not implemented:** no accepted implementation.
- **Blocked / owner acceptance:** needs hardware, credentials, approved external dependency or owner action.
- **Accepted:** all stated criteria and evidence are satisfied for the relevant platform and exact commit.

Stories are deliberately outcome-based. An API route, UI control or source file alone does not satisfy a story.

## Epic 1 — Identity, trust and owner governance

### JARVIS-US-001 — Enroll independent devices
As the owner, I want each companion device to have its own cryptographic identity and permissions so that compromise or revocation of one device does not implicitly trust another.

Acceptance:
- Each device generates and protects its own private key.
- Enrollment requires an owner-authorized transaction and proof of possession.
- Device permissions are least-privilege and independently revocable.
- Unknown, expired, revoked and replayed requests are rejected.
- Two Android phones can enroll and operate independently.

Status: **Partial — Android source exists; two-phone physical acceptance pending.**

### JARVIS-US-002 — Approve exact state-changing work
As the owner, I want approvals bound to the exact device, task, operation, parameters, target and expiry so that changed or replayed requests cannot reuse consent.

Acceptance:
- Default-deny policy evaluates every state-changing operation.
- Approval is single-use, expiry-bound and scope-bound.
- Policy is rechecked immediately before dispatch.
- Model output, voice recognition and plugins cannot grant authority.
- Denial and mismatch are audited without leaking sensitive payloads.

Status: **Implemented — needs adversarial and exact-head testing.**

### JARVIS-US-003 — Revoke and recover a device
As the owner, I want immediate revocation and safe recovery so that a lost phone cannot continue to act.

Acceptance:
- Revocation blocks future requests immediately.
- Active work stops or becomes uncertain and is reconciled.
- Replacement devices enroll with new keys.
- Other devices remain active unless revoke-all is explicitly selected.

Status: **Implemented — needs device/fault acceptance.**

## Epic 2 — Conversation and local AI

### JARVIS-US-004 — Use local AI by default
As the owner, I want JARVIS to use local Ollama for private conversations so that my data does not silently leave my devices.

Acceptance:
- Provider routing selects local Ollama by default.
- Remote providers remain unavailable without explicit configuration and task authorization.
- No private-memory cloud fallback occurs after local failure.
- Timeouts, unavailable models and malformed responses are bounded and reported.
- Existing conversation contracts remain stable.

Status: **Implemented — needs exact-head live Ollama testing.**

### JARVIS-US-005 — Use specialist agents safely
As the owner, I want specialist agents to plan and review work without direct host authority.

Acceptance:
- Agent outputs are schema-validated and advisory.
- Tool candidates map to registered capabilities.
- All actions pass the normal policy/approval/execution path.
- Malformed, conflicting or injected outputs fail closed.

Status: **Partial — agent foundation exists; broad quality/regression suite required.**

## Epic 3 — Voice and hands-free interaction

### JARVIS-US-006 — Wake JARVIS locally
As the owner, I want an opt-in local “Hey Jarvis” wake phrase so that hands-free activation does not require continuous cloud audio upload.

Acceptance:
- Listening is visibly indicated and can be muted/stopped immediately.
- Local wake processing is proven on the MSI, not inferred from a browser mock.
- Measure false accepts, false rejects, wake latency, CPU/RAM and performance in quiet/noisy environments.
- Consent revocation stops capture and discards pending transcript.
- Wake phrase alone never authorizes consequential actions.

Status: **Partial — local wake path and browser orchestration exist; hardware/acoustic acceptance pending.**

### JARVIS-US-007 — Convert speech into a reviewed command
As the owner, I want speech converted into a transcript and command proposal that I can review before consequential execution.

Acceptance:
- Capture, STT, final transcript, intent/parameter extraction and request submission have explicit states.
- Interim hypotheses cannot execute.
- Transcript review/explicit submission is enforced where configured.
- Recognition errors, empty/ambiguous transcripts, timeouts and cancellation are recoverable.
- A single utterance cannot create duplicate tasks.
- Command parameters and target application are confirmed when ambiguous.
- Authorization and independent outcome verification are identical to typed commands.

Status: **Partial — browser E2E scenarios authored; real microphone/STT and full action-chain acceptance pending.**

### JARVIS-US-008 — Receive spoken acknowledgement and results
As the owner, I want spoken acknowledgement and concise completion/error reports.

Acceptance:
- Target phrase is “Hi sir, I am ready to work”.
- Local Piper is preferred when installed and configured.
- Browser speech fallback is disclosed as potentially remote.
- TTS failure does not affect task correctness or authorization.
- Audio output can be stopped and is not logged as sensitive content.

Status: **Partial — TTS paths exist; target-device acceptance pending.**

## Epic 4 — Desktop and application automation

### JARVIS-US-009 — Discover and launch approved applications
As the owner, I want JARVIS to discover installed apps and launch only approved targets.

Acceptance:
- Resolve app identity from trusted OS metadata/registered adapters.
- Never launch an ambiguous or untrusted target.
- Confirm process/window identity and report launch outcome.
- Respect allowlists, permissions and owner policy.

Status: **Partial — Windows adapter foundation exists; broad app compatibility matrix pending.**

### JARVIS-US-010 — Interact with application controls
As the owner, I want JARVIS to perform supported UI actions and verify the resulting state.

Acceptance:
- Verify foreground process/window before every action.
- Stop on focus changes, ambiguous controls or inaccessible UI.
- Use supported OS accessibility/UI APIs rather than blind coordinates where possible.
- Verify the state change independently.
- Report unsupported/partial outcomes honestly.

Status: **Partial — selected capabilities exist; app-by-app reliability evidence pending.**

## Epic 5 — Task execution, concurrency and recovery

### JARVIS-US-011 — Plan and execute multi-step tasks
As the owner, I want JARVIS to break work into dependent steps and track each result.

Acceptance:
- Tasks have durable identity, lifecycle, dependency, deadline and audit references.
- Planner output is validated and advisory.
- Every side effect is authorized and verified.
- Failed/blocked/uncertain prerequisites prevent dependent execution.
- Partial outcomes are visible to the owner.

Status: **Implemented — needs integration/fault testing.**

### JARVIS-US-012 — Execute independent workflow branches safely
As the owner, I want independent DAG branches to run concurrently while dependent branches wait.

Acceptance:
- Validate missing dependencies, cycles and duplicate IDs.
- Each branch has isolated task state, approval, attempt count, checkpoint and outcome.
- Branch execution passes the live task service, policy gateway, audit, encrypted journal and outcome verifier.
- Bound concurrency and resource locks prevent races/deadlocks.
- A failed branch blocks descendants but does not unnecessarily stop unrelated safe branches.
- Cancellation, timeout and restart preserve truthful outcomes.
- Uncertain/non-idempotent branches never replay automatically.

Status: **Partial — standalone DAG executor/checkpoint safeguards exist; live service integration is not complete.**

### JARVIS-US-013 — Recover interrupted work
As the owner, I want JARVIS to reconcile work after a crash or partial failure rather than blindly repeating it.

Acceptance:
- Persist checkpoint before external side effects.
- Distinguish no-effect, completed, partial and uncertain.
- Require owner reconciliation where external state cannot be proven.
- Retry only with confirmed no-effect or verified idempotency.
- Preserve audit and branch-level approval history.

Status: **Partial — foundations exist; live DAG recovery and process-kill tests pending.**

## Epic 6 — Memory, retrieval and learning

### JARVIS-US-014 — Manage personal memory
As the owner, I want encrypted, categorized memory that I can review, correct, export and delete.

Acceptance:
- Memory has provenance, owner scope, retention and expiry.
- Changes are owner-reviewed where required.
- Deletion covers primary records and derived indexes/caches where supported and verifies completion.
- Cross-device access is permission-bound.
- Corrupt state fails closed.

Status: **Implemented — needs lifecycle/security acceptance.**

### JARVIS-US-015 — Retrieve useful memories and documents
As the owner, I want relevant memory/document context with source attribution.

Acceptance:
- Semantic and lexical retrieval are bounded and have deterministic fallback.
- Document ingestion validates type, size and ownership.
- PDF/DOCX parsing and OCR are local-only and bounded.
- Results cite source and chunk.
- Retrieved text is untrusted and cannot instruct JARVIS to execute actions.
- Deletion removes source and derived index entries.

Status: **Partial — retrieval/parser foundations exist; adversarial, relevance and deletion tests required.**

### JARVIS-US-016 — Measure learning quality
As the owner, I want evidence that memory and learning improve retrieval and task outcomes rather than simply increasing stored data.

Acceptance:
- Capture owner-labelled relevance judgements and helpful/not-helpful feedback.
- Measure Precision@K, Recall@K, MRR, helpful rate, correction rate and candidate acceptance rate.
- Track trends only after a minimum sample threshold.
- Establish a baseline evaluation corpus and prevent regression beyond agreed tolerances.
- Keep raw prompts, transcripts, memory text and identifiers out of aggregate telemetry.
- Candidate approval/rejection must remain owner-controlled; metrics cannot auto-promote memory.

Status: **Partial — encrypted aggregate evaluator and HUD/API hooks exist; live retrieval instrumentation, benchmark corpus and regression gates remain.**

## Epic 7 — Android companion and synchronization

### JARVIS-US-017 — Use two independent Android companions
As the owner, I want each phone to connect independently and perform only its granted capabilities.

Acceptance:
- Debug/release package builds reproducibly.
- Each phone has independent identity and encrypted local queue.
- Signed request, expiry, replay and revocation checks work.
- Background polling behavior and limitations are disclosed.
- Physical install and two-phone acceptance are recorded.

Status: **Partial — Android source exists; build/install/device acceptance pending.**

### JARVIS-US-018 — Synchronize safely across devices
As the owner, I want memory and approved changes to synchronize without silently overwriting conflicting data.

Acceptance:
- Durable bounded queues, TTL, monotonic sequence and replay protection.
- Device-scoped data and permissions.
- Explicit conflict resolution; no last-writer-wins.
- Offline state-changing commands remain held for owner decision.
- Reconnect, revoked-device and crash recovery tests pass.

Status: **Partial — sync contracts/queue foundation exist; durable end-to-end acceptance pending.**

## Epic 8 — Cross-platform support

### JARVIS-US-019 — Use JARVIS across desktop and mobile platforms
As the owner, I want a consistent product experience across Windows, macOS, Linux, Android and iOS.

Acceptance:
- Shared API/contracts and capability negotiation.
- Native adapters use platform permissions and secure storage.
- Unsupported capabilities are declared per OS/version.
- Each platform has automated and physical-device acceptance.
- No claim of universal support based only on shared UI/API.

Status: **Partial — Windows/Android foundations; macOS/Linux/iOS not accepted.**

## Epic 9 — Plugins, developer tools and integrations

### JARVIS-US-020 — Add integrations safely
As the owner, I want integrations installed disabled and granted only narrow permissions.

Acceptance:
- Data-only manifests; no arbitrary plugin code or shell.
- Explicit install, grant, revoke and version validation.
- All actions use standard policy/approval and audit.
- Invalid or injected manifests fail closed.

Status: **Partial — plugin/workflow foundation exists; expanded adversarial testing required.**

### JARVIS-US-021 — Use JARVIS as a developer assistant
As the owner, I want JARVIS to inspect permitted repositories and propose changes without exposing secrets or pushing unapproved work.

Acceptance:
- Explicit repository and scope grants.
- Secret/runtime/protected paths excluded.
- Suggestions remain drafts until separately approved.
- Apply, branch, commit and push are distinct operations.
- CI evidence refers to exact commit SHA.

Status: **Partial — developer assistant foundation exists; end-to-end scoped Git/CI acceptance pending.**

## Epic 10 — Build, release and operations

### JARVIS-US-022 — Produce verifiable releases
As the owner, I want reproducible packages with provenance, checksums and offline verification.

Acceptance:
- Build provenance, SBOM and SHA-256 inventory.
- Trusted signing/manifest policy.
- Archive/path/symlink/inventory tamper tests.
- Clean-room verification and backup/restore drills.
- Release approval remains owner-controlled.

Status: **Partial — utility foundation exists; complete signed release pipeline and operational acceptance pending.**

### JARVIS-US-023 — Operate and recover JARVIS
As the owner, I want reliable health, diagnostics, backup and recovery without exposing private data.

Acceptance:
- Redacted health/diagnostic events.
- Resource, queue, task and provider health are bounded and observable.
- Backup/restore is documented and tested.
- Persistence/audit failures fail closed.
- Recovery distinguishes uncertain external effects.

Status: **Partial — operations documentation and selected health routes exist; measured SLOs and full recovery drills pending.**

## Epic 11 — Privacy, quality and performance

### JARVIS-US-024 — Protect private data and consent
As the owner, I want sensitive data to remain local by default and all sensor use to be visible and revocable.

Acceptance:
- No continuous cloud audio upload by default.
- Browser STT remote-processing limitations disclosed.
- Prompt/transcript/secret payloads excluded from routine logs.
- Export/deletion/retention semantics are clear.
- Cloud use is explicit, scoped and revocable.

Status: **Implemented in policy design; needs end-to-end privacy verification.**

### JARVIS-US-025 — Meet reliability and performance targets
As the owner, I want measurable reliability and resource usage across core scenarios.

Acceptance:
- Define latency, CPU, RAM, queue wait, timeout and recovery budgets.
- Run repeated workload and soak tests.
- Track crash-free task completion and verified outcome rate.
- Test resource exhaustion, queue saturation and provider outage.
- Publish measurements with hardware/software configuration.

Status: **Not complete — budgets and repeatable performance baseline need to be established.**

## Delivery order

1. P0: live workflow DAG integration, branch isolation, approvals, journal, audit, outcome verification and recovery.
2. P0: voice-to-command reliability on real Windows hardware, including wake/STT, consent, transcript review, duplicate prevention and safe execution.
3. P0: exact-head CI and security/fault-injection gates; repair existing browser smoke failures.
4. P1: learning evaluation connected to actual retrieval and task feedback; benchmark corpus and regression thresholds.
5. P1: RAG/parser security, relevance and deletion validation.
6. P1: Windows app-automation compatibility matrix and two-Android-device acceptance.
7. P1: cross-device durable sync and recovery.
8. P2: macOS/Linux/iOS native implementations, broader integrations and release automation.

