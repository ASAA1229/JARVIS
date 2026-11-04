# JARVIS — Master Repository Documentation

**Snapshot date:** 2026-10-24  
**Current planning baseline:** JARVIS Gap Closure Rounds 1–15  
**Disposition:** POC foundation exists; universal assistant acceptance remains **BLOCKED / NOT RELEASE-READY**.

This is the current summary of product scope, implementation evidence, branch policy and acceptance blockers. Historical source-document consolidation is retained in Mast_repo_md2.md; this file is not a claim that every historical item has been revalidated.

## 1. Product goal

JARVIS is a security-first, voice-driven personal AI operating assistant intended to do work end-to-end across supported applications and devices. Initial devices are the Windows 11 MSI laptop and two Android phones. The goal includes Windows application control, email, WhatsApp and other messaging, SMS, supported normal/online calls, Microsoft Teams, Microsoft 365, documents, calendars, reminders, recurring schedules and multi-step workflows.

The universal application goal is capability-based discovery and automation, not an unsupported promise of unrestricted control. JARVIS must identify the safest permitted API/UI adapter, verify the outcome, and report unsupported operations honestly.

## 2. Current repository and branch state

At the start of the 2026-10-24 audit, remote branches were main, dev and new. PR #12 (new → dev feature integration) merged at d061216b2a007992e4ddae912d8e88c812934bd1. PR #13 (documentation reconciliation) merged at 29df6b8699a8145f2163efee0c0ac306af2e7adc.

Missing role branches fix, test and enhancement were recreated from dev and fast-forwarded to the current dev integration commit. main remains unchanged at 5c7d8d303862de6ac730db9e15855b5f6a70af59.

- main: production/release; owner-controlled final release only.
- dev: integration target; non-main changes arrive through PR.
- fix: bug fixes and regression work.
- test: test, audit and evidence work.
- new: staged feature development; its tree matched dev at the PR #13 merge.
- enhancement: broader feature enhancements.

Never force-push, rewrite history, discard dirty work, or delete branches without explicit authorization. Do not commit/push directly to dev. PRs target dev only. Never automate a merge into main; the owner performs any eventual dev → main release merge manually.

## 3. Current source status

- Runtime: Node.js 24 + TypeScript modular monolith.
- Server: currently loopback-bound; this does not enable secure remote phone access.
- Security: Ed25519 device/session foundation, signed requests, replay checks, enrollment proof-of-possession, owner approval/TOTP step-up, revocation, default-deny policy gateway, task-bound approvals, and hash-chained audit logging.
- Windows: selected read-only system queries, small static app allowlist plus constrained Start-menu discovery, and bounded foreground-window UI Automation for text, clipboard, hotkeys, zoom and named controls.
- Companion: browser HUD with text fallback and explicit push-to-talk; optional Piper TTS and browser speech synthesis.
- Memory: encrypted local categorized store with TTL/integrity foundations.
- Store: official-store search destinations only, not silent installation.
- Capability registry distinguishes implemented, partial, planned and restricted.

See POC.md for the evidence-backed current baseline, POC2.md for the acceptance register, docs/PERSONALIZED_JARVIS_REQUIREMENTS.md for the 15 discovery decisions, and docs/CROSS_DEVICE_IMPLEMENTATION_STATUS.md for cross-device limits.

## 4. Hosted CI evidence

- new documentation head 6dd9d8d62ccf2610fb458da159fc1dd11f47079c: successful CI run https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099231737
- dev integration commit 29df6b8699a8145f2163efee0c0ac306af2e7adc: successful CI run https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099365008
- fix at the same integration commit: successful CI run https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099378785
- test at the same integration commit: successful CI run https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099381517
- PR #13 documentation reconciliation is merged: https://github.com/Guda-Abhishek/JARVIS/pull/13

The new commit message records the final 103-test security CI pass. These results cover configured CI only. They do not prove real Windows UI acceptance, physical audio, native Android, messaging/call integrations, or universal app control. npm audit remains unverified in the current baseline.

## 5. Architecture and execution flow

Request → device/session authentication → bounded intent/planner → PolicyGateway → task-scoped approval when required → authorized adapter → outcome verification → audit → user-visible result.

Planner/model output is advisory only and never directly executes an action. Each state-changing operation must pass the central policy gateway and a registered executor. Approval is bound to task, device, operation, canonical parameters and expiry. Unexpected state stops dependent steps; retries and rollback are permitted only when safe.

## 6. Security invariants

1. Default deny; unknown operations are rejected.
2. No unrestricted shell, administrator elevation or security bypass.
3. Strict blocks remain for financial/payment automation, credential entry and voice-only high-risk authentication.
4. Independent device identities, keys, permissions and sessions; replay and expired/revoked requests are rejected.
5. Audit records are tamper-evident and redacted; security-state failures fail closed.
6. No success claim based only on command dispatch or a mock.
7. User-folder/workspace scope, deletion quarantine/recovery, reviewed scripts and risk-based approvals are required before broad file/terminal control.
8. Local-first memory and private-data handling; cloud sharing must be minimized and authorized according to policy.
9. Remote operation remains disabled until authenticated transport, device authorization and physical-device acceptance are proven.
10. Mic/listening state must be visible and controllable. Wake-word listening remains off until the desired local implementation is validated.

## 7. Capability and gap summary

| Capability | Current status | Main acceptance gap |
|---|---|---|
| Build/static checks/tests/browser smoke | CI green on listed commits | Rerun after docs update; check each recreated branch run |
| Device identity/approval gateway/audit | Implemented foundation | Independent review, complete API edge cases and recovery tests |
| Windows app launch | Partial | Real target laptop, visible process/window and end-to-end verification |
| Windows desktop interaction | Partial | Accessibility edge cases, destination verification, foreground safety and recovery |
| Voice/HUD | Partial | Local always-ready wake phrase, physical mic, actual TTS and privacy validation |
| Personal memory | Partial | User review/conflict UI, retrieval, retention and verified deletion across backups |
| Native Android and two phones | Planned/incomplete | Native agent, Android Keystore, secure remote transport and physical-device acceptance |
| Email, WhatsApp, SMS, calls, Teams, Microsoft 365 | Planned/incomplete | End-to-end app integrations, approval workflow and outcome confirmation |
| Durable scheduled workflows | Planned/incomplete | Persistent state, recurrence, unattended execution and safe reconnect/recovery |
| Universal application discovery/control | Partial/planned | Capability inventory and staged adapter coverage |
| Official app installation | Partial | Current implementation is store-search handoff only |
| Dependency advisory audit | Unverified | Successful npm registry advisory check |
| Physical/independent security acceptance | Open | Target devices and independent adversarial review |

## 8. Voice and gesture boundaries

The current companion uses explicit push-to-talk and text fallback. Browser recognition may be vendor/cloud-dependent; local/offline recognition is not proven. The voice manager defaults wake-word listening off. Optional Piper TTS needs target-laptop command-line and audible playback acceptance.

The gesture preview is local/opt-in and does not authorize backend actions. Physical precision, false activation, latency, sustained resource use and policy-routed action integration require separate acceptance.

## 9. Android and remote access

The current source tree has no complete native Android agent. A browser PWA does not provide Android Keystore authority or unrestricted background telephony. Do not expose the loopback server to LAN/public clients until secure transport, enrollment, signed requests, replay resistance, endpoint authorization, session revocation and task-scoped approval are reviewed and tested. Test both phones independently; revoking one must not affect the other.

## 10. POC documentation convention

- POC.md contains implemented behavior supported by evidence.
- POC2.md contains incomplete criteria, blockers, unverified behavior and required acceptance evidence.
- Move an item from POC2 to POC only after the actual action and outcome-verification path passes.
- Update existing documents; do not create duplicate Markdown status/requirements files.
- Mast_repo_md2.md is the historical consolidated source archive and should not be mistaken for a fresh test run.

## 11. Required next steps

1. Re-run exact-commit CI after the current documentation updates and check recreated branch runs.
2. Close security/approval/API/transport blockers before broad automation.
3. Validate the Windows desktop agent and physical voice behavior on the target MSI.
4. Implement and test native Android agents on both phones.
5. Add communication/calendar/application adapters incrementally, with official integrations where possible.
6. Implement durable workflow/scheduler, local/cloud privacy routing and full user-controlled memory lifecycle.
7. Run failure-injection, performance, privacy, memory deletion and independent security acceptance.
8. Keep main untouched; integrate non-main work through PRs to dev.

## Overall assessment

JARVIS has a useful security-oriented foundation and a green automated baseline, but it is **not yet the planned universal personal assistant**. Native Android and remote operation, local always-ready voice, real Windows acceptance, end-to-end communications, durable scheduling, and full memory lifecycle are the largest gaps. The next implementation phase should follow POC2's acceptance register and the staged security-first delivery plan.
