# Operations

## 1. Runtime topology

The primary JARVIS server listens on loopback (default port 3000). HUD, companion pages and signed device/owner APIs are served by the primary application. Ollama listens locally at `http://localhost:11434`. The optional website AI gateway uses a separate listener (commonly 3100) and per-site bearer keys.

~~~mermaid
flowchart LR
  PHONE1[Android phone 1] --> VPN[Private VPN / trusted network]
  PHONE2[Android phone 2] --> VPN
  VPN --> TLS[HTTPS reverse proxy]
  TLS --> HOST[127.0.0.1:3000 JARVIS]
  HUD[Local browser HUD] --> HOST
  HOST --> OLLAMA[localhost:11434 Ollama]
  SITE[Owner website server] -->|HTTPS + site key| GW[Separate gateway listener]
  GW --> OLLAMA
~~~

## 2. Start and stop

Start Ollama using the installed local service/application. Confirm the model:

~~~powershell
ollama list
~~~

Start JARVIS from repository root:

~~~powershell
npm start
~~~

Open `http://127.0.0.1:3000/`. Stop with normal process shutdown (Ctrl+C in foreground). Do not delete runtime state to force a restart.

## 3. Health and monitoring

Ollama:
- Confirm service reachability at OLLAMA_URL and configured model availability.
- Run `npm run test:ollama` for provider smoke testing.
- Monitor CPU/RAM, model load and inference latency; CPU-only inference may be slow.
- The signed `GET /api/ai/health` checks the chat model and reports optional `embeddingModelAvailable`; `npm run test:ollama` performs actual native chat and, when installed, embedding inference. `GET /api/ai/providers` reports configured/circuit-breaker state, not a live network probe. A health check is not proof that agents or complete workflows are accepted.

JARVIS signed-device diagnostics:
- `GET /api/ai/health`
- `GET /api/ai/providers`

Monitor process availability, provider/timeout/error rates, active and queued tasks, wait duration, scheduler/journal health, audit integrity, disk capacity, state-file permissions, Android sync/conflicts and CPU/RAM/battery. Logs must contain bounded redacted metadata only; never log prompts, transcripts, memory, credentials or signatures.

## 4. Private companion connectivity

Recommended shape:

~~~text
Android phones -> private VPN/trusted network -> HTTPS :443 -> reverse proxy
              -> 127.0.0.1:3000 JARVIS
~~~

Review `deploy/Caddyfile.example`, configure a trusted TLS certificate and restrict firewall access to private clients. Never disable certificate validation, expose the primary API directly or create a public port-forward. Laptop, JARVIS and proxy must be awake/running; remote wake is not provided. A disconnected phone must establish a fresh signed session.

### Android build and install

Requirements: JDK 17, Android SDK 35, Build-Tools 35.x, Platform-Tools, compatible Gradle 8.9+ and Android Studio.

~~~powershell
gradle -p android-app :app:assembleDebug
adb devices -l
adb -s <device-serial> install -r <path-to-debug-apk>
~~~

The generated debug APK is under `android-app/app/build/outputs/apk/debug/`; verify its exact filename. Debug artifacts are for internal testing, not production distribution. Enroll both phones independently and verify separate identities, keys and permissions.

## 5. Website AI gateway

The optional gateway is a separate OpenAI-compatible text listener. Configure `JARVIS_SITE_GATEWAY_PORT=3100` in private .env, then:

~~~powershell
npm run site-key -- create portfolio
npm run site-key -- list
curl.exe http://127.0.0.1:3100/v1/health
~~~

Copy the one-time generated key to the website's server-side secret store, never browser code. The gateway exposes text-only `/v1/chat/completions`, `/v1/models` and `/v1/health`. It cannot access tools, planner, personal memory, device control or owner routes.

If remote access is explicitly approved, expose only the gateway listener through HTTPS. Never tunnel the primary JARVIS port. Revoke/rotate:

~~~powershell
npm run site-key -- revoke portfolio
npm run site-key -- create portfolio
~~~

Update the website secret after rotation. The laptop must remain awake for local inference.

## 6. State, backups and retention

Runtime state is stored in local files under configured paths (commonly `data/`): device state, audit records, encrypted personal memory, encrypted document library (`documents.enc`) and derived vectors (`documents.enc.vectors`), conversation history, task journals, workflow/plugin registries, sync queues and gateway metadata.

- Keep data/, .env, keys and local state out of Git and public shares.
- Use encrypted, access-controlled backup storage.
- Back up from a consistent application state; prefer supported export or clean shutdown.
- Record backup time, source commit, included state categories and key dependencies.
- Test restore in an isolated copy.
- Protect owner-control and encryption keys separately from backups.
- In-app deletion cannot erase independent OneDrive/cloud-sync/version-history copies. Exclude sensitive runtime state from consumer sync or manage that retention separately.
- When `JARVIS_OWNER_CONTROL_TOKEN` is configured, conversation sessions are stored in `./data/conversations.enc` (or alongside the configured device state path as `.conversations`), encrypted with AES-256-GCM and restored after restart. Sessions expire after about 30 minutes. Without owner control, history is process-local. Back up the encrypted file only as part of the protected local-state backup set.

Document RAG is enabled only when `JARVIS_OWNER_CONTROL_TOKEN` is configured. Signed endpoints are `POST /api/documents/ingest`, `/api/documents/search`, `/api/documents/list` and `/api/documents/delete`. Ingestion accepts UTF-8 TXT, Markdown, CSV, JSON, LOG, YAML, XML and HTML text; PDF and DOCX files (and opt-in local OCR) are accepted only through `POST /api/documents/ingest-file`; the plain `ingest` endpoint takes text. Each document is limited to 2 MB, 1 million characters, 500 chunks and the library to 20 million stored chunk characters. Documents are isolated to the authenticated device. Embeddings use the configured loopback Ollama endpoint via `POST /api/embed` and `JARVIS_EMBED_MODEL` (default `nomic-embed-text`); lexical search remains the fallback.

Never edit encrypted state files manually. Corrupt or unauthenticated document source state must fail closed. The derived embedding index may be rebuilt from the encrypted source library.

## 7. Recovery

### Ollama unavailable
1. Confirm Ollama is running.
2. Check OLLAMA_URL and local reachability.
3. Confirm OLLAMA_MODEL with `ollama list`.
4. Run `npm run test:ollama`.
5. Review redacted diagnostics.
6. Do not use cloud fallback unless explicitly configured and authorized for that task.

### JARVIS or persistence failure
1. Stop new state-changing work and preserve data/.
2. Record branch/commit and sanitized logs.
3. Inspect task and audit status through owner-authorized routes.
4. Treat interrupted external effects as uncertain.
5. Reconcile actual state before retry; retry only after confirmed no effect or verified idempotency.
6. If audit/journal integrity is uncertain, fail closed and restore only from verified backup under owner-approved procedure.

### Lost or compromised device
Revoke the affected device through owner recovery. Confirm immediate revocation and that other enrolled devices remain independent unless revoke-all is explicitly selected. Enroll replacement as a new device; never copy private keys.

### Sync conflicts
Revalidate device, permission, TTL, sequence and replay status. Surface stale changes for owner resolution; do not use last-writer-wins. Offline commands remain held until explicit owner decision and re-enter normal policy/approval before execution.

## 8. Release and customer verification

Release outputs include a package, build provenance, SHA-256 manifest and checksum sidecar. Validate exact package bytes and extracted inventory.

1. Build from recorded full commit SHA and CI/Jenkins build identity.
2. Generate manifest/checksums after package finalization.
3. Authenticate manifest-ignore policy using independently trusted digest or approved Ed25519 signature.
4. Verify package name, size and digest against policy/manifest.
5. Verify extracted files; reject missing, modified, unexpected, unsafe-path, symlink and special entries.
6. Generate SBOM and complete dependency/security review.
7. Sign through protected release infrastructure; never commit signing keys.
8. Record release disposition and owner approval.

### Customer pre-upgrade verifier

The offline Python 3.9+ standard-library verifier consumes an authenticated policy, manifest/archive, extracted directory, approved compatibility matrix and existing or freshly collected Linux/AIX snapshot.

~~~sh
python3 scripts/customer_preupgrade_verifier.py \
  --manifest-ignore manifest-ignore.json \
  --trusted-policy-sha256 <trusted-64-character-sha256> \
  --manifest release-manifest.json \
  --artifact customer-release.tar.gz \
  --extracted-dir ./customer-release \
  --matrix approved-compatibility.json \
  --collect-snapshot \
  --snapshot-output environment-snapshot.json \
  --report pre-upgrade-report.json
~~~

Exit codes: 0 integrity and compatibility passed; 2 integrity passed but compatibility unsupported/incomplete; 1 input, trust, collection or integrity failure. Review reports before sharing.

### Linux/AIX environment snapshot

~~~sh
python3 scripts/environment_snapshot.py
python3 scripts/environment_snapshot.py --output /path/to/customer-snapshot.json
python3 scripts/environment_snapshot.py --stdout
~~~

Read-only collection; no installs, configuration changes, privilege escalation, network transmission or hardware/storage inventory.

### Jenkins and Nexus

Jenkins build-to-manifest provenance and Nexus artifact-set contracts are documented design boundaries. Live integration requires authoritative release coordinates, repository path rules, trust anchors and approved credentials. Nexus publication remains disabled unless explicitly approved and validated.

## 9. Operational boundaries

No production deployment, public tunnel, paid service activation, production-secret change or Nexus publication without explicit owner approval. Do not run as administrator, expose the main API publicly or claim production readiness from local build/CI alone.


## 10. Android enrollment and real-device acceptance details

The native companion requires trusted HTTPS; cleartext HTTP is rejected. Each phone creates its own Ed25519 identity. Private-key encoding is protected with AES-GCM and an Android Keystore wrapping key; offline queue data uses a separate Keystore-backed AES-GCM key. No owner control token is stored in the app.

Enrollment is owner-mediated:
1. Create a short-lived enrollment transaction from an already authorized owner device, including any required authenticator step-up.
2. Scan/open the owner-generated QR/deep link or manually enter the transaction ID and one-time code. The app does not currently include an in-app QR scanner.
3. Submit the phone enrollment request.
4. Approve the exact pending phone and requested permissions on the owner device.
5. Check approval and establish/reconnect the signed session.
6. Repeat independently for phone two.

The app supports bounded read-only app inventory, local user-tap app launch, signed text requests and optional WorkManager approval polling. Polling is opt-in and constrained by Android's periodic-work minimum (about 15 minutes); it is not real-time push. It does not provide arbitrary remote app control, SMS/call actions, notification-list access or remote wake. Server-side queued inventory is volatile, not a durable remote command channel.

For internal testing, the debug APK is `android-app/app/build/outputs/apk/debug/app-debug.apk`. CI artifacts are debug-signed, should be checksum-verified and are not production releases. The CI artifact retention period described in the build workflow is 30 days. Production signing requires a separately protected signing key and reviewed release process.

## 11. Voice output operations

For optional Piper, set absolute paths in private .env:
- `JARVIS_PIPER_EXECUTABLE` — trusted Piper executable.
- `JARVIS_PIPER_MODEL` — licensed compatible voice model.

Restart JARVIS and test through an authenticated HUD session. If either setting is empty, browser speech synthesis is the fallback. If the local provider fails, the HUD suppresses repeated local TTS attempts for the current page session; reload after fixing configuration. Do not run Piper as administrator or use voice models without appropriate license/rights.

## 12. Python utility operations

The Linux/AIX environment snapshot uses Python 3.9+ standard library only:

~~~sh
python3 scripts/environment_snapshot.py
python3 scripts/environment_snapshot.py --output /path/to/customer-snapshot.json
python3 scripts/environment_snapshot.py --stdout
python3 -m unittest discover -s tests -p 'test_environment_snapshot.py' -v
~~~

It collects a deliberately small read-only OS snapshot. Linux reads /etc/os-release and uname/hostname/uptime/timezone. AIX reads oslevel, uname, hostname, uptime and timezone. Unsupported OS exits before collection. It does not collect hardware, disks, filesystems, mounts, environment variables, credentials, processes or users. Required command failure prevents final snapshot creation.

Compatibility matrix schema v1 contains unique check IDs, dotted JSON field paths and equals, one_of or exists operators. Expected values must come from owner/ACI-approved sources; templates are placeholders, not certifications.

On-site change detection compares a trusted baseline with a customer directory using relative path, size and SHA-256. It is read-only, rejects symlinks/special files/incomplete scans and classifies unchanged, modified, missing and unexpected entries:

~~~sh
node scripts/on-site-change-detection.mjs baseline ./released ./baseline.json [./change-detection-ignore.json]
node scripts/on-site-change-detection.mjs scan ./customer-install ./snapshot.json [./change-detection-ignore.json]
node scripts/on-site-change-detection.mjs compare ./baseline.json ./snapshot.json ./change-report.json
~~~

Ignore entries are exact relative paths; wildcards are not supported. Exit codes: 0 no differences, 2 differences, 1 validation/execution failure, 64 usage error. Reports include paths and hashes and must be reviewed before sharing.

A portable customer ZIP can be created with `python3 scripts/build_customer_bundle.py --output /tmp/customer-preupgrade-tool.zip`. The bundle is offline and excludes Node/Jenkins runtime, credentials, keys, customer snapshots and reports. Existing outputs are not overwritten unless --force is specified.

## 13. Jenkins provenance and Nexus publication boundary

The current manifest generator uses PROJECT_NAME, full GIT_COMMIT (or GIT_COMMIT_SHA), BUILD_NUMBER (or GITHUB_RUN_NUMBER) and optionally REQUIRE_BUILD_PROVENANCE=true. Release provenance must record full source commit and build identity; never infer customer/product/version/release coordinates from branch names or artifact paths.

The Jenkins-to-manifest handoff and Nexus artifact-set contract are design/schema work, not permission to alter a live Jenkins controller or Nexus. Before activation, the owner/ACI POC must confirm authoritative customer/product/version/release inputs, repository key/format, canonical path hierarchy, supported package formats, trust-anchor distribution, retention and immutability policy.

If approved later, publication must use a unique staging coordinate, verify every uploaded file by read-back SHA-256 and size, and mark the set complete only after every required object is verified. Existing coordinates are immutable; mismatched existing content is a conflict. Customer verification remains offline. Nexus publication remains disabled.

## Current operational and release verification state

PRs #63/#64 are merged into `new`; local lint, build, tests, browser smoke, Python release tests and dependency audit pass (see [Project Status](PROJECT_STATUS.md) for exact counts). GitHub exact-head CI on the pushed SHA must be confirmed before any promotion. Jenkins/Nexus live publication remains disabled: `src/release/artifactRepository.ts` refuses every call until the owner supplies approved configuration.

### External configuration still required (owner/ACI)

- Jenkins: approved controller/agent, pipeline definition, credentials, immutable build-identity inputs (customer/product/version/release coordinates).
- Nexus: repository key/format, canonical path hierarchy, auth contract, trust-anchor distribution, retention/immutability policy and explicit publish authorization for each digest.
- Devices: the MSI Windows 11 microphone/STT/wake acceptance run and two physical Android phones (build, install, enroll, revoke, offline/reconnect).
- Signing: `JARVIS_RELEASE_SIGNING_KEY` (private PEM, environment only) and `JARVIS_RELEASE_PUBLIC_KEY` for `scripts/release-bundle.mjs`; `MANIFEST_IGNORE_PRIVATE_KEY` / `MANIFEST_IGNORE_PUBLIC_KEY` repository secrets for release signatures.
- Owner acceptance of performance budgets (provisional values live in `scripts/perf-soak.ts`).

### Backup and restore tool

`scripts/state-backup.ts` (module `src/ops/stateBackup.ts`) creates an HMAC-authenticated archive of the already-encrypted state files (per-file SHA-256, name/traversal validation, no overwrite without `--force`). Set `JARVIS_OWNER_CONTROL_TOKEN` in the environment; never pass it on the command line. A backup is point-in-time: deleting a memory later does not reach older backups, so delete superseded backups yourself. Restore drills are covered by `test/state_backup_restore.test.ts`.

### Voice reliability counters

HUD transcript submissions carry a `voice.utteranceId`; the server suppresses a repeated id or an identical transcript within 5 seconds (HTTP 409, no new task). `POST /api/voice/wake-event` records counter-only wake events and `GET /api/voice/metrics` (owner permission) reports false-accept, false-reject and duplicate-suppression rates. Counters hold no transcripts or audio and reset on restart.

### DAG recovery

After a restart, branches that were dispatched become `uncertain` and are never replayed. An owner or the requesting device resumes with `POST /api/workflow/resume` (`taskId`, `reconciledNoEffectSteps`, `note`), naming only the branches confirmed to have had no external effect; each becomes a fresh child task that passes policy and approval again.

## Local PDF and DOCX ingestion

Use signed `POST /api/documents/ingest-file` with `sourceName`, canonical base64 `documentBase64`, optional `title`, and optional boolean `ocr`. The request body limit is 21 MiB; the decoded file limit is 15 MB. The response reports format and extraction method (`text`, `ocr`, or `text+ocr`).

DOCX needs no external parser. For PDF text extraction install Poppler so `pdftotext` is on PATH. For scanned PDFs, also install `pdftoppm` and Tesseract (`tesseract`) on the JARVIS host; set `ocr: true` explicitly. These tools run locally. No cloud OCR is configured. OCR currently recognizes English and at most 20 pages, a 3-minute processing budget and 100 MB aggregate raster-output cap; normal PDF text extraction supports at most 30 pages. If local tools are missing, PDF ingestion fails with an actionable error rather than returning an empty index.


## Voice synthesis note (2026-11-15)

Commits bc7dd7a and 28e7ebb make the Piper TTS path report "unavailable" when Piper is not configured instead of failing, with a test for the unconfigured fallback. Piper has not been exercised on the target MSI hardware.
