# JARVIS Epic Status Register

**As of:** 2026-11-14 | **Evidence basis:** recent repository commit/merge history and existing project documentation

| Epic | Workstream | Development | Testing | Integration | Acceptance / release | Current note |
|---|---|---|---|---|---|---|
| JAR-E01 | Core assistant runtime and agent architecture | Existing partial | Local node tests 546/546 and script tests 3/3 at 66b3411; CI not observed | Tool integration partial | Ongoing | Preserve existing work |
| JAR-E02 | Workflow orchestration and DAG execution | Implemented increment (live DAG, branch approvals, owner-reconciled resume) | Local adversarial/crash tests pass; kill simulated at journal level; CI not observed | PRs #61/#63/#64/#65 merged | Operational acceptance pending | GAP-001/002/003 COMPLETE AND VERIFIED (local) |
| JAR-E03 | Capability catalogue and safe tool execution | Implemented (catalogue + adapter-contract suite) | Contract/drift tests for every catalogued app pass locally (synthetic) | Allowlist catalogue integrated | Device acceptance pending | GAP-022 COMPLETE AND VERIFIED (local, synthetic) |
| JAR-E04 | Windows desktop and developer automation | Partial (Windows primary; macOS/Linux adapters IMPLEMENTED - NOT TESTED) | Mocked-runner tests only for macOS/Linux; no hardware | Adapters behind fail-closed contract | Physical device pending | Windows 11 target; GAP-019/020 |
| JAR-E05 | Android integration and per-device sessions | Target scope | Not assessed | Not assessed | Not accepted | Two Android phones (GAP-012 BLOCKED) |
| JAR-E06 | Voice interface, wake word and audio privacy | Partial (software-level utterance guard and offline evaluation harness) | Synthetic voice fixtures pass; no hardware | Not verified end to end | Not accepted | Wake phrase is requirement; GAP-004 BLOCKED, GAP-006 PARTIAL |
| JAR-E07 | Local/cloud AI routing and model/provider integration | Partial | Provider matrix not audited; offline retrieval harness synthetic only | E2E not verified | Cost/privacy pending | No continuous cloud audio |
| JAR-E08 | Security, trust policy and human approval | Partial | Local adversarial, isolation and privacy-sentinel tests pass | Fail-closed; providers disabled | Sensitive action pending | Payment apps excluded |
| JAR-E09 | CI/CD, release, Jenkins and Nexus | Partial | Ed25519 signed bundle, clean-room verify and tamper tests pass locally (GAP-018) | Jenkins/Nexus disabled (GAP-023/024 BLOCKED) | External integration pending | No GitHub run observed; not operational |
| JAR-E10 | Monitoring, audit, recovery and operations | Partial | Backup/restore drills and perf baseline local; no real DR exercise | Cross-module not verified | Operational acceptance pending | perf/baseline.i5-1235U.json; budgets provisional |

**Reconciled 2026-11-14 (documentation owner):** development, testing, integration and acceptance columns updated to the verified evidence in PROJECT_STATUS.md. Local evidence is not CI evidence (no GitHub Actions run observed; `gh` unauthenticated) and nothing here is CI VERIFIED.
