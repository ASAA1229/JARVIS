import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildControlActionScript } from '../src/adapters/windowsDesktopAgent.js';
import { matchesExpectedAppWindow } from '../src/adapters/windowsAppLauncher.js';

test('desktop:click_control validates and indexes the same UI Automation collection', () => {
  const script = buildControlActionScript('desktop:click_control', 'Save');

  assert.match(script, /\$foundControls = \$root\.FindAll/);
  assert.match(script, /if \(\$foundControls\.Count -ne 1\)/);
  assert.match(script, /\$element = \$foundControls\.Item\(0\)/);
  assert.doesNotMatch(script, /if \(\$matches\.Count/);
});

test('desktop:set_value validates and indexes the same UI Automation collection', () => {
  const script = buildControlActionScript('desktop:set_value', 'Title', 'JARVIS');

  assert.match(script, /\$matches = \$root\.FindAll/);
  assert.match(script, /if \(\$matches\.Count -ne 1\)/);
  assert.match(script, /\$element = \$matches\.Item\(0\)/);
  assert.doesNotMatch(script, /if \(\$foundControls\.Count/);
});

test('UI Automation control scripts escape PowerShell single-quoted values', () => {
  const clickScript = buildControlActionScript('desktop:click_control', "O'Brien");
  const valueScript = buildControlActionScript('desktop:set_value', "O'Brien", "It's JARVIS");

  assert.ok(clickScript.includes("NameProperty, 'O''Brien'"));
  assert.ok(valueScript.includes("NameProperty, 'O''Brien'"));
  assert.ok(valueScript.includes("$pattern.SetValue('It''s JARVIS')"));
  assert.ok(valueScript.includes("$actual -cne 'It''s JARVIS'"));
});

test('set_value script keeps sensitive-field checks and independent value verification', () => {
  const script = buildControlActionScript('desktop:set_value', 'Account name', 'demo');

  assert.match(script, /Current\.IsPassword/);
  assert.match(script, /password\|passcode\|pin\|cvv\|card number\|bank account\|security code/);
  assert.match(script, /\$actual = \$pattern\.Current\.Value/);
  assert.match(script, /\$actual -cne 'demo'/);
  assert.match(script, /VALUE_VERIFIED/);
});

test('set_value script rejects a missing text argument before execution', () => {
  assert.throws(
    () => buildControlActionScript('desktop:set_value', 'Title'),
    /A text value is required/,
  );
});

test('desktop action validation rejects empty or oversized control names before invoking PowerShell', async () => {
  const { WindowsDesktopAgent } = await import('../src/adapters/windowsDesktopAgent.js');
  const agent = new WindowsDesktopAgent();

  const emptyName = await agent.execute({
    operation: 'desktop:click_control',
    parameters: { name: '   ' },
  });
  assert.equal(emptyName.success, false);
  assert.match(emptyName.error || '', /Control name must contain 1–120 characters/);

  const longName = await agent.execute({
    operation: 'desktop:set_value',
    parameters: { name: 'x'.repeat(121), text: 'demo' },
  });
  assert.equal(longName.success, false);
  assert.match(longName.error || '', /Control name must contain 1–120 characters/);
});

test('app launch verification requires expected process identity, not title alone', () => {
  const app = { windowMatch: { processNames: ['mspaint'], titleContains: 'Paint' } };
  assert.equal(matchesExpectedAppWindow({ pid: 10, processName: 'mspaint.exe', title: 'Untitled - Paint' }, app), true);
  assert.equal(matchesExpectedAppWindow({ pid: 11, processName: 'notepad.exe', title: 'Paint - Notes' }, app), false);
  assert.equal(matchesExpectedAppWindow({ pid: 12, processName: 'mspaint.exe', title: 'Untitled - Drawing' }, app), false);
  assert.equal(matchesExpectedAppWindow({ pid: 13, processName: 'MSPAINT', title: 'Paint' }, app), true);
});

test('app launch verification fails closed when no process matcher is configured', () => {
  assert.equal(matchesExpectedAppWindow({ pid: 10, processName: 'mspaint.exe', title: 'Paint' }, {}), false);
});

test('discovered Start-menu launch never claims verified success without process identity mapping', async () => {
  const { discoveredLaunchResult } = await import('../src/adapters/windowsAppLauncher.js');
  const selected = { Name: 'Paint', AppID: 'Microsoft.Paint_8wekyb3d8bbwe!App' };
  const titleOnlyLookalike = discoveredLaunchResult(selected, {
    pid: 22,
    processName: 'notepad',
    title: 'Paint - Notes',
  });
  assert.equal(titleOnlyLookalike.success, true);
  assert.equal(titleOnlyLookalike.outcome, 'PARTIAL_SUCCESS');
  assert.equal((titleOnlyLookalike.evidence as Record<string, unknown>).targetWindowVerified, false);
  assert.equal((titleOnlyLookalike.evidence as Record<string, unknown>).newWindowDetected, true);
  assert.match(titleOnlyLookalike.error || '', /cannot independently verify/i);

  const noWindow = discoveredLaunchResult(selected);
  assert.equal(noWindow.outcome, 'PARTIAL_SUCCESS');
  assert.equal((noWindow.evidence as Record<string, unknown>).newWindowDetected, false);
  assert.equal((noWindow.evidence as Record<string, unknown>).targetWindowVerified, false);
});
