import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.js';
import { createOfficialStoreSearch } from '../src/stores/officialStore.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { WindowsAppLauncherAdapter } from '../src/adapters/windowsAppLauncher.js';

const TOKEN = 'owner-token-for-memory-tests-0123456789';

function withTempDir<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-enhancement-'));
  try { return run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('personal memory is encrypted at rest and persists across store instances', () => withTempDir((directory) => {
  const path = join(directory, 'memory.enc');
  const first = new PersonalMemoryStore(path, TOKEN);
  const saved = first.save('project', 'JARVIS Windows agent milestone', 10);
  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('JARVIS Windows agent milestone'));
  const reopened = new PersonalMemoryStore(path, TOKEN);
  assert.equal(reopened.list()[0]?.id, saved.id);
  assert.equal(reopened.list()[0]?.content, 'JARVIS Windows agent milestone');
  assert.equal(reopened.delete(saved.id), true);
  assert.equal(reopened.list().length, 0);
}));

test('personal memory rejects credentials and sensitive payment data', () => withTempDir((directory) => {
  const store = new PersonalMemoryStore(join(directory, 'memory.enc'), TOKEN);
  assert.throws(() => store.save('general', 'My password is hunter2'), /credentials or sensitive financial data/);
  assert.throws(() => store.save('general', 'My bank account number is 123456'), /credentials or sensitive financial data/);
}));

test('tampered memory fails closed instead of silently replacing data', () => withTempDir((directory) => {
  const path = join(directory, 'memory.enc');
  new PersonalMemoryStore(path, TOKEN).save('preference', 'concise responses');
  const raw = JSON.parse(readFileSync(path, 'utf8')) as { ciphertext: string };
  raw.ciphertext = Buffer.from('tampered').toString('base64');
  writeFileSync(path, JSON.stringify(raw));
  assert.throws(() => new PersonalMemoryStore(path, TOKEN), /could not be decrypted or validated/);
}));

test('Windows app launcher blocks payment apps before any OS launch attempt', async () => {
  const launcher = new WindowsAppLauncherAdapter();
  const result = await launcher.launchApp('PhonePe');
  assert.equal(result.success, false);
  assert.match(result.error || '', /excludes payment and financial applications/);
  assert.equal(result.evidence.blockedByPolicy, true);
});

test('official store discovery returns only official store domains and excludes payment apps', () => {
  assert.equal(new URL(createOfficialStoreSearch('windows', 'VLC').searchUrl).hostname, 'apps.microsoft.com');
  assert.equal(new URL(createOfficialStoreSearch('android', 'VLC').searchUrl).hostname, 'play.google.com');
  assert.equal(new URL(createOfficialStoreSearch('ios', 'VLC').searchUrl).hostname, 'apps.apple.com');
  assert.throws(() => createOfficialStoreSearch('android', 'PhonePe'), /excludes payment and financial applications/);
});

test('desktop voice intents produce only bounded allowlisted operations', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'Owner', timestamp: Date.now() };
  const rememberName = await planner.generatePlan('remember my name is Abhishek Guda', context);
  assert.equal(rememberName.operations[0]?.operation, 'memory:save');
  assert.deepEqual(rememberName.operations[0]?.parameters, { category: 'preference', content: 'owner name: Abhishek Guda' });
  const reviewMemory = await planner.generatePlan('what do you remember about me', context);
  assert.equal(reviewMemory.operations[0]?.operation, 'memory:list');
  const forgetMemory = await planner.generatePlan('forget memory 0123456789abcdef0123456789abcdef', context);
  assert.equal(forgetMemory.operations[0]?.operation, 'memory:delete');
  assert.deepEqual(forgetMemory.operations[0]?.parameters, { id: '0123456789abcdef0123456789abcdef' });
  const openChrome = await planner.generatePlan('open Chrome', context);
  assert.equal(openChrome.operations[0]?.operation, 'app:launch');
  assert.deepEqual(openChrome.operations[0]?.parameters, { appId: 'Google Chrome' });
  const blockedPaymentApp = await planner.generatePlan('open Paytm', context);
  assert.equal(blockedPaymentApp.operations.length, 0);
  assert.match(blockedPaymentApp.explanation, /payment and financial applications/);
  const unpinnedZoom = await planner.generatePlan('zoom in', context);
  assert.equal(unpinnedZoom.operations.length, 0);
  assert.match(unpinnedZoom.explanation, /Name the application to zoom/);
  const zoom = await planner.generatePlan('zoom in on Chrome', context);
  const inspect = await planner.generatePlan('inspect the current window', context);
  assert.equal(inspect.operations[0]?.operation, 'desktop:inspect_window');
  const click = await planner.generatePlan('click button named Save', context);
  assert.equal(click.operations[0]?.operation, 'desktop:click_control');
  assert.deepEqual(click.operations[0]?.parameters, { name: 'Save' });
  const setField = await planner.generatePlan('set field Search to JARVIS', context);
  assert.equal(setField.operations[0]?.operation, 'desktop:set_value');
  assert.deepEqual(setField.operations[0]?.parameters, { name: 'Search', text: 'JARVIS' });
  assert.equal(zoom.operations[0]?.operation, 'desktop:zoom');
  assert.deepEqual(zoom.operations[0]?.parameters, { direction: 'in', expectProcess: 'Chrome' });
  const unpinnedType = await planner.generatePlan('type Hello JARVIS', context);
  assert.equal(unpinnedType.operations.length, 0);
  assert.match(unpinnedType.explanation, /will not type into an unknown foreground window/);
  const type = await planner.generatePlan('type Hello JARVIS in notepad', context);
  assert.equal(type.operations[0]?.operation, 'desktop:type_text');
  assert.deepEqual(type.operations[0]?.parameters, { text: 'Hello JARVIS', expectProcess: 'notepad' });
  const compound = await planner.generatePlan('open Notepad and write Hello JARVIS', context);
  assert.equal(compound.operations[0]?.operation, 'desktop:launch_and_type');
  assert.deepEqual(compound.operations[0]?.parameters, { appId: 'notepad', text: 'Hello JARVIS' });
  const missingName = await planner.generatePlan('open Notepad and write my name', context);
  assert.equal(missingName.operations.length, 0);
  assert.match(missingName.explanation, /verified owner name configured/);
  const savedName = await planner.generatePlan('open Notepad and write my name', {
    ...context, memory: ['owner name: Abhishek Guda'],
  });
  assert.equal(savedName.operations[0]?.operation, 'desktop:launch_and_type');
  assert.deepEqual(savedName.operations[0]?.parameters, { appId: 'notepad', text: 'Abhishek Guda' });
  const copyPaste = await planner.generatePlan('copy selected text in Chrome and paste it in Notepad', context);
  assert.deepEqual(copyPaste.operations.map((op) => [op.operation, op.parameters]), [
    ['desktop:copy_selection', { expectProcess: 'Chrome' }],
    ['app:launch', { appId: 'notepad' }],
    ['desktop:paste_clipboard', { expectProcess: 'Notepad' }],
  ]);
  assert.equal(planner.validatePlanSchema(copyPaste).valid, true);
  // Without a named source the planner must not copy from an unknown foreground window.
  const unsourcedCopyPaste = await planner.generatePlan('copy this and paste it in Notepad', context);
  assert.equal(unsourcedCopyPaste.operations.length, 0);
  assert.match(unsourcedCopyPaste.explanation, /Name the application containing the selection/);
  // Pronouns refer to the clipboard; they are never pasted as literal text.
  for (const phrase of ['paste it in Notepad', 'paste this into Notepad', 'paste that in Notepad']) {
    const pastePronoun = await planner.generatePlan(phrase, context);
    assert.deepEqual(pastePronoun.operations.map((op) => [op.operation, op.parameters]), [
      ['desktop:paste_clipboard', { expectProcess: 'Notepad' }],
    ], phrase);
  }
  const validation = planner.validatePlanSchema(type);
  assert.equal(validation.valid, true);
  assert.equal(planner.validatePlanSchema(compound).valid, true);
});
