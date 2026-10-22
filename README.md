# JARVIS

**Personal AI assistant — security-first, modular, cross-device.**

JARVIS is planned as a privacy-conscious personal assistant for a Windows laptop and Android companion devices. The project is currently in the **POC planning stage**. Technology choices and detailed implementation decisions remain open where noted below.

> **Status:** Planning only. No application code has been approved or started. Implementation must not begin until the owner gives separate explicit approval.

## POC goal

Prove one secure, end-to-end workflow across the Windows host and an enrolled Android companion:

1. Enroll and authenticate a device.
2. Establish an authenticated, encrypted connection.
3. Receive a user request and translate it into a bounded action plan.
4. Apply policy checks and obtain task-scoped approval when required.
5. Execute only an explicitly permitted, limited operation.
6. Verify the outcome using evidence from the host.
7. Record a privacy-conscious audit event and report the actual result.

The first POC should favor a small, demonstrably secure workflow over broad assistant capabilities. Initial Windows actions are limited to **read-only system information and selected installed-app launching**. Launching an application does not authorize sensitive actions inside it.

## Proposed architecture

A **modular monolith** is the starting architecture proposal. Modules should have clear interfaces so components can be replaced or tested independently.

- **Request intake:** Accepts owner and companion requests.
- **Device identity and sessions:** Maintains independent identities, keys, sessions, permissions, and revocation for each enrolled phone.
- **AI/planner interface:** Allows evaluation of one local model and one cloud option. Models are advisory only and never receive execution authority.
- **Policy gateway:** Enforces default-deny authorization, least privilege, risk classification, preconditions, approvals, and revocation. All state-changing execution must pass through this gateway.
- **Execution adapters:** Expose a small allowlist of host operations rather than unrestricted shell access.
- **Verification and recovery:** Checks observed outcomes, handles interruption, and reconciles uncertain or partial results.
- **Audit and configuration:** Records security-relevant decisions and outcomes while minimizing personal data and redacting secrets.

Technology, storage, networking, and Windows/Android implementation choices are **not yet finalized**. Compare options with small experiments before selecting them.

## Security principles

- Default-deny access; least privilege; owner authority; no self-elevation by delegated administrators or AI.
- A model, external content, files, scripts, and network responses are untrusted inputs.
- Approvals are task-scoped and bound to the device, requested outcome, permitted actions/resources, risk level, and expiry. Material scope changes require new approval.
- Critical actions require stronger confirmation. Voice recognition and a wake word are not authentication.
- Device revocation must immediately prevent new authorized actions from that device; active work must stop safely and be reconciled.
- Offline queues are limited to harmless informational requests. State-changing work must be revalidated before execution; unsafe or non-idempotent actions must never be blindly replayed.
- No administrator elevation. If an operation requires it, stop and explain.
- No unrestricted terminal or script execution. Unknown commands, unsafe arguments, unexpected chaining, and out-of-scope targets are denied.
- File changes are limited to explicitly approved workspaces. Deletion should use a recoverable quarantine where feasible; permanent deletion requires explicit confirmation.
- Secrets must never be exposed to AI models or written to ordinary logs. No telemetry by default.
- If authorization or audit integrity is suspect, fail closed for state-changing actions, preserve available evidence, and notify the owner.
- Financial capabilities are excluded: no bank access, payments/transfers, trading or investment transactions, or financial authentication. These cannot be enabled by broad owner approval.

## Device and connectivity plan

- Windows laptop is the primary host; WSL/Linux is optional and will be evaluated against dependency needs.
- Android starts as a companion with selected phone tools, not unrestricted device access.
- The design should support two Android phones, each with independent identity, keys, sessions, permissions, and immediate revocation.
- Enrollment is proposed to combine a short-lived, one-time QR flow with authenticator verification. TOTP apps (Google/Microsoft Authenticator) and passkeys/security keys will be evaluated; TOTP alone is not authorization.
- Enrollment and revocation are controlled from the owner laptop or an authorized phone with step-up verification.
- Evaluate private VPN/overlay, outbound relay, and local-plus-remote relay approaches. No public unrestricted remote endpoint is planned.
- When the laptop is asleep or unavailable, attempt wake only where supported; otherwise report that it is unavailable. Do not claim an action succeeded without verification.

## POC scope

**Included**
- Security and device-identity foundation.
- One Android companion enrollment and authenticated request path, designed to extend to a second phone.
- Limited read-only Windows information.
- Selected installed-app launching.
- Policy checks, task-scoped approvals, expiry, rejection, and revocation handling.
- Audit events, verification, interruption handling, and basic recovery tests.
- Replaceable local/cloud AI interface, evaluated without granting models execution authority.
- Documentation, threat model, test plan, and traceability from requirements to tests.

**Out of scope for the initial POC**
- Administrator elevation or unrestricted shell access.
- Arbitrary script execution or broad file modification.
- Permanent deletion without explicit confirmation.
- Autonomous sending of messages or submitting forms.
- Broad Android permissions or unrestricted phone control.
- Scheduled autonomous automation and persistent memory until their approval, retention, and deletion policies are implemented.
- Publicly exposed, unrestricted remote access.
- All financial access, authentication, and transactions.

## Acceptance criteria

The POC is acceptable only when documented tests demonstrate that:

- An unregistered, revoked, expired, or unauthorized device cannot perform protected actions.
- Expired, reused, rejected, or scope-expanded approvals cannot authorize execution.
- AI output cannot bypass the policy gateway or grant itself permissions.
- Prohibited actions and out-of-scope commands are denied.
- Revocation prevents new actions immediately and active work is safely interrupted and reconciled.
- Interrupted or disconnected state-changing tasks are not blindly replayed.
- Results are reported as successful only when verified; uncertain and partial outcomes are clearly identified.
- Secrets are absent from model inputs and ordinary audit logs.
- Audit and recovery behavior is tested, including suspected integrity failure.
- Unit, integration, security-abuse, end-to-end, and recovery tests pass; resource usage is measured against thresholds agreed before implementation.

## Planning deliverables before implementation

1. Requirements baseline and open-decision register.
2. Threat model and trust boundaries.
3. Architecture and request-flow diagrams.
4. Risk, permissions, and approval matrix.
5. Technology comparisons and proof-of-concept experiments.
6. Windows/Android environment and dependency plan.
7. Test strategy, acceptance thresholds, and requirements-to-test traceability matrix.
8. Recovery, setup, and operations documentation.

## Open decisions

- Windows account/isolation model and host-side execution boundary.
- Risk tiers and which actions require approval or stronger confirmation.
- Network approach and remote connectivity behavior.
- Windows and Android technology stack.
- Local/cloud model candidates and privacy controls.
- Storage, audit integrity, backup, retention, and verified deletion design.
- Session expiry, enrollment-token lifecycle, and recovery-code storage.
- Performance/resource thresholds and the exact first vertical-slice scenarios.

## Approval gate

**This repository currently documents the proposed POC only. Do not start application coding until the owner explicitly approves implementation as a separate step.** Resolve or explicitly accept the relevant open decisions before committing to implementation choices.
