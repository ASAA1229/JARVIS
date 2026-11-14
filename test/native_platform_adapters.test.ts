import test from 'node:test';
import assert from 'node:assert/strict';
import { VerificationOutcome } from '../src/core/types.js';
import { LinuxAdapter, MacOSAdapter, MACOS_SCRIPTS, defaultProcessRunner, type ProcessRunner, type RunResult } from '../src/platform/nativeAdapters.js';
import { selectPlatformAdapter } from '../src/platform/platformAdapters.js';

/**
 * JARVIS-GAP-019/020. IMPLEMENTED - NOT TESTED on real macOS/Linux hardware: these tests use a
 * mocked process runner and assert exact command construction, argument handling and failures.
 */
type Call = { command: string; args: string[] };
function mock(script: Array<RunResult | ((call: Call) => RunResult)>): { run: ProcessRunner; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  return {
    calls,
    run: async (command, args) => {
      const call = { command, args: [...args] };
      calls.push(call);
      const next = script[Math.min(i++, script.length - 1)];
      return typeof next === 'function' ? next(call) : next;
    },
  };
}
const ok = (stdout = ''): RunResult => ({ code: 0, stdout, stderr: '' });
const missing: RunResult = { code: null, stdout: '', stderr: '', error: 'ENOENT' };
const timeout: RunResult = { code: null, stdout: '', stderr: '', error: 'TIMEOUT' };
const crashed: RunResult = { code: 1, stdout: '', stderr: 'boom /Users/secret', error: 'FAILED' };

test('macOS app:launch builds exactly `open -a <name>` as an argv array and reports PARTIAL (launch is not verified)', async () => {
  const m = mock([ok()]);
  const result = await new MacOSAdapter(m.run).execute('app:launch', { appName: 'Visual Studio Code' });
  assert.deepEqual(m.calls, [{ command: 'open', args: ['-a', 'Visual Studio Code'] }]);
  assert.equal(result.success, true);
  assert.equal(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
});

test('macOS rejects hostile app names before any process is started (no shell, no injection surface)', async () => {
  for (const name of ['Safari; rm -rf /', '$(whoami)', '`id`', 'a|b', 'a&b', "x'y", 'x"y', '../../bin/sh', '-a evil', 'new\nline', '', 'x'.repeat(81), 42, undefined]) {
    const m = mock([ok()]);
    const result = await new MacOSAdapter(m.run).execute('app:launch', { appName: name });
    assert.equal(result.success, false, String(name));
    assert.equal((result.evidence as { attempted: boolean }).attempted, false);
    assert.equal(m.calls.length, 0, `process started for ${JSON.stringify(name)}`);
  }
});

test('macOS list_windows checks Accessibility permission first and uses the exact JXA invocations', async () => {
  const m = mock([ok('trusted\n'), ok('Finder\tDesktop\nSafari\tApple\tPage')]);
  const result = await new MacOSAdapter(m.run).execute('desktop:list_windows', {});
  assert.deepEqual(m.calls[0], { command: 'osascript', args: ['-l', 'JavaScript', '-e', MACOS_SCRIPTS.accessibilityTrusted] });
  assert.deepEqual(m.calls[1], { command: 'osascript', args: ['-l', 'JavaScript', '-e', MACOS_SCRIPTS.listWindows] });
  assert.deepEqual((result.data as { windows: unknown[] }).windows, [{ process: 'Finder', title: 'Desktop' }, { process: 'Safari', title: 'Apple\tPage' }]);
  assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
});

test('macOS denied Accessibility permission fails closed with guidance and runs no UI script', async () => {
  for (const operation of ['desktop:list_windows', 'desktop:focus_window'] as const) {
    const m = mock([ok('untrusted')]);
    const result = await new MacOSAdapter(m.run).execute(operation, { processName: 'Safari' });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Accessibility permission is not granted/);
    assert.equal(m.calls.length, 1, 'only the permission probe ran');
  }
});

test('macOS focus passes the process name via argv (never interpolated into script text) and verifies frontmost', async () => {
  const evil = "Safari'); do shell script 'id";
  assert.equal((await new MacOSAdapter(mock([ok()]).run).execute('desktop:focus_window', { processName: evil })).success, false);
  const m = mock([ok('trusted'), ok('ok'), ok('Safari\n')]);
  const result = await new MacOSAdapter(m.run).execute('desktop:focus_window', { processName: 'Safari' });
  assert.deepEqual(m.calls[1], { command: 'osascript', args: ['-l', 'JavaScript', '-e', MACOS_SCRIPTS.focusProcess, '--', 'Safari'] });
  assert.ok(!MACOS_SCRIPTS.focusProcess.includes('Safari'));
  assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
  const wrongFront = mock([ok('trusted'), ok('ok'), ok('Terminal')]);
  const partial = await new MacOSAdapter(wrongFront.run).execute('desktop:focus_window', { processName: 'Safari' });
  assert.equal(partial.success, false);
  assert.equal(partial.outcome, VerificationOutcome.PARTIAL_SUCCESS);
});

test('macOS tool absence, timeouts and crashes become safe failures without raw stderr', async () => {
  for (const [bad, pattern] of [[missing, /not installed or not on PATH/], [timeout, /time limit/], [crashed, /could not open|failed/]] as const) {
    const result = await new MacOSAdapter(mock([bad]).run).execute('app:launch', { appName: 'Safari' });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', pattern);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
  }
  const info = await new MacOSAdapter(mock([ok('14.5\n'), ok('arm64\n')]).run).execute('system:get_info', {});
  assert.deepEqual(info.data, { platform: 'macos', version: '14.5', arch: 'arm64' });
  assert.equal((await new MacOSAdapter(mock([missing]).run).execute('system:get_info', {})).success, false);
  assert.equal((await new MacOSAdapter(mock([ok()]).run).execute('terminal:run' as never, {})).success, false);
});

test('Linux app:launch builds exactly `gtk-launch <id>` and validates the desktop id', async () => {
  const m = mock([ok()]);
  const result = await new LinuxAdapter(m.run, {}).execute('app:launch', { desktopId: 'org.gnome.Calculator' });
  assert.deepEqual(m.calls, [{ command: 'gtk-launch', args: ['org.gnome.Calculator'] }]);
  assert.equal(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
  for (const id of ['calc; reboot', '$(id)', '../x', '-evil', 'a b', '', 'x'.repeat(101), 7]) {
    const bad = mock([ok()]);
    assert.equal((await new LinuxAdapter(bad.run, {}).execute('app:launch', { desktopId: id })).success, false);
    assert.equal(bad.calls.length, 0, JSON.stringify(id));
  }
});

test('Linux X11 list/focus use exact wmctrl/xdotool argv and verify the active window', async () => {
  const env = { XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' };
  const list = mock([ok('0x01  0 host Terminal\n0x02  0 host Web Browser')]);
  const listed = await new LinuxAdapter(list.run, env).execute('desktop:list_windows', {});
  assert.deepEqual(list.calls, [{ command: 'wmctrl', args: ['-l'] }]);
  assert.deepEqual((listed.data as { windows: unknown[] }).windows, [{ id: '0x01', title: 'Terminal' }, { id: '0x02', title: 'Web Browser' }]);

  const focus = mock([ok(), ok('Mozilla Firefox\n')]);
  const focused = await new LinuxAdapter(focus.run, env).execute('desktop:focus_window', { titleContains: 'firefox' });
  assert.deepEqual(focus.calls, [{ command: 'wmctrl', args: ['-a', 'firefox'] }, { command: 'xdotool', args: ['getactivewindow', 'getwindowname'] }]);
  assert.equal(focused.outcome, VerificationOutcome.VERIFIED_SUCCESS);
  const unconfirmed = await new LinuxAdapter(mock([ok(), ok('Other App')]).run, env).execute('desktop:focus_window', { titleContains: 'firefox' });
  assert.equal(unconfirmed.outcome, VerificationOutcome.PARTIAL_SUCCESS);
  const hostile = mock([ok()]);
  assert.equal((await new LinuxAdapter(hostile.run, env).execute('desktop:focus_window', { titleContains: 'a\u0000b' })).success, false);
  assert.equal(hostile.calls.length, 0);
});

test('Linux Wayland and headless sessions fail closed for window operations and run nothing', async () => {
  for (const env of [{ XDG_SESSION_TYPE: 'wayland' }, { WAYLAND_DISPLAY: 'wayland-0' }, {}]) {
    for (const operation of ['desktop:list_windows', 'desktop:focus_window'] as const) {
      const m = mock([ok()]);
      const result = await new LinuxAdapter(m.run, env).execute(operation, { titleContains: 'x' });
      assert.equal(result.success, false);
      assert.match(result.error ?? '', /Wayland|No graphical session/);
      assert.equal(m.calls.length, 0);
    }
  }
  assert.equal(new LinuxAdapter(mock([ok()]).run, { XDG_SESSION_TYPE: 'wayland' }).session(), 'wayland');
});

test('Linux missing wmctrl/xdotool/gtk-launch and timeouts yield clear safe errors', async () => {
  const env = { DISPLAY: ':0' };
  assert.match((await new LinuxAdapter(mock([missing]).run, env).execute('desktop:list_windows', {})).error ?? '', /wmctrl is not installed/);
  assert.match((await new LinuxAdapter(mock([missing]).run, env).execute('app:launch', { desktopId: 'x' })).error ?? '', /gtk-launch is not installed/);
  assert.match((await new LinuxAdapter(mock([timeout]).run, env).execute('desktop:list_windows', {})).error ?? '', /time limit/);
  assert.equal((await new LinuxAdapter(mock([crashed]).run, env).execute('app:launch', { desktopId: 'x' })).success, false);
  const info = await new LinuxAdapter(mock([ok('Linux 6.8.0 x86_64\n')]).run, env).execute('system:get_info', {});
  assert.deepEqual(info.data, { platform: 'linux', kernel: 'Linux 6.8.0 x86_64', session: 'x11' });
});

test('adapters are honest about status: implemented but never hardwareVerified, with blockers listed', () => {
  for (const adapter of [new MacOSAdapter(mock([ok()]).run), new LinuxAdapter(mock([ok()]).run, {})]) {
    const info = adapter.describe();
    assert.equal(info.implemented, true);
    assert.equal(info.hardwareVerified, false);
    assert.ok(info.blockers.length >= 1);
  }
});

test('selectPlatformAdapter keeps failing closed unless a native adapter is explicitly injected', async () => {
  const winExec = async () => ({ success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS });
  assert.equal(selectPlatformAdapter('darwin', winExec).describe().implemented, false);
  assert.equal(selectPlatformAdapter('linux', winExec).describe().implemented, false);
  const m = mock([ok()]);
  const mac = selectPlatformAdapter('darwin', winExec, { macos: new MacOSAdapter(m.run) });
  assert.equal(mac.describe().implemented, true);
});

test('the default runner reports a missing executable as ENOENT without throwing', async () => {
  const result = await defaultProcessRunner('jarvis-definitely-not-a-command', ['x'], { timeoutMs: 2000 });
  assert.equal(result.error, 'ENOENT');
});
