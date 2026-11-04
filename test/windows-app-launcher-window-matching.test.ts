import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsAppLauncherAdapter, matchesExpectedAppWindow, selectUniqueExpectedAppWindow } from '../src/adapters/windowsAppLauncher.js';
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
