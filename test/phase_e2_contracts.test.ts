import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findPaymentTarget } from '../src/policy/exclusions.js';
import { isRegisteredTool, validateToolParameters } from '../src/policy/toolRegistry.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { KnowledgeSourceRegistry } from '../src/memory/knowledgeSources.js';
import { DocumentRagStore } from '../src/memory/documentRagStore.js';

test('payment exclusion covers shell, path and argument targets but not repository source paths (E:D4.4)', () => {
  assert.equal(findPaymentTarget({ command: 'cmd', args: ['/c', 'start', 'https://paypal.com'] }, 'terminal:run'), 'args');
  assert.equal(findPaymentTarget({ path: 'C:\\Apps\\PhonePe\\data.txt' }, 'file:read'), 'path');
  assert.equal(findPaymentTarget({ cwd: 'C:\\Users\\me\\Paytm' }, 'terminal:run'), 'cwd');
  assert.equal(findPaymentTarget({ appId: 'notepad', text: 'bank statement notes' }, 'desktop:type_text'), undefined);
  assert.equal(findPaymentTarget({ repo: 'jarvis', path: 'src/payments/readme' }, 'dev:read'), undefined);
});

test('tool registry rejects unregistered tools and mistyped parameters (E:D4.6)', () => {
  assert.equal(isRegisteredTool('file:read'), true);
  assert.equal(isRegisteredTool('shell:exec'), false);
  assert.match(validateToolParameters('shell:exec', {}) ?? '', /not registered/);
  assert.match(validateToolParameters('file:read', { path: 42 }) ?? '', /must be a string/);
  assert.match(validateToolParameters('terminal:run', { command: 'git', args: 'status' }) ?? '', /array of strings/);
  assert.match(validateToolParameters('file:read', { path: 'a.txt', extra: 1 }) ?? '', /Disallowed parameter/);
  assert.equal(validateToolParameters('file:read', { path: 'a.txt' }), undefined);
});

test('planner schema validation refuses unregistered tools and mistyped parameters (E:D4.6)', () => {
  const planner = new LocalHeuristicPlanner();
  const plan = (operation: string, parameters: Record<string, unknown>) => ({ intent: 'x', confidence: 1, explanation: 'x', operations: [{ operation, parameters, justification: 'x' }] });
  assert.equal(planner.validatePlanSchema(plan('shell:exec', {})).valid, false);
  assert.equal(planner.validatePlanSchema(plan('file:read', { path: 7 })).valid, false);
  assert.equal(planner.validatePlanSchema(plan('file:read', { path: 'a.txt' })).valid, true);
});

test('retrieval is restricted to owner-approved knowledge collections (E:D4.8)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-ks-'));
  try {
    const token = 'x'.repeat(40);
    const registry = new KnowledgeSourceRegistry(join(dir, 'sources.enc'), token);
    const store = new DocumentRagStore(join(dir, 'docs.enc'), token, null, registry);
    assert.throws(() => store.ingest({ ownerDeviceId: 'd1', sourceName: 'a.txt', content: 'alpha handbook text', collection: 'handbook' }), /approved/);
    assert.throws(() => store.ingest({ ownerDeviceId: 'd1', sourceName: 'a.txt', content: 'alpha handbook text' }), /approved/);
    registry.approve('handbook', 'd1');
    store.ingest({ ownerDeviceId: 'd1', sourceName: 'a.txt', content: 'alpha handbook text', collection: 'handbook' });
    assert.equal((await store.search('d1', 'alpha handbook')).length > 0, true);
    registry.revoke('handbook');
    assert.equal((await store.search('d1', 'alpha handbook')).length, 0);
    // The registry persists encrypted and reloads.
    registry.approve('handbook', 'd1');
    assert.equal(new KnowledgeSourceRegistry(join(dir, 'sources.enc'), token).isApproved('handbook'), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
