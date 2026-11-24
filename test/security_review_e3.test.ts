import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { freePort } from './helpers/freePort.js';
import { JarvisServer } from '../src/server/server.js';
import { chatCompletion } from '../src/ai/providerClient.js';

const PORT = await freePort();
const TOKEN = 'e3-security-review-token-0123456789abcdef';
const previous = process.env.JARVIS_OWNER_CONTROL_TOKEN;
let server: JarvisServer;
let dir: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-e3-sec-'));
  process.env.JARVIS_OWNER_CONTROL_TOKEN = TOKEN;
  server = new JarvisServer(PORT, join(dir, 'audit.log'), join(dir, 'devices.json'));
  await server.start();
});
after(async () => {
  await server.stop();
  if (previous === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN; else process.env.JARVIS_OWNER_CONTROL_TOKEN = previous;
  rmSync(dir, { recursive: true, force: true });
});

function getWithHost(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path: '/api/status', headers: { host } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

test('E3:D4.13 DNS rebinding: foreign Host headers are refused, loopback names work', async () => {
  assert.equal(await getWithHost(`evil.example.com:${PORT}`), 403);
  assert.equal(await getWithHost('127.0.0.1.evil.example'), 403);
  assert.equal(await getWithHost(`127.0.0.1:${PORT}`), 200);
  assert.equal(await getWithHost(`localhost:${PORT}`), 200);
});

test('E3:D4.13 owner-token guessing on bootstrap enrollment is rate limited and audited without the token', async () => {
  const attempt = (token: string) => fetch(`http://127.0.0.1:${PORT}/api/enrollment/challenge`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-owner-control-token': token }, body: '{}' });
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt(`wrong-guess-${i}-`.padEnd(40, 'x'))).status, 401);
  assert.equal((await attempt(TOKEN)).status, 429, 'even the right token is refused while locked out');
  const records = JSON.stringify(server.getService().audit.getRecords());
  assert.ok(records.includes('OWNER_ENROLLMENT_AUTH_REJECTED'));
  assert.equal(records.includes(TOKEN), false);
});

test('E3:D4.13 cloud provider calls never follow redirects (API key cannot be forwarded)', async () => {
  const original = globalThis.fetch;
  const seen: Array<RequestInit | undefined> = [];
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => { seen.push(init); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'ok' }], choices: [{ message: { content: 'ok' } }] }), { status: 200 }); }) as typeof fetch;
  try {
    for (const format of ['anthropic', 'openai'] as const) {
      await chatCompletion({ id: format, format, baseUrl: 'https://api.example.com/v1', model: 'm', apiKey: 'k', local: false, cost: 'paid' } as never, [{ role: 'user', content: 'hi' }], {}, new AbortController().signal).catch(() => undefined);
    }
  } finally { globalThis.fetch = original; }
  assert.equal(seen.length, 2);
  for (const init of seen) assert.equal(init?.redirect, 'error');
});
