# JARVIS — Epic Register and Delivery Plan

**Updated:** 2026-11-05  
**Planning branch:** `new`  
**Latest code checkpoint:** `0849597cd569ad288132ca66d1e6183e37eb02ac` (documentation refresh baseline)  
**Overall:** Existing epics remain open until their acceptance gates are met.

This register organizes the epics already present in `POC2.md`; it does not introduce unrelated feature streams. Source code and authored tests are implementation evidence only. See [POC.md](../POC.md) for the implemented baseline, [POC2.md](../POC2.md) for the detailed work-left checklist, and [USER_STORIES.md](USER_STORIES.md) for story-level acceptance criteria.

## Delivery principles

- Local-first, free-only/zero ongoing cost as the default; cloud services are opt-in and task-scoped.
- Windows laptop is the primary execution device; the two Android phones are companion/approval devices.
- Security invariants are non-negotiable: default-deny policy, scoped single-use approvals, audit integrity, no admin elevation, no unrestricted shell, and no financial/payment automation.
- Never auto-replay an uncertain state-changing action.
- No capability is accepted without evidence from the relevant environment.
- Development work is prioritized; testing and device acceptance remain mandatory gates, not optional follow-up.
- No PR unless explicitly requested. If requested, non-main branches target `dev`; `main` is never automated.

## Epic summary

| ID | Epic | Priority | Current disposition | Primary outcome |
|---|---|---:|---|---|
| JARVIS-E01 | Security, Identity & Approval Foundation | P0 | In progress — acceptance open | Every action is authenticated, authorized, auditable and safely revocable |
| JARVIS-E02 | Voice Interaction & Cinematic HUD | P1 / active | In progress — lifecycle hardening implemented; tests/device validation open | Reliable local wake, consented capture, clear HUD and verified speech output |
| JARVIS-E03 | Windows Desktop Control | P1 | In progress — real-app acceptance open | Safe, bounded control of supported Windows applications |
| JARVIS-E04 | Multi-Step Execution & Recovery | P1 | In progress — lifecycle/fault acceptance open | Durable workflows that stop safely and recover through human review |
| JARVIS-E05 | Android Companion & Cross-Device Control | P1 | In progress — both-phone acceptance open | Two independently secured phones can approve/control permitted laptop tasks |
| JARVIS-E06 | Memory, Privacy & Personalization | P1 | In progress — lifecycle acceptance open | Private, useful, permission-aware memory with retention and deletion |
| JARVIS-E07 | AI, Integrations & Productivity Automation | P1 / P2 | In progress — prompt contracts, advisory agents and conversation continuity implemented; validation and provider/context gaps open | Useful local/cloud AI and existing integrations without policy bypass |
| JARVIS-G01 | Release, Compatibility & Resource Acceptance | Cross-cutting gate | Open | Exact-head software, security, device and resource evidence |

---

## JARVIS-E01 — Security, Identity & Approval Foundation

**Priority:** P0  
**Goal:** Ensure that no operation can execute unless the requesting device, session, user permission, task, parameters and approval are valid.

**Existing implementation areas:** device identity/session code, Ed25519 request signing, replay protection, policy gateway, approval lifecycle, audit chain, revocation and redaction.

**Remaining outcomes**
- Complete route-to-adapter policy coverage and adversarial review.
- Prove approval binding, single-use behavior, expiry, concurrency and stale-state rejection.
- Prove fail-closed behavior for audit/security persistence failures.
- Complete owner recovery for authenticator/device-management loss.
- Keep financial/payment apps, credentials, admin elevation and arbitrary shell excluded.

**Exit gate:** exact-head security suite passes; independent route/permission matrix and fault-injection evidence are recorded; no policy bypass or secret disclosure remains open.

## JARVIS-E02 — Voice Interaction & Cinematic HUD

**Priority:** P1 — active development priority  
**Goal:** Deliver a dependable “Hey Jarvis” experience while making microphone, speech-provider, execution and result states visible and controllable.

**Existing implementation areas:** HUD, push-to-talk, transcript review, local wake runtime setup/integration, optional local STT/TTS adapters, consent, cancellation and recognizer lifecycle hardening.

**Development progress — 2026-11-05:** VoiceManager lifecycle hardening and HUD consent-revocation guards have been added on `new`, with focused regression tests. Tests are not yet executed; target-device acceptance remains open.

**Remaining outcomes**
- Install and verify the local wake engine/model on the MSI.
- Validate wake accuracy, false triggers, resource use, sleep/resume and microphone lifecycle.
- Validate explicit browser speech consent and document any browser/vendor processing.
- Validate push-to-talk review-before-submit and consented post-wake capture.
- Verify Piper playback/local STT, interruption, timeout and error recovery.
- Validate accessibility, responsive layout and clear listening/privacy indicators.

**Exit gate:** target-MSI evidence covers wake → acknowledgement → consented capture → authenticated request → policy decision → outcome; speech privacy boundaries are documented; exact-head software checks pass.

## JARVIS-E03 — Windows Desktop Control

**Priority:** P1  
**Goal:** Control supported Windows applications safely without pretending to be universal remote-desktop software.

**Existing implementation areas:** allowlisted app launch, foreground-window adapters, UI Automation, clipboard, hotkeys, zoom and system information.

**Remaining outcomes**
- Verify target process/window identity before interaction.
- Stop on focus change, ambiguous target, inaccessible control or unexpected window.
- Test supported actions in real applications and independently verify saved outcomes.
- Document unsupported/custom-rendered controls and application coverage.
- Strengthen financial/credential protection without relying solely on window-title heuristics.

**Exit gate:** supported app matrix has real Windows evidence; ambiguous or unverified outcomes remain partial; policy restrictions remain intact.

## JARVIS-E04 — Multi-Step Execution & Recovery

**Priority:** P1  
**Goal:** Make multi-step work durable and recoverable without unsafe retries or replay.

**Existing implementation areas:** planner, scheduler, encrypted task journal, lifecycle checkpoints, recovery states, reconciliation endpoint and companion review panel.

**Remaining outcomes**
- Audit every lifecycle transition and ensure checkpoint-before-side-effect ordering.
- Fault-inject audit/journal failures, crash, cancellation, revocation and concurrency.
- Exercise partial external effects and unknown outcomes.
- Verify reconciliation permissions, encrypted notes, audit trail and terminal dispositions.
- Prove no dependent step runs after uncertain or failed persistence.

**Exit gate:** restart/fault-injection tests pass; all uncertain tasks require explicit review; no automatic replay occurs.

## JARVIS-E05 — Android Companion & Cross-Device Control

**Priority:** P1  
**Goal:** Use two Android phones as separately trusted companion devices for notifications, approvals and explicitly permitted laptop actions.

**Existing implementation areas:** native Android app source, Android Keystore support, signed API client, companion identity/protocol and command queue.

**Remaining outcomes**
- Build/install on both physical phones.
- Independently enroll each phone and prove separate keys, identity, session and permissions.
- Validate signed transport, replay defense, expiry, owner approval, cancellation and revocation.
- Verify revoking one phone does not disable the other.
- Validate offline/reconnect behavior and stale-command rejection.

**Exit gate:** both phones pass independent enrollment, authorization, command, revocation and recovery scenarios. Native iOS remains future scope.

## JARVIS-E06 — Memory, Privacy & Personalization

**Priority:** P1  
**Goal:** Provide private, useful memory with clear owner control and predictable lifecycle behavior.

**Existing implementation areas:** encrypted local memory store, category/TTL controls, integrity checks and companion review controls.

**Remaining outcomes**
- Complete signed/policy-gated create/read/update/delete behavior.
- Validate encryption, integrity, retention, export/backup and credential rejection.
- Add/verify bounded semantic retrieval and permission-aware context.
- Resolve laptop/phone synchronization conflicts.
- Verify deletion across primary data, indexes, caches, exports and backups.
- Ensure cloud AI receives only task-authorized context.

**Exit gate:** lifecycle, privacy, retention, recovery and deletion tests pass; cross-device behavior is documented and accepted.

## JARVIS-E07 — AI, Integrations & Productivity Automation

**Priority:** P1 / P2  
**Goal:** Provide useful conversational/planning intelligence and complete only the integrations already represented in project scope.

**Existing implementation areas:** authenticated conversation route, configurable OpenAI-compatible endpoint, deterministic planner, schedules, notifications, memory UI and official-store handoff.

**Remaining outcomes**
- Verify local endpoint defaults, unavailable behavior and safe fallback.
- Treat model output as untrusted; enforce schema validation and policy checks.
- Keep cloud providers opt-in, task-scoped and secret-safe.
- Complete existing schedule/notification/productivity workflows and persistence.
- Clearly document unsupported communication and third-party integrations.
- No silent app installation, financial actions or communication sending without explicit authorization.

**Exit gate:** each supported workflow has end-to-end evidence and each unsupported integration has an explicit boundary.

## JARVIS-G01 — Release, Compatibility & Resource Acceptance

**Type:** cross-cutting release gate, not a new feature epic  
**Goal:** Establish evidence that the integrated product is safe, stable and appropriate for the actual laptop and phones.

**Required checks**
- Exact-head Node build, TypeScript check, unit/integration suite and browser security smoke.
- Python utility tests and Android Gradle build where applicable.
- Dependency/security audit with recorded output.
- Windows/browser/Android compatibility and unsupported-platform behavior.
- CPU, RAM, disk, network and battery/resource measurements.
- Accessibility, keyboard-only and responsive UI checks.
- Reconciled README, POC, POC2 and cross-device status.
- No release-ready claim until hardware gates pass.

---

## JARVIS-E07 implementation update — AI agent and prompt orchestration (2026-11-05)

**Status:** IMPLEMENTED IN PART / VALIDATION NOT RUN

The existing E07 scope now includes a more complete AI-agent foundation on branch `new`:
- Versioned prompt registry with role-separated system, developer and user messages.
- Strict response schemas and local validation for conversational, task-planning, tool-selection and summarization agents.
- Advisory-agent orchestration that does not execute tools or desktop actions directly.
- Local-first OpenAI-compatible model adapter; remote model use remains explicitly gated by configuration.
- Bounded, authenticated, device-isolated conversation sessions with ordered request handling and safe history trimming.
- Capability-catalogue validation for tool candidates and dependency-graph validation for task plans.

**Remaining work:** provider compatibility/error handling, prompt-injection review across every profile, authoritative server-side capability metadata enrichment, plan consistency/risk annotations, conversation retention/deletion and multi-tab/restart/revocation lifecycle review.

**Guardrail:** AI output remains untrusted advisory data. It cannot authorize or execute state-changing actions; the existing planner and policy gateway remain mandatory. No tests, build, lint, CI or device validation were run under the current pause instruction.

## Recommended execution order

1. E02 Voice/HUD — continue the active development priority and close the MSI acceptance gaps.
2. E01 Security/Identity — run focused software hardening and adversarial review without weakening invariants.
3. E03 Windows Desktop — complete target binding and real-app verification.
4. E04 Workflow Recovery — complete lifecycle/fault coverage and human-reviewed recovery.
5. E05 Android — finish native software/build gaps, then test both phones.
6. E06 Memory/Privacy — complete lifecycle, retention, deletion and cross-device behavior.
7. E07 AI/Integrations — close existing workflows and document unsupported services.
8. G01 Release gate — exact-head CI, device matrix, resource measurements and final audit.

The order may be adjusted when a security blocker or dependency requires it. Do not start unrelated feature work while existing epic exit gates remain open.

## Epic status updates

Update the summary table and the relevant exit gate whenever implementation evidence changes. For every status change, include:
- Branch and exact commit SHA.
- Files/modules changed.
- Tests authored and tests actually executed (separate fields).
- CI run URL and exact commit, if available.
- Device/environment evidence, if applicable.
- Remaining blockers and owner action.

## E02 implementation note — bounded transcription recovery

The voice manager now has an independent transcription timeout and stale-callback guard. See JARVIS-US-034. Implementation and regression tests are present on `new`; execution, exact-head CI and target-MSI verification are still pending.

## E02 implementation note — voice-to-app session feedback

The HUD now visibly and audibly explains when a voice directive cannot be submitted because no authenticated device session is restored. The request is explicitly marked as not sent and the pipeline shows the session gate as failed. Regression assertions were added. This is not end-to-end voice-to-app completion: command capture, signed request, approval and Windows launch still require exact-head automated and MSI acceptance evidence.


## E02 implementation note — natural-language app launch normalization

Planner now strips trailing punctuation and common polite suffixes before resolving explicit app-launch requests. Regression cases cover `Open Notepad.`, `Hey Jarvis, open Calculator please.` and `Run Paint for me`. Implementation and test source are on `new`; tests have not been executed and MSI acceptance remains open.

## E03/E02 implementation note — existing app window reuse

The Windows app launcher now detects a unique existing allowlisted window and requests verified foreground focus before attempting a new process spawn. This addresses singleton/reused-process behavior that could otherwise produce a launch acknowledgement without a newly observed PID. Multiple matches are not arbitrarily selected; failed focus is not reported as success. Regression tests were added but remain unexecuted pending CI and MSI validation.



## E01/E02 implementation note — approval card single-use handling

The HUD approval flow now guards each approval ID against concurrent resolution requests, disables both card actions while the signed request is in flight, and restores controls only when the request settles and the card remains present. Verified terminal outcomes remove the card; non-terminal/unknown outcomes remain visible and are labelled as not complete. Communication ambiguity is never described as success and instructs the operator to refresh task status before retrying. This is implementation-only; tests and device acceptance were not run.


## E01/E03 implementation note — task history and recovery review surfaced in HUD

The companion HUD now consumes the authenticated task-list endpoint and renders recent task state, operation, origin, timestamps, and expandable step summaries. It refreshes after directive/approval activity, periodically, and on demand. Tasks in `AWAITING_RECOVERY` or `INTERRUPTED` expose the existing signed manual reconciliation endpoint with the three supported dispositions and required observation note. The UI explicitly states that reconciliation does not replay or resume an action; server-side ownership, journal and validation checks remain authoritative. Implementation only; no tests or device validation were run.


## E01/E04 implementation note — task detail and recovery transition clarity

Task history cards now include an expandable detail view with safe task metadata and step summaries, excluding raw parameters and result payloads. Manual reconciliation is guarded against duplicate in-flight submissions per task. Successful responses distinguish the chosen disposition from the server-returned state, with explicit language that an observed effect is not independently verified completion and no action is retried/resumed/replayed. Validation remains pending by instruction.


## E01/E04 implementation note — explicit stop and workflow interruption boundary

The companion task history now exposes authenticated stop controls for executing workflows and cancellation for pending/approval tasks. Duplicate stop requests are suppressed per task. The core treats interruption as a hard workflow boundary: the current step remains uncertain, dependent steps are recorded as skipped, and execution returns without evaluating another step. UI copy does not imply rollback or absence of external effects. Implementation only; validation remains open.


## E01/E04 implementation note — asynchronous workflow transition guards

The core now rechecks task state when policy evaluation resumes after asynchronous planning/approval boundaries. A task cancelled while planning is pending cannot continue when the planner returns. Approval expiry is terminal for that request: the task is marked EXPIRED, dependent steps are skipped, and the handler returns without evaluating the operation. Successful approval is checkpointed as APPROVED before policy evaluation can reach an adapter; checkpoint failure blocks execution and invalidates the approval where possible. No tests, build, lint, CI, or device validation were run.

## JARVIS-E08 — Shared DevOps Pipeline, Provenance & Artifact Integrity

**Status:** IN PROGRESS — source implementation present; validation paused; Nexus publishing paused.

**Goal:** Produce traceable, verifiable build artifacts consistently through GitHub Actions and Jenkins, and provide a safe customer-package verification path.

**Implemented source scope**
- Build provenance manifest with project/CI/source identity and deterministic release identity.
- SHA-256 manifest/checksum verification and customer-package verification policy.
- CycloneDX dependency SBOM generation and artifact packaging.
- Jenkins and GitHub Actions signing/checksum integration foundations, scoped credentials, temporary-key cleanup, and fail-fast command handling.

**Remaining development scope**
- Harden manifest header and file-inventory schema validation before checksum verification.
- Compare manifest inventory with actual archive members before claiming package-content integrity.
- Complete actionable customer verification reports and failure-stage classification.
- Keep provenance fields consistent across manifest, checksum, signature and CI context.
- Document non-secret Jenkins/GitHub configuration and release/rollback operations.

**Exit criteria**
- Malformed or inconsistent manifest inventories are rejected before checksum acceptance.
- Archive members match the declared inventory and every file's size/hash is verified.
- Customer verification checks policy, manifest and package in the documented order and emits an actionable report.
- Exact-head GitHub Actions and Jenkins runs produce verifiable artifacts, signatures, checksums and SBOM evidence.
- Nexus remains disabled unless separately approved; production merge/deployment requires explicit owner approval.
- Source code alone does not constitute acceptance; validation evidence is required when testing resumes.

### E08 implementation note — provenance and signing foundations (2026-11-05)

The shared artifact-integrity implementation validates explicit project identity, recognized CI provider, source commit/build metadata and current-environment consistency. Customer verification binds the authenticated policy to the manifest release identity. Pipeline definitions include SBOM, checksum/signing foundations and scoped temporary signing-key handling. Exact-head pipeline and package acceptance remain outstanding; testing is paused.
