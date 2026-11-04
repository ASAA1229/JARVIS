import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowInfo, WindowsWindowManager } from './windowsWindows.js';

const execFileAsync = promisify(execFile);

export interface AllowlistedApp {
  id: string;
  name: string;
  executable: string;
  processName: string;
  /** How to recognise this app's window when verifying a launch. */
  windowMatch?: { processNames: string[]; titleContains?: string };
}

/**
 * A launch is verified only when the new window belongs to an expected process.
 * A title substring is an additional constraint, never an alternative identity.
 */
/**
 * Unknown Start-menu apps remain partial unless a conservative process identity
 * hint is available. A matching process plus optional title constraint is
 * required before reporting a discovered launch as independently verified.
 */
export function discoveredLaunchResult(
  selected: { Name: string; AppID: string },
  newWindow?: WindowInfo,
  expectedIdentity?: { processNames: string[]; titleContains?: string },
): ExecutionResult {
  const targetWindowVerified = Boolean(newWindow && expectedIdentity && matchesExpectedAppWindow(newWindow, { windowMatch: expectedIdentity }));
  return {
    success: true,
    outcome: targetWindowVerified ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.PARTIAL_SUCCESS,
    data: {
      name: selected.Name,
      appId: selected.AppID,
      status: newWindow ? 'Launch requested; a new window appeared' : 'Launch requested',
      ...(newWindow ? { observedWindow: { pid: newWindow.pid, processName: newWindow.processName, title: newWindow.title } } : {}),
    },
    evidence: {
      discovery: 'Get-StartApps',
      launcher: 'explorer.exe shell:AppsFolder',
      exactOrUniqueMatch: true,
      newWindowDetected: Boolean(newWindow),
      targetWindowVerified,
      verificationLimitation: targetWindowVerified ? undefined : 'No trusted AppID-to-process identity mapping is available for this app.',
      ...(expectedIdentity ? { expectedProcessNames: expectedIdentity.processNames } : {}),
    },
    error: targetWindowVerified ? undefined : 'Windows accepted the launch request, but JARVIS cannot independently verify that the observed window belongs to the selected application.',
  };
}

/** Conservative identity hints for common Windows inbox apps. Unknown apps remain partial. */
const DISCOVERED_WINDOW_IDENTITIES: Record<string, { processNames: string[]; titleContains?: string }> = {
  'settings': { processNames: ['SystemSettings'], titleContains: 'Settings' },
  'microsoft store': { processNames: ['WinStore.App'], titleContains: 'Microsoft Store' },
  'photos': { processNames: ['Photos', 'Microsoft.Photos'], titleContains: 'Photos' },
  'clock': { processNames: ['Time', 'WindowsAlarms'], titleContains: 'Clock' },
};

export function discoveredWindowIdentity(name: string): { processNames: string[]; titleContains?: string } | undefined {
  return DISCOVERED_WINDOW_IDENTITIES[name.trim().toLowerCase()];
}

export function matchesExpectedAppWindow(
  window: WindowInfo,
  app: Pick<AllowlistedApp, 'windowMatch'>,
): boolean {
  const match = app.windowMatch;
  if (!match) return false;
  const processName = window.processName.toLowerCase().replace(/\.exe$/, '');
  if (!match.processNames.some((name) => name.toLowerCase().replace(/\.exe$/, '') === processName)) {
    return false;
  }
  return match.titleContains === undefined ||
    window.title.toLowerCase().includes(match.titleContains.toLowerCase());
}

/** A focus target is safe only when exactly one window has the trusted app identity. */
export function selectUniqueExpectedAppWindow(
  windows: WindowInfo[],
  app: Pick<AllowlistedApp, 'windowMatch'>,
): { window?: WindowInfo; matchCount: number } {
  const matches = windows.filter((window) => matchesExpectedAppWindow(window, app));
  return { window: matches.length === 1 ? matches[0] : undefined, matchCount: matches.length };
}

export class WindowsAppLauncherAdapter {
  constructor(
    private readonly windows: Pick<WindowsWindowManager, 'snapshot' | 'focusWindow'> = new WindowsWindowManager(),
  ) {}

  // Explicit allowlist of launchable applications
  private readonly allowlist: Map<string, AllowlistedApp> = new Map([
    [
      'notepad',
      {
        id: 'notepad',
        name: 'Notepad',
        executable: 'notepad.exe',
        processName: 'Notepad.exe',
        windowMatch: { processNames: ['notepad'], titleContains: 'Notepad' },
      },
    ],
    [
      'calc',
      {
        id: 'calc',
        name: 'Calculator',
        executable: 'calc.exe',
        processName: 'CalculatorApp.exe',
        windowMatch: { processNames: ['calculatorapp', 'calc'], titleContains: 'Calculator' },
      },
    ],
    [
      'mspaint',
      {
        id: 'mspaint',
        name: 'Paint',
        executable: 'mspaint.exe',
        processName: 'mspaint.exe',
        windowMatch: { processNames: ['mspaint'], titleContains: 'Paint' },
      },
    ],
  ]);

  /**
   * Returns list of allowlisted applications.
   */
  public getAllowlist(): AllowlistedApp[] {
    return Array.from(this.allowlist.values());
  }

  /**
   * Capability inventory for allowlisted apps plus, on Windows, unique Start-menu
   * names. This never launches an application and never claims UI automation works
   * for a discovered name.
   */
  public async inventory(signal?: AbortSignal): Promise<ExecutionResult> {
    const allowlisted = this.getAllowlist().map((app) => ({
      applicationId: app.id,
      name: app.name,
      installationStatus: process.platform === 'win32' ? 'allowlisted' : 'allowlisted-not-windows',
      officialApi: 'none',
      uiAutomation: 'foreground-only-if-accessible',
      supportedOperations: ['app:launch'],
      requiredPermission: 'app:launch:execute',
      risk: 'MEDIUM',
      verificationMethod: 'new-window snapshot after launch',
      limitations: 'Launch acknowledgement is not proof the user-visible document was saved.',
      testStatus: app.id === 'notepad' ? 'automated-partial; interactive-laptop-acceptance-required' : 'allowlisted-unverified-on-target-hardware',
    }));
    let discovered: Array<{ applicationId: string; name: string; installationStatus: string; supportedOperations: string[]; risk: string; testStatus: string; limitations: string }> = [];
    if (process.platform === 'win32' && process.env.JARVIS_ENABLE_START_MENU_INVENTORY === '1') {
      try {
        const script = [
          '$ErrorActionPreference = "Stop"',
          'Get-StartApps | Select-Object -First 80 Name, AppID | ConvertTo-Json -Depth 3 -Compress',
        ].join('; ');
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
          timeout: 8_000, maxBuffer: 256 * 1024, windowsHide: true, signal,
        });
        const parsed = stdout.trim() ? JSON.parse(stdout) as Array<{ Name: string; AppID: string }> | { Name: string; AppID: string } : [];
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        discovered = rows
          .filter((row) => typeof row?.Name === 'string' && typeof row?.AppID === 'string' && !this.isFinancialAppName(row.Name))
          .map((row) => ({
            applicationId: row.AppID,
            name: row.Name,
            installationStatus: 'start-menu',
            supportedOperations: ['app:launch-if-unique-name'],
            risk: 'MEDIUM',
            testStatus: 'discovered-untested',
            limitations: 'No official API inventory; UI automation is not implied.',
          }));
      } catch (error) {
        return {
          success: true,
          outcome: VerificationOutcome.PARTIAL_SUCCESS,
          data: { allowlisted, discovered: [] },
          evidence: { startMenuInventory: false, error: error instanceof Error ? error.name : 'UnknownError' },
          error: 'Allowlisted inventory is available; Start-menu discovery failed.',
        };
      }
    }
    return {
      success: true,
      outcome: VerificationOutcome.VERIFIED_SUCCESS,
      data: { allowlisted, discovered, startMenuQueried: discovered.length > 0 },
      evidence: {
        allowlistedCount: allowlisted.length,
        discoveredCount: discovered.length,
        startMenuQueried: process.env.JARVIS_ENABLE_START_MENU_INVENTORY === '1',
        financialAppsExcluded: true,
      },
    };
  }

  /**
   * Launches an allowlisted Windows application and captures evidence.
   */
  public async launchApp(appId: string, signal?: AbortSignal): Promise<ExecutionResult> {
    if (typeof appId !== 'string' || !appId.trim() || appId.trim().length > 120) {
      return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Application name must contain 1–120 characters.', evidence: { requestedType: typeof appId, requestedLength: typeof appId === 'string' ? appId.length : undefined } };
    }
    const requestedName = appId.trim();
    if (this.isFinancialAppName(requestedName)) {
      return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'JARVIS policy excludes payment and financial applications from general-purpose control.', evidence: { requestedApp: requestedName, blockedByPolicy: true } };
    }
    const app = this.allowlist.get(requestedName.toLowerCase());
    if (!app) return this.launchDiscoveredStartMenuApp(requestedName, signal);

    try {
      if (signal?.aborted) {
        return {
          success: false,
          outcome: VerificationOutcome.UNCERTAIN,
          error: 'Application launch was interrupted before process creation',
          evidence: { app: app.id },
          interrupted: true,
        };
      }
      // Capture the current desktop once. Besides identifying new windows after
      // launch, this lets "open Notepad" bring an already-open, unambiguous window
      // forward instead of spawning a process that may hand off to an existing
      // singleton and then fail the new-PID verification.
      let knownWindows: WindowInfo[] = [];
      try { knownWindows = await this.windows.snapshot(signal); } catch { /* verification will be PARTIAL */ }
      const knownPids = new Set(knownWindows.map((window) => window.pid));
      const existingMatches = knownWindows.filter((window) => matchesExpectedAppWindow(window, app));
      if (existingMatches.length === 1) {
        const existing = existingMatches[0];
        const focused = await this.windows.focusWindow({ pid: existing.pid }, signal);
        if (!focused.success || focused.outcome !== VerificationOutcome.VERIFIED_SUCCESS) {
          return {
            ...focused,
            success: false,
            error: 'The application is already open, but JARVIS could not verify that its existing window was brought forward. ' + (focused.error || ''),
            evidence: { ...focused.evidence, appId: app.id, reusedExistingWindow: true },
          };
        }
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
          data: { appId: app.id, name: app.name, pid: existing.pid, status: 'Already running; existing window focused', windowPid: existing.pid, windowProcess: existing.processName, windowTitle: existing.title },
          evidence: { appId: app.id, pid: existing.pid, processName: existing.processName, existingWindowDetected: true, reusedExistingWindow: true, mechanism: 'unique existing window snapshot and verified foreground focus', timestamp: Date.now() },
        };
      }

      // Spawn process detached, WITHOUT shell: true (preventing shell injection attacks)
      const child = spawn(app.executable, [], {
        detached: true,
        stdio: 'ignore',
        shell: false,
        signal,
      });

      await new Promise<void>((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', reject);
      });
      child.unref();

      const pid = child.pid;
      if (!pid) {
        return {
          success: false,
          outcome: VerificationOutcome.VERIFIED_FAILURE,
          error: 'Failed to obtain process ID after spawn',
          evidence: { app: app.id },
        };
      }

      // Verification step: prefer a real window that appeared after the launch.
      const appWindow = await this.waitForAppWindow(app, knownPids, signal);
      if (appWindow) {
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
          data: { appId: app.id, name: app.name, pid, status: 'Running', windowPid: appWindow.pid, windowProcess: appWindow.processName, windowTitle: appWindow.title },
          evidence: { pid, processName: app.processName, newWindowDetected: true, windowPid: appWindow.pid, mechanism: 'window snapshot before/after launch', timestamp: Date.now() },
        };
      }
      // The app may reuse an already-open process/window. Only focus when exactly
      // one trusted window matches this allowlisted app identity.
      if (app.windowMatch) {
        try {
          const selection = selectUniqueExpectedAppWindow(await this.windows.snapshot(signal), app);
          if (selection.window) {
            const existingWindow = selection.window;
            const focused = await this.windows.focusWindow({ pid: existingWindow.pid }, signal);
            if (focused.success && focused.outcome === VerificationOutcome.VERIFIED_SUCCESS) {
              return {
                success: true,
                outcome: VerificationOutcome.VERIFIED_SUCCESS,
                data: {
                  appId: app.id,
                  name: app.name,
                  pid: existingWindow.pid,
                  status: 'Existing application window focused',
                  windowTitle: existingWindow.title,
                },
                evidence: {
                  existingWindowReused: true,
                  windowPid: existingWindow.pid,
                  windowProcess: existingWindow.processName,
                  mechanism: 'unique trusted app-window match + verified foreground focus',
                },
              };
            }
          } else if (selection.matchCount > 1) {
            return {
              success: true,
              outcome: VerificationOutcome.PARTIAL_SUCCESS,
              data: { appId: app.id, name: app.name, status: 'Launch requested; multiple existing windows matched' },
              evidence: { existingWindowReused: true, ambiguousWindowCount: selection.matchCount, focusAttempted: false },
              error: 'Multiple existing windows match this application; JARVIS did not choose one to focus.',
            };
          }
        } catch {
          // A failed snapshot/focus must not be treated as launch verification.
        }
      }

      // No uniquely verified usable window: a process check alone cannot prove
      // that the user-visible application is ready for input.
      await delay(300, undefined, { signal });
      const isRunning = await this.verifyProcessRunning(app.processName, pid, signal);

      if (isRunning) {
        return {
          success: true,
          outcome: VerificationOutcome.PARTIAL_SUCCESS,
          data: {
            appId: app.id,
            name: app.name,
            pid,
            status: 'Running',
          },
          evidence: {
            pid,
            processName: app.processName,
            verifiedViaTasklist: true,
            timestamp: Date.now(),
          },
        };
      } else {
        return {
          success: true,
          outcome: VerificationOutcome.PARTIAL_SUCCESS,
          data: {
            appId: app.id,
            pid,
            status: 'Spawned, but background process name differed or window was delayed',
          },
          evidence: { pid, processName: app.processName, verified: false },
        };
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        return {
          success: false,
          outcome: VerificationOutcome.UNCERTAIN,
          error: 'Application launch was interrupted; its final state requires reconciliation',
          evidence: { app: app.id },
          interrupted: true,
        };
      }
      return {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: 'Application launch failed; no verified success is reported.',
        evidence: { app: app.id, errorType: err instanceof Error ? err.name : 'UnknownError' },
      };
    }
  }

  /** Wait for a window of this app that did not exist before the launch. */
  private async waitForAppWindow(app: AllowlistedApp, knownPids: ReadonlySet<number>, signal?: AbortSignal): Promise<WindowInfo | undefined> {
    const match = app.windowMatch;
    if (!match) return undefined;
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if (signal?.aborted) return undefined;
      let windows: WindowInfo[];
      try { windows = await this.windows.snapshot(signal); } catch { return undefined; }
      const found = windows.find((window) =>
        !knownPids.has(window.pid) && matchesExpectedAppWindow(window, app));
      if (found) return found;
      await delay(400, undefined, { signal }).catch(() => undefined);
    }
    return undefined;
  }

  private isFinancialAppName(name: string): boolean {
    return /\b(phonepe|paytm|google\s*pay|gpay|paypal|wallet|banking|payment)\b/i.test(name);
  }

  private async launchDiscoveredStartMenuApp(query: string, signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      if (process.platform !== 'win32') throw new Error('Dynamic Start menu discovery is available only on Windows.');
      if (signal?.aborted) throw new Error('Application launch was cancelled.');
      const safeQuery = query.replace(/'/g, "''");
      const script = [
        '$ErrorActionPreference = "Stop"',
        "$q = '" + safeQuery + "'",
        '$all = @(Get-StartApps | Where-Object { $_.Name.IndexOf($q, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 } | Select-Object -First 30 Name, AppID)',
        '$all | ConvertTo-Json -Depth 3 -Compress',
      ].join('; ');
      const encoded = Buffer.from(script, 'utf16le').toString('base64');
      const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: 8_000, maxBuffer: 128 * 1024, windowsHide: true, signal,
      });
      const output = stdout.trim();
      const parsed = output ? JSON.parse(output) as Array<{ Name: string; AppID: string }> | { Name: string; AppID: string } : [];
      const candidates = (Array.isArray(parsed) ? parsed : [parsed]).filter((candidate) =>
        typeof candidate.Name === 'string' && typeof candidate.AppID === 'string' &&
        !this.isFinancialAppName(candidate.Name),
      );
      const exact = candidates.filter((candidate) => candidate.Name.toLowerCase() === query.toLowerCase());
      const matches = exact.length ? exact : candidates;
      if (matches.length === 0) {
        return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: "No installed Start menu application matched '" + query + "'.", evidence: { query, discovery: 'Get-StartApps', matches: 0 } };
      }
      if (matches.length !== 1) {
        return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: "Multiple applications matched '" + query + "'. Ask for the exact app name.", evidence: { query, candidates: matches.map((candidate) => candidate.Name) } };
      }
      const selected = matches[0];
      let knownPids = new Set<number>();
      try { knownPids = new Set((await this.windows.snapshot(signal)).map((window) => window.pid)); } catch { /* verification will be PARTIAL */ }
      await execFileAsync('explorer.exe', ['shell:AppsFolder\\' + selected.AppID], {
        timeout: 8_000, windowsHide: true, signal,
      });
      let newWindow: WindowInfo | undefined;
      const expectedIdentity = discoveredWindowIdentity(selected.Name);
      if (expectedIdentity) {
        const deadline = Date.now() + 8_000;
        while (Date.now() < deadline && !signal?.aborted) {
          try {
            const windows = await this.windows.snapshot(signal);
            newWindow = windows.find((window) =>
              !knownPids.has(window.pid) &&
              matchesExpectedAppWindow(window, { windowMatch: expectedIdentity }));
          } catch { newWindow = undefined; }
          if (newWindow) break;
          await delay(400, undefined, { signal }).catch(() => undefined);
        }
      } else {
        try { newWindow = await this.windows.waitForNewWindow(knownPids, undefined, 8_000, signal); } catch { newWindow = undefined; }
      }
      return discoveredLaunchResult(selected, newWindow, expectedIdentity);
    } catch (error) {
      return {
        success: false,
        outcome: signal?.aborted ? VerificationOutcome.UNCERTAIN : VerificationOutcome.VERIFIED_FAILURE,
        error: signal?.aborted
          ? 'Application launch was interrupted; reconcile the target state before retrying.'
          : 'Start-menu application launch failed; no verified success is reported.',
        evidence: { query, discovery: 'Get-StartApps', errorType: error instanceof Error ? error.name : 'UnknownError' },
        interrupted: signal?.aborted,
      };
    }
  }

  private async verifyProcessRunning(processName: string, pid?: number, signal?: AbortSignal): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('tasklist.exe', [
        '/FO',
        'CSV',
        '/NH',
        '/FI',
        `PID eq ${pid}`,
      ], { signal });
      return stdout.includes(String(pid));
    } catch {
      return false;
    }
  }
}
