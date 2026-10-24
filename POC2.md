# JARVIS POC2 — Pending, Blocked, Unverified, and Future Work

**Updated:** 2026-10-24
**Rule:** Nothing moves to `POC.md` until its acceptance criteria are satisfied with recorded evidence.

## POC blockers / incomplete work

- [ ] **M2 — Real Windows runtime:** Run the actual backend on the target Windows 11 host and verify Notepad opens visibly from the real UI/voice/text path. Capture policy decision, adapter result, OS process evidence, audit entry, and honest UI result.
- [ ] **M3 — Android enrollment/channel:** Implement and verify a supported secure enrollment and communication path; physical-device acceptance required.
- [ ] **M4 — Approval lifecycle:** Complete HTTP/API contract coverage for approve, reject, expiry, duplicate requests, stale approvals, concurrent transitions, and task/device/parameter binding.
- [ ] **M5 — AI planner:** Re-verify runtime integration, schema validation, adversarial input rejection, and strict policy gateway enforcement.
- [ ] **M6 — Verification/hardening:** Obtain exact-commit CI and target-platform acceptance; retain fail-closed and outcome-truth guarantees.
- [ ] **M7 — Remaining security remediation:** The new branch now has owner-controlled expiring enrollment requests, explicit request approval/rejection/cancel, TOTP step-up, replay/failure controls, encrypted TOTP state, and device/session management with automated coverage. Remaining M7 gates include broader persistence failure/recovery verification, exhaustive API contract/error-redaction review, accessibility, audit-failure edge cases, hosted CI, and independent security review.
- [ ] **Voice/audio — physical acceptance:** Test real microphone permission, capture, stop/mute/cancel, device removal, recognition timeouts/late results, actual TTS playback, autoplay failures, and privacy indicators on supported browsers.
- [ ] **Speech privacy:** Determine and document whether the selected browser recognition engine sends audio to a vendor service; do not claim local/offline recognition without evidence.
- [ ] **M8 — Specification:** Locate an approved M8 specification and the relevant discovery decisions. Do not invent requirements; remain blocked until scope is approved.
- [ ] **M9 — Android prototype integration:** Review the separate prototype, implement the required backend security capabilities and task APIs only after design/security review, build/install, and verify on physical devices. Keep remote access disabled until secure transport and authorization are proven.
- [ ] **M10 — Specification:** Find the authoritative scope in history/branches or request owner approval; do not infer it.
- [ ] **M11 — Specification:** Find the authoritative scope in history/branches or request owner approval; do not infer it.
- [ ] **M12 — Gesture & spatial interaction:** Current `new` branch has a local-only preview foundation. Before completion, pass target Windows webcam/lifecycle acceptance, measured precision/false-activation/latency/performance thresholds, voice arbitration and stale-target tests, and any policy-routed action integration tests. Keep deletion, approval, and system actions disabled until each passes review; see [M12 acceptance plan](docs/m12-gesture-spatial-interaction.md).
- [ ] **Two-phone acceptance:** Enroll both devices, verify separate keys/sessions/permissions, revoke one, and prove the other remains independently usable.
- [ ] **Device enrollment real-client acceptance:** Current enrollment transactions are loopback-only and process-local. Validate two independent browser profiles and an Android companion against a secure remote transport design before remote QR enrollment; do not change the server bind address to make this work. Test owner approval, TOTP step-up, cancellation, expiry, and revocation on real clients.
- [ ] **TOTP owner recovery:** TOTP state encryption is keyed from the owner control token. Establish and verify a safe owner recovery procedure before changing/rotating that token or before a lost-authenticator event; no bypass is implemented.
- [ ] **Hosted CI:** Verify workflow result for the exact accepted commit; local green tests alone are insufficient.
- [ ] **Dependency reproducibility:** Re-run clean lockfile installation, build, typecheck/lint, tests, and security audit on the final reviewed commit.
- [ ] **Repository consolidation:** Inventory all Markdown and test files across `main`, `dev`, `new`, `fix`, `test`, and `lovable`; merge unique requirements/results into `master_repo_md.md` and `master_repo_test`; verify no unique criteria or source tests would be lost before deleting files.
- [ ] **Worktrees:** Inventory existing worktrees and create/verify isolated milestone worktrees for M1–M11 without overwriting dirty work; document future-milestone provisioning.

## Future scope (requires explicit approval before implementation)

- Native Android companion using Android Keystore hardware-backed key storage where available.
- Secure remote access using a reviewed TLS/VPN/overlay trust model, independent device permissions, and revocation.
- More desktop, browser, file, and phone capabilities, each introduced through bounded adapters and explicit policy/approval rules.
- Optional local model integration and cloud model selection under per-task data-sharing policy.
- Better offline behavior, scheduled workflows, notifications, and cross-device orchestration.
- HUD polish and selective porting from the partial Lovable candidate after runtime/security gates are satisfied.

## Required evidence to move an item into POC

For each item, record: acceptance criterion; exact commit SHA; implementation path; test command and output; whether the test is mocked or real; target OS/browser/device; manual/physical evidence where required; known limitations; reviewer decision. Only then mark it complete in `POC.md` and remove it from this pending list. Keep the overall POC incomplete while any release-blocking acceptance gate remains open.
