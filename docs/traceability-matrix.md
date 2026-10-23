> **Current status (2026-10-23): integrated release is BLOCKED — NOT READY.** Milestones 1–7 evidence is summarized in the [acceptance audit](milestones-1-to-7-acceptance-audit.md). M9 prototype source is isolated on `new` and not integrated into `fix`; M8 approval artifacts are absent. Current local checks passed on the dirty `fix` tree based on `9ead85cdacb7e9dedf855605a6d0942760ea3a6f`; this is not hosted-CI or immutable source evidence. See [final integration acceptance](final-integration-acceptance-2026-10-23.md).

# Requirements Traceability Matrix — Historical Baseline and Current Remediation

The authoritative Milestones 1–7 status-by-criterion matrix is in the [current acceptance audit](milestones-1-to-7-acceptance-audit.md). This document retains historical requirement IDs and adds current regression links; historical pass claims below are not a substitute for the current matrix.

## 1. Traceability Mapping

| Requirement ID | Requirement Area | Implementation Module | Automated Test Family | Verification Status |
|---|---|---|---|---|
| **SEC-01** | Unknown, unauthenticated or revoked device rejected | `src/core/identity.ts`, `src/core/service.ts` | `test/core.test.ts: SEC-01` | **PASS (Verified)** |
| **SEC-05** | Public service API cannot expose an adapter dispatcher that bypasses policy | `src/core/service.ts` | `test/core.test.ts: SEC-05` | **PASS (current regression run)** |
| **SEC-06** | Expired sessions are rejected before request processing | `src/core/identity.ts`, `src/core/service.ts` | `test/core.test.ts: SEC-06` | **PASS (current regression run)** |
| **SEC-02** | Task-scoped approvals cannot be reused or expanded | `src/policy/gateway.ts` | `test/core.test.ts: SEC-02` | **PASS (Verified)** |
| **SEC-03** | Prohibited and unmapped operations denied by default | `src/policy/gateway.ts`, `src/planner/planner.ts` | `test/core.test.ts: SEC-03` | **PASS (Verified)** |
| **SEC-04** | Single-use enrollment challenge cannot be reused/expired | `src/core/identity.ts` | `test/core.test.ts: SEC-04` | **PASS (Verified)** |
| **FLOW-01** | Request follows identity → policy → execution → verification | `src/core/service.ts` | `test/core.test.ts: FLOW-01` | **PASS (Verified)** |
| **FLOW-02** | Policy Gateway enforces approval for state-changing app launch | `src/core/service.ts`, `src/adapters/windowsAppLauncher.ts` | `test/core.test.ts: FLOW-02` | **PASS (Verified)** |
| **AUD-01** | Tamper-evident audit log maintains cryptographic hash chain | `src/audit/audit.ts` | `test/core.test.ts: AUD-01` | **PASS (Verified)** |
| **SEC-HARD-01** | Rejection of malformed / invalid Ed25519 public keys | `src/crypto/crypto.ts`, `src/core/identity.ts` | `test/hardening.test.ts: SEC-HARD-01` | **PASS (Verified)** |
| **SEC-HARD-02** | Single-use approval consumption prevents approval replay | `src/policy/gateway.ts` | `test/hardening.test.ts: SEC-HARD-02` | **PASS (Verified)** |
| **SEC-HARD-03** | Multi-device independence (2 phones, independent identities & revocation) | `src/core/identity.ts`, `src/core/service.ts` | `test/hardening.test.ts: SEC-HARD-03` | **PASS (Verified)** |
| **SEC-HARD-04** | Approval/rejection service methods require an authenticated active session; revoked approvers are denied | `src/core/service.ts` | `test/hardening.test.ts: SEC-HARD-04` | **PASS (current regression run)** |
| **SEC-HARD-05** | AI Planner schema validation & rejection of adversarial command injection | `src/planner/planner.ts`, `src/core/service.ts` | `test/hardening.test.ts: SEC-HARD-05` | **PASS (Verified)** |
| **SEC-HARD-06** | Tamper detection: detecting modified records and broken hash chains | `src/audit/audit.ts` | `test/hardening.test.ts: SEC-HARD-06` | **PASS (Verified)** |
| **SEC-HARD-07** | Server route session authentication on approval & revocation endpoints | `src/server/server.ts` | `test/hardening.test.ts: SEC-HARD-07` | **PASS (Verified)** |
| **SEC-HARD-08** | Rejection of stale timestamps (> 60s) and replay session requests | `src/core/identity.ts` | `test/hardening.test.ts: SEC-HARD-08` | **PASS (Verified)** |
| **E2E-LIVE-01** | Full live HTTP runtime lifecycle against running server endpoint | `src/server/server.ts`, `src/core/service.ts` | `test/e2e_recovery.test.ts: E2E-LIVE-01` | **PASS (Verified)** |
| **RECOVER-01** | Persistent device revocation across host server restart | `src/core/identity.ts`, `src/server/server.ts` | `test/e2e_recovery.test.ts: RECOVER-01` | **PASS (Verified)** |
| **RECOVER-02** | Fail-closed execution block on compromised audit chain | `src/audit/audit.ts`, `src/core/service.ts` | `test/e2e_recovery.test.ts: RECOVER-02` | **PASS (Verified)** |
| **VOICE-01** | Privacy guarantee: no continuous capture or wake-word listening by default | `src/voice/voiceManager.ts` | `test/voice_hud.test.ts: VOICE-01` | **PASS (Verified)** |
| **VOICE-02** | Push-to-talk activation and transcript lifecycle | `src/voice/voiceManager.ts` | `test/voice_hud.test.ts: VOICE-02` | **PASS (Verified)** |
| **VOICE-03** | Mute privacy control halts capture and refuses microphone start | `src/voice/voiceManager.ts` | `test/voice_hud.test.ts: VOICE-03` | **PASS (Verified)** |
| **VOICE-04** | Cancellation discards in-flight transcript immediately | `src/voice/voiceManager.ts` | `test/voice_hud.test.ts: VOICE-04` | **PASS (Verified)** |
| **HUD-01** | Server serves Cinematic HUD assets at /hud endpoint | `src/server/server.ts`, `src/companion/hud.html` | `test/voice_hud.test.ts: HUD-01` | **PASS (Verified)** |
| **FLOW-03** | Partial adapter evidence is not reported as complete/verified | `src/core/service.ts`, `src/core/types.ts` | `test/core.test.ts: FLOW-03` | **PASS (current automated run)** |
| **FLOW-04** | Interrupted execution reports an uncertain outcome | `src/core/service.ts`, `src/adapters/windowsAppLauncher.ts`, `src/adapters/windowsSystem.ts` | `test/core.test.ts: FLOW-04` | **PASS (current automated run)** |
| **FLOW-05** | Completion audit persistence failure reports recovery-required | `src/core/service.ts` | `test/core.test.ts: FLOW-05` | **PASS (current automated run)** |
| **AUD-02** | Nested, text, and legacy audit data is redacted | `src/audit/audit.ts` | `test/audit.test.ts: AUD-02` | **PASS (current automated run)** |
| **AUD-03** | Truncated audit data fails closed | `src/audit/audit.ts` | `test/audit.test.ts: AUD-03` | **PASS (current automated run)** |
| **AUD-04** | Unavailable audit storage blocks further records | `src/audit/audit.ts` | `test/audit.test.ts: AUD-04` | **PASS (current automated run)** |
| **AUD-05** | Runtime audit-file tampering is detected before append | `src/audit/audit.ts` | `test/audit.test.ts: AUD-05` | **PASS (current automated run)** |
| **SEC-API-00/10** | Enrollment requires owner authorization and proof of private-key possession | `src/server/server.ts`, `src/core/identity.ts` | `test/e2e_recovery.test.ts: SEC-API-00, SEC-API-10` | **PASS (current automated run)** |
| **SEC-API-01** | Legacy HUD session bootstrap cannot bypass device-bound authentication | `src/server/server.ts` | `test/e2e_recovery.test.ts: SEC-API-01` | **PASS (current automated run)** |
| **SEC-API-02/03/06/13** | Status is minimal; audit is authenticated, permission-gated, redacted | `src/server/server.ts`, `src/audit/audit.ts` | `test/e2e_recovery.test.ts: SEC-API-02/03/06/13` | **PASS (current automated run)** |
| **SEC-API-04/05** | JSON media type, payload shape, and request size are validated | `src/server/server.ts` | `test/e2e_recovery.test.ts: SEC-API-04/05` | **PASS (current automated run)** |
| **SEC-API-07/08/09** | Signed session/request freshness, body binding, and nonce replay are enforced | `src/server/server.ts`, `src/core/identity.ts` | `test/e2e_recovery.test.ts: SEC-API-07/08/09` | **PASS (current automated run)** |
| **SEC-API-11/12** | Unknown approvals and cross-device revocation are safely rejected | `src/server/server.ts`, `src/core/service.ts` | `test/e2e_recovery.test.ts: SEC-API-11/12` | **PASS (current automated run)** |
| **SEC-API-14** | Expired approval is rejected over HTTP without execution | `src/server/server.ts`, `src/policy/gateway.ts` | `test/e2e_recovery.test.ts: SEC-API-14` | **PASS (current regression run)** |
| **RECOVER-03** | Corrupt persisted device state blocks sensitive onboarding | `src/core/identity.ts` | `test/e2e_recovery.test.ts: RECOVER-03` | **PASS (current automated run)** |
| **SERVER-01** | Listener startup failures reject rather than hang | `src/server/server.ts` | `test/server_lifecycle.test.ts: SERVER-01` | **PASS (current regression run)** |
| **SERVER-02** | Stop is safe before startup and after the server has stopped | `src/server/server.ts` | `test/server_lifecycle.test.ts: SERVER-02` | **PASS (current regression run)** |
| **BROWSER-01** | Browser enrollment, signed actions, XSS, CSP/runtime errors, reduced motion | `src/companion/hud.html`, `hud.js`, `hud.css`, `src/server/server.ts` | `test/browser-smoke.mjs` | **PASS in Microsoft Edge; speech recognition simulated** |
| **BROWSER-02** | Uncertain approval outcome is never rendered as verified success | `src/companion/hud.js` | `test/browser-smoke.mjs` | **PASS in Microsoft Edge; approval response intercepted** |
| **BROWSER-03** | Recognizer permission error is surfaced and leaves text fallback available | `src/companion/hud.js` | `test/browser-smoke.mjs` | **PASS in Microsoft Edge; recognizer error simulated** |

---

## 2. Historical Test Execution Evidence (superseded)

```text
> jarvis-core@0.1.0 test
> node --test --import tsx test/**/*.test.ts

▶ JARVIS Core Security & Lifecycle Verification
  ✔ SEC-01: Unknown, unauthenticated or revoked device is rejected (33.87ms)
  ✔ FLOW-01: End-to-end happy path for allowlisted read-only system information (26.84ms)
  ✔ FLOW-02: Policy Gateway enforces approval for state-changing app launch (1077.87ms)
  ✔ SEC-02: Scope expansion or altered parameters voids approval (14.84ms)
  ✔ SEC-03: Prohibited and unmapped operations are denied by default (13.13ms)
  ✔ SEC-04: Single-use enrollment challenge cannot be reused or redeemed after expiry (13.64ms)
  ✔ AUD-01: Tamper-evident audit log maintains verifiable cryptographic hash chain (26.80ms)
✔ JARVIS Core Security & Lifecycle Verification (1211.55ms)

▶ JARVIS Milestone 6: Live HTTP Runtime, Recovery & Persistence Verification
  ✔ E2E-LIVE-01: Full HTTP Lifecycle (Status -> Challenge -> Enroll -> Auth -> Request -> Approve -> Launch -> Revoke) (1262.11ms)
  ✔ RECOVER-01: Persistent device revocation remains enforced after server restart (24.86ms)
  ✔ RECOVER-02: Compromised audit chain causes fail-closed execution block (21.68ms)
✔ JARVIS Milestone 6: Live HTTP Runtime, Recovery & Persistence Verification (1310.83ms)

▶ JARVIS Milestone 5: Security Hardening, Multi-Device & Negative Verification
  ✔ SEC-HARD-01: Malformed and invalid public keys are rejected during enrollment (34.58ms)
  ✔ SEC-HARD-02: Single-use approval consumption prevents approval reuse/replay attack (1039.29ms)
  ✔ SEC-HARD-03: Multi-device independence — revoking Phone A leaves Phone B active (3611.30ms)
  ✔ SEC-HARD-04: Approver verification — unauthorized or revoked phone cannot approve tasks (53.10ms)
  ✔ SEC-HARD-05: AI Planner schema validator rejects invalid operations and adversarial injections (39.19ms)
  ✔ SEC-HARD-06: Tamper detection — detecting file modification and broken hash chain (26.13ms)
  ✔ SEC-HARD-07: HTTP Server enforces session authentication on approval and revocation routes (187.21ms)
  ✔ SEC-HARD-08: Stale and replay session requests are rejected (25.67ms)
✔ JARVIS Milestone 5: Security Hardening, Multi-Device & Negative Verification (5021.13ms)

▶ JARVIS Milestone 7: Voice Privacy, Push-to-Talk Lifecycle & HUD Routing
  ✔ VOICE-01: Privacy guarantee — no continuous capture or wake-word by default (50.89ms)
  ✔ VOICE-02: Push-to-talk activation and transcript lifecycle (6.29ms)
  ✔ VOICE-03: Mute privacy control halts capture and refuses start (7.07ms)
  ✔ VOICE-04: Cancellation discards in-flight transcript immediately (3.47ms)
  ✔ HUD-01: Server serves Cinematic HUD assets at /hud endpoint (96.40ms)
✔ JARVIS Milestone 7: Voice Privacy, Push-to-Talk Lifecycle & HUD Routing (168.05ms)

ℹ tests 23
ℹ suites 4
ℹ pass 23
ℹ fail 0
ℹ duration_ms 5806.59ms
```


## 3. Remediation coverage added on `fix` (not a completion sign-off)

The current remediation branch adds regression coverage for:

- Enrollment challenge owner-token authorization and enrollment proof-of-possession.
- Legacy HUD session bootstrap fails closed instead of minting a session.
- Public status endpoint exposes only minimal health state and reports `DEGRADED` when audit or persisted identity state is unhealthy.
- Audit endpoint rejects unauthenticated and insufficiently privileged access.
- API malformed JSON, non-JSON content type, null/non-object bodies, oversized payloads, missing fields, unknown paths, and wrong methods.
- Signed session creation and protected API requests: timestamp freshness, nonce replay, signature validation, and exact-body binding.
- Approval rejection for unknown IDs and prevention of unauthorized cross-device revocation.
- Corrupt persisted device state blocks enrollment/session creation and reports degraded health.
- HUD/companion static checks: CSP, unsafe HTML sink/inline-handler regressions, shared WebCrypto client, and voice timeout/privacy disclosure.

**Historical hosted verification:** [Windows CI run](https://github.com/Guda-Abhishek/JARVIS/actions/runs/39915715819) on `fix` commit `867747b780a5b1470cf9dcb12f9894bdb09b4639` passed build, TypeScript check, and **38 tests (0 failed, 0 skipped)**. This does not validate the current dirty working tree, interactive physical microphone, native Android/two-phone, or owner-device acceptance. Milestone 7 remains **BLOCKED — NOT COMPLETE**.

## 4. Current Local Verification Evidence — 2026-10-23

The following checks were rerun on the current dirty working tree, whose `HEAD` and `origin/fix` are `9ead85cdacb7e9dedf855605a6d0942760ea3a6f`. Because the remediation is uncommitted, this SHA identifies the base revision, not an immutable copy of the tested source.

| Command | Result |
|---|---|
| `npm run build` | PASS |
| `npm run lint` | PASS (`tsc --noEmit`) |
| `npm test` | PASS — 51 tests, 0 failures, 0 skipped; sandbox attempt hit Node `uv_os_get_passwd` ENOMEM, retry outside sandbox passed |
| `npm run test:browser` | PASS — Edge against local server; harness timeout clock corrected from 200 ms to 5 seconds; Web Speech mocked |
| `npm audit --audit-level=low` | PASS — 0 vulnerabilities; approved retry after sandbox registry access failure |

Environment: Windows 11 Home (build 26300), Node `v24.16.0`, npm `11.13.0`, PowerShell `7.6.7`, Microsoft Edge `155.0.4283.62`. `gh run list --branch fix --limit 10` stopped because `gh` is not authenticated. Ubuntu WSL 2 is installed but has no Linux `node` executable; no WSL test ran. Physical microphone/vendor recognition, Android build, two-phone, and owner-device acceptance are not represented by these results. The exact tested source tree remains uncommitted; `9ead85cdacb7e9dedf855605a6d0942760ea3a6f` is its base commit only. M9 source is isolated in the `new` worktree and has not been merged or built.
