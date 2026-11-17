import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname, userInfo } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import { freePort } from './helpers/freePort.js';

/**
 * JARVIS-US-023 / JAR-E10: monitoring surfaces are authorization-gated, redacted and bounded, and
 * persistence/audit failure is observable and fails closed.
 */
const OWNER_TOKEN = 'monitoring-endpoints-owner-token-0123456789abc';
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-monitoring-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const service = server.getService();
  const device = (permissions: Permission[]) => {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge(permissions);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'monitor-test', keys.publicKey);
    const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
    const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, keys.privateKey), ts, nonce);
    return { sessionId: session.sessionId!, privateKey: keys.privateKey };
  };
  const get = async (path: string, who: { sessionId: string; privateKey: string } | undefined) => {
    if (!who) { const r = await fetch(base + path); return { status: r.status, text: await r.text() }; }
    const t = Date.now(); const n = CryptoUtil.randomToken(16);
    const canonical = CryptoUtil.buildCanonicalRequestString('GET', path, who.sessionId, t, n, undefined);
    const r = await fetch(base + path, { headers: { 'x-session-id': who.sessionId, 'x-request-timestamp': String(t), 'x-request-nonce': n, 'x-request-signature': CryptoUtil.signData(canonical, who.privateKey) } });
    return { status: r.status, text: await r.text() };
  };
  return { dir, server, service, device, get, cleanup: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('resource, provider and audit monitoring require device management; unauthenticated and ordinary devices are refused', async () => {
  const env = await boot();
  try {
    const owner = env.device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const ordinary = env.device([Permission.SYSTEM_INFO_READ]);
    for (const path of ['/api/resources', '/api/ai/providers', '/api/audit']) {
      assert.equal((await env.get(path, undefined)).status, 401, `${path} unauthenticated`);
      assert.equal((await env.get(path, ordinary)).status, 403, `${path} ordinary device`);
      assert.equal((await env.get(path, owner)).status, 200, `${path} owner`);
    }
  } finally { await env.cleanup(); }
});

test('monitoring responses are redacted: no credentials, host/user names, state paths or resource lock names', async () => {
  const saved = { key: process.env.JARVIS_CLOUD_OPENAI_API_KEY, model: process.env.JARVIS_CLOUD_OPENAI_MODEL };
  process.env.JARVIS_CLOUD_OPENAI_API_KEY = 'sk-TESTFIXTURE-monitoring-sentinel';
  process.env.JARVIS_CLOUD_OPENAI_MODEL = 'gpt-monitoring';
  const env = await boot();
  try {
    const owner = env.device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const status = await env.get('/api/status', undefined);
    const bodies = [status.text, (await env.get('/api/resources', owner)).text, (await env.get('/api/ai/providers', owner)).text, (await env.get('/api/audit', owner)).text];
    const forbidden = ['sk-TESTFIXTURE-monitoring-sentinel', OWNER_TOKEN, env.dir, hostname(), userInfo().username];
    for (const body of bodies) for (const secret of forbidden) {
      if (secret.length < 4) continue;
      assert.equal(body.includes(secret), false, `monitoring output leaked ${secret.slice(0, 8)}…`);
    }
    assert.deepEqual(Object.keys(JSON.parse(status.text)).sort(), ['checks', 'platform', 'status', 'uptimeSeconds'], 'the unauthenticated status endpoint exposes only coarse health');
  } finally {
    await env.cleanup();
    if (saved.key === undefined) delete process.env.JARVIS_CLOUD_OPENAI_API_KEY; else process.env.JARVIS_CLOUD_OPENAI_API_KEY = saved.key;
    if (saved.model === undefined) delete process.env.JARVIS_CLOUD_OPENAI_MODEL; else process.env.JARVIS_CLOUD_OPENAI_MODEL = saved.model;
  }
});

test('resource and queue health are bounded and numeric; the task list and audit view are size-bounded', async () => {
  const env = await boot();
  try {
    const owner = env.device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const resources = JSON.parse((await env.get('/api/resources', owner)).text) as Record<string, unknown>;
    assert.ok(resources.ai && typeof resources.ai === 'object');
    const walk = (value: unknown, path: string): void => {
      if (typeof value === 'number') assert.ok(Number.isFinite(value), `${path} is not finite`);
      else if (Array.isArray(value)) { assert.ok(value.length <= 200, `${path} unbounded array`); value.forEach((v, i) => walk(v, `${path}[${i}]`)); }
      else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`);
      else if (typeof value === 'string') assert.ok(value.length <= 2000, `${path} unbounded string`);
    };
    walk(resources, 'resources');
    const snapshot = env.service.taskCoordinator.snapshot();
    assert.equal(JSON.stringify(snapshot).includes('desktop:'), false, 'queue snapshot never exposes resource names');
    const audit = JSON.parse((await env.get('/api/audit', owner)).text) as { records?: unknown[] } | unknown[];
    const records = Array.isArray(audit) ? audit : audit.records ?? [];
    assert.ok(records.length <= 1000, 'audit view is bounded');
  } finally { await env.cleanup(); }
});

test('a tampered audit log is observable via status and blocks execution (fail closed)', async () => {
  const env = await boot();
  try {
    const owner = env.device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE, Permission.APP_LAUNCH]);
    const before = JSON.parse((await env.get('/api/status', undefined)).text) as { checks: { auditIntegrity: boolean } };
    assert.equal(before.checks.auditIntegrity, true);
    const path = join(env.dir, 'audit.log');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    assert.ok(lines.length >= 2);
    lines[1] = lines[1].replace(/"eventType":"[^"]*"/, '"eventType":"FORGED_EVENT"');
    writeFileSync(path, lines.join('\n') + '\n');
    const after = JSON.parse((await env.get('/api/status', undefined)).text) as { checks: { auditIntegrity: boolean } };
    assert.equal(after.checks.auditIntegrity, false, 'tampering is visible to monitoring');
    const result = await env.service.submitRequest(owner.sessionId, 'What is the OS version?');
    assert.notEqual(result.state, 'COMPLETED', 'execution is blocked while audit integrity is broken');
  } finally { await env.cleanup(); }
});
