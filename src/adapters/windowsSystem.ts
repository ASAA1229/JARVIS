import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class WindowsSystemAdapter {
  /**
   * Retrieves allowlisted OS facts.
   */
  public async getOsInfo(): Promise<ExecutionResult> {
    const data = {
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      uptimeSeconds: Math.floor(os.uptime()),
    };

    return {
      success: true,
      outcome: VerificationOutcome.VERIFIED_SUCCESS,
      data,
      evidence: { source: 'node:os', timestamp: Date.now() },
    };
  }

  /**
   * Retrieves system memory statistics.
   */
  public async getMemoryInfo(): Promise<ExecutionResult> {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;

    const data = {
      totalBytes: totalMem,
      freeBytes: freeMem,
      usedBytes: usedMem,
      usagePercent: Number(((usedMem / totalMem) * 100).toFixed(2)),
    };

    return {
      success: true,
      outcome: VerificationOutcome.VERIFIED_SUCCESS,
      data,
      evidence: { source: 'node:os:memory', timestamp: Date.now() },
    };
  }

  /**
   * Retrieves battery status via WMIC or PowerShell (read-only query).
   */
  public async getBatteryStatus(signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      // Execute powershell read-only query without shell interpolation
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-CimInstance -ClassName Win32_Battery | Select-Object -Property EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json',
      ], { signal });

      const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : null;
      return {
        success: true,
        outcome: VerificationOutcome.VERIFIED_SUCCESS,
        data: parsed || { status: 'No battery detected (Desktop or AC-only)' },
        evidence: { query: 'Win32_Battery', raw: parsed, timestamp: Date.now() },
      };
    } catch (err: unknown) {
      if (signal?.aborted) {
        return {
          success: false,
          outcome: VerificationOutcome.UNCERTAIN,
          error: 'Battery query was interrupted',
          evidence: { interrupted: true },
          interrupted: true,
        };
      }
      // Graceful fallback if battery query is unavailable
      return {
        success: true,
        outcome: VerificationOutcome.PARTIAL_SUCCESS,
        data: { message: 'Battery query unavailable or desktop AC power' },
        evidence: { error: String(err) },
      };
    }
  }

  /**
   * Retrieves disk space for the specified drive (defaults to C:).
   */
  public async getDiskSpace(drive: string = 'C:', signal?: AbortSignal): Promise<ExecutionResult> {
    // Sanitize drive input: only letters followed by colon
    if (!/^[a-zA-Z]:$/.test(drive)) {
      return {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: 'Invalid drive identifier',
        evidence: { providedDrive: drive },
      };
    }

    try {
      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='${drive}'" | Select-Object -Property Size, FreeSpace | ConvertTo-Json`,
      ], { signal });

      const parsed = JSON.parse(stdout.trim());
      const totalBytes = Number(parsed.Size);
      const freeBytes = Number(parsed.FreeSpace);
      const usedBytes = totalBytes - freeBytes;

      return {
        success: true,
        outcome: VerificationOutcome.VERIFIED_SUCCESS,
        data: {
          drive,
          totalBytes,
          freeBytes,
          usedBytes,
          freePercent: Number(((freeBytes / totalBytes) * 100).toFixed(2)),
        },
        evidence: { query: 'Win32_LogicalDisk', timestamp: Date.now() },
      };
    } catch (err: unknown) {
      return {
        success: false,
        outcome: VerificationOutcome.UNCERTAIN,
        error: signal?.aborted ? 'Disk query was interrupted' : `Failed to query disk space: ${String(err)}`,
        evidence: signal?.aborted ? { interrupted: true } : { error: String(err) },
        interrupted: signal?.aborted,
      };
    }
  }
}
