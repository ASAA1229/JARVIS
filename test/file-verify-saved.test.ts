import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFileAdapter } from '../src/adapters/workspaceFiles.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { VerificationOutcome } from '../src/core/types.js';

test('file:verify_saved proves freshness and expected content', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'jarvis-verify-saved-'));
  try {
    const adapter = new WorkspaceFileAdapter([root]);
    const file = path.join(root, 'notes.txt');
    writeFileSync(file, 'meeting notes: ship on friday');
    const since = Date.now() - 1_000;

    const ok = await adapter.verifySaved('notes.txt', since, 'ship on friday');
    assert.equal(ok.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.equal(typeof ok.evidence?.sha256, 'string');

    const missingText = await adapter.verifySaved('notes.txt', since, 'not there');
    assert.equal(missingText.success, false);
    assert.equal(missingText.outcome, VerificationOutcome.VERIFIED_FAILURE);

    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    const stale = await adapter.verifySaved('notes.txt', Date.now(), undefined);
    assert.equal(stale.success, false);
    assert.match(stale.error ?? '', /not modified after/);

    const absent = await adapter.verifySaved('missing.txt', since, undefined);
    assert.equal(absent.success, false);

    const outside = await adapter.verifySaved('../escape.txt', since, undefined);
    assert.equal(outside.success, false);

    const badSince = await adapter.verifySaved('notes.txt', 'yesterday', undefined);
    assert.equal(badSince.success, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('planner maps a saved-file check to the read-only verify operation', async () => {
  const plan = await new LocalHeuristicPlanner().generatePlan('verify that the file notes.txt was saved with "ship on friday"', { requesterName: 'owner', timestamp: Date.now() });
  assert.equal(plan.operations[0]?.operation, 'file:verify_saved');
  assert.deepEqual(plan.operations[0]?.parameters, { path: 'notes.txt', contains: 'ship on friday' });
});
