import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsAppLauncherAdapter, discoveredLaunchResult, matchesExpectedAppWindow, selectUniqueExpectedAppWindow, discoveredWindowIdentity } from '../src/adapters/windowsAppLauncher.js';
import { VerificationOutcome } from '../src/core/types.js';
import type { WindowInfo } from '../src/adapters/windowsWindows.js';

const notepad: WindowInfo = { pid: 4100, processName: 'Notepad', title: 'notes.txt - Notepad' };

test('allowlisted app window matching is case-insensitive and ignores .exe suffixes', () => {
  assert.equal(matchesExpectedAppWindow(notepad, {
    windowMatch: { processNames: ['notepad.exe'], titleContains: 'NOTEPAD' },
  }), true);
});

test('allowlisted app window matching rejects an unrelated process even when title matches', () => {
  assert.equal(matchesExpectedAppWindow(
    { ...notepad, processName: 'OtherEditor' },
    { windowMatch: { processNames: ['notepad'], titleContains: 'Notepad' } },
  ), false);
});

test('allowlisted app window matching rejects a mismatched title', () => {
  assert.equal(matchesExpectedAppWindow(
    { ...notepad, title: 'Untitled' },
    { windowMatch: { processNames: ['notepad'], titleContains: 'Notepad' } },
  ), false);
});

test('unknown app identity never matches an allowlisted window', () => {
  assert.equal(matchesExpectedAppWindow(notepad, {}), false);
});


test('launching an app with one existing matching window focuses it instead of spawning a duplicate', async () => {
  let focusedPid: number | undefined;
  const windows = {
    snapshot: async () => [notepad],
    focusWindow: async (target: { pid?: number }) => {
      focusedPid = target.pid;
      return {
        success: true,
        outcome: VerificationOutcome.VERIFIED_SUCCESS,
        data: { focused: true },
        evidence: { foregroundFocusVerified: true },
      };
    },
  } as unknown as import('../src/adapters/windowsWindows.js').WindowsWindowManager;

  const result = await new WindowsAppLauncherAdapter(windows).launchApp('notepad');

  assert.equal(focusedPid, notepad.pid);
  assert.equal(result.success, true);
  assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
  assert.deepEqual(result.data, {
    appId: 'notepad',
    name: 'Notepad',
    pid: notepad.pid,
    status: 'Already running; existing window focused',
    windowPid: notepad.pid,
    windowProcess: notepad.processName,
    windowTitle: notepad.title,
  });
  assert.equal(result.evidence?.reusedExistingWindow, true);
});

test('launching an app does not claim success when its existing window cannot be focused', async () => {
  const windows = {
    snapshot: async () => [notepad],
    focusWindow: async () => ({
      success: false,
      outcome: VerificationOutcome.VERIFIED_FAILURE,
      error: 'Foreground focus was denied.',
      evidence: { foregroundFocusVerified: false },
    }),
  } as unknown as import('../src/adapters/windowsWindows.js').WindowsWindowManager;

  const result = await new WindowsAppLauncherAdapter(windows).launchApp('notepad');

  assert.equal(result.success, false);
  assert.equal(result.outcome, VerificationOutcome.VERIFIED_FAILURE);
  assert.match(result.error ?? '', /already open.*could not verify/i);
  assert.equal(result.evidence?.reusedExistingWindow, true);
});

test('unique expected-window selection returns the sole trusted match', () => {
  const other: WindowInfo = { pid: 4200, processName: 'Explorer', title: 'File Explorer' };
  const selection = selectUniqueExpectedAppWindow([other, notepad], {
    windowMatch: { processNames: ['notepad'], titleContains: 'Notepad' },
  });
  assert.equal(selection.window?.pid, notepad.pid);
  assert.equal(selection.matchCount, 1);
});

test('unique expected-window selection refuses ambiguous matches', () => {
  const second: WindowInfo = { pid: 4101, processName: 'Notepad', title: 'draft.txt - Notepad' };
  const selection = selectUniqueExpectedAppWindow([notepad, second], {
    windowMatch: { processNames: ['notepad'], titleContains: 'Notepad' },
  });
  assert.equal(selection.window, undefined);
  assert.equal(selection.matchCount, 2);
});

test('unique expected-window selection returns no target when nothing matches', () => {
  const selection = selectUniqueExpectedAppWindow([], {
    windowMatch: { processNames: ['notepad'], titleContains: 'Notepad' },
  });
  assert.equal(selection.window, undefined);
  assert.equal(selection.matchCount, 0);
});


test('ambiguous existing app windows prevent arbitrary focus and duplicate launch', async () => {
  const second: WindowInfo = { pid: 4101, processName: 'Notepad', title: 'draft.txt - Notepad' };
  let focusCalls = 0;
  const windows = {
    snapshot: async () => [notepad, second],
    focusWindow: async () => {
      focusCalls += 1;
      return {
        success: true,
        outcome: VerificationOutcome.VERIFIED_SUCCESS,
        evidence: { foregroundFocusVerified: true },
      };
    },
  } as unknown as import('../src/adapters/windowsWindows.js').WindowsWindowManager;

  const result = await new WindowsAppLauncherAdapter(windows).launchApp('notepad');

  assert.equal(focusCalls, 0);
  assert.equal(result.success, true);
  assert.equal(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
  assert.equal(result.evidence?.duplicateLaunchPrevented, true);
  assert.equal(result.evidence?.ambiguousWindowCount, 2);
  assert.match(result.error ?? '', /multiple existing windows/i);
});


test('discovered Start-menu launch is partial when no trusted process identity is available', () => {
  const result = discoveredLaunchResult(
    { Name: 'Third-party Editor', AppID: 'Vendor.Editor' },
    { pid: 5100, processName: 'editor', title: 'Editor' },
  );

  assert.equal(result.success, true);
  assert.equal(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
  assert.equal(result.evidence?.targetWindowVerified, false);
  assert.match(result.error ?? '', /cannot independently verify/i);
});

test('discovered Start-menu launch verifies only a window matching the trusted identity', () => {
  const result = discoveredLaunchResult(
    { Name: 'Settings', AppID: 'windows.immersivecontrolpanel' },
    { pid: 5200, processName: 'SystemSettings', title: 'Settings' },
    { processNames: ['SystemSettings'], titleContains: 'Settings' },
  );

  assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
  assert.equal(result.evidence?.targetWindowVerified, true);
});

test('a Store app falls back to its uniquely titled ApplicationFrameHost frame for focus', async () => {
  const calculator: WindowInfo = { pid: 27208, processName: 'CalculatorApp', title: 'Calculator' };
  const targets: Array<{ pid?: number; processName?: string; titleContains?: string }> = [];
  const windows = {
    snapshot: async () => [calculator],
    focusWindow: async (target: { pid?: number; processName?: string; titleContains?: string }) => {
      targets.push(target);
      // The inner CoreWindow cannot take foreground; only the hosting frame can.
      return target.processName === 'ApplicationFrameHost'
        ? { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, evidence: { foregroundWindowVerified: true } }
        : { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Foreground focus was denied.' };
    },
  } as unknown as import('../src/adapters/windowsWindows.js').WindowsWindowManager;

  const result = await new WindowsAppLauncherAdapter(windows).launchApp('calc');

  assert.deepEqual(targets, [{ pid: 27208 }, { processName: 'ApplicationFrameHost', titleContains: 'Calculator' }]);
  assert.equal(result.success, true);
  assert.equal(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
});

test('the Store-app frame fallback still fails closed when the frame cannot be focused', async () => {
  const calculator: WindowInfo = { pid: 27208, processName: 'CalculatorApp', title: 'Calculator' };
  const windows = {
    snapshot: async () => [calculator],
    focusWindow: async () => ({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: '2 windows matched' }),
  } as unknown as import('../src/adapters/windowsWindows.js').WindowsWindowManager;

  const result = await new WindowsAppLauncherAdapter(windows).launchApp('calc');

  assert.equal(result.success, false);
  assert.match(String(result.error), /could not verify that its existing window was brought forward/);
});


test('supported browser discovery maps each known browser to its process identity', () => {
  assert.deepEqual(discoveredWindowIdentity('Google Chrome'), { processNames: ['chrome'] });
  assert.deepEqual(discoveredWindowIdentity('Microsoft Edge'), { processNames: ['msedge'] });
  assert.deepEqual(discoveredWindowIdentity('Firefox'), { processNames: ['firefox'] });
  assert.deepEqual(discoveredWindowIdentity('Brave'), { processNames: ['brave'] });
  assert.deepEqual(discoveredWindowIdentity('Opera'), { processNames: ['opera'] });
});
