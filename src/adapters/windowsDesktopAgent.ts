import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import { LOCKED_DESKTOP_GUARD, WindowTarget, WindowsWindowManager, classifyPowerShellError, failureResult } from './windowsWindows.js';

// Per-call expected foreground process, carried through async calls so concurrent
// desktop actions cannot overwrite each other's target.
const expectedProcessStore = new AsyncLocalStorage<string | undefined>();

const execFileAsync = promisify(execFile);

export type DesktopAction =
  | { operation: 'desktop:type_text'; parameters: { text: string; expectProcess?: string } }
  | { operation: 'desktop:paste_text'; parameters: { text: string } }
  | { operation: 'desktop:hotkey'; parameters: { keys: string[] } }
  | { operation: 'desktop:zoom'; parameters: { direction: 'in' | 'out' | 'reset' } }
  | { operation: 'desktop:copy_selection'; parameters: Record<string, never> }
  | { operation: 'desktop:paste_clipboard'; parameters: Record<string, never> }
  | { operation: 'desktop:inspect_window'; parameters: { expectProcess?: string } }
  | { operation: 'desktop:read_control'; parameters: { name?: string; automationId?: string; expectProcess?: string } }
  | { operation: 'desktop:click_control'; parameters: { name?: string; automationId?: string; expectProcess?: string } }
  | { operation: 'desktop:set_value'; parameters: { name?: string; automationId?: string; text: string; expectProcess?: string } }
  | { operation: 'desktop:list_windows'; parameters: Record<string, never> }
  | { operation: 'desktop:focus_window'; parameters: WindowTarget };

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

export function buildForegroundFocusAssertionScript(): string {
  return "if ([JarvisForeground]::GetForegroundWindow() -ne $foregroundHwnd) { throw 'FOREGROUND_CHANGED' }";
}

function buildControlSelector(name?: string, automationId?: string): string {
  if (typeof automationId === 'string' && automationId.trim()) {
    return "$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty, '" + escapePowerShellSingleQuoted(automationId.trim()) + "')";
  }
  if (typeof name === 'string' && name.trim()) {
    return "$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '" + escapePowerShellSingleQuoted(name.trim()) + "')";
  }
  throw new Error('Specify a control name or automationId.');
}

function validateControlSelector(name?: unknown, automationId?: unknown): void {
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 120)) throw new Error('Control name must contain 1–120 characters.');
  if (automationId !== undefined && (typeof automationId !== 'string' || !/^[A-Za-z0-9_.:-]{1,160}$/.test(automationId))) throw new Error('automationId must contain 1–160 safe identifier characters.');
  if ((typeof automationId !== 'string' || !automationId.trim()) && (typeof name !== 'string' || !name.trim())) throw new Error('Specify a control name or automationId.');
}

export function buildReadControlScript(name?: string, automationId?: string): string {
  const selector = buildControlSelector(name, automationId);
  return [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    selector,
    '$root = [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHwnd)',
    '$matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)',
    'if ($matches.Count -ne 1) { throw "Control selector must resolve to exactly one control." }',
    '$element = $matches.Item(0)',
    '$name = $element.Current.Name',
    '$type = $element.Current.ControlType.ProgrammaticName',
    '$sensitive = $element.Current.IsPassword -or $name -match "(?i)password|passcode|pin|otp|one[- ]time password|recovery code|cvv|card number|credit card|debit card|card expiry|expiration date|bank account|account number|routing number|iban|swift code|sort code|security code"',
    '$value = $null',
    '$available = $false',
    'if (-not $sensitive) { $pattern = $null; if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { $value = [string]$pattern.Current.Value; $available = $true } }',
    '$result = @{ name = $name; controlType = $type; valueAvailable = $available; redacted = [bool]$sensitive; value = $(if ($sensitive) { "[REDACTED]" } elseif ($available) { $value } else { $null }) }',
    '$result | ConvertTo-Json -Compress -Depth 3',
  ].join('; ');
}

export function buildControlActionScript(
  operation: 'desktop:click_control' | 'desktop:set_value',
  name?: string,
  text?: string,
  automationId?: string,
): string {
  const selector = buildControlSelector(name, automationId);
  const base = [
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    selector,
    '$root = [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHwnd)',
  ];
  if (operation === 'desktop:click_control') {
    return [
      ...base,
      '$foundControls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)',
      'if ($foundControls.Count -ne 1) { throw "Control selector must resolve to exactly one control." }',
      '$element = $foundControls.Item(0)',
      '$pattern = $null',
      'if (-not $element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { throw "Control does not expose an Invoke action." }',
      '$pattern.Invoke()',
      '[Console]::Out.WriteLine("CONTROL_INVOKED")',
    ].join('; ');
  }
  if (typeof text !== 'string') throw new Error('A text value is required for desktop:set_value.');
  const safeText = escapePowerShellSingleQuoted(text);
  return [
    ...base,
    '$matches = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)',
    'if ($matches.Count -ne 1) { throw "Control name must resolve to exactly one control." }',
    '$element = $matches.Item(0)',
    '$actualName = $element.Current.Name',
    'if ($element.Current.IsPassword -or $actualName -match "(?i)password|passcode|pin|otp|one[- ]time password|recovery code|cvv|card number|credit card|debit card|card expiry|expiration date|bank account|account number|routing number|iban|swift code|sort code|security code") { throw "JARVIS policy blocks writing to credential or financial fields." }',
    '$pattern = $null',
    'if (-not $element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) { throw "Control does not expose a Value action." }',
    "$pattern.SetValue('" + safeText + "')",
    '$actual = $pattern.Current.Value',
    'if ($actual -cne ' + "'" + safeText + "'" + ') { throw "UI Automation value verification did not match." }',
    '[Console]::Out.WriteLine("VALUE_VERIFIED")',
  ].join('; ');
}

/**
 * Windows-side interaction adapter. It acts on the current foreground window
 * only. The caller must authorize each action through PolicyGateway first.
 */
export class WindowsDesktopAgent {
  private readonly windows = new WindowsWindowManager();

  public isSupportedHost(): boolean {
    return process.platform === 'win32';
  }

  private assertWindows(): void {
    if (!this.isSupportedHost()) throw new Error('Windows desktop agent can run only on Windows.');
  }

  private foregroundWindowGuard(expectProcess?: string): string {
    return [
      "$ErrorActionPreference = \"Stop\"",
      "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class JarvisForeground { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId); }' -ErrorAction SilentlyContinue",
      "$foregroundHwnd = [JarvisForeground]::GetForegroundWindow()",
      "if ($foregroundHwnd -eq [IntPtr]::Zero) { throw 'NO_FOREGROUND_WINDOW' }",
      "$foregroundPid = [uint32]0",
      "[void][JarvisForeground]::GetWindowThreadProcessId($foregroundHwnd, [ref]$foregroundPid)",
      "$foreground = Get-Process -Id $foregroundPid -ErrorAction Stop",
      "if (($foreground.ProcessName + ' ' + $foreground.MainWindowTitle) -match '(?i)phonepe|paytm|google\\s*pay|gpay|paypal|wallet|bank|payment') { throw 'JARVIS policy blocks interaction with financial/payment applications or windows.' }",
      LOCKED_DESKTOP_GUARD,
      ...(expectProcess ? ["if ($foreground.ProcessName -ne '" + expectProcess + "') { throw 'TARGET_MISMATCH' }"] : []),
    ].join('; ');
  }

  private async runPowerShell(script: string, signal?: AbortSignal): Promise<string> {
    this.assertWindows();
    const guardedScript = this.foregroundWindowGuard(expectedProcessStore.getStore()) + '; ' + script;
    const encoded = encodePowerShell(guardedScript);
    try {
      const result = await execFileAsync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
        { timeout: 10_000, maxBuffer: 64 * 1024, windowsHide: true, signal },
      );
      return result.stdout.trim();
    } catch (error) {
      // Strips the encoded script from the message and tags timeouts, locked
      // sessions, target mismatches and policy blocks with a machine-readable kind.
      throw classifyPowerShellError(error, signal);
    }
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
      buildForegroundFocusAssertionScript(),
      "$payload = '" + safeText + "'",
      '[System.Windows.Forms.Clipboard]::SetText($payload)',
      'Start-Sleep -Milliseconds 120',
      buildForegroundFocusAssertionScript(),
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

  /**
   * Public entry point. Window discovery and focus go to the window manager; every
   * other action acts on the foreground window and may be pinned to an expected
   * process (`expectProcess`) so input is never sent to the wrong application.
   */
  public async execute(action: DesktopAction, signal?: AbortSignal): Promise<ExecutionResult> {
    if (action.operation === 'desktop:list_windows') return this.windows.listWindows(signal);
    if (action.operation === 'desktop:focus_window') return this.windows.focusWindow(action.parameters, signal);
    const rawExpect = (action.parameters as { expectProcess?: unknown } | undefined)?.expectProcess;
    let expect: string | undefined;
    if (rawExpect !== undefined) {
      if (typeof rawExpect !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(rawExpect)) {
        return {
          success: false,
          outcome: VerificationOutcome.VERIFIED_FAILURE,
          error: 'expectProcess must be a plain process name.',
          failureKind: 'unsupported',
          evidence: { host: 'windows', operation: action.operation },
        };
      }
      expect = rawExpect.replace(/\.exe$/i, '');
    }
    return expectedProcessStore.run(expect, () => this.executeInner(action, signal));
  }

  private async executeInner(action: DesktopAction, signal?: AbortSignal): Promise<ExecutionResult> {
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
          buildForegroundFocusAssertionScript(),
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
          buildForegroundFocusAssertionScript(),
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

      if (action.operation === 'desktop:inspect_window') {
        const script = [
          'Add-Type -AssemblyName UIAutomationClient',
          'Add-Type -AssemblyName UIAutomationTypes',
          '$root = [System.Windows.Automation.AutomationElement]::FromHandle($foregroundHwnd)',
          'if ($null -eq $root) { throw "No foreground window is available." }',
          '$allControls = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)',
          '$items = New-Object System.Collections.Generic.List[object]',
          'for ($i = 0; $i -lt [Math]::Min($allControls.Count, 80); $i++) { $control = $allControls.Item($i); $items.Add(@{ name = $control.Current.Name; controlType = $control.Current.ControlType.ProgrammaticName; automationId = $control.Current.AutomationId }) }',
          '$result = @{ process = $foreground.ProcessName; windowTitle = $foreground.MainWindowTitle; controls = @($items) }',
          '$result | ConvertTo-Json -Depth 4 -Compress',
        ].join('; ');
        const output = await this.runPowerShell(script, signal);
        const parsed = JSON.parse(output) as { process: string; windowTitle: string; controls: Array<{ name: string; controlType: string; automationId: string }> };
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
          data: parsed,
          evidence: { host: 'windows', mechanism: 'Windows UI Automation control-tree inspection', controlsReported: parsed.controls.length },
        };
      }

      if (action.operation === 'desktop:read_control') {
        const { name, automationId } = action.parameters;
        validateControlSelector(name, automationId);
        const output = await this.runPowerShell(buildReadControlScript(name, automationId), signal);
        const parsed = JSON.parse(output) as { name: string; controlType: string; valueAvailable: boolean; redacted: boolean; value: string | null };
        return {
          success: true,
          outcome: VerificationOutcome.VERIFIED_SUCCESS,
          data: parsed,
          evidence: { host: 'windows', mechanism: 'UI Automation ValuePattern read', uniqueControlVerified: true, sensitiveValueRedacted: parsed.redacted, valueAvailable: parsed.valueAvailable },
        };
      }

      if (action.operation === 'desktop:click_control') {
        const { name, automationId } = action.parameters;
        validateControlSelector(name, automationId);
        const script = buildControlActionScript('desktop:click_control', name, undefined, automationId);
        const output = await this.runPowerShell(script, signal);
        const confirmed = output.includes('CONTROL_INVOKED');
        return {
          success: confirmed,
          outcome: confirmed ? VerificationOutcome.PARTIAL_SUCCESS : VerificationOutcome.VERIFIED_FAILURE,
          data: { controlName: name, automationId },
          evidence: { host: 'windows', mechanism: 'UI Automation InvokePattern', selector: automationId ? 'AutomationId' : 'Name', acknowledgement: confirmed },
          error: confirmed ? undefined : 'Control invocation was not acknowledged.',
        };
      }

      if (action.operation === 'desktop:set_value') {
        const { name, automationId, text } = action.parameters;
        validateControlSelector(name, automationId);
        this.validateText(text);
        const script = buildControlActionScript('desktop:set_value', name, text, automationId);
        const output = await this.runPowerShell(script, signal);
        const confirmed = output.includes('VALUE_VERIFIED');
        return {
          success: confirmed,
          outcome: confirmed ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.VERIFIED_FAILURE,
          data: { controlName: name, automationId, characters: text.length },
          evidence: { host: 'windows', mechanism: 'UI Automation ValuePattern', selector: automationId ? 'AutomationId' : 'Name', valueVerified: confirmed },
          error: confirmed ? undefined : 'The control value could not be verified.',
        };
      }

      if (action.operation === 'desktop:paste_clipboard') {
        const script = [
          '$ErrorActionPreference = "Stop"',
          'Add-Type -AssemblyName System.Windows.Forms',
          buildForegroundFocusAssertionScript(),
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
          '$before = [System.Windows.Forms.Clipboard]::GetText()',
          buildForegroundFocusAssertionScript(),
          '[System.Windows.Forms.SendKeys]::SendWait("^c")',
          'Start-Sleep -Milliseconds 250',
          '$clip = [System.Windows.Forms.Clipboard]::GetText()',
          'if ([string]::IsNullOrWhiteSpace($clip) -or $clip -eq $before) { [Console]::Out.WriteLine("COPY_UNVERIFIED") } else { [Console]::Out.WriteLine([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($clip))) }',
        ].join('; ');
        const output = await this.runPowerShell(script, signal);
        if (!output || output.includes('COPY_UNVERIFIED')) {
          return {
            success: false,
            outcome: VerificationOutcome.UNCERTAIN,
            error: 'No new non-empty selection was verified; JARVIS will not reuse possibly stale clipboard content.',
            evidence: { host: 'windows', mechanism: 'Ctrl+C + clipboard comparison', verified: false },
          };
        }
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
      // Input may already have been delivered when a timeout or cancellation hits, so
      // those cases are reported as UNCERTAIN rather than a clean failure.
      return failureResult(error, { operation: action.operation }, action.operation !== 'desktop:inspect_window', signal);
    }
  }
}
