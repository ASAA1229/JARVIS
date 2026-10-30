# JARVIS POC2 — Remaining Gaps, Blockers, and Acceptance Plan

**Updated:** 2026-10-24  
**Baseline:** source tree 6222e1964774c78e6853d6113335b1a3f0284881; documentation head 6dd9d8d62ccf2610fb458da159fc1dd11f47079c; dev integration commit 29df6b8699a8145f2163efee0c0ac306af2e7adc  
**Rule:** A capability does not move to POC.md as accepted until its acceptance criteria pass with recorded evidence. No new requirements document is needed for this gap closure; update this file and the existing project docs.

## Existing Epic Closure Plan — 2026-10-30

**Scope freeze:** finish and accept only the epics/capabilities already started or recorded in this repository. Do not introduce a new epic, milestone, or unrelated feature stream until every existing epic has either passed its acceptance gate or has an explicitly documented external blocker with evidence. No PR is created without the owner's explicit request.

Complete these phases in order; phase numbers organize existing work and do not create new epics:

1. **Voice Interaction & Cinematic HUD (currently active):** local-only “Hey Jarvis” keyword spotting, explicit separate consent for any browser/vendor speech recognition after wake, review-before-execute transcript handling, microphone lifecycle safeguards, local TTS configuration/output, browser regression coverage, and target MSI acceptance.
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
- [ ] Implement and measure the desired local wake-word loop, visible microphone/listening status, privacy control, interruption and resource use before claiming always-ready voice.
- [ ] Keep wake-word listening off until the actual opt-in local implementation and acceptance are complete.
- [ ] Verify compact HUD layouts, keyboard accessibility, error states and real-device browser behavior.

## P1 — Android companions and remote control

- [ ] Implement a native Android agent/companion; the current browser companion is not a substitute for native OS permissions or Android Keystore.
- [ ] Enroll both real phones independently and prove separate keys, identities, sessions, permission sets and approval authority.
- [ ] Verify secure authenticated remote transport, request signing, nonce replay protection, session expiry, owner approval, cancellation, and immediate revocation.
- [ ] Revoke one phone and prove it can no longer act while the other remains independently usable.
- [ ] Test behavior when the laptop is asleep, unreachable, or reconnects. Queue harmless informational tasks only; reject or revalidate state-changing work.
- [ ] Validate app launch, notifications, SMS/telephony capabilities and any accessibility-based automation against the actual Android versions and user-enabled permissions.
- [ ] Keep remote access disabled until secure transport and end-to-end authorization are proven.

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

**Not accepted yet:** the setup script has not been run on the target MSI, so third-party model/runtime files and their compatibility are not verified on the actual machine. The upstream commit is immutable but unsigned. The setup script now verifies each downloaded source/model file against the expected Git blob SHA-1 from that commit before use, then prints a SHA-256 inventory for local records. Microphone permission, false-trigger behavior, CPU/RAM usage, audible local Piper TTS, and browser recovery still require target-device tests. The latest hosted Actions runs (including commit `1cac6e346559d6b9d5bae0c18312d7b311755778`) report both jobs failing within about 2–3 seconds before checkout: the Jobs API returns `runner_id: 0`, an empty `runner_name`, and no steps. This is evidence of a runner/job-start failure, not evidence that source tests failed; logs are unavailable (`BlobNotFound`). There is no exact-head build/test result to claim. Restore/investigate GitHub-hosted runner availability and then obtain a green exact-head run before acceptance. Do not advance to Phase 2 or introduce any new epic until this active phase reaches its acceptance gate or a precisely evidenced external blocker is recorded.


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
