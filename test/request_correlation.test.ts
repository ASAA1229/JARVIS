import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { AuditLogger } from '../src/audit/audit.js';
import { runWithRequestId } from '../src/core/requestContext.js';
import { getAgentModelConfigStatus } from '../src/conversation/agentModelAdapter.js';
import { freePort } from './helpers/freePort.js';

test('E2:D0.4 main server returns X-Request-ID: reuses a valid incoming value, otherwise generates one', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-reqid-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const echoed = await fetch(`${base}/api/capabilities`, { headers: { 'X-Request-ID': 'req-abc12345' } });
    assert.equal(echoed.headers.get('x-request-id'), 'req-abc12345');
    const invalid = await fetch(`${base}/api/capabilities`, { headers: { 'X-Request-ID': 'bad id!' } });
    assert.notEqual(invalid.headers.get('x-request-id'), 'bad id!');
    assert.match(invalid.headers.get('x-request-id') ?? '', /^[A-Za-z0-9._-]{8,64}$/);
    const missing = await fetch(`${base}/no-such-route`);
    assert.equal(missing.status, 404);
    assert.match(missing.headers.get('x-request-id') ?? '', /^[A-Za-z0-9._-]{8,64}$/);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2:D0.4 audit records carry the request id only when a request context exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-reqid-audit-'));
  try {
    const audit = new AuditLogger(join(dir, 'audit.log'));
    const outside = audit.record('TEST_EVENT', { a: 1 });
    runWithRequestId('req-audit-0001', () => audit.record('TEST_EVENT', { a: 2 }));
    const records = audit.getPublicRecords();
    assert.equal(JSON.stringify(outside.details).includes('requestId'), false);
    assert.equal((records[records.length - 1].details as Record<string, unknown>).requestId, 'req-audit-0001');
    assert.equal(audit.verifyIntegrity().valid, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('E2:D4.7 agent model status follows the routing mode through the provider router', () => {
  const keys = ['OLLAMA_URL', 'JARVIS_AI_BASE_URL', 'JARVIS_AI_ALLOW_REMOTE', 'OLLAMA_MODEL', 'JARVIS_AI_MODEL', 'JARVIS_ROUTING_MODE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    process.env.OLLAMA_MODEL = 'test-model:1b';
    for (const mode of ['local-first', 'local-only', 'offline']) {
      process.env.JARVIS_ROUTING_MODE = mode;
      assert.deepEqual(getAgentModelConfigStatus(), { status: 'ready', mode: 'local', model: 'test-model:1b', apiKeyConfigured: false, provider: 'local', routingMode: mode });
    }
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
