# JARVIS Milestones 1–7 Test Results

- **Execution date:** 2026-10-23
- **Branch:** `fix`
- **HEAD SHA for all recorded runs:** `21c02aee19471a048d3391d1515746d25a87247b`
- **Important source identity limitation:** source, test, workflow, and documentation changes were uncommitted. The SHA is the base commit and does not identify the exact tested working tree. No commit was requested or created.
- **Remote:** `origin/fix` was at the same SHA at baseline. The current source tree is not represented by that remote commit.

## Environment

| Component | Observed |
|---|---|
| OS | Microsoft Windows 11 Home Single Language, build 26300 |
| Node.js | `v24.16.0`, platform `win32`, architecture `x64` |
| npm | `11.13.0` |
| PowerShell | `7.6.7` |
| Browser | Microsoft Edge `155.0.4283.62`, headless via `playwright-core` |
| WSL | Ubuntu 2 present; Linux `node` command is unavailable |
| Languages used by project | TypeScript/JavaScript, HTML, CSS, Node.js, npm |
| Python/Java | Not required by the current source or package scripts; not installed/used for this audit |

## Final verification

Every command below ran against the same uncommitted working tree based on `21c02aee19471a048d3391d1515746d25a87247b`.

| Command | Exit | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---:|---|
| `npm ci` | 0 | — | — | — | Lockfile install succeeded; 7 packages added, npm reported 0 vulnerabilities. |
| `npm run build` | 0 | — | — | — | TypeScript production build succeeded. |
| `npm run lint` | 0 | — | — | — | Script is `tsc --noEmit`; type-check succeeded. |
| `npm test` | 0 | 51 | 0 | 0 | All test suites passed, including live HTTP, persistence, regression, and server lifecycle tests. |
| `npm run test:browser` | 0 | 1 workflow | 0 | 0 | `BROWSER_E2E_PASS` in real Edge against the local server. Web Speech recognition is simulated; the uncertain approval response is intercepted. |
| `npm audit --audit-level=low` | 0 | — | — | — | 0 known dependency vulnerabilities. |
| `npm ls --depth=0` | 0 | — | — | — | Declared top-level dependencies resolve from the installed lockfile. |

The browser script does not report a test-case count; it is recorded as one successful browser workflow, not as a TAP test. Its mocked boundaries are the Web Speech recognizer and the ambiguous approval response. Enrollment, device-key signing, HTTP requests, static assets, CSP, real DOM rendering, status polling, and the read-only success path use the local server/browser implementation.

## Focused regressions and iteration history

| Run | Command / purpose | Exit and result |
|---|---|---|
| Initial baseline suite before this audit's added regressions | `npm run build; npm run lint; npm test` | Exit 0 for all; 46 passed, 0 failed, 0 skipped. |
| Dispatcher exposure reproduction | `node --test --import tsx --test-name-pattern="Execution dispatcher is not exposed" test/core.test.ts` | Exit 1, 0 passed / 1 failed. Assertion observed `Reflect.get(service, 'executeTask')` was an `AsyncFunction`; no adapter was invoked. This confirmed the public method was exposed. |
| Expiry and dispatcher regressions after fix | `node --test --import tsx --test-name-pattern="(Execution dispatcher|Expired sessions)" test/core.test.ts` | Exit 0; 2 passed. |
| Expired approval HTTP regression | `node --test --import tsx --test-name-pattern="Expired approval" test/e2e_recovery.test.ts` | Exit 0; 1 passed. |
| Approval-session and policy-flow regression | `node --test --import tsx --test-name-pattern="(authenticated active approver|Policy Gateway enforces|Interrupting)" test/core.test.ts test/hardening.test.ts` | Exit 0; 3 passed. |
| Startup bind-failure regression | `node --test --import tsx test/server_lifecycle.test.ts` | Exit 0; initially 1 passed. A second lifecycle test was added for idempotent stop and is included in the final 51-test run. |
| First full suite after lifecycle test additions | `npm run build; npm run lint; npm test` | Build/lint exited 0; test exited 1, 49 passed / 1 failed / 0 skipped. `RECOVER-01` exposed that `stop()` rejected when shared cleanup stopped an already-stopped server. `stop()` was made idempotent and SERVER-02 was added. |
| First combined lifecycle/recovery rerun | `node --test --import tsx test/server_lifecycle.test.ts test/e2e_recovery.test.ts` | Exit 1, 20 passed / 1 failed. `E2E-LIVE-01` observed a response without a `state` field; no root cause was established. The failure was not reproducible in the isolated test, the subsequent combined rerun, or the final full suite. Failure diagnostics were improved to include the response payload if it recurs. |
| Isolated live HTTP rerun | `node --test --import tsx --test-name-pattern="Full HTTP Lifecycle" test/e2e_recovery.test.ts` | Exit 0; 1 passed. |
| Repeated combined lifecycle/recovery rerun | `node --test --import tsx test/server_lifecycle.test.ts test/e2e_recovery.test.ts` | Exit 0; 21 passed / 0 failed / 0 skipped. |
| Final complete automated suite | `npm test` | Exit 0; 51 passed / 0 failed / 0 skipped. |
| First browser run with simulated `not-allowed` error | `npm run test:browser` | Exit 1 because the browser harness treated the expected app log `Speech recognition error: not-allowed` as an unexpected console error. The harness was updated to require exactly that expected event while continuing to fail on other console/page errors. |
| Final browser run | `npm run test:browser` | Exit 0; `BROWSER_E2E_PASS`. |

The transient `E2E-LIVE-01` failure is recorded as a non-reproduced run anomaly, not silently discarded. It remains a test-stability observation for future CI monitoring.

## Windows adapter probe

The following read-only adapter probe ran directly on the observed Windows 11 environment:

```powershell
node --import tsx --input-type=module -e 'import { WindowsSystemAdapter } from "./src/adapters/windowsSystem.ts"; const adapter = new WindowsSystemAdapter(); const [os, memory, battery, disk] = await Promise.all([adapter.getOsInfo(), adapter.getMemoryInfo(), adapter.getBatteryStatus(), adapter.getDiskSpace("C:")]); console.log(JSON.stringify({ os: { success: os.success, outcome: os.outcome, platform: os.data?.platform, arch: os.data?.arch }, memory: { success: memory.success, outcome: memory.outcome, totalBytes: memory.data?.totalBytes }, battery: { success: battery.success, outcome: battery.outcome, data: battery.data }, disk: { success: disk.success, outcome: disk.outcome, data: disk.data } }, null, 2));'
```

| Operation | Observed outcome |
|---|---|
| OS information | `VERIFIED_SUCCESS`, `win32`, `x64` |
| Memory | `VERIFIED_SUCCESS` |
| Battery | `VERIFIED_SUCCESS` via `Get-CimInstance Win32_Battery` |
| C: disk | `VERIFIED_SUCCESS` via `Get-CimInstance Win32_LogicalDisk` |
| App launch | Existing automated Notepad approval flow ran on this Windows host; it is not proof that Calculator/Paint or the owner's target device passed. |

## Environment and external checks

| Command | Exit | Result / limitation |
|---|---:|---|
| `wsl -d Ubuntu -- node --version` | 127 | Ubuntu WSL returned `/bin/bash: node: command not found`. |
| `wsl -d Ubuntu -- npm --version` | 0 | `11.13.0` printed, but without a Linux Node executable this does not establish a usable Linux Node runtime. No packages were installed in WSL. |
| `gh run list --branch fix --limit 10` | 4 | GitHub CLI requested `gh auth login` / `GH_TOKEN`; hosted CI status could not be queried. |

The CI workflow definition includes locked install, build, type-check, `npm test`, and browser smoke steps, but a workflow definition is not evidence of a run on this working tree. Python and Java checks were not applicable to the current TypeScript/Node project; no unused runtime was installed.

## Reproducible manual acceptance still required

1. **Exact-source CI:** after authorized commit on `fix`, run the workflow against that SHA and retain the hosted run URL and results. Do not represent the historical workflow run as current evidence.
2. **Owner Windows device:** repeat `npm ci`, build, lint, tests, and adapter checks on the owner's designated Windows 11 machine. Test Notepad, Calculator, and Paint only through explicit approval and verify process evidence.
3. **Android/two-phone:** use two physical devices with independent keys; verify enrollment, permissions, concurrent sessions, revoking Phone A while Phone B remains authorized, and native Keystore behavior if a native app becomes available.
4. **Physical microphone/privacy:** in supported browsers, explicitly test grant and deny, release-to-stop, cancellation, timeout, recognizer errors, transcript disposal, visible microphone state, text fallback, and applicable browser-vendor audio-processing disclosures.
5. **WSL/Linux:** provide an approved Linux Node.js 24 runtime, then run `npm ci`, `npm run build`, `npm run lint`, and `npm test` from the project in Ubuntu. No Linux test is claimed here.
6. **Accessibility:** manually verify screen-reader announcements, focus order/visibility, touch cancellation, pointer loss/outside release, and reduced-motion behavior beyond the automated checks.

Current criterion-level dispositions are in the [acceptance audit](milestones-1-to-7-acceptance-audit.md); defects and remaining risks are in the [findings register](milestones-1-to-7-findings-register.md).
