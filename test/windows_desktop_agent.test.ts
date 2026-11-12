import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildControlActionScript, buildForegroundFocusAssertionScript, buildReadControlScript } from '../src/adapters/windowsDesktopAgent.js';
import { matchesExpectedAppWindow } from '../src/adapters/windowsAppLauncher.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

test('UI Automation supports AutomationId selectors and rejects competing selectors', async () => {
  const readScript = buildReadControlScript(undefined, 'MainDocumentTitle');
  const clickScript = buildControlActionScript('desktop:click_control', undefined, undefined, 'SaveButton');
  assert.match(readScript, /AutomationIdProperty, 'MainDocumentTitle'/);
  assert.match(clickScript, /AutomationIdProperty, 'SaveButton'/);

  const { WindowsDesktopAgent } = await import('../src/adapters/windowsDesktopAgent.js');
  const agent = new WindowsDesktopAgent();
  const ambiguous = await agent.execute({
    operation: 'desktop:click_control',
    parameters: { name: 'Save', automationId: 'SaveButton' },
  });
  assert.equal(ambiguous.success, false);
  assert.match(ambiguous.error || '', /either a control name or automationId, not both/i);
});

test('desktop:read_control requires a unique control and redacts sensitive values', () => {
  const script = buildReadControlScript("Account name");
  assert.match(script, /\$matches = \$root\.FindAll/);
  assert.match(script, /\$matches\.Count -ne 1/);
  assert.match(script, /Current\.IsPassword/);
  assert.match(script, /\[REDACTED\]/);
  assert.match(script, /ValuePattern/);
  assert.match(script, /valueAvailable/);
});

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
  for (const term of [
    'password',
    'passcode',
    'pin',
    'otp',
    'one[- ]time password',
    'recovery code',
    'cvv',
    'card number',
    'credit card',
    'debit card',
    'card expiry',
    'expiration date',
    'bank account',
    'account number',
    'routing number',
    'iban',
    'swift code',
    'sort code',
    'security code',
  ]) {
    assert.ok(script.includes(term), `Sensitive-field guard is missing: ${term}`);
  }
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

test('Windows app launcher does not return raw exception messages or unbounded invalid input', () => {
  const source = readFileSync(new URL('../src/adapters/windowsAppLauncher.ts', import.meta.url), 'utf8');
  assert.match(source, /Application launch failed; no verified success is reported/);
  assert.match(source, /Start-menu application launch failed; no verified success is reported/);
  assert.doesNotMatch(source, /Launch execution error: \`\${String\(err\)\}\`/);
  assert.doesNotMatch(source, /error: error instanceof Error \? error\.message : String\(error\)/);
  assert.match(source, /requestedType: typeof appId, requestedLength:/);
});

test('planner routes an explicit named-control read to the guarded desktop operation', async () => {
  const planner = new LocalHeuristicPlanner();
  const plan = await planner.generatePlan('read control Document title', { requesterName: 'owner', timestamp: Date.now() });
  assert.equal(plan.operations[0]?.operation, 'desktop:read_control');
  assert.deepEqual(plan.operations[0]?.parameters, { name: 'Document title' });
  assert.equal(planner.validatePlanSchema(plan).valid, true);
});


test('desktop control scripts bind UI Automation to the same guarded foreground window handle', () => {
  const readScript = buildReadControlScript('Document title');
  const setScript = buildControlActionScript('desktop:set_value', 'Document title', 'JARVIS');

  assert.match(readScript, /FromHandle\(\$foregroundHwnd\)/);
  assert.match(setScript, /FromHandle\(\$foregroundHwnd\)/);
  assert.doesNotMatch(readScript, /FromHandle\(\[JarvisForeground\]::GetForegroundWindow\(\)\)/);
});

test('planner routes an explicit named-field value change to guarded UI Automation', async () => {
  const planner = new LocalHeuristicPlanner();
  const plan = await planner.generatePlan('set field Document title to JARVIS test', { requesterName: 'owner', timestamp: Date.now() });

  assert.equal(plan.operations[0]?.operation, 'desktop:set_value');
  assert.deepEqual(plan.operations[0]?.parameters, { name: 'Document title', text: 'JARVIS test' });
  assert.equal(planner.validatePlanSchema(plan).valid, true);
});


test('planner binds a named-control read to an explicitly named process', async () => {
  const planner = new LocalHeuristicPlanner();
  const plan = await planner.generatePlan('read control Document title in notepad', { requesterName: 'owner', timestamp: Date.now() });
  assert.equal(plan.operations[0]?.operation, 'desktop:read_control');
  assert.deepEqual(plan.operations[0]?.parameters, { name: 'Document title', expectProcess: 'notepad' });
  assert.equal(planner.validatePlanSchema(plan).valid, true);
});

test('planner binds control click and value changes to an explicitly named process', async () => {
  const planner = new LocalHeuristicPlanner();
  const clickPlan = await planner.generatePlan('click button Save in notepad', { requesterName: 'owner', timestamp: Date.now() });
  assert.equal(clickPlan.operations[0]?.operation, 'desktop:click_control');
  assert.deepEqual(clickPlan.operations[0]?.parameters, { name: 'Save', expectProcess: 'notepad' });
  assert.equal(planner.validatePlanSchema(clickPlan).valid, true);

  const setPlan = await planner.generatePlan('set field Document title in notepad to JARVIS test', { requesterName: 'owner', timestamp: Date.now() });
  assert.equal(setPlan.operations[0]?.operation, 'desktop:set_value');
  assert.deepEqual(setPlan.operations[0]?.parameters, { name: 'Document title', expectProcess: 'notepad', text: 'JARVIS test' });
  assert.equal(planner.validatePlanSchema(setPlan).valid, true);
});


test('keyboard input scripts can fail closed when foreground focus changes', () => {
  const assertion = buildForegroundFocusAssertionScript();
  assert.match(assertion, /GetForegroundWindow\(\) -ne \$foregroundHwnd/);
  assert.match(assertion, /FOREGROUND_CHANGED/);
});
