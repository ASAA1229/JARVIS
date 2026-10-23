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
    const app = this.allowlist.get(appId.toLowerCase());

    if (!app) {
      return {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: `Application '${appId}' is not in the allowlist`,
        evidence: { requestedApp: appId },
      };
    }

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
