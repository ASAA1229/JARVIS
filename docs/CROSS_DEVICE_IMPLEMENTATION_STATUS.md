# Cross-Device Agent Protocol and Implementation Status

## Execution architecture

The server is the planner and policy authority; it is not itself a universal device controller. Each target device must run a device-side agent that advertises supported capabilities and executes only signed, policy-authorized requests.

### Request lifecycle

1. The user submits a voice/text goal from an enrolled device.
2. The planner produces a bounded list of typed operations. Model output is advisory only.
3. The policy gateway validates every operation and parameters.
4. Each state-changing step obtains a task-scoped approval. Approval binds the device, operation, canonical parameters hash, and expiry.
5. The authenticated device agent executes the action with cancellation and a timeout.
6. The agent returns structured evidence; JARVIS verifies the result and appends an audit record.
7. The next workflow step is evaluated independently. A failure or uncertain result stops the workflow.

### Signed HTTP requests

Native clients must use the same device-bound session and signed-request protocol as the existing companion. Signatures must bind the HTTP method, request path, session ID, timestamp, nonce, and SHA-256 body digest. Nonces are single-use. Do not embed owner control tokens or shared server secrets in mobile apps.

## Windows agent

src/adapters/windowsDesktopAgent.ts implements a bounded foreground-window adapter for explicit text entry, clipboard selection/paste, allowlisted hotkeys, and zoom shortcuts. It uses PowerShell in non-interactive STA mode without shell:true, requires the existing app-launch permission, and each state-changing operation is approval-gated.

Current limitations:
- The desktop interaction adapter targets the current foreground window, not arbitrary hidden windows. UI Automation currently enumerates immediate controls and requires exact unique control names; it is not complete automation for every custom-rendered app.
- Keyboard/clipboard acknowledgement is not proof that an application accepted or saved the content. Those actions are reported as partial until stronger UI Automation verification is available.
- Financial/payment application names in the foreground process/window title are blocked as a defense-in-depth check; this heuristic is not a complete way to detect every financial website or app.
- This is not yet universal Windows UI Automation. A production agent should use a dedicated Windows UI Automation implementation, explicit target selection, accessibility-tree inspection, and stronger foreground identity checks.

### Supported bounded workflows

- zoom in, zoom out, reset zoom sends an app-appropriate keyboard shortcut to the foreground window.
- type <explicit text> pastes the supplied text to the foreground window after approval.
- copy selected text copies the current selection and returns its text; this can expose sensitive data, so approval is required.
- copy this and paste it into Notepad plans copy → launch Notepad → paste. Each step passes policy independently.
- open Notepad and write <explicit text> launches Notepad and enters the supplied text after approval.
- open Notepad and write my name is not executed if a verified owner name is unavailable; JARVIS asks the owner to configure or provide it.

## Personal memory

src/memory/personalMemoryStore.ts provides local AES-256-GCM encrypted storage derived from the configured owner control token, integrity verification on read, atomic writes, TTLs, categories, and conservative rejection of credential/payment-like content. The /api/memory endpoints require a signed authenticated session and DEVICE_MANAGE permission.

Voice/text requests such as 'remember my name is Abhishek' and 'what do you remember about me' are routed to owner-only memory operations. Save/delete operations require approval; memory listing requires DEVICE_MANAGE. The initial memory implementation is not a substitute for a full profile UI, semantic retrieval, verified deletion across backups, or richer retention controls. Those remain required before memory should be considered complete.

## Official store discovery

POST /api/store-search is authenticated and returns official Microsoft Store, Google Play, or Apple App Store search URLs. It excludes known payment app names. It does not silently install software: installation must continue through the official store and its user/OS confirmation flow. Automated installation is platform-dependent and not claimed as implemented.

## Android and iOS

Native agents are not yet complete. They must be separately installed and enrolled; web browser capabilities cannot substitute for native OS authority.

Android implementation requirements:
- Keystore-backed device key, authenticated enrollment, signed requests, revocation checks, and least-privilege permissions.
- App launch through package manager; ring/find through OS-supported features; AccessibilityService only after explicit user enablement and with a clear privacy indicator.
- Store installation remains a Play Store handoff with user confirmation; no silent install or sideload.

iOS implementation requirements:
- Device-bound authentication and supported Shortcuts/App Intents, app URL schemes where available, and Apple-approved Find My integration.
- Do not promise unrestricted cross-app control, background automation, or voice-only unlocking. iOS restrictions must be surfaced as unsupported/partial capabilities.

## Validation boundary

CI can validate TypeScript, planner/policy behavior, encrypted memory, and store URL generation. It cannot prove that a Windows app received text, that zoom changed visually, or that mobile controls work on physical devices. Windows UI tests and Android/iOS device tests are still required before claiming universal control.