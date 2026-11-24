// TEMPORARY / TEST DATA: fictional episodes and fake credentials only (E3:D4.17).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/freePort.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import { redactText, isExcludedPath } from '../src/learning/redaction.js';
import { exportEpisodes, EpisodeStore } from '../src/learning/episodeStore.js';

const PORT = await freePort();
let server: JarvisServer;
let dir: string;
let ingestKey: string;
const previousToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;
const previousKeys = process.env.JARVIS_INGEST_KEYS_PATH;
const previousEpisodes = process.env.JARVIS_EPISODES_PATH;
const base = `http://127.0.0.1:${PORT}`;

type Who = { sessionId: string; privateKey: string };
function enroll(permissions: Permission[]): Who {
  const service = server.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'learn-test', keys.publicKey);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  return { sessionId: session.sessionId!, privateKey: keys.privateKey };
}
function signed(method: 'GET' | 'POST', path: string, who: Who, body?: unknown) {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const canonical = CryptoUtil.buildCanonicalRequestString(method, path.split('?')[0]!, who.sessionId, timestamp, nonce, body);
  return fetch(base + path, {
    method,
    headers: {
      'x-session-id': who.sessionId, 'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce,
      'x-request-signature': CryptoUtil.signData(canonical, who.privateKey),
      ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
    },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
}
const postEpisode = (episode: unknown, key = ingestKey) => fetch(`${base}/api/learning/episodes`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-jarvis-ingest-key': key }, body: JSON.stringify(episode),
});
const FAKE_KEY = 'sk-' + 'a1b2c3d4e5f6g7h8i9j0k1l2';
const episode = (id: string, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id, source: 'claude-code', startedAt: '2026-01-01T10:00:00.000Z', assistantGenerated: true,
  prompt: 'fix the failing parser test for widgets', workspace: 'demo',
  steps: [
    { kind: 'edit', path: 'src/widgets.ts', assistantGenerated: true, summary: 'edit' },
    { kind: 'command', command: 'npm test', commandClass: 'test', exitCode: 0, assistantGenerated: false, outputTail: 'pass 12' },
  ],
  outcome: { status: 'success', summary: 'tests pass' },
  ...extra,
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-'));
  process.env.JARVIS_OWNER_CONTROL_TOKEN = 'learning-owner-token-0123456789abcdef012345';
  process.env.JARVIS_INGEST_KEYS_PATH = join(dir, 'ingest-keys.json');
  process.env.JARVIS_EPISODES_PATH = join(dir, 'episodes.enc');
  server = new JarvisServer(PORT, join(dir, 'audit.log'), join(dir, 'devices.json'));
  await server.start();
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const created = await signed('POST', '/api/learning/ingest-keys/create', owner, { name: 'vscode-test' });
  assert.equal(created.status, 201);
  ingestKey = ((await created.json()) as { ingestKey: string }).ingestKey;
});

after(async () => {
  await server.stop();
  for (const [name, value] of [['JARVIS_OWNER_CONTROL_TOKEN', previousToken], ['JARVIS_INGEST_KEYS_PATH', previousKeys], ['JARVIS_EPISODES_PATH', previousEpisodes]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

test('ingest key is stored hashed only', () => {
  const file = readFileSync(join(dir, 'ingest-keys.json'), 'utf8');
  assert.equal(file.includes(ingestKey), false);
  assert.match(file, /"keyHash"/);
});

test('ingest requires a valid key', async () => {
  const none = await fetch(`${base}/api/learning/episodes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(episode('noauth0001')) });
  assert.equal(none.status, 401);
  const bad = await postEpisode(episode('badkey0001'), 'jli_000000000000_' + 'A'.repeat(43));
  assert.equal(bad.status, 401);
});

test('ingest key cannot reach any other API or the owner learning routes', async () => {
  for (const [method, path] of [['GET', '/api/memory'], ['POST', '/api/request'], ['GET', '/api/devices'], ['GET', '/api/memory/export'],
    ['POST', '/api/documents/search'], ['GET', '/api/learning/episodes'], ['GET', '/api/learning/recipes'], ['GET', '/api/learning/export']] as const) {
    const response = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-jarvis-ingest-key': ingestKey, authorization: `Bearer ${ingestKey}` },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });
    assert.ok([401, 403].includes(response.status), `${method} ${path} -> ${response.status}`);
  }
});

test('server-side redaction runs on ingest and nothing secret is stored', async () => {
  const dirty = episode('redact00001', {
    prompt: `use ${FAKE_KEY} and mail me at someone@example.com`,
    steps: [
      { kind: 'command', command: 'curl -H "Authorization: Bearer abcdefghijklmnop12345" https://x.test', assistantGenerated: false },
      { kind: 'edit', path: 'config/.env.local', assistantGenerated: true, summary: 'should be dropped' },
      { kind: 'save', path: 'src/ok.ts', assistantGenerated: false },
    ],
  });
  const response = await postEpisode(dirty);
  assert.equal(response.status, 201);
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const list = await (await signed('GET', '/api/learning/episodes?status=pending', owner)).json() as { episodes: Array<{ id: string; status: string; episode: { prompt: string; steps: Array<{ path?: string; command?: string }> } }> };
  const stored = list.episodes.find((e) => e.id === 'redact00001')!;
  assert.equal(stored.status, 'pending');
  const text = JSON.stringify(stored);
  assert.equal(text.includes(FAKE_KEY), false);
  assert.equal(text.includes('someone@example.com'), false);
  assert.equal(text.includes('abcdefghijklmnop12345'), false);
  assert.equal(stored.episode.steps.some((s) => s.path?.includes('.env')), false);
  assert.equal(stored.episode.steps.length, 2);
  // Encrypted at rest.
  assert.equal(readFileSync(join(dir, 'episodes.enc'), 'utf8').includes('widgets'), false);
});

test('invalid schema is rejected', async () => {
  assert.equal((await postEpisode({ schemaVersion: 2 })).status, 400);
  assert.equal((await postEpisode(episode('badstep0001', { steps: [{ kind: 'nope', assistantGenerated: true }] }))).status, 400);
});

test('owner routes need a DEVICE_MANAGE session', async () => {
  assert.equal((await fetch(`${base}/api/learning/episodes`)).status, 401);
  const reader = enroll([Permission.SYSTEM_INFO_READ]);
  assert.equal((await signed('GET', '/api/learning/episodes', reader)).status, 403);
});

test('pending -> approve flow makes episodes searchable and a recipe; reject drops content', async () => {
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  assert.equal((await postEpisode(episode('approve00001'))).status, 201);
  assert.equal((await postEpisode(episode('reject000001', { prompt: 'secret-ish unwanted thing' }))).status, 201);
  assert.equal((await postEpisode(episode('approve00001'))).status, 200); // idempotent

  // Not searchable while pending.
  let search = await (await signed('POST', '/api/learning/search', owner, { query: 'failing parser widgets' })).json() as { results: unknown[] };
  assert.equal(search.results.length, 0);

  assert.equal((await signed('POST', '/api/learning/episodes/approve', owner, { id: 'approve00001' })).status, 200);
  assert.equal((await signed('POST', '/api/learning/episodes/reject', owner, { id: 'reject000001' })).status, 200);
  assert.equal((await signed('POST', '/api/learning/episodes/approve', owner, { id: 'approve00001' })).status, 409);

  search = await (await signed('POST', '/api/learning/search', owner, { query: 'failing parser widgets' })).json() as { results: Array<{ id: string }> };
  assert.equal(search.results[0] && (search.results[0] as { id: string }).id, 'approve00001');
  const recipes = await (await signed('GET', '/api/learning/recipes', owner)).json() as { recipes: Array<{ id: string; commands: Array<{ command: string }>; outcome: { status: string } }> };
  const recipe = recipes.recipes.find((r) => r.id === 'approve00001')!;
  assert.equal(recipe.commands[0]?.command, 'npm test');
  assert.equal(recipe.outcome.status, 'success');
  const rejected = await (await signed('GET', '/api/learning/episodes?status=rejected', owner)).json() as { episodes: Array<{ episode: { prompt?: string } }> };
  assert.equal(rejected.episodes[0]?.episode.prompt, undefined);
});

test('export excludes assistant-generated content by default and honours the owner setting', async () => {
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const excluded = await (await signed('GET', '/api/learning/export', owner)).json() as { assistantContentIncluded: boolean; episodes: Array<{ id: string; steps: Array<{ assistantGenerated: boolean }> }> };
  assert.equal(excluded.assistantContentIncluded, false);
  const ep = excluded.episodes.find((e) => e.id === 'approve00001')!;
  assert.ok(ep.steps.length > 0 && ep.steps.every((s) => s.assistantGenerated === false));
  assert.equal(JSON.stringify(excluded).includes('src/widgets.ts'), false);

  assert.equal((await signed('POST', '/api/learning/settings', owner, { allowAssistantContentInExport: true })).status, 200);
  const included = await (await signed('GET', '/api/learning/export', owner)).json() as { episodes: Array<{ id: string; steps: unknown[] }> };
  assert.equal(included.episodes.find((e) => e.id === 'approve00001')!.steps.length, 2);
  await signed('POST', '/api/learning/settings', owner, { allowAssistantContentInExport: false });
});

test('exportEpisodes pure function drops assistant steps, summary and diffs', () => {
  const file = join(dir, 'pure.enc');
  const store = new EpisodeStore(file, 'learning-owner-token-0123456789abcdef012345');
  store.ingest(episode('pure00000001', { assistantSummary: 'AI wrote this', steps: [
    { kind: 'edit', path: 'a.ts', assistantGenerated: true, diff: '+ai code' },
    { kind: 'command', command: 'npm run build', commandClass: 'build', exitCode: 0, assistantGenerated: false },
  ] }), 'k');
  store.approve('pure00000001');
  const rows = exportEpisodes(store.list(), false);
  const text = JSON.stringify(rows);
  assert.equal(text.includes('AI wrote this'), false);
  assert.equal(text.includes('+ai code'), false);
  assert.ok(text.includes('npm run build'));
  assert.equal(store.settings.allowAssistantContentInExport, false);
});

test('delete-all removes everything; revoked keys stop working; actions are audited', async () => {
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const removed = await (await signed('POST', '/api/learning/episodes/delete-all', owner, {})).json() as { removed: number };
  assert.ok(removed.removed >= 3);
  const list = await (await signed('GET', '/api/learning/episodes', owner)).json() as { episodes: unknown[] };
  assert.equal(list.episodes.length, 0);
  const keys = await (await signed('GET', '/api/learning/ingest-keys', owner)).json() as { keys: Array<{ id: string; keyHash?: string }> };
  assert.equal(keys.keys[0]?.keyHash, undefined);
  assert.equal((await signed('POST', '/api/learning/ingest-keys/revoke', owner, { id: keys.keys[0]!.id })).status, 200);
  assert.equal((await postEpisode(episode('afterrevoke1'))).status, 401);
  const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
  for (const event of ['LEARNING_EPISODE_RECEIVED', 'LEARNING_EPISODE_APPROVED', 'LEARNING_EPISODES_DELETED_ALL', 'LEARNING_INGEST_KEY_REVOKED']) assert.match(audit, new RegExp(event));
  assert.equal(audit.includes(FAKE_KEY), false);
});

test('rate limit applies per key', async () => {
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const created = await (await signed('POST', '/api/learning/ingest-keys/create', owner, { name: 'slow-key', requestsPerMinute: 2 })).json() as { ingestKey: string };
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await postEpisode(episode(`rate0000000${i}`), created.ingestKey)).status);
  assert.deepEqual(statuses, [201, 201, 429, 429]);
});

test('redaction patterns and excluded paths', () => {
  const samples = [
    FAKE_KEY, 'ghp_' + 'A'.repeat(36), 'gho_' + 'B'.repeat(36), 'xoxb-1234567890-abcdefghij', 'AKIA' + 'ABCDEFGHIJKLMNOP',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk', 'Bearer abcdefghijklmnopqrstuv',
    '-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBg\n-----END PRIVATE KEY-----', 'password=hunter2hunter2', 'token: "abcd1234efgh"',
    'postgres://admin:s3cretpw@db.local:5432/app', 'jane.doe@example.org', 'call +1 415-555-0134 now',
  ];
  for (const sample of samples) assert.notEqual(redactText(sample), sample, sample);
  assert.equal(redactText('plain build output 12 passed'), 'plain build output 12 passed');
  assert.equal(redactText('a@b.co', { emails: false, phones: true }), 'a@b.co');
  for (const p of ['.env', '.env.local', 'a/b/server.pem', 'k.key', 'C:\\x\\id_rsa', 'Token.txt', 'credentials.json']) assert.ok(isExcludedPath(p), p);
  assert.equal(isExcludedPath('src/environment.ts'), false);
});
