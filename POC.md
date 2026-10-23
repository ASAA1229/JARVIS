# JARVIS POC — Implemented and Evidence-Backed

**Updated:** 2026-10-23  
**Overall POC acceptance:** INCOMPLETE / BLOCKED. This file lists implemented behavior and local evidence; it does not mean the product is release-ready.

## Implemented baseline

- Node.js 24 + TypeScript modular-monolith backend.
- Browser-based companion/HUD with text fallback and push-to-talk controls.
- Device identity and session protocol using Ed25519; one-time enrollment challenges and signed session/request flow are present in the remediation checkout.
- Default-deny `PolicyGateway`, operation allowlist, task-scoped approvals, single-use approval consumption, session expiry/revocation, and AI planner schema validation.
- Selected read-only Windows system-information operations and allowlisted installed-app launch adapter.
- Outcome states distinguish verified, partial, failed, and uncertain execution; interrupted or unaudited results must not be reported as verified success.
- Hash-chained audit records, redaction, integrity checking, persistence/recovery logic, and fail-closed execution behavior.
- Automated unit/integration regression suite and browser smoke harness.

## Reported local verification (must be tied to exact commit before release)

On the reported dirty `fix` tree based on `9ead85cdacb7e9dedf855605a6d0942760ea3a6f` on 2026-10-23:

- `npm ci`: PASS.
- `npm run build`: PASS.
- `npm run lint`: PASS.
- `npm test`: 51 passed, 0 failed, 0 skipped.
- `npm run test:browser`: PASS; speech recognition simulated.
- `npm audit --audit-level=low`: PASS, 0 reported vulnerabilities.
- `npm ls --depth=0`: PASS.

These results were reported against a dirty tree and are not exact-commit hosted-CI evidence.

## M12 local preview foundation — `new` branch

- An opt-in, video-only camera and same-origin MediaPipe Hand Landmarker/WASM run in a worker. Camera defaults off, the active state is visible, and stop releases tracks and inference resources.
- Automated gesture tests passed **7/7** using synthetic landmark fixtures. They cover schema/version/target/staleness bounds, confidence floor, dwell/rearm/duplicate suppression, point/pinch/swipe, tracking loss, and absence of gesture-to-backend/shell/adapter execution paths.
- `npm run test:browser` passed in Microsoft Edge with a fake-camera device. The fake stream loaded the same-origin model/WASM and ran CPU inference; the test checked video-only capture, stop/release, simulated camera loss/permission denial, and no external request. This is not physical webcam or gesture-accuracy acceptance.
- On this branch, `npm run build`, `npm run lint`, and `npm ls --depth=0` passed. The full `npm test` run has existing environment/timing failures and is not green; see `master_repo_test` for exact counts. The final `npm audit` endpoint was unreachable.
- M12 is **PARTIAL**. Gesture proposals are previews only. Policy/approval/adapter integration, voice arbitration, deletion confirmation, physical precision/false-activation/latency, sustained resource use, and target laptop acceptance remain open.

## Implemented does not mean externally accepted

- Windows application-launch implementation exists, but real visible Notepad acceptance on the target MSI must be separately recorded. A mocked test does not count.
- Browser voice lifecycle and HUD controls exist, but physical microphone/vendor speech behavior and actual voice playback acceptance remain unverified.
- Automated tests cover device independence, but physical two-phone enrollment/revocation acceptance is not complete.
- Android prototype exists separately but is not integrated with the backend.

## POC completion gate

The overall POC must remain **NOT COMPLETE** until the POC2 blockers are closed with evidence, the target Windows runtime is accepted, required device/voice behavior is verified, and exact-source CI is available. Move individual items from `POC2.md` into this file only after the corresponding acceptance criteria pass and evidence is recorded.
