import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDeveloperRequest } from '../src/developer/developerPlanner.js';
import { DEVELOPER_OPERATIONS } from '../src/developer/operations.js';
import { RUNNABLE_SCRIPTS, runProjectScript } from '../src/developer/repoTools.js';
import { DeveloperAssistant } from '../src/developer/developerAssistant.js';

test('new developer phrases map to approval-gated or read-only operations', () => {
  assert.equal(planDeveloperRequest('open a pull request for jarvis: Add sync')?.operations[0]?.operation, 'dev:pr_create');
  assert.deepEqual(planDeveloperRequest('run the tests in jarvis')?.operations[0]?.parameters, { repo: 'jarvis', script: 'test' });
  assert.equal(planDeveloperRequest('show history of jarvis')?.operations[0]?.operation, 'dev:history');
  assert.equal(planDeveloperRequest('document src/index.ts in jarvis')?.operations[0]?.operation, 'dev:doc_suggest');
  // Drafting a PR stays text-only and separate from opening one.
  assert.equal(planDeveloperRequest('draft a pr for jarvis')?.operations[0]?.operation, 'dev:pr_draft');
  for (const op of ['dev:pr_create', 'dev:run_script', 'dev:history', 'dev:doc_suggest']) {
    assert.ok((DEVELOPER_OPERATIONS as readonly string[]).includes(op), op);
  }
});

test('script runner only accepts allowlisted names that exist in package.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-dev-script-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e "process.exit(0)"' } }));
    const repo = { name: 'scratch', path: dir, scopes: ['read', 'ci'], connectedAt: new Date().toISOString() } as never;
    assert.ok(!RUNNABLE_SCRIPTS.has('deploy'));
    await assert.rejects(() => runProjectScript(repo, 'deploy'), /Only these project scripts/);
    await assert.rejects(() => runProjectScript(repo, 'build'), /no "build" script/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repository history records outcomes without contents', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-dev-history-'));
  try {
    const assistant = new DeveloperAssistant(join(dir, 'developer'), () => null);
    const missing = await assistant.execute('dev:git_status', { repo: 'unknown' });
    assert.equal(missing.success, false);
    const history = await assistant.execute('dev:history', { repo: 'unknown' });
    // An unknown repo cannot be read, so history is refused rather than leaking anything.
    assert.equal(history.success, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
