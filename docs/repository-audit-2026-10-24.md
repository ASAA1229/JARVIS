# JARVIS Repository Audit Report — 2026-10-24

**Updated after JARVIS Gap Closure Rounds 1–15.** This report records the live GitHub branch state, source-level findings, hosted CI evidence, and remaining acceptance gaps. It is not a physical-device certification.

## Scope and method

Reviewed repository metadata, remote branch inventory, PR #12, branch/tree comparisons, the recursive source tree on new, core implementation files, current POC/requirements documentation, and recent GitHub Actions runs.

Repository: https://github.com/Guda-Abhishek/JARVIS  
Default branch: main (private repository)  
Audit baseline before this report's documentation updates: new at 6222e1964774c78e6853d6113335b1a3f0284881.

The remote GitHub review can inspect source and hosted CI but cannot operate the owner's Windows desktop, microphone, or Android phones. Source presence and CI success are not proof of real-world acceptance.

## Branch and PR findings

At the start of this audit, the remote branches were:
- dev — d061216b2a007992e4ddae912d8e88c812934bd1
- main — 5c7d8d303862de6ac730db9e15855b5f6a70af59
- new — 6222e1964774c78e6853d6113335b1a3f0284881

PR #12, titled “New”, from new to dev was already merged on 2026-10-24. Merge commit: d061216b2a007992e4ddae912d8e88c812934bd1. See https://github.com/Guda-Abhishek/JARVIS/pull/12.

The dev and new commits reference the same Git tree c1f4e650e4e358bd9e00505c2e3e01cff32f9a18. Thus their code/files were identical at the time of inspection, while dev was one merge commit ahead of new. This is a same-tree result, not identical commit IDs.

The missing role branches were recreated from dev:
- fix — debugging and regression fixes
- test — test/audit work
- enhancement — broader feature enhancements

main was not modified. The branch recreation was based on dev's merge commit. Branch-specific CI triggered for fix/test was still in progress at the time of the initial inventory; the latest run status must be checked before describing those branch heads as CI-validated.

## Hosted CI evidence

- new, commit 6222e1964774c78e6853d6113335b1a3f0284881: successful run https://github.com/Guda-Abhishek/JARVIS/actions/runs/40098158500
- dev, commit d061216b2a007992e4ddae912d8e88c812934bd1: successful run https://github.com/Guda-Abhishek/JARVIS/actions/runs/40098105606

The latest new commit message records the final 103-test security CI pass. Use the linked workflow run for exact job evidence. The configured CI includes locked dependency installation, build/typecheck, tests and browser smoke. npm audit is not confirmed by these runs; the package advisory endpoint was previously unavailable.

## Source-level implementation findings

### Present foundation
- Node.js 24 / TypeScript modular-monolith project with build, lint/typecheck, test and browser-smoke scripts.
- Device identity/session and signed-request foundations using Ed25519, replay checks, enrollment proof-of-possession, owner approval, TOTP step-up and revocation.
- Default-deny policy gateway with operation/permission/parameter checks, task-scoped approval binding and audit logging.
- Hash-chained audit records, error redaction and fail-closed handling in security-sensitive paths.
- Selected read-only Windows system queries.
- Windows app launch adapter with a small static allowlist and constrained Start-menu discovery.
- Foreground-window desktop adapter for explicit text paste, clipboard selection, allowlisted hotkeys, zoom shortcuts, control inspection/click/value setting.
- Encrypted local memory foundation with categories/TTL and integrity checks.
- Browser companion/HUD with push-to-talk/text fallback, optional local Piper TTS, and capability registry.
- Official app-store search URL generation.

### Gaps confirmed by source/document inspection
1. **Universal Windows control:** current UI automation targets the foreground window and accessible uniquely named controls. It cannot guarantee operation in every installed/custom-rendered app. Keyboard/clipboard acknowledgements do not prove content was saved.
2. **Voice:** current voice manager defaults wake-word listening off. Browser speech recognition may use vendor/cloud processing. Always-ready local wake phrase and real microphone/TTS acceptance are not proven.
3. **Native Android:** no complete native Android agent or Android Keystore client is present in this source tree. Two-phone enrollment, secure remote transport and device-level acceptance remain open.
4. **Communications:** end-to-end email send/schedule, WhatsApp, SMS, cellular/VoIP calls, Teams, Microsoft 365 and calendar adapters are not complete in this POC.
5. **Scheduling and autonomy:** durable multi-step workflows, recurring/conditional scheduling, unattended persistence/recovery and reconnect reconciliation are incomplete.
6. **Memory:** encrypted local storage exists, but full review/conflict UI, source visibility, semantic retrieval, cross-device sync policy, retention lifecycle and verified deletion across backups remain open.
7. **App installation:** current official-store functionality generates official search destinations; it does not silently install apps.
8. **Financial/payment protection:** process/window-name checks are only defense in depth. The owner policy exclusion must remain and must not be represented as perfect detection.
9. **Remote transport:** current loopback-first behavior does not establish a secure, accepted remote device channel.
10. **Cost/privacy:** the deterministic planner does not currently use OPENAI_API_KEY; hybrid local/cloud routing and provider/free-tier verification remain future work.

## Acceptance matrix

| Area | Repository/CI evidence | Current status |
|---|---|---|
| Build, static check, automated tests, browser smoke | Successful hosted CI on new and dev commits above | PASS for those exact commits |
| Device identity, request signing, approval gateway | Code and regression tests present | Implemented foundation; independent review and edge-case coverage remain |
| Windows app launch | Adapter and tests present | Partial; target Windows interactive-session test required |
| Windows UI Automation | Bounded adapter and tests present | Partial; real app acceptance and stronger outcome verification required |
| Voice/HUD | Browser companion and smoke harness present | Partial; physical mic, local wake and audible TTS not accepted |
| Encrypted memory | Store/API foundation and tests present | Partial |
| Native Android / two phones | No completed native agent in tree | Planned/incomplete |
| Email, messaging, calls, Teams, Microsoft 365 | No complete end-to-end integration layer | Planned/incomplete |
| Scheduled unattended workflows | No complete durable scheduler/orchestrator | Planned/incomplete |
| Universal app discovery/control | Partial launch discovery and bounded Windows UI automation | Planned/partial; not universal |
| npm audit | No verified current result | Unverified |
| Physical-device/security acceptance | Not possible through hosted CI alone | Open |

## Required next steps

1. Keep POC.md honest about implemented vs partial behavior; keep POC2.md as the acceptance checklist.
2. Merge the current documentation reconciliation to dev by PR only; do not automate main.
3. Run exact-commit CI on all updated branches and confirm the newly recreated branch runs.
4. Close P0 security/approval/transport gaps before broad automation.
5. Validate the Windows agent on the target laptop and implement/test native Android support on both phones.
6. Build communication, calendar, application-adapter, and durable workflow layers incrementally with explicit approvals and result verification.
7. Run failure-injection, privacy, memory-retention/deletion, performance and physical-device acceptance.
8. Update existing documentation only; do not create duplicate status/requirements Markdown files.

## Overall assessment

The repository has a useful security-oriented foundation and a green automated baseline, but it is **not yet the planned universal JARVIS assistant**. The most significant missing areas are native Android/remote operation, real Windows acceptance, local always-ready voice, end-to-end communication integrations, durable scheduling/workflows, and full user-controlled memory. The next implementation phase should begin with the POC2 acceptance register and staged security-first delivery, not a broad unbounded feature dump.


## Addendum — gap-closure documentation reconciliation (2026-10-24)

After the initial source audit, the following existing files were updated on the non-main branch new to align the current status and the 15 approved discovery decisions: POC.md, POC2.md, README.md, AGENTS.md, master_repo_md.md, docs/PERSONALIZED_JARVIS_REQUIREMENTS.md, and docs/CROSS_DEVICE_IMPLEMENTATION_STATUS.md. This audit report was also refreshed. No new Markdown files were created and no application source code was changed by this documentation pass.

The documentation now distinguishes current repository implementation from the broader target: local always-ready wake-word voice, native Android/Android Keystore, two-phone remote control, email/WhatsApp/SMS/call/Teams/Microsoft 365 integrations, durable scheduling, full memory lifecycle, and universal app control remain incomplete until implemented and accepted.

The branch update/reconciliation itself is scoped to non-main refs. PR #12 (feature integration) and PR #13 (documentation reconciliation) were merged into dev; PR #13 merge commit is 29df6b8699a8145f2163efee0c0ac306af2e7adc. main remains untouched. CI passed for new documentation head 6dd9d8d62ccf2610fb458da159fc1dd11f47079c (run 40099231737) and dev merge commit 29df6b8699a8145f2163efee0c0ac306af2e7adc (run 40099365008), with the same integration commit also passing on fix and test (runs 40099378785 and 40099381517).


## Addendum — source hardening and HUD honesty pass (2026-10-24, uncommitted working-tree changes)

**Verification status: NOT RUN.** This pass was made through file-level edit access only. No terminal, Git, build, type-check, test, browser or device was available, so `npm run lint`, `npm run build`, `npm test` and `npm run test:browser` have **not** been executed against these changes. Treat every item below as *implemented in source, unverified* until those commands pass on the owner's machine. The reference images (HUD.png, HUD2.png, companion.png) were not visually inspected in this pass.

### Changes made

| Area | Prior state (from source inspection) | Change | Verification |
|---|---|---|---|
| Policy gateway auditing | Replay of a consumed approval, reuse of a rejected or expired approval, and use of an unknown approval id were denied but left no audit event. | `src/policy/gateway.ts` now records `POLICY_DENIED_APPROVAL_NOT_FOUND` (identifier truncated to 12 characters) and `POLICY_DENIED_APPROVAL_UNUSABLE` (`ALREADY_CONSUMED`, `REJECTED` or `EXPIRED`). Denial reasons and decisions are unchanged. | New tests in `test/approval_lifecycle.test.ts`; not run |
| Approval table growth | `pendingApprovals` was never pruned. | Added `PolicyGateway.pruneApprovals()`, called on each new approval request. Only records expired more than 1 hour ago are removed; a pruned approval is reported as not found, so it can never authorize anything. | Test in `test/approval_lifecycle.test.ts`; not run |
| Status endpoint | `/api/status` returned only `status`. | Now also returns `platform`, `uptimeSeconds` and `checks` (`auditIntegrity`, `identityState`). Values are measured at request time. No device, key, token, session or audit content is exposed. | `test/hud_telemetry.test.ts`; not run |
| HUD telemetry | `SYSTEM: WINDOWS 11` and `HOST LINK: LOCAL 127.0.0.1` were hard-coded. After an outage the host indicator stayed `OFFLINE` forever and the banner never recovered. | `src/companion/hud.html` and `hud.js`: values now come from `/api/status`; hard-coded text replaced with `CHECKING`; recovery from an outage is detected and reported; failed health checks are named when degraded. | Static-content tests; not run in a browser |
| HUD voice display | The listening waveform was a synthetic sine wave presented as voice activity. | `hud.js` now reads real microphone samples through a local `AnalyserNode` during user-started capture. If no level data is available it draws a flat dashed line labelled `CAPTURING - NO LEVEL DATA` instead of simulating input. Audio is not recorded, stored, uploaded or played. The meter is stopped on stop, cancel, recognizer end, mute and by a 1-second backstop timer. The idle ambient line remains decorative and is not telemetry. | Static-content tests only; **real microphone behavior is unverified** |
| HUD resource use | Waveform ran at display refresh rate; status/audit polling continued while the tab was hidden. | Waveform limited to about 30 fps; status and audit polling skip while `document.hidden`. | Not measured |

### Files changed

`src/policy/gateway.ts`, `src/server/server.ts`, `src/companion/hud.html`, `src/companion/hud.js`, `test/approval_lifecycle.test.ts` (new), `test/hud_telemetry.test.ts` (new), and this report. `data/`, `.env` and the reference images were not read or modified.

### Behavioral risks to check when tests are run

- The new tests assume a fresh identity-state path reports `identityState: true`; if `JarvisServer`'s third constructor argument has different semantics, `test/hud_telemetry.test.ts` may need adjusting.
- The new audit events call `AuditLogger.record`, which already throws when the log is unhealthy. This is intentional fail-closed behavior, but it means a corrupted log now also stops denial paths that were previously silent.
- `hud.js` opens a second, level-only microphone stream while capturing. Confirm in Chrome/Edge on the target laptop that this does not interfere with `SpeechRecognition` and that the microphone indicator clears when capture ends. `test/browser-smoke.mjs` launches Edge with a fake media device, so the meter will start there too; that run is the first thing to check for regressions (it mocks `SpeechRecognition`, so it does not prove real recognition).

### Findings from this inspection (not fixed in this pass)

1. **Remembered approval for `app:launch` (design decision, review recommended):** an approved launch is remembered per device and parameter set for 30 days and later runs without a prompt. It is device- and parameter-bound and persisted with an HMAC only when an owner control token is configured; otherwise it is session-local. Confirm 30 days is the intended window.
2. **Hard-coded companion elements:** the HUD's POLICY RISK MATRIX and `POLICY: DEFAULT-DENY` label are static descriptions of design intent, not live measurements. They are accurate to the current gateway but are not computed from it.
3. **Approval state is in memory only.** A restart discards pending approvals, which fails safe, but there is no durable workflow recovery.
4. **Voice:** recognition still depends on the browser speech service; there is no local wake-word or local speech-to-text engine. Hands-free wake phrases are matched against browser transcripts.
5. **Not addressed here:** Windows desktop agent hardening, native Android, communications, scheduler, memory review UI, file/terminal scope, and the larger companion redesign. The earlier gap list in this report still applies to all of them.

### Manual acceptance still required

1. Run `npm run lint`, `npm run build`, `npm test`, `npm run test:browser` and record the real results.
2. Open `/hud`: confirm SYSTEM and HOST LINK populate from the server, stop the server and confirm `OFFLINE`/`UNREACHABLE`, restart it and confirm `HOST RECONNECTED`.
3. With a physical microphone, press the voice button and speak: the line should follow real input; deny microphone permission and confirm the `NO LEVEL DATA` label; confirm the browser microphone indicator clears after capture ends.
4. Trigger an approval, let it expire, and confirm a `POLICY_DENIED_APPROVAL_UNUSABLE` audit entry appears.


## Addendum 2 — HUD and companion visual redesign (2026-10-25, uncommitted working-tree changes)

**Verification status: NOT RUN in a real browser against the live server; tests not executed.** The three reference images were viewed. The redesigned markup and CSS were rendered as static pages in headless Chromium (no scripts, no backend) at 1440x900 (HUD), 1280x900 and 390x844 (companion) and compared by eye with the references; the 820 px HUD layout was rendered but not reviewed. Script behavior (state colours, pipeline, status nodes, link banner, microphone meter) was **not** exercised in a browser. `npm run lint`, `npm run build`, `npm test` and `npm run test:browser` have not been run.

### Reference analysis (HUD.png, HUD2.png, companion.png)

Deep navy field with a faint city-night glow; cyan line-work with amber used for alerts and green for success; bracketed glass panels; a title plate with a ruler across the top; a large central reactor made of tick rings, thick arc segments and crosshairs around a cyan-to-amber particle swirl; a status line with three circular nodes at the bottom; hazard-striped headings on security panels in the companion reference; a terminal-style audit log. Decorative values in the references (temperature, munitions, threat level, coordinates) were deliberately **not** reproduced because JARVIS has no such data.

### What changed

| File | Change |
|---|---|
| `src/companion/hud.css` | Full rewrite. Palette and tokens, bracketed `.frame` panels, title plate, SVG reactor styling, swirl core, state-driven colour/speed, status nodes, pipeline, chamfered controls, responsive breakpoints at 1180/760 px, reduced-motion support (manual toggle and OS preference). CSS only; animations use transform/opacity; no `backdrop-filter`. Camera/gesture rules were carried over unchanged. |
| `src/companion/hud.html` | Restructured: header plate and measured-readout panel, SVG reactor with accessible core button (`role=button`, `tabindex`, Enter key), waveform under the reactor, status nodes, directive pipeline, control bar (mic, wake phrase, pause, hands-free, voice, motion). All previous element ids kept. No inline styles or scripts. |
| `src/companion/hud.js` | `setAssistantState` now sets `body[data-state]` (idle / listening / processing / attention / error / muted) derived from the real status label; speaking is mirrored from `isSpeaking`. Real-state status nodes (core, host, session). A directive pipeline (sent, policy, consent, verified) that advances only from actual server responses or request failures, with a distinct skipped-consent state. Waveform line recoloured to the new palette. |
| `src/companion/index.html`, `style.css` | Companion restyled to the same language: title plate, laptop link banner, request pipeline, hazard-striped security headings, two-column desktop layout and mobile-first single column (requests, approvals, outcomes, device, audit). Hard-coded `Audit Chain: VALID` and `Host: Windows 11 Home` removed. |
| `src/companion/app.js` | `pollStatus` now drives a three-stage link state (online / reconnecting / unreachable after 3 failed polls) with an honest banner that says nothing is queued while the laptop is unreachable; audit-chain validity and host OS come from `/api/status`; request pipeline; approval cards now state that approvals are single-use, short-lived and bound to the exact action. |
| `test/hud_telemetry.test.ts` | Added structural tests (required ids, no inline style/script, state and pipeline wiring, companion link state). Static checks only. |

No security, authentication, device-identity or policy logic was changed in this pass. The reference PNGs were not copied into the repository's runtime assets.

### Known limits of this UI pass

- No Stop/Cancel-task control was added to either UI: the server has no task-cancellation endpoint, and a button that did nothing would be misleading. Escape still cancels voice capture only.
- The idle reactor swirl and ambient waveform are decorative; the label and nodes carry the real state.
- Two separate hands-free controls remain (wake phrase detection and continuous capture). That duplication predates this pass and is confusing; it should be merged in a follow-up.
- Android and iOS were not addressed; the companion is still a web page, not a native agent.

### Manual visual acceptance

1. Run the checks listed above, then open `/` and `/companion` at 1440, 1024, 820 and 390 px widths and compare with the three references.
2. Confirm the reactor changes colour for listening, processing, error, and muted states, and pulses while a spoken reply plays.
3. Stop the server: the HUD host node should show OFFLINE and the companion should move from RECONNECTING to LAPTOP UNREACHABLE after about 9 seconds; restart it and confirm both recover.
4. Submit a read-only directive and a launch directive and confirm the pipeline shows a skipped consent stage for the first and a waiting consent stage for the second.
5. Turn on reduced motion (and, separately, the OS setting) and confirm the rings stop spinning.
6. On the target laptop, check CPU use of the HUD tab while idle.


## Addendum 3 — Functional gap closure (2026-10-26, uncommitted working-tree changes)

**Verification status: NOT COMPILED, NOT RUN.** This pass was made with file-edit access only, at the owner's instruction not to run or write tests. Expect to fix compile errors on first `npm run build`; existing tests that assumed the old behavior (see Behavior changes) need updating.

### New modules

| Module | What it does | Limits |
|---|---|---|
| `src/adapters/windowsWindows.ts` | Window discovery (`Get-Process` main windows), exactly-one-match focus with `GetForegroundWindow` readback, new-window detection, shared PowerShell error classification (timeout, cancelled, locked session, target mismatch, blocked, unavailable). | Windows only; untested on a real desktop. Focus can be refused by Windows focus-lock, which is reported as a failure. |
| `src/adapters/workspaceFiles.ts` | list / name-search / read / create-new / single-edit (with backup) / delete-to-quarantine / restore inside configured roots. Symlinks, junctions, reserved device names and credential-like file names refused; every mutation verified by read-back or checksum. | Roots from `JARVIS_WORKSPACE_ROOTS` (default `~/Documents/JARVIS Workspace`). Text files up to 256 KB. Name search only. Quarantine is never purged automatically. |
| `src/adapters/terminalRunner.ts` | Non-shell execution of allowlisted read-only programs (`git` status/log/diff/branch/rev-parse/show/ls-files with a flag allowlist, `node --version`, `python --version`, `hostname`), 15 s timeout, 64 KB output cap, process-tree kill, scrubbed environment, workspace-only working directory. | Not a general shell. No package scripts. No elevation path exists. |
| `src/scheduler/scheduler.ts` | Scheduled and recurring requests stored as owner + request text only; at-most-once delivery; missed one-shots are never replayed; HMAC-protected persistence when an owner token is set. | Each run re-enters the normal pipeline, so state-changing steps wait for a fresh approval (approvals expire after 5 minutes). Unattended state-changing automation is deliberately not possible. |
| `src/core/notifications.ts` | Bounded feed for approvals needed, blocked, failed, uncertain, completed, expired, cancelled, schedule and revocation events. | In memory only; short non-sensitive summaries. |
| `src/voice/providers.ts` | Speech-to-text / wake-phrase provider interfaces, a real local `whisper.cpp` provider, a configurable transcript wake-phrase matcher, privacy settings (cloud speech off unless `JARVIS_ALLOW_CLOUD_SPEECH=1`). | Needs whisper.cpp and a model installed (`JARVIS_WHISPER_CLI`, `JARVIS_WHISPER_MODEL`). No audio-level wake-word engine exists. The HUD is **not yet wired** to the local engine and still uses browser recognition. |

### Changes to existing code

- **Verifier / types:** an UNCERTAIN adapter result is no longer reported as a clean failure; tasks move to `AWAITING_RECOVERY` and are never auto-retried. `ExecutionResult.failureKind` added.
- **Desktop agent:** timeouts and cancellation after input was sent are UNCERTAIN; locked-desktop guard; optional `expectProcess` pins input to the intended foreground process; new `desktop:list_windows` and `desktop:focus_window`.
- **App launcher:** a launch is VERIFIED only when a new window of the app appears (before/after window snapshot); a process check alone is now PARTIAL. `desktop:launch_and_type` types only into the verified window, after focusing it and pinning `expectProcess`; otherwise it refuses to type.
- **Policy gateway:** rules for window focus/list, `file:*`, `terminal:run`, `schedule:*`, `memory:update`; `invalidateApprovals()` for task cancellation and device revocation.
- **Core service:** all new operations dispatch only from the post-policy execution path; 60 s ceiling per execution; one bounded retry for read-only operations after a timeout; per-step records (completed / failed / uncertain / blocked / skipped / awaiting approval / cancelled); `cancelTask`, `onDeviceRevoked`, `getHealthSnapshot`; scheduled jobs run through the same pipeline; approval expiry marks the task EXPIRED.
- **Server:** `GET /api/notifications`, `GET /api/health` (owner devices), `GET /api/tasks`, `POST /api/task/cancel`, `GET /api/voice/capabilities`, `POST /api/voice/transcribe`; revocation now cancels that device's approvals, schedules and running tasks; the scheduler starts and stops with the server.
- **Planner:** natural-language mappings for the new operations (shell metacharacters never match).
- **Memory:** correction (`memory:update`), instruction-like text refused as untrusted, relevance-based retrieval for planning, deletion verified by decrypting the stored file again.
- **Conversation layer:** its action-verb detector was extended so the new commands reach the planner instead of the chat model.

### Behavior changes that may break existing tests or habits

1. **Remembered app-launch approvals are now OFF by default.** Previously one approval allowed that app/device launch without prompting for 30 days. Now every launch needs a fresh single-use approval; the owner may opt in with `JARVIS_REMEMBER_LAUNCH_MINUTES` (1-240). Tests in `test/remembered_approval*.test.ts` that assume the old behavior need that variable set or updating.
2. A launch with no detectable new window is PARTIAL, not VERIFIED (for example Notepad reusing an existing window).
3. UNCERTAIN results now surface as `AWAITING_RECOVERY` instead of FAILED.

### Still not implemented (needs more than this iteration)

- HUD/companion wiring to local speech-to-text, always-on local wake word, interruptible speech and approval-aware spoken flow beyond what existed.
- UIA/accessibility-tree control (named-control clicks from the earlier agent are unchanged); zoom/clipboard improvements beyond the target-pinning guard.
- Queueing of harmless requests while the laptop is asleep (the companion reports unreachable and queues nothing), secure remote access away from home, native Android agent with Keystore keys.
- Email/SMS/WhatsApp/Teams adapters and memory review/correction UI remain outstanding. Browser UI now exists for notifications and schedules, but it is polling-based and still needs hosted CI plus physical-device acceptance.
- Multi-step plans still come only from the local heuristic planner; no dependency graph beyond ordered steps; no LLM planner provider.


## Audit addendum — 2026-10-26 regression triage

### Hosted CI result reviewed

Workflow run [40216510796](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40216510796) completed with **build PASS, TypeScript check PASS, automated tests FAIL (127 passed, 3 failed), browser smoke SKIPPED**. The failure was not a remembered-approval regression: both remembered-approval tests passed.

The three failures were stale assertions in `test/e2e_recovery.test.ts`:
1. The public `/api/status` response tests expected only `status`, while the current handler also emits coarse runtime fields (`platform`, `uptimeSeconds`, and boolean health checks). The assertions now validate the exact non-secret schema and types.
2. The expired-approval HTTP test expected the task to remain `AWAITING_APPROVAL`, while the current lifecycle deliberately transitions it to `EXPIRED`. The test now checks `TaskState.EXPIRED`.

These test-only corrections were pushed to `new` in commit `4909abf4e2a44fdf14a1c874d0348a9ebd80db7b`. A follow-up source-comment correction was pushed in `679630345ec40f8584f8454bdc74375b3983789c` to align the remembered-grant comment with the implemented 30-minute default. **The corrected commit has not yet been confirmed by a completed hosted CI run in this report.**

### Security interpretation

The status endpoint exposes only platform, uptime, and two coarse health booleans in addition to status; it does not expose device records, keys, tokens, task content, or audit internals. Keep the schema assertion strict so future additions are reviewed. Approval expiry must remain terminal and must not execute the operation.

### Remaining validation

- [ ] Confirm hosted build, typecheck, complete automated suite, and browser smoke on the corrected source commit.
- [ ] Run `npm audit` against the locked dependency tree and record the exact result; the previous report did not verify this.
- [ ] Perform target Windows 11 interactive desktop, microphone/TTS, and both Android-device acceptance. Hosted CI cannot substitute for these checks.


## Audit addendum — approval replay and corrupt-state coverage (2026-10-26)

Added tests in `test/remembered_approval.test.ts` for parameter-scope tampering, cross-task replay, single-use consumption, and corrupted remembered-grant state. The corrupt-state test verifies that the policy gateway requires a fresh approval and refuses to report a remembered grant as safely persisted when the integrity envelope is invalid.

These tests are committed to branch `new`; **no execution result has been observed for this commit yet**. Do not mark this control verified until the hosted test suite passes. Remaining P0 test gaps include concurrent/duplicate resolution, wrong-device binding, approval expiry boundaries, audit-chain failure, and session/device revocation behavior.


### Approval lifecycle test expansion — 2026-10-26

Added explicit tests for duplicate resolution, cross-device replay, and approval expiry. These complement parameter-scope mutation, cross-task replay, single-use consumption, and corrupted remembered-grant persistence coverage. These are source changes only until a completed CI run confirms the tests pass; they are not yet marked verified.


## Companion notification UI addendum — 2026-10-26

Implemented on `new`:
- Browser companion now renders the authenticated device-scoped notification feed using `GET /api/notifications`.
- Notifications refresh on demand and poll every 10 seconds while the page is visible.
- Rendered notification content uses `textContent` rather than HTML injection.
- Browser smoke coverage now expects a verified read-only request to appear in the notification feed.

**Not yet verified:** the workflow triggered by these changes has not been confirmed green at the time of this documentation update. Browser polling is not native push delivery, and this change does not complete Android notifications or background delivery.


## Companion schedule manager addendum — 2026-10-27

- Added schedule controls in the browser companion for one-time and recurring requests, owner-scoped listing, and cancellation.
- All schedule actions are sent through the signed `/api/request` path; no direct scheduler endpoint bypass was introduced.
- Added planner grammar for a separate initial delay and repeat interval, with tests for minute/hour parsing and read-only schedule listing.
- Added browser smoke coverage for schedule listing alongside notification rendering.
- Scheduling remains service-dependent; the browser companion is not native Android push delivery.

**Validation status:** implementation and tests are committed on `new`; full CI and browser smoke on the exact latest head remain required. Do not treat as accepted before the hosted workflow passes.


## Personal memory review controls — 2026-10-27

- Browser companion now exposes review, category-aware save, correction, and deletion request controls for encrypted local personal memory.
- Mutations use the signed `/api/request` pipeline and remain subject to policy/approval. The UI uses text-only DOM insertion for stored content.
- Planner routing was extended for explicit memory categories and the conversational layer recognizes memory management commands.
- Delayed recurring schedule parsing was corrected to use regular expression escapes rather than literal backslash characters.
- A new planner test file covers category-aware saving and listing; conversation tests cover review, correction, and deletion routing.

**Acceptance gate:** hosted CI on the latest branch head, including browser smoke, has not yet been confirmed green. Do not accept these changes based solely on source edits. Physical Windows and Android device validation remains outstanding.


## Follow-up audit — 2026-10-29

### Changes verified on branch `new`

1. **Conversation routing regression:** CI run [40923859884](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40923859884) failed because `List installed apps` returned the conversational model-unavailable response instead of routing to the action planner. Added installed-app inventory phrasings to the action-request matcher. The existing `test/conversation.test.ts` case now passes in the final successful suite.
2. **Scheduler persistence fail-closed behavior:** inspection found that `Scheduler.tick()` ignored the return value from the durable pre-execution state write and could invoke the runner even when the at-most-once advance had failed to persist. The scheduler now returns without invoking the runner on that failure, stops scheduled execution after persistence health becomes unhealthy, and reports cancellation as failed if cancellation state cannot be persisted.
3. **Regression test:** added `test/scheduler_persistence_security.test.ts`, which simulates a persistence failure and asserts that the runner is not called and the persistence failure is audited.

### Verification

- Final code/test commit: `405b2eb233f08dfa0dde022a781cc34c611acd97`.
- Successful push CI: [40926857275](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40926857275).
- Successful PR CI: [40926865217](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40926865217).
- Both runs passed TypeScript build, TypeScript check, automated test suite, and browser security smoke.
- The dependency installation step reported zero vulnerabilities during `npm ci`; a separate `npm audit` command has not yet been recorded.

### Remaining acceptance limits

This automated verification does not prove real Windows desktop interaction, microphone/wake/TTS behavior, local model inference, native Android control, two-phone authorization/revocation, or communication integrations. Those remain blocked or unverified until the target hardware, required services, and supported integrations are exercised. The overall project remains **NOT RELEASE-READY**.

## Follow-up audit — 2026-10-30 (Windows launch identity)

### Finding and correction
- **Finding:** The app-window polling logic accepted a new window if either its process name matched the allowlist or its title contained a configured substring. The title-only branch could falsely verify an unrelated process as the requested application.
- **Correction:** launch verification now fails closed unless the process name matches an expected process. A configured title substring is checked as an additional condition, not an alternative identity.
- **Regression coverage:** tests assert expected-process success, unrelated-process/title false positive rejection, title mismatch rejection, .exe normalization, and fail-closed behavior when matcher metadata is missing.
- **Acceptance limit:** this is deterministic unit coverage of matching logic, not proof of actual Windows launch behavior on the MSI laptop. Hosted CI must pass on the latest new branch head; interactive Windows acceptance remains open.

## Follow-up audit — 2026-10-30 (dynamic Start-menu launch)

- **Finding:** dynamically discovered Start-menu apps were considered verified if a newly visible window's title or process text contained the first word of the request. No trusted mapping connected the selected Start-menu AppID to that process.
- **Correction:** dynamic launches now report partial success even when a new window appears. Evidence distinguishes newWindowDetected from targetWindowVerified; the latter remains false until process identity can be independently established.
- **Tests:** added coverage for a title-only lookalike process and for no observed window.
- **Limitations:** this avoids a false success claim but does not yet implement trusted AppID-to-process discovery. Real MSI acceptance remains required.



## Windows desktop field-protection gap closure — 2026-10-30

The Windows UI Automation `desktop:set_value` path now blocks additional sensitive-field name patterns, including one-time passwords (OTP), recovery codes, credit/debit card fields, card expiry/expiration date, account and routing numbers, IBAN, SWIFT code, and sort code. This complements the existing password/PIN/CVV/security-code checks and the financial-app process/window block. Regression coverage asserts that the generated UI Automation script retains the expanded denylist. This is defense-in-depth, not a substitute for classifying every form semantically; fields with misleading or missing accessibility names remain a limitation. Hosted CI for the latest source and test commits must complete before this change is called validated, and physical MSI acceptance remains outstanding.

## Phase 1 baseline audit refresh — 2026-10-30

**Audited integration baseline:** `dev` commit `9d1e160c8b4d46ea163a7fc296ff41b064663e70`. This refresh checks the current branch metadata and hosted CI evidence; it does not certify the owner's physical Windows laptop or Android devices.

### Findings from current `dev`

- Hosted run [40953010689](https://github.com/Guda-Abhishek/JARVIS/actions/runs/40953010689) on the exact `dev` commit completed with **failure**.
- TypeScript build: PASS.
- TypeScript check: PASS.
- Automated tests: **158 passed, 1 failed**.
- Browser security smoke: SKIPPED because the automated suite failed.
- The failing assertion is in `test/windows_desktop_agent.test.ts`, checking the generated Windows sensitive-field guard. The generated PowerShell expression contains the expected terms, but the test's single compound regular-expression assertion fails. The assertion was changed on `new` to check each required term independently; this is a test correction, not proof of runtime Windows UI behavior.
- Dependency installation in that run reported `found 0 vulnerabilities`. To make this an explicit CI gate, `npm audit --audit-level=moderate` was added to the workflow on `new`; acceptance depends on its completed result for the exact latest commit.
- GitHub branch metadata reports `dev` as **not protected**, with no required status checks. This means CI is advisory rather than enforced by branch protection at present; repository settings need owner review.
- `main` was not changed.

### Phase 1 remediation in progress on `new`

- Updated the sensitive-field test assertion to check each expected credential/financial-field pattern independently.
- Added an explicit dependency audit step to `.github/workflows/ci.yml`.
- Hosted CI is running against the updated `new` commits. Do not mark the baseline green until build, typecheck, dependency audit, the complete test suite, and browser security smoke all pass on the same exact head.
- The next acceptance gate is to merge these changes to `dev` only after the pull request review and green exact-head CI. No PR is to be merged automatically.

### Phase 1 remaining blockers

1. Obtain a green exact-head CI run including the explicit dependency audit and browser smoke.
2. Review whether branch protection and required checks should be enabled for `dev` without changing `main` or its release policy.
3. Complete route-by-route policy-gateway and error-redaction review, including adversarial testing and owner recovery review.
4. Run target-device Windows acceptance and both Android-device acceptance; hosted CI cannot perform these checks.
5. Record exact commit, environment, test result, expected/actual behavior and limitations for each accepted capability.

**Status:** Phase 1 is **in progress**, not complete. No physical-device acceptance is implied by this report.

## Phase 1 route and error-disclosure review — 2026-10-30

### Finding and remediation on `new`

- **Finding:** The authenticated local voice synthesis endpoint returned exception messages from the Piper process directly to the client. Spawn failures can include configured executable paths, and process diagnostics can include model or filesystem details. The local transcription endpoint also forwarded provider exceptions directly, so future providers could accidentally expose implementation details.
- **Remediation:** `/api/voice/synthesize` now returns generic configuration/generation errors and `/api/voice/transcribe` returns a generic recognition error. Provider details remain server-side and are not included in the API response.
- **Regression coverage:** Added `test/voice_endpoint_redaction.test.ts`, which configures a deliberately missing executable with sensitive-looking paths, sends an authenticated signed request, and asserts that the response is a generic failure without those paths.
- **Validation:** This change is committed to `new`; exact-head CI is required before calling it verified. No physical device behavior is implied.
- **Route review status:** Initial source inspection found signed-request authentication on the main task, approval, memory, voice, notification, health, task, cancellation and audit routes; owner-management routes additionally apply permission/policy checks. Public enrollment status/details are transaction-code bound; the bootstrap challenge is gated by the owner control token and closes after an active device exists. This is an initial static review, not a complete penetration test. Remaining adversarial coverage should include body-size/content-type abuse, enrollment transaction replay/races, state-file tampering and recovery, concurrent approval resolution, and route-level permission matrix tests.

### Additional HTTP input-boundary coverage — 2026-10-30

- Added `test/http_body_limits.test.ts` to exercise the live HTTP server's shared JSON-body parser for an incorrect media type, malformed JSON, and an oversized payload.
- Expected outcomes are HTTP 415, 400, and 413 respectively. The test intentionally reaches request parsing before session authorization; it does not imply that the requested operation can execute without a signed session.
- CI for the exact updated `new` head must pass before this coverage is marked verified.


### Android inventory queue input validation — 2026-10-30

A focused hardening increment on `new` adds validation to `src/android/commandQueue.ts` and regression cases in `test/android_command_queue.test.ts`. Device IDs must be bounded identifiers; non-finite TTLs no longer create a NaN expiry; malformed or over-limit app inventories are rejected atomically; and returned inventory snapshots do not alias internal queue state. Invalid completion payloads leave the command in `CLAIMED` state.

**Audit disposition:** source change and test additions are present, but execution evidence is pending. Do not mark the tests as passing until CI or a local test run on this exact head is inspected. This does not close the Android epic: volatile queue state, remote transport/lifecycle behavior and real-device enrollment/revocation remain unaccepted.


### Workflow checkpoint journal prototype — 2026-10-30

Added `src/core/taskJournal.ts` and `test/task_journal.test.ts` on `new`. The journal encrypts task snapshots using AES-256-GCM, atomically replaces the state file, rejects malformed/oversized checkpoint data, and fails closed when authenticated decryption or schema validation fails. Non-terminal states become `AWAITING_RECOVERY` on reload, with stale approvals cleared and no automatic replay.

**Audit finding / release blocker:** the journal is not yet connected to `JarvisCoreService` task lifecycle writes. This is a tested-by-design implementation increment, not yet verified by execution evidence and not a claim of durable workflow support in the live service. Confirm CI on the exact head, integrate every lifecycle transition, and exercise crash/restart with uncertain external effects before acceptance.


## Follow-up implementation audit — 2026-10-30

### Manual recovery review increment

Four implementation commits on the new branch add a guarded manual recovery path:

- Service commit: 39403879bc1db83652157af2c5c36ceb029c3676 — adds task reconciliation semantics.
- API commit: c357ee647d6ff75d9fe7d02fbe3da10c9cca308f — adds signed-session POST /api/task/reconcile.
- Test commit: f795c383a7ff1bfdc4d804361c23f212cd5cb99b — adds service regression tests.
- Journal validation commit: 91b5fc196a64472e273b50588ad103e01ab2cd3a — validates persisted reconciliation metadata.

The workflow supports three human-reviewed dispositions. Confirmed no effect closes the original task as failed; observed effect is only partial/unverified; unknown remains awaiting recovery. It never resumes or replays the task, never starts dependent steps, and never treats a user note as independent proof of application success. The raw recovery note is persisted only in the encrypted task journal; the audit event records its length and disposition, not the note itself.

### Verification status and limits

- GitHub's combined status endpoint returned no status checks for commit 91b5fc196a64472e273b50588ad103e01ab2cd3a at the time of this audit; the connector's workflow-run lookup returned no runs for that SHA. Therefore the new code and newly added tests are **not CI-verified** here.
- No local build/test command was run in this environment.
- The documented Actions runner startup issue remains an external blocker to exact-head hosted validation until a workflow executes its steps.
- The MSI microphone/voice and Windows UI Automation acceptance, and the two-phone Android enrollment/transport/revocation acceptance, still require the actual devices.
- The report file was updated in place; no new report file was created. No PR was opened, and dev/main were not changed.


### Additional security review — stale approval guard (2026-10-30)

A source review found a lifecycle invariant gap: the approval handler did not explicitly require the associated task to remain in AWAITING_APPROVAL before resolving an existing approval record. This matters when a checkpoint failure, interruption, or cancellation has already moved the task into another state. The handler now checks the task state before approval resolution, audits the rejection, and returns a conflict response. A regression test covers a task already awaiting recovery and verifies that the approval remains unconsumed.

The companion now includes a Recovery Review panel that reads tasks via the authenticated signed-session endpoint and submits a user-reviewed disposition through the signed API. This is a review/closure UX, not automatic resume.

**Exact-head validation is still unavailable:** no local test execution was performed, and the connector reports no CI status checks or workflow run for the latest source head. Keep these changes marked pending verification until the workflow actually runs. Physical MSI and both-phone acceptance remain separate release gates.
