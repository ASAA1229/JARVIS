import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecutionResult, VerificationOutcome } from '../core/types.js';

const execFileAsync = promisify(execFile);

export type DesktopAction =
  | { operation: 'desktop:type_text'; parameters: { text: string } }
  | { operation: 'desktop:paste_text'; parameters: { text: string } }
  | { operation: 'desktop:hotkey'; parameters: { keys: string[] } }
  | { operation: 'desktop:zoom'; parameters: { direction: 'in' | 'out' | 'reset' } }
  | { operation: 'desktop:copy_selection'; parameters: Record<string, never> }
  | { operation: 'desktop:paste_clipboard'; parameters: Record<string, never> };

const HOTKEYS: Record<string, string> = {
  CTRL: '^', ALT: '%', SHIFT: '+', ENTER: '{ENTER}', TAB: '{TAB}',
  ESC: '{ESC}', ESCAPE: '{ESC}', BACKSPACE: '{BACKSPACE}', DELETE: '{DELETE}',
  HOME: '{HOME}', END: '{END}', UP: '{UP}', DOWN: '{DOWN}', LEFT: '{LEFT}',
  RIGHT: '{RIGHT}', PAGEUP: '{PGUP}', PAGEDOWN: '{PGDN}', COPY: '^c',
  PASTE: '^v', SELECTALL: '^a', SAVE: '^s', FIND: '^f', NEW: '^n',
};

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function encodePowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/**
 * Windows-side interaction adapter. It acts on the current foreground window
 * only. The caller must authorize each action through PolicyGateway first.
 */
export class WindowsDesktopAgent {
  public isSupportedHost(): boolean {
    return process.platform === 'win32';
  }

  private assertWindows(): void {
    if (!this.isSupportedHost()) throw new Error('Windows desktop agent can run only on Windows.');
  }

  private foregroundWindowGuard(): string {
    return [
      "$ErrorActionPreference = \"Stop\"",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class JarvisForeground { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }' -ErrorAction SilentlyContinue",
      "$foregroundPid = [uint32]0",
      "[void][JarvisForeground]::GetWindowThreadProcessId([JarvisForeground]::GetForegroundWindow(), [ref]$foregroundPid)",
      "$foreground = Get-Process -Id $foregroundPid -ErrorAction Stop",
      "if ($foreground.ProcessName -match '(?i)phonepe|paytm|googlepay|gpay|paypal|wallet|bank|payment') { throw 'JARVIS policy blocks interaction with financial/payment applications.' }",
    ].join('; ');
  }

  private async runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
    this.assertWindows();
    const guardedScript = this.foregroundWindowGuard() + '; ' + script;
    const encoded = encodePowerShell(guardedScript);
    const result = await execFileAsync(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
      { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, signal },
    );
    return result.stdout.trim();
  }

  private validateText(text: unknown): asserts text is string {
    if (typeof text !== 'string' || text.length < 1 || text.length > 10_000) {
      throw new Error('Text must contain 1–10000 characters.');
    }
    if (text.includes('\u0000')) throw new Error('Text cannot contain NUL characters.');
  }

  private async pasteText(text: string, signal?: AbortSignal): Promise<ExecutionResult> {
    this.validateText(text);
    const safeText = escapePowerShellSingleQuoted(text);
    const script = [
      '$ErrorActionPreference = "Stop"',
      'Add-Type -AssemblyName System.Windows.Forms',
      "$payload = '" + safeText + "'",
      '[System.Windows.Forms.Clipboard]::SetText($payload)',
      'Start-Sleep -Milliseconds 120',
      '[System.Windows.Forms.SendKeys]::SendWait("^v")',
      'Start-Sleep -Milliseconds 180',
      '[Console]::Out.WriteLine("PASTE_SENT")',
    ].join('; ');
    const output = await this.runPowerShell(script, signal);
    const confirmed = output.includes('PASTE_SENT');
    return {
      success: confirmed,
      outcome: confirmed ? VerificationOutcome.PARTIAL_SUCCESS : VerificationOutcome.VERIFIED_FAILURE,
      data: { action: 'paste-text', characters: text.length },
      evidence: { host: 'windows', mechanism: 'PowerShell STA + SendKeys', acknowledgement: confirmed },
      error: confirmed ? undefined : 'Paste acknowledgement missing; destination content was not verified.',
    };
  }

  public async execute(action: DesktopAction, signal?: AbortSignal): Promise<ExecutionResult> {
    try {
      if (signal?.aborted) throw new Error('Desktop action cancelled before execution.');
      if (action.operation === 'desktop:type_text' || action.operation === 'desktop:paste_text') {
        return await this.pasteText(action.parameters.text, signal);
      }

      if (action.operation === 'desktop:hotkey') {
        const keys = action.parameters.keys;
        if (!Array.isArray(keys) || keys.length < 1 || keys.length > 3) {
          throw new Error('Hotkey must contain one to three allowlisted keys.');
        }
        const normalized = keys.map((key) => String(key).trim().toUpperCase());
        const sequence = normalized.map((key) => {
          const mapped = HOTKEYS[key];
          if (!mapped) throw new Error("Hotkey '" + key + "' is not allowlisted.");
          return mapped;
        }).join('');
        const script = [
          '$ErrorActionPreference = "Stop"',
          'Add-Type -AssemblyName System.Windows.Forms',
          "[System.Windows.Forms.SendKeys]::SendWait('" + escapePowerShellSingleQuoted(sequence) + "')",
          '[Console]::Out.WriteLine("HOTKEY_SENT")',
        ].join('; ');
        const output = await this.runPowerShell(script, signal);
        const confirmed = output.includes('HOTKEY_SENT');
        return {
          success: confirmed,
          outcome: VerificationOutcome.PARTIAL_SUCCESS,
          data: { action: 'hotkey', keys: normalized },
          evidence: { host: 'windows', acknowledgement: confirmed },
          error: confirmed ? undefined : 'Hotkey was not acknowledged.',
        };
      }

      if (action.operation === 'desktop:zoom') {
        const zoomKeys: Record<'in' | 'out' | 'reset', string> = { in: '^{ADD}', out: '^{SUBTRACT}', reset: '^0' };
        const sequence = zoomKeys[action.parameters.direction];
        const script = [
          '$ErrorActionPreference = "Stop"',
          'Add-Type -AssemblyName System.Windows.Forms',
          "[System.Windows.Forms.SendKeys]::SendWait('" + sequence + "')",
          '[Console]::Out.WriteLine("ZOOM_KEY_SENT")',
        ].join('; ');
        const output = await this.runPowerShell(script, signal);
        const confirmed = output.includes('ZOOM_KEY_SENT');
        return {
          success: confirmed,
          outcome: VerificationOutcome.PARTIAL_SUCCESS,
          data: { action: 'zoom', direction: action.parameters.direction },
          evidence: { host: 'windows', keySequence: sequence, acknowledgement: confirmed },
          error: confirmed ? undefined : 'Zoom key was not acknowledged; visual zoom level was not verified.',
        };
      }

      if (action.operation === 'desktop:paste_clipboard') {
        const script = [
          '$ErrorActionPreference = "Stop"',
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.SendKeys]::SendWait("^v")',
          '[Console]::Out.WriteLine("CLIPBOARD_PASTE_SENT")',
        ].join('; ');
        const output = await this.runPowerShell(script, signal);
        const confirmed = output.includes('CLIPBOARD_PASTE_SENT');
        return {
          success: confirmed,
          outcome: VerificationOutcome.PARTIAL_SUCCESS,
          data: { action: 'paste-clipboard' },
          evidence: { host: 'windows', acknowledgement: confirmed },
          error: confirmed ? undefined : 'Clipboard paste was not acknowledged; destination content was not verified.',
        };
      }

      if (action.operation === 'desktop:copy_selection') {
        const script = [
          '$ErrorActionPreference = "Stop"',
          'Add-Type -AssemblyName System.Windows.Forms',
          '[System.Windows.Forms.SendKeys]::SendWait("^c")',
          'Start-Sleep -Milliseconds 180',
          '$clip = [System.Windows.Forms.Clipboard]::GetText()',
          '[Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($clip)))',
        ].join('; ');
        const output = await this.runPowerShell(script, signal);
        const encoded = output.split(/\r?\n/).filter(Boolean).at(-1) || '';
        const text = Buffer.from(encoded, 'base64').toString('utf8');
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
          data: { text, characters: text.length },
          evidence: { host: 'windows', mechanism: 'Ctrl+C + Windows clipboard read', characters: text.length },
        };
      }

      return {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: 'Unsupported desktop action.',
        evidence: { operation: (action as { operation?: string }).operation },
      };
    } catch (error) {
      return {
        success: false,
        outcome: signal?.aborted ? VerificationOutcome.UNCERTAIN : VerificationOutcome.VERIFIED_FAILURE,
        error: error instanceof Error ? error.message : String(error),
        evidence: { host: 'windows', operation: action.operation },
        interrupted: signal?.aborted,
      };
    }
  }
}
