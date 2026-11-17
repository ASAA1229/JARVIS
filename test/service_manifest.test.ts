import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { buildServiceManifest, manifestCommit, manifestEnvironment } from '../src/integration/serviceManifest.js';
import { validateSchema } from './helpers/jsonSchemaSubset.js';
import { freePort } from './helpers/freePort.js';

const OWNER_TOKEN = 'test-owner-control-token-0123456789abcdef';
const schema = JSON.parse(readFileSync(new URL('../contracts/asaa-ecosystem/v1/service-manifest.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

const healthy = { auditIntegrity: true, identityState: true, ollama: { configured: true, available: true }, aiGatewayRunning: false, asaaEvents: 'disabled' as const };

test('manifest builder output is valid against the vendored v1 schema', () => {
  const manifest = buildServiceManifest({ ...healthy, env: {} });
  assert.deepEqual(validateSchema(schema, manifest), []);
  assert.equal(manifest.service, 'jarvis');
  assert.equal(manifest.project, 'JARVIS');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.commit, null);
  assert.equal(manifest.status, 'ok');
  assert.deepEqual(manifest.checks, { auditIntegrity: 'ok', identityState: 'ok', ollama: 'ok', aiGateway: 'disabled', asaaEvents: 'disabled' });
  assert.ok(manifest.capabilities.includes('events.produce'));
});

test('check values follow cached state: down audit/identity or Ollama degrade the status; unconfigured Ollama and gateway are disabled', () => {
  assert.equal(buildServiceManifest({ ...healthy, auditIntegrity: false }).checks.auditIntegrity, 'down');
  assert.equal(buildServiceManifest({ ...healthy, auditIntegrity: false }).status, 'degraded');
  assert.equal(buildServiceManifest({ ...healthy, identityState: false }).status, 'degraded');
  const ollamaDown = buildServiceManifest({ ...healthy, ollama: { configured: true, available: false } });
  assert.equal(ollamaDown.checks.ollama, 'down');
  assert.equal(ollamaDown.status, 'degraded');
  assert.equal(buildServiceManifest({ ...healthy, ollama: { configured: false, available: false } }).checks.ollama, 'disabled');
  assert.equal(buildServiceManifest({ ...healthy, ollama: undefined }).checks.ollama, 'disabled');
  assert.equal(buildServiceManifest({ ...healthy, aiGatewayRunning: true }).checks.aiGateway, 'ok');
  assert.equal(buildServiceManifest({ ...healthy, asaaEvents: 'degraded' }).status, 'degraded');
  assert.equal(buildServiceManifest({ ...healthy, asaaEvents: 'ok' }).status, 'ok');
});

test('commit and environment come only from validated environment values', () => {
  assert.equal(manifestCommit({ JARVIS_BUILD_COMMIT: 'ABCDEF1234567' }), 'abcdef1234567');
  assert.equal(manifestCommit({ JARVIS_BUILD_COMMIT: 'not-a-sha' }), null);
  assert.equal(manifestCommit({}), null);
  assert.equal(manifestEnvironment({ JARVIS_ENVIRONMENT: 'local-prod' }), 'local-prod');
  assert.equal(manifestEnvironment({ JARVIS_ENVIRONMENT: 'weird' }), 'development');
  assert.deepEqual(validateSchema(schema, buildServiceManifest({ ...healthy, env: { JARVIS_BUILD_COMMIT: 'abcdef1', JARVIS_ENVIRONMENT: 'staging' } })), []);
});

test('the test validator rejects a manifest that breaks the contract (sanity check of the validator itself)', () => {
  const bad = { ...buildServiceManifest({ ...healthy }), extra: 1, status: 'broken' };
  assert.ok(validateSchema(schema, bad).length >= 2);
});

test('GET /.well-known/asaa-service is public, schema-valid and exposes nothing sensitive', async () => {
  process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-manifest-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/.well-known/asaa-service`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /application\/json/);
    const text = await response.text();
    assert.deepEqual(validateSchema(schema, JSON.parse(text)), []);
    const manifest = JSON.parse(text) as { checks: Record<string, string> };
    assert.equal(manifest.checks.auditIntegrity, 'ok');
    assert.equal(manifest.checks.identityState, 'ok');
    assert.equal(manifest.checks.aiGateway, 'disabled');
    assert.equal(manifest.checks.asaaEvents, 'disabled');
    for (const secret of [OWNER_TOKEN, dir, String(port), hostname(), 'deviceId', 'publicKey']) assert.equal(text.includes(secret), false, `manifest leaked ${secret.slice(0, 8)}`);
    server.setAiGatewayRunning(true);
    const running = await (await fetch(`http://127.0.0.1:${port}/.well-known/asaa-service`)).json() as { checks: Record<string, string> };
    assert.equal(running.checks.aiGateway, 'ok');
    const post = await fetch(`http://127.0.0.1:${port}/.well-known/asaa-service`, { method: 'POST' });
    assert.notEqual(post.status, 200, 'only GET serves the manifest');
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
