# JARVIS Personalized Operating Assistant — Product Requirements

**Updated:** 2026-10-24  
**Authority:** JARVIS Gap Closure discovery, Rounds 1–15  
**Status:** Requirements baseline; implementation and acceptance remain incomplete.

## Product definition

JARVIS is a voice-driven personal AI operating assistant intended to evolve into a personal AI operating system. It must do work end-to-end across supported applications and devices, not merely answer questions or open apps.

Initial device scope is the Windows 11 MSI laptop and two Android phones. iOS is outside the current implementation scope. The goal is universal application discovery and capability-based interaction, with honest limits where an operating system or app does not permit automation.

## Owner-approved decisions — 15 rounds

1. **Completion target:** complete personal assistant across Windows and both Android phones, including voice, memory, automation and remote control. Audit gaps before new implementation. Require automated, real-device, security, failure/recovery and documented acceptance evidence. Zero ongoing cost is the target.
2. **Audit scope:** audit main, dev, fix, test, new and enhancement; compare unique commits, features, regressions, missing changes and conflicts without modifying branches during the audit.
3. **Device scope:** Windows 11 MSI laptop and two Android phones; iOS out of scope for this implementation.
4. **Autonomy:** high autonomy within safeguards. Execute permitted multi-step workflows with minimal interruptions; pause for high-risk actions, uncertain permissions and irreversible consequences.
5. **AI:** hybrid local/cloud AI with automatic model selection. Prefer local processing for private, offline and routine tasks; use genuinely free cloud AI when beneficial and authorized. Model output is advisory and never grants execution authority.
6. **Voice:** always-ready local wake phrase is the target, with push-to-talk fallback, visible microphone/listening state, stop control, interruption and spoken responses. No continuous cloud audio upload by default. This target is not accepted until local wake detection and platform behavior are tested.
7. **Memory:** local-first, categorized, user-controlled memory with review, correction, retention and verified deletion. Cross-device encrypted sync is disabled by default unless approved for explicit categories.
8. **Remote access:** each phone has independent device identity, keys, permissions and sessions; secure authenticated transport, replay protection, risk-based approval and immediate revocation are mandatory.
9. **Windows application control:** broad control through approved capabilities—launch supported apps, interact with windows, enter text, use clipboard, control zoom and verify outcomes. All state-changing operations pass the policy gateway; no administrator privileges.
10. **Failure recovery:** stop, reconcile and recover safely. Inspect actual state, determine what succeeded, retry/rollback only when safe, and request approval for risky recovery.
11. **Long-running workflows:** continue autonomously within approved boundaries while the owner is unavailable; preserve state, pause at approval gates and resume after approval.
12. **Scheduled automation:** run approved schedules automatically, recheck permissions/risk at execution time, notify outcomes/failures, and require fresh approval for expired or newly risky actions.
13. **Memory conflicts:** detect outdated/contradictory details, show source/category, ask when needed, and support review, correction, expiry and verified deletion.
14. **Cloud privacy:** prefer local processing for private information. Before cloud sharing when required by policy, disclose what will be shared and why, minimize the data and obtain authorization.
15. **Universal app discovery:** discover installed apps, identify official API and UI capabilities, choose the safest authorized integration, verify outcomes and honestly report unsupported operations.

## Device and resource constraints

- Primary host: Windows 11 Home, Intel Core i5-1235U, 16 GB RAM, Intel Iris Xe graphics.
- Companion devices: two Android phones; exact OS versions, OEM behavior and permissions must be checked during acceptance.
- Prefer free/open-source components and zero ongoing cost. Verify free-tier terms, quotas, rate limits and availability instead of assuming a cloud provider is free.
- Favor resource-efficient background services, local wake detection and automatic model selection. Benchmark before selecting local models.
- Do not store or infer secrets; credentials belong in the OS vault or appropriate secure storage.

## Capability domains

### Voice and conversation
- Local wake phrase, push-to-talk fallback, transcript review, spoken responses, interruption, cancellation and task continuation.
- Custom wake phrase and professional vocal style.
- Visible microphone/listening state, privacy controls and graceful failure states.
- Do not treat voice recognition as strong authentication.

### Windows desktop and system
- Discover and launch installed/built-in apps; inspect active window and accessibility context.
- Enter text, use clipboard, operate supported controls, use allowlisted hotkeys and zoom, and verify the result.
- Read-only system/resource monitoring.
- User-folder and explicitly scoped workspace file operations; deletion quarantine and recovery.
- Approved terminal commands and reviewed scripts; no unrestricted shell or admin escalation.

### Android and cross-device control
- Native device-side agent with Android Keystore-backed device key, independent enrollment, signed requests and immediate revocation.
- App discovery/launch, notifications, and selected messaging/telephony operations only through permitted platform APIs or explicit user-enabled accessibility capability.
- Secure remote laptop control with reachability checks. If the laptop is unreachable, queue harmless informational tasks only; reject or revalidate state-changing work.
- Do not claim that a browser PWA has native Android authority.

### Universal applications and communications
Target scope includes email, WhatsApp, SMS, normal cellular calls, supported online/VoIP calls, Microsoft Teams chats/meetings, Microsoft 365, documents, calendars, reminders, and other installed/built-in applications. Support is capability-based and staged; an app without a safe/authorized integration must be marked partial or unsupported.

**Email approval workflow:** the owner supplies recipients, CC recipients, a concept and relevant context/timing. JARVIS drafts the subject/body with AI, reads the complete To/CC/subject/body/timing aloud, and waits for the exact spoken approval word “approved” before sending or scheduling. Approval binds to the exact recipients, content and timing; material edits require fresh approval. Verify service confirmation before reporting sent.

The same task-oriented approach applies to messages, calls and meetings, with approvals appropriate to risk and platform rules. Do not claim a message was sent, a call connected or a meeting scheduled without confirmed evidence.

### AI, memory and workflow engine
- Replaceable local/cloud model interface and automatic selection by task complexity, quality, hardware, privacy and connectivity.
- Cloud sharing minimized and authorized according to the privacy policy; no model receives execution authority.
- Personal memory supports categories, sources, review, correction, contradiction handling, expiry, retention and verified deletion.
- Multi-step planning, checkpoints, clarification, cancellation, idempotency, timeouts, durable state, safe retries and outcome verification.
- Scheduled/recurring/conditional workflows with run-time authorization checks, expiry and failure notifications.

## Approval and security model

- Default deny. Unknown operations are rejected.
- Read-only and eligible low-risk allowlisted queries may run automatically.
- State-changing actions are risk-classified; outbound communication, file changes, app installation, clipboard writes and other consequential operations use the applicable approval policy.
- Approval binds authenticated device, task, operation, canonical parameters hash and expiry; one-time approvals cannot be replayed.
- Strong owner authentication and step-up are required for sensitive security management. Voice alone cannot authorize high-risk operations.
- Separate device identities, keys, permissions and sessions; stale/expired sessions and replayed requests are rejected.
- Audit events are tamper-evident, redacted and retained for the defined 30-day target. Audit-integrity/persistence failures fail closed.
- Credentials isolated in OS vault; local backup encrypted; no telemetry.
- Strictly block financial/payment application automation, credential entry, unrestricted shell execution, security bypass, administrator elevation and voice-only unlocking.
- On unexpected state, stop dependent actions, reconcile, and retry or roll back only if safe. Never claim uncertain results are success.

## Platform constraints

- Windows: prefer UI Automation/accessibility and explicit target selection. Foreground-window and process-name heuristics are not sufficient for universal control or perfect sensitive-app detection.
- Android: native companion and explicit OS permissions are required; capabilities vary by Android version/OEM. AccessibilityService requires explicit enablement and transparent disclosure.
- iOS: no unrestricted cross-app control; supported intents/shortcuts would be required if scope changes in a future owner-approved phase.
- APIs, app terms, OS restrictions and user/OS confirmations take precedence over the universal goal. Never bypass security controls or silently sideload apps.
- Web/browser UI automation alone is not a substitute for a device-side agent.

## Delivery and definition of done

Each capability must include a platform, required permission, risk tier, adapter, policy check, audit event, failure/recovery behavior, verification method, automated tests and target-device acceptance evidence. Status must be one of implemented, partial, planned or restricted.

A feature is not complete because code exists or CI passes. It is complete only when the exact source commit passes relevant tests and the real target device demonstrates the expected action and independently verifiable outcome. Overall POC remains blocked until the POC2 acceptance register is closed.
