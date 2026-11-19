# JARVIS Epic Register — 2026-11-14

| ID | Epic | Development | Testing | Integration | Acceptance/release |
|---|---|---|---|---|---|
| JAR-E01 | Core runtime and agent architecture | PARTIALLY COMPLETE (local; per-criterion classification) | test/agent_contracts.test.ts; test/conversation.test.ts; full suite 547 tests | Tool integration partial | Ongoing |
| JAR-E02 | Workflow orchestration/DAG | COMPLETE AND VERIFIED (local; per-criterion classification) | test/workflow_execution.test.ts; test/workflow_live_dag.test.ts; test/workflow_dag_service_recovery.test.ts | PRs #61/#63/#64/#65 merged | Operational acceptance pending |
| JAR-E03 | Capability catalogue/safe tools | COMPLETE AND VERIFIED (local; per-criterion classification) | test/app_catalogue_contract.test.ts; test/app_adapter_contracts.test.ts; test/policy_permission_matrix.test.ts | Allowlist catalogue integrated | Device acceptance pending |
| JAR-E04 | Windows desktop/developer automation | PARTIALLY COMPLETE (local; per-criterion classification) | test/windows_desktop_agent.test.ts; test/native_platform_adapters.test.ts; test/plugin_isolation.test.ts; test/developer_ci_commit_binding.test.ts | Adapters behind fail-closed contract | Physical device pending |
| JAR-E05 | Android/per-device sessions | BLOCKED BY EXTERNAL DEPENDENCY (local; per-criterion classification) | test/device_session_extra.test.ts; test/android_protocol.test.ts | Not assessed | Not accepted |
| JAR-E06 | Voice/wake word/audio privacy | PARTIALLY COMPLETE (local; per-criterion classification) | test/voice_utterance_guard.test.ts; test/offline_evaluation.test.ts; test/local_cloud_separation.test.ts | Not verified end to end | Not accepted |
| JAR-E07 | Local/cloud AI/provider integration | COMPLETE AND VERIFIED (local; per-criterion classification) | test/local_cloud_separation.test.ts; test/provider_router.test.ts; test/ollama_provider.test.ts | E2E not verified | Cost/privacy pending |
| JAR-E08 | Security/trust/human approval | COMPLETE AND VERIFIED (local; per-criterion classification) | test/policy_permission_matrix.test.ts; test/device_session_extra.test.ts; test/privacy_log_exclusion.test.ts | Fail-closed; providers disabled | Sensitive action pending |
| JAR-E09 | CI/CD/Jenkins/Nexus | PARTIALLY COMPLETE (local; per-criterion classification) | test/release_bundle_signing.test.ts; test/jenkins_boundary.test.ts; test/sbom_verification.test.ts | Jenkins/Nexus disabled (GAP-023/024 BLOCKED) | External integration pending |
| JAR-E10 | Monitoring/audit/recovery/operations | PARTIALLY COMPLETE (local; per-criterion classification) | test/monitoring_endpoints.test.ts; test/state_backup_restore.test.ts; test/perf_trend.test.ts | Cross-module not verified | Operational acceptance pending |

Recent repo history shows ongoing engineering, not full device/voice/user acceptance or production readiness.

**Reconciled 2026-11-14 (documentation owner):** development, testing, integration and acceptance columns updated to the verified evidence in PROJECT_STATUS.md. Local evidence is not CI evidence (no GitHub Actions run observed; `gh` unauthenticated) and nothing here is CI VERIFIED.

**Reconciled 2026-11-15 (documentation owner):** development, testing, integration and acceptance columns updated to the verified evidence in PROJECT_STATUS.md. Local evidence is not CI evidence (no GitHub Actions run observed; `gh` unauthenticated) and nothing here is CI VERIFIED.


---

## Discovery expansion — Sets 7–12 (2026-11-19)

The questionnaire phase is closed at Set 12. The user selected “all of the above” for every question in Sets 1–12. These selections are **candidate requirements for reconciliation**, not evidence of implementation, a committed delivery promise, or a change to Master Requirements Baseline v1.0.

New cross-cutting candidate requirement domains to map into the existing epic hierarchy:
- Shared architecture, bounded project ownership, API/event contracts, service identities, common directory, configuration and secrets, notifications, documents, search, workflow, audit, observability, reporting and shared AI services.
- Data architecture, domain ownership, master/reference data, validation, synchronization, consistency, privacy, classification, retention/deletion, import/export, migration, lineage, analytics, offline handling and AI data governance.
- Security governance, identity/authentication/authorization, privileged access, application/API/network/device/repository security, secure SDLC, supply-chain controls, encryption, monitoring, vulnerability/incident response, third-party controls and AI/JARVIS safeguards.
- CI/CD, build/test automation, artifact provenance, environment promotion, IaC, deployment strategies, rollback, infrastructure/platform cost controls, multi-platform support and pipeline observability.
- Quality engineering across requirements, acceptance criteria, unit/integration/API/UI/E2E/regression/performance/security/accessibility/compatibility/mobile/desktop/data/AI testing, test data, defects, release gates and UAT.

Reconciliation rules:
1. Preserve all existing epic IDs, evidence, status distinctions and repository-specific architecture.
2. Map applicable candidate requirements to Project → Epic → Sub-epic → Feature → User Story → Tasks → Acceptance Criteria → Dependencies → Status → Evidence.
3. Do not mark a capability implemented, tested, integrated, accepted or released from questionnaire selections alone.
4. Keep PLANNED / NOT ASSESSED / IMPLEMENTED-NEEDS-TESTING / TESTED / INTEGRATED / ACCEPTED / RELEASED distinctions explicit.
5. The approved Master Requirements Baseline v1.0 remains unchanged; any new baseline requires separate approval.
6. Planning/documentation only. No code, tests, deployment, merge, paid service, production change or release is authorized by this update.


Project epic coverage: JAR-E01–E09 plus existing later epic/gap work. Apply the candidate domains as cross-cutting sub-epics/features where applicable; do not create duplicate epics or change existing development/testing/integration/acceptance values without new evidence.
