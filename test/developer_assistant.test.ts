import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { redactSecrets, containsSecret } from '../src/developer/secrets.js';
import { RepoRegistry, isDeniedRepoPath, parseScopes, resolveInsideRepo } from '../src/developer/repoRegistry.js';
import { assertSafeDiff, isValidBranchName, PROTECTED_BRANCHES } from '../src/developer/repoTools.js';
import { DeveloperAssistant } from '../src/developer/developerAssistant.js';
import { PolicyGateway } from '../src/policy/gateway.js';

const context = { requesterName: 'Owner', timestamp: Date.now() };

test('planner maps explicit developer phrases to dev:* operations', async () => {
  const planner = new LocalHeuristicPlanner();
  const cases: Array<[string, string, Record<string, unknown>]> = [
    ['connect repo portfolio at C:\\Users\\me\\portfolio with scopes read, suggest, git-write', 'dev:repo_connect', { name: 'portfolio', path: 'C:\\Users\\me\\portfolio', scopes: 'read, suggest, git-write' }],
    ['show git status of portfolio', 'dev:git_status', { repo: 'portfolio' }],
    ['git log of repo jarvis', 'dev:git_log', { repo: 'jarvis' }],
    ['show file src/server.ts in portfolio', 'dev:read', { repo: 'portfolio', path: 'src/server.ts' }],
    ['explain src/server.ts in portfolio', 'dev:explain', { repo: 'portfolio', path: 'src/server.ts', request: '' }],
    ['suggest a fix for src/lib/seo.ts in portfolio: escape the title', 'dev:suggest_change', { repo: 'portfolio', path: 'src/lib/seo.ts', request: 'escape the title' }],
    ['apply suggestion a1b2c3d4 in portfolio', 'dev:apply_suggestion', { suggestionId: 'a1b2c3d4', repo: 'portfolio' }],
    ['create branch feature/seo-fix in portfolio', 'dev:branch_create', { repo: 'portfolio', branch: 'feature/seo-fix' }],
    ['commit to portfolio: fix SEO title escaping', 'dev:commit', { repo: 'portfolio', message: 'fix SEO title escaping' }],
    ['push portfolio', 'dev:push', { repo: 'portfolio' }],
    ['draft a pr for portfolio', 'dev:pr_draft', { repo: 'portfolio' }],
  ];
  for (const [request, operation, parameters] of cases) {
    const plan = await planner.generatePlan(request, context);
    assert.equal(plan.operations[0]?.operation, operation, request);
    assert.deepEqual(plan.operations[0]?.parameters, parameters, request);
    assert.equal(planner.validatePlanSchema(plan).valid, true, request);
  }
  // Ordinary requests are untouched.
  assert.equal((await planner.generatePlan('open notepad', context)).operations[0]?.operation, 'app:launch');
});

test('policy: reads need no approval, every git write needs owner approval', () => {
  const rules = (PolicyGateway as unknown as { prototype: object }).prototype;
  assert.ok(rules);
  const gateway = new PolicyGateway({ record: () => ({}) } as never, join(mkdtempSync(join(tmpdir(), 'pg-')), 'g.json'));
  const table = (gateway as unknown as { rules: Map<string, { requiresApproval: boolean; riskTier: string }> }).rules;
  if (table instanceof Map) {
    for (const op of ['dev:apply_suggestion', 'dev:branch_create', 'dev:commit', 'dev:push', 'dev:repo_connect']) assert.equal(table.get(op)?.requiresApproval, true, op);
    for (const op of ['dev:git_status', 'dev:read', 'dev:pr_draft']) assert.equal(table.get(op)?.requiresApproval, false, op);
  }
});

test('secret redaction covers common credential formats', () => {
  const input = [
    'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
    'token: ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'jrv_0123456789ab_' + 'A'.repeat(43),
    'password = "hunter2hunter2"',
    '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----',
  ].join('\n');
  const output = redactSecrets(input);
  for (const leaked of ['sk-proj-abc', 'ghp_abc', 'jrv_0123', 'hunter2', 'MIIabc']) assert.equal(output.includes(leaked), false, leaked);
  assert.equal(containsSecret('just a normal sentence'), false);
});

test('protected paths, branches and diffs fail closed', () => {
  for (const path of ['.env', '.env.local', 'config/.env.production', 'data/audit.log', 'node_modules/x/index.js', '.git/config', 'certs/server.pem', 'id_ed25519']) {
    assert.equal(isDeniedRepoPath(path), true, path);
  }
  assert.equal(isDeniedRepoPath('src/server.ts'), false);
  for (const branch of ['main', 'master', 'dev']) assert.ok(PROTECTED_BRANCHES.has(branch));
  assert.equal(isValidBranchName('feature/seo-fix'), true);
  for (const bad of ['../x', 'a..b', '-x', 'x.lock', 'x y']) assert.equal(isValidBranchName(bad), false, bad);

  const dir = mkdtempSync(join(tmpdir(), 'dev-repo-'));
  try {
    mkdirSync(join(dir, '.git'));
    const repo = { name: 'demo', path: dir, scopes: ['read' as const], connectedAt: '' };
    assert.throws(() => resolveInsideRepo(repo, '../outside.txt'), /outside the connected repository/);
    assert.throws(() => resolveInsideRepo(repo, '.env'), /protected/);
    assert.deepEqual(assertSafeDiff(repo, '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+b\n'), ['src/a.ts']);
    assert.throws(() => assertSafeDiff(repo, '--- a/.env\n+++ b/.env\n@@ -1 +1 @@\n-a\n+b\n'), /protected/);
    assert.throws(() => assertSafeDiff(repo, '--- a/../x\n+++ b/../x\n'), /outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repositories must be connected with the needed scope', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-assist-'));
  try {
    const repoDir = join(dir, 'repo');
    mkdirSync(join(repoDir, '.git'), { recursive: true });
    writeFileSync(join(repoDir, 'README.md'), 'hello');
    const registry = new RepoRegistry(join(dir, 'state.repos.json'));
    assert.throws(() => registry.connect('demo', 'relative/path', ['read']), /absolute/);
    const connection = registry.connect('demo', repoDir, parseScopes('suggest'));
    assert.deepEqual(connection.scopes, ['read', 'suggest']);
    assert.throws(() => registry.require('demo', 'git-write'), /git-write/);

    const assistant = new DeveloperAssistant(join(dir, 'state'), () => null);
    const readme = await assistant.execute('dev:read', { repo: 'demo', path: 'README.md' });
    assert.equal(readme.success, true);
    const noModel = await assistant.execute('dev:explain', { repo: 'demo', path: 'README.md' });
    assert.equal(noModel.success, false);
    assert.match(String(noModel.error), /No AI model is configured/);
    const blocked = await assistant.execute('dev:commit', { repo: 'demo', message: 'x y z' });
    assert.equal(blocked.success, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
