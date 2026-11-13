# JARVIS — Release Readiness

**Status date:** 2026-11-13  
**Decision:** **NO-GO**  
**Candidate branch:** `fix-live-dag-ci-hardening`  
**Baseline feature CI:** https://github.com/ASAA1229/JARVIS/actions/runs/43415584498

## Release gate summary

| Gate | Current status | Evidence required to pass |
|---|---|---|
| Build and type safety | NEEDS TESTING | Re-run build/type checks on the exact release candidate SHA |
| Automated correctness | TEST FAILED | Full suite passes; baseline feature run had 409/415 tests pass |
| Approval and authorization | NEEDS TESTING | Authenticated session, permission, scope, expiry, replay and race tests pass |
| DAG checkpoint/recovery | NEEDS TESTING | Malformed-state rejection, crash/restart, uncertain-effect and owner-reconciliation tests pass |
| Browser smoke/security | NEEDS TESTING | Browser security smoke executes and passes on exact SHA |
| Android package | NEEDS TESTING | CI build plus install/runtime tests on both owner phones |
| Windows voice/desktop | OWNER ACCEPTANCE PENDING | Real microphone, wake/STT, application interaction and verified outcomes on target MSI |
| Dependency security/SBOM | NEEDS TESTING | Audit and SBOM regenerated for exact candidate SHA |
| Artifact integrity/provenance | NEEDS TESTING | Manifest, checksums, signing/trust and clean-room verification pass |
| Backup/restore/DR | NEEDS TESTING | Successful restore and recovery drill with recorded evidence |
| Jenkins/Nexus | OWNER ACCEPTANCE PENDING | Approved live endpoints, credentials and publish/retrieve evidence |
| Owner acceptance | OWNER ACCEPTANCE PENDING | Owner signs off all applicable product, privacy and device scenarios |

## Current blocking evidence

The Live DAG feature branch CI run `43415584498` on commit `156b5750ef99e10a8d33c43ad5dc873a183d57cd` reported 409 passing and six failing tests. Dependency installation, SBOM generation, dependency audit, TypeScript check/build and Android debug APK assembly passed. Browser smoke, Python release tests and manifest/provenance steps were skipped after the automated test job failed.

A candidate remediation exists on `fix-live-dag-ci-hardening`: asynchronous rejection assertions now await `rejectTask`; persisted approval-pending checkpoints reject incompatible terminal outcomes; the single-label synthetic benchmark measures Precision@1 consistently. This remediation is not yet verified. A new exact-head CI run is mandatory.

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
