# JARVIS POC2 — Pending, Blocked, Unverified, and Future Work

**Updated:** 2026-10-24
**Rule:** Nothing moves to `POC.md` until its acceptance criteria are satisfied with recorded evidence.

## POC blockers / incomplete work

- [ ] **M2 — Real Windows runtime:** Run the actual backend on the target Windows 11 host and verify Notepad opens visibly from the real UI/voice/text path. Capture policy decision, adapter result, OS process evidence, audit entry, and honest UI result.
- [ ] **M3 — Android enrollment/channel:** Implement and verify a supported secure enrollment and communication path; physical-device acceptance required.
- [ ] **M4 — Approval lifecycle:** Complete HTTP/API contract coverage for approve, reject, expiry, duplicate requests, stale approvals, concurrent transitions, and task/device/parameter binding.
- [ ] **M5 — AI planner:** Re-verify runtime integration, schema validation, adversarial input rejection, and strict policy gateway enforcement.
- [ ] **M6 — Verification/hardening:** Obtain exact-commit CI and target-platform acceptance; retain fail-closed and outcome-truth guarantees.
- [ ] **M7 — Remaining security remediation:** The new branch now has owner-controlled expiring enrollment requests, explicit request approval/rejection/cancel, TOTP step-up, replay/failure controls, encrypted TOTP state, and device/session management with automated coverage. Remaining M7 gates include broader persistence failure/recovery verification, exhaustive API contract/error-redaction review, accessibility, audit-failure edge cases, and independent security review. Exact-commit hosted CI now passes on the consolidated baseline; target-device acceptance remains open.
- [ ] **Voice/audio — physical acceptance:** `fix` now contains an initial opt-in hands-free wake-phrase loop (`Hey/Hello/Hi JARVIS`, `I'm here`), stop-phrase handling, browser speech-synthesis responses, and recognition-error recovery. This is code presence only, not acceptance. Run build/lint/unit/browser tests and then test real microphone permission, same-utterance and separate-utterance commands, stop/mute/cancel, recognition timeouts/late results, actual audible TTS, browser autoplay/voice availability, duplicate-command prevention, and privacy indicators on the target Windows browser. Do not claim continuous/offline operation across all browsers.
- [ ] **Speech privacy:** Determine and document whether the selected browser recognition engine sends audio to a vendor service; do not claim local/offline recognition without evidence.
- [ ] **M8 — Specification:** Locate an approved M8 specification and the relevant discovery decisions. Do not invent requirements; remain blocked until scope is approved.
- [ ] **M9 — Android prototype integration:** Review the separate prototype, implement the required backend security capabilities and task APIs only after design/security review, build/install, and verify on physical devices. Keep remote access disabled until secure transport and authorization are proven.
- [ ] **M10 — Specification:** Find the authoritative scope in history/branches or request owner approval; do not infer it.
- [ ] **M11 — Specification:** Find the authoritative scope in history/branches or request owner approval; do not infer it.
- [ ] **M12 — Gesture & spatial interaction:** Current `new` branch has a local-only preview foundation. Before completion, pass target Windows webcam/lifecycle acceptance, measured precision/false-activation/latency/performance thresholds, voice arbitration and stale-target tests, and any policy-routed action integration tests. Keep deletion, approval, and system actions disabled until each passes review; see [M12 acceptance plan](docs/m12-gesture-spatial-interaction.md).
- [ ] **Two-phone acceptance:** Enroll both devices, verify separate keys/sessions/permissions, revoke one, and prove the other remains independently usable.
- [ ] **Device enrollment real-client acceptance:** Current enrollment transactions are loopback-only and process-local. Validate two independent browser profiles and an Android companion against a secure remote transport design before remote QR enrollment; do not change the server bind address to make this work. Test owner approval, TOTP step-up, cancellation, expiry, and revocation on real clients.
- [ ] **TOTP owner recovery:** TOTP state encryption is keyed from the owner control token. Establish and verify a safe owner recovery procedure before changing/rotating that token or before a lost-authenticator event; no bypass is implemented.
- [x] **Hosted CI:** Exact-commit hosted CI passed for commit `9a40f95528d32aaed63626a1c48ae1ef4e1cda51` on `fix` push, `fix` PR, `new` push, `test` push, and `enhancement` PR. The same commit adds regression tests for UI Automation control-count binding and PowerShell value escaping. See [audit addendum](docs/repository-audit-2026-10-24.md#addendum--exact-shared-commit-ci-and-branch-inventory-2026-10-24) and [test register](master_repo_test).
- [x] **Dependency reproducibility (CI stages):** Exact-commit hosted CI passed locked dependency installation, build, typecheck/lint, automated tests, and browser smoke on `9a40f95528d32aaed63626a1c48ae1ef4e1cda51`. [Audit evidence](docs/repository-audit-2026-10-24.md). `npm audit` is not part of CI and remains unverified.
- [x] **Repository consolidation inventory:** Completed recursive Markdown/test inventory for `main`, `dev`, `enhancement`, `new`, `fix`, `test`, `lovable`, `Jarvis-Abhi`, and `feature/local-neural-tts`. Current decisions, exact hosted CI, and branch/test divergence dispositions are recorded in `master_repo_md.md`, `master_repo_test`, and `docs/repository-audit-2026-10-24.md`. Historical Lovable docs and divergent test variants were retained on their original refs; no source tests or branches were deleted. The older test variants were not blindly overwritten onto the newer current suite.
- [ ] **Worktrees:** Inventory existing worktrees and create/verify isolated milestone worktrees for M1–M11 without overwriting dirty work; document future-milestone provisioning.

- [ ] **HUD/voice integration verification:** Re-run build/lint/unit/browser smoke on the exact merged `new` branch; test wake enable/pause/disable, mute, voice-output toggle, single spoken response per result, audio playback failure recovery, mobile layout, keyboard navigation, and real Piper CLI/model playback. Verify the final branch has no conflict markers or duplicate voice/listener definitions.

## Future scope (requires explicit approval before implementation)

- Native Android companion using Android Keystore hardware-backed key storage where available.
- Secure remote access using a reviewed TLS/VPN/overlay trust model, independent device permissions, and revocation.
- More desktop, browser, file, and phone capabilities, each introduced through bounded adapters and explicit policy/approval rules.
- Optional local model integration and cloud model selection under per-task data-sharing policy.
- Better offline behavior, scheduled workflows, notifications, and cross-device orchestration.
- HUD polish and selective porting from the partial Lovable candidate after runtime/security gates are satisfied.

## Required evidence to move an item into POC

For each item, record: acceptance criterion; exact commit SHA; implementation path; test command and output; whether the test is mocked or real; target OS/browser/device; manual/physical evidence where required; known limitations; reviewer decision. Only then mark it complete in `POC.md` and remove it from this pending list. Keep the overall POC incomplete while any release-blocking acceptance gate remains open.


## Voice recognition reliability — verification pending

- [ ] Run build, lint, unit tests, and browser smoke tests on the merged `new` branch.
- [ ] Verify click-to-toggle push-to-talk stays listening after one click, captures speech, and shows a reviewable transcript; confirm a second click stops capture.
- [ ] Verify “Hey JARVIS, open Notepad” preserves and dispatches the command text through the authenticated policy gateway.
- [ ] Verify browser microphone permission, selected input device, speech-service/network availability, no-speech recovery, and the visible error states in Edge/Chrome.
- [ ] Verify hands-free standby can restart after recognition sessions end, and confirm actual physical microphone and TTS playback on Windows/Android.


## Final automated validation — 2026-10-24

- [x] Final reviewed code/test commit: `9a40f95528d32aaed63626a1c48ae1ef4e1cda51`.
- [x] Hosted CI green on `fix` push/PR, `new` push, `test` push, and `enhancement` PR; all workflow stages completed successfully. Exact run links are in [the audit](docs/repository-audit-2026-10-24.md).
- [x] Added six focused Windows UI Automation script/validation regression tests.
- [ ] Live Windows interactive-session acceptance, real microphone/TTS/wake behavior, Android two-phone tests, native iOS, and independent adversarial security review remain blocked on target devices/owner review. These cannot be truthfully completed by hosted CI alone.

## Approval binding and policy input hardening — 2026-10-24

- [x] **Code change:** Task-scoped approval checks now bind approval to task ID, requesting device ID, operation, and parameter hash.
- [x] **Code change:** Invalid runtime parameter containers fail closed before key enumeration/hashing.
- [x] **Code change:** Approval rejection checks the same operation-family permissions as approval for memory and desktop actions.
- [x] **Regression tests added:** `test/policy_gateway_binding.test.ts` covers cross-task replay, cross-device replay, operation substitution, malformed containers, and disallowed parameters.
- [ ] **CI validation pending:** Confirm PR #11 passes build, typecheck, automated tests, and browser smoke test; do not mark this code accepted until the exact commit is green.
- [ ] **Further approval contract tests:** expiry, duplicate/concurrent transitions, stale task state, audit persistence failure, and task/device parameter binding through the HTTP API remain open.
- [ ] **Release gates unchanged:** physical Windows app interaction, microphone/TTS, Android two-phone acceptance, native iOS, remote transport review, and independent adversarial security review remain incomplete.

## Adapter exception disclosure hardening — 2026-10-24

- [x] **Code change:** Core adapter exceptions are converted to a generic user-facing failure; raw exception strings are not copied into result evidence or audit details.
- [x] **Regression test added:** `test/adapter_error_redaction.test.ts` injects a private path-like diagnostic and checks task/audit outputs do not disclose it.
- [ ] **CI validation pending:** Verify this test and the approval-binding tests pass on the final PR head.
- [ ] **Broader review pending:** audit all HTTP routes and adapter-authored errors for path, command, token, or sensitive data disclosure.

## CI-driven test correction — 2026-10-24

- The first hosted run for the new suite passed build and TypeScript checks but failed one new operation-binding test because the test fixture used a parameter name rejected by the target operation before the approval-binding branch could be exercised. The implementation's parameter allowlist behaved as designed.
- Corrected the test to use a valid parameter shape for the alternate operation, preserving the intended replay/binding assertion.
- Corrected test commit: `191f1eefcfc1d171c3bd8ebc8731e83cdea2f85d`.
- [ ] Re-run/confirm hosted CI for the corrected PR head before marking the new suite PASS.

## Corrected approval-binding CI result — 2026-10-24

- [x] Hosted CI run [40091754717](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40091754717) completed successfully for code/test commit `191f1eefcfc1d171c3bd8ebc8731e83cdea2f85d`: locked dependency install, TypeScript build, TypeScript check, automated suite (**101 passed, 0 failed**), and browser security smoke test all passed. The run is code/test evidence for that commit; documentation-only follow-up commits do not change source or tests. It does not establish physical Windows, microphone/TTS, Android/iOS, or independent security acceptance.
- [ ] Complete broader approval HTTP contract tests (expiry, duplicate/concurrent transitions, stale task state, persistence/audit failure).
- [ ] Complete route-by-route adapter/API error disclosure review and independent adversarial review.
- [ ] Complete physical Windows/voice/Android acceptance; native iOS remains incomplete.

## Approval rejection authorization tests — 2026-10-24

- [x] Added `test/rejection_permissions.test.ts` to verify a read-only device cannot reject desktop or personal-memory approvals without the matching permission.
- [ ] Run and verify hosted CI on the latest branch head; the previous 101-test green run predates this new test file.

## Rejection test harness correction — 2026-10-24

- Initial CI failed two newly added tests because they used asynchronous `assert.rejects` for synchronous permission exceptions. The expected permission checks were reached.
- Updated the assertions to `assert.throws` in commit `f8f49920d15048dc6bebb85a3c22a2066777bfa4`.
- [ ] Re-run CI on the corrected test commit and verify the full browser smoke stage before closing this item.
