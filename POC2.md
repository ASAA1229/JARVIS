# JARVIS POC2 — Remaining Gaps, Blockers, and Acceptance Plan

**Updated:** 2026-10-24  
**Baseline:** new source tree 6222e1964774c78e6853d6113335b1a3f0284881; dev merge commit d061216b2a007992e4ddae912d8e88c812934bd1  
**Rule:** A capability does not move to POC.md as accepted until its acceptance criteria pass with recorded evidence. No new requirements document is needed for this gap closure; update this file and the existing project docs.

## Confirmed repository/branch state

- PR #12, new → dev, is already merged: https://github.com/Guda-Abhishek/JARVIS/pull/12
- dev and new currently have the same Git tree. dev is one merge commit ahead of new; they are not the same commit.
- fix, test, and enhancement were missing and have been recreated from dev.
- main remains unchanged and is not a target for automated commits, pushes, or merges.
- Hosted CI completed successfully on new commit 6222e1964774c78e6853d6113335b1a3f0284881: https://github.com/Guda-Abhishek/JARVIS/actions/runs/40098158500
- Hosted CI completed successfully on dev commit d061216b2a007992e4ddae912d8e88c812934bd1: https://github.com/Guda-Abhishek/JARVIS/actions/runs/40098105606
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
