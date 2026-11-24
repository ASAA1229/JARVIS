import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';
import { handleWorkspaceRoute } from '../src/server/workspaceRoutes.js';
import { CodingHelper, extractDiffBlock, type HelperEvent, type HelperModel } from '../src/workspace/codingHelper.js';

const OWNER_TOKEN = 'owner-control-token-for-workspace-route-tests';

function enroll(service: JarvisCoreService, permissions: Permission[], name: string, nonceChar: string): string {
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, name, keys.publicKey);
  assert.equal(enrolled.success, true);
  const timestamp = Date.now();
  const nonce = nonceChar.repeat(32);
  const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey);
  const session = service.identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
  assert.equal(session.success, true);
  return session.sessionId!;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function harness(model?: HelperModel) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-ws-routes-'));
  const project = join(dir, 'project');
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'src', 'app.ts'), 'export const value = 1;\nexport const other = 2;\n');
  writeFileSync(join(project, '.env'), 'API_KEY=should-never-be-served\n');
  const service = new JarvisCoreService(new LocalHeuristicPlanner(), join(dir, 'audit.log'), join(dir, 'state'), OWNER_TOKEN);
  const ownerSession = enroll(service, [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE, Permission.APP_LAUNCH], 'ws owner', 'a');
  const viewerSession = enroll(service, [Permission.SYSTEM_INFO_READ], 'ws viewer', 'b');
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleWorkspaceRoute(req, res, url, {
      jarvis: service,
      ...(model ? { helperModel: model } : {}),
      readJsonBody: (request, maxBytes = 65536) => new Promise((resolve, reject) => {
        let body = '';
        request.on('data', (chunk: Buffer) => { body += chunk.toString(); if (body.length > maxBytes) reject(new Error('Payload too large')); });
        request.on('end', () => resolve(body ? JSON.parse(body) : {}));
      }),
      authorize: (_req, sessionId) => {
        const auth = service.identity.validateDeviceSession(sessionId);
        return auth.valid && auth.device ? { valid: true, device: auth.device } : { valid: false, error: auth.error };
      },
      json: (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const call = async (method: string, path: string, body?: unknown, session = ownerSession): Promise<{ status: number; json: Json }> => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'x-session-id': session, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, json: (await response.json()) as Json };
  };
  const approve = async (result: Json) => {
    assert.equal(result['state'], TaskState.AWAITING_APPROVAL, `expected approval, got ${String(result['state'])}: ${String(result['message'])}`);
    return service.approveTask(result['approvalId'] as string, ownerSession);
  };
  const cleanup = async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    service.stopBackgroundServices();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, project, service, call, approve, ownerSession, viewerSession, port, cleanup };
}

test('routes need an owner session; unapproved roots are refused; adding a root needs approval', async () => {
  const h = await harness();
  try {
    const anon = await fetch(`http://127.0.0.1:${h.port}/api/workspace/roots`);
    assert.equal(anon.status, 401);
    assert.equal((await h.call('GET', '/api/workspace/roots', undefined, h.viewerSession)).status, 403);

    assert.equal((await h.call('GET', '/api/workspace/tree?root=project')).status, 403);
    assert.equal((await h.call('GET', '/api/workspace/file?root=project&path=src/app.ts')).status, 403);

    const add = await h.call('POST', '/api/workspace/roots/add', { name: 'project', path: h.project });
    assert.equal(add.json['state'], TaskState.AWAITING_APPROVAL);
    assert.equal((await h.call('GET', '/api/workspace/roots')).json['roots'].length, 0, 'not usable before approval');
    assert.equal((await h.call('GET', '/api/workspace/tree?root=project')).status, 403);

    const approved = await h.approve(add.json);
    assert.equal(approved.state, TaskState.COMPLETED, approved.message);
    assert.deepEqual((await h.call('GET', '/api/workspace/roots')).json['roots'].map((r: Json) => r['name']), ['project']);

    const tree = await h.call('GET', '/api/workspace/tree?root=project');
    assert.deepEqual(tree.json['entries'].map((e: Json) => e['name']), ['src']);
    const file = await h.call('GET', '/api/workspace/file?root=project&path=src/app.ts');
    assert.equal(file.json['content'].startsWith('export const value'), true);
    for (const path of ['.env', '../outside.txt', 'src/../../x']) {
      assert.ok([400, 403].includes((await h.call('GET', `/api/workspace/file?root=project&path=${encodeURIComponent(path)}`)).status), path);
    }
    assert.equal((await h.call('GET', '/api/workspace/search?root=project&q=value')).json['results'].length, 1);
    assert.ok(h.service.audit.getRecords().length > 0);
  } finally { await h.cleanup(); }
});

async function withRoot() {
  const h = await harness();
  const add = await h.call('POST', '/api/workspace/roots/add', { name: 'project', path: h.project });
  await h.approve(add.json);
  return h;
}

test('writes require approval: nothing changes until approved, rejection leaves the file alone, stale base is refused', async () => {
  const h = await withRoot();
  try {
    const target = join(h.project, 'src', 'app.ts');
    const original = readFileSync(target, 'utf8');
    const opened = (await h.call('GET', '/api/workspace/file?root=project&path=src/app.ts')).json;

    const preview = await h.call('POST', '/api/workspace/diff', { root: 'project', path: 'src/app.ts', content: 'export const value = 99;\nexport const other = 2;\n' });
    assert.match(preview.json['diff'], /-export const value = 1;\n\+export const value = 99;/);
    assert.equal(readFileSync(target, 'utf8'), original, 'previews never write');

    const request = { root: 'project', path: 'src/app.ts', content: 'export const value = 99;\nexport const other = 2;\n', baseHash: opened['hash'] };
    const pending = await h.call('POST', '/api/workspace/write', request);
    assert.equal(pending.json['state'], TaskState.AWAITING_APPROVAL);
    assert.match(pending.json['diff'], /\+export const value = 99;/);
    assert.equal(readFileSync(target, 'utf8'), original, 'unapproved write must not touch the file');

    const rejected = await h.service.rejectTask(pending.json['approvalId'], h.ownerSession);
    assert.equal(rejected.success, true);
    assert.equal(readFileSync(target, 'utf8'), original);

    const again = await h.call('POST', '/api/workspace/write', request);
    const done = await h.approve(again.json);
    assert.equal(done.state, TaskState.COMPLETED, done.message);
    assert.equal(readFileSync(target, 'utf8'), request.content);
    assert.ok(h.service.audit.getRecords().some((entry) => JSON.stringify(entry).includes('workspace:write')), 'audit entry for the write');

    const stale = await h.call('POST', '/api/workspace/write', { ...request, content: 'changed again\n' });
    assert.equal(stale.status, 409);
    assert.equal((await h.call('POST', '/api/workspace/write', { ...request, path: '.env', content: 'x' })).status, 403);
    assert.equal((await h.call('POST', '/api/workspace/write', { ...request, path: '../x.ts' })).status, 403);
  } finally { await h.cleanup(); }
});

test('create, rename and delete each go through approval', async () => {
  const h = await withRoot();
  try {
    const created = await h.call('POST', '/api/workspace/create', { root: 'project', path: 'src/new.ts', content: 'export {};\n' });
    assert.equal(existsSync(join(h.project, 'src', 'new.ts')), false);
    assert.equal((await h.approve(created.json)).state, TaskState.COMPLETED);
    assert.equal(readFileSync(join(h.project, 'src', 'new.ts'), 'utf8'), 'export {};\n');
    assert.equal((await h.call('POST', '/api/workspace/create', { root: 'project', path: 'src/new.ts', content: 'x' })).status, 409);
    assert.equal((await h.call('POST', '/api/workspace/create', { root: 'project', path: '.env.local', content: 'x' })).status, 403);

    const renamed = await h.call('POST', '/api/workspace/rename', { root: 'project', path: 'src/new.ts', to: 'src/renamed.ts' });
    assert.equal(existsSync(join(h.project, 'src', 'renamed.ts')), false);
    assert.equal((await h.approve(renamed.json)).state, TaskState.COMPLETED);
    assert.equal(existsSync(join(h.project, 'src', 'renamed.ts')), true);

    const secretRename = await h.call('POST', '/api/workspace/rename', { root: 'project', path: 'src/renamed.ts', to: 'src/.env' });
    const failed = await h.approve(secretRename.json);
    assert.notEqual(failed.state, TaskState.COMPLETED);
    assert.equal(existsSync(join(h.project, 'src', '.env')), false);

    const deleted = await h.call('POST', '/api/workspace/delete', { root: 'project', path: 'src/renamed.ts' });
    assert.equal(existsSync(join(h.project, 'src', 'renamed.ts')), true);
    assert.equal((await h.approve(deleted.json)).state, TaskState.COMPLETED);
    assert.equal(existsSync(join(h.project, 'src', 'renamed.ts')), false);
  } finally { await h.cleanup(); }
});

function fakeModel(answer: string): HelperModel {
  return { async *stream() { for (const part of answer.match(/[\s\S]{1,17}/g) ?? []) yield part; } };
}

const GOOD_ANSWER = [
  'The constant should be 42.',
  '```diff',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,2 +1,2 @@',
  '-export const value = 1;',
  '+export const value = 42;',
  ' export const other = 2;',
  '```',
].join('\n');

async function readSse(port: number, session: string, body: unknown): Promise<HelperEvent[]> {
  const response = await fetch(`http://127.0.0.1:${port}/api/workspace/helper`, {
    method: 'POST', headers: { 'x-session-id': session, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await response.text();
  return text.split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)) as HelperEvent);
}

test('helper streams over SSE and returns a diff proposal that is not applied until approved', async () => {
  const h = await harness(fakeModel(GOOD_ANSWER));
  try {
    await h.approve((await h.call('POST', '/api/workspace/roots/add', { name: 'project', path: h.project })).json);
    const target = join(h.project, 'src', 'app.ts');
    const original = readFileSync(target, 'utf8');
    const events = await readSse(h.port, h.ownerSession, { root: 'project', action: 'fix', message: 'make value 42', path: 'src/app.ts', selection: { text: 'export const value = 1;', startLine: 1, endLine: 1 } });
    assert.ok(events.filter((event) => event.type === 'token').length > 1, 'streamed in several chunks');
    const proposal = events.find((event) => event.type === 'proposal');
    assert.ok(proposal && proposal.type === 'proposal' && proposal.valid, JSON.stringify(proposal));
    assert.deepEqual(proposal.files, ['src/app.ts']);
    assert.equal(events[events.length - 1]!.type, 'done');
    assert.equal(readFileSync(target, 'utf8'), original, 'a proposal never writes');

    // Discard = simply not applying. Apply needs an approval, and only then writes.
    const apply = await h.call('POST', '/api/workspace/apply', { root: 'project', diff: (proposal as { diff: string }).diff });
    assert.equal(apply.json['state'], TaskState.AWAITING_APPROVAL);
    assert.equal(readFileSync(target, 'utf8'), original);
    const done = await h.approve(apply.json);
    assert.equal(done.state, TaskState.COMPLETED, done.message);
    assert.equal(readFileSync(target, 'utf8'), 'export const value = 42;\nexport const other = 2;\n');

    // Reject path leaves the file alone.
    writeFileSync(target, original);
    const second = await h.call('POST', '/api/workspace/apply', { root: 'project', diff: (proposal as { diff: string }).diff });
    await h.service.rejectTask(second.json['approvalId'], h.ownerSession);
    assert.equal(readFileSync(target, 'utf8'), original);

    // A diff aimed at a secret file or outside the root is refused before any approval exists.
    const evil = '--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+X=1\n';
    assert.equal((await h.call('POST', '/api/workspace/apply', { root: 'project', diff: evil })).status, 403);
  } finally { await h.cleanup(); }
});

test('helper marks invalid or secret-bearing proposals and never reaches unapproved roots', async () => {
  const h = await withRoot();
  try {
    const bad = GOOD_ANSWER.replace('-export const value = 1;', '-export const value = 777;');
    const helper = new CodingHelper(h.service.workspace, fakeModel(bad));
    const events: HelperEvent[] = [];
    for await (const event of helper.run({ root: 'project', action: 'fix', message: 'x', path: 'src/app.ts' })) events.push(event);
    const proposal = events.find((event) => event.type === 'proposal');
    assert.ok(proposal && proposal.type === 'proposal' && !proposal.valid);

    const secret = ['```diff', '--- /dev/null', '+++ b/src/leak.ts', '@@ -0,0 +1 @@', '+const token = "sk-' + 'a'.repeat(30) + '";', '```'].join('\n');
    const leaky: HelperEvent[] = [];
    for await (const event of new CodingHelper(h.service.workspace, fakeModel(secret)).run({ root: 'project', action: 'generate', message: 'x' })) leaky.push(event);
    const leakProposal = leaky.find((event) => event.type === 'proposal');
    assert.ok(leakProposal && leakProposal.type === 'proposal' && !leakProposal.valid);

    const refused: HelperEvent[] = [];
    for await (const event of new CodingHelper(h.service.workspace, fakeModel('hi')).run({ root: 'nope', action: 'chat', message: 'x' })) refused.push(event);
    assert.equal(refused[0]!.type, 'error');

    // The prompt never carries secret file content or secret-looking values.
    const prompts: string[] = [];
    const spy: HelperModel = { async *stream(messages) { prompts.push(messages.map((m) => m.content).join('\n')); yield 'ok'; } };
    for await (const event of new CodingHelper(h.service.workspace, spy).run({ root: 'project', action: 'explain', message: '', path: 'src/app.ts', content: 'const apiKey = "sk-' + 'b'.repeat(30) + '";' })) void event;
    assert.ok(!prompts[0]!.includes('b'.repeat(30)));
    const envEvents: HelperEvent[] = [];
    for await (const event of new CodingHelper(h.service.workspace, spy).run({ root: 'project', action: 'explain', message: '', path: '.env' })) envEvents.push(event);
    assert.ok(!prompts[prompts.length - 1]!.includes('should-never-be-served'));
    assert.equal(extractDiffBlock('no diff here'), null);
  } finally { await h.cleanup(); }
});

test('running scripts is limited to the developer allowlist and needs a connected repository', async () => {
  const h = await withRoot();
  try {
    assert.equal((await h.call('POST', '/api/workspace/run', { root: 'project', script: 'rm -rf /' })).status, 400);
    assert.equal((await h.call('POST', '/api/workspace/run', { root: 'project', script: 'start' })).status, 400);
    assert.equal((await h.call('POST', '/api/workspace/run', { root: 'project', script: 'test' })).status, 409);
    assert.equal((await h.call('POST', '/api/workspace/run', { root: 'unknown', script: 'test' })).status, 403);
  } finally { await h.cleanup(); }
});
