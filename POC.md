# JARVIS POC — Project Overview, Implementation Status and Remaining Work

**Repository:** `ASAA1229/JARVIS` · **Branch:** `new` · **Status baseline:** 2026-11-07
**Status vocabulary:** DONE — VERIFIED ON TARGET LAPTOP · DONE — VERIFIED LOCALLY (automated) · IMPLEMENTED — NEEDS TESTING · PARTIAL — NEEDS DEVELOPMENT · NOT STARTED

## 1. What JARVIS is

JARVIS is a local-first personal AI assistant for the owner's Windows 11 laptop (i5-1235U, 16 GB RAM, no discrete GPU). It combines a voice/text HUD, guarded Windows desktop control, approval-gated multi-step tasks, encrypted personal memory, an Android companion for approvals, and — new in E09 — a personal AI gateway that the owner's websites call with an API key instead of a paid cloud model. Every state-changing action passes a default-deny policy gateway, owner approval and a tamper-evident audit log; nothing uncertain is replayed automatically.

## 2. Status at a glance (2026-11-07)

Automated evidence on `new` (local, this laptop): `tsc` clean · 249 + 3 Node tests pass (2 real-Notepad tests need an **unlocked** desktop) · 30 Python tests pass · browser smoke pass (its 10 s waits are load-sensitive) · `npm audit` 0 vulnerabilities · build pass. CI/Jenkins re-enabled but **not yet run** (commits not pushed).

| Epic | Done | Needs testing | Pending development |
|---|---|---|---|
| **E01** Security, identity & approvals | Signed device sessions, default-deny policy, single-use approvals, hash-chained audit — DONE — VERIFIED LOCALLY | Exact-head CI run | Owner recovery after authenticator/device loss (US-005) |
| **E02** Voice & HUD | HUD loads and parses (fixed syntax error), wake-word assets installed and model loads in Edge in 1.6 s, barge-in, consent gating — VERIFIED LOCALLY | Owner says “Hey Jarvis, open Notepad” into the real microphone; Piper TTS audio | Piper binary/model install; HUD accessibility review |
| **E03** Windows desktop control | Notepad, Calculator, Paint launch + existing-window focus (incl. Store apps) — VERIFIED ON TARGET LAPTOP | UI Automation read/click/set on real apps | General app-specific outcome verification (US-016) |
| **E04** Multi-step execution & recovery | Encrypted journal, stop/cancel, recovery review, transition guards — VERIFIED LOCALLY | Crash/restart drill with a real partial side effect | — |
| **E05** Android companion | Signed API + inventory queue — VERIFIED LOCALLY (server side) | APK build, install and enrol on both phones | Durable offline queue, push delivery |
| **E06** Memory & privacy | Encrypted store, TTL, deletion incl. task-history scrub, owner export — VERIFIED LOCALLY | Export/delete from the companion UI by the owner | Cross-device memory sync (US-027), semantic retrieval |
| **E07** AI & integrations | Prompt registry, structured agents, routing, capability checks — VERIFIED LOCALLY; local llama3.2 answers live | Advisory agents against the live model | Productivity integrations beyond schedule/memory (US-030/031) |
| **E08** DevOps & artifact integrity | Provenance, SHA-256, archive/customer verification, release disposition — VERIFIED LOCALLY | First CI/Jenkins run after push; SBOM/signature inspection | Nexus publishing (disabled by policy) |
| **E09** Personal AI gateway for websites | `/v1` OpenAI-compatible gateway, per-site keys, limits, audit (12 tests); live portfolio → gateway → llama3.2 answered in 14–24 s — VERIFIED ON TARGET LAPTOP | Through a public tunnel from the deployed portfolio | Tunnel setup (owner's domain), production monitoring |
| **G01** Release & resources | Idle footprint measured: 0 % CPU, 66 MB working set, 34 MB private, 12 threads, ~10 ms per status request; Ollama + llama3.2 ≈ 2.3 GB RAM when loaded | Full release report on an exact pushed commit | Battery/sleep-resume measurements |

## 3. How to test what is ready

1. **Start JARVIS:** copy `.env.example` to `.env`, run `node scripts/configure-owner-token.mjs`, then `npm start` and open `http://127.0.0.1:3000/hud`. Keep the desktop unlocked — JARVIS refuses desktop actions while Windows is locked.
2. **Wake word:** in the HUD enable hands-free and post-wake speech consent, say “Hey Jarvis”. Expect “LOCAL WAKE ACTIVE”, then the acknowledgement. (Assets are installed; re-run `scripts/setup-local-wake-word.ps1` on a new machine.)
3. **Voice → app:** say “Hey Jarvis, open Notepad”, approve the card. Expect Notepad to open or come to the front and the HUD to show a verified result. Repeat with Calculator and Paint.
4. **Memory:** “remember preference: …”, approve; use **Export memories** in the companion; then “forget memory <id>” and confirm the export no longer lists it.
5. **Site AI gateway:** `ollama pull llama3.2`; set `JARVIS_SITE_GATEWAY_PORT=3100`; `npm run site-key -- create portfolio`; restart; `curl http://127.0.0.1:3100/v1/health`. For the deployed portfolio, run a Cloudflare Tunnel to port 3100 only and set `JARVIS_AI_URL` / `JARVIS_AI_KEY` as server secrets (see `docs/SITE_AI_GATEWAY.md`).
6. **Automated checks:** `npm run lint`, `npm test`, `npm run test:browser`, `python -m unittest discover -s tests -t .`.

## 4. Known constraints

- **Model speed:** CPU-only llama3.2 generated ~2 tokens/s while OneDrive sync held the CPU at 1.3 GHz / 77 % load; first answers take 10–25 s.
- **OneDrive:** the project lives in a OneDrive folder; continuous sync of `node_modules`, build output and `data/` costs CPU and means deleted memories may persist in OneDrive version history.
- **Locked desktop:** all desktop actions fail closed while Windows is locked or disconnected.
- **Local-first, zero ongoing cost:** no paid cloud model by default; remote AI only with explicit opt-in.
- **Safety boundaries:** no administrator elevation, no unrestricted shell, no payment/financial automation, no automatic replay of uncertain actions, voice alone never authorizes high-risk actions.
- **Gateway exposure:** only the gateway port may be tunnelled; the main JARVIS port must stay private. The laptop must be awake for sites to get live answers.

## 5. Open decisions for the owner

1. Push `new` so CI/Jenkins run on the exact commits (and open a PR to `dev`).
2. Choose the public tunnel hostname (e.g. `ai.<your-domain>`) for the gateway.
3. Model choice: keep `llama3.2` (better answers) or use `llama3.2:1b` (≈2–3× faster on this CPU).
4. Move the repositories out of OneDrive, or exclude `node_modules`, `.output`, `dist` and `data/` from sync.
5. Schedule Android acceptance with both phones (needs Android SDK/Gradle on a build machine).
6. Decide whether Piper neural TTS should be installed or browser speech remains the default.

## 6. Future scope — enhancement candidates (proposals, not commitments)

- Semantic memory retrieval with local embeddings; cross-device memory sync.
- Gateway: per-site system prompts and usage dashboard; optional GPU/NPU-accelerated model.
- Productivity integrations (calendar, mail drafts) behind explicit approval.
- Automatic sleep/wake awareness so sites get a fast “JARVIS offline” signal.
- Signed release bundles published to an internal registry once Nexus is approved.

## Branch and safety rules

- `main` is production-protected and is never updated automatically.
- `dev` is the integration branch; approved pull requests from development branches target `dev`.
- `new` is the current feature/development branch; `fix` is for authorized fixes; `test` is for testing/audit work.
- No branch creation/switching, PR, merge, push to another branch, deployment or production change without explicit authorization.
- No secrets or API keys are committed; owner-supplied credentials remain in local environment configuration.

---

## Historical implementation and audit log

> Note (2026-11-07): entries below are kept as history. Statements in them that testing or development is “paused” or “not run” are superseded by sections 2–3 above.

---

## Conversational response layer — 2026-10-25

- Added an authenticated conversational route before the action planner. It handles stable identity answers and selected common AI questions in natural English.
- General questions can use an OpenAI-compatible chat-completions endpoint. The default endpoint is local Ollama at `http://127.0.0.1:11434/v1`; model defaults to `llama3.2`. Configure `JARVIS_AI_BASE_URL`, `JARVIS_AI_MODEL`, and optionally `JARVIS_AI_API_KEY` as appropriate.
- No cloud endpoint is selected by default. If the local/configured endpoint is unavailable, JARVIS returns a clear fallback instead of pretending that an AI answer was generated.
- Owner memories are supplied only when the authenticated device has device-management permission, and only a bounded set of records is included.
- The HUD now handles `state: ANSWERED` separately from action execution outcomes, displays the conversational message, and sends that message to speech output.
- The HUD requires explicit, per-session consent before starting browser speech recognition for push-to-talk or post-wake command capture. Consent is not persisted between page sessions because the browser recognition provider may process audio remotely.
- Push-to-talk speech is displayed in the editable transcript review panel and is not transmitted until the user explicitly selects **EXECUTE DIRECTIVE**. After local wake detection, if the separate post-wake browser-speech consent is enabled, the HUD captures the command and submits it through the existing policy gateway without a separate transcript-review click; this does not bypass policy denial or required approval.
- Continuous hands-free/browser wake detection is now blocked until a true local audio wake-word engine is configured; the current transcript matcher is not an audio-level local detector. The requested wake acknowledgement is `Hi sir, I am ready to work.` when a supported wake path is available.
- **Not yet verified on physical hardware:** browser recognition behavior, audible TTS timing, and end-to-end local model inference. No local wake-word capability is claimed.


## Implementation status refresh — 2026-10-26

A review of hosted run [40216510796](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40216510796) found that the TypeScript build and typecheck passed, but the automated suite had 3 stale HTTP-test expectations (127 tests passed). The affected tests were corrected on branch `new`: public status assertions now validate the measured, non-secret response schema, and the expired-approval test expects the terminal `EXPIRED` task state. Both remembered-approval tests passed in that run. The corrected source commit still requires a fresh completed CI result before the baseline can be described as green.

Remembered app-launch approval is currently configured for **30 minutes by default**, can be disabled with `JARVIS_REMEMBER_LAUNCH_MINUTES=0`, and can be set to 1–240 minutes. It applies only to the exact same app launch on the same device and never grants approval for typing, file changes, terminal execution, or other operations. Persistence across restarts requires the owner control token and a consistent state path. This policy is not a replacement for task-scoped, single-use approvals for other state-changing actions.


## Companion additions pending acceptance — 2026-10-27

Recent source changes on `new` add browser-companion notification polling, owner-scoped schedule management, and personal-memory review controls. The memory panel supports category-aware save, correction, and deletion requests; mutations continue through the signed policy-gated request path. The schedule panel supports one-time/recurring requests, listing, and cancellation. The delayed-recurring schedule grammar's regular expression has been corrected.

These additions are **implemented and pass hosted CI** on commit `9371ed3dba6a416cbd03ac5da105bc60a3a0fee9`: TypeScript build, typecheck, all 144 automated tests, and browser security smoke passed in run 40543314073. They are not yet accepted for full product release because physical Windows voice/UI tests and Android-device acceptance remain outstanding. Browser polling is not native Android push delivery. `main` remains untouched.


## Windows desktop control — completion increment (2026-10-30)

JARVIS supports a guarded Windows UI Automation path for inspecting accessible controls, reading a uniquely named control, invoking a uniquely named control, and setting a uniquely named non-sensitive value. The value-setting operation checks the value after writing; it is not considered successful merely because input was sent.

**Safety boundary:** desktop actions are limited to the current foreground window, go through the policy gateway, and require approval for state-changing actions. Credential/payment-related fields are blocked or redacted using Windows password metadata and label heuristics. Those heuristics are a defence-in-depth measure, not a guarantee that every sensitive field is detected. Actions must stop when a control name is ambiguous or the required UI Automation pattern is unavailable.

**Verification limitation:** UI Automation value readback confirms the control's exposed value, not necessarily that an application saved or submitted it. JARVIS must not claim a form was saved or a transaction completed without application-specific evidence. Real interactive acceptance on the target MSI laptop remains required.


### Target-process binding and acceptance requirements (2026-10-30)

Control-read, control-click and control-value requests can include an explicit process target (for example, `read control Document title in notepad`). JARVIS checks that the foreground process matches this target before executing the operation. Omitting the target means the operation applies to the current foreground process, still subject to the foreground guard and approval policy.

Acceptance on the actual MSI laptop remains a required release gate:
1. Open Notepad and a browser; test that a target-bound request is rejected when the wrong app is foreground.
2. Inspect the foreground window and verify that duplicate control names fail closed.
3. Test reading a harmless field, setting a harmless field, and invoking a harmless button; verify values and outcomes.
4. Confirm password and financial-labelled controls are redacted or blocked.
5. Test focus changes during a request and confirm no action is redirected to a different app.
6. Verify a saved test document by reopening/reading its file content; a control-value readback alone is not proof of persistence.
7. Record Windows version, app versions, pass/fail results, and sanitized evidence without recording document contents or secrets.

Automated CI covers the planner, policy, script construction, build, and regression tests. It cannot substitute for this interactive hardware acceptance.


## Android companion — inventory queue hardening (2026-10-30)

The read-only cross-device Android app-inventory queue now validates device identifiers, handles non-finite TTL values safely, rejects malformed/control-character app records and inventories above 300 entries, and avoids exposing internal result objects through returned references. Invalid inventory results do not transition a claimed command to completed. Regression tests were added for malformed input, queue expiry, oversize inventories and defensive-copy isolation.

**Acceptance status remains partial:** these are source-level safeguards for the in-memory inventory command path, not proof of secure end-to-end remote operation. The queue is volatile and limited to `android.app.list`; it does not provide durable delivery, background push, arbitrary phone control or physical two-phone acceptance. Exact-head CI and Android device testing remain required before acceptance.


## Advanced multi-step execution — encrypted checkpoint foundation (2026-10-30)

Added `src/core/taskJournal.ts` with AES-256-GCM encrypted task checkpoints, authenticated encryption, bounded journal size/count, atomic temporary-file replacement, defensive-copy reads, and fail-closed handling for unreadable/tampered state. On restart, non-terminal records are converted to `AWAITING_RECOVERY`; stale approval IDs are cleared and automatic resume is explicitly disabled. Added focused regression tests in `test/task_journal.test.ts`. The journal now also rolls back the in-memory record and marks itself unhealthy if a checkpoint write fails, preventing the running process from exposing an undurable task as current state; a regression test covers this failure path.

**Status: partial integration; not yet accepted as an end-to-end workflow feature.** A security follow-up also closes a stale-rejection path: `rejectTask` now requires the associated task to exist and remain in `AWAITING_APPROVAL` before resolving the approval. Rejection attempts against recovery/interrupted/cancelled tasks are audited and denied without consuming the approval; a regression test covers the recovery-state case. Exact-head execution remains unverified. `JarvisCoreService` now loads the encrypted journal when an owner control token is configured, restores persisted tasks, and checkpoints task creation, execution start, step results and workflow advancement. A failed checkpoint moves the live task to recovery-required and prevents the next dependent step from starting. Some early planning/error, expiry and revocation transitions still need full lifecycle coverage, and explicit reconcile/resume UX is not implemented. Exact-head CI and integration acceptance for crash/restart, partial side effects and safe reconciliation remain required. External side effects must be reconciled before retry; state-changing operations must never be automatically replayed after an uncertain outcome.

## Voice/HUD lifecycle hardening — 2026-10-30

The browser voice path now also stops and discards an in-flight capture immediately when the user unchecks browser-speech consent. Hiding the HUD stops active voice capture, clears the pending transcript, releases the audio meter, and stops any standby listener. Browser smoke coverage exercises mid-capture consent revocation and verifies that late recognition results cannot repopulate the discarded transcript.

**Acceptance boundary:** these are software lifecycle safeguards, not proof of always-ready local voice. The local wake-word engine/model is still not installed; hands-free wake detection must remain unavailable. Browser push-to-talk may send audio to a vendor service after explicit session consent. Local Piper TTS and audible playback, and physical MSI/browser/microphone acceptance, remain unverified.

## Local wake-word engine integration — 2026-10-30

Added an opt-in local wake-word runtime path for the HUD using the open-source onnx-wakeword browser engine, the English “Hey Jarvis” model package, and a one-time Windows setup script at `scripts/setup-local-wake-word.ps1`. The setup installs exact `onnxruntime-web@1.20.1` / `jszip@3.10.1` versions in an ignored local folder with a local npm lockfile, and downloads engine/model assets from immutable upstream commit `8002ba9a14d80c0f71447920d3f1c8ee986b1432`. Each downloaded upstream file is checked against its pinned Git blob hash before use. Assets remain ignored by Git; audio inference is performed in-browser on the device after setup. The server serves only a strict allowlist of local wake assets. If the assets are missing or fail to load, the HUD fails closed and keeps text and consent-gated push-to-talk available.

Wake-triggered browser speech recognition requires a separate, session-only checkbox from push-to-talk consent. Push-to-talk transcripts remain review-only until the user explicitly selects **EXECUTE DIRECTIVE**. After local wake detection, consented post-wake speech is submitted through the existing policy gateway; this does not bypass policy denial or required approval. If the browser rejects speech-recognition startup, the HUD clears pending capture state, reports that no command was sent, and schedules local wake standby recovery. The model/runtime is not bundled in Git and has not yet been installed or exercised on the target MSI. Therefore local wake detection is implemented as an integration path but is **not yet accepted as operational**. Exact-head CI and target-device microphone, false-trigger, resource-use and local TTS playback checks are required. As of the latest recorded attempt, hosted Actions jobs failed before runner assignment (`runner_id: 0`, no runner name, no steps), so source build/test status remains unknown until runner availability is restored.


## Task recovery review — implementation status (2026-10-30)

The new branch now exposes an authenticated POST /api/task/reconcile route for tasks already in AWAITING_RECOVERY or INTERRUPTED. The task owner can review their task; an active device with device-management permission can review another device's task. A review note and one of three explicit dispositions are required.

- **Confirmed no effect:** closes the original task as failed; the user must submit a new request if appropriate.
- **Effect observed:** records a partial outcome. It never marks the task completed from a user note alone.
- **Still unknown:** leaves the task awaiting recovery.
- All dispositions avoid automatic replay and do not start the next workflow step. The note is stored in the encrypted task journal; audit records contain only its length, disposition, reviewer and previous state.

The browser companion now includes a Recovery Review panel: it loads recovery tasks through the signed session and submits the selected disposition and note through the signed API. A browser smoke assertion checks the panel and authenticated task-list flow. Automated regression tests have been added, but they have not been executed in this chat environment. The exact-head CI result is not yet available. This feature is **implemented, pending automated validation**, and does not satisfy the real-application recovery acceptance gate by itself.

The follow-up lifecycle audit also adds checkpoint writes for early planning/denial paths, skipped workflow steps, rejection/expiry/cancellation, and final outcomes. A failed final checkpoint is returned as uncertain/recovery-required instead of verified completion. The HTTP recovery endpoint fails closed when the encrypted task journal is not configured.

**Release acceptance remains incomplete:** run build/typecheck/unit tests/browser smoke on the exact new head; then perform the crash/restart and uncertain-side-effect checklist on the target MSI. Do not interpret a manual note as proof that an application saved or submitted anything.


## Voice input validation follow-up — 2026-10-31

The local speech-recognition provider now rejects malformed RIFF/WAV containers and truncated chunks before starting the local recognition process. Regression tests cover container/chunk bounds, PCM format requirements, wake phrase boundaries, and explicit cloud-provider opt-in. Exact-head execution and Windows microphone/model/TTS acceptance remain pending; this change does not claim end-to-end voice completion.

The local Piper TTS adapter now caps captured audio at 16 MiB, bounds retained stderr to 8 KiB, and validates RIFF/WAV size and chunk boundaries before returning generated audio. Added regression tests cover valid WAV output, inconsistent RIFF size, truncated chunks, empty samples, and oversized buffers. These are source-level safeguards only; exact-head CI and audible Piper playback on the MSI remain unverified. The HUD's legacy transcript wake/stop matcher also now requires complete normalized phrase boundaries rather than substring matches; direct HUD-level regression coverage remains to be added.


## Voice capture completion idempotency — 2026-11-01

The HUD now guards each speech-recognition capture's terminal `onend` handler so a repeated terminal event cannot dispatch the same post-wake command twice. Push-to-talk remains review-first; consented post-wake capture still passes through the policy gateway. Tests remain paused and exact-head CI/MSI acceptance are pending.


## Voice cancellation cleanup hardening — 2026-11-01

The HUD now detaches the active browser recognizer before aborting a cancelled capture, stops the audio meter, and relies on capture-generation invalidation to ignore late callbacks. Recognition startup failures also stop the meter. Tests remain paused and exact-head CI/MSI acceptance remain pending.


### Voice timeout safety update — 2026-11-01

A post-wake browser-speech capture that reaches the 15-second limit is now cancelled and discarded instead of being stopped normally, preventing a possibly incomplete final transcript from being auto-dispatched. The cancellation invalidates late recognition callbacks and allows wake detection to recover when still enabled. Push-to-talk continues to expose its transcript for explicit review. This change has not been tested because testing is paused; Windows MSI acceptance and exact-head CI remain pending.


### Voice interruption safety update — 2026-11-02

Non-network, non-permission errors during post-wake speech capture now invalidate the active capture and discard partial speech before automatic dispatch, show a clear “command not sent” status, and schedule wake recovery when hands-free remains enabled. Existing network and microphone-permission failures continue to stop/disable the affected voice path. Testing remains paused; this is a source change, not proof of runtime behavior on Windows.


### Speech output lifecycle update — 2026-11-02

Local TTS playback now attaches completion/error handlers before playback and routes both events through one-shot cleanup, revoking the audio object URL, clearing the speaking flag, and scheduling hands-free recovery when enabled. This is source-level hardening only. Testing remains paused, and actual TTS playback and Windows acceptance are pending.


### Speech output cancellation update — 2026-11-02

Disabling voice output or hands-free now stops active local TTS and browser speech synthesis, releases audio resources, clears a pending hands-free restart timer, and invalidates late synthesis responses so they cannot unexpectedly begin playback. This is source-level hardening only; testing remains paused and runtime/MSI acceptance is pending.


### Hands-free recognizer lifecycle update — 2026-11-02

Stale callbacks from stopped/replaced browser wake recognizers are now ignored; restart scheduling is owned by the active recognizer and its timer is cleared safely before a successor starts. This reduces the risk of overlapping recognition sessions during wake-word and command-capture transitions. Tests remain paused and runtime/MSI acceptance is pending.


### Local wake-engine lifecycle update — 2026-11-02

Local wake model loading and engine startup now verify that their lifecycle is still current after asynchronous waits. Stale starts are stopped rather than enabling wake listening after hands-free was disabled or microphone privacy mode was activated. If hands-free is re-enabled during an old startup, a fresh attempt is scheduled after it unwinds. Tests remain paused; runtime/MSI acceptance is pending.

### Voice visibility recovery update — 2026-11-02

Hands-free wake recovery no longer queues a restart while the HUD document is hidden, including recovery requests raised during capture cancellation. The delayed callback also checks visibility before attempting startup; the existing visibility-change handler schedules recovery when the HUD becomes visible again. Tests remain paused; browser lifecycle behavior and Windows MSI acceptance are unverified.

### Browser wake fallback visibility update — 2026-11-02

The browser-based hands-free fallback now refuses to start recognition while the HUD is hidden or microphone privacy mode is enabled. Its delayed error/end/start-failure recovery callbacks recheck visibility and mute state before opening a new recognition session, matching the local wake engine's foreground-only behavior. Tests remain paused; browser runtime and Windows MSI acceptance are unverified.


### Browser wake-recognition retry safety
- Synchronous `recognizer.start()` exceptions now use the same bounded exponential retry budget as asynchronous recognition errors and session endings, preventing an unbounded fixed-interval restart loop.

- Browser-based wake recognition now uses bounded exponential retry delays and pauses after five consecutive unsuccessful session endings, rather than repeatedly reopening the microphone.
- A usable transcript resets the retry counter. Local wake-word detection remains separate; browser speech recognition still requires its explicit consent setting.
- Runtime/browser acceptance testing has not been run; verify recovery, pause, resume, mute, and hidden-tab behavior on the target MSI before treating this as validated.

## Development increment — safe application intent routing

**Implementation commit:** `09b45366318ed27ee109b8635d56b0448c65b3c8`  
**Status:** IMPLEMENTED / TEST-AUTHORED / CI PENDING

- Changed the local planner so a known app name alone is not enough to create an `app:launch` operation; an explicit launch verb is required.
- Added support for `open`, `launch`, `start`, `run` and `bring up` phrasing, including a leading Hey/Hello/Hi JARVIS wake phrase.
- Kept known apps mapped to their allowlisted IDs and left generic app discovery on its existing policy/approval path.
- Added regression cases for informational mentions and explicit voice-style launch commands.
- Exact-head CI and real MSI voice-to-app execution have not yet been verified.

## Development increment — bounded voice transcription lifecycle

**Implementation:** `src/voice/voiceManager.ts`, `test/voice_manager.test.ts`  
**Status:** IMPLEMENTED / TEST-AUTHORED / EXECUTION PENDING

- Added a separate configurable transcription deadline (`maxTranscriptionDurationSeconds`, default 10 seconds), independent of microphone capture duration.
- Stalled recognition now returns to idle when no text exists, or preserves partial text in confirmation state for explicit review.
- Completion, cancellation, mute and disposal clear the transcription timer; generation checks prevent stale callbacks from affecting later captures.
- Added regression tests for partial-text timeout, empty timeout recovery, completed-transcription timer cleanup and invalid timeout configuration.
- Tests have been authored but not executed in this session; exact-head CI and Windows/browser runtime verification remain pending.

## Development increment — voice directive session diagnostics

**Implementation:** src/companion/hud.js, test/voice_hud.test.ts  
**Status:** IMPLEMENTED / REGRESSION-TEST-AUTHORED / EXECUTION PENDING

- When a wake/voice directive reaches the HUD without a restored authenticated device session, the HUD now reports that the directive was not sent, updates the pipeline as blocked before policy evaluation, adds a failure-feed entry, and speaks the reason where speech output is available.
- This closes a silent-feedback gap: a wake acknowledgement must not be mistaken for successful command submission.
- The planner maps explicit “open Notepad” requests to the existing app:launch operation. The server then applies policy and can require explicit approval; the HUD must show the approval card before launch.
- Tests were extended to assert the unauthenticated-session feedback path. They are authored but have not been executed; exact-head CI and MSI acceptance remain pending.

## Development increment — natural-language app launch normalization

**Implementation:** `src/planner/planner.ts`, `test/planner-launch-phrasing.test.ts`  
**Status:** IMPLEMENTED / TEST-AUTHORED / EXECUTION PENDING

- Normalizes trailing punctuation and common polite suffixes ("please", "for me") before matching application launch intents.
- Routes allowlisted Notepad, Calculator and Paint commands through their existing application IDs; generic app discovery remains constrained to the existing safe app-name character set and policy/approval flow.
- Added regression cases for punctuated and polite launch phrasing.
- No Windows application was launched during this code-only change. Tests, exact-head CI and MSI acceptance remain pending.

## Development increment — existing application window reuse

**Implementation:** src/adapters/windowsAppLauncher.ts, test/windows-app-launcher-window-matching.test.ts  
**Status:** IMPLEMENTED / REGRESSION-TEST-AUTHORED / EXECUTION PENDING

- An explicit launch request now checks the current desktop snapshot before spawning a process.
- If exactly one window matches the allowlisted application identity, JARVIS focuses that existing window and reports success only when Windows confirms foreground focus.
- If focus cannot be verified, the action is reported as a failure rather than claiming the app opened. Ambiguous/multiple matches are not arbitrarily focused.
- Added regression tests for successful existing-window reuse and failed focus verification. Tests are authored but not executed in this environment.


## Development increment — single-use approval interaction hardening

**Implementation:** `src/companion/hud.js`  
**Status:** IMPLEMENTED / VALIDATION NOT RUN

- HUD approval cards now disable both resolution controls while the signed approval/rejection request is in flight and ignore duplicate clicks for the same approval ID.
- Controls are restored only after the request settles and only when the card remains present. Terminal task outcomes remove the card; an unknown/non-terminal outcome keeps it visible and is explicitly labelled as not complete.
- Network/server ambiguity is not presented as success. The operator is told to refresh task status before retrying, because the server may already have consumed the single-use approval.
- Development-only change. Automated tests and target-device checks were intentionally not run in this increment.

## Development increment — HUD task history and manual recovery workflow

**Implementation:** `src/companion/hud.html`, `src/companion/hud.js`, `src/companion/hud.css`  
**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Connected the HUD to the authenticated `GET /api/tasks` endpoint. The recent-task panel refreshes on startup, after directive/approval resolution, on demand, and periodically while the HUD is open.
- Task cards show operation, state, update time, origin, and expandable step status/message details. They do not display task parameters or execution result payloads.
- `AWAITING_RECOVERY` and `INTERRUPTED` tasks expose a manual review form with the server-supported dispositions and an 8–500 character observation note.
- Reconciliation uses the signed `POST /api/task/reconcile` route. The UI explicitly states that this records a human review only and does not retry or resume the original action.
- Recovery controls are shown only for eligible task states. API authorization, task ownership, durable journal availability, and validation remain enforced server-side.
- No tests, CI, or target-device validation were run for this development increment.


## Development increment — task detail view and explicit recovery transitions

**Implementation:** HUD task history and recovery review  \
**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Added an expandable task-detail view with an allowlist of safe metadata: task reference, operation, current state, origin, creation time, last update, and step status/message timeline.
- Task parameters and result payloads remain excluded from the detail view.
- Recovery submissions are guarded against duplicate in-flight requests for the same task.
- Successful reconciliation now explains the selected disposition separately from the server-returned state. `effect_observed` is explicitly not described as independently verified completion; `still_unknown` remains unresolved; `confirmed_no_effect` is not replayed.
- The task list is refreshed after a confirmed reconciliation and the outcome is recorded in the execution feed. No retry, resume, or replay behavior is introduced.
- No tests, build, lint, CI, or target-device validation were run for this increment.


## Development increment — explicit HUD stop/cancel controls and workflow interruption boundary

**Implementation:** `src/core/service.ts`, companion HUD  \
**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Added task-card stop controls for executing workflows and cancellation controls for tasks that have not started execution or are waiting for approval.
- Stop/cancel requests use the existing authenticated, signed `POST /api/task/cancel` endpoint; duplicate in-flight requests for one task are suppressed.
- The core now treats an interrupted adapter result as a hard workflow boundary: it records the current step as uncertain, marks all remaining planned steps as skipped, persists the interrupted state, and returns without evaluating or starting another step.
- The HUD warns that the current operation may already have produced an external effect. It never describes interruption as rollback or proof that the effect did not happen.
- Failed/ambiguous cancellation responses instruct the owner to refresh task status before taking further action.
- No tests, build, lint, CI, or device validation were run for this increment.


## Development increment — asynchronous workflow transition guards

**Implementation:** src/core/service.ts  
**Status:** IMPLEMENTED / VALIDATION NOT RUN

- Re-checks task state when policy evaluation resumes after planner/approval asynchronous boundaries. A task cancelled while planning is pending cannot proceed when the planner later returns.
- Approval expiry now marks the pending task EXPIRED, records remaining workflow steps as skipped, and returns immediately without policy evaluation or execution.
- A successful approval is checkpointed as APPROVED before policy evaluation can reach an adapter.
- If the approval checkpoint fails, execution is blocked and the approval is invalidated where possible; the task remains in recovery.
- Added JARVIS-US-040 to capture lifecycle checkpoint and stale-transition acceptance criteria.
- No tests, build, lint, CI, or device validation were run.

## Shared DevOps pipeline and artifact integrity — 2026-11-05

**Status: IMPLEMENTED IN SOURCE / PIPELINE AND RELEASE ACCEPTANCE PENDING**

The `new` branch now contains a shared artifact-integrity foundation aligned with the Portfolio project:
- Build provenance manifests include project identity, source revision, branch, build number, CI provider/run metadata, and a deterministic release identity.
- SHA-256 checksums and manifest verification are supported, with customer-package verification and authenticated manifest-ignore policy handling.
- CycloneDX dependency SBOM generation and artifact packaging are integrated into repository workflow foundations.
- GitHub Actions and Jenkins definitions include signing/checksum foundations, fail-fast command handling, and scoped signing credentials.
- Jenkins temporary private-key files are cleaned up; GitHub Actions signing secrets are scoped to the signing step.
- Strict provenance validation rejects missing/placeholder project identity, unsupported CI providers, malformed commit/build metadata, and mismatches against current CI environment values.

**Not yet accepted:** manifest file-inventory schema hardening is the next source increment; exact-head CI/Jenkins execution and end-to-end artifact verification remain pending. Nexus publishing is explicitly paused and must remain disabled unless separately authorized. No tests, builds, pipeline runs, customer-package validation, or Nexus publishing were performed for this snapshot.

The DevOps delivery backlog is tracked in [docs/EPICS.md](docs/EPICS.md), [docs/USER_STORIES.md](docs/USER_STORIES.md), and the remaining-work register in [POC2.md](POC2.md).
