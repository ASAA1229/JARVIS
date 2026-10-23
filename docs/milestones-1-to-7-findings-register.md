# JARVIS Milestones 1–7 Findings Register

- **Audit date:** 2026-10-23
- **Branch:** `fix`
- **HEAD / base SHA:** `21c02aee19471a048d3391d1515746d25a87247b`
- **Tree status:** uncommitted working-tree changes are present. This is the base SHA, not a commit containing the exact audited source.
- **Scope:** current code and automated evidence; historical findings are retained with updated dispositions.

## Severity summary

| Severity | Findings | Current disposition |
|---|---:|---|
| Critical | 2 | Both baseline defects fixed and covered by current API/browser regressions. |
| High | 10 | 4 fixed and regression-tested; 3 partially remediated; 3 remain blocked by platform/CI acceptance. |
| Medium | 3 | Partial coverage/remediation; none is a verified release sign-off. |
| Low | 0 | No separate low-severity finding recorded in this audit. |

The count includes findings first reported against the old `new` baseline and the additional service-boundary defect found during this audit. The historical baseline description is not a statement that each issue remains present in current code.

## Findings

| ID | Severity | Finding / affected requirement | Reproduction or evidence | Remediation / current disposition |
|---|---|---|---|---|
| F-01 | Critical | Legacy HUD session route could bypass device-bound session authentication. | `/api/hud/session` is exercised by SEC-API-01. | **Fixed.** Route returns 503 with no session ID; browser establishes a signed session through enrollment and `/api/session`. |
| F-02 | Critical | Untrusted directive/approval content could be rendered as executable HTML. | Real Edge XSS regression injects an `<img onerror>` payload into approval content. | **Fixed.** DOM construction uses text nodes/text content, inline handlers are absent, CSP excludes unsafe inline script/style. |
| F-03 | High | Public status/audit endpoints exposed excessive operational data. | SEC-API-02/03/06/13 and browser least-privilege audit-polling check. | **Fixed in tested routes.** Status is minimal; audit requires a signed, privileged session and returns redacted public records. |
| F-04 | High | Enrollment authorization and abuse controls were inadequate. | SEC-API-00/10 test owner challenge authorization and proof-of-possession. | **Partially remediated.** Owner token and key-possession proof are enforced. Challenge rate limiting and owner-controlled permission assignment are not implemented. |
| F-05 | High | Approval transitions needed authorization, scope, and one-time state enforcement. | SEC-02, SEC-HARD-02/04, SEC-API-11/14, browser rejection flow. | **Fixed in the tested lifecycle.** Scope is hashed, approval is single-use/one-way, expiry and invalid approvers are rejected, service approval/rejection requires an active session. |
| F-06 | High | Browser speech capture could outlive the manager timeout or expose stale transcripts. | Edge smoke uses a simulated recognizer to exercise release, cancel, stale result, timeout, and `not-allowed` error. | **Fixed in the tested browser code; physical acceptance blocked.** Real microphone/browser-vendor behavior is not established by the mock. |
| F-07 | High | Speech processing could be falsely represented as local/offline. | HUD privacy notice states browser/vendor service may receive audio and local-only processing is not guaranteed. | **Disclosure implemented.** Vendor-specific data handling and physical-browser behavior remain unverified. |
| F-08 | High | HUD could report success based on approval acceptance instead of execution evidence. | Browser smoke intercepts an approval response marked `COMPLETED` but `UNCERTAIN`/`verified:false`; it must not render success. | **Fixed and regression-tested.** Verified success requires completed state, true success, `VERIFIED_SUCCESS`, and `verified:true`. |
| F-09 | High | Device-state persistence errors could leave security state uncertain. | RECOVER-01/03 verify persisted revocation and corrupt-state fail-closed behavior. | **Fail-closed implementation verified for corruption; partial evidence.** Persistence write-failure injection/recovery remains untested. |
| F-10 | High | HTTP payload and error handling could return wrong statuses or leak internals. | SEC-API-04/05/08 and API boundary tests for body shape, media type, size, signatures, and selected status contracts. | **Partially remediated.** Tested paths return stable non-success codes and generic internal errors; exhaustive route-by-route contract coverage remains. |
| F-11 | High | Hosted CI result for the exact remediation source is unavailable. | `gh run list --branch fix --limit 10` exited 4 because GitHub CLI authentication is unavailable; working tree is dirty. | **Blocked.** Local checks pass, but hosted CI on an immutable commit is still required. |
| F-12 | Medium | HTTP methods, route semantics, and response contracts are not exhaustive. | Wrong-method/unknown-route checks and selected route cases pass; exhaustive matrix is absent. | **Partial.** Add route-by-route positive/negative status, method, schema, and injected-failure coverage before sign-off. |
| F-13 | Medium | Audit redaction edge-case coverage is incomplete. | AUD-02 and SEC-API-13 cover nested arrays/objects, legacy content, signatures, and public API response redaction. | **Partial.** Query strings, arbitrary token formats, Unicode/malformed values, and secret-bearing exception paths are not exhaustively tested. |
| F-14 | Medium | Accessibility and input-device coverage is incomplete. | Browser smoke verifies key shortcuts, editable-field Space behavior, and reduced-motion toggle. | **Partial.** Screen-reader, focus order, touch cancellation, pointer loss/outside release, and full reduced-motion animation behavior need manual/automated acceptance. |
| F-15 | High | Public execution dispatcher and approval service inputs allowed bypass of policy/authentication boundaries. | A regression initially failed because `Reflect.get(service, 'executeTask')` returned an `AsyncFunction`; no adapter was invoked by the reproducer. Prior approval/rejection service methods accepted a device ID rather than a session. | **Fixed and regression-tested.** Dispatchers are ECMAScript-private; approve/reject methods validate an active session; server routes pass the session only after signed-request validation. SEC-05 and SEC-HARD-04 pass. |

## Remaining risks and gates

1. Enrollment remains without a rate limiter or owner-controlled permission selection.
2. Persistence write-failure injection, full API error-contract coverage, and broad input/fuzz testing are incomplete.
3. Speech tests use a mocked recognizer; they do not verify microphone permission prompts, actual capture stop/release, vendor-side processing, or physical device privacy indicators.
4. Native Android Keystore, remote phone transport, and two physical phones are not implemented/verified.
5. The current local Windows 11 Home environment was tested, but the owner's target device acceptance is not claimed.
6. WSL Ubuntu 2 is present, but Linux Node.js is unavailable; no Linux test was run.
7. Hosted CI cannot be confirmed for the dirty working tree. No commit, push, branch switch, or PR was created.

Milestone 7 remains **BLOCKED — NOT COMPLETE**. See the [acceptance matrix](milestones-1-to-7-acceptance-audit.md), [test evidence](milestones-1-to-7-test-results.md), and [security/API audit](security-api-feature-audit-2026-10-23.md).
