# JARVIS

**Security-first personal AI assistant POC — Windows host and browser-based companion, with native Android agents planned.**

> **Current status (2026-10-24): NOT RELEASE-READY.** The repository has a working security-oriented backend foundation and a successful hosted CI run, but the universal assistant vision is not implemented end-to-end. See [POC](POC.md), [POC2 gap register](POC2.md), [personalized requirements](docs/PERSONALIZED_JARVIS_REQUIREMENTS.md), [cross-device status](docs/CROSS_DEVICE_IMPLEMENTATION_STATUS.md), and [repository audit](docs/repository-audit-2026-10-24.md).

## Branch and PR status

- main: production/release branch; automated work must not commit, push, or merge to it.
- dev: integration branch. PR #12 from new was merged on 2026-10-24.
- new: feature/gap-closure branch. Its documentation reconciliation was integrated through PR #13.
- fix, test, enhancement: recreated from dev on 2026-10-24 because they were absent from the remote branch list; all three were fast-forwarded to the current dev integration commit.
- PRs from non-main branches target dev. The owner performs any eventual dev → main merge manually.

## Product goal

JARVIS should become a voice-driven personal AI operating assistant for the user's Windows 11 laptop and two Android phones. It should handle work end-to-end across supported applications: Windows desktop control, email, WhatsApp and other messaging, SMS, normal and supported online calls, Microsoft Teams, Microsoft 365, documents, calendars, reminders, and scheduled multi-step workflows.

The universal goal is capability-based: discover installed/built-in applications, inspect available official APIs and accessible UI capabilities, select the safest authorized adapter, verify results, and clearly report unsupported operations. It is not a claim of unrestricted control over every app or OS.

## Current implementation baseline

- Node.js 24 + TypeScript modular monolith.
- Ed25519 device identity/session and signed-request foundation, replay protection, enrollment and TOTP owner step-up, revocation.
- Default-deny policy gateway, bounded operation allowlist, task-scoped approval checks and hash-chained audit logging.
- Selected read-only Windows system queries and limited Windows app launch.
- Foreground-window UI Automation for selected text/control/clipboard/zoom interactions.
- Browser companion/HUD with push-to-talk and text fallback.
- Browser companion notification feed backed by signed, device-scoped `/api/notifications` polling.
- Browser companion schedule manager for owner-scoped one-time/recurring requests, listing, and cancellation through the signed policy-gated request path.
- Optional local Piper TTS, with browser speech synthesis fallback.
- Encrypted local personal-memory foundation and official-store search-link generation.
- Capability registry with implemented/partial/planned/restricted status.
- Automated test suite and browser smoke test.

## Important limitations

- The Windows app launch and UI automation adapters are bounded; this is not universal control of every installed app.
- Always-ready local wake-word listening is not yet accepted; voice manager defaults wake-word listening off. Browser recognition may use vendor/cloud processing.
- Android native agents, Android Keystore integration, two-phone physical acceptance and secure remote laptop control are incomplete.
- Complete email, WhatsApp, SMS, telephony, Teams, Microsoft 365 and calendar integrations are not present yet.
- Scheduled recurring workflows, durable unattended execution, full memory lifecycle UI, semantic retrieval and verified deletion across backups remain incomplete.
- Payment/financial application automation, credential entry, unrestricted shell execution, administrator elevation, security bypass, and voice-only high-risk authentication remain restricted.

## Architecture and security

- Planner output is advisory. It never receives execution authority.
- Every action must pass the default-deny policy gateway and registered executor.
- State-changing actions require the applicable risk-based approval; approval is bound to task, device, operation, parameters and expiry.
- Verify actual outcomes; do not claim success from command acknowledgement alone.
- Stop dependent steps after unexpected behavior and reconcile actual state before any safe retry/recovery.
- Prefer local processing for private data. Disclose and minimize cloud data sharing and obtain authorization when required.
- Do not run as administrator or silently install/sideload applications.

## Run locally (Windows PowerShell)

Create a private .env from the committed template. The file is ignored by Git.

```powershell
Copy-Item .env.example .env
node scripts/configure-owner-token.mjs
npm ci
npm run build
npm run lint
npm test
npm run test:browser
npm start
```

Open http://127.0.0.1:3000/ for the local HUD. The companion enrollment page is at http://127.0.0.1:3000/companion. The server binds to loopback; this does not enable remote-device access.

WSL/Linux equivalent for copying the template: `cp .env.example .env`.

### Configuration notes

- PORT defaults to 3000 and is validated as a port number.
- JARVIS_DEVICE_STATE_PATH and JARVIS_AUDIT_PATH can configure local state paths.
- JARVIS_OWNER_CONTROL_TOKEN is required for owner-controlled enrollment and encrypted memory features; generate it locally with the script.
- OPENAI_API_KEY is not used by the current deterministic planner. Adding it does not enable cloud AI.
- Optional Piper settings configure local TTS. If not configured, the companion can fall back to browser speech synthesis.

## Validation

Verified hosted CI evidence for the gap-closure baseline:
- [new documentation head 6dd9d8d6 — successful run](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099231737)
- [dev integration commit 29df6b86 — successful run](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099365008)
- [fix branch at the same integration commit — successful run](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099378785)
- [test branch at the same integration commit — successful run](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40099381517)
- Documentation PR #13 merged into dev: https://github.com/Guda-Abhishek/JARVIS/pull/13

These runs validate configured repository automation only. They do not prove physical Windows desktop interaction, real microphone/wake/TTS behavior, native Android control, WhatsApp/SMS/calls/Teams integration, or universal application coverage. npm audit remains unverified; see POC2.md for acceptance criteria.

## Branch and release policy

Use fix for debugging/regressions, test for test/audit work, new for features and staged development, enhancement for broader enhancements, and dev for integration. Create non-main PRs to dev. Do not automate changes to main; the owner performs the final dev → main merge manually.


## Validation status refresh — 2026-10-26

The latest reviewed hosted run, [40216510796](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40216510796), passed build and TypeScript checks but failed 3 of 130 automated tests (127 passed); browser smoke was skipped. The failures were stale assertions for the current measured `/api/status` schema and the intended terminal `EXPIRED` state after approval expiry. Those assertions have been corrected on `new`; the corrected commit still needs a completed CI run before it can be called green. Both remembered-approval tests passed in the reviewed run.

Remembered app-launch approvals default to 30 minutes and are limited to the exact same app/device/parameters. Set `JARVIS_REMEMBER_LAUNCH_MINUTES=0` to disable them. Other state-changing operations still require fresh approval. Hosted CI is not physical-device acceptance, and `npm audit` remains unverified until run and recorded.
