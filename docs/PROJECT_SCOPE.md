# JARVIS Project Scope

**Project:** JARVIS — personal AI assistant, developer assistant and automation platform  
**Repository:** https://github.com/ASAA1229/JARVIS  
**Scope version:** 2026-11-14 | **Status:** existing implementation must be preserved and assessed incrementally

## Mission
Evolve the existing JARVIS implementation toward a personal AI operating system for assistance, development workflows, voice/device interaction and authorized automation.

## Users and target devices
Owner-operated. Initial targets: Windows 11 MSI laptop and two Android phones, with per-device sessions and device-aware authorization.

## In scope
- Existing agent/runtime and tool architecture.
- Workflow orchestration, DAG execution, task state and recovery.
- Capability catalogue and allowlisted tool execution.
- Windows desktop/developer assistance and Android integrations.
- Voice interface and custom wake phrase.
- Local/cloud model routing and provider controls.
- Device/session management, QR and authenticator preference.
- Permission, trust policy, human approval, audit and privacy safeguards.
- CI/release automation, future Jenkins/Nexus integration, observability and recovery.

## User-established constraints
- Custom wake phrase: **“Hey Jarvis”**.
- Ready response: **“Hi sir, I am ready to work”**.
- Hybrid local/cloud; avoid continuous cloud audio upload.
- Zero ongoing cost target unless explicitly changed.
- High autonomy only within authorization and safety boundaries.
- Payment-app automation is excluded.
- Prefer QR + authenticator for device pairing/authentication.

## Conditional / excluded
No unrestricted sensitive actions, payment-app automation, always-on cloud audio streaming, or paid services without explicit approval. Jenkins/Nexus integrations remain conditional until configured and verified.

## Current status summary
Recent repository history through 2026-11-14 includes merged workflow-DAG integration and CI hardening, capability-catalogue work, fail-closed platform adapters, disabled Jenkins/Nexus providers and release/test documentation. These are repository changes, not proof of physical-device, voice, Android or production acceptance. Preserve existing work; do not restart from basics.
