# JARVIS — Release Readiness

**Status date:** 2026-11-13  
**Decision:** **NO-GO**  
**Candidate branch:** `new` (PRs #63/#64 merged)  
**Baseline feature CI:** https://github.com/ASAA1229/JARVIS/actions/runs/43415584498

## Release gate summary

| Gate | Current status | Evidence required to pass |
|---|---|---|
| Build and type safety | TEST PASSED (local) | Re-run build/type checks on the exact release candidate SHA |
| Automated correctness | TEST PASSED (local; one environment-sensitive E2E flake, passes in isolation) | Full suite passes; baseline feature run had 409/415 tests pass |
| Approval and authorization | TEST PASSED (local) | Authenticated session, permission, scope, expiry, replay and race tests pass |
| DAG checkpoint/recovery | TEST PASSED (local; kill simulated at journal level) | Malformed-state rejection, crash/restart, uncertain-effect and owner-reconciliation tests pass |
| Browser smoke/security | TEST PASSED (local) | Browser security smoke executes and passes on exact SHA |
| Android package | NEEDS TESTING | CI build plus install/runtime tests on both owner phones |
| Windows voice/desktop | OWNER ACCEPTANCE PENDING | Real microphone, wake/STT, application interaction and verified outcomes on target MSI |
| Dependency security/SBOM | TEST PASSED (local audit 0 vulnerabilities; SBOM verified against lockfile) | Audit and SBOM regenerated for exact candidate SHA |
| Artifact integrity/provenance | TEST PASSED (local; Ed25519 signed bundle, clean-room verify, tamper tests with local keys); production signing key and CI run pending | Manifest, checksums, signing/trust and clean-room verification pass on the release SHA |
| Backup/restore/DR | TEST PASSED (local drills); real DR exercise pending | Successful restore and recovery drill with recorded evidence |
| Jenkins/Nexus | OWNER ACCEPTANCE PENDING | Approved live endpoints, credentials and publish/retrieve evidence |
| Owner acceptance | OWNER ACCEPTANCE PENDING | Owner signs off all applicable product, privacy and device scenarios |

## Current blocking evidence

The Live DAG feature branch CI run `43415584498` on commit `156b5750ef99e10a8d33c43ad5dc873a183d57cd` reported 409 passing and six failing tests. Dependency installation, SBOM generation, dependency audit, TypeScript check/build and Android debug APK assembly passed. Browser smoke, Python release tests and manifest/provenance steps were skipped after the automated test job failed.

A candidate remediation exists on `fix-live-dag-ci-hardening`: asynchronous rejection assertions now await `rejectTask`; persisted approval-pending checkpoints reject incompatible terminal outcomes; the single-label synthetic benchmark measures Precision@1 consistently. Exact-head CI run `43419769716` for commit `2b9613088d8f571fa3390107837fca6630` is currently IN PROGRESS. The remediation is not yet verified; the full run, including downstream jobs, must pass.

## GO criteria

Release may move from NO-GO only when:
1. All P0 security, authorization, checkpoint, voice and critical functionality tests pass.
2. All required CI jobs pass on one exact candidate SHA, including jobs previously skipped.
3. No unresolved P0 defects or unreviewed security exceptions remain.
4. Windows and both Android devices pass their applicable acceptance scenarios.
5. Artifact provenance, integrity, signing/trust and recovery evidence are complete.
6. Privacy, data deletion, backup/restore and rollback behavior are accepted.
7. Owner acceptance is explicitly recorded.

A green unit-test job alone is insufficient. A conditional release, if ever considered, must document non-P0 exclusions, mitigations, expiry and owner approval. No such exception is currently approved.


## Update 2026-11-13: post-merge local evidence

PRs #63/#64 are merged into `new`; the historical six failures pass. Local final results: lint, build, 497 tests (one environment-sensitive Notepad E2E flake that passes alone), 3 script tests, browser smoke, 33 Python tests and a clean `npm audit`. Decision remains **NO-GO**: GitHub exact-head CI, physical MSI voice/desktop acceptance, two-phone acceptance, Jenkins/Nexus live evidence and owner sign-off are outstanding.


## Update 2026-11-14: batch reconciliation

Coordinator rerun at `66b3411`: lint pass, 546/546 node tests, 3/3 script tests. Documentation-owner run at `3e4b9d1`: lint pass, 543 of 547 node tests, with 4 `e2e_recovery` failures caused by a fixed-port (3899) collision with a concurrent process. Not CI VERIFIED. New local evidence: signed release bundle (GAP-018), macOS/Linux adapters with mocked runner only (GAP-019/020, NOT TESTED on hardware), adapter-contract suite (GAP-022), offline evaluation harness and performance baseline (GAP-006/007/015). Decision remains **NO-GO**.


## Update 2026-11-15

Coordinator-verified at `031eb7e`: lint, 585/585 node tests, 3/3 script tests (concurrent-run flakes removed in 3c17702). CI not observed. Criteria rollup: 105 of 127 story criteria and 63 of 76 requirements are complete and verified locally; the remaining criteria are partial, not tested, or blocked on devices, Jenkins/Nexus and owner acceptance. Decision remains **NO-GO**.
