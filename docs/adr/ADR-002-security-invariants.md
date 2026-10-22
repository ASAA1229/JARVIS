# ADR-002: Security Invariants and Policy Gateway Architecture

## Status
Accepted

## Context
JARVIS operates on the invariant that neither user input, external network messages, nor AI planner proposals possess execution authority. The system must enforce default-deny authorization, task-scoped approvals, immediate revocation, tamper-evident audit logging, and verifiable outcomes.

## Invariants & Design Rules

1. **Default-Deny Policy Gateway (`PolicyGateway`)**:
   - Every single requested capability must evaluate against an explicit permission matrix and risk classification table.
   - Low risk (read-only allowlisted system metrics) may execute without human approval if the enrolled device holds the specific permission.
   - State-changing or user-interactive capabilities (such as launching an application) require an explicit, unexpired, task-scoped human approval.
   - Any unmapped operation, unknown argument, or scope expansion is rejected immediately.

2. **Untrusted AI Advisory Boundary**:
   - The AI planner component receives only minimized task context (never secrets, tokens, or private identity keys).
   - The AI planner generates a candidate JSON plan conforming to a strict schema (`PlanSchema`).
   - The AI planner is *strictly isolated* from execution adapters. It can only submit the proposed plan to the Policy Gateway.
   - The AI planner cannot approve plans, grant itself elevated permissions, or modify policy rules.

3. **Cryptographic Device Identity & Revocation**:
   - Each companion device generates an asymmetric keypair (Ed25519) on initial enrollment.
   - Enrollment uses a short-lived (e.g., 120-second), single-use challenge token presented via QR code or secure out-of-band channel, redeemed with authenticator step-up verification.
   - Every companion request must carry an authenticated signature or session token bound to the device's public key.
   - Revocation of a device immediately updates the local revocation state, invalidating active sessions and rejecting subsequent requests.
   - If an in-flight operation is active when a device is revoked, the cancellation token signals interruption, safely terminating or reconciling the task.

4. **Bounded Execution Adapters & Zero Administrator Elevation**:
   - No interactive or unrestricted shells (`cmd.exe /k`, `powershell.exe -Command <arbitrary>`).
   - Only predefined, parameterized operations are registered with the host runner.
   - Process spawning must use explicit arguments (no string-concatenated shell execution).
   - If an operation requires UAC or administrator privileges, it must fail closed and refuse execution.

5. **Outcome Verification & Honest Reporting**:
   - Process launch or command execution return code does not guarantee intended outcome.
   - The `Verifier` inspects observable host evidence (e.g., checking if the specific allowlisted process ID or window title is running).
   - Outcomes are classified as `VERIFIED_SUCCESS`, `VERIFIED_FAILURE`, `PARTIAL_SUCCESS`, or `UNCERTAIN`.
   - An uncertain outcome must never be reported as a success.

6. **Tamper-Evident Audit Logging**:
   - Every authentication attempt, policy evaluation, approval decision, execution start/finish, verification check, and revocation event is appended to an immutable audit log.
   - Each audit record includes a SHA-256 hash chaining mechanism (`prev_hash`, `record_hash`) to detect log tampering or deletion.
   - Secrets, tokens, and private keys are strictly redacted or excluded before audit entry persistence.

## Consequences
- Guaranteed adherence to the README security principles and mandatory safeguards.
- Clear testability: each invariant has corresponding automated security-abuse tests.
