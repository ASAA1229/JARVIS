# JARVIS Security, API, Endpoint and Feature Audit

- **Audit date:** 2026-10-23
- **Audited source ref:** `new` at `a125e1be891edd1c6198be76e0d534366c728cb3`
- **Audit branch:** `test`
- **Scope:** source-level review of API routes, cryptographic identity/session flow, policy/approval lifecycle, execution adapters, verification, audit logging, HUD, voice lifecycle, persistence and automated-test coverage.
- **Execution status:** **STATIC REVIEW ONLY — runtime tests were not executed during this audit session.** The existing traceability matrix contains a historical report of 23 passing tests, but that output was not independently reproduced here. No finding below should be treated as runtime-verified.
- **Release recommendation:** **BLOCKED.** Do not advance Milestone 7 or merge to `main`.

## 1. Executive result

The repository has meaningful baseline tests for device enrollment, Ed25519 signatures, session freshness, policy allowlisting, approval replay, multi-device revocation, audit-chain tampering, HTTP request lifecycle and HUD asset routing. However, coverage is not yet sufficient to claim that every API, endpoint, key-handling path, browser interaction and failure state has been tested.

The most urgent findings are:
1. **Critical — HUD session authentication bypass:** `POST /api/hud/session` directly inserts a session into the identity manager's private session map and returns it without proof-of-possession of the device private key.
2. **Critical — unsafe HUD HTML rendering:** `src/companion/hud.js` uses `innerHTML` to render request text and approval messages, and embeds approval IDs in inline event handlers.
3. **High — unauthenticated sensitive endpoints:** `GET /api/status` exposes device records and audit-integrity details; `GET /api/audit` exposes recent audit records without session authentication. Enrollment challenge creation and redemption also lack owner step-up authorization at the HTTP boundary.
4. **High — approval authorization binding requires further enforcement:** approval records are created for a task/device/scope, but `resolveApproval` does not itself verify that the approver is authorized for that specific approval or that the approval is still pending/unresolved. The service does check that an approver device is active, but authorization semantics need explicit tests and policy.
5. **High — HTTP error and payload handling:** malformed JSON/oversized payload handling, content types, method mismatches, missing fields, response codes, and server error leakage need tests and hardening. The body reader can reject on an oversized payload and still receive later stream events.
6. **High — voice privacy/lifecycle mismatch:** the browser Web Speech API lifecycle is separate from `VoiceManager`; the 15-second capture timeout in the manager does not prove the browser recognizer stops after 15 seconds. Browser speech may use a vendor/remote service, and local-only processing is not established.
7. **High — HUD outcome reporting:** approval UI behavior must be driven by validated HTTP status and authoritative backend state. Approval accepted is not equivalent to execution verified.
8. **High — persistence failure handling:** identity persistence currently swallows read/write errors; startup can continue without clearly reporting corrupted state or failed persistence.
9. **High — no reproducible CI evidence for the audited SHA:** the connector returned no workflow runs and no combined status entries for the audited commit. This is not proof that CI is disabled; it means this audit could not verify CI evidence.

## 2. Evidence and limitations

### Evidence reviewed
- `src/server/server.ts`
- `src/core/identity.ts`
- `src/core/service.ts`
- `src/policy/gateway.ts`
- `src/planner/planner.ts`
- `src/crypto/crypto.ts`
- `src/audit/audit.ts`
- `src/verification/verifier.ts`
- `src/adapters/windowsAppLauncher.ts`
- `src/adapters/windowsSystem.ts`
- `src/companion/hud.html`, `hud.js`, `hud.css`
- `src/voice/voiceManager.ts`
- `test/core.test.ts`, `test/hardening.test.ts`, `test/e2e_recovery.test.ts`, `test/voice_hud.test.ts`
- `package.json`, `tsconfig.json`, `docs/traceability-matrix.md`, `docs/poc-completion-report.md`

### Limitations
- No local checkout/runtime was available in this execution context, so no Node test suite, TypeScript build, browser automation, OS-specific process launch, fuzz test, or live HTTP probe was run.
- Existing test logs copied into documentation are historical repository evidence, not independent results from this audit.
- Windows-specific adapter behavior cannot be confirmed on the target MSI without running on Windows 11.
- Browser speech recognition behavior varies by browser/vendor; no claim of local/offline speech processing is justified by source inspection alone.

## 3. API and endpoint coverage matrix

| Endpoint / route | Existing evidence | Missing tests / risk | Audit status |
|---|---|---|---|
| `GET /`, `GET /index.html` | Static asset route logic exists | Status/content type, missing asset, path traversal, browser console, accessibility | Not runtime-tested |
| `GET /style.css`, `GET /app.js` | Static asset route logic exists | Same static route checks; MIME and CSP behavior | Not runtime-tested |
| `GET /hud`, `GET /hud/index.html` | HUD asset smoke test checks HTML marker | CSP, DOM behavior, keyboard/touch, missing JS/CSS, injection regression | Partial source/test coverage |
| `GET /hud/hud.css`, `GET /hud/hud.js` | HUD asset smoke test checks CSS/JS markers | Browser execution, no console errors, CSP compatibility | Partial source/test coverage |
| `GET /api/status` | E2E checks ONLINE and audit integrity | Authentication/authorization; avoid exposing full device records, key metadata or internal status; compromised audit state behavior | High-risk gap |
| `POST /api/enrollment/challenge` | E2E obtains a challenge | Unauthorized caller can mint challenges; rate limits, step-up, validation and audit failure paths | High-risk gap |
| `POST /api/enrollment/redeem` | E2E valid enrollment; unit tests invalid key and single-use challenge | Missing/empty/wrong-type fields, expired challenge, duplicate device, challenge race, device name bounds, unauthorized enrollment | Partial coverage |
| `POST /api/hud/session` | No direct security regression test identified | **Direct private session-map mutation bypasses signed session establishment**; unauthorized local origin/session creation; key lifecycle | **Critical blocker** |
| `POST /api/session` | Valid signature and stale timestamp tested through core/E2E | Invalid signature, unknown/revoked device, malformed timestamp/signature, replay/nonce semantics, session expiry, malformed body/status codes | Partial coverage |
| `POST /api/request` | E2E and missing-session test | Invalid session, oversized/malformed JSON, missing/empty/non-string text, huge text, rate limiting, concurrency, correct HTTP status on auth failure | Partial coverage |
| `POST /api/approval/approve` | E2E approval and unauthenticated rejection test | Unknown/expired/rejected/replayed approval over HTTP, cross-device policy, parameter tampering, HTTP status/body truthfulness | Partial coverage |
| `POST /api/approval/reject` | Route exists | No dedicated route-level test found; duplicate/expired/unknown approval; resulting task state and audit event | Gap |
| `POST /api/device/revoke` | E2E revoke and unauthenticated route test | Self-revocation semantics, nonexistent device, revoked caller, cross-device authorization, persistence failure, active-task interruption, HTTP status | Partial coverage |
| `GET /api/audit` | Route exists | **Unauthenticated audit exposure**; authorization, redaction, pagination, integrity state, retention, oversized response | High-risk gap |
| Unknown paths/methods | 404 fallback exists | Wrong method on known path, OPTIONS behavior, unsupported content type, malformed URL | Gap |
| All HTTP error paths | Catch-all 500 exists | Internal exception leakage; auth errors currently can become 500 from `/api/request`; stable error schema/status map | High-risk gap |

## 4. Cryptographic keys, identity and session checks

| Area | Existing tests/evidence | Additional tests required | Status |
|---|---|---|---|
| Ed25519 keypair generation/signature verification | Valid signed session path exists | Wrong private key, signature bit-flip, wrong key type/curve, malformed PEM, public/private key mismatch | Partial |
| Public key validation | Malformed key tests exist | Boundary/oversized key input, duplicate public key enrollment, canonical PEM variations | Partial |
| Device ID derivation | Derived from SHA-256 of public key | Duplicate key must not overwrite identity or permissions; collision/duplicate handling | Gap |
| Enrollment challenge | Single-use behavior tested | Expiry at boundary, concurrent redemption race, token entropy/size, invalid permissions, cleanup of expired challenges | Partial |
| Session creation | Fresh signed timestamp tested | Signature replay within freshness window; nonce/challenge; expiry; TTL bounds; unknown/revoked device; session ID entropy | Partial |
| Session validation | Invalid/revoked session tested | Expired session, malformed session ID, device status change, stale last-seen handling | Partial |
| Session revocation | Device revoke test exists | Persistence failures and concurrent request-vs-revoke race | Partial |
| Private key handling | Test checks logs do not contain literal `privateKey` field | Prove private keys are never accepted/stored/logged server-side; browser key storage and origin isolation review | Partial |
| Request canonicalization | ADR-004 documents canonical signed request format | Verify implementation actually uses the documented METHOD/PATH/SESSION/TIMESTAMP/NONCE/BODY hash contract on every authenticated request | Unverified |

## 5. Core features and execution behavior

| Feature | Existing coverage | Additional checks required | Status |
|---|---|---|---|
| Default-deny policy | Unknown/prohibited operation tests | Unknown operation over every entry path; bypass attempts; permission matrix per device | Partial |
| Permission enforcement | Required permission checked in gateway | Device with no permissions; only read permission; only launch permission; malformed permission state | Partial |
| Parameter allowlists | Scope-expansion test exists | Extra parameters, wrong types, empty strings, path/drive injection, case variants, nested objects, prototype-like keys | Partial |
| Task-scoped approval | Scope hash and single-use tests | Wrong approver, approval bound to different task/device, rejected/expired/duplicate resolution, simultaneous approvals | Partial |
| Planner/schema validation | Adversarial operation test exists | Null/non-object plan, too many operations, oversized strings/objects, extra fields, missing fields, provider exception, timeout | Partial |
| Windows OS/system facts | Read-only happy path | Actual Windows 11 results, unavailable battery, disk-drive invalid input, platform fallback, permission denied | Not target-runtime-tested |
| App launcher | Notepad/Calculator path tested in E2E documentation | App allowlist bypass, invalid app ID, process PID race, multiple matching processes, launch failure, non-Windows host behavior | Not target-runtime-tested |
| Outcome verification | Verifier module and completion report | Verified success/failure/partial/uncertain for each adapter; stale PID; process starts then exits; exception after side effect | Partial |
| Task interruption/revocation | Service interruption function exists | Verify signal reaches real adapter; revoke during execution; race before/after launch; reconcile side effects | Gap |
| Audit chain | Tamper detection and fail-closed test reported | Restart verification, truncated/corrupt file, write failure, secret patterns, concurrent writes, disk full, append failure | Partial |
| Persistent device state | Restart revocation test reported | Corrupt JSON, partial writes, permissions, atomic write, failure reporting, simultaneous update loss | Partial |
| UI approval/task feed | HUD source reviewed | DOM XSS, duplicate cards, network failure, HTTP non-2xx, stale approvals, correct final state | High-risk gap |
| Voice push-to-talk | VoiceManager unit tests | Real browser recognizer timeout, mute during capture, release/cancel, late result after cancel, denied permission, browser errors | High-risk gap |
| Text fallback | UI code exists | Browser without SpeechRecognition, text submit while voice unavailable, keyboard behavior and empty text | Partial |
| Accessibility/reduced motion | Toggle and keyboard handlers exist | Focus visibility, screen-reader labels, Spacebar while typing in all controls, motion truly stops timers/animation | Gap |

## 6. Severity-ranked findings

### F-01 — Critical: HUD session provisioning bypasses cryptographic authentication
**Location:** `src/server/server.ts`, `POST /api/hud/session`.

The endpoint creates a new device keypair but does not retain the private key for proof-of-possession, then writes an active session directly into `(identity as any).sessions`. It bypasses `DeviceIdentityManager.createSession`, making possession of the enrolled private key irrelevant to this session. Loopback-only binding is defense-in-depth, not a replacement for session authentication.

**Required fix:** remove direct private-map mutation. Define a secure local-HUD identity lifecycle with controlled key custody and signed session establishment through the same public authentication path as other devices. Do not return private key material to the browser. Add tests for unauthorized session creation, missing/wrong signature, revocation, expiry and direct-map bypass regression.

### F-02 — Critical: potential DOM XSS in HUD
**Location:** `src/companion/hud.js`.

Approval cards interpolate request text and server messages into `innerHTML`, with inline `onclick` handlers. Feed/response paths also require a complete sink audit. Directive text may originate from the user, and server responses are not safe HTML by default.

**Required fix:** create DOM nodes, set untrusted strings via `textContent`/form values, bind event listeners programmatically, remove inline handlers, and strengthen CSP to avoid `unsafe-inline`. Add payload regression tests such as `<img src=x onerror=alert(1)>` and quotes/markup in approval IDs/messages.

### F-03 — High: unauthenticated audit and status exposure
**Location:** `src/server/server.ts`, `GET /api/audit` and `GET /api/status`.

These routes return internal operational information without session validation. Status returns full device records. Audit events may contain request content or metadata even when secrets are redacted.

**Required fix:** require appropriate authenticated/authorized access or return a strictly minimal public health response. Redact data at the response boundary, not only at log write time. Add unauthenticated, revoked-session and least-privilege tests.

### F-04 — High: enrollment endpoints lack owner authorization and abuse controls
**Location:** `/api/enrollment/challenge` and `/api/enrollment/redeem`.

Challenge creation and redemption are not authenticated at the HTTP boundary. On the loopback-only host this still permits local processes or browser-origin attacks to attempt enrollment.

**Required fix:** bind enrollment to a verified owner control flow, use one-time short TTL challenge, origin/CSRF protections where applicable, rate limiting, bounded fields, audit failure cases, and explicit owner confirmation before adding a new device.

### F-05 — High: approval resolution lacks explicit authorization/state binding
**Location:** `src/policy/gateway.ts`, `resolveApproval`; `src/core/service.ts`, `approveTask`/ `rejectTask`.

Approver activity is checked in the service, but resolution itself does not validate that the approval is still pending and belongs to the expected target task/device or enforce a clear owner/delegated approver policy. The reject path should also check the result of `resolveApproval` rather than proceeding as if resolution succeeded.

**Required fix:** centralize approval state transitions; require pending/unexpired/unconsumed status, bind approver eligibility and target scope, atomically consume approval before execution, reject repeated resolution, and test concurrency/replay/cross-device cases.

### F-06 — High: browser voice capture lacks a shared hard timeout/privacy lifecycle
**Location:** `src/voice/voiceManager.ts` and `src/companion/hud.js`.

The manager timeout and browser recognizer are separate. The UI starts/stops Web Speech directly, so the manager's 15-second bound does not establish an actual browser capture timeout. Cancel/mute can also race with late recognition events.

**Required fix:** one lifecycle controller for start, stop, timeout, cancel, mute, permission denial, error and late results. Ensure every exit path calls `stop()`/`abort()`, discards stale transcripts, and has a regression test.

### F-07 — High: cloud speech processing disclosure is not established
**Location:** browser SpeechRecognition integration and privacy notice.

The browser implementation does not prove audio is processed locally. Avoid claiming local/offline speech processing. Provide a clear notice before enabling browser speech, preserve text fallback, and evaluate a local engine as a separate decision.

### F-08 — High: approval UI can misreport execution state
**Location:** HUD approval handler and feed rendering.

The UI must not equate an HTTP response, approval acceptance, or card removal with verified execution. Non-2xx responses, malformed JSON and network timeouts need explicit handling. Unknown outcomes must be shown as uncertain and reconciled, not success.

### F-09 — High: persistence errors are swallowed
**Location:** `src/core/identity.ts`, `loadState` and `persistState`.

State-file parse/write failures are caught without surfaced fail-closed state. A failed write could make revocation appear successful in memory while not surviving restart.

**Required fix:** expose a health/error state, fail closed for sensitive operations when persistence integrity is unknown, write atomically, verify after writes as appropriate, and add corrupt-file/read-only-directory/disk-failure tests.

### F-10 — High: HTTP validation/status contract is incomplete
**Location:** `src/server/server.ts`.

Malformed JSON and oversize requests can reach the generic catch-all and return 500. Authentication exceptions from `/api/request` can also become 500 rather than 401. Returning `String(err)` risks leaking internal implementation details.

**Required fix:** validate schemas and content types before business logic; enforce request-size limits safely; return stable 400/401/403/404/409/413/500 codes; do not return raw exception text to clients; test each route's negative response contract.

### F-11 — High: no verified CI execution for audited SHA
**Evidence:** no workflow run/status was returned by the connector for `a125e1be891edd1c6198be76e0d534366c728cb3`.

**Required fix:** run tests and typecheck in a local runtime or configured CI, save the exact commit SHA, command, timestamp, Node version, exit code, and raw output. Add browser/E2E coverage and ensure CI runs on PRs to `dev`.

### F-12 — Medium: HTTP response semantics and route completeness
Cover OPTIONS/unsupported methods, missing fields, invalid field types, empty request, unknown device, nonexistent target device, duplicate enrollments, duplicate task resolution, audit pagination, response cache headers, security headers and unsupported content type.

### F-13 — Medium: audit coverage and redaction tests are too narrow
Test tokens, PEM/private keys, passwords, auth headers, query strings, multiline secrets, nested objects, Unicode, malformed values, and secrets in exception messages. Verify redaction in both persisted logs and API responses.

### F-14 — Medium: keyboard/touch/accessibility and reduced motion
Test pointer-up outside button, touch cancellation, repeated key events, Spacebar in every editable control, Escape during processing, focus visibility, labels/announcements, reduced-motion preference, and stopping canvas animation rather than only toggling a CSS class.

## 7. Required test plan before declaring Milestone 7 complete

### A. Build and static checks
- `npm ci`
- `npm run build`
- `npm run lint`
- `npm test`
- Check for unused imports, type escapes/casts such as `as any`, unsafe sinks, inline handlers, unhandled promise rejections, and accidental generated/runtime files.

### B. API contract tests for every route
For each route, exercise: valid request, missing authentication, invalid/revoked/expired session where applicable, malformed JSON, missing required field, wrong field type, oversized body, unsupported content type, unexpected method, unknown resource, backend exception, and correct response status/body. Verify no raw secrets or stack traces are returned.

### C. Identity and cryptographic tests
Valid enrollment; invalid key; wrong signer; signature tampering; stale timestamp; replay; expired session; duplicate public key; challenge reuse/expiry/race; session revocation; persisted revocation after restart; invalid/corrupt state file; each phone independent; device permissions enforced per capability.

### D. Policy and approval abuse tests
Default-deny unknown operation; permission absent; extra parameter; wrong parameter type; altered target/hash; approval expired/rejected/replayed; concurrent duplicate approval; wrong approver; revoked approver; cross-device approval; revocation between approval and execution; policy gateway bypass attempt; planner prompt injection and malformed output.

### E. Execution and outcome verification
All supported OS queries; invalid drive; missing battery; app allowlist positive and negative cases; process launch failure; PID verification; process exit/race; adapter exception; uncertain result; partial result; interruption and recovery; no false success after timeout/disconnect.

### F. Audit and persistence
Hash chain valid/tampered/truncated; restart; corrupt persisted state; write failure; concurrent records; redaction across nested fields; status/audit endpoint access control; retention/size bounds; fail closed before state-changing work when integrity cannot be established.

### G. Browser HUD and voice
Run browser automation against the real server. Verify all static assets load, no console errors, no XSS, no inline handler dependency, correct CSP, no stale approvals, accurate HTTP errors, transcript confirmation/edit/cancel, timeout, release-to-stop, Escape cancel, mute while recording, permission denied, recognizer error, unsupported browser text fallback, late result disposal, clear cloud speech disclosure, reduced motion, keyboard/touch and focus behavior.

### H. Windows 11 target checks
On the MSI: run read-only system info, RAM, battery and C: disk queries; launch each allowlisted app; verify process PID and outcome; verify no shell is invoked; test unavailable battery/permissions; measure latency and memory; test startup/shutdown and audit persistence. Do not treat a non-Windows test host as evidence for Windows behavior.

## 8. Acceptance gates

Milestone 7 stays **INCOMPLETE / BLOCKED** until all conditions hold:
- [ ] F-01 and F-02 fixed and regression-tested.
- [ ] F-03 through F-10 fixed or explicitly dispositioned with owner approval and compensating controls; no critical/high unaccepted findings.
- [ ] Full automated suite rerun from the exact fix commit; no failures/skips without explanation.
- [ ] TypeScript build and lint pass.
- [ ] All HTTP endpoints have contract tests and security-negative tests.
- [ ] Browser E2E confirms voice lifecycle, CSP/XSS safety and truthful task status.
- [ ] Windows 11 runtime checks recorded separately from generic CI.
- [ ] Traceability matrix updated to distinguish implemented, automated-tested, runtime-tested and not tested.
- [ ] Audit evidence references exact commit SHA, environment, commands and outputs.
- [ ] Fixes are committed/pushed to `fix`; audit remains on `test`; PRs target `dev` only when checks pass.
- [ ] `main` remains untouched; no automated merge.

## 9. Next actions

1. Use this report as the baseline audit record on `test`.
2. Switch to `fix` and remediate in order: F-01 session bypass, F-02 XSS, F-03/04 endpoint authorization, F-05 approval state machine, F-06/07 voice lifecycle/privacy, F-08 outcome reporting, F-09 persistence fail-closed behavior, F-10 HTTP validation.
3. Add tests alongside each fix; do not mark unexecuted tests as passing.
4. Run the complete suite in an actual Node/Windows-compatible environment and attach raw evidence.
5. Push the fixes to `fix`; stop before merging to `dev` or `main` unless the required review/acceptance gate is met.
