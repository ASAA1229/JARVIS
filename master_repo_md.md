# JARVIS — Master Repository Documentation

**Snapshot date:** 2026-10-24
**Current feature branch:** `new` (device security workflow + M12 gesture foundation)
**Disposition:** POC implementation exists; integrated acceptance remains BLOCKED / NOT RELEASE-READY.

> This file consolidates the currently reviewed project facts, architecture, branch policy, milestone status, security invariants, and known limitations. It is not a claim that every Markdown file on every branch has been read. Repository-wide file enumeration for every ref is not exposed by the current connected GitHub actions; existing documentation must not be deleted until a complete branch-by-branch inventory and preservation check can be performed.

## 1. Product goal

JARVIS is a privacy-conscious personal AI assistant intended to start with a secure Windows desktop POC and browser companion/HUD, then expand to Android companion devices and additional capabilities. The initial supported actions are read-only system information and selected installed-application launching. The project must prioritize security, truthful outcomes, explicit approval, and incremental evidence-based delivery over feature breadth.

## 2. Current source and status

- Runtime: Node.js 24 + TypeScript modular monolith.
- Host: Windows 11 target; backend currently loopback-only at `127.0.0.1:3000`.
- Companion: browser-based HUD with text fallback and push-to-talk / Web Speech integration. Browser speech recognition remains browser/vendor-dependent and is not proven local/offline.
- M12 gesture foundation: opt-in browser webcam, same-origin MediaPipe hand landmarks in a worker, HUD-only cursor/gesture previews. It cannot call backend actions. Physical webcam accuracy and target-laptop performance remain unverified; see [M12 status](docs/m12-gesture-spatial-interaction.md).
- Android: separate M9 prototype exists on `new`; it is not integrated with the backend and has not passed physical-device acceptance.
- Overall release status: **BLOCKED — NOT READY**.
- Current remediation evidence is documented in `docs/security-api-feature-audit-2026-10-23.md`, `docs/final-integration-acceptance-2026-10-23.md`, and `docs/traceability-matrix.md`.

## 3. Branch policy

- `main`: production/release; never commit, push, merge, or automate promotion into it. Owner performs any promotion manually from `dev`.
- `dev`: integration branch. Feature/fix/audit branches reach it through pull requests.
- `new`: feature development / historical baseline and separate Android prototype.
- `fix`: current security remediation and regression work.
- `test`: audit baseline and testing evidence.
- `lovable`: partial UI candidate; do not wholesale merge the scaffold.

Do not force-push, rewrite history, discard dirty changes, or delete branches/worktrees without inspection and explicit authorization. PRs from `new`, `fix`, `test`, or other work branches target `dev`, never `main` automatically.

## 4. Architecture and execution flow

Expected lifecycle:

`Request → Device/session authentication → Intent/planner → PolicyGateway → Task-scoped approval when required → Allowlisted adapter → Outcome verification → Audit → User-visible result`

Core areas include `src/core/identity.ts`, `src/core/service.ts`, `src/policy/gateway.ts`, `src/planner/planner.ts`, `src/crypto/crypto.ts`, `src/audit/audit.ts`, `src/verification/verifier.ts`, `src/adapters/windowsAppLauncher.ts`, `src/adapters/windowsSystem.ts`, `src/server/server.ts`, `src/companion/hud.*`, and `src/voice/voiceManager.ts`.

AI output is advisory only and must never authorize or directly execute actions. Every action must pass through the central policy gateway and its authentication, risk, approval, and allowlist rules.

## 5. Security invariants

1. Default-deny authorization; unknown operations are rejected.
2. No arbitrary shell execution, unrestricted scripts, or administrator elevation.
3. Application launching is limited to a fixed allowlist; shell interpolation is prohibited.
4. Task approvals are bound to the action and parameters, expire appropriately, and cannot be reused.
5. Device identities, sessions, permissions, and revocation are independent per device.
6. Revoked/expired sessions cannot authorize new actions; critical actions require stronger confirmation.
7. Audit records are tamper-evident, redacted, and fail closed when integrity or persistence is unhealthy.
8. No action is reported as verified success merely because a request was accepted or a mock returned success.
9. Backend remains loopback-only until remote/mobile transport, enrollment, authorization, and TLS trust are independently implemented and verified.
10. Microphone capture requires explicit activation, visible status, and reliable cancellation. Wake-word listening is disabled by default.
11. No secrets, private keys, tokens, or unnecessary sensitive transcripts in logs or committed files.

## 6. Milestones 1–12 status

Status labels: PASS, PARTIAL, BLOCKED, UNVERIFIED, FAIL. Historical reports are not a substitute for current evidence.

| Milestone | Scope | Current status | Evidence / next gate |
|---|---|---|---|
| M1 | Foundation and project setup | PASS (historical/local evidence) | Revalidate against current committed tree and clean CI. |
| M2 | Secure Windows core | PARTIAL | Verify real target-Windows app launch and all adapter outcomes. |
| M3 | Android enrollment/channel | BLOCKED | Physical Android enrollment and secure transport not accepted. |
| M4 | Approval/task lifecycle | PARTIAL | Local regression evidence exists; finish API contract, owner permissions, and external acceptance. |
| M5 | AI planner integration | PARTIAL | Planner must remain schema-validated and advisory; verify full runtime path. |
| M6 | Verification, hardening, release | PARTIAL | Local checks pass on a dirty tree; exact-commit CI and external gates outstanding. |
| M7 | Security remediation/completion | BLOCKED | Hosted CI, owner Windows acceptance, physical microphone behavior, and remaining security/API gates. |
| M8 | Approved scope unknown | UNVERIFIED / BLOCKED | Approved specification and discovery decisions were not found in reviewed checkout. Do not invent scope. |
| M9 | Android prototype/integration | PARTIAL / BLOCKED | Prototype is separate, unbuilt/unintegrated; backend APIs and device acceptance are missing. |
| M10 | Approved scope unknown | UNVERIFIED / BLOCKED | Find authoritative specification in repository history/branches before implementation. |
| M11 | Approved scope unknown | UNVERIFIED / BLOCKED | Find authoritative specification in repository history/branches before implementation. |
| M12 | Gesture & spatial interaction | PARTIAL | Same-origin local camera/tracking foundation on `new`; 7/7 gesture unit tests and fake-camera Edge lifecycle/local-inference smoke passed. Physical precision/latency, voice arbitration, safe action integration, and hardware acceptance remain open. See [M12 ADR](docs/adr/ADR-006-local-gesture-tracking.md) and [acceptance plan](docs/m12-gesture-spatial-interaction.md). |

## 7. Current local verification evidence (2026-10-23)

Reported on a dirty `fix` working tree based on `9ead85cdacb7e9dedf855605a6d0942760ea3a6f`:

- `npm ci`: PASS.
- `npm run build`: PASS.
- `npm run lint`: PASS (TypeScript no-emit check).
- `npm test`: PASS, 51 tests, 0 failures, 0 skipped.
- `npm run test:browser`: PASS after harness timeout correction; speech recognition simulated.
- `npm audit --audit-level=low`: PASS, 0 reported vulnerabilities.
- `npm ls --depth=0`: PASS.
- Android build/device acceptance: BLOCKED (SDK/tooling and physical devices unavailable).
- Hosted CI for exact tested tree: UNVERIFIED; authenticated CI evidence unavailable, and the harness timing correction was uncommitted in the report.
- Real target-MSI and visible Notepad acceptance: not proven by the above test results; must be verified on the actual Windows runtime.

See `master_repo_test` for the test evidence matrix and limitations.

## 8. Voice/audio status

The browser HUD includes push-to-talk and a voice lifecycle, but browser Web Speech behavior depends on the browser/vendor and has not been proven to be offline/local. Automated browser checks simulate recognition. Physical microphone capture, vendor behavior, real playback, and privacy behavior need target-device acceptance. Ensure permission handling, visible listening/mute state, cancellation, transcript disposal, no duplicate streams/listeners, timeout cleanup, no false speaking/listening animation, and no speech success claims when playback fails.

## 9. Command execution / Notepad regression

A passing unit test or mock is not proof that Notepad visibly opened. Verify the full route from UI/text/voice input through command parsing, session authentication, `PolicyGateway`, approval, the Windows app-launch adapter, OS process start, outcome verification, audit, and response. The Windows backend must be running in the supported Windows environment. WSL/Linux must not silently claim it launched a Windows process. Report `requested`, `awaiting_approval`, `denied`, `failed`, `started`, and `verified` distinctly. A process PID does not alone prove a visible window is ready.

## 10. Android and remote access

The M9 Android prototype is not integrated. It expects security capabilities/task APIs absent from the current backend and must fail closed. Do not expose the loopback backend to LAN or remote clients until authenticated TLS transport, endpoint authorization, enrollment proof-of-possession, request signing/replay prevention, session revocation, role enforcement, and approval contracts are implemented and reviewed. Two-phone isolation requires real two-device testing.

## 11. Lovable candidate

`experiments/lovable-ui-candidate/` is a partial design candidate. Port components selectively only. Do not replace the actual backend, API contracts, security gateway, or production HUD wholesale. UI states must reflect authoritative runtime results.

## 12. POC and POC2 update convention

- `POC.md` records only work implemented and supported by evidence. Distinguish locally tested, committed, and externally accepted work; do not label the overall POC complete while acceptance gates remain blocked.
- `POC2.md` records all incomplete criteria, blockers, unverified behavior, future work already approved, and the exact acceptance evidence required to move an item into POC.
- On every future POC update, re-evaluate both files together, move an item to POC only after evidence supports completion, and keep unresolved work in POC2.

## 13. Documentation consolidation / preservation rule

This master document is intended to be the consolidated project reference. The separate `master_repo_test` file contains test and acceptance evidence. The complete all-branch Markdown/test-file inventory has not yet been retrieved through the connected GitHub actions. Therefore, no broad deletion is claimed or performed by this commit. Do not delete source test code or unique milestone requirements until they have been consolidated and the complete file inventory is verified.

## 14. Future milestone template

Each future milestone requires an approved scope, non-goals, prerequisites, affected modules, security/privacy review, acceptance criteria, unit/integration/E2E/hardware tests, required environment, rollback, documentation, evidence, and a dependency map. A worktree existing is not evidence of milestone completion.

## 15. Device enrollment and owner authentication (implemented locally, 2026-10-24)

- First-owner bootstrap remains a one-time local action authorized by `JARVIS_OWNER_CONTROL_TOKEN`; it is disabled once an active device exists. The bootstrap identity receives the existing management permission to operate owner controls.
- Later enrollment uses a signed, `DEVICE_MANAGE` session and fresh TOTP step-up to create a 120-second transaction. The QR carries a `jarvis://enroll` reference and a 256-bit one-time code. Only the SHA-256 hash is held in transaction state; the raw code is returned to the creator for QR/manual fallback and is never audited.
- The enrolling browser creates an Ed25519 identity and signs a proof bound to transaction id, device name, platform, public-key hash, server-selected permissions, expiry, and the one-time code. Exchange creates a pending request only. A management device must approve the matching request hash with a fresh TOTP step before the identity is created. Reject/cancel/expiry are terminal states.
- Google Authenticator-compatible TOTP uses RFC-style SHA-1, six digits, and 30-second periods through `otpauth`. Validation accepts at most one adjacent step and prevents accepted-step reuse. Five failed codes within 15 minutes lock verification until the window passes. The seed, accepted counter, and failure timestamps are AES-256-GCM encrypted at rest; the encryption key is HKDF-derived from the configured owner control token. Rotating that token makes existing encrypted TOTP state unreadable and requires owner recovery/reset.
- `PolicyGateway` authorizes security controls; `DeviceIdentityManager` remains the source of device/session identity and immediate revocation. The UI lists device/session state, pending requests, least-privilege permissions, QR/manual code, cancellation, approval, rejection, and revocation.
- Enrollment transactions are process-local and expire on access/sweep; restart invalidates in-flight transactions. TOTP state is persisted. Network binding remains `127.0.0.1`; this does not enable Android over LAN or the public internet. Remote phone scanning/approval is blocked pending HTTPS/remote transport design. Manual same-origin browser entry and automated HTTP tests are supported.
- Current local evidence: `npm run build` PASS; `npm run lint` PASS; `npm test` PASS 75/75 when using the temporary Windows `os.userInfo()` compatibility shim; `npm run test:browser` FAILS at the existing voice-recognition timing wait in `test/browser-smoke.mjs:290`; the new TOTP/QR approval workflow is not covered by this browser harness; `npm audit` could not reach the npm advisory endpoint. See `master_repo_test`.
- This implementation is **PARTIAL**, not device-accepted: physical Android/second-browser enrollment, authenticator app scan on a phone, browser camera QR scanning, session expiry/revocation across restart, and hosted CI are not proven by local unit/HTTP tests.
