# JARVIS

**Security-first personal AI assistant POC — Windows host with a browser-based companion/HUD.**

> **Current status (2026-10-23): Milestone 7 — Security Remediation & Completion. IN PROGRESS / NOT RELEASE-READY.** Do not begin the next milestone or merge to `main` until the acceptance gates are evidenced. The audit report on `test` is the baseline review; current remediation work is on `fix`.

## Current milestone and source branches

- `new`: original feature implementation under review.
- `test`: audit baseline, automated tests, and [Security/API/Feature Audit](docs/security-api-feature-audit-2026-10-23.md).
- `fix`: current remediation and regression tests.
- `dev`: integration branch; changes from `new`, `fix`, or `test` reach it by PR only.
- `main`: production/release branch. **Never push, commit, or merge to `main` automatically.** The owner performs any final merge manually from `dev`.

The current `fix` work addresses cryptographic session establishment, request signing/replay protection, enrollment proof-of-possession, API authorization and validation, approval-state correctness, persistence failure handling, safe DOM rendering, browser voice lifecycle, and regression tests. The milestone is not complete merely because build/typecheck/tests pass: browser runtime behavior, target Windows 11 behavior, and all remaining high-risk findings must be verified too.

## POC architecture

- **Runtime:** Node.js 24 + TypeScript, modular monolith.
- **Identity:** Ed25519 device keys, short-lived one-time enrollment challenges, signed session establishment, signed API requests, timestamp/nonce replay protection, and device revocation.
- **Policy:** default deny, bounded operation allowlist, task-scoped approval, parameter-hash binding, and approval state-transition checks.
- **Execution:** read-only Windows system information and selected installed-app launch only; no arbitrary shell, scripts, administrator elevation, or financial operations.
- **Verification/audit:** outcome verification, hash-chained audit events, redaction, persisted device state, and fail-closed behavior when security state is unhealthy.
- **Browser companion/HUD:** cinematic HUD, push-to-talk, transcript confirmation, text fallback, and a shared WebCrypto Ed25519 client. Browser key storage uses IndexedDB and the imported private key is non-extractable where supported.
- **AI planning:** model/planner output is advisory and must pass the policy gateway; it never receives execution authority.

## Run locally (Windows PowerShell)

Create a private `.env` from the committed template. Node.js 24's built-in dotenv loader reads `.env` before application startup; variables already present in the process environment take precedence. The file is ignored by Git.

```powershell
Copy-Item .env.example .env
node scripts/configure-owner-token.mjs
npm ci
npm run build
npm run lint
npm test
npm start
```

Open **http://127.0.0.1:3000/** for the primary cinematic HUD with push-to-talk and text requests. The secure browser enrollment page is at **http://127.0.0.1:3000/companion**; after enrolling, return to `/`. `/hud` remains an alias for the primary HUD.

Voice recognition uses the browser's `SpeechRecognition` / `webkitSpeechRecognition` API when available and the page runs in a secure context. Capture starts only on an explicit push-to-talk interaction, stops at 15 seconds, and requires transcript review plus a separate submit action. Speech recognition may process audio through the browser vendor or a cloud service; local-only processing is not guaranteed. Text requests remain available when voice is unsupported or blocked.

WSL/Linux uses the equivalent copy command: `cp .env.example .env`, followed by `node scripts/configure-owner-token.mjs`. The repository's Linux/WSL runtime acceptance is still outstanding.

### Environment variables

| Variable | Required? | Default / behavior |
|---|---|---|
| `PORT` | Optional | `3000`; must be an integer from 1 through 65535. The server binds to `127.0.0.1`; there is no configurable host or application URL. |
| `JARVIS_DEVICE_STATE_PATH` | Optional | `./data/devices.json` for persisted device state. |
| `JARVIS_AUDIT_PATH` | Optional | `./data/audit.log` for the tamper-evident audit log. |
| `JARVIS_OWNER_CONTROL_TOKEN` | Required for device enrollment only | Generate locally with the script above. Must be 32–256 URL-safe characters. Missing, placeholder, or weak values disable enrollment; JARVIS still starts, and the challenge endpoint fails closed. |
| `OPENAI_API_KEY` | Not used by this version | The template contains a placeholder only. The current planner is deterministic and local; no OpenAI provider reads this variable or sends cloud requests. Replacing the placeholder does not enable a provider. |

`NODE_ENV`, session lifetimes, enrollment challenge lifetime, and cryptographic keys are not environment-configurable in this implementation and are therefore not listed as supported settings. No owner token or API key is required to run the local deterministic planner and inspect the public health status.

`node scripts/configure-owner-token.mjs` writes 32 random bytes as a hexadecimal owner token directly into `.env` without displaying it. It refuses to overwrite an already valid token. To rotate one, use the application's device/session revocation and re-enrollment procedures; do not replace it casually if enrolled devices depend on the current owner workflow. The owner token authorizes enrollment challenges only; it is not an OpenAI API key or a device session credential.

To use OpenAI in a future supported provider integration, create an API key in the owner's official OpenAI Platform account and place it locally in `OPENAI_API_KEY`. Do not put it in `JARVIS_OWNER_CONTROL_TOKEN`. The present application does not validate or consume that setting. Never commit `.env`, paste its contents into reports, or share screenshots containing it. If startup reports an invalid `PORT` or unreadable `.env`, correct that local setting; if owner enrollment is reported disabled, generate a token with the script and restart.

## API surface

| Route | Purpose | Security notes |
|---|---|---|
| `GET /api/status` | Minimal health status | Public response exposes only `ONLINE` or `DEGRADED` |
| `POST /api/enrollment/challenge` | Create one-time enrollment challenge | Requires `x-owner-control-token`; disabled if owner token is not configured |
| `POST /api/enrollment/redeem` | Register device public key | Requires proof-of-possession signature |
| `POST /api/session` | Establish device session | Requires Ed25519 signature over timestamp + one-time nonce |
| `POST /api/request` | Submit a bounded request | Requires active session plus canonical signed request headers |
| `POST /api/approval/approve` | Approve eligible pending task | Requires signed request and an eligible active device |
| `POST /api/approval/reject` | Reject eligible pending task | Requires signed request and an eligible active device |
| `POST /api/device/revoke` | Revoke self or permitted target | Cross-device revocation requires `DEVICE_MANAGE` |
| `GET /api/audit` | Read recent audit records | Requires signed request and `DEVICE_MANAGE` permission |
| `POST /api/hud/session` | Legacy HUD bootstrap | Intentionally returns `503`; direct session minting is disabled |

Protected API requests use the canonical signed payload contract:

`METHOD:PATH:SESSION_ID:TIMESTAMP:NONCE:SHA256(BODY)`

The nonce must be fresh and is consumed once. A browser that cannot support Ed25519/WebCrypto or secure key storage must fail closed and use the text UI only after a valid device session is established.

## Security boundaries and known limitations

- Voice is push-to-talk only; there is no wake-word or continuous capture by default. Browser speech recognition may use a vendor/remote service; **local-only processing is not guaranteed**. The HUD discloses this and provides text input.
- The browser POC is not yet a complete native Android companion or remote-device transport. Network access, Android Keystore-backed identity, enrollment QR workflow, two-phone permissions, and owner/delegated-admin management require separate verification.
- The default enrollment challenge assigns limited permissions. Privileged audit viewing and cross-device revocation require `DEVICE_MANAGE`; the current UI does not yet provide an owner-approved permission assignment workflow.
- The server binds to loopback by default. Do not expose it publicly or forward its port to an untrusted network.
- Passing CI is necessary but not sufficient. Browser automation and checks on the owner's Windows 11 MSI remain required before Milestone 7 can be accepted.

## Validation

CI runs on a Windows runner with Node.js 24 and executes:

1. `npm ci`
2. `npm run build`
3. `npm run lint`
4. `npm test`

See the [test branch audit](https://github.com/Guda-Abhishek/JARVIS/blob/test/docs/security-api-feature-audit-2026-10-23.md) and [GitHub Actions runs](https://github.com/Guda-Abhishek/JARVIS/actions). The traceability matrix and completion report are historical until refreshed with the final accepted `fix` commit and exact CI evidence.

## Branch and release policy

- Work on `new`, `test`, and `fix`; commit and push only to the branch that owns the work.
- PRs from `new`, `test`, or `fix` target `dev` only when checks pass.
- Never automate commits, PRs, or merges into `main`. The owner manually reviews and merges `dev` to `main`.
- Do not force-push, reset, or discard unrelated work.
- Do not claim success for an action whose outcome is uncertain.
