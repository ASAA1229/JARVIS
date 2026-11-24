import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/freePort.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import type { AIMessage, AIProvider } from '../src/ai/aiProvider.js';
import { escapeHtml, parseMarkdown, safeUrl } from '../src/studio/markdown.js';
import { isValidTotpCode, withStepUp } from '../src/studio/stepup.js';
import { buildModelfile } from '../src/studio/modelBuilder.js';
import { conversationToTrainingRecord, looksSensitive, mergeTrainingRecords, validateTrainingRecord } from '../src/studio/training.js';

// Fixture note: all conversation text below is fictional TEST DATA.
const PORT = await freePort();
let server: JarvisServer;
let dir: string;
const previousEnv = { token: process.env.JARVIS_OWNER_CONTROL_TOKEN, studio: process.env.JARVIS_STUDIO_DIR, sites: process.env.JARVIS_SITE_CLIENTS_PATH };

type Who = { sessionId: string; privateKey: string };
let owner: Who;
let reader: Who;
const seenPrompts: AIMessage[][] = [];
let slowMode = false;

function enroll(permissions: Permission[]): Who {
  const service = server.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'studio-test', keys.publicKey);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  return { sessionId: session.sessionId!, privateKey: keys.privateKey };
}

function call(method: string, path: string, who: Who | null, body?: unknown, signal?: AbortSignal): Promise<Response> {
  const headers: Record<string, string> = {};
  if (who) {
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const canonical = CryptoUtil.buildCanonicalRequestString(method, path.split('?')[0]!, who.sessionId, timestamp, nonce, body);
    Object.assign(headers, {
      'x-session-id': who.sessionId, 'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce,
      'x-request-signature': CryptoUtil.signData(canonical, who.privateKey),
    });
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), ...(signal ? { signal } : {}) });
}

function sseEvents(text: string): Array<{ event: string; data: any }> {
  return text.split('\n\n').filter(Boolean).map((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1] ?? 'message';
    const data = JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? 'null');
    return { event, data };
  });
}

const fakeProvider: AIProvider = {
  id: 'fake', model: 'fake-model',
  async chat() { return 'unused'; },
  async healthCheck() { return { available: true, modelAvailable: true, model: 'fake-model' }; },
  async *stream(messages: AIMessage[], _options, signal?: AbortSignal) {
    seenPrompts.push(messages);
    yield 'Hello ';
    if (slowMode) {
      await new Promise<void>((resolve) => { signal?.addEventListener('abort', () => resolve()); setTimeout(resolve, 5000); });
      return;
    }
    yield 'from **fake**.';
  },
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-studio-'));
  process.env.JARVIS_OWNER_CONTROL_TOKEN = 'studio-owner-token-0123456789abcdefghij';
  process.env.JARVIS_STUDIO_DIR = join(dir, 'studio');
  process.env.JARVIS_SITE_CLIENTS_PATH = join(dir, 'site-clients.json');
  server = new JarvisServer(PORT, join(dir, 'audit.log'), join(dir, 'devices.json'));
  server.setStudioProviderFactory(() => ({ provider: fakeProvider, model: 'fake-model' }));
  await server.start();
  owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  reader = enroll([Permission.SYSTEM_INFO_READ]);
});

after(async () => {
  await server.stop();
  if (previousEnv.token === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN; else process.env.JARVIS_OWNER_CONTROL_TOKEN = previousEnv.token;
  if (previousEnv.studio === undefined) delete process.env.JARVIS_STUDIO_DIR; else process.env.JARVIS_STUDIO_DIR = previousEnv.studio;
  if (previousEnv.sites === undefined) delete process.env.JARVIS_SITE_CLIENTS_PATH; else process.env.JARVIS_SITE_CLIENTS_PATH = previousEnv.sites;
  rmSync(dir, { recursive: true, force: true });
});

test('the Studio shell is served, and path traversal or unknown files are not', async () => {
  const page = await call('GET', '/studio', null);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /<title>JARVIS Studio<\/title>/);
  assert.match(html, /<section id="code-view"/);
  assert.equal((await call('GET', '/studio/studio.js', null)).status, 200);
  assert.equal((await call('GET', '/studio/studio.css', null)).status, 200);
  assert.equal((await call('GET', '/studio/..%2fpackage.json', null)).status, 404);
  assert.equal((await call('GET', '/studio/../../package.json', null)).status, 404);
  assert.equal((await call('GET', '/studio/studioStore.ts', null)).status, 404);
});

test('chat API requires a signed owner session', async () => {
  assert.equal((await call('GET', '/api/studio/conversations', null)).status, 401);
  assert.equal((await call('POST', '/api/studio/conversations', null, {})).status, 401);
  assert.equal((await call('GET', '/api/studio/conversations', reader)).status, 403);
  assert.equal((await call('GET', '/api/studio/conversations', { ...owner, privateKey: reader.privateKey })).status, 401);
});

test('conversations: create, list, search, get, rename, delete', async () => {
  const created = await call('POST', '/api/studio/conversations', owner, { title: 'Garden plan' });
  assert.equal(created.status, 201);
  const { conversation } = await created.json() as { conversation: { id: string; title: string } };
  assert.equal(conversation.title, 'Garden plan');

  const listed = await (await call('GET', '/api/studio/conversations', owner)).json() as { conversations: Array<{ id: string }> };
  assert.ok(listed.conversations.some((item) => item.id === conversation.id));
  const searched = await (await call('GET', '/api/studio/conversations?q=garden', owner)).json() as { conversations: unknown[] };
  assert.equal(searched.conversations.length, 1);
  const missed = await (await call('GET', '/api/studio/conversations?q=zzzz', owner)).json() as { conversations: unknown[] };
  assert.equal(missed.conversations.length, 0);

  assert.equal((await call('GET', `/api/studio/conversations/${conversation.id}`, owner)).status, 200);
  const renamed = await call('PATCH', `/api/studio/conversations/${conversation.id}`, owner, { title: 'Garden plan v2' });
  assert.equal(renamed.status, 200);
  assert.equal(((await renamed.json()) as { conversation: { title: string } }).conversation.title, 'Garden plan v2');
  assert.equal((await call('PATCH', `/api/studio/conversations/${conversation.id}`, owner, { title: '   ' })).status, 400);
  assert.equal((await call('PATCH', `/api/studio/conversations/${conversation.id}`, owner, { nothing: true })).status, 400);

  assert.equal((await call('GET', '/api/studio/conversations/not-an-id', owner)).status, 400);
  assert.equal((await call('GET', '/api/studio/conversations/00000000-0000-4000-8000-000000000000', owner)).status, 404);

  assert.equal((await call('DELETE', `/api/studio/conversations/${conversation.id}`, owner)).status, 200);
  assert.equal((await call('GET', `/api/studio/conversations/${conversation.id}`, owner)).status, 404);

  // Conversations are stored encrypted: the title never appears in plaintext on disk.
  const files = readdirSync(dir).filter((name) => name.endsWith('.studio'));
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(dir, files[0]!), 'utf8').includes('Garden'), false);
});

test('send streams SSE from the provider, persists both turns and uses approved memory as context', async () => {
  server.getService().personalMemory!.save('preference', 'Owner prefers metric units');
  const { conversation } = await (await call('POST', '/api/studio/conversations', owner, {})).json() as { conversation: { id: string } };
  seenPrompts.length = 0;
  const response = await call('POST', `/api/studio/conversations/${conversation.id}/send`, owner, { text: 'Which metric units should I use for a recipe?' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
  const events = sseEvents(await response.text());
  assert.deepEqual(events.map((item) => item.event), ['meta', 'delta', 'delta', 'done']);
  assert.equal(events.filter((item) => item.event === 'delta').map((item) => item.data.text).join(''), 'Hello from **fake**.');
  assert.ok(events[0]!.data.sources.some((label: string) => label.startsWith('memory:')));

  const prompt = seenPrompts[0]!;
  assert.equal(prompt[0]!.role, 'system');
  assert.ok(prompt.some((message) => message.content.includes('Owner prefers metric units')), 'approved memory is supplied as context');
  assert.equal(prompt.at(-1)!.content, 'Which metric units should I use for a recipe?');

  const stored = (await (await call('GET', `/api/studio/conversations/${conversation.id}`, owner)).json() as { conversation: { title: string; messages: Array<{ role: string; content: string }> } }).conversation;
  assert.deepEqual(stored.messages.map((message) => message.role), ['user', 'assistant']);
  assert.equal(stored.messages[1]!.content, 'Hello from **fake**.');
  assert.match(stored.title, /Which metric units/);

  assert.equal((await call('POST', `/api/studio/conversations/${conversation.id}/send`, owner, { text: '' })).status, 400);
  assert.equal((await call('POST', `/api/studio/conversations/${conversation.id}/send`, owner, { text: 'hi', model: 'bad model!' })).status, 400);

  const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
  assert.match(audit, /STUDIO_MESSAGE_SENT/);
  assert.equal(audit.includes('metric units'), false, 'chat text never enters the audit log');
});

test('stop: aborting a stream keeps the partial reply and marks it stopped', async () => {
  const { conversation } = await (await call('POST', '/api/studio/conversations', owner, {})).json() as { conversation: { id: string } };
  slowMode = true;
  try {
    const response = await call('POST', `/api/studio/conversations/${conversation.id}/send`, owner, { text: 'Tell me a very long story' });
    const streamReader = response.body!.getReader();
    const first = await streamReader.read();
    assert.ok(first.value && first.value.length > 0);
    const abort = await call('POST', `/api/studio/conversations/${conversation.id}/abort`, owner, {});
    assert.equal(((await abort.json()) as { aborted: boolean }).aborted, true);
    let tail = '';
    while (true) { const chunk = await streamReader.read(); if (chunk.done) break; tail += new TextDecoder().decode(chunk.value); }
    assert.match(tail, /event: done/);
  } finally { slowMode = false; }
  const stored = (await (await call('GET', `/api/studio/conversations/${conversation.id}`, owner)).json() as { conversation: { messages: Array<{ role: string; stopped?: boolean; content: string }> } }).conversation;
  assert.equal(stored.messages[1]!.stopped, true);
  assert.match(stored.messages[1]!.content, /^Hello/);
});

test('an unavailable provider returns 503 and no stream', async () => {
  const { conversation } = await (await call('POST', '/api/studio/conversations', owner, {})).json() as { conversation: { id: string } };
  server.setStudioProviderFactory(() => null);
  try {
    assert.equal((await call('POST', `/api/studio/conversations/${conversation.id}/send`, owner, { text: 'hello there' })).status, 503);
  } finally { server.setStudioProviderFactory(() => ({ provider: fakeProvider, model: 'fake-model' })); }
});

test('API keys: the site key is revealed exactly once', async () => {
  const service = server.getService();
  const created = service.gatewaySites.execute('gateway:site_create', { name: 'studio-test-site' }, 'device-x');
  assert.equal(created.success, true);
  const token = (created.data as { revealToken: string }).revealToken;
  assert.equal(JSON.stringify(created.data).includes('"apiKey"'), false, 'the key is never in the task result');
  // The reveal is bound to the creating device; use the owner device id for this check.
  const ownerDeviceId = service.identity.listDevices().find((device) => device.permissions.includes(Permission.DEVICE_MANAGE))!.id;
  const second = service.gatewaySites.execute('gateway:site_create', { name: 'studio-test-site-2' }, ownerDeviceId);
  const secondToken = (second.data as { revealToken: string }).revealToken;
  assert.equal((await call('POST', '/api/gateway/sites/reveal', owner, { revealToken: token })).status, 404, 'another device cannot take it');
  const first = await call('POST', '/api/gateway/sites/reveal', owner, { revealToken: secondToken });
  assert.equal(first.status, 200);
  assert.match(((await first.json()) as { apiKey: string }).apiKey, /\S{16,}/);
  assert.equal((await call('POST', '/api/gateway/sites/reveal', owner, { revealToken: secondToken })).status, 404, 'a second reveal fails');
  const list = JSON.stringify(await (await call('GET', '/api/gateway/sites', owner)).json());
  assert.equal(list.includes('keyHash'), false);
});

test('the Studio UI never persists keys in browser storage or renders model output via innerHTML', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'studio', 'studio.js'), 'utf8');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(source), false);
  const storageKeys = [...source.matchAll(/prefs\.(?:get|set)\('([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(storageKeys)].sort(), ['studio.model', 'studio.theme']);
  assert.equal(/sessionStorage|console\.(log|info|debug)/.test(source), false);
});

test('training export includes only conversations the owner marked, minus bad or sensitive ones', async () => {
  const make = async (title: string, turns: Array<[string, string]>, train: boolean) => {
    const { conversation } = await (await call('POST', '/api/studio/conversations', owner, { title })).json() as { conversation: { id: string } };
    const store = (server as unknown as { studio: { deps: { store: { appendMessage(id: string, m: object): void } } } }).studio.deps.store;
    for (const [user, assistant] of turns) {
      store.appendMessage(conversation.id, { role: 'user', content: user });
      store.appendMessage(conversation.id, { role: 'assistant', content: assistant });
    }
    if (train) await call('PATCH', `/api/studio/conversations/${conversation.id}`, owner, { useForTraining: true });
    return conversation.id;
  };
  await make('Approved chat', [['TEST DATA: name a fruit', 'TEST DATA: an apple']], true);
  await make('Not approved chat', [['TEST DATA: secret hobby', 'TEST DATA: unapproved reply']], false);
  await make('Contains secret', [['TEST DATA: store this', 'TEST DATA: api_key = abcdef1234567890xyz']], true);
  const mixed = await make('Mixed ratings', [['TEST DATA: first question', 'TEST DATA: good answer'], ['TEST DATA: second question', 'TEST DATA: poor answer']], true);
  const mixedConversation = (await (await call('GET', `/api/studio/conversations/${mixed}`, owner)).json() as { conversation: { messages: Array<{ id: string; role: string }> } }).conversation;
  const poor = mixedConversation.messages.filter((message) => message.role === 'assistant')[1]!;
  assert.equal((await call('POST', `/api/studio/conversations/${mixed}/rate`, owner, { messageId: poor.id, rating: 'down' })).status, 200);

  assert.equal((await call('POST', '/api/studio/training/export', owner, {})).status, 400, 'export needs explicit confirmation');
  const exported = await call('POST', '/api/studio/training/export', owner, { confirm: true });
  assert.equal(exported.status, 200);
  const result = await exported.json() as { records: number; file: string };
  assert.equal(result.records, 2);
  const folder = join(dir, 'studio', 'training');
  const files = readdirSync(folder);
  assert.equal(files.length, 1);
  const text = readFileSync(join(folder, files[0]!), 'utf8');
  const lines = text.trim().split('\n').map((line) => JSON.parse(line) as { messages: Array<{ role: string; content: string }> });
  assert.equal(lines.length, 2);
  assert.equal(text.includes('unapproved reply'), false);
  assert.equal(text.includes('abcdef1234567890xyz'), false);
  assert.equal(text.includes('poor answer'), false);
  assert.equal(text.includes('good answer'), true);
  assert.ok(lines.every((line) => line.messages[0]!.role === 'system' && validateTrainingRecord(line).length === 0));
});

test('persona and local model build: persona saved, build needs approval and never runs directly', async () => {
  const saved = await call('PUT', '/api/studio/persona', owner, { persona: 'You are terse.', baseModel: 'llama3.2:latest' });
  assert.equal(saved.status, 200);
  assert.equal(((await (await call('GET', '/api/studio/persona', owner)).json()) as { persona: string }).persona, 'You are terse.');
  assert.equal((await call('PUT', '/api/studio/persona', owner, { persona: 'x', baseModel: 'bad model;rm' })).status, 400);
  const preview = await (await call('GET', '/api/studio/modelfile', owner)).json() as { modelfile: string };
  assert.match(preview.modelfile, /^FROM llama3\.2:latest\nSYSTEM """You are terse\."""/);
  assert.equal((await call('POST', '/api/studio/model/build', owner, {})).status, 400, 'confirm flag is required');
  const buildResponse = await call('POST', '/api/studio/model/build', owner, { confirm: true });
  const build = await buildResponse.json() as { approvalId?: string; state: string };
  assert.ok(build.approvalId, 'the build waits for owner approval');
  assert.equal(build.state, 'AWAITING_APPROVAL');
  assert.equal(readdirSync(join(dir, 'studio')).includes('models'), false, 'nothing was written or run before approval');
});

test('HTML escaping helper and markdown renderer never emit markup', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)"> & \'q\''), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;');
  assert.equal(escapeHtml(undefined), '');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,<b>x</b>'), null);
  assert.equal(safeUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  const tree = parseMarkdown('# Title\n\n<script>alert(1)</script> and [bad](javascript:alert(1)) and [ok](https://example.com)\n\n```ts\nconst a = "<b>";\n```\n');
  const json = JSON.stringify(tree);
  assert.ok(tree.some((node) => node.type === 'code' && node.lang === 'ts' && node.value === 'const a = "<b>";'));
  const links = json.match(/"type":"link","href":"([^"]+)"/g) ?? [];
  assert.equal(links.length, 1);
  assert.match(json, /<script>alert\(1\)<\/script>/, 'markup stays inert text inside a text node');
  assert.ok(!json.includes('"href":"javascript'));
  // An unterminated fence from a streaming reply still renders as code.
  assert.equal(parseMarkdown('```py\nprint(1)').at(0)?.type, 'code');
});

test('Modelfile generation cannot be broken out of by the persona text', () => {
  const file = buildModelfile('llama3.2:latest', 'Be nice.\n"""\nPARAMETER num_ctx 1');
  assert.equal(file.split('"""').length, 3, 'exactly one opening and one closing delimiter');
  assert.throws(() => buildModelfile('bad model', 'x'));
  assert.throws(() => buildModelfile('llama3.2', '   '));
});

test('training helpers: validation, secrets, test-data label, duplicates, and the merge script', () => {
  assert.equal(looksSensitive('my token = abcdefghijklmnop'), true);
  assert.equal(looksSensitive('plain chat'), false);
  assert.ok(validateTrainingRecord({ messages: [{ role: 'user', content: 'a' }] }).length > 0);
  const { record } = conversationToTrainingRecord({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a', rating: 'down' }] }, 'p');
  assert.equal(record, null);
  const good = { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] };
  assert.equal(mergeTrainingRecords([good, good]).kept.length, 1);

  const fixtures = join('test', 'fixtures', 'training');
  const run = (...args: string[]) => JSON.parse(execFileSync(process.execPath, ['scripts/build-training-set.mjs', ...args], { cwd: process.cwd(), encoding: 'utf8' })) as { read: number; kept: number; rejected: number };
  const excluded = run(fixtures);
  assert.deepEqual([excluded.read, excluded.kept, excluded.rejected], [3, 0, 3], 'labelled test data is excluded by default');
  const out = join(dir, 'merged.jsonl');
  const included = run('--include-test-data', '--out', out, fixtures);
  assert.equal(included.kept, 3);
  assert.equal(readFileSync(out, 'utf8').trim().split('\n').length, 3);
  assert.match(readFileSync(join(fixtures, 'demo-training.jsonl'), 'utf8'), /TEMPORARY \/ TEST DATA/);
});

test('Studio code mount point is an empty section and nothing under src/studio/code is created here', () => {
  const html = readFileSync(join(process.cwd(), 'src', 'studio', 'index.html'), 'utf8');
  assert.match(html, /<section id="code-view"[^>]*><\/section>/);
  assert.match(readFileSync(join(process.cwd(), 'src', 'studio', 'studio.js'), 'utf8'), /registerView/);
});

test('step-up: totpCode is sent only when TOTP is ENABLED, validated as 6 digits, retried on 401, never stored', async () => {
  const sent: Array<Record<string, unknown>> = [];
  const send = async (body: Record<string, unknown>) => { sent.push(body); return { ok: true }; };

  await withStepUp({ getStatus: async () => 'DISABLED', askCode: async () => { throw new Error('must not prompt'); }, send }, { approvalId: 'a1' });
  assert.deepEqual(sent[0], { approvalId: 'a1' }, 'no code is sent when TOTP is disabled');

  const answers = ['12ab56', '123', '123456'];
  const errors: string[] = [];
  await withStepUp({ getStatus: async () => 'ENABLED', askCode: async (error) => { errors.push(error); return answers.shift()!; }, send }, { approvalId: 'a2' });
  assert.deepEqual(sent[1], { approvalId: 'a2', totpCode: '123456' });
  assert.equal(sent.length, 2, 'invalid codes never reach the server');
  assert.equal(errors.length, 3);
  assert.match(errors[1]!, /6-digit/);

  // A 401 shows the verification message and lets the owner retry.
  let attempts = 0;
  const codes = ['111111', '222222'];
  const seenErrors: string[] = [];
  const result = await withStepUp({
    getStatus: async () => 'ENABLED',
    askCode: async (error) => { seenErrors.push(error); return codes.shift()!; },
    send: async (body) => { attempts += 1; if (body['totpCode'] === '111111') throw Object.assign(new Error('x'), { status: 401 }); return body; },
  }, {});
  assert.equal(attempts, 2);
  assert.equal(seenErrors[1], 'Fresh authenticator verification required');
  assert.deepEqual(result, { totpCode: '222222' });

  await assert.rejects(withStepUp({ getStatus: async () => 'ENABLED', askCode: async () => null, send }, {}), /cancelled/);
  assert.equal(isValidTotpCode('123456'), true);
  assert.equal(isValidTotpCode('12345'), false);
  assert.equal(isValidTotpCode('1234567'), false);

  const source = readFileSync(join(process.cwd(), 'src', 'studio', 'studio.js'), 'utf8');
  assert.match(source, /stepUpPost\('\/api\/approval\/approve'/);
  assert.match(source, /stepUpPost\('\/api\/gateway\/sites\/reveal'/);
  assert.match(source, /input\.value = ''; \/\/ the code is never kept/);
});

test('the TOTP status endpoint the Studio consults answers for the owner device', async () => {
  const response = await call('GET', '/api/security/totp/status', owner);
  assert.equal(response.status, 200);
  assert.ok(['ENABLED', 'DISABLED'].includes(((await response.json()) as { status: string }).status));
});

test('chat answers about past work use approved development episodes only, with the fix and error included', async () => {
  const store = (server as unknown as { episodeStore: import('../src/learning/episodeStore.js').EpisodeStore }).episodeStore;
  const base = { schemaVersion: 1 as const, source: 'claude-code', startedAt: '2026-01-03T10:00:00.000Z', workspace: 'demo-app', assistantGenerated: true };
  store.ingest({ ...base, id: 'epapproved0001', prompt: 'TEMPORARY / TEST DATA: make widgetize reject empty names', steps: [
    { kind: 'command', command: 'python test_widget.py', commandClass: 'test', exitCode: 1, assistantGenerated: true, outputTail: "AttributeError: 'NoneType' object has no attribute 'strip'" },
    { kind: 'edit', path: 'widget.py', assistantGenerated: true, diff: '- if not name.strip():\n+ if not isinstance(name, str) or not name.strip():' },
    { kind: 'command', command: 'python test_widget.py', commandClass: 'test', exitCode: 0, assistantGenerated: true },
  ], assistantSummary: 'Guarded widgetize against None.', outcome: { status: 'success' } }, 'k');
  store.approve('epapproved0001');
  store.ingest({ ...base, id: 'eppending00001', prompt: 'TEMPORARY / TEST DATA: widgetize secret pending plan', steps: [], assistantSummary: 'pending widgetize note', outcome: { status: 'unknown' } }, 'k');

  const { conversation } = await (await call('POST', '/api/studio/conversations', owner, {})).json() as { conversation: { id: string } };
  seenPrompts.length = 0;
  const response = await call('POST', `/api/studio/conversations/${conversation.id}/send`, owner, { text: 'Why did widgetize fail and how was it fixed?' });
  const events = sseEvents(await response.text());
  assert.ok(events[0]!.data.sources.includes('episode:epapproved0001'));
  const context = seenPrompts[0]!.map((message) => message.content).join('\n');
  assert.ok(context.includes('isinstance(name, str)'), 'the fix diff reaches the model');
  assert.ok(context.includes('AttributeError'), 'the failing error output reaches the model');
  assert.ok(context.includes('Guarded widgetize against None.'));
  assert.equal(context.includes('pending widgetize note'), false, 'pending episodes are never used');
  assert.ok(context.includes('never invent code, commits, tests or history'), 'the no-invention rule is in the system prompt');
});
