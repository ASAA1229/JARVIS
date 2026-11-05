# JARVIS POC2 — Remaining Gaps, Blockers, and Acceptance Plan

**Status snapshot:** 2026-11-05  
**Branch reviewed:** `new`  
**Latest code checkpoint:** `0849597cd569ad288132ca66d1e6183e37eb02ac`  
**Overall status:** **IN PROGRESS — NOT RELEASE-READY**

> This file is the actionable gap register. The epics and delivery sequence are in [docs/EPICS.md](docs/EPICS.md), and implementable user stories with acceptance criteria are in [docs/USER_STORIES.md](docs/USER_STORIES.md). Existing epics are being closed before introducing unrelated feature streams.

## Current work-left summary

1. Close the **Voice Interaction & Cinematic HUD** epic with target-MSI wake, capture, consent, TTS/STT, resource and browser acceptance.
2. Complete the **Security, Identity & Approval** adversarial/lifecycle review and prove exact-head tests.
3. Close **Windows Desktop Control** through real target-process binding, safe foreground interaction, and independently verified application outcomes.
4. Complete **Advanced Multi-Step Execution & Recovery** fault injection, crash/restart and partial-side-effect reconciliation.
5. Finish **Android Companion & Cross-Device Control** software/build work, then independently enroll and revoke both physical phones.
6. Complete **Memory, Privacy & Personalization** lifecycle, retrieval, retention, deletion and cross-device behavior.
7. Complete the **AI Agent & Prompt Orchestration** implementation gaps within the existing E07 scope: provider resilience, richer context governance, agent routing coverage, and response-quality acceptance.
8. Finish existing **AI, Integrations & Productivity Automation** boundaries and end-to-end workflows already represented in the repository.
9. Run exact-head build, typecheck, unit/integration tests, browser smoke, Android build and target-device acceptance; reconcile all project documentation.

## Evidence rules

- `IMPLEMENTED`: relevant source exists; does not imply tested or accepted.
- `TEST-AUTHORED`: regression coverage exists; does not imply it has executed.
- `CI-VERIFIED`: completed CI run for the exact commit is green.
- `DEVICE-VERIFIED`: the named real target device and scenario passed with recorded evidence.
- `ACCEPTED`: all applicable implementation, test, CI, device and security gates passed.
- `BLOCKED`: an external dependency prevents progress; record owner/action and evidence.
- Do not convert a status based on assumption. Record commit SHA, environment, command/run, expected/actual result and limitation.

## Immediate branch and validation checkpoint

- The `new` branch includes voice lifecycle and consent-revocation changes through `fa7131c2bf3f77c0d8ef245969567d6dbfe723e9`.
- `src/voice/voiceManager.ts` was hardened and `test/voice_manager.test.ts` was added.
- Focused voice-manager tests are authored but have **not yet been executed**.
- The CI workflow is manual-dispatch / PR-to-dev; no exact-head CI run is available from the surfaced Actions history.
- No physical-device acceptance is implied.

## Prioritized remaining-work register

### P0 — Security, identity and approval foundation

- [ ] Re-run the complete security/build/test suite on the exact current `new` head.
- [ ] Audit every state-changing route and adapter path to prove there is no policy-gateway bypass.
- [ ] Exercise approval approve/reject/expiry, duplicate and concurrent resolution, stale task state, replay, parameter/task/device binding and persistence failure.
- [ ] Verify session expiry, immediate revocation, independent device identity/permissions and fail-closed security-state handling.
- [ ] Complete route-by-route authorization and error/secret-redaction review plus adversarial tests.
- [ ] Define and test owner recovery for TOTP/authenticator loss, device-management loss and owner-token rotation.
- [ ] Verify audit-chain tampering, audit-write failure and recovery behavior.
- [ ] Preserve hard restrictions: financial/payment apps, credential entry, unrestricted shell, admin elevation, security bypass and voice-only high-risk authorization.

### P1 — Voice Interaction & Cinematic HUD (active development priority)

**Development progress — 2026-11-05:** VoiceManager now rejects overlapping capture/review sessions, guards timeout callbacks with a capture generation, cancels and clears transcripts on mute, bounds transcript input to 1,200 characters, separates microphone capture from transcription, and exposes explicit transcription completion. The active HUD also cancels capture/discards the transcript on consent revocation and rechecks consent before a post-wake command can be dispatched. Focused tests cover duplicate starts, review preservation, timeout, cancellation, mute, late callbacks, invalid duration and HUD consent guards. Tests are authored only; execution is pending.

- [ ] Run the local wake-word setup on the target MSI; record runtime/model versions and integrity checks.
- [ ] Verify microphone permissions, wake accuracy, false positives/negatives, startup/restart, mute, stop, hidden-tab, sleep/resume and cancellation.
- [ ] Measure CPU, RAM, latency and battery/resource impact during standby and active capture.
- [ ] Validate wake → acknowledgement → separately consented speech capture → authenticated request → policy decision → execution/result end-to-end.
- [ ] Verify push-to-talk transcript review and explicit submit; test no-speech, timeout, duplicate callbacks, late results, network/microphone errors and cancellation.
- [ ] Verify the exact acknowledgement: `Hi sir, I am ready to work.`
- [ ] Install/configure local Piper TTS and optional local STT; verify audible playback/recognition and interruption on the MSI.
- [ ] Document browser/vendor speech processing. Do not claim local-only speech unless all audio processing is proven local.
- [ ] Verify HUD accessibility, keyboard operation, responsive layout, visible mic/listening state and privacy controls.
- [ ] Run browser smoke and focused tests on exact head when CI runners are available.

### P1 — Windows Desktop Control

- [ ] Verify allowlisted Notepad/Calculator/Paint launch via the authenticated real request path on Windows 11.
- [ ] Prove target process/window identity before typing or invoking controls; abort if focus changes or target is ambiguous.
- [ ] Test UI Automation discovery and unique selector enforcement across standard and custom-rendered applications.
- [ ] Verify clipboard read/write, paste, hotkeys, zoom, click, set-value, cancellation and timeout behavior in real applications.
- [ ] Independently verify saved/accepted outcomes; keep acknowledgements partial when evidence is absent.
- [ ] Exercise inaccessible controls, unexpected windows, app crash, user focus changes and interrupted execution.
- [ ] Validate payment/credential protection beyond process/title heuristics; retain explicit exclusions.
- [ ] Document the supported application matrix and unsupported control types.

### P1 — Advanced Multi-Step Execution & Recovery

- [ ] Audit every task lifecycle transition and ensure durable journal writes precede dependent side effects.
- [ ] Fault-inject journal write, audit write, process crash, cancellation, revocation and concurrent approval failures.
- [ ] Test restart recovery for every non-terminal state; clear stale approvals and never replay automatically.
- [ ] Exercise partial external side effects and prove that unknown outcomes remain `AWAITING_RECOVERY`.
- [ ] Verify reconciliation dispositions: confirmed no effect, effect observed (partial only), and still unknown.
- [ ] Verify recovery UI/API permissions, encrypted notes, redaction and audit evidence.
- [ ] Confirm no dependent step runs after a failed checkpoint or uncertain result.
- [ ] Keep automatic resume/retry disabled for non-idempotent or uncertain actions.

### P1 — Android Companion & Cross-Device Control

- [ ] Build and install the native Android app on both actual phones.
- [ ] Enroll each phone independently; prove unique Android Keystore-backed keys, device identity, sessions and permission scopes.
- [ ] Verify signed transport, nonce/replay protection, expiry, owner approval, cancellation and immediate revocation.
- [ ] Revoke phone A and prove phone B remains independently authorized; prove revoked A cannot reconnect or replay queued commands.
- [ ] Test laptop offline/asleep/restart and phone network changes; reject stale state-changing commands on reconnect.
- [ ] Validate queue TTL, bounded payloads, duplicate completion, acknowledgement and failure recovery.
- [ ] Verify companion approval notifications and deep links without granting the phone broader authority.
- [ ] Record Android OS/device versions, app build, test evidence and limitations. iOS remains future scope.

### P1 — Memory, Privacy & Personalization

- [ ] Complete memory create/read/update/delete lifecycle through signed, policy-gated APIs.
- [ ] Verify encryption, integrity, category restrictions, TTL/retention and credential/payment-data rejection.
- [ ] Implement/verify semantic retrieval with bounded context and permission-aware access.
- [ ] Define conflict resolution and synchronization between laptop and both phones.
- [ ] Verify deletion from primary storage, indexes, caches, exports and backups; document any retention boundary.
- [ ] Test memory export/backup and restore without exposing keys or plaintext secrets.
- [ ] Ensure cloud AI receives only task-authorized context and never receives continuous microphone audio.

### P1/P2 — AI, Integrations & Productivity Automation

- [ ] Verify local AI endpoint configuration, timeout/unavailable behavior and deterministic fallback.
- [ ] Ensure model output is treated as untrusted advisory data and cannot bypass planner schema validation or policy checks.
- [ ] Add explicit opt-in for each cloud provider/use; verify key handling via environment only and no committed secrets.
- [ ] Complete only the integrations already in repository scope; document unsupported APIs and required user permissions.
- [ ] Verify existing schedule creation/list/cancel, notifications and recurring-task persistence/restart behavior.
- [ ] Test task cancellation, retries, idempotency and safe failure across existing workflows.
- [ ] Keep financial/payment actions excluded and do not silently install apps or send communications.

### P1/P2 — AI agent, prompt contracts and conversation orchestration (implementation expanded; validation paused)

**Implemented on `new` at checkpoint `0849597cd569ad288132ca66d1e6183e37eb02ac`:**
- Versioned prompt registry and role-separated system, developer and user prompt construction.
- Strict structured response contracts and local validation for conversational, task-planning, tool-selection and summarization profiles.
- Advisory-agent routing separated from state-changing execution; action requests remain subject to the existing planner and policy gateway.
- Local-first OpenAI-compatible agent adapter; remote endpoints remain blocked unless explicitly enabled by configuration.
- Bounded conversation history tied to authenticated device sessions; only visible user/assistant turns are retained.
- Per-conversation serialization, bounded session count/expiry, LRU eviction, complete-turn trimming, and authenticated conversation clearing.
- Model-unavailable fallback responses are not persisted as conversational history.
- Tool candidates are validated against the live capability catalogue; restricted or unknown capability IDs are rejected.
- Task-plan dependency graphs reject missing, duplicate, self-referential and cyclic dependencies.

**Remaining development / acceptance work:**
- [ ] Review every prompt profile for injection boundaries, untrusted retrieved context, output minimization and explicit refusal behavior.
- [ ] Improve provider compatibility and error classification without silently enabling remote inference or paid services.
- [ ] Define deterministic routing coverage for mixed informational, planning, tool-selection and execution-intent requests.
- [ ] Enrich tool-candidate results server-side from authoritative capability metadata; never trust model-supplied risk or approval metadata.
- [ ] Tighten plan consistency rules (status/step consistency, bounded plan size, dependency ordering and risk/approval annotations).
- [ ] Review conversation session lifecycle across HUD/companion reloads, concurrent tabs, device revocation and server restart.
- [ ] Define retention, export and deletion behavior for conversation history and ensure it remains separate from long-term personal memory.
- [ ] Keep model responses advisory only; all state-changing operations must pass the policy gateway.
- [ ] After testing is explicitly resumed, run schema, routing, prompt-injection, concurrency and provider-failure tests on the exact branch head.

**Current status:** implementation expanded; tests/build/lint/CI and device validation were not run because testing is paused. No agent capability is marked accepted.

### P2 — Release, compatibility and resource acceptance

- [ ] Run exact-head Node build, TypeScript check, complete automated suite and browser security smoke.
- [ ] Run Python utility tests and Android Gradle build where applicable.
- [ ] Run dependency/security audit and record findings; do not claim zero vulnerabilities without output.
- [ ] Validate supported Windows/browser/Android versions and graceful unsupported-platform behavior.
- [ ] Measure idle/active CPU, memory, disk, network and battery impact against the balanced-resource target.
- [ ] Complete accessibility, keyboard-only, screen-size and error-state checks.
- [ ] Produce final evidence-based audit; update README, POC, POC2 and cross-device status together.
- [ ] Keep `main` untouched; integration remains PR-only to `dev`.

## Scope and sequencing rules

1. Finish the existing epics before opening unrelated feature streams.
2. Prioritize software-testable implementation and development work first; retain tests and acceptance criteria as mandatory gates, but do not describe unexecuted tests as passing.
3. Physical-device steps are explicit owner acceptance tasks and cannot be substituted with hosted CI.
4. No new cloud spend or paid dependency is assumed. Local-first and free-only operation remain project constraints.
5. Do not weaken security controls to make a demo pass.
6. No PR is created unless explicitly requested. If requested, non-main work targets `dev`; never automate a merge to `dev` or `main`.

---

## Historical gap and implementation log

The historical sections below are retained for traceability. Their status notes describe the state at the time they were written; use the 2026-11-05 register above for current prioritization.

## Existing Epic Closure Plan — 2026-10-30

**Scope freeze:** finish and accept only the epics/capabilities already started or recorded in this repository. Do not introduce a new epic, milestone, or unrelated feature stream until every existing epic has either passed its acceptance gate or has an explicitly documented external blocker with evidence. No PR is created without the owner's explicit request.

Complete these phases in order; phase numbers organize existing work and do not create new epics:

1. **Voice Interaction & Cinematic HUD (currently active):** local-only “Hey Jarvis” keyword spotting, explicit separate consent for browser/vendor speech recognition after wake, review-before-execute for push-to-talk, consent-gated post-wake command submission through the policy gateway, microphone lifecycle safeguards, local TTS configuration/output, browser regression coverage, and target MSI acceptance. Post-wake submission is not approval: the policy gateway may deny the directive or require the applicable approval.
2. **Advanced Multi-Step Execution & Recovery:** audit every task lifecycle transition into the encrypted journal; test restart recovery, expired/revoked/stale approvals, checkpoint write failures, partial side effects and idempotency; implement safe reconciliation/recovery UX. Never auto-replay uncertain state-changing operations.
3. **Security and approval foundation:** re-run exact-head tests for policy gateway, task/device/operation/parameter-bound approvals, replay protection, expiry/revocation, audit integrity, persistence failure, redaction, and owner recovery.
4. **Windows desktop agent:** close software-testable launch/focus/control/input/clipboard/zoom/verification gaps; document unsupported controls and keep actual MSI acceptance separate from hosted CI.
5. **Android and cross-device companion:** complete software-testable native identity/session/Keystore/revocation/queue behavior and Android build; perform independent enrollment/revocation and transport tests on both actual phones before enabling remote control.
6. **Existing memory, scheduler, and productivity workflows:** complete lifecycle, persistence, retrieval/review/deletion, cancellation and restart tests for capabilities already in the repository.
7. **Existing integrations and final acceptance audit:** verify each already-started communications/productivity integration, preserve explicit unsupported/restricted boundaries, run the full regression/security/Android build pipeline, and reconcile POC.md, POC2.md, README.md and CROSS_DEVICE_IMPLEMENTATION_STATUS.md.

**Acceptance rule:** each phase closes only with (a) implementation evidence, (b) passing exact-head CI for applicable build/tests, (c) target-device evidence where hardware is required, and (d) documentation aligned to the evidence. If hardware is unavailable in hosted CI, report the remaining user-side acceptance step precisely; do not mislabel it as passed or introduce new work to replace it.

## Confirmed repository/branch state

- PR #12 (new → dev feature integration) is merged: https://github.com/Guda-Abhishek/JARVIS/pull/12
- PR #13 (main documentation reconciliation) is merged: https://github.com/Guda-Abhishek/JARVIS/pull/13
- PR #14 (post-merge status and CI evidence refresh) is merged: https://github.com/Guda-Abhishek/JARVIS/pull/14
- dev is at d5fc9cc42e0476dcf24d85ea6d95815fb592497e. new contains the same tree as dev at the PR #14 merge, before the current follow-up checklist clarification.
- fix, test and enhancement were recreated from dev and fast-forwarded to the current integration commit. The same commit passed CI on dev, fix and test; enhancement points to the same commit.
- main remains at 5c7d8d303862de6ac730db9e15855b5f6a70af59 and has not been modified.
- CI success is not physical-device acceptance. npm audit is not confirmed by these runs.

## P0 — Security and execution foundation

- [ ] Re-run the complete security suite on the exact documentation-updated commit and confirm hosted CI is green.
- [ ] Verify every state-changing operation passes the default-deny policy gateway, with no alternate adapter or API path.
- [ ] Complete approval lifecycle API tests: approve/reject, expiry, duplicate/concurrent transitions, stale state, persistence failure, and exact task/device/operation/parameter binding.
- [x] Reject stale approval mutations: `rejectTask` now verifies the associated task exists and remains `AWAITING_APPROVAL` before resolving the approval; a regression test checks that a recovery-state task and its approval remain unchanged.
- [ ] Verify replay rejection, session expiry, immediate revocation, independent device identities/permissions, and fail-closed behavior when audit or security persistence fails.
- [ ] Complete route-by-route API/error-redaction review and independent adversarial security review.
- [ ] Define and test owner recovery for TOTP/device-management state before owner-token rotation or authenticator loss.
- [ ] Confirm deletion quarantine/recovery and verified deletion requirements before enabling broad file operations.
- [ ] Preserve strict blocks for financial/payment automation, credential entry, unrestricted shell execution, administrator elevation, security bypass, and voice-only high-risk authentication.

## P1 — Windows desktop agent

- [ ] On the target Windows 11 MSI laptop, verify visible Notepad launch through the real authenticated request path; record policy decision, process/window evidence, adapter output, audit event, and user-facing result.
- [ ] Test foreground-window identity, UI Automation discovery, exact unique control matching, text entry, clipboard copy/paste, hotkeys, zoom, cancellation, timeouts, and recovery in real applications.
- [ ] Distinguish action acknowledgement from destination acceptance or persistence; keep results partial/uncertain until independently verified.
- [ ] Test apps with inaccessible/custom-rendered controls and report unsupported capabilities rather than claiming universal control.
- [ ] Validate financial/payment protection beyond simple process/window-name heuristics; retain the owner policy exclusion.
- [ ] Test interruption and unexpected-window changes between planning and execution.
- [ ] Validate application discovery against installed applications and Start-menu entries; document coverage and failure cases.

## P1 — Voice and HUD

- [ ] Verify push-to-talk in current Windows browsers, including microphone permissions, transcript review, explicit submit, cancel/stop, timeout, no-speech, late results, duplicate prevention, and recovery.
- [ ] Verify the command phrase is preserved through authenticated request signing and policy evaluation.
- [ ] Test actual Piper TTS executable/model compatibility and audible playback on the target laptop; test browser speech-synthesis fallback.
- [ ] Document speech-recognition provider/network behavior. Do not claim local-only recognition unless demonstrated.
- [ ] Install and measure the opt-in local wake-word engine on the target MSI; verify the complete wake → consented command capture → policy-gateway decision path, visible microphone/listening status, privacy control, interruption and resource use before claiming accepted always-ready voice.
- [ ] Keep wake-word listening disabled by default; only enable it after the user opts in, and do not claim the flow is accepted until target-device acceptance is recorded.
- [ ] Verify compact HUD layouts, keyboard accessibility, error states and real-device browser behavior.

## P1 — Android companions and remote control

- [ ] Implement a native Android agent/companion; the current browser companion is not a substitute for native OS permissions or Android Keystore.
- [ ] Enroll both real phones independently and prove separate keys, identities, sessions, permission sets and approval authority.
- [ ] Verify secure authenticated remote transport, request signing, nonce replay protection, session expiry, owner approval, cancellation, and immediate revocation.
- [ ] Revoke one phone and prove it can no longer act while the other remains independently usable.
- [ ] Test behavior when the laptop is asleep, unreachable, or reconnects. Queue harmless informational tasks only; reject or revalidate state-changing work.
- [ ] Validate app launch, notifications, SMS/telephony capabilities and any accessibility-based automation against the actual Android versions and user-enabled permissions.
- [ ] Keep remote access disabled until secure transport and end-to-end authorization are proven.

### Android command-channel progress — 2026-11-05

- Implemented explicit command expiry visibility and bounded retention for the existing read-only Android app-inventory channel.
- Device revocation now cancels pending/claimed inventory commands involving that device (as requester or target), clears command results, and records an audit event.
- Added queue regression tests for expiry visibility, cancellation, and post-cancellation completion rejection.
- These changes do not close the Android epic: exact-head CI and two-physical-phone enrollment, revocation-isolation, HTTPS transport, and target-device acceptance are still required.

## P1 — Universal application and communications coverage

The target is capability-based discovery for all installed and built-in apps on Windows and both Android phones. This is a staged goal, not a claim that all apps expose automation interfaces.

- [ ] Add a truthful application/capability inventory and adapter status for each discovered app.
- [ ] Prefer official APIs/integrations; use controlled accessibility/UI automation only when permitted and safe.
- [ ] Implement and test email drafting, To/CC resolution, subject/body generation, read-aloud review, exact-draft approval, send, and verified delivery status.
- [ ] Implement calendar/meeting creation and recurring schedules with timezone handling, conflict detection, approval and result verification.
- [ ] Evaluate and implement supported WhatsApp, SMS, cellular-call, VoIP-call and Teams messaging/meeting paths. Document API and OS restrictions; provide a safe handoff where automation is unavailable.
- [ ] Implement Microsoft 365 and other application workflows incrementally, with per-capability acceptance tests.
- [ ] Preserve the requirement that consequential outbound communication is reviewed and explicitly approved before sending/placing when policy requires it; approval must bind the exact target and content.
- [ ] Never claim a message was sent, a call connected, or a meeting scheduled without confirmed evidence.
- [ ] Keep official-store workflows as user-confirmed handoffs unless a platform explicitly supports a compliant approved installation path.

## P1 — AI, privacy, memory and workflow orchestration

- [ ] Implement hybrid local/cloud model routing; model selection must not confer execution authority.
- [ ] Before cloud sharing of private data when required, disclose what data will be shared and why, minimize it, and obtain authorization. Verify provider/free-tier limits; zero ongoing cost is the target.
- [ ] Add user-facing memory review, correction, source/category visibility, contradiction detection, expiry and verified deletion.
- [ ] Verify retention/deletion across persisted data and backups; cross-device encrypted sync remains disabled by default until explicitly approved.
- [ ] Implement durable multi-step workflows with checkpoints, cancellation, idempotency, timeouts, state persistence and stop/reconcile recovery.
- [ ] Implement recurring/scheduled/conditional tasks with authorization rechecked at run time, expiry, notification, and safe behavior while the owner is unavailable.
- [ ] Preserve the user’s explicit email workflow: AI prepares subject/body from the user’s concept/context, reads the complete To/CC/subject/body/timing aloud, and sends only after the user says “approved”; any material edit invalidates the previous approval.
- [ ] Implement useful cross-app orchestration without unnecessary interruptions for permitted low-risk actions.

## P2 — Resource, accessibility and release validation

- [ ] Benchmark startup, idle CPU/RAM, wake-word latency, TTS latency, desktop action latency and sustained operation on the target MSI.
- [ ] Test keyboard accessibility, focus visibility, error recovery and companion usability on both phones.
- [ ] Run tests for laptop sleep/restart, process crash, network loss, corrupted state, audit-write failure, partial completion and uncertain outcomes.
- [ ] Run dependency/security review; npm audit is not considered passed until the registry endpoint returns a verified result.
- [ ] Produce acceptance evidence linking exact commit, test command/run, environment, expected result, actual result and any limitation.
- [ ] Reconcile legacy M8/M10/M11 labels with the now-authoritative gap-closure decisions before assigning implementation milestones; do not invent historical specifications.
- [ ] Revisit stale document links and legacy branch references during documentation review; preserve historical records rather than deleting them.

## Acceptance rules

1. Unit tests and hosted CI are necessary but insufficient for OS/device capabilities.
2. Every capability must declare its platform, required permission, risk tier, adapter, verification method, failure behavior, and status (implemented/partial/planned/restricted).
3. No operation may bypass the policy gateway. The model/planner never receives direct execution authority.
4. Unexpected state stops dependent steps. Retry or rollback only when safe; ask for approval for risky recovery.
5. The user must be able to cancel. The system must report partial/uncertain outcomes honestly.
6. Keep main untouched by automated work. Feature/documentation changes go to non-main branches; PRs target dev. The owner performs any eventual dev → main release merge manually.


## Conversational response and wake greeting follow-up — 2026-10-25

- [x] Add a bounded conversational response layer for identity, creator, owner-memory summaries, and a small set of common AI definitions.
- [x] Add an opt-in/configurable OpenAI-compatible chat-completions client with a local Ollama default and a 12-second timeout.
- [x] Route conversational answers separately from state-changing actions; action directives still enter the existing planner and PolicyGateway.
- [x] Add an explicit HUD response branch for conversational answers so JSON metadata is not displayed as the answer.
- [x] Change the wake response to the requested exact greeting: "Hii sir, I am ready to work."
- [ ] Run repository build, lint, unit tests, and browser smoke tests on this exact commit.
- [ ] Verify wake-word behavior, microphone privacy indicator, greeting playback, and follow-on command capture on the target Windows laptop.
- [ ] Verify a configured local model end-to-end. No foundation model is trained by this change; model inference is delegated to the configured endpoint.
- [ ] Add broader automated tests for the conversational router and response formatting.
- [ ] Implement semantic embeddings/vector retrieval in a later, separately tested stage; current memory context is bounded text retrieval, not embedding-based retrieval.

Acceptance note: browser-based wake recognition is not guaranteed to be local. Hands-free remains an explicit user-enabled feature. Do not describe the wake phrase as hardware-verified until a real-device test is recorded.


## Regression triage — 2026-10-26

- [x] Inspected hosted run [40216510796](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40216510796): TypeScript build PASS, typecheck PASS, tests 127 PASS / 3 FAIL, browser smoke skipped after test failure.
- [x] Corrected stale `/api/status` schema expectations in the lifecycle and security tests. The tests now assert the exact non-sensitive measured fields and health-check types.
- [x] Corrected the expired-approval test to expect `TaskState.EXPIRED`; an expired approval must not remain pending or execute.
- [x] Confirmed both remembered-approval tests passed in the failed run, including the boundary that remembered launch grants do not authorize text entry.
- [ ] Verify all checks on a completed hosted CI run for the corrected commit. Do not mark the POC release-ready until it passes.
- [ ] Run and record dependency audit; previous hosted results do not prove `npm audit` status.
- [ ] Complete physical Windows voice/UI and both Android-device acceptance; source and CI evidence alone are insufficient.


## P0 security regression tests added — 2026-10-26

Added regression coverage in `test/remembered_approval.test.ts` for three authorization invariants: an approval cannot be reused for changed parameters, cannot be replayed against another task, and can authorize only one execution. Added a tampered remembered-grant-state case to verify the gateway fails closed and does not report a remembered grant as successfully persisted.

**Status: code committed; tests not yet executed on the updated commit.** The prior CI result is not evidence for these newly added tests. The next gate is a fresh hosted run of build, typecheck, all tests, and browser smoke. Continue with explicit tests for concurrent approval resolution, wrong-device binding, approval expiry, audit-chain failure, and device/session revocation after this run is green.


### Approval lifecycle test expansion — 2026-10-26

Extended `test/remembered_approval.test.ts` to cover duplicate approve/reject resolution attempts, cross-device replay, and expiry (including a delayed resolution attempt). Together with the earlier tests, the new coverage exercises task/parameter binding, single-use consumption, corrupt persisted grant state, and fail-closed grant persistence. All are committed on `new`; **execution is pending** until the hosted workflow reports results for the updated head.


## Next security slice — session lifecycle hardening (2026-10-26)

- Added a hard session TTL boundary: session lifetimes must be integer seconds from 1 through 86,400; zero, negative, fractional, non-finite and over-one-day values are rejected.
- Session activation now fails closed if the `SESSION_CREATED` audit event cannot be durably recorded. The just-created session is deactivated and removed; the signed nonce remains consumed, which is safe and forces a fresh client request.
- Added `test/session_lifecycle_security.test.ts` covering invalid TTL values and an audit-write failure during session creation.

**Evidence status:** changes are committed on `new`, but no completed CI result has yet confirmed these tests. Do not call this slice verified until the build, typecheck, full suite, and browser smoke pass on the exact head.


## Companion notifications panel — 2026-10-26

- Added a Notifications & Alerts panel to the browser companion.
- The panel polls the existing authenticated `GET /api/notifications` endpoint using the device's signed request flow, displays a bounded recent list, and uses text-only DOM rendering for notification content.
- Added a browser smoke assertion that a completed read-only request appears in the authenticated notification feed.
- This UI addition does not establish native Android push notifications; it is a polling feed in the browser companion.
- Validation is pending for the exact latest head. Do not treat this as accepted until the complete CI workflow, including browser smoke, passes.


## Companion schedule management — 2026-10-27

- Added a schedule-management panel in the browser companion for one-time and recurring requests, schedule listing, and owner-scoped cancellation.
- Schedule creation, listing, and cancellation are submitted through the existing signed request path and therefore remain subject to the normal policy and approval gateway.
- Added planner support for a recurring request with a separate initial delay (for example, `schedule in 10 minutes then every 30 minutes to check system memory`) and unit tests for minute/hour parsing.
- Schedule listing is user-triggered rather than automatic on enrollment to avoid competing with the first owner request.
- Schedule persistence and execution remain governed by the existing scheduler: jobs are re-authorized at run time, missed one-shot jobs are not replayed, and schedules stop when the owner device is revoked.
- The companion is a polling/browser interface; this does not implement native Android push notifications or guarantee execution while the JARVIS service is stopped.

**Validation status:** implementation and test additions are committed on `new`; latest exact-head CI and browser smoke must pass before acceptance. Physical Windows and Android-device testing remain outstanding.


## Regression follow-up — 2026-10-27

- Reviewed hosted run [40364512541](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40364512541): build/typecheck passed, but tests exposed two follow-ups. The expired-session test was still creating a session with an invalid negative TTL after TTL validation was added; it now creates a valid one-second session and verifies expiry after waiting. The HTTP lifecycle test's deterministic OS-info request was being intercepted by the conversational fallback when no local model was configured; system-fact questions are now routed to the action planner.
- Added conversational-router regression tests for OS version, system memory, disk space, schedule listing, and delayed recurring schedule requests.
- Added schedule-planner tests for initial delay plus recurring interval in minutes/hours.
- A subsequent hosted run is required to verify these fixes together with the schedule UI and session-lifecycle tests. The previous run is not evidence that the current head passes.


### Conversational router follow-up — 2026-10-27

The first CI attempt for the new routing tests exposed an escaped-regex defect in the action classifier (the pattern contained literal double backslashes). The classifier has been corrected to use regex word-boundary and digit escapes, so OS/system facts and schedule commands can route to the deterministic planner. The previous CI result predates this correction and the updated expired-session test; a fresh green run is still required.


## Companion personal memory review — 2026-10-27

- Added a companion panel to review the encrypted local memory list, showing category, update time, content, and record ID.
- Added category-aware save controls for general, preference, project, and routine entries.
- Added correction and deletion request controls. They submit an explicit record ID and content through the signed `/api/request` path; existing policy and owner-approval rules remain authoritative.
- Saved content and identifiers use safe DOM text rendering, not HTML.
- Corrected the delayed-recurring schedule parser's escaped regular expression.
- Added planner coverage for category-aware save and memory listing, plus conversational-router coverage for memory commands.
- Extended browser smoke coverage to exercise the authenticated memory list panel as well as schedule listing and notification rendering.

**Validation status:** the exact latest branch head still requires a completed hosted build, typecheck, full test suite, and browser smoke. Physical Windows and Android acceptance remain outstanding.


### Hosted validation follow-up — 2026-10-27

- Hosted run [40542914662](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40542914662) passed TypeScript build, TypeScript check, and all 144 automated tests. The browser smoke reached its final runtime-error assertion and failed because the environment emitted zero optional speech-recognition `not-allowed` console events, while the test required exactly one.
- Updated the browser smoke assertion to allow zero or one expected optional speech-permission event while continuing to fail on any page error, unexpected console error, or repeated permission error.
- Follow-up CI run 40543314073 passed TypeScript build, typecheck, all 144 automated tests, and browser security smoke on commit `9371ed3dba6a416cbd03ac5da105bc60a3a0fee9`. Physical Windows and Android-device acceptance remains outstanding.


## Regression and scheduler persistence follow-up — 2026-10-29

- [x] Investigated hosted CI run [40923859884](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40923859884). Build and TypeScript checks passed; the test suite exposed one routing regression in the existing test for email drafting and installed-app inventory. The failing assertion was the `List installed apps` case, which incorrectly returned the unavailable-model conversational fallback rather than passing to the action planner.
- [x] Updated the conversational action-request matcher to route “list installed apps”, “show installed apps”, and “discover installed apps” through the existing planner and policy gateway.
- [x] Fixed a scheduler fail-closed gap: a failed durable pre-execution state write previously did not prevent the scheduled runner from being called. Scheduled execution now stops when persistence health is bad and does not invoke the runner if the at-most-once state advance cannot be persisted. Cancellation returns failure when its durable state update fails.
- [x] Added `test/scheduler_persistence_security.test.ts` to simulate a persistence failure and assert that scheduled work is not executed, scheduler health becomes unhealthy, and the failure is audited.
- [x] Verified exact code/test head `405b2eb233f08dfa0dde022a781cc34c611acd97` in successful push CI run [40926857275](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40926857275) and PR CI run [40926865217](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40926865217). Build, typecheck, automated tests, and browser security smoke all passed.
- [ ] Physical Windows microphone, wake/TTS and desktop acceptance remains outstanding.
- [ ] Native Android and two-phone acceptance remains outstanding.
- [ ] Run and record a separate `npm audit`; `npm ci` reporting zero vulnerabilities is useful evidence but does not replace a recorded dedicated audit.

**Scope note:** these changes improve two concrete defects; they do not close the broader product gaps documented above. JARVIS remains not release-ready.

## Windows app launch verification guard — 2026-10-30

- Fixed a false-positive in the allowlisted app launch adapter: matching a new window by title substring alone could attribute another application's window to the requested app.
- The matcher now requires an expected process name; a configured title substring is an additional check.
- Added regression coverage for title-only false positives, mismatched titles, .exe normalization, and missing matcher configuration.
- Hosted validation is running on the latest new branch commit. Physical MSI acceptance remains required, and universal Windows application control is still partial.

## Dynamic app launch verification guard — 2026-10-30

- Removed first-word title/process matching as a basis for claiming a discovered Start-menu application was verified.
- Dynamic Start-menu launch now returns PARTIAL_SUCCESS until a trusted AppID-to-process mapping can identify the target process. It records whether a new window appeared but marks targetWindowVerified as false.
- Regression tests cover a title-only lookalike window and a launch with no observed new window.
- Acceptance remains open for Windows MSI interactive testing and full hosted CI on the latest branch head.



## Windows desktop field-protection gap closure — 2026-10-30

The Windows UI Automation `desktop:set_value` path now blocks additional sensitive-field name patterns, including one-time passwords (OTP), recovery codes, credit/debit card fields, card expiry/expiration date, account and routing numbers, IBAN, SWIFT code, and sort code. This complements the existing password/PIN/CVV/security-code checks and the financial-app process/window block. Regression coverage asserts that the generated UI Automation script retains the expanded denylist. This is defense-in-depth, not a substitute for classifying every form semantically; fields with misleading or missing accessibility names remain a limitation. Hosted CI for the latest source and test commits must complete before this change is called validated, and physical MSI acceptance remains outstanding.


## Universal Windows application control — current status (2026-10-30)

Implemented in the current `new` branch:
- Foreground-window process guard with payment/financial-window deny patterns.
- Windows UI Automation control inspection and exact-name matching.
- Guarded control value read, click/invoke, and non-sensitive value set with readback verification.
- Credential/financial field heuristics, task-scoped approval for state changes, and tests for planner routing and script construction.
- UI Automation scripts now use the same foreground window handle captured by the guard, reducing the chance of a focus change redirecting the action to another application.

Still required before this epic can be called complete:
1. Run the automated workflow on Windows and complete interactive acceptance on the actual MSI laptop.
2. Add app-specific adapters for applications whose controls do not expose usable UI Automation patterns.
3. Verify durable outcomes (for example, saved document state) rather than only control-value readback.
4. Build robust multi-step target selection and recovery when a window closes, changes, or becomes unavailable.
5. Expand supported-app coverage incrementally and document unsupported applications explicitly.

This is an incremental implementation, not universal compatibility with every installed Windows application. Payment apps/actions remain out of scope.


### Target binding and remaining acceptance gate (2026-10-30)

Named-control reads, clicks, and value updates now accept optional `expectProcess`. Natural-language requests can specify a target process using an `in <process>` suffix. The desktop guard rejects a process mismatch before the operation executes. This is a foreground-process check, not a guarantee that every application exposes controls or that a window remains unchanged for the entire workflow.

**Epic completion gate:** CI must pass on the latest commit, and the MSI acceptance checklist in `POC.md` must be run interactively. In particular, test Notepad and a browser, duplicate names, focus changes, blocked sensitive fields, and durable file-save verification. Apps that expose neither usable UI Automation patterns nor stable accessible controls still require dedicated adapters; they must be reported as unsupported instead of silently falling back to unsafe input.


## Android companion — inventory queue hardening (2026-10-30)

Implemented on `new`:
- Validate requester/target identifiers before creating, claiming or querying commands; reject same-device requests.
- Treat non-finite TTL input as the default 60-second TTL, then clamp valid values to the supported 1–60 second range.
- Reject malformed app inventory records, control characters, and lists larger than 300 rather than silently storing partial data.
- Keep a command in `CLAIMED` state when an invalid result is submitted, allowing only a valid result to complete it before expiry.
- Return defensive copies so callers cannot mutate the queue's stored inventory through result objects.
- Add regression tests for invalid IDs/TTL, malformed app records, oversize lists, expiry, single-claim/single-completion and defensive-copy behavior.

**Not yet proven:** tests have been authored but have not been run in this environment. This change does not complete the Android epic. The queue remains in-memory and read-only; secure authenticated transport, full native Android lifecycle/permission acceptance, reconnect behavior and real two-phone revocation tests remain open. Do not enable general remote control based on this increment alone.


## Advanced multi-step execution — checkpoint journal foundation (2026-10-30)

Implemented on `new`:
- AES-256-GCM encrypted task checkpoint file, keyed from the configured owner control token with a per-write random salt and IV.
- Atomic temp-file write/rename, bounded file size and record count, and fail-closed behavior for invalid/tampered encrypted state.
- Defensive-copy checkpoint reads and basic record shape validation.
- On restart, non-terminal records are moved to `AWAITING_RECOVERY`; stale approval IDs are cleared and no workflow auto-resumes.
- Regression tests for encrypted-at-rest content, restart recovery, terminal-state preservation, tampering/wrong key, invalid records and defensive copies.
- [x] On checkpoint persistence failure, restore the prior in-memory record (or remove a newly added one), mark the journal unhealthy, and reject subsequent writes; regression test simulates a blocked parent path.

**Integration status (2026-10-30):** `JarvisCoreService` now opens the encrypted journal when an owner control token is configured, restores prior task records into the task list, checkpoints task creation, execution start, step results and workflow advancement, and marks interrupted records `AWAITING_RECOVERY` on restart without replaying them. A checkpoint-write failure moves the live task to recovery-required and prevents the next workflow step from starting. Cancellation/interruption and approval steps checkpoint through the step recorder. This is still partial lifecycle coverage: some early planning/error/revocation/expiry transitions and recovery UX need further audit, and the service currently has no explicit reconcile-and-resume command. Exact-head CI, crash/restart integration acceptance, partial-side-effect reconciliation and target-device acceptance remain unconfirmed.


## Voice and HUD privacy hardening — 2026-10-30

Implemented on `new`:
- Browser speech recognition for push-to-talk is blocked by default and requires an explicit checkbox consent for the current page session. The consent is not persisted.
- Finalized speech populates the editable transcript review field; it is not sent until the user explicitly presses **EXECUTE DIRECTIVE**.
- Hands-free/wake detection now fails closed while no local audio-level wake-word engine is configured, preventing continuous browser/vendor recognition from starting through either HUD toggle.
- HUD text explains the privacy boundary and keeps typed directives available without microphone use.
- Corrected the wake acknowledgement text to `Hi sir, I am ready to work.`.
- Browser smoke coverage checks that speech does not start without consent and that hands-free cannot start without a local wake engine.

**Status note:** this was the status before the local wake-word runtime integration documented below. The integration now exists in source, but the engine/model still requires installation and hardware acceptance on the target MSI. Browser push-to-talk and post-wake speech may still send audio to a browser/vendor service after separate explicit consent. Piper TTS audible output, accessibility/responsive behavior, and exact-head CI remain open.

## Voice/HUD follow-up — consent revocation and hidden-page handling (2026-10-30)

Added immediate capture cancellation when browser-speech consent is revoked, including transcript discard and protection against late recognition results. When the HUD becomes hidden, active capture is cancelled, the audio meter is released, and any standby listener is stopped. Browser smoke coverage verifies mid-capture consent revocation and late-result rejection.

**Still open / not accepted:** the local wake-word integration now has a setup path, but it is not yet proven operational on the target MSI. Verify model/runtime compatibility, microphone permissions, false triggers, CPU/RAM, local TTS/Piper audible output, and accessibility/responsive behavior. Do not describe the voice path as fully local: post-wake/browser speech remains a separately consented browser/vendor service unless local STT is installed and integrated.

## Local wake-word runtime integration and current acceptance gate — 2026-10-30

Implemented on `new`:
- Added `scripts/setup-local-wake-word.ps1` to install pinned `onnxruntime-web@1.20.1` and `jszip@3.10.1` in the ignored local runtime directory, preserve a local npm lockfile for transitive dependencies, and download the onnx-wakeword engine, mel frontend, and English “Hey Jarvis” model package. Upstream source/model URLs are pinned to immutable commit `8002ba9a14d80c0f71447920d3f1c8ee986b1432` rather than the mutable `main` branch. Assets are ignored by Git and are not checked into the repository.
- Added strict allowlisted server routes for the local runtime/model assets. Missing assets fail closed; the HUD does not fall back to continuous browser/vendor recognition.
- Connected the HUD to the local wake engine with single-start protection, local inference status, pause/stop behavior, page-hidden cleanup, and the required spoken acknowledgement.
- Added separate session-only consent for browser speech recognition after local wake detection. Voice transcripts remain review-only and require explicit **EXECUTE DIRECTIVE**.
- Added tests for the setup script reference, wake asset route allowlisting, and local wake integration wiring.

**Not accepted yet:** the setup script has not been run on the target MSI, so third-party model/runtime files and their compatibility are not verified on the actual machine. The upstream commit is immutable but unsigned. The setup script now verifies each downloaded source/model file against the expected Git blob SHA-1 from that commit before use, then prints a SHA-256 inventory for local records. Microphone permission, false-trigger behavior, CPU/RAM usage, audible local Piper TTS, and browser recovery still require target-device tests. The latest hosted Actions runs (including commit `1cac6e346559d6b9d5bae0c18312d7b311755778`) report both jobs failing within about 2–3 seconds before checkout: the Jobs API returns `runner_id: 0`, an empty `runner_name`, and no steps. This is evidence of a runner/job-start failure, not evidence that source tests failed; logs are unavailable (`BlobNotFound`). There is no exact-head build/test result to claim. The repeated pre-checkout runner-start failure is now recorded as an external validation blocker, so independent software-testable work in the already-existing Phase 2 recovery epic may proceed. Phase 1 remains open: obtain a green exact-head run when runner availability is restored and complete target-MSI wake/TTS/microphone acceptance before declaring voice complete.


## Recovery workflow implementation increment — 2026-10-30

**Implemented on `new` after the previously documented checkpoint-journal foundation:**
- Added an authenticated `POST /api/task/reconcile` endpoint, using the existing signed-session request protocol.
- The requesting device may review its own task; a device with `DEVICE_MANAGE` permission may review other tasks. Tasks outside `AWAITING_RECOVERY`/`INTERRUPTED` cannot be reconciled through this endpoint.
- A review requires an explicit disposition and an 8–500 character note. The raw note is kept out of audit details; the audit records only its length, reviewer, prior state, and disposition.
- `confirmed_no_effect` closes the task as `FAILED` and tells the user to submit a new request if needed; it does not replay the original task.
- `effect_observed` closes the task as `PARTIAL`, never `COMPLETED`, because a user note is not independent application-level proof.
- `still_unknown` remains `AWAITING_RECOVERY`. All paths explicitly avoid automatic replay or dependent-step continuation.
- Reconciliation metadata is stored in the encrypted task journal and shape-validated when restored.
- Added service-level regression tests for owner-authenticated reconciliation, no automatic replacement task, and the rule that user observation cannot be promoted to verified success.

**Validation status:** implementation and tests are committed on `new`; exact-head build, lint, full unit suite, browser smoke, and Android build have not yet been confirmed. The GitHub connector currently reports no status checks for the exact head, so this increment must not be called green until a completed workflow provides evidence. These tests have not been executed in this chat environment.

**Remaining workflow gaps:** add crash/fault-injection coverage for audit-write and journal-write failures during reconciliation; exercise partial external side effects with a real application; the companion now has a Recovery Review panel that fetches tasks through the signed session and submits review decisions through the signed request client; verify this interaction in exact-head browser smoke and target-device acceptance; verify cancellation/revocation/expiry transitions across the complete lifecycle. The endpoint is a safe review/closure path, not a generic workflow resume engine.


## Security regression follow-up — stale approvals after recovery transitions (2026-10-30)

A code review found that an approval record could remain present after a task moved out of AWAITING_APPROVAL (for example, after checkpoint failure or interruption). The approval handler now checks the current persisted/in-memory task state before resolving or consuming the approval and refuses any task not currently awaiting approval. The denial is audited, and the API maps this stale-state result to HTTP 409.

A regression test seeds a task in AWAITING_RECOVERY, creates an approval record for it, and asserts that approval fails without consuming the approval or changing the recovery state. The test uses an unsupported operation so the test cannot launch or mutate a real application.

**Validation remains pending:** no exact-head build/typecheck/test/browser-smoke result is available yet. Treat this as a security fix with authored regression coverage, not as verified until CI executes on the resulting commit.


## Workflow lifecycle checkpoint audit — 2026-10-30

A follow-up source audit enumerated task-state transitions in JarvisCoreService and tightened persistence around several early-exit and terminal paths:

- Persist request-audit failure and planner failure/schema-rejection/unmappable-plan states.
- Persist device-state, revocation and audit-integrity execution denials.
- Treat a failed checkpoint while entering AWAITING_APPROVAL as a hard stop and attempt to invalidate the pending approval; the stale-task approval guard remains a second line of defence.
- Persist skipped-step records after policy denial, approval rejection, approval expiry and cancellation.
- Persist final verified/partial/failed outcomes after step recording; if the final checkpoint fails, report UNCERTAIN/AWAITING_RECOVERY rather than a verified completion.
- Require a configured durable encrypted task journal before the HTTP recovery-review endpoint accepts a disposition.

**Status:** these source changes are committed on new, but they do not yet have exact-head CI evidence. Additional fault-injection tests are still required for journal write failure, audit write failure, concurrent cancellation/revocation, and crash/restart after a side effect. Keep the workflow epic open until these tests pass and the MSI application-level recovery checklist is recorded.


## Windows launcher error-disclosure hardening — 2026-10-30

The Windows app-launch adapter no longer returns raw process/spawn exception text to the client. Allowlisted and Start-menu launch failures now return bounded generic messages with only the error class retained in evidence. Invalid application-name diagnostics no longer echo an arbitrary oversized or non-string input. A regression test asserts these redaction boundaries at source level.

**Status:** implementation and regression test are committed; exact-head CI is not yet available. This does not prove actual Windows launch success or close the MSI interaction/verification acceptance gate.


## Voice reliability hardening — 2026-10-31

- Tightened local STT WAV validation before audio is passed to the optional whisper.cpp process: RIFF length must match the buffer, each chunk header and payload must remain inside the declared container, and the PCM format chunk must contain the required fields.
- Added focused regression tests for valid PCM input, truncated chunks, inconsistent RIFF size, undersized format chunks, wake-phrase word boundaries, and explicit cloud-speech opt-in.
- This is source-level hardening only. The tests must run on the exact resulting commit; it does not prove whisper.cpp/model installation, microphone capture, wake-word accuracy, or audible TTS on the MSI.


## Voice epic follow-up — bounded local TTS output

- [x] Bound Piper subprocess stdout to 16 MiB and retained stderr diagnostics to 8 KiB to prevent unbounded process output from consuming memory.
- [x] Validate RIFF/WAV declared size, chunk boundaries, format chunk presence and non-empty audio data before returning TTS output.
- [x] Add focused tests for valid WAV output, inconsistent RIFF size, truncated chunks, empty samples and oversized buffers.
- [ ] Run the exact-head TypeScript build, unit suite and browser smoke test after runner availability is restored; no hosted test result is claimed for this change.
- [ ] On the MSI, verify the configured Piper binary/model, audible playback, interruption/timeout behavior and acceptable latency.

This is reliability hardening within the existing Voice Interaction & Cinematic HUD epic, not epic acceptance. Local wake-word operation and physical-device voice acceptance remain open. The HUD's transcript-based wake/stop helper was also hardened to require whole-phrase boundaries, reducing accidental substring triggers. Direct browser-level tests for that helper remain outstanding.

## Voice startup failure recovery — 2026-11-01

- Fixed the post-wake browser speech-recognition startup exception path: if the browser rejects `recognizer.start()`, JARVIS now clears the pending wake-capture state, resets listening indicators, reports that no command was sent, and schedules local wake standby recovery.
- This is a source-level recovery fix only. Tests remain paused and no exact-head CI or MSI acceptance is claimed.


## Voice capture completion idempotency — 2026-11-01

- Added a per-capture completion guard so duplicate browser `onend` events cannot process the same finalized wake transcript more than once or submit the same command twice from that capture.
- Corrected the stale source comment to distinguish review-first push-to-talk from consented post-wake command dispatch through the policy gateway.
- This is a source-level safeguard only. Tests remain paused; exact-head CI and MSI voice acceptance are not claimed.


## Voice cancellation cleanup hardening — 2026-11-01

- Cancellation now detaches the active recognizer reference before requesting browser abort, invalidates the capture generation, and stops the audio meter. Late callbacks from the cancelled capture remain ignored by the generation guard.
- Recognition-start exceptions also stop the audio meter while resetting capture state.
- Source-level change only. Tests remain paused; exact-head CI and target MSI acceptance are not claimed.


## Voice/HUD follow-up — fail-closed post-wake timeout (2026-11-01)

Implemented on `new`: if consented post-wake browser speech capture reaches its 15-second limit, JARVIS now cancels and discards that capture instead of calling the normal stop path that can finalize and automatically submit a potentially incomplete wake command. Cancellation invalidates late recognizer events and schedules local wake detection recovery when hands-free remains enabled. Push-to-talk retains its existing timeout behavior: the transcript is presented for user review and is not sent automatically. This is source-level hardening only; tests remain paused by instruction, and exact-head CI plus Windows MSI voice acceptance are still unverified.


## Voice/HUD follow-up — interrupted wake capture fails closed (2026-11-02)

Implemented on `new`: non-permission, non-network errors during post-wake browser speech capture now invalidate the active capture and discard any partial transcript before it can reach automatic policy-gateway submission. The HUD reports that no command was sent and schedules wake recovery when hands-free remains enabled. Network and microphone-permission errors retain their existing explicit stop/disable behavior. Tests remain paused; this is not runtime acceptance evidence, and exact-head CI plus target-MSI verification remain pending.


## Voice/HUD follow-up — local speech playback terminal-state cleanup (2026-11-02)

Implemented on `new`: local TTS audio now registers its ended/error handlers before playback begins and uses a one-shot cleanup path to revoke the object URL, clear `isSpeaking`, and schedule hands-free recovery where appropriate. This addresses a short-clip race where playback could finish before the completion handler was attached, plus media errors that could leave speech state stuck. Tests remain paused; runtime playback, browser compatibility, and Windows MSI acceptance are not verified.


## Voice/HUD follow-up — speech-output cancellation and privacy controls (2026-11-02)

Implemented on `new`: disabling voice output or switching hands-free off now cancels browser speech synthesis and active local TTS audio, revokes its object URL, clears pending wake-restart timers, and resets speaking state. A generation guard prevents an in-flight local TTS request from starting playback after voice output has been disabled or superseded by a newer response. Tests remain paused; runtime/browser and MSI acceptance are not verified.


## Voice/HUD follow-up — stale hands-free recognizer callbacks (2026-11-02)

Hardened browser wake-listener lifecycle on `new`: callbacks from a recognizer that has already been stopped or replaced are ignored, and only the current recognizer may schedule a restart. Restart timers are cleared and nulled before replacement starts, reducing the chance of overlapping microphone-recognition sessions during wake/capture transitions. Tests remain paused; this is source-level hardening and does not establish runtime or MSI acceptance.


## Voice/HUD follow-up — wake-engine startup cancellation race (2026-11-02)

Added a lifecycle generation guard to local wake-engine startup on `new`. If the user disables hands-free, mutes the microphone, changes visibility, or replaces the active lifecycle while model loading/engine startup is awaiting, stale startup work is abandoned and its engine is stopped rather than reactivating the microphone. A fresh restart is scheduled if hands-free was re-enabled while the older startup was still unwinding. Tests remain paused; runtime/browser and MSI acceptance are not verified.

## Voice/HUD follow-up — visibility-aware wake recovery (2026-11-02)

Implemented on `new`: wake-recovery scheduling now refuses to queue microphone startup while the HUD is hidden and clears any existing restart timer. The timer callback repeats the visibility guard, while the existing `visibilitychange` handler requests recovery after the HUD returns to the foreground. This avoids background restart attempts triggered by capture-cancellation cleanup. Tests remain paused; runtime/browser and MSI acceptance are not verified.

## Voice/HUD follow-up — browser fallback visibility guards (2026-11-02)

Implemented on `new`: browser-based hands-free standby now checks visibility and microphone mute state before creating a recognition session. Restart timers triggered by recognition errors, end events, or synchronous start failures re-check those conditions before restarting. This prevents delayed fallback callbacks from reopening microphone recognition while the HUD is hidden or privacy mute is active. Tests remain paused; runtime/browser and MSI acceptance are not verified.


### Browser wake-recognition retry safety
- Synchronous `recognizer.start()` exceptions now use the same bounded exponential retry budget as asynchronous recognition errors and session endings, preventing an unbounded fixed-interval restart loop.

- Browser-based wake recognition now uses bounded exponential retry delays and pauses after five consecutive unsuccessful session endings, rather than repeatedly reopening the microphone.
- A usable transcript resets the retry counter. Local wake-word detection remains separate; browser speech recognition still requires its explicit consent setting.
- Runtime/browser acceptance testing has not been run; verify recovery, pause, resume, mute, and hidden-tab behavior on the target MSI before treating this as validated.

## Development increment — safe application intent routing

**Implementation commit:** `09b45366318ed27ee109b8635d56b0448c65b3c8`  
**Status:** IMPLEMENTED / TEST-AUTHORED / CI PENDING

- Changed the local planner so a known app name alone is not enough to create an `app:launch` operation; an explicit launch verb is required.
- Added support for `open`, `launch`, `start`, `run` and `bring up` phrasing, including a leading Hey/Hello/Hi JARVIS wake phrase.
- Kept known apps mapped to their allowlisted IDs and left generic app discovery on its existing policy/approval path.
- Added regression cases for informational mentions and explicit voice-style launch commands.
- Exact-head CI and real MSI voice-to-app execution have not yet been verified.

## CI failure triage — remediation applied, rerun pending

The latest surfaced JARVIS CI run (`41890545131`) is for an earlier commit, not the current branch head. Android build, dependency audit, TypeScript build and TypeScript check passed in that run; the automated suite failed.

Remediation applied on `new`:
- Removed a duplicated second copy of the artifact-integrity test suite that redeclared module-level constants.
- Aligned the Piper WAV size-validation message with the test's size-specific diagnostic.
- Corrected the rejection test to assert the documented initial `approved: false` state for a newly created approval.
- Updated the HUD regression assertion to validate actual separation of final and interim speech-recognition segments rather than depending on a comment string.

The earlier run also contained these failures; their fixes are in the branch history:
- Voice capture timeout was cleared before transcription completion.
- A test expected an obsolete HUD source comment; current source uses explicit `result.isFinal` and interim-result filtering.
- The approval/recovery path now checks task state before resolving an approval.

**Not yet verified:** no successful Actions run has been observed for the current `new` head. Do not mark JARVIS CI green until a fresh exact-head run completes.

## Voice-to-app execution — session feedback gap

**Status:** IMPLEMENTED / TEST-AUTHORED / VALIDATION PENDING

- The HUD now gives an audible and visible “directive not sent” explanation when no authenticated device session is restored. It no longer leaves the operator with only the wake acknowledgement in that failure case.
- An explicit “open Notepad” request is planned as app:launch; policy approval is a separate required stage where applicable. The app must not launch merely because the wake phrase was detected.
- Remaining validation: confirm browser speech capture receives the command after local wake detection, confirm the signed /api/request call, inspect the approval card, approve it, and verify the Notepad window on the MSI.
- Automated tests have not yet been run on the latest commit. Do not treat this increment as end-to-end verified.

## Voice-to-app follow-up — already-open application handling

**Status:** IMPLEMENTED / TEST-AUTHORED / VALIDATION PENDING

- Fixed a launch-verification gap for apps that reuse an existing process/window: a unique matching existing window is now focused and verified instead of relying only on detecting a new PID.
- Multiple matching windows are not selected arbitrarily. Focus failure is surfaced as failure, not success.
- Added two focused regression tests. Still pending: run the full suite, exact-head CI, and test a cold launch plus already-open Notepad on the MSI.


## Development increment — approval card concurrency and outcome clarity

**Status:** IMPLEMENTED / VALIDATION NOT RUN

- The HUD now prevents concurrent resolution requests for the same approval and disables the card controls during the request.
- A verified terminal response removes the card; non-terminal/unknown outcomes remain visible and cannot be mistaken for task completion.
- Communication ambiguity is reported as unknown, with an explicit instruction to refresh task status before retrying. This avoids treating a possibly-consumed single-use approval as safely retryable.
- Per current instruction, no tests or CI were run. Exact-head validation and MSI acceptance remain outstanding.

## Development increment — task timeline and recovery review in HUD

**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Added a recent-task panel backed by the authenticated task-list API, with manual refresh and periodic refresh.
- Timeline refreshes after new directives and approval decisions so the HUD can catch server-side state transitions instead of relying only on local messages.
- Task cards expose safe status metadata and expandable workflow step summaries; raw task parameters and result payloads are not rendered.
- Interrupted and recovery-pending tasks now expose the existing manual reconciliation endpoint. The owner can record `confirmed_no_effect`, `effect_observed`, or `still_unknown` with a required observation note.
- Reconciliation is review/annotation only; the HUD does not retry, resume, or replay the task. Server-side ownership, authentication, durable-journal and note validation remain authoritative.
- Per instruction, no tests or CI were run. UI and MSI acceptance remain outstanding.


## Development increment — task details and recovery transition clarity

**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Added an expandable detail view for each task, including task reference, operation, state, origin, created/updated timestamps, and safe step summaries.
- Kept task parameters and result payloads out of the HUD.
- Prevented overlapping manual reconciliation requests for the same task.
- Recovery feedback now names the submitted disposition and displays the state returned by the server. Observed effects are not represented as verified completion, and unknown outcomes remain explicitly unresolved.
- Refreshes task history after a confirmed review; no action is retried, resumed, or replayed.
- Per instruction, no tests, build, lint, CI, or device validation were run.


## Development increment — task stop/cancel workflow boundary

**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Added authenticated stop/cancel actions directly to task history cards: running tasks can request interruption; pending/approval tasks can be cancelled before execution.
- Added per-task in-flight protection and clear response/error feedback.
- Tightened the execution lifecycle so an interrupted adapter outcome is always treated as uncertain, remaining dependent steps are recorded as skipped, and the workflow returns without starting another operation.
- The UI explicitly distinguishes a stop request from rollback: an in-flight external effect may already have occurred and requires reconciliation.
- No tests, build, lint, CI, or target-device validation were run.


## Development increment — workflow state revalidation and approval checkpointing

**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Added a state gate at the policy-evaluation boundary. Only CREATED workflow steps and APPROVED steps can proceed; delayed planner results cannot revive cancelled, expired, interrupted, failed, or recovery-pending tasks.
- Expired approvals now terminate the handler immediately after marking the task EXPIRED and skipping dependent steps. The operation is not evaluated or executed.
- Approval acceptance is durably checkpointed as APPROVED before execution can begin. A failed checkpoint blocks execution and invalidates the approval where possible.
- Added JARVIS-US-040. Concurrency/fault-injection tests and exact-head validation remain outstanding.
- No tests, build, lint, CI, or device validation were run.
