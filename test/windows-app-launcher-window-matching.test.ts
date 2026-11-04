import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesExpectedAppWindow } from '../src/adapters/windowsAppLauncher.js';
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
