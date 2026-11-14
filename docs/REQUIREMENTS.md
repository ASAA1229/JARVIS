# Requirements

## 1. Product definition and approved constraints

JARVIS is a local-first personal AI operating assistant evolving toward a personal AI operating system. It combines chat, voice, supported desktop/mobile capabilities, guarded task execution, owner-controlled memory, integrations, scheduling and recovery. Deliver useful increments; the full vision is not a prerequisite for an MVP.

- Primary host: Windows 11 laptop.
- Companion devices: two independently enrolled Android phones.
- Future targets: macOS, Linux desktop and iOS; these are not currently accepted implementations.
- AI: Ollama local-first; cloud providers optional, disabled unless configured and explicitly authorized.
- Cost: zero recurring cost by default; paid services require explicit approval.
- Autonomy: execute permitted work within approved boundaries; pause for sensitive, irreversible, ambiguous or untrusted operations.
- Memory: local-first, categorized, owner-controlled, reviewable, correctable, expirable and deletable.
- Voice: local wake detection is the target; visible listening state, mute/stop, consent and push-to-talk fallback are required.
- Explicit exclusions: financial/payment automation, credential entry, unrestricted shell, administrator elevation, security bypass and voice-only high-risk authorization.

## 2. Functional requirements

### 2.1 Conversation and AI
- Preserve existing chat UI, authenticated chat API, conversation IDs, prompt system, agent orchestration and response contracts.
- Route local inference through the provider abstraction; native Ollama `/api/chat` is primary.
- Support configurable model, URL, timeout, health/model checks, bounded retry and typed error handling.
- Preserve streaming where existing callers support it.
- Keep future provider adapters replaceable without changing business logic.
- Treat model output as advisory and validate structured responses.
- Keep cloud use task-scoped, explicit and privacy-aware.

### 2.2 Voice and HUD
- Text and consent-controlled voice interaction through the existing HUD.
- Push-to-talk, transcript review where configured, cancellation, timeout, mute and visible microphone/listening state.
- Local “Hey Jarvis” wake is the target; explicitly enabled and tested per target device. Measure false accepts, false rejects, wake latency and resource use on actual hardware.
- Target acknowledgement: “Hi sir, I am ready to work.”
- Optional local Piper TTS; browser speech synthesis fallback. Local TTS does not prove local speech recognition.
- Voice is not strong authentication and cannot independently authorize high-risk actions. End-to-end validation covers microphone, wake, capture, STT, transcript finalization/review, intent/parameter extraction, signed request, policy/approval, execution and independent outcome verification.

### 2.3 Desktop and app capabilities
- Discover installed applications and registered capabilities; choose the safest supported official API or UI adapter.
- Launch allowlisted applications and reuse a matching window only when identity is verified.
- Verify process/window identity and foreground target before interaction; stop on ambiguity, focus change or inaccessible controls.
- Support only implemented/tested actions such as selected UI controls, clipboard, keyboard and zoom.
- Independently verify state-changing outcomes; acknowledgements are not proof of completion.
- Report unsupported capabilities as unsupported or partial.

### 2.4 Task planning, execution and recovery
- Track task identity, lifecycle, dependencies, progress, cancellation, deadlines and audit references.
- Planner/agent output is advisory; only trusted capabilities can execute.
- Every state-changing step passes policy and task/device/operation/parameter-bound approval.
- Persist required checkpoints before dependent side effects.
- Stop descendants after failed, blocked, cancelled or uncertain prerequisites.
- Distinguish completed, failed, partial, uncertain, blocked, cancelled and recovery-required outcomes.
- Treat interrupted external effects as uncertain. Never automatically replay a non-idempotent or uncertain action.
- Retry only after owner-reviewed confirmed-no-effect reconciliation or a verified idempotency contract.
- Scheduling revalidates permission/risk at run time and persists at-most-once state before dispatch.

### 2.5 Concurrency and workflows
- Bound planner and adapter admission, queue lengths and per-device concurrency.
- Prioritize interactive work while aging queued work to prevent starvation.
- Acquire complete resource lock sets atomically in canonical order.
- Release locks/slots on completion, error, cancellation and timeout.
- Reject duplicate task admission and unsafe re-entrant admission.
- Validate workflow DAGs for missing dependencies and cycles.
- Concurrent branches are enabled only after full executor/service integration and testing.
- Branch approvals must be scoped and revalidated through the normal policy gateway.
- Partial failure blocks descendants but may allow unrelated safe branches to finish.
- No automatic replay of uncertain branches after restart.

### 2.6 Memory and learning
- Preserve bounded device/conversation-isolated session context.
- Maintain short-lived working memory and encrypted long-term memory.
- Support categories, provenance, owner review, correction, expiry, export and verified deletion.
- Retrieve relevant memory and owner-scoped documents using local semantic/lexical signals; use lexical fallback if embeddings fail.
- Ingest bounded UTF-8 text documents, deduplicate, chunk with overlap, cite source filename/title/chunk, and support list/search/delete.
- Encrypt document content and derived embeddings at rest; isolate documents by authenticated device.
- Treat retrieved memory/document text as untrusted, never as system instructions or action authority.
- PDF/DOCX parsing and opt-in local OCR have implementation documented in the architecture/operations baseline; parser security, relevance, deletion and physical-environment acceptance remain required. Cross-device document sharing remains a separate capability.
- Capture feedback/useful facts as encrypted, attributed learning candidates.
- Require owner approval before candidates become durable memory.
- Never automatically fine-tune model weights.\n- Measure retrieval quality using owner-labelled relevance judgements, Precision@K, Recall@K, MRR, helpful/correction feedback and learning-candidate acceptance. Establish a versioned baseline corpus and regression thresholds before claiming learning improvement. Metrics must never auto-promote memory or authorize actions.
- Define deletion/retention across primary stores, indexes, caches, exports and backups.
- When owner control is configured, conversation sessions use encrypted local persistence and restore after restart; sessions expire after about 30 minutes. Without owner control, session history is process-local. Validate the exact configured path and behavior against the deployed build.

### 2.7 Companion and synchronization
- Independently enroll each phone with distinct key and permissions.
- Sign requests; enforce session expiry, replay defense and immediate revocation.
- Use trusted HTTPS; never expose the main API directly to the public internet.
- Encrypt offline queues at rest; bound size, TTL, sequence and payload.
- Revalidate device, permission, age and approval when changes reach the hub.
- Detect memory conflicts; no silent last-writer-wins.
- Hold offline commands for owner decision; never auto-run on reconnect.
- Peer envelopes must be signed, recipient-bound, expiring and replay-protected.

### 2.8 Plugins, developer tools and integrations
- Plugins are data-only manifests; no executable plugin code or shell.
- Install disabled with no grants; grant only allowlisted permissions and revalidate manifests.
- Version workflows; every state-changing step uses normal policy/approval.
- AI workflow drafts are advisory and cannot run before validation and owner approval.
- Developer repository connections are explicitly scoped; secrets, runtime state and protected paths are never read or sent to a model.
- Code suggestions remain drafts; apply/commit/push require separate scope and approval.
- External communications use supported official APIs or explicitly enabled platform capabilities with risk-appropriate approval and outcome verification.
- Long-term integrations are not claimed implemented without evidence.

### 2.9 Website AI gateway
- Optional separate OpenAI-compatible text gateway for owner-controlled sites.
- Per-site keys, hash-at-rest, one-time reveal, revocation/rotation and rate/output limits.
- No tools, planner, memory, device control or owner endpoints through the gateway.
- Gateway off unless configured; primary JARVIS API remains loopback-only.

### 2.10 Release utilities
- Generate build provenance and SHA-256 artifact inventories.
- Verify manifest, archive and extracted inventory.
- Authenticate release policy using independently trusted digest or approved Ed25519 signature.
- Offline Linux/AIX snapshot and compatibility tools are read-only except requested outputs.
- Nexus publication remains disabled pending explicit approval and validated repository contract.

## 3. Non-functional requirements

| Area | Requirement |
|---|---|
| Security | Default deny, least privilege, cryptographic device identity, scoped approvals, fail-closed audit |
| Privacy | Local-first, minimum context, explicit cloud opt-in, no prompt/transcript logging by default |
| Reliability | Bounded timeout/retry/queues, atomic writes, crash recovery and truthful uncertainty |
| Performance | Resource-aware operation, bounded context/output and measurable latency/CPU/RAM |
| Maintainability | Modular boundaries, typed contracts, dependency injection, focused tests |
| Portability | Shared contracts with native capability-based adapters |
| Accessibility | Keyboard-operable controls, visible state and understandable errors |
| Observability | Structured redacted metadata without sensitive payloads |
| Cost | No paid dependency by default |
| Supply chain | Locked dependencies, provenance, checksums, signing and protected credentials |

## 4. Delivery domains

1. Security, identity, sessions and approvals.
2. Voice interaction and HUD.
3. Desktop application discovery/control.
4. Multi-step execution, concurrency and recovery.
5. Android companion and cross-device control.
6. Memory, privacy and personalization.
7. AI providers, agents, prompts, integrations and automation.
8. Build provenance, artifact integrity and compatibility.
9. Website AI gateway.
10. Owner panels, plugin/workflow management and visual composition.
11. Jenkins build-to-manifest provenance handoff.
12. Nexus artifact publication/retrieval contract (design only until approved).
13. Concurrent workflow branch execution and deadlock safety.

These are outcome groups, not claims that all capabilities are implemented.

## 5. Acceptance and evidence

Use these statuses precisely:
- **IMPLEMENTED — NEEDS TESTING:** source exists; no pass implied.
- **TEST-AUTHORED:** test exists but may not have run.
- **TEST PASSED (exact SHA):** relevant tests executed successfully on the stated commit.
- **DEVICE VERIFIED:** named physical device, OS/version and scenario passed.
- **OWNER ACCEPTANCE PENDING:** owner-only or physical acceptance remains.
- **BLOCKED:** external dependency prevents validation.
- **ACCEPTED:** all applicable implementation, automated, security, device and operational gates passed.

A release candidate requires exact-head build/type/lint/tests; route and authorization review; dependency/security/secret scans; crash, persistence, cancellation, concurrency and recovery tests; target Windows acceptance; Android build/install/two-phone acceptance where applicable; provenance/SBOM/artifact integrity; compatibility limits and owner approval.

Never infer a pass from source presence, authored tests, historical runs or a successful build alone.

## Acceptance status and evidence rules

Project status uses the canonical lifecycle vocabulary in [Project Status](PROJECT_STATUS.md): **PLANNED, NOT STARTED, IN DEVELOPMENT, IMPLEMENTED, NEEDS TESTING, TEST FAILED, TEST PASSED, CI VERIFIED, DEVICE VERIFIED, OWNER ACCEPTANCE PENDING, ACCEPTED**. Requirements are not considered accepted because a module or test file exists. Automated acceptance must identify the exact SHA and command/job; device acceptance must identify the physical device, OS and scenario; owner-only decisions require explicit approval.

PRs #63/#64 (Live DAG hardening and integration) are merged into `new`. Local automated verification passes (see [Project Status](PROJECT_STATUS.md)); CI on the pushed head, device acceptance and owner acceptance are still required before any requirement is ACCEPTED. New requirement coverage: owner-reconciled DAG resume, duplicate-transcript suppression with wake counters, integrity-protected backup/restore, SBOM-vs-lockfile verification, supported-app contracts. See [Gap Analysis](GAP_ANALYSIS.md).

## PDF, DOCX and OCR requirements

- Signed device-scoped binary ingestion accepts PDF and DOCX up to 15 MB; extracted text is capped at 1 million characters.
- DOCX extraction is in-process and reads the main document text, including paragraphs, tables, tabs and line breaks.
- PDF text extraction requires Poppler (`pdftotext`). Scanned-page OCR is opt-in and additionally requires Poppler (`pdftoppm`) and local Tesseract.
- PDF extraction is limited to 30 pages; OCR is limited to 20 pages with a 1600-pixel maximum raster dimension and a 3-minute OCR budget. OCR language is currently English.
- OCR is never silently enabled. Missing local tools produce an explicit error; no cloud OCR fallback exists.
