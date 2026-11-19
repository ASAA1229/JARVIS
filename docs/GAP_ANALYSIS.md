# JARVIS — Refined Gap Analysis and Development Backlog

**Status date:** 2026-11-14 (gap table reconciled with the 2026-11-14 batch)  
**Repository:** ASAA1229/JARVIS  
**Active working branch:** `new` (PRs #63 and #64 - Live DAG CI hardening and DAG integration - are merged into it; `fix-live-dag-ci-hardening` is no longer the active branch)

## 1. Executive assessment

JARVIS has substantial source implementation across local AI, voice/HUD, Windows capabilities, task/policy execution, memory/RAG, Android companion, plugins, developer tooling and release utilities. The main risk is no longer absence of modules: it is incomplete integration, incomplete evidence and unmeasured reliability.

The following must not be conflated:
- source exists;
- tests are authored;
- tests passed on the current exact commit;
- a physical device passed;
- owner accepted the behavior;
- production/release gates passed.

Current documentation and source review show the largest delivery risks are live DAG integration, real-device voice reliability, learning-quality instrumentation, exact-head CI evidence, platform acceptance and durable recovery.

## 2. Priority and status rules

- **P0:** blocks safe core operation or invalidates a central product promise.
- **P1:** required for dependable daily use and credible platform acceptance.
- **P2:** future platform breadth and advanced operational maturity.

Statuses:
- **IMPLEMENTED — NEEDS TESTING**
- **PARTIAL**
- **NEEDS TESTING — tests authored, execution not implied**
- **NOT IMPLEMENTED**
- **BLOCKED / OWNER ACCEPTANCE PENDING**

No gap is closed by documentation or source presence alone.

## 3. Prioritized gaps

| ID | Priority | Gap | Current status | Completion evidence |
|---|---|---|---|---|
| JARVIS-GAP-001 | P0 | Integrate DAG executor into live workflow/task service | COMPLETE AND VERIFIED (locally) - live DAG, child-task isolation, bounded concurrency, resource locks and lock-release-on-throw/cancel/timeout tests pass on local `new` after the #63/#64 merge; GitHub exact-head CI rerun pending push | Live workflow expansion preserves dependency edges; isolated child task per branch; encrypted parent/child journal; bounded parallel execution and resource locks; exact-head integration tests and fault acceptance pending |
| JARVIS-GAP-002 | P0 | Branch-level approval and policy lifecycle | COMPLETE AND VERIFIED (locally) - branch approval expiry, replay, concurrent-resolution race, unauthorized/revoked approver and restart-invalidation tests added and passing | Each branch uses a distinct child task and existing exact-scope, single-use Policy Gateway approval; approval/rejection/expiry updates and resumes the parent DAG; race/expiry/revocation tests pending |
| JARVIS-GAP-003 | P0 | Crash/restart and partial-failure recovery for concurrent branches | COMPLETE AND VERIFIED (locally) - restart marks dispatched branches uncertain (never replayed); explicit owner-reconciled resume implemented (`resumeWorkflowRun`, `POST /api/workflow/resume`) and tested; kill is simulated at journal level, not a real SIGKILL | Encrypted DAG checkpoints and fail-closed restart are wired; in-flight branches become recovery-required and are not replayed; explicit owner-reconciled DAG resume and process-kill tests remain |
| JARVIS-GAP-004 | P0 | Voice-to-command full-path reliability on actual MSI hardware | BLOCKED BY EXTERNAL DEPENDENCY - physical MSI microphone/STT/wake acceptance; OWNER ACCEPTANCE PENDING | Microphone/wake/STT/intent/approval/execution/verification tests on Windows 11 with noise, timeout, mute, cancellation and error evidence |
| JARVIS-GAP-005 | P0 | Exact-head CI and security regression gates | PARTIALLY COMPLETE - local lint/build/497+3 tests/browser smoke/33 Python tests pass; `e2e_recovery` launches real Notepad and failed once under concurrent load but passes in isolation; GitHub exact-head CI not yet confirmed | Build, lint, all tests, browser smoke/security, Ollama, Android and security scans green on same SHA |
| JARVIS-GAP-006 | P0 | Voice false-accept/false-reject and duplicate command prevention | PARTIALLY COMPLETE - duplicate-final-transcript/one-task-per-utterance suppression and wake metric counters implemented and tested (software level); offline voice evaluation harness added (commit 2323df3, synthetic); hardware false-accept/false-reject rates need physical measurement | Measured wake metrics, replay/duplicate suppression, interim/final transcript tests and one-task-per-utterance evidence |
| JARVIS-GAP-007 | P1 | Learning evaluation is not yet tied to representative real retrieval outcomes | PARTIALLY COMPLETE - synthetic benchmark and offline evaluation harness (`npm run eval`, commit 2323df3) pass; owner-labelled real corpus and thresholds still required | Exact-head benchmark pass; owner-labelled corpus, baseline and regression thresholds |
| JARVIS-GAP-008 | P1 | Learning candidate acceptance and correction telemetry completeness | COMPLETE AND VERIFIED (locally) - atomic quality counters with rollback and visible write failures; candidate lifecycle, dedup, provenance, privacy and no-auto-promotion tests pass | Atomic/reliable counters, correction attribution, provenance, deduplication and lifecycle tests |
| JARVIS-GAP-009 | P1 | Document RAG relevance, adversarial and deletion acceptance | COMPLETE AND VERIFIED (locally) - injection across all document types, delimiter forgery, per-device isolation (lexical and semantic), verified deletion and index rebuild tests pass | Ground-truth retrieval corpus, injection tests, per-device isolation, index rebuild and verified deletion |
| JARVIS-GAP-010 | P1 | PDF/DOCX/OCR parser hostile-input validation | COMPLETE AND VERIFIED (locally; Poppler/Tesseract mocked, Tesseract absent on this host) - hostile ZIP/XML/PDF inputs, bombs, traversal, timeouts, missing tools and temp-file cleanup tested; defects fixed | Malformed PDF/ZIP, decompression bomb, path traversal, timeout, tool absence and OCR-limit tests |
| JARVIS-GAP-011 | P1 | Windows application compatibility and outcome verification | PARTIALLY COMPLETE - app catalogue and contract/drift tests implemented (GAP-022); per-app physical outcome matrix on the MSI remains OWNER ACCEPTANCE PENDING | Per-app capability matrix; focus/window identity, permission, failure and independent state verification |
| JARVIS-GAP-012 | P1 | Two Android phone physical acceptance | BLOCKED BY EXTERNAL DEPENDENCY - two physical Android phones required; OWNER ACCEPTANCE PENDING | Build/install both devices; independent enrollment, signed calls, revocation, offline/reconnect and queue tests |
| JARVIS-GAP-013 | P1 | Cross-device sync durability and replay recovery | COMPLETE AND VERIFIED (locally) - per-change durable checkpoints, per-device push lock, claim-before-run command decisions, replay/conflict/revocation/crash tests pass | Durable queue, monotonic sequence, replay protection, conflicts, crash recovery and revoked-device tests |
| JARVIS-GAP-014 | P1 | Conversation/session persistence documentation and behavior consistency | COMPLETE AND VERIFIED (locally) - canonical path, encryption, restart, 30-minute idle expiry and bounds reconciled in code (`describe()`) and tested; documentation aligned | Confirm exact configured path, encryption, restart recovery and expiry; align README, requirements, architecture and operations |
| JARVIS-GAP-015 | P1 | Performance budgets and soak/regression testing | PARTIALLY COMPLETE - `npm run perf` harness run; stored baseline `perf/baseline.i5-1235U.json` and trend comparison added (commit 66b3411); budgets provisional until the owner agrees targets | Agreed latency/CPU/RAM/queue/recovery budgets; repeatable workload and soak evidence |
| JARVIS-GAP-016 | P1 | Plugin/developer assistant permission and isolation acceptance | COMPLETE AND VERIFIED (locally) - malformed manifest, injection, scope-escalation, tampered-state and protected-path tests pass; symlink-escape defect fixed | Malformed manifest, prompt injection, protected-path and scope-escalation tests |
| JARVIS-GAP-017 | P1 | Backup, restore and memory deletion verification across derived state | COMPLETE AND VERIFIED (locally) - integrity-protected backup/restore tool, restore drills, tamper/traversal refusal and derived-deletion verification tested; external/older backups remain outside JARVIS control | Restore drills; delete primary/index/cache; verify no residual access; explicitly document external backup limits |
| JARVIS-GAP-018 | P1 | Release provenance, SBOM, signing and clean-room validation | COMPLETE AND VERIFIED (locally) - Ed25519 signed bundle with clean-room verification and tamper tests (commit aa05317) plus SBOM-vs-lockfile verifier; local test keys only, production key and GitHub run remain owner actions | Signed exact artifact, provenance, SBOM, checksum and tamper/restore evidence |
| JARVIS-GAP-019 | P2 | macOS native adapter | IMPLEMENTED — NOT TESTED - adapter behind the fail-closed contract (commit c97ee83), mocked runner only, no macOS hardware | Native permission-aware adapter and physical acceptance |
| JARVIS-GAP-020 | P2 | Linux desktop native adapter | IMPLEMENTED — NOT TESTED - adapter behind the fail-closed contract (commit c97ee83), mocked runner only, no Linux hardware | Portal/accessibility integration and distribution-specific acceptance |
| JARVIS-GAP-021 | P2 | iOS companion | NOT IMPLEMENTED - no iOS client built (out of scope) | Swift/SwiftUI client, Keychain, permission model and physical acceptance |
| JARVIS-GAP-022 | P2 | Broader app integrations and capability discovery | COMPLETE AND VERIFIED (locally, synthetic) - catalogue, contract/drift tests and generated adapter-contract suite for every catalogued app (commit aee9167); no live app evidence | Supported app catalogue, API/UI adapter contracts, version drift tests and verified outcomes |
| JARVIS-GAP-023 | P2 | Jenkins build-to-manifest live integration | BLOCKED BY EXTERNAL DEPENDENCY - disabled provider contract implemented; live Jenkins needs approved pipeline/credentials | Approved pipeline, immutable build identity and provenance handoff |
| JARVIS-GAP-024 | P2 | Nexus artifact publication/retrieval | BLOCKED BY EXTERNAL DEPENDENCY - disabled provider and local trust-policy mock implemented; live Nexus needs approved coordinates/credentials/owner authorization | Approved repository coordinates, auth contract, trust policy and owner authorization |

## 4. Detailed completion definitions

### P0-A — Workflow DAG integration
1. Preserve existing sequential behavior for workflows that do not require concurrency.
2. Create a parent workflow execution record and durable branch records; do not share mutable single-task state between branches.
3. Resolve each branch's operation through the existing capability registry and Policy Gateway.
4. Bind branch approval to exact branch/task/device/operation/parameters and consume it once.
5. Persist branch checkpoint before dispatch and persist terminal/uncertain outcomes after dispatch.
6. Use the existing audit chain and outcome verifier.
7. Enforce bounded concurrency and resource lock acquisition; never allow lock leaks on timeout/cancel/error.
8. On dependency failure, block descendants while allowing unrelated safe branches to complete.
9. On restart, mark in-flight external effects uncertain; never replay them automatically.
10. Add unit, route integration, approval race, crash/restart and partial-failure tests. Current live path is wired; exact-head CI evidence is pending. Explicit owner-reviewed resume after restart remains a separate closure item.

### P0-B — Voice end-to-end reliability
Test each stage independently and as a full chain:
1. microphone permission and capture start;
2. local wake detection and visible listening state;
3. speech capture and endpointing;
4. STT provider selection and local/remote disclosure;
5. final transcript stabilization and review;
6. intent, entity and parameter extraction;
7. ambiguity confirmation;
8. signed request and authorization;
9. task/approval execution;
10. independent outcome verification and TTS acknowledgement.

Required negative cases: denied permission, device unplug, silence, noise, false wake, missed wake, partial/interim transcript, malformed transcript, duplicate final event, timeout, focus loss, mute/consent revocation, network loss, model/STT unavailable, policy denial and uncertain external side effect.

### P0-C — CI and test evidence
- Add the feature branch to relevant CI triggers.
- Ensure the browser smoke test uses stable semantic selectors and fails on real regressions.
- Run all jobs on the exact branch head.
- Record failing job logs and repair the root cause.
- Do not use prior successful runs as evidence for later commits.

### P1-A — Learning quality
- Use a fixed, versioned benchmark set of owner-labelled queries and relevant memory/document IDs.
- Report Precision@K, Recall@K, MRR, helpful rate, correction rate and candidate acceptance rate.
- Separate benchmark scores from subjective feedback.
- Measure retrieval with embeddings enabled and lexical fallback.
- Add thresholds only after baseline collection; do not fabricate targets.
- Ensure metrics cannot promote candidates or change policy automatically.
- Persist only minimum encrypted aggregate/benchmark identifiers necessary; avoid raw prompts/transcripts in telemetry.

### P1-B — RAG and parser quality
- Test source citations, deduplication, chunk boundaries and deterministic retrieval.
- Test prompt injection in all supported document types.
- Test encrypted persistence, per-device isolation, deletion and index rebuild.
- Fuzz binary parsers and enforce byte/page/entry/decompression/time limits.
- Verify missing Poppler/Tesseract produces a clear safe error and no cloud fallback.

### P1-C — Platform and operational acceptance
- Build an app compatibility matrix for Windows 11.
- Build/install and test both Android phones independently.
- Establish measurable performance budgets from the target MSI hardware.
- Complete backup/restore and release provenance tests.
- Implement macOS/Linux/iOS only after the shared capability contracts and acceptance harness are stable.

## 5. Recommended execution sequence

1. JARVIS-GAP-001 to 003: live workflow DAG integration and recovery.
2. JARVIS-GAP-004 to 006: voice pipeline and hardware reliability.
3. JARVIS-GAP-005: exact-head CI/security gates continuously.
4. JARVIS-GAP-007 to 010: learning evaluation, RAG and parser quality.
5. JARVIS-GAP-011 to 018: Windows/Android, sync, performance, privacy and release operations.
6. JARVIS-GAP-019 to 024: future platform and enterprise integrations.

## 6. Definition of done for every gap

A gap is closed only when:
- acceptance criteria are implemented;
- unit/integration/security/fault tests are added as appropriate;
- tests pass on the exact commit;
- physical-device tests are recorded when required;
- documentation and user-story status are updated;
- no existing security, privacy, API or regression boundary is weakened;
- owner acceptance is recorded for owner-only actions.



## 7. Latest CI failure and remediation tracking (2026-11-13)

Evidence: [GitHub Actions run 43415584498](https://github.com/ASAA1229/JARVIS/actions/runs/43415584498), branch `new-workflow-dag-integration`, commit `156b5750ef99e10a8d33c43ad5dc873a183d57cd`.

- Automated tests: 409 passed, 6 failed, 415 total.
- Four approval/rejection failures used synchronous assertions against the asynchronous `rejectTask` method. Test assertions now await the returned promise on `fix-live-dag-ci-hardening`.
- One checkpoint test showed an approval-pending branch could carry a terminal outcome. Validation now rejects any outcome while `status === awaiting_approval` on `fix-live-dag-ci-hardening`.
- One retrieval benchmark asserted Precision@K = 1.0 for one relevant item while requesting up to five results. The benchmark now evaluates at `limit: 1`, matching the single-label top-one assertion.
- Candidate code and test changes are committed on the isolated fix branch. Exact-head CI run [43419769716](https://github.com/ASAA1229/JARVIS/actions/runs/43419769716) is IN PROGRESS for `2b9613088d8f571459b16fa3390107837fca6630`. Status remains **NEEDS TESTING** until all tests and downstream jobs pass on that exact head.


## 8. Local verification results - 2026-11-13 (branch `new`, after PRs #63/#64)

Initial baseline (before this increment): `npm run lint` pass; `npm run build` pass; `npm test` 415/415 plus 3/3 script tests pass (the six CI failures listed in section 7 no longer fail on `new`); `npm run test:browser` pass; Python release tests 31 of 33 passing (2 errors: the customer bundle referenced `docs/*.md` files removed by documentation consolidation; 1 test assertion double-escaped a newline).

Final (this increment): `npm run lint` pass; `npm run build` pass; `npm test` 497 tests (496 pass; the single failure `E2E-LIVE-01` launches real Notepad and failed under concurrent machine load with a Windows focus-verification failure, then passed 20/20 when run alone) plus 3/3 script tests; `npm run test:browser` pass; `python -m unittest discover -s tests -t .` 33/33 pass; `npm audit --audit-level=moderate` 0 vulnerabilities.

Defects found and fixed: customer bundle allowlist referenced deleted docs; DOCX numeric-entity RangeError and raw zlib errors on hostile archives; OCR tool failures leaked raw process errors; developer repo path containment followed symlinks outside the repository; sync batches were checkpointed only at the end (crash replay could re-apply changes) and concurrent identical pushes or command decisions could run twice; learning telemetry counters could run ahead of the durable value and write failures were silent; restart left dispatched DAG branches marked `running`.

Not claimed: no physical voice, Android, Jenkins/Nexus or owner acceptance was performed. Gap rows above reflect that.


## 9. Update 2026-11-14

Statuses in section 3 now include the 2026-11-14 batch: GAP-018 and GAP-022 COMPLETE AND VERIFIED (local); GAP-019/020 IMPLEMENTED — NOT TESTED (mocked runner); GAP-006/007/015 remain PARTIALLY COMPLETE with an offline evaluation harness and a stored performance baseline. Verification: coordinator 546/546 node tests plus 3/3 script tests at `66b3411`; documentation-owner run at `3e4b9d1` had 543 of 547 passing, the 4 failures being port-3899 collisions with a concurrent process in `e2e_recovery.test.ts`. No CI run was observed. Tally of the 24 gaps: 12 complete and verified, 5 partial, 4 blocked, 2 implemented not tested, 1 not implemented.


## 10. Update 2026-11-15

Verification at `031eb7e`: lint pass, 585/585 node tests, 3/3 script tests (coordinator). GAP-005 stays PARTIALLY COMPLETE because no GitHub Actions run has been observed for the exact head; CI evidence is now bound to the exact commit in code (`src/release/ciProvider.ts`). Per-criterion classification lives in `reports/epic-criteria.json`. No gap status changed.
