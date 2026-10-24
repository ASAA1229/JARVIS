# JARVIS POC — Implemented and Evidence-Backed

**Updated:** 2026-10-24
**Overall POC acceptance:** INCOMPLETE / BLOCKED. This file lists implemented behavior and local evidence; it does not mean the product is release-ready.

## Implemented baseline

- Node.js 24 + TypeScript modular-monolith backend.
- Browser-based companion/HUD with text fallback and push-to-talk controls.
- Device identity and session protocol using Ed25519; one-time enrollment challenges and signed session/request flow are present in the remediation checkout.
- Owner-authorized device enrollment with expiring QR/manual-code transactions, Ed25519 proof-of-possession, pending approval, explicit TOTP step-up, least-privilege permission selection, cancellation/rejection, device listing, and server-side revocation. TOTP seeds and anti-replay/failure state are encrypted at rest.
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
- The earlier full test attempt on this branch had environment/timing failures; that is superseded by the current evidence below. The final `npm audit` endpoint was unreachable.

## Current device-security worktree evidence (2026-10-24)

The `new` branch worktree is currently dirty with the device-enrollment/authentication implementation. Automated checks against this working tree:

- `npm run build`: PASS.
- `npm run lint`: PASS (TypeScript no-emit check).
- `npm test`: PASS — 75 passed, 0 failed, 0 skipped. This Windows sandbox required a temporary process-only shim for Node `os.userInfo()` returning `uv_os_get_passwd … ENOMEM`; the shim was removed after the run and did not change project files.
- `npm run test:browser`: FAIL — after legacy bootstrap enrollment and earlier HUD checks, the simulated voice-recognition lifecycle wait at `test/browser-smoke.mjs:290` timed out twice. The new QR/TOTP approval workflow is not covered by this harness.
- `npm audit --audit-level=low`: UNAVAILABLE — npm registry advisory endpoint failed; installation itself reported 0 vulnerabilities, which is not a substitute for an audit result.
- `npm ls --depth=0` and JavaScript syntax checks: PASS.

Device-security tests cover TOTP provisioning/verification, encrypted seed-at-rest, TOTP replay and failure lockout, hashed single-use enrollment references, QR output, proof-of-possession, pending-before-approval, exact request binding, least-privilege grants, cancellation/expiry, unauthorized management denial, and the HTTP create → exchange → approve → session → revoke path. No physical Android or remote-device acceptance is claimed.
- M12 is **PARTIAL**. Gesture proposals are previews only. Policy/approval/adapter integration, voice arbitration, deletion confirmation, physical precision/false-activation/latency, sustained resource use, and target laptop acceptance remain open.

## HUD/voice merge review (2026-10-24)

- The `new` branch contained unresolved Git conflict markers in `src/companion/hud.html`, duplicated hands-free event listeners, and two competing `speakResponse` declarations. The conflict and duplicate code were corrected in the HUD fix commit.
- Voice output is gated by the existing voice-output toggle and microphone privacy state; audible playback, browser autoplay, and actual Piper CLI compatibility remain unverified until target-runtime testing.
- Responsive HUD styling was enhanced for compact layouts, keyboard focus visibility, button states, and readable telemetry. Visual/browser acceptance is still required.

## Implemented does not mean externally accepted

- Windows application-launch implementation exists, but real visible Notepad acceptance on the target MSI must be separately recorded. A mocked test does not count.
- Browser voice lifecycle and HUD controls exist, but physical microphone/vendor speech behavior and actual voice playback acceptance remain unverified.
- Automated tests cover device independence, but physical two-phone enrollment/revocation acceptance is not complete.
- Android prototype exists separately but is not integrated with the backend.

## POC completion gate

The overall POC must remain **NOT COMPLETE** until the POC2 blockers are closed with evidence, the target Windows runtime is accepted, required device/voice behavior is verified, and exact-source CI is available. Move individual items from `POC2.md` into this file only after the corresponding acceptance criteria pass and evidence is recorded.


## Voice capture reliability fix (2026-10-24)

- Changed the HUD voice button from pointer-down/pointer-up capture to click-to-toggle. A normal click previously started recognition and immediately stopped it on pointer release, which could leave no time to speak.
- Wake detection now preserves a command spoken in the same utterance as a wake phrase (for example, “Hey JARVIS, open Notepad”) instead of throwing away the command portion.
- Recognition errors now surface actionable states for microphone permission denial, unavailable microphone hardware, speech-service/network failure, and no speech detected. Permission denial also cancels and releases the active capture state.
- The push-to-talk transcript remains a review-and-confirm flow; hands-free wake commands use the existing authenticated directive and policy path. No policy/approval bypass was added.
- Browser automation coverage was updated for click-to-toggle capture and microphone-permission recovery. Physical microphone, browser speech-service availability, and real-device acceptance still require testing.

## Approval-binding security remediation — 2026-10-24

- Added a fail-closed runtime check for malformed policy parameter containers before enumeration or hashing.
- Task-scoped approval evaluation now checks the approval's task ID, requesting device ID, and operation name as well as the canonical parameter hash. Matching parameters alone can no longer replay an approval into a different task, device, or operation.
- Approval rejection now applies the same operation-family permission checks as approval: memory operations require `DEVICE_MANAGE`; app launch and desktop operations require `APP_LAUNCH`.
- Added `test/policy_gateway_binding.test.ts` covering task replay, device mismatch, operation mismatch, malformed parameter containers, and unknown parameters.
- This is source/test implementation, not acceptance evidence until the new PR CI passes. Physical Windows/voice/Android acceptance and independent security review remain open; overall POC remains INCOMPLETE / BLOCKED.

## Adapter exception redaction — 2026-10-24

- The core execution service no longer returns raw adapter exception strings to the user or includes them in audit evidence. It returns a bounded failure message and records only the non-sensitive exception class in completion audit metadata.
- Added `test/adapter_error_redaction.test.ts` to inject a path-like private diagnostic and assert it is absent from the task result and public audit records.
- These tests are committed on `gap-closure`; their status remains pending until the exact PR CI run completes. This does not yet constitute a full API error-redaction review across every route and adapter.

## Approval and error-redaction regression CI — 2026-10-24

- Hosted CI run [40091754717](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40091754717) completed successfully for code/test commit `191f1eefcfc1d171c3bd8ebc8731e83cdea2f85d`: locked dependency install, TypeScript build, TypeScript check, automated suite (**101 passed, 0 failed**), and browser security smoke test all passed. The run is code/test evidence for that commit; documentation-only follow-up commits do not change source or tests. It does not establish physical Windows, microphone/TTS, Android/iOS, or independent security acceptance.
- Overall POC remains INCOMPLETE / BLOCKED because real Windows desktop, physical voice, two-phone Android, secure remote transport, native iOS, and independent security-review gates are still open.

## Approval-rejection permission regression coverage — 2026-10-24

- Added `test/rejection_permissions.test.ts` for attempts to reject desktop and personal-memory approvals using devices that lack the required `APP_LAUNCH` or `DEVICE_MANAGE` permission.
- This new test file is committed after the earlier passing CI run; its validation is pending a new hosted CI run. The earlier 101-test green result does not include this new file.
