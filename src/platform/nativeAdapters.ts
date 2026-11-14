/**
 * macOS and Linux desktop adapters (JARVIS-GAP-019/020).
 *
 * STATUS: IMPLEMENTED - NOT TESTED on real hardware. Command construction, argument
 * handling and failure paths are unit-tested with a mocked process runner only. No
 * macOS or Linux machine was available, so real permission prompts, Wayland
 * behavior and OS-version drift are unverified and need physical acceptance.
 *
 * Safety rules shared by both adapters:
 *  - commands run through an argv-array runner, never a shell, so user text can
 *    never be interpreted as shell syntax; values are additionally validated;
 *  - missing tools, denied permissions, timeouts and unsupported sessions return a
 *    VERIFIED_FAILURE naming the cause, never a success;
 *  - a launch is only PARTIAL_SUCCESS (the OS accepted it); focus is VERIFIED only
 *    after an independent read-back of the frontmost window.
 */
import { VerificationOutcome, type ExecutionResult } from '../core/types.js';
import type { DesktopPlatformAdapter, PlatformAdapterInfo, PlatformOperation } from './platformAdapters.js';

export interface RunResult { code: number | null; stdout: string; stderr: string; error?: 'ENOENT' | 'TIMEOUT' | 'FAILED' }
/** argv-array process runner; injected so tests can assert exact commands. */
export type ProcessRunner = (command: string, args: readonly string[], options: { timeoutMs: number; signal?: AbortSignal }) => Promise<RunResult>;

const APP_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+()-]{0,79}$/;
const DESKTOP_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TITLE = /^[^\u0000-\u001f]{1,120}$/;
const TIMEOUT_MS = 10_000;

const failure = (error: string, evidence: Record<string, unknown> = {}): ExecutionResult => ({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error, evidence: { attempted: true, ...evidence } });
const rejected = (error: string): ExecutionResult => ({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error, evidence: { attempted: false } });

function explain(tool: string, result: RunResult): string | undefined {
  if (result.error === 'ENOENT') return `${tool} is not installed or not on PATH; the operation was not performed.`;
  if (result.error === 'TIMEOUT') return `${tool} did not respond within the time limit and was stopped.`;
  if (result.error === 'FAILED' || (result.code !== 0 && result.code !== null)) return `${tool} failed (exit ${result.code}).`;
  return undefined;
}

/** Real runner using execFile semantics (no shell). */
export const defaultProcessRunner: ProcessRunner = async (command, args, { timeoutMs, signal }) => {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, signal, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve({ code: 0, stdout, stderr });
      const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: string | number };
      if (e.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '', error: 'ENOENT' });
      if (e.killed) return resolve({ code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: 'TIMEOUT' });
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: stdout ?? '', stderr: stderr ?? '', error: 'FAILED' });
    });
  });
};

/* ------------------------------------------------------------------ macOS */

/** JXA scripts receive user values through argv (run(argv)); values are never interpolated into script text. */
export const MACOS_SCRIPTS = {
  accessibilityTrusted: "ObjC.import('ApplicationServices'); $.AXIsProcessTrusted() ? 'trusted' : 'untrusted'",
  listWindows: "function run(argv){const se=Application('System Events');const out=[];se.processes.whose({visible:true})().forEach(p=>{try{p.windows().forEach(w=>out.push(p.name()+'\\t'+w.name()))}catch(e){}});return out.join('\\n')}",
  focusProcess: "function run(argv){const se=Application('System Events');const p=se.processes.byName(argv[0]);p.frontmost=true;return 'ok'}",
  frontmostProcess: "function run(argv){return Application('System Events').processes.whose({frontmost:true})()[0].name()}",
} as const;

export class MacOSAdapter implements DesktopPlatformAdapter {
  constructor(private readonly run: ProcessRunner = defaultProcessRunner) {}

  describe(): PlatformAdapterInfo {
    return {
      platform: 'macos', implemented: true, hardwareVerified: false,
      supportedOperations: ['app:launch', 'desktop:list_windows', 'desktop:focus_window', 'system:get_info'],
      blockers: ['Physical macOS acceptance (TCC Accessibility/Automation prompts, OS-version drift)'],
    };
  }

  private osascript(script: string, args: readonly string[] = [], signal?: AbortSignal) {
    return this.run('osascript', ['-l', 'JavaScript', '-e', script, ...(args.length ? ['--', ...args] : [])], { timeoutMs: TIMEOUT_MS, signal });
  }

  /** Accessibility permission gate for UI scripting operations. */
  private async accessibilityGate(signal?: AbortSignal): Promise<ExecutionResult | undefined> {
    const check = await this.osascript(MACOS_SCRIPTS.accessibilityTrusted, [], signal);
    const problem = explain('osascript', check);
    if (problem) return failure(problem);
    if (check.stdout.trim() !== 'trusted') {
      return failure('macOS Accessibility permission is not granted to the JARVIS host process. Grant it in System Settings > Privacy & Security > Accessibility; no UI operation was performed.', { permission: 'accessibility', granted: false });
    }
    return undefined;
  }

  async execute(operation: PlatformOperation, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    switch (operation) {
      case 'app:launch': {
        const name = parameters.appName;
        if (typeof name !== 'string' || !APP_NAME.test(name)) return rejected('appName must be 1-80 plain characters (letters, digits, spaces and . _ + ( ) -).');
        const result = await this.run('open', ['-a', name], { timeoutMs: TIMEOUT_MS, signal });
        const problem = explain('open', result);
        if (problem) return failure(problem.includes('failed') ? `macOS could not open "${name}" (is it installed?).` : problem, { appName: name });
        return { success: true, outcome: VerificationOutcome.PARTIAL_SUCCESS, data: { appName: name, status: 'Launch requested' }, error: 'macOS accepted the launch request; no independent window verification was performed.', evidence: { command: 'open -a', appName: name } };
      }
      case 'desktop:list_windows': {
        const gate = await this.accessibilityGate(signal);
        if (gate) return gate;
        const result = await this.osascript(MACOS_SCRIPTS.listWindows, [], signal);
        const problem = explain('osascript', result);
        if (problem) return failure(problem);
        const windows = result.stdout.split('\n').filter(Boolean).slice(0, 200).map((line) => { const [process, ...title] = line.split('\t'); return { process, title: title.join('\t') }; });
        return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { windows }, evidence: { count: windows.length } };
      }
      case 'desktop:focus_window': {
        const process = parameters.processName;
        if (typeof process !== 'string' || !APP_NAME.test(process)) return rejected('processName must be 1-80 plain characters.');
        const gate = await this.accessibilityGate(signal);
        if (gate) return gate;
        const focus = await this.osascript(MACOS_SCRIPTS.focusProcess, [process], signal);
        const problem = explain('osascript', focus);
        if (problem) return failure(problem, { processName: process });
        const front = await this.osascript(MACOS_SCRIPTS.frontmostProcess, [], signal);
        if (explain('osascript', front) || front.stdout.trim() !== process) {
          return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'Focus was requested but the frontmost application could not be confirmed.', evidence: { processName: process, frontmost: front.stdout.trim() || null } };
        }
        return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { processName: process }, evidence: { frontmost: process } };
      }
      case 'system:get_info': {
        const version = await this.run('sw_vers', ['-productVersion'], { timeoutMs: TIMEOUT_MS, signal });
        const arch = await this.run('uname', ['-m'], { timeoutMs: TIMEOUT_MS, signal });
        const problem = explain('sw_vers', version) ?? explain('uname', arch);
        if (problem) return failure(problem);
        return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { platform: 'macos', version: version.stdout.trim(), arch: arch.stdout.trim() }, evidence: { source: 'sw_vers, uname' } };
      }
      default:
        return rejected(`Operation ${String(operation)} is not supported by the macOS adapter.`);
    }
  }
}

/* ------------------------------------------------------------------ Linux */

export type LinuxSession = 'x11' | 'wayland' | 'unknown';

export class LinuxAdapter implements DesktopPlatformAdapter {
  constructor(
    private readonly run: ProcessRunner = defaultProcessRunner,
    private readonly env: Record<string, string | undefined> = process.env,
  ) {}

  session(): LinuxSession {
    const type = (this.env.XDG_SESSION_TYPE ?? '').toLowerCase();
    if (type === 'wayland' || this.env.WAYLAND_DISPLAY) return 'wayland';
    if (type === 'x11' || this.env.DISPLAY) return 'x11';
    return 'unknown';
  }

  describe(): PlatformAdapterInfo {
    return {
      platform: 'linux', implemented: true, hardwareVerified: false,
      supportedOperations: ['app:launch', 'desktop:list_windows', 'desktop:focus_window', 'system:get_info'],
      blockers: [
        'Physical acceptance per distribution/desktop environment',
        'Wayland window listing/focus needs the XDG desktop portal or compositor-specific APIs (not implemented; X11 via wmctrl/xdotool only)',
      ],
    };
  }

  private x11Gate(): ExecutionResult | undefined {
    const session = this.session();
    if (session === 'wayland') return failure('Window listing and focus are not available in a Wayland session with wmctrl/xdotool; the XDG desktop portal path is not implemented. No operation was performed.', { session, attempted: false });
    if (session === 'unknown') return failure('No graphical session was detected (DISPLAY / XDG_SESSION_TYPE are unset); no operation was performed.', { session, attempted: false });
    return undefined;
  }

  async execute(operation: PlatformOperation, parameters: Record<string, unknown>, signal?: AbortSignal): Promise<ExecutionResult> {
    switch (operation) {
      case 'app:launch': {
        const id = parameters.desktopId;
        if (typeof id !== 'string' || !DESKTOP_ID.test(id)) return rejected('desktopId must be a .desktop application id (letters, digits, . _ -).');
        const result = await this.run('gtk-launch', [id], { timeoutMs: TIMEOUT_MS, signal });
        const problem = explain('gtk-launch', result);
        if (problem) return failure(problem.includes('failed') ? `Could not launch "${id}" (is the .desktop entry installed?).` : problem, { desktopId: id });
        return { success: true, outcome: VerificationOutcome.PARTIAL_SUCCESS, data: { desktopId: id, status: 'Launch requested' }, error: 'The launcher accepted the request; no independent window verification was performed.', evidence: { command: 'gtk-launch', desktopId: id } };
      }
      case 'desktop:list_windows': {
        const gate = this.x11Gate();
        if (gate) return gate;
        const result = await this.run('wmctrl', ['-l'], { timeoutMs: TIMEOUT_MS, signal });
        const problem = explain('wmctrl', result);
        if (problem) return failure(problem);
        const windows = result.stdout.split('\n').filter(Boolean).slice(0, 200).map((line) => { const parts = line.split(/\s+/); return { id: parts[0], title: line.split(/\s+/).slice(3).join(' ') }; });
        return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { windows }, evidence: { count: windows.length } };
      }
      case 'desktop:focus_window': {
        const title = parameters.titleContains;
        if (typeof title !== 'string' || !TITLE.test(title)) return rejected('titleContains must be 1-120 printable characters.');
        const gate = this.x11Gate();
        if (gate) return gate;
        const focus = await this.run('wmctrl', ['-a', title], { timeoutMs: TIMEOUT_MS, signal });
        const problem = explain('wmctrl', focus);
        if (problem) return failure(problem, { titleContains: title });
        const active = await this.run('xdotool', ['getactivewindow', 'getwindowname'], { timeoutMs: TIMEOUT_MS, signal });
        const name = active.stdout.trim();
        if (explain('xdotool', active) || !name.toLowerCase().includes(title.toLowerCase())) {
          return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'Focus was requested but the active window could not be confirmed.', evidence: { titleContains: title, activeWindow: name || null } };
        }
        return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { activeWindow: name }, evidence: { activeWindow: name } };
      }
      case 'system:get_info': {
        const kernel = await this.run('uname', ['-srm'], { timeoutMs: TIMEOUT_MS, signal });
        const problem = explain('uname', kernel);
        if (problem) return failure(problem);
        return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { platform: 'linux', kernel: kernel.stdout.trim(), session: this.session() }, evidence: { source: 'uname -srm' } };
      }
      default:
        return rejected(`Operation ${String(operation)} is not supported by the Linux adapter.`);
    }
  }
}
