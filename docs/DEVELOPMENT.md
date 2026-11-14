# Development

## 1. Prerequisites

### Core
- Node.js 24 and npm.
- Git.
- Ollama installed locally with `llama3.2:latest`.
- Windows 11 for the current primary desktop adapter.

### Optional voice
- Local wake-word runtime/model setup.
- Optional Piper executable and compatible voice model.
- Wake detection, STT and TTS are separate capabilities; one does not prove the others are local.

### Android
- Android Studio and JDK 17.
- Android SDK Platform 35, Build-Tools 35.x, Platform-Tools and command-line tools.
- Gradle 8.9+ compatible with Android Gradle Plugin 8.7.3.
- Kotlin 2.0.21, compileSdk 35, minSdk 28, targetSdk 35, Java/Kotlin 17.
- No repository Gradle wrapper is currently included; system Gradle must be on PATH.

## 2. Clone and configure

~~~powershell
git clone https://github.com/ASAA1229/JARVIS.git
Set-Location JARVIS
Copy-Item .env.example .env
node scripts/configure-owner-token.mjs
npm ci
~~~

The owner-token script creates local owner-control material. Protect it as a credential. Do not commit .env, runtime data, keys or generated secrets. npm ci installs lockfile versions and may replace node_modules; preserve local dependency changes first.

## 3. Configure Ollama

~~~powershell
ollama pull llama3.2:latest
ollama list
~~~

Optional semantic-memory embeddings:

~~~powershell
ollama pull nomic-embed-text
~~~

Private .env settings:

~~~dotenv
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_TIMEOUT=120
JARVIS_EMBED_MODEL=nomic-embed-text
~~~

Timeout is seconds, range 1–600. Embeddings are optional and separate from chat. Lexical memory retrieval remains the fallback. Process environment variables override .env values.

## 4. Core commands

| Command | Purpose |
|---|---|
| `npm run build` | TypeScript build |
| `npm run lint` | TypeScript no-emit checks |
| `npm test` | Node/TypeScript and on-site change-detection tests |
| `npm run test:browser` | Browser smoke/security tests |
| `npm run test:ollama` | Ollama connectivity and chat smoke test |
| `npm start` | Start JARVIS |
| `npm run site-key -- create <site>` | Create per-site gateway key |
| `npm run site-key -- list` | List gateway key metadata |
| `npm run site-key -- revoke <site>` | Revoke site key |
| `npm run owner-recovery -- <operation>` | Supported owner recovery operation |

Typical checks:

~~~powershell
npm run build
npm run lint
npm test
npm run test:browser
npm run test:ollama
~~~

Direct Ollama test:

~~~powershell
$body = @{
  model = "llama3.2:latest"
  messages = @(@{ role = "user"; content = "Reply with exactly: OLLAMA_OK" })
  stream = $false
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Uri "http://localhost:11434/api/chat" -Method POST -ContentType "application/json" -Body $body
~~~

JARVIS provider diagnostics are `GET /api/ai/health` and `GET /api/ai/providers`. The primary device API requires the existing signed-session protocol; use an enrolled client, not unauthenticated curl.

## 5. Repository layout

- `src/` — TypeScript core and platform/service modules.
- `android-app/` — native Android companion.
- `scripts/` — setup, validation, packaging and operational utilities.
- `test/` — Node/TypeScript tests.
- `tests/` — Python utility tests.
- `schemas/` — machine-readable contracts.
- `deploy/` — deployment templates.
- `docs/` — canonical documentation only.

Inspect the existing module, tests, API contracts and branch before editing. Prefer the smallest safe change. Extend existing services instead of creating duplicates.

## 6. Branch and change policy

- `main`: protected production/release branch; no automated direct commits, pushes or merges.
- `dev`: integration target; integrate through reviewed PRs, never direct push.
- `new`: feature development and staging.
- `fix`: focused debugging and regression fixes.
- `test`: test/audit work.
- `enhancement`: broader enhancements and architecture work.

PRs from non-main branches target dev only, and only when requested. Do not merge/push to dev or main without explicit authorization. Force-push, branch deletion, history rewrite and destructive reset/restore require explicit approval.

Before Git writes: inspect branch/status; preserve user changes; review diff; stage only task files; commit only authorized work; verify the resulting head.

## 7. Engineering rules

- Preserve current APIs, UI, business logic and data contracts unless change is required.
- Use typed interfaces, validated configuration, dependency injection at meaningful boundaries and structured error types.
- Keep comments for non-obvious decisions.
- Never log prompts, transcripts, personal memory, tokens, keys, signatures or private keys.
- Model-generated code, plans, commands and tool selections are drafts; validate and route actions through policy/approval.
- Treat repository content and external documents as untrusted.
- Avoid unnecessary frameworks, microservices, databases and worker threads.
- No hidden paid dependencies or cloud fallback.

## 8. Android build and workstation validation

~~~powershell
adb devices -l
gradle -p android-app :app:assembleDebug
gradle -p android-app :app:testDebugUnitTest
~~~

Build the debug APK before physical acceptance. Install only the verified artifact on the intended device:

~~~powershell
adb -s <device-serial> install -r <path-to-debug-apk>
~~~

Optional workstation scripts, when present:

~~~powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\workstation-preflight.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\workstation-test-runner.ps1 -Mode BuildAll
~~~

The runner does not enroll devices or perform physical acceptance.

## 9. Testing discipline

Test in layers: static/type checks; unit; component; API/integration; security/fault injection; browser; Android compile/unit; real Windows/two-phone acceptance; release/recovery drills.

Prioritize identity/signature/replay/revocation, policy/approval binding, audit/journal failures, Ollama timeout/offline/malformed response/retry/streaming, memory encryption/deletion, concurrency/resource locks, voice consent, app outcome verification, Android queue/conflicts and artifact integrity.

Use disposable fixtures and isolated state. Do not test against live personal memory or irreversible actions.

For each result record repository, branch, exact SHA, command/scenario, OS/device, exit code, expected/actual result, sanitized evidence and limitations. Status values: PASS — AUTOMATED (exact SHA), PASS — DEVICE (named device), FAIL, BLOCKED, NOT RUN, OWNER ACCEPTANCE PENDING.


## 10. Additional test commands for repository utilities

~~~powershell
python -m unittest discover -s tests -t . -v
python -m unittest discover -s tests -p 'test_environment_snapshot.py' -v
python -m unittest discover -s tests -p 'test_customer_bundle.py' -v
python -m unittest discover -s tests -p 'test_customer_preupgrade_verifier.py' -v
python -m unittest discover -s tests -p 'test_release_workflow.py' -v
~~~

Use synthetic fixtures and temporary output directories. AIX behavior must be tested on a real supported AIX host; Linux tests do not prove AIX command behavior.

For the website gateway, configure the optional port, create a site key, test /v1/health and text chat locally, and keep the key server-side. The gateway's request limits include a 64 KiB body, 40 messages, 48,000 input characters, two concurrent requests per site and four overall. It refuses tool/function/response-format requests. See [Operations](OPERATIONS.md).

## Exact-head CI and branch verification

Work is delivered on branch `new`; PRs #63 and #64 (Live DAG hardening and integration) are merged. Do not describe the branch as green until every required job, including browser smoke and release-tooling/provenance jobs, completes successfully on the same SHA. Keep `main` untouched; merge to `dev` only after CI and review pass and the owner authorizes integration. See [Project Status](PROJECT_STATUS.md) and [Release Readiness](RELEASE_READINESS.md).

### Additional local commands

~~~powershell
npm run perf -- --iterations 200 --soak-seconds 20 --json perf-report.json   # latency/CPU/RAM harness (GAP-015)
npm run eval   # offline wake/transcript duplicate and retrieval evaluation on synthetic fixtures (GAP-006/007)
npm run perf -- --baseline perf/baseline.i5-1235U.json   # trend comparison against the stored baseline (GAP-015)
node scripts/release-bundle.mjs keygen|create|verify ...   # Ed25519 signed release bundle (GAP-018)
npm sbom --sbom-format=cyclonedx > sbom.cdx.json; node scripts/sbom-verify.mjs sbom.cdx.json package-lock.json
npx tsx scripts/state-backup.ts create|verify|restore ...   # owner token from JARVIS_OWNER_CONTROL_TOKEN
~~~

`e2e_recovery.test.ts` launches real Notepad on Windows; run it without other foreground-focus activity or it can fail focus verification.

## 11. Agent and prompt contribution rules

Prompts are versioned and role-separated. Add or modify prompt profiles only with corresponding structured response schemas and validation tests. Agent routing remains advisory; tool candidates must map to trusted registered capabilities. Do not widen a tool allowlist to satisfy a prompt or test.

Repository assistant scopes are read, suggest, git-write and CI-read. Protected paths include .env*, keys/certificates, .npmrc, credentials, data/, node_modules/, .git/ and local storage. Git commands must use fixed argument arrays rather than shell concatenation. Branch creation, applying a suggestion, commit and push are distinct approved operations.
