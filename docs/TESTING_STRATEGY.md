# JARVIS — Comprehensive Testing Strategy

**Target branch:** `test`  
**Purpose:** Stop feature work and validate the current JARVIS codebase from unit level through device and release acceptance.  
**Status:** Test cases are being authored. This document does not claim that any new test has passed.

## 1. Test levels and techniques

| Level / technique | Scope | Primary method | Evidence required |
|---|---|---|---|
| Static analysis | TypeScript, Python, Kotlin, config, scripts | Type checks, lint, compiler diagnostics, secret scan | Exact-head logs |
| Unit | Pure functions, parsers, planners, validators | Node test runner, Python unittest, Android local unit tests | Pass/fail + coverage |
| Component | Adapters, memory stores, policy, sync, voice | Fakes, temporary directories, deterministic clocks | Assertions and failure-path output |
| Integration | HTTP routes, persistence, device/session, planner/executor | In-process server, isolated temp state, contract tests | Request/response traces with secrets redacted |
| API contract | Every route, method, schema, status, auth boundary | Positive/negative contract matrix | OpenAPI/route inventory or test assertions |
| Security | Authentication, authorization, replay, injection, data leakage | Negative tests, fuzzing, abuse cases, dependency audit, SAST | Findings with severity and remediation |
| Regression | Previously fixed incidents and recent feature increments | Focused deterministic tests | Repro case linked to test |
| E2E | HUD → planner → policy → approval → adapter → verified result | Browser automation and controlled test doubles | Traceable task/audit/evidence IDs |
| Desktop acceptance | Windows 11 host, app identity, focus, UI Automation | Manual + scripted MSI laptop runs | Screen recording/logs and expected-vs-actual |
| Android acceptance | Native companion, Keystore, session, sync, owner panels | Gradle tests, emulator, two physical phones | Device/API/build matrix |
| Performance | Latency, throughput, memory, CPU, queue growth | Load and soak tests with bounded fixtures | p50/p95/p99, resource snapshots |
| Reliability | Restart, crash, disk-full, partial writes, network loss | Fault injection and recovery drills | Before/after state and recovery proof |
| Compatibility | Supported Windows, Android, Node, Java, browser matrix | Matrix CI and manual device checks | Versioned compatibility results |
| Accessibility / usability | HUD and Android owner workflows | Keyboard, screen-reader, contrast, focus, error-state checks | WCAG-oriented findings |
| Release / supply chain | Build provenance, SBOM, artifact integrity, signing | Reproducible build checks, checksum/signature verification | Manifest, SBOM, provenance and CI run |

## 2. Automated suite

### TypeScript / Node
- `npm ci`
- `npm run lint`
- `npm run build`
- `npm test`
- `npm run test:browser`

The Node test script currently runs `test/**/*.test.ts` and `scripts/on-site-change-detection.test.mjs`. Confirm the glob includes every intended suite on the Windows runner.

### Python
- `python -m unittest discover -s tests -t . -v`
- Include environment snapshot, compatibility matrix, customer bundle, pre-upgrade verifier and release workflow cases.

### Android
- `gradle -p android-app :app:testDebugUnitTest`
- `gradle -p android-app :app:assembleDebug`
- Add local JVM tests for parsing, queue semantics and conflict-resolution decisions; add instrumented tests for Keystore, enrollment, notifications and lifecycle. The repository currently has no Android unit/instrumentation test source set, so these are outstanding coverage.

## 3. Critical functional test matrix

### Identity, sessions and device lifecycle
- Enrollment valid/invalid/expired/replayed challenge; duplicate device; malformed key; wrong proof.
- Signed request valid signature, altered body/path/method, expired timestamp, nonce replay, wrong device, revoked device and key rotation.
- TOTP valid, invalid, replay, clock skew and rate limiting.
- Session expiry, revocation, restart persistence and fail-closed behavior.
- Two phones enrolled independently; one phone cannot impersonate the other.

### Policy, approvals and audit
- Default deny for unknown capability/operation and malformed planner output.
- Approval binds exact task, operation, parameters, device and expiry.
- Single-use approval, duplicate approval, reject/cancel race, expired approval and cross-task reuse.
- High-risk actions never execute from voice-only authorization.
- Audit hash-chain tampering, truncation, invalid previous hash and redaction of credentials/transcripts.
- Policy failure, audit write failure and state persistence failure must fail closed.

### Voice and desktop
- Push-to-talk start/stop/cancel/mute/timeout; duplicate start; late callback; empty/oversized transcript.
- Wake phrase false positives, phrase boundary, noisy room, accents, silence, device unavailable and offline mode.
- Local/cloud provider routing: memory-bearing prompts remain local; cloud disabled by default; explicit opt-in only; no silent fallback.
- Speech recognition clipping and recovery variants, including “open Notepad” and clipped “pen Notepad”.
- Allowlisted launch, unknown app, shell-host identity rejection, unique window, ambiguous windows, pre-existing window focus, no window, wrong process with matching title, timeout and focus denial.
- UI Automation stale element, inaccessible app, wrong foreground window, clipboard privacy and stop-on-unexpected-state.
- Target MSI acceptance: Hey Jarvis → speech capture → intent → policy → approval → Notepad opens → observed correct process/window → truthful result.

### Memory and sync
- Save/read/update/delete/export/import, category isolation, encryption, corrupt ciphertext and key rotation.
- Learning candidates require owner review; deletion and retention across indexes/backups.
- Sync protocol negotiation, invalid capability, monotonic sequence, duplicate/replay, TTL expiry, future timestamp, malformed payload, oversized batch and revoked sender.
- Conflict types: concurrent update, update-vs-delete, deleted-on-hub; keep laptop, keep phone, merge and unauthorized resolver.
- Offline commands remain held; explicit run/discard; expiry and revocation discard; every run re-enters normal approval.
- Pull returns only permitted categories and only the requesting device's conflict metadata.
- Peer envelope wrong recipient, unknown sender, tampering, replay and invalid signature.

### HUD, browser, gateway and developer workflows
- Route authorization, XSS payload rendering, CSRF/origin rejection, CSP/security headers and private page noindex.
- Loading/empty/offline/forbidden/error states and keyboard-only navigation.
- Gateway key creation, one-time reveal, hash-at-rest, scope enforcement, expiry, revocation and rate limits.
- Developer assistant untrusted repository content, command injection attempts, path traversal, secret redaction and approval gates.
- Workflow scheduling: timezone/DST, recurrence, duplicate execution, restart, cancellation, persistence failure and at-most-once semantics.

### DevOps and release integrity
- Build provenance missing/mismatch, wrong project/build/commit, manifest tampering, archive checksum mismatch, file inventory mismatch and path traversal.
- SBOM generation and dependency audit; license and vulnerability review.
- Jenkins failure propagation for every Node command; artifact archive only after successful verification.
- Nexus remains disabled. Tests must assert no publication on test branch and no credential exposure.

## 4. Security test techniques
- Threat-model review and abuse-case testing for every trust boundary.
- SAST, dependency/SCA audit, secret scanning and configuration scanning.
- DAST against a local isolated server; no production probing.
- Fuzz parsers, JSON schemas, route paths, request-body boundaries, AppID inputs and signed-envelope payloads.
- Property-based invariants: approval is single-use; denied actions never execute; revoked devices never sync; private data never appears in public output.
- Mutation testing for policy, authorization, signature verification and resume-independent JARVIS critical modules.
- Race/concurrency tests for approval consumption, duplicate requests, sync sequence and scheduler persistence.
- Fault injection for disk-full, permission denied, corrupted state, process termination and network interruption.

## 5. Manual acceptance gates

| Gate | Required evidence | Status |
|---|---|---|
| MSI Windows 11 voice and Notepad flow | Repeatable wake/capture/approval/launch evidence | NOT RUN |
| Windows app identity/focus across allowlisted apps | Process + window identity, no false positives | NOT RUN |
| Android build and install | APK, install/launch and lifecycle result | NOT RUN |
| Two-phone pairing and sync | Separate identities, conflict and revocation drills | NOT RUN |
| Browser HUD security/accessibility | Browser matrix, keyboard and screen-reader review | NOT RUN |
| Gateway integration | HTTPS, scoped site key, revocation and no secret leakage | NOT RUN |
| Backup/recovery | Corrupt state and restore drills | NOT RUN |
| Release provenance | Exact-head CI, SBOM, checksums and signature evidence | NOT RUN |

## 6. Execution and reporting rules
1. Record branch name and exact commit SHA before every run.
2. Run deterministic unit suites first, then integration/API, security, browser, platform and manual acceptance.
3. Use synthetic data and disposable state. Never use production credentials or personal content in test fixtures.
4. Capture failing test, reproduction steps, logs, severity, affected component and a linked defect.
5. Re-run focused regression tests after a fix; then rerun the relevant full suite.
6. Do not label a test passed unless it executed successfully on the recorded SHA.
7. Keep automated CI, Windows laptop acceptance, Android physical-device acceptance and release readiness as separate statuses.
8. Nexus publication, production deployment, admin elevation and security bypass remain out of scope.

## 7. Current known coverage gaps
- No Android unit or instrumented test source sets exist yet.
- Actual microphone/wake-word/TTS, target-Windows app interaction and two-phone operation require physical acceptance.
- CI on a hosted runner cannot prove hardware behavior.
- The current test-branch README contains unresolved Git conflict markers; treat this as a repository hygiene defect to resolve before considering the branch clean.
- New regression tests authored during this phase are pending execution until a test-branch CI run completes.
