# JARVIS Personalized Operating Assistant — Product Requirements

## Product definition

JARVIS is a personalized, cross-device operating assistant for its owner. It combines conversational assistance, information retrieval, device control, application automation, personal memory, task planning, proactive workflows, and auditable execution. The HUD is an interface, not the boundary of the product.

This document records the target product vision. A capability marked planned or partial is not a claim that the current code can perform it.

## Product principles

1. **Owner-specific:** preferences, memory, routines, voice, projects, devices, and rules are explicitly configurable.
2. **Cross-device:** Windows is the primary control center; enrolled Android and iOS devices are targets/companions according to each OS's supported capabilities.
3. **Intent to verified outcome:** understand → clarify if ambiguous → plan → authorize → execute through a device-side adapter → verify → audit.
4. **Default deny:** AI planning never grants authority. Every state-changing action must pass the policy gateway and a registered executor.
5. **Honest status:** report verified success, verified failure, partial success, or uncertainty. Never claim an action succeeded solely because a command was sent.
6. **Local-first and cost-aware:** use local processing where practical; disclose and minimize any cloud sharing; prefer free/open-source components when suitable.
7. **Replaceable components:** planner, model providers, voice input/output, device agents, store adapters, and application adapters use stable interfaces.
8. **No privilege escalation:** no administrator access by default, no arbitrary shell execution, no bypassing OS security, and no silent sideloading.
9. **Safety exclusions:** financial/payment applications and payment flows are excluded from general-purpose UI automation. Examples include PhonePe, Paytm, and Google Pay.
10. **Main is release-protected:** feature work stays on a non-main branch and is proposed to `dev` by PR; the owner handles any eventual `dev` to `main` merge manually.

## Capability domains

- Conversation: speech/text input, wake phrase as an opt-in feature, push-to-talk, transcript review, spoken responses, follow-up context, multilingual capability where supported.
- Personal context: owner profile, explicit memory, project context, preferences, schedules, routines, retention and deletion controls.
- Windows desktop: discover/launch applications; active-window and accessibility context; keyboard, pointer, clipboard, text entry, zoom and window control; permitted file operations; system monitoring.
- Mobile: app launching and supported accessibility actions on enrolled Android; supported app shortcuts/integrations on iOS; phone ring/find workflows; device-specific permissions and revocation.
- Official stores: search the target OS's official store, verify app identity/publisher, show target device and request approval before installation; never silently sideload.
- Web and knowledge: search, summarize, research and cite sources; open the correct browser/application; separate untrusted page content from trusted instructions.
- Workflow engine: multi-step planning, checkpoints, user clarification, cancellation, retries only when safe, timeouts, interruption/reconciliation, idempotency and outcome verification.
- Developer assistant: repository-aware tasks, Git, tests, build/log analysis and approved terminal allowlists; review scripts before execution and scope file changes.
- Proactive assistance: opt-in reminders, scheduled workflows, health/status alerts and suggestions; quiet hours and notification preferences.
- Device coordination: per-device identity, capability discovery, authenticated transport, reachability checks, queue only harmless informational work while offline, and revalidate state-changing work.
- Security and observability: least privilege, task-scoped approvals, strong authentication, revocation, audit chain, redaction, retention controls, encrypted local backups and fail-closed behavior.

## Approval model

- Read-only, low-risk, allowlisted queries may run automatically.
- App launch, installation, file changes, clipboard writes, external communication, system changes and other state-changing actions are assigned explicit risk tiers and require the policy-defined approval.
- Approval is bound to the authenticated device, operation, canonical parameters and expiry. Remembered approvals are opt-in, narrowly scoped, revocable and unavailable for sensitive operations.
- Payment/financial app automation, credential entry, transactions, bypassing device lock, disabling security controls, unrestricted shell execution and administrator elevation remain blocked.
- Voice recognition is not equivalent to strong authentication. Voice alone must not unlock a device or authorize high-risk actions. Future hands-free unlock must use OS-supported secure authentication and anti-spoofing.

## Platform constraints

- Windows desktop automation should prefer UI Automation/accessibility APIs and narrowly scoped adapters, with user-visible activity and cancellation.
- Android automation requires explicit platform permissions and a separately installed device-side companion/agent; capability varies by OEM and Android version.
- iOS does not permit unrestricted background control of other apps. Use supported Shortcuts, app intents, system integrations and Apple-approved device-finding mechanisms.
- Browser APIs alone cannot provide reliable arbitrary OS-level control. Desktop/mobile control must be implemented in authenticated device-side agents.
- App-store search does not imply that the app can be installed silently or that every store exposes a public installation API. Approval and user/OS interaction may be required.

## Delivery and acceptance

Build in independently testable increments. Each feature must include: requirements, permission/risk classification, a concrete adapter, failure handling, audit events, unit tests, integration tests where possible, and explicit acceptance evidence on target devices. Do not label a capability implemented until its actual action and verification path work.

### Milestones

1. Restore a green baseline and resolve the outstanding enrollment/platform regression.
2. Capability registry, per-platform capability discovery and explicit unsupported/partial states.
3. Windows desktop agent foundation: authenticated local IPC, allowlisted launch and UI Automation adapter, foreground-window context and cancellation.
4. Intent/plan improvements and safe multi-step workflow lifecycle.
5. Clipboard, text entry, zoom and file workflows, each with scoped approval and outcome verification.
6. Android companion agent, secure enrollment/transport, app launch and ring-device integration.
7. Official-store discovery and approval-led installation workflows.
8. Personal memory, owner preferences, routines and retention controls.
9. iOS-supported integrations and documented limitations.
10. Opt-in wake-word/voice identity work only after voice privacy, anti-spoofing and secure authentication review.
11. Proactive workflows, recovery, observability and full cross-device acceptance tests.

## Definition of done

A capability is done only when the code exists, tests pass, the relevant permission and approval rules are enforced server-side, the executor runs on the target OS, results are independently verified, failures are truthful, audit records are produced, and the target-device test evidence is documented. Passing TypeScript checks alone is not sufficient.
