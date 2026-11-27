# JARVIS Epic Status Register

**As of:** 2026-11-14 | **Evidence basis:** recent repository commit/merge history and existing project documentation

| Epic | Workstream | Development | Testing | Integration | Acceptance / release | Current note |
|---|---|---|---|---|---|---|
| JAR-E01 | Core assistant runtime and agent architecture | PARTIALLY COMPLETE (local; per-criterion classification) | test/agent_contracts.test.ts; test/conversation.test.ts; full suite 547 tests | Tool integration partial | Ongoing | Agent contracts, routing and failure handling are verified; integration depth with every tool is partial. |
| JAR-E02 | Workflow orchestration and DAG execution | COMPLETE AND VERIFIED (local; per-criterion classification) | test/workflow_execution.test.ts; test/workflow_live_dag.test.ts; test/workflow_dag_service_recovery.test.ts | PRs #61/#63/#64/#65 merged | Operational acceptance pending | Locally verified; operational acceptance pending. |
| JAR-E03 | Capability catalogue and safe tool execution | COMPLETE AND VERIFIED (local; per-criterion classification) | test/app_catalogue_contract.test.ts; test/app_adapter_contracts.test.ts; test/policy_permission_matrix.test.ts | Allowlist catalogue integrated | Device acceptance pending | Synthetic windows only; real apps pending. |
| JAR-E04 | Windows desktop and developer automation | PARTIALLY COMPLETE (local; per-criterion classification) | test/windows_desktop_agent.test.ts; test/native_platform_adapters.test.ts; test/plugin_isolation.test.ts; test/developer_ci_commit_binding.test.ts | Adapters behind fail-closed contract | Physical device pending | macOS/Linux adapters IMPLEMENTED — NOT TESTED on real hardware. |
| JAR-E05 | Android integration and per-device sessions | BLOCKED BY EXTERNAL DEPENDENCY (local; per-criterion classification) | test/device_session_extra.test.ts; test/android_protocol.test.ts | Not assessed | Not accepted | Session security verified in software; physical phones required. |
| JAR-E06 | Voice interface, wake word and audio privacy | PARTIALLY COMPLETE (local; per-criterion classification) | test/voice_utterance_guard.test.ts; test/offline_evaluation.test.ts; test/local_cloud_separation.test.ts | Not verified end to end | Not accepted | Software level verified; MSI hardware BLOCKED. |
| JAR-E07 | Local/cloud AI routing and model/provider integration | COMPLETE AND VERIFIED (local; per-criterion classification) | test/local_cloud_separation.test.ts; test/provider_router.test.ts; test/ollama_provider.test.ts | E2E not verified | Cost/privacy pending | Zero-cost defaults and no-egress-by-default proven locally; live cloud providers intentionally not exercised. |
| JAR-E08 | Security, trust policy and human approval | COMPLETE AND VERIFIED (local; per-criterion classification) | test/policy_permission_matrix.test.ts; test/device_session_extra.test.ts; test/privacy_log_exclusion.test.ts | Fail-closed; providers disabled | Sensitive action pending | Locally verified; not an independent security certification. |
| JAR-E09 | CI/CD, release, Jenkins and Nexus | PARTIALLY COMPLETE (local; per-criterion classification) | test/release_bundle_signing.test.ts; test/jenkins_boundary.test.ts; test/sbom_verification.test.ts | Jenkins/Nexus disabled (GAP-023/024 BLOCKED) | External integration pending | GitHub Actions run not observed; Jenkins/Nexus BLOCKED BY EXTERNAL DEPENDENCY (disabled providers fail closed). |
| JAR-E10 | Monitoring, audit, recovery and operations | PARTIALLY COMPLETE (local; per-criterion classification) | test/monitoring_endpoints.test.ts; test/state_backup_restore.test.ts; test/perf_trend.test.ts | Cross-module not verified | Operational acceptance pending | No real disaster-recovery exercise; budgets provisional. |

**Reconciled 2026-11-14 (documentation owner):** development, testing, integration and acceptance columns updated to the verified evidence in PROJECT_STATUS.md. Local evidence is not CI evidence (no GitHub Actions run observed; `gh` unauthenticated) and nothing here is CI VERIFIED.

**Update 2026-11-15 (documentation owner):** epic development labels are rendered from `reports/epic-criteria.json` (committed in 72965d7): 4 COMPLETE AND VERIFIED (JAR-E02, E03, E07, E08), 5 PARTIALLY COMPLETE (E01, E04, E06, E09, E10), 1 BLOCKED BY EXTERNAL DEPENDENCY (E05). Scope of that file: local automated verification only; no GitHub Actions run observed, no physical device or owner acceptance. JAR-E05 stays BLOCKED (two physical phones). US-003 revoke-all and US-025 metrics are still in progress and are not marked done.

**Reconciled 2026-11-15 (documentation owner):** development, testing, integration and acceptance columns updated to the verified evidence in PROJECT_STATUS.md. Local evidence is not CI evidence (no GitHub Actions run observed; `gh` unauthenticated) and nothing here is CI VERIFIED.


---

## 2026-11-19 discovery reconciliation note

Sets 1–12 are complete; all questions were answered “all of the above.” These are candidate requirements only. Existing status rows and evidence remain authoritative and are not upgraded by questionnaire answers. New cross-cutting domains to map: architecture/integration; data governance; security/privacy; CI/CD/infrastructure; quality engineering and acceptance. Requirement-to-epic/story/task/evidence mapping, ownership, dependencies, prioritization and acceptance criteria remain pending.


## Project-specific pending work carried forward (not a status promotion)
Re-run exact-head CI after DAG hardening; verify physical MSI Windows voice/microphone/wake-word behavior; complete two-Android-phone per-device session acceptance; measure physical false-accept/false-reject voice rates; resolve remaining Notepad E2E environment sensitivity; complete owner-labelled retrieval corpus/thresholds; verify Jenkins/Nexus only with authorized live infrastructure; finish owner acceptance and release gates.


## Evidence reconciliation — 2026-11-20

| Area | Current verified state | Remaining evidence |
|---|---|---|
| CI on `new` | CI passed, run 44727781030 | Re-run on exact candidate SHA before promotion |
| CI on `dev` / `main` | Not found in the current audit; NOT TESTED | Execute and record branch-specific workflows |
| Windows 11 and Android hardware | Not device-verified | Physical-device tests and owner acceptance |
| Wake word, voice, pairing and privacy | Not fully device-verified | End-to-end evidence on supported hardware |
| Jenkins and artifact lifecycle | Not live-integration verified | Approved endpoint, publish/retrieve/integrity/recovery evidence |
| Release acceptance | Not accepted | Close P0 security, privacy, device, operations and owner gates |

A green `new` CI run must not be generalized to other branches or physical devices. See [Project Status](PROJECT_STATUS.md) and [Pending Work](PENDING_WORK_REGISTER.md).


## Owner decision update — 2026-11-27

The owner decisions above are settled. Android tooling selection is also settled: use existing Android Studio/SDK, install missing free components locally, and support command-line builds.

Do not classify Nexus as a blocker; it is intentionally paused due to cost. Jenkins remains in use. Physical-device acceptance on the MSI and two Android phones remains a validation activity to be performed when devices are available, not a reason to pause unrelated development. Preserve all existing epic status/evidence until a fresh exact-commit verification is recorded.
