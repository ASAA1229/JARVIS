import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.js';
import { createOfficialStoreSearch } from '../src/stores/officialStore.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

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
  require('node:fs').writeFileSync(path, JSON.stringify(raw));
  assert.throws(() => new PersonalMemoryStore(path, TOKEN), /could not be decrypted or validated/);
}));

test('official store discovery returns only official store domains and excludes payment apps', () => {
  assert.equal(new URL(createOfficialStoreSearch('windows', 'VLC').searchUrl).hostname, 'apps.microsoft.com');
  assert.equal(new URL(createOfficialStoreSearch('android', 'VLC').searchUrl).hostname, 'play.google.com');
  assert.equal(new URL(createOfficialStoreSearch('ios', 'VLC').searchUrl).hostname, 'apps.apple.com');
  assert.throws(() => createOfficialStoreSearch('android', 'PhonePe'), /excludes payment and financial applications/);
});

test('desktop voice intents produce only bounded allowlisted operations', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'Owner', timestamp: Date.now() };
  const zoom = await planner.generatePlan('zoom in', context);
  assert.equal(zoom.operations[0]?.operation, 'desktop:zoom');
  assert.deepEqual(zoom.operations[0]?.parameters, { direction: 'in' });
  const type = await planner.generatePlan('type Hello JARVIS', context);
  assert.equal(type.operations[0]?.operation, 'desktop:type_text');
  assert.deepEqual(type.operations[0]?.parameters, { text: 'Hello JARVIS' });
  const validation = planner.validatePlanSchema(type);
  assert.equal(validation.valid, true);
});
