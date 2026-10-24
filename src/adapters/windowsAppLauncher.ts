import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const execFileAsync = promisify(execFile);

export interface AllowlistedApp {
  id: string;
  name: string;
  executable: string;
  processName: string;
}

export class WindowsAppLauncherAdapter {
  // Explicit allowlist of launchable applications
  private readonly allowlist: Map<string, AllowlistedApp> = new Map([
    [
      'notepad',
      {
        id: 'notepad',
        name: 'Notepad',
        executable: 'notepad.exe',
        processName: 'Notepad.exe',
      },
    ],
    [
      'calc',
      {
        id: 'calc',
        name: 'Calculator',
        executable: 'calc.exe',
        processName: 'CalculatorApp.exe',
      },
    ],
    [
      'mspaint',
      {
        id: 'mspaint',
        name: 'Paint',
        executable: 'mspaint.exe',
        processName: 'mspaint.exe',
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
   * Launches an allowlisted Windows application and captures evidence.
   */
  public async launchApp(appId: string, signal?: AbortSignal): Promise<ExecutionResult> {
    if (typeof appId !== 'string' || !appId.trim() || appId.trim().length > 120) {
      return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Application name must contain 1–120 characters.', evidence: { requestedApp: String(appId) } };
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

      // Verification step: verify running state via tasklist
      await delay(600, undefined, { signal });
      const isRunning = await this.verifyProcessRunning(app.processName, pid, signal);

      if (isRunning) {
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
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
        error: `Launch execution error: ${String(err)}`,
        evidence: { app: app.id, error: String(err) },
      };
    }
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
      await execFileAsync('explorer.exe', ['shell:AppsFolder\\' + selected.AppID], {
        timeout: 8_000, windowsHide: true, signal,
      });
      return {
        success: true,
        outcome: VerificationOutcome.PARTIAL_SUCCESS,
        data: { name: selected.Name, appId: selected.AppID, status: 'Launch requested' },
        evidence: { discovery: 'Get-StartApps', launcher: 'explorer.exe shell:AppsFolder', exactOrUniqueMatch: true, targetWindowVerified: false },
        error: 'Windows accepted the launch request, but the target application window was not independently verified.',
      };
    } catch (error) {
      return {
        success: false,
        outcome: signal?.aborted ? VerificationOutcome.UNCERTAIN : VerificationOutcome.VERIFIED_FAILURE,
        error: error instanceof Error ? error.message : String(error),
        evidence: { query, discovery: 'Get-StartApps' },
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
