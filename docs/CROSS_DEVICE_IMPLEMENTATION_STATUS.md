# Cross-Device Agent Protocol and Implementation Status

**Updated:** 2026-10-24  
**Status:** Windows local POC foundation present; native Android agents and secure remote operation are not yet accepted.

## Architecture target

The server is the planner and policy authority; it is not itself a universal device controller. Each target device must run a device-side agent that advertises capabilities and executes only authenticated, policy-authorized requests.

1. User submits a voice/text goal from an enrolled device.
2. Planner produces a bounded list of typed operations; model output is advisory.
3. Policy gateway validates every operation and parameter.
4. State-changing steps obtain task-scoped approval when required. Approval binds device, task, operation, canonical parameter hash and expiry.
5. Authenticated device-side adapter executes with cancellation and timeout.
6. Adapter returns structured evidence; verifier evaluates the result and audit records the outcome.
7. Each following workflow step is checked independently. Unexpected state or uncertain outcome stops dependent actions.

## Current repository evidence

The current source includes:
- Ed25519 device identity/session foundations and signed request validation.
- Timestamp/nonce replay protection and device revocation.
- Enrollment transactions with owner approval and TOTP step-up.
- Default-deny policy checks and task/device/operation/parameter-bound approval logic.
- Hash-chained audit records and encrypted local memory.
- A bounded Windows foreground-window adapter and selected application launch.
- A browser-based companion/HUD.

The source tree does **not** contain a completed native Android application/agent. The web companion does not provide native Android Keystore, unrestricted app control, or background telephony authority.

## Signed request requirements

Native clients must use the device-bound session and signed-request protocol. Signatures bind HTTP method, request path, session ID, timestamp, nonce and SHA-256 body digest. Nonces are single-use. Never embed owner control tokens or shared server secrets in mobile apps. Device revocation and session expiry must be checked at execution time.

## Windows agent

The current Windows adapter targets the foreground window and supports bounded actions such as explicit text paste, selected-text copy, allowlisted hotkeys, zoom shortcuts, foreground-window inspection, unique-name control invocation and value-setting. The app launcher has a small static allowlist and constrained Start-menu discovery.

Limitations:
- It is not universal control of every installed Windows app.
- UI Automation requires accessible controls and exact unique names; custom-rendered apps may not expose usable controls.
- Clipboard/keyboard acknowledgements do not prove that destination content was accepted or saved.
- Financial/payment protection based on process/window names is defense in depth, not complete detection.
- Physical target-Windows acceptance is still required.

## Android requirements

- Native companion/agent with Android Keystore-backed device key.
- Independent enrollment, identity, sessions, permissions and revocation for each phone.
- Signed requests, replay protection, secure authenticated transport and run-time authorization.
- App discovery/launch through permitted OS APIs; selected notifications, messaging and telephony only where platform and app capabilities permit.
- AccessibilityService only after explicit user enablement, with transparent disclosure and narrow permissions.
- Real two-phone acceptance: enroll both, verify independent keys/permissions, revoke one, and prove the other remains usable.
- Remote control must remain disabled until transport, authorization and physical-device acceptance are proven.

## Laptop reachability and recovery

- Check authenticated reachability and current session before execution.
- If the laptop is asleep, attempt wake only through an explicitly supported and configured mechanism.
- If unavailable, queue harmless informational tasks only. Reject or revalidate state-changing tasks on reconnection.
- On unexpected state, stop dependent operations, reconcile what happened, and retry/roll back only when safe.
- Do not report success without evidence.

## Universal app discovery and integrations

The target is to discover installed and built-in apps on Windows and both Android phones, identify available official APIs and accessible UI capabilities, then select the safest authorized adapter. Unsupported capabilities must be reported explicitly.

Email, WhatsApp, SMS, normal cellular calls, supported VoIP calls, Teams, Microsoft 365, calendar scheduling and other application integrations remain incomplete until their end-to-end adapters and acceptance tests exist. Official-store search currently generates official search destinations; it does not install apps.

## Memory and AI privacy

The encrypted local memory store is an initial foundation, not a complete user-facing memory system. Rich retrieval, conflict resolution, source visibility, cross-device sync, retention workflows and verified deletion across backups remain open.

Prefer local AI for private data. Before cloud sharing when required, disclose the data and purpose, minimize the payload, and obtain authorization. The planner/model never bypasses the policy gateway.

## Validation boundary

Hosted CI can validate TypeScript, planner/policy behavior, encrypted memory and adapter tests. It cannot prove that an actual Windows application received/saved text, that zoom changed visually, or that native Android controls work on physical devices. Keep universal application control, always-ready local wake-word behavior, two-phone remote operation, communications integrations and recurring unattended workflows marked partial/planned until target acceptance evidence exists.
