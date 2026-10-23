# JARVIS POC Implementation Plan & Roadmap

## 1. Overview & Authorized Scope
This implementation plan establishes the phased construction of the JARVIS secure personal assistant proof of concept (POC). 
As authorized, implementation proceeds in testable, incremental milestones adhering strictly to the security principles, default-deny policy architecture, and allowlisted Windows operations defined in [README.md](../../README.md) and Architecture Decision Records ([ADR-001](adr/ADR-001-technology-stack.md), [ADR-002](adr/ADR-002-security-invariants.md)).

## 2. Milestone Structure & Status

| Milestone | Title | Focus Area | Status |
|---|---|---|---|
| **M1** | **Foundation & Project Setup** | Environment validation, TypeScript project structure, configuration, crypto utilities, core interfaces, test runner | **PASS — VERIFIED (local Windows environment)** |
| **M2** | **Secure Windows Core** | Policy gateway, default-deny rules, allowlisted read-only system facts, allowlisted app launcher, outcome verifier, tamper-evident audit log | **PARTIAL — local system facts and Notepad path tested; all apps/target acceptance not verified** |
| **M3** | **Android Enrollment & Channel** | Ed25519 keypair identity, single-use enrollment token challenge, session management, revocation engine, web/companion interface | **BLOCKED — browser companion tested; native Android/two-phone acceptance outstanding** |
| **M4** | **Approval & Task Lifecycle** | Task-scoped approvals, expiry, rejection, concurrency interruption, outcome reconciliation, denial paths | **PARTIAL — core paths tested; real adapter concurrency/reconciliation remains unverified** |
| **M5** | **AI Planner Integration** | Replaceable AI provider interface, structured schema validation, local heuristic planner, proof of policy enforcement | **PARTIAL — local planner and adversarial boundary tested; broad intent coverage is incomplete** |
| **M6** | **Verification, Hardening & Release** | Automated security suite, live HTTP E2E tests, recovery semantics | **PARTIAL — local suites pass; performance evidence and WSL/Linux runtime verification are incomplete** |
| **M7** | **Security Remediation & Completion** | Close security findings, regression coverage, browser validation, accurate audit/traceability evidence | **BLOCKED — local checks pass; external acceptance and exact-commit CI remain** |

---

## 3. Detailed Milestone Deliverables

### Milestone 1: Foundation & Project Setup
- Root configuration: `package.json`, `tsconfig.json`.
- Dependency management: zero paid dependencies, relying on Node.js v24 native modules (`node:crypto`, `node:test`, `node:assert`, `node:fs`, `node:child_process`) and lightweight development tools (`tsx`, `typescript`).
- Directory structure:
  - `src/core/` (interfaces, models, errors)
  - `src/crypto/` (Ed25519, hashing, key management, token generation)
  - `src/policy/` (policy engine, risk classification, approval manager)
  - `src/adapters/` (windows system facts, app launcher)
  - `src/audit/` (tamper-evident audit chain)
  - `src/verification/` (outcome observer, verifier)
  - `src/planner/` (AI provider abstraction, schema validator)
  - `src/server/` (HTTP/WebSocket server, companion UI endpoint)
  - `src/companion/` (responsive web companion client for Android/mobile)
  - `test/` (automated test suite)
- Baseline verification tests.

### Milestone 2: Secure Windows Core
- `PolicyGateway`: default-deny evaluator against `OperationType`, `DeviceContext`, `ApprovalRecord`.
- `WindowsSystemAdapter`: strictly allowlisted metrics:
  - OS version / architecture
  - CPU load / uptime
  - Memory statistics
  - Battery / power status
  - Disk space for system drive
- `WindowsAppLauncherAdapter`: strictly allowlisted application identifiers (e.g., `notepad`, `calc`, `paint`). Direct process spawning without shell string concatenation.
- `OutcomeVerifier`: queries Windows process tree / system state to verify actual execution status (`VERIFIED_SUCCESS`, `VERIFIED_FAILURE`, `UNCERTAIN`).
- `AuditLogger`: append-only JSON/WAL store with SHA-256 hash chaining (`prev_hash`).

### Milestone 3: Android Companion & Enrollment
- Companion identity generator (Ed25519 keypair).
- Enrollment challenge generation with 120-second TTL and single-use redemption tracking.
- Session lifecycle: issuance, TTL expiration, permission scoping.
- Instant revocation engine: immediately invalidates keys/sessions and cancels active jobs.
- Interactive companion UI: mobile-responsive UI (dark mode, status indicator, enrollment view, approval cards, task triggers).

### Milestone 4: Approval & Task Lifecycle
- Request dispatcher and task state machine (`CREATED`, `AWAITING_APPROVAL`, `APPROVED`, `EXECUTING`, `COMPLETED`, `FAILED`, `CANCELLED`, `INTERRUPTED`).
- Task-scoped approval tokens cryptographically linked to `(taskId, operation, target, timestamp, expiry)`.
- Scope-expansion rejection: if parameters change after approval, approval is voided.
- Concurrent revocation test: revoking a device while a task is executing cleanly halts execution.

### Milestone 5: Replaceable AI Planner
- AI planner interface: `IPlannerProvider { plan(request: string, context: MinimizedContext): Promise<PlanProposal> }`.
- Heuristic/Deterministic local planner implementation (instant, 0-cost, fully offline).
- Schema validation with strict rejection of unauthorized operations or syntax hallucinations.
- Adversarial test: verify that a maliciously constructed AI response attempting shell access or permission escalation is rejected by the Policy Gateway.

### Milestone 6: Verification, Testing & POC Release
- Test families:
  1. Unit tests (crypto, schemas, policy logic).
  2. Integration tests (end-to-end request lifecycle).
  3. Security abuse tests (expired approvals, altered scopes, unknown devices, revoked sessions, AI bypass attempts, prohibited shell operations).
  4. Fault recovery tests (interrupted task, broken audit chain detection).
- Requirements traceability matrix update.
- Performance and resource usage measurement.
- POC completion summary.

### Milestone 7: Security Remediation & Completion

The current `fix` working tree contains security fixes and regression tests for authenticated enrollment/session creation, least-privilege audit access, audit redaction/integrity failures, authenticated service-level approvals, private policy-gated dispatch, truthful execution outcomes, interruption handling, CSP/XSS-safe HUD rendering, and push-to-talk cancellation/discard/timeout behavior. The 2026-10-23 local audit ran a clean `npm ci`, build, type-check, 51 automated tests, and a real Microsoft Edge smoke test with simulated Web Speech recognition; `npm audit` reported zero vulnerabilities. The tested changes are uncommitted on top of `21c02aee19471a048d3391d1515746d25a87247b`; that commit is the base revision, not an immutable identifier for the tested working tree.

Milestone 7 remains **BLOCKED — NOT COMPLETE** pending hosted CI on an exact remediation commit, owner-device acceptance, native Android/two-phone validation, and physical microphone/browser-vendor privacy verification. WSL Ubuntu is available but has no Linux Node.js runtime, so no Linux test run was possible. Do not begin Milestone 8 until these gates and the remaining audit findings are explicitly dispositioned. See the [Milestones 1–7 acceptance audit](milestones-1-to-7-acceptance-audit.md), [test results](milestones-1-to-7-test-results.md), [findings register](milestones-1-to-7-findings-register.md), [security audit](security-api-feature-audit-2026-10-23.md), and [traceability matrix](traceability-matrix.md) for current evidence and limitations.
