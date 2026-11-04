import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ExecutionResult, FailureKind, VerificationOutcome } from '../core/types.js';

const execFileAsync = promisify(execFile);

/** Payment and financial software is excluded from general-purpose control. */
export const FINANCIAL_APP_PATTERN = /(phonepe|paytm|google\s*pay|gpay|paypal|wallet|bank|payment)/i;

/** Thrown by Windows adapters; carries a machine-readable failure kind. */
export class WindowsAgentError extends Error {
  public readonly kind?: FailureKind;
  constructor(kind: FailureKind | undefined, message: string) {
    super(message);
    this.name = 'WindowsAgentError';
    this.kind = kind;
  }
}

/**
 * Convert an execFile/PowerShell failure into a WindowsAgentError without leaking
 * the encoded script (execFile embeds the full command line in `error.message`).
 */
export function classifyPowerShellError(error: unknown, signal?: AbortSignal): WindowsAgentError {
  if (error instanceof WindowsAgentError) return error;
  if (signal?.aborted) return new WindowsAgentError('cancelled', 'The Windows operation was cancelled.');
  // Plain validation errors thrown by our own code (not by execFile) are safe to show.
  if (error instanceof Error && !('cmd' in error) && !('stderr' in error) && !('killed' in error)) {
    return new WindowsAgentError(undefined, error.message.slice(0, 200));
  }
  const candidate = error as { killed?: boolean; code?: string | number; stderr?: unknown; message?: unknown } | undefined;
  if (candidate?.killed === true || candidate?.code === 'ETIMEDOUT') {
    return new WindowsAgentError('timeout', 'The Windows operation timed out; its side effects are unknown.');
  }
  const stderr = typeof candidate?.stderr === 'string' ? candidate.stderr : '';
  const message = typeof candidate?.message === 'string' ? candidate.message : '';
  const haystack = stderr + ' ' + message;
  if (haystack.includes('DESKTOP_LOCKED')) {
    return new WindowsAgentError('locked_session', 'The Windows desktop is locked or disconnected; no action was taken.');
  }
  if (haystack.includes('TARGET_MISMATCH')) {
    return new WindowsAgentError('target_mismatch', 'The foreground window is not the intended application; no action was taken.');
  }
  if (haystack.includes('NO_WINDOW') || haystack.includes('Cannot find a process')) {
    return new WindowsAgentError('unavailable', 'The target application or window is not available.');
  }
  if (haystack.includes('policy blocks')) {
    const line = (stderr || message).split(/\r?\n/).find((entry) => entry.includes('policy blocks')) || 'Blocked by JARVIS policy.';
    return new WindowsAgentError('blocked', line.trim().slice(0, 200));
  }
  const firstLine = stderr.split(/\r?\n/).find((entry) => entry.trim()) || 'The Windows operation failed.';
  return new WindowsAgentError(undefined, firstLine.trim().slice(0, 200));
}

/**
 * Build a failure ExecutionResult. When side effects may already have happened
 * (timeout or cancellation after input was sent) the outcome is UNCERTAIN, not a
 * clean failure, so callers do not blindly retry and duplicate the action.
 */
export function failureResult(
  error: unknown,
  evidence: Record<string, unknown>,
  sideEffectsPossible: boolean,
  signal?: AbortSignal,
): ExecutionResult {
  const classified = classifyPowerShellError(error, signal);
  const uncertain = sideEffectsPossible && (classified.kind === 'timeout' || classified.kind === 'cancelled');
  return {
    success: false,
    outcome: uncertain ? VerificationOutcome.UNCERTAIN : VerificationOutcome.VERIFIED_FAILURE,
    error: classified.message,
    failureKind: classified.kind,
    interrupted: classified.kind === 'cancelled' ? true : undefined,
    evidence: { host: 'windows', ...evidence, ...(classified.kind ? { failureKind: classified.kind } : {}) },
  };
}

/** PowerShell prelude: refuse to act while the interactive desktop is locked. */
export const LOCKED_DESKTOP_GUARD =
  "if (Get-Process -Name LogonUI -ErrorAction SilentlyContinue) { throw 'DESKTOP_LOCKED' }";

export interface WindowInfo {
  pid: number;
  processName: string;
  title: string;
}

export interface WindowTarget {
  pid?: number;
  processName?: string;
  titleContains?: string;
}

function normalizeProcessName(value: string): string {
  return value.trim().toLowerCase().replace(/\.exe$/i, '');
}

export function windowMatches(window: WindowInfo, target: WindowTarget): boolean {
  if (target.pid !== undefined && window.pid !== target.pid) return false;
  if (target.processName !== undefined && normalizeProcessName(window.processName) !== normalizeProcessName(target.processName)) return false;
  if (target.titleContains !== undefined && !window.title.toLowerCase().includes(target.titleContains.toLowerCase())) return false;
  return true;
}

/** Validate a user/planner-supplied window target. Returns an error string or undefined. */
export function validateWindowTarget(target: unknown): string | undefined {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return 'Window target must be an object.';
  const candidate = target as Record<string, unknown>;
  const allowedKeys = new Set(['pid', 'processName', 'titleContains']);
  for (const key of Object.keys(candidate)) if (!allowedKeys.has(key)) return `Unsupported window target field '${key}'.`;
  if (candidate.pid !== undefined && (!Number.isInteger(candidate.pid) || (candidate.pid as number) < 1)) return 'pid must be a positive integer.';
  if (candidate.processName !== undefined && (typeof candidate.processName !== 'string' || !/^[A-Za-z0-9._ -]{1,64}$/.test(candidate.processName))) return 'processName contains unsupported characters.';
  if (candidate.titleContains !== undefined && (typeof candidate.titleContains !== 'string' || candidate.titleContains.trim().length < 1 || candidate.titleContains.length > 80)) return 'titleContains must contain 1-80 characters.';
  if (candidate.pid === undefined && candidate.processName === undefined && candidate.titleContains === undefined) return 'Specify processName and/or titleContains.';
  return undefined;
}

/**
 * Discovers and focuses top-level windows using Win32/.NET process APIs. It never
 * sends input to a window; input is the desktop agent's job and is always gated
 * by the PolicyGateway before either module is called.
 */
export class WindowsWindowManager {
  public isSupportedHost(): boolean {
    return process.platform === 'win32';
  }

  private async runPowerShell(script: string, signal?: AbortSignal, timeoutMs = 8_000): Promise<string> {
    if (!this.isSupportedHost()) throw new WindowsAgentError('unsupported', 'Window management is available only on Windows.');
    const guarded = '$ErrorActionPreference = "Stop"; ' + LOCKED_DESKTOP_GUARD + '; ' + script;
    const encoded = Buffer.from(guarded, 'utf16le').toString('base64');
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { timeout: timeoutMs, maxBuffer: 256 * 1024, windowsHide: true, signal },
      );
      return stdout.trim();
    } catch (error) {
      throw classifyPowerShellError(error, signal);
    }
  }

  /** Visible top-level windows with titles, excluding financial applications. */
  public async snapshot(signal?: AbortSignal): Promise<WindowInfo[]> {
    const script = [
      '$items = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | Select-Object -First 80 Id, ProcessName, MainWindowTitle)',
      'ConvertTo-Json -InputObject $items -Compress -Depth 3',
    ].join('; ');
    const output = await this.runPowerShell(script, signal);
    if (!output) return [];
    const parsed = JSON.parse(output) as unknown;
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const windows: WindowInfo[] = [];
    for (const row of rows) {
      const item = row as { Id?: unknown; ProcessName?: unknown; MainWindowTitle?: unknown };
      if (typeof item?.Id !== 'number' || typeof item.ProcessName !== 'string' || typeof item.MainWindowTitle !== 'string') continue;
      if (FINANCIAL_APP_PATTERN.test(item.ProcessName + ' ' + item.MainWindowTitle)) continue;
      windows.push({ pid: item.Id, processName: item.ProcessName, title: item.MainWindowTitle.slice(0, 120) });
    }
    return windows;
  }

  public async listWindows(signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      const windows = await this.snapshot(signal);
      return {
        success: true,
        outcome: VerificationOutcome.VERIFIED_SUCCESS,
        data: { windows },
        evidence: { host: 'windows', mechanism: 'Get-Process main-window enumeration', windowCount: windows.length, financialWindowsExcluded: true },
      };
    } catch (error) {
      return failureResult(error, { operation: 'desktop:list_windows' }, false, signal);
    }
  }

  /** Windows that match a target, from a fresh snapshot. */
  public async findWindows(target: WindowTarget, signal?: AbortSignal): Promise<WindowInfo[]> {
    return (await this.snapshot(signal)).filter((window) => windowMatches(window, target));
  }

  /**
   * Poll for a window that did not exist before an action (optionally matching a
   * target). Returns undefined on timeout; throws only for lock/cancel/host errors.
   */
  public async waitForNewWindow(
    knownPids: ReadonlySet<number>,
    target: WindowTarget | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WindowInfo | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new WindowsAgentError('cancelled', 'Window wait was cancelled.');
      const windows = await this.snapshot(signal);
      const fresh = windows.find((window) => !knownPids.has(window.pid) && (!target || windowMatches(window, target)));
      if (fresh) return fresh;
      await delay(400, undefined, { signal }).catch(() => undefined);
    }
    return undefined;
  }

  /**
   * Bring exactly one matching window to the foreground and verify that Windows
   * actually granted foreground focus to that process.
   */
  public async focusWindow(target: WindowTarget, signal?: AbortSignal): Promise<ExecutionResult> {
    const invalid = validateWindowTarget(target);
    if (invalid) {
      return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: invalid, failureKind: 'unsupported', evidence: { host: 'windows', operation: 'desktop:focus_window' } };
    }
    try {
      const matches = await this.findWindows(target, signal);
      if (matches.length === 0) {
        return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'No matching application window is open.', failureKind: 'unavailable', evidence: { host: 'windows', operation: 'desktop:focus_window', matches: 0 } };
      }
      if (matches.length > 1) {
        return {
          success: false,
          outcome: VerificationOutcome.VERIFIED_FAILURE,
          error: `${matches.length} windows matched; name the window more precisely so JARVIS does not act on the wrong one.`,
          failureKind: 'target_mismatch',
          evidence: { host: 'windows', operation: 'desktop:focus_window', matches: matches.length, candidates: matches.slice(0, 8).map((window) => `${window.processName}: ${window.title}`) },
        };
      }
      const window = matches[0];
      const script = [
        "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class JarvisFocus { [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr h); [DllImport(\"user32.dll\")] public static extern bool ShowWindowAsync(IntPtr h, int cmd); [DllImport(\"user32.dll\")] public static extern bool IsIconic(IntPtr h); [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }' -ErrorAction SilentlyContinue",
        `$p = Get-Process -Id ${window.pid} -ErrorAction Stop`,
        '$h = $p.MainWindowHandle',
        "if ($h -eq [IntPtr]::Zero) { throw 'NO_WINDOW' }",
        'if ([JarvisFocus]::IsIconic($h)) { [void][JarvisFocus]::ShowWindowAsync($h, 9) }',
        '[void][JarvisFocus]::SetForegroundWindow($h)',
        'Start-Sleep -Milliseconds 350',
        '$fp = [uint32]0',
        '[void][JarvisFocus]::GetWindowThreadProcessId([JarvisFocus]::GetForegroundWindow(), [ref]$fp)',
        '[Console]::Out.WriteLine("FOREGROUND_PID=" + $fp)',
      ].join('; ');
      const output = await this.runPowerShell(script, signal);
      const match = output.match(/FOREGROUND_PID=(\d+)/);
      const foregroundPid = match ? Number(match[1]) : NaN;
      if (foregroundPid === window.pid) {
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
          data: { pid: window.pid, processName: window.processName, title: window.title },
          evidence: { host: 'windows', mechanism: 'SetForegroundWindow + GetForegroundWindow readback', foregroundPidVerified: true },
        };
      }
      return {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: 'Windows did not grant foreground focus to that window (another window may have focus-lock). No input was sent.',
        failureKind: 'unavailable',
        evidence: { host: 'windows', operation: 'desktop:focus_window', foregroundPidVerified: false },
      };
    } catch (error) {
      return failureResult(error, { operation: 'desktop:focus_window' }, false, signal);
    }
  }
}
