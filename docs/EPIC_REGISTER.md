# JARVIS Epic Register — 2026-11-14

| ID | Epic | Development | Testing | Integration | Acceptance/release |
|---|---|---|---|---|---|
| JAR-E01 | Core runtime and agent architecture | Existing partial | Local node tests 546/546 and script tests 3/3 at 66b3411; CI not observed | Tool integration partial | Ongoing |
| JAR-E02 | Workflow orchestration/DAG | Implemented increment (live DAG, branch approvals, owner-reconciled resume) | Local adversarial/crash tests pass; kill simulated at journal level; CI not observed | PRs #61/#63/#64/#65 merged | Operational acceptance pending |
| JAR-E03 | Capability catalogue/safe tools | Implemented (catalogue + adapter-contract suite) | Contract/drift tests for every catalogued app pass locally (synthetic) | Allowlist catalogue integrated | Device acceptance pending |
| JAR-E04 | Windows desktop/developer automation | Partial (Windows primary; macOS/Linux adapters IMPLEMENTED - NOT TESTED) | Mocked-runner tests only for macOS/Linux; no hardware | Adapters behind fail-closed contract | Physical device pending |
| JAR-E05 | Android/per-device sessions | Target scope | Not assessed | Not assessed | Not accepted |
| JAR-E06 | Voice/wake word/audio privacy | Partial (software-level utterance guard and offline evaluation harness) | Synthetic voice fixtures pass; no hardware | Not verified end to end | Not accepted |
| JAR-E07 | Local/cloud AI/provider integration | Partial | Provider matrix not audited; offline retrieval harness synthetic only | E2E not verified | Cost/privacy pending |
| JAR-E08 | Security/trust/human approval | Partial | Local adversarial, isolation and privacy-sentinel tests pass | Fail-closed; providers disabled | Sensitive action pending |
| JAR-E09 | CI/CD/Jenkins/Nexus | Partial | Ed25519 signed bundle, clean-room verify and tamper tests pass locally (GAP-018) | Jenkins/Nexus disabled (GAP-023/024 BLOCKED) | External integration pending |
| JAR-E10 | Monitoring/audit/recovery/operations | Partial | Backup/restore drills and perf baseline local; no real DR exercise | Cross-module not verified | Operational acceptance pending |

Recent repo history shows ongoing engineering, not full device/voice/user acceptance or production readiness.

**Reconciled 2026-11-14 (documentation owner):** development, testing, integration and acceptance columns updated to the verified evidence in PROJECT_STATUS.md. Local evidence is not CI evidence (no GitHub Actions run observed; `gh` unauthenticated) and nothing here is CI VERIFIED.
