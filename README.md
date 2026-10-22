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

---

# Architecture, workflows, feature maps, and design diagrams

> These are **planning diagrams**, not a claim that the system is implemented. They capture the current intended boundaries and workflows. Technology choices and unresolved design details remain provisional. GitHub renders the Mermaid diagrams below directly in this README; no separate image assets are required.

## 1. System context and trust boundaries

```mermaid
flowchart LR
    OWNER[Owner]
    PHONE1[Android companion A]
    PHONE2[Android companion B]
    subgraph TRUSTED_HOST["Owner-controlled Windows host"]
        INTAKE[Request intake]
        AUTH[Identity and session manager]
        POLICY[Policy gateway]
        EXEC[Allowlisted execution adapters]
        VERIFY[Outcome verification and recovery]
        AUDIT[Privacy-conscious audit]
        AI[Replaceable AI / planner interface]
        HOST[Windows read-only information and app launcher]
        INTAKE --> AUTH
        INTAKE --> AI
        AI -->|untrusted proposed plan| POLICY
        AUTH --> POLICY
        POLICY -->|authorized bounded operation only| EXEC
        EXEC --> HOST
        HOST --> VERIFY
        VERIFY --> AUDIT
        POLICY --> AUDIT
        AUTH --> AUDIT
    end
    OWNER -->|local authenticated request| INTAKE
    PHONE1 -->|authenticated encrypted channel| INTAKE
    PHONE2 -->|authenticated encrypted channel| INTAKE
    POLICY -.->|deny by default| DENY[Denied / approval required]
    EXT[External content, files, model output, network data]
    EXT -.->|untrusted input| INTAKE
    EXT -.->|untrusted input| AI
```

**Boundary rule:** neither the AI model nor a companion phone can call the execution adapter directly. The policy gateway is the mandatory enforcement point. The network path (private overlay, outbound relay, or hybrid) remains undecided.

## 2. End-to-end request workflow

```mermaid
flowchart TD
    A[Request received] --> B{Device/session valid?}
    B -- No --> X[Reject and audit]
    B -- Yes --> C[Normalize request and define desired outcome]
    C --> D[Build bounded plan]
    D --> E[Classify risk, permissions, target and side effects]
    E --> F{Allowed by policy?}
    F -- No --> X
    F -- Yes --> G{Approval required?}
    G -- Yes --> H[Request task-scoped approval]
    H --> I{Approved, unexpired, same scope?}
    I -- No --> X
    I -- Yes --> J[Re-check authorization and preconditions]
    G -- No --> J
    J --> K{Still valid and device not revoked?}
    K -- No --> X
    K -- Yes --> L[Execute bounded allowlisted operation]
    L --> M[Verify using observed evidence]
    M --> N{Outcome verified?}
    N -- Yes --> O[Audit and report completed]
    N -- Partial --> P[Reconcile partial result and report accurately]
    N -- No / uncertain --> Q[Mark uncertain or failed; recovery path]
    P --> R[Audit and report]
    Q --> R
```

**Invariant:** a request is not successful merely because a command was dispatched. The result must be verified; unknown outcomes are reported as unknown, interrupted, or partial.

## 3. Component and feature map

```mermaid
flowchart TB
    subgraph EXPERIENCE["User experience"]
        VOICE[Voice: wake word / push-to-talk]
        TEXT[Text request]
        STATUS[Visible listening, approval and task status]
        COMPANION[Android companion UI]
    end
    subgraph CORE["Core services — proposed modular monolith"]
        REQUEST[Request and task manager]
        DEVICE[Device identity, permissions and sessions]
        PLAN[AI provider interface and planner]
        POLICY[Authorization and risk policy]
        APPROVAL[Approval lifecycle]
        EXEC[Capability-based execution adapters]
        VERIFY[Verification and reconciliation]
        AUDIT[Audit, retention and incident controls]
        MEMORY[Future memory service — gated / not in initial POC]
    end
    subgraph ADAPTERS["Bounded capabilities"]
        SYS[Read-only Windows system facts]
        APP[Allowlisted installed-app launch]
        PHONE[Selected Android tools — individually permissioned]
    end
    VOICE --> REQUEST
    TEXT --> REQUEST
    COMPANION --> REQUEST
    REQUEST --> STATUS
    REQUEST --> DEVICE
    REQUEST --> PLAN
    PLAN -->|proposal only| POLICY
    DEVICE --> POLICY
    POLICY <--> APPROVAL
    POLICY --> EXEC
    EXEC --> SYS
    EXEC --> APP
    EXEC --> PHONE
    EXEC --> VERIFY
    VERIFY --> AUDIT
    DEVICE --> AUDIT
    POLICY --> AUDIT
    MEMORY -.->|requires separate policy and owner approval| REQUEST
```

| Feature area | POC status | Boundary |
|---|---|---|
| Device enrollment and identity | In scope | Independent identity per phone; revocation supported |
| Read-only Windows information | In scope | Explicit allowlist; no broad machine inspection |
| Launch selected installed apps | In scope | Launch only; no authority over actions inside the app |
| Approval and policy gateway | In scope | Default-deny; task-bound approvals |
| Verification and audit | In scope | Evidence-based outcomes; redact secrets |
| Local/cloud AI comparison | Evaluate in POC | Advisory planner only; no direct execution |
| Voice interface | Later / design consideration | Wake word and voice are not authentication |
| Selected Android phone tools | Limited initial scope | Each permission granted separately |
| Persistent memory | Deferred | Requires approval, retention, privacy and deletion design |
| Automation, broad file operations, unrestricted terminal | Excluded initially | Separate future scope and security review required |
| Financial access or transactions | Prohibited | Not enabled by broad approval |

## 4. AI and model-provider design

```mermaid
flowchart LR
    TASK[Task context builder]
    REDACT[Data minimization and secret filtering]
    INTERFACE[Model provider interface]
    LOCAL[Local model adapter]
    CLOUD[Cloud model adapter]
    VALIDATE[Structured output validation]
    PLAN[Candidate plan]
    POLICY[Independent policy gateway]
    EXEC[Execution adapter]
    TASK --> REDACT --> INTERFACE
    INTERFACE --> LOCAL
    INTERFACE --> CLOUD
    LOCAL --> VALIDATE
    CLOUD --> VALIDATE
    VALIDATE --> PLAN --> POLICY --> EXEC
    EXEC -.->|no direct model access| LOCAL
    EXEC -.->|no direct model access| CLOUD
```

### Model contract

- **Input:** only the minimum task context approved for that request; secrets and unrelated personal data are excluded.
- **Output:** a proposed structured plan, explanation, and uncertainty indicators—not commands with inherent authority.
- **Validation:** schema, allowed operation identifiers, parameter bounds, target scope, and size limits are checked before policy evaluation.
- **Authorization:** performed independently of the model by the policy gateway using the authenticated requester, device permissions, risk classification, approvals, and current preconditions.
- **Provider choice:** one local candidate and one cloud candidate will be compared experimentally. Names, model versions, hardware requirements, latency limits, and cloud disclosure rules are not yet finalized.
- **Failure behavior:** malformed output, provider failure, low confidence, unavailable connectivity, or policy ambiguity must not trigger an unsafe fallback or execution.

## 5. Device enrollment, session, and revocation workflow

The diagram below uses a standard Mermaid flowchart for broad renderer compatibility.

```mermaid
flowchart TD
    A[Owner starts enrollment] --> B[Step-up verification at authorized control point]
    B --> C[Create short-lived one-time enrollment challenge]
    C --> D[Show QR code or one-time challenge]
    D --> E[Android device scans challenge]
    E --> F[Verify authenticator step and redeem challenge]
    F --> G{Challenge valid and unused?}
    G -- No --> H[Reject enrollment and record security event]
    G -- Yes --> I[Register independent device identity]
    I --> J[Assign only approved device permissions]
    J --> K[Create device-bound session]
    K --> L[Record enrollment result in audit]
    L --> M[Device can submit authenticated requests]

    N[Owner or authorized control point requests revocation] --> O[Step-up verification]
    O --> P[Invalidate selected device session and credentials]
    P --> Q[Block new requests from that device]
    Q --> R[Safely interrupt active work]
    R --> S[Reconcile task outcome and record audit event]
```

**Enrollment constraints**

- Each phone has its own identity, keys, session, permissions, and revocation state.
- The enrollment challenge is short-lived, single-use, and rejected if expired or already redeemed.
- Reinstalling the companion app requires re-enrollment.
- TOTP authenticator verification is not authorization by itself. Passkeys/security keys and authenticator options remain technology decisions.
- Enrollment and revocation are available only through the owner laptop or an authorized phone with step-up verification.
- Revocation must prevent new actions immediately. Any in-flight action is safely interrupted and reconciled; irreversible side effects are not assumed to be reversible.
- The exact QR payload, cryptographic key exchange, session expiry, and recovery protocol are not finalized.

## 6. Approval lifecycle and revocation semantics

```mermaid
stateDiagram-v2
    [*] --> Created
    Created --> AwaitingApproval
    Created --> Approved: Policy permits without human approval
    AwaitingApproval --> Approved: Valid approval
    AwaitingApproval --> Rejected
    AwaitingApproval --> Expired
    Created --> Cancelled
    AwaitingApproval --> Cancelled
    Approved --> Executing: Preconditions rechecked
    Approved --> Expired: Approval expires before execution
    Approved --> Cancelled
    Executing --> Completed: Verified success
    Executing --> Failed: Verified failure
    Executing --> Interrupted: Revocation / disconnect / host interruption
    Executing --> AwaitingRecovery: Outcome uncertain
    Interrupted --> AwaitingRecovery: Reconcile state
    AwaitingRecovery --> Completed: Completion independently verified
    AwaitingRecovery --> Failed: Failure independently verified
    AwaitingRecovery --> Interrupted: Still unresolved
```

Approval must be bound to **requester/device, intended outcome, allowed actions and targets, risk tier, expiry, and confirmation strength**. A changed plan or expanded scope requires a new approval. Revocation immediately blocks new actions; in-flight work is interrupted safely, then reconciled. Rollback is attempted only when supported and safe—irreversible side effects cannot be assumed reversible.

## 7. Data flow and trust classification

```mermaid
flowchart TD
    REQUEST[Request and device identity]
    CONTEXT[Minimal task context]
    MODEL[Local or cloud model]
    PROPOSAL[Untrusted plan proposal]
    POLICY[Policy decision + approval record]
    ACTION[Bounded execution request]
    EVIDENCE[Observed execution evidence]
    AUDIT[Redacted audit event]
    RESULT[User-facing result]
    SECRET[Credentials and cryptographic secrets]
    REQUEST --> CONTEXT
    CONTEXT --> MODEL
    MODEL --> PROPOSAL
    PROPOSAL --> POLICY
    POLICY --> ACTION
    ACTION --> EVIDENCE
    EVIDENCE --> RESULT
    REQUEST --> AUDIT
    POLICY --> AUDIT
    EVIDENCE --> AUDIT
    SECRET -.->|isolated; never model-visible or ordinary-loggable| MODEL
    SECRET -.->|separate protected storage| AUDIT
```

| Data category | Intended handling | Must not happen |
|---|---|---|
| Request content | Use for the active task; minimize retained content | Unnecessary retention or unrelated disclosure |
| Device identity and session material | Protected, device-scoped, revocable | Sharing credentials between phones |
| Model context | Minimum necessary; cloud sharing disclosed per task | Include secrets or grant execution authority |
| Proposed plan | Treat as untrusted until validated and authorized | Execute model output directly |
| Approval record | Bind to exact task scope, device, expiry and risk | Reuse for materially changed work |
| Audit events | Record security decisions, action IDs, outcomes and failures; redact secrets | Store passwords, tokens, or unnecessary personal content |
| Memory | Deferred until explicit approval and lifecycle controls exist | Save secrets or sensitive data by default |
| Backups | Encrypt local backup; keep device/credential secrets out of ordinary backups | Treat ordinary backup as a credential vault |

## 8. Permission and risk decision map

```mermaid
flowchart TD
    ACTION[Requested capability] --> CLASSIFY[Identify target, data, side effects and reversibility]
    CLASSIFY --> BLOCK{Prohibited or outside POC?}
    BLOCK -- Yes --> DENY[Deny; explain; audit]
    BLOCK -- No --> PERM{Requester and device have capability permission?}
    PERM -- No --> DENY
    PERM -- Yes --> RISK{Risk tier and confirmation requirement}
    RISK -->|Low-risk read-only allowlisted action| PRE[Check preconditions]
    RISK -->|Approval required| APPROVE[Task-scoped approval]
    RISK -->|Critical action| STRONG[Stronger confirmation / step-up]
    APPROVE --> PRE
    STRONG --> PRE
    PRE --> VALID{Scope still valid, unexpired and not revoked?}
    VALID -- No --> DENY
    VALID -- Yes --> EXEC[Execute through policy gateway]
    EXEC --> VERIFY[Verify outcome and audit]
```

Risk tiers and the exact action-to-approval mapping are **open decisions**. This diagram defines the decision sequence, not final risk assignments. The initial POC should include only narrowly scoped, low-risk read-only operations and selected app launches, with approval/revocation paths tested.

## 9. Connectivity and offline behavior

```mermaid
flowchart TD
    REQUEST[Phone request] --> ONLINE{Authenticated channel available?}
    ONLINE -- Yes --> SESSION[Validate device, session and permissions]
    SESSION --> POLICY[Normal policy and approval workflow]
    ONLINE -- No --> TYPE{Harmless informational request?}
    TYPE -- Yes --> QUEUE[Optional bounded queue; mark pending]
    TYPE -- No --> HOLD[Hold or reject state-changing task]
    QUEUE --> RECONNECT[Connectivity restored]
    RECONNECT --> REVALIDATE[Re-check identity, expiry, authorization, relevance and duplicate status]
    REVALIDATE --> POLICY
    HOLD --> RECONNECT
    POLICY --> RESULT[Verified result or explicit unavailable/uncertain status]
```

No blind replay of non-idempotent or destructive work. If the laptop cannot be reached or woken, the user receives an unavailable status rather than a fabricated success. Wake capability is hardware, OS, power-state, and network dependent and must be tested.

## 10. Requirements-to-test traceability map

| Requirement ID | Requirement area | Verification evidence / test family |
|---|---|---|
| SEC-01 | Unknown, invalid, expired or revoked device denied | Security-abuse and integration tests |
| SEC-02 | Task-scoped approvals cannot be reused or expanded | Approval lifecycle tests |
| SEC-03 | AI cannot bypass policy or grant permissions | Adversarial planner and gateway tests |
| SEC-04 | No administrator elevation or unrestricted execution | Negative tests against execution adapters |
| SEC-05 | Revocation blocks new actions and interrupts active work | Concurrency and interruption tests |
| SEC-06 | Secrets excluded from model context and ordinary logs | Data-flow review and automated redaction tests |
| FLOW-01 | Request follows identity → policy → execution → verification | End-to-end happy-path and denial-path tests |
| FLOW-02 | Uncertain outcomes are not reported as success | Fault injection and reconciliation tests |
| FLOW-03 | Disconnected tasks are revalidated; no unsafe blind replay | Offline/reconnect and duplicate-request tests |
| AUD-01 | Security decisions and outcomes are auditable | Audit completeness, integrity and retention tests |
| REC-01 | Recovery behavior works after interruption or suspected integrity failure | Recovery drills and incident scenarios |
| PRIV-01 | Cloud context is minimized and disclosed per task | Data minimization review and provider-boundary tests |
| SCOPE-01 | POC remains within approved capabilities | Scope-negative tests and acceptance checklist |

These IDs are proposed traceability labels for planning and must be reconciled with the final requirements baseline before implementation. Test thresholds, resource budgets, and complete test cases remain to be agreed.

## 11. Suggested repository documentation map

As the planning work matures, split large documents into dedicated files and link them here:

- `docs/requirements.md` — requirements baseline, priorities, open decisions.
- `docs/architecture.md` — module boundaries, deployment/context diagrams, interface contracts.
- `docs/threat-model.md` — assets, trust boundaries, threat scenarios, mitigations.
- `docs/permissions-and-approvals.md` — risk tiers, capability matrix, approval lifecycle.
- `docs/data-and-privacy.md` — data categories, retention, cloud disclosure, deletion and backup.
- `docs/connectivity-and-devices.md` — enrollment, session lifecycle, connectivity alternatives, revocation.
- `docs/testing-and-acceptance.md` — test cases, traceability, measurable acceptance thresholds.
- `docs/technology-decisions.md` — experiments, comparisons, chosen options and rationale.

These are proposed future planning documents; this README update does not create those files or application code.
