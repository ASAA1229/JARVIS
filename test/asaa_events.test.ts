import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsaaEventProducer, buildEnvelope, categorizeAuditFailure, readAsaaEventsConfig, type AsaaEventEnvelope } from '../src/integration/asaaEvents.js';
import { AuditLogger } from '../src/audit/audit.js';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import { validateSchema } from './helpers/jsonSchemaSubset.js';
import { freePort } from './helpers/freePort.js';

const envelopeSchema = JSON.parse(readFileSync(new URL('../contracts/asaa-ecosystem/v1/event-envelope.schema.json', import.meta.url), 'utf8')) as Record<string, unknown>;
const TOKEN = 'asaa-test-integration-token-do-not-use';
const ORG = 'org-test-0001';
const OWNER_TOKEN = 'test-owner-control-token-0123456789abcdef';

/** MOCK ASAA ingest endpoint (in-process HTTP server). It is not the real ASAA service. */
class MockAsaaIngest {
  readonly requests: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: string }> = [];
  /** Scripted status codes for successive requests; defaults to 202 afterwards. */
  script: number[] = [];
  private server: Server | undefined;
  baseUrl = '';

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        const status = this.script.shift() ?? 202;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  get envelopes(): AsaaEventEnvelope[] {
    return this.requests.map((request) => JSON.parse(request.body) as AsaaEventEnvelope);
  }
}

describe('ASAA event producer (disabled by default; tested against a MOCK ingest server)', () => {
  let dir: string;
  let mock: MockAsaaIngest;
  let clock: number;
  const outbox = () => join(dir, 'outbox.json');

  const producer = (overrides: Partial<ConstructorParameters<typeof AsaaEventProducer>[0]> = {}) => new AsaaEventProducer({
    config: { baseUrl: mock.baseUrl, token: TOKEN, orgId: ORG },
    outboxPath: outbox(),
    now: () => clock,
    backoffBaseMs: 1_000,
    backoffMaxMs: 60_000,
    maxAttempts: 4,
    timeoutMs: 2_000,
    ...overrides,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-asaa-events-'));
    mock = new MockAsaaIngest();
    await mock.start();
    clock = 1_700_000_000_000;
  });

  afterEach(async () => {
    await mock.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const task = (taskId = 'task-abc123') => ({ taskId, operation: 'system:get_os_info', outcome: 'VERIFIED_SUCCESS', failed: false });

  test('configuration: enabled only when URL, token and org id are all set; HTTPS required unless loopback', () => {
    assert.deepEqual(readAsaaEventsConfig({}), { enabled: false, reason: 'not-configured' });
    assert.equal(readAsaaEventsConfig({ ASAA_EVENTS_URL: 'https://asaa.example.com', ASAA_EVENTS_TOKEN: TOKEN }).enabled, false);
    assert.equal((readAsaaEventsConfig({ ASAA_EVENTS_URL: 'https://asaa.example.com', ASAA_EVENTS_TOKEN: TOKEN }) as { reason: string }).reason, 'incomplete');
    const ok = readAsaaEventsConfig({ ASAA_EVENTS_URL: 'https://asaa.example.com/', ASAA_EVENTS_TOKEN: TOKEN, ASAA_ORG_ID: ORG });
    assert.deepEqual(ok, { enabled: true, config: { baseUrl: 'https://asaa.example.com', token: TOKEN, orgId: ORG } });
    assert.equal(readAsaaEventsConfig({ ASAA_EVENTS_URL: 'http://asaa.example.com', ASAA_EVENTS_TOKEN: TOKEN, ASAA_ORG_ID: ORG }).enabled, false);
    for (const loopback of ['http://127.0.0.1:8101', 'http://localhost:8101', 'http://[::1]:8101']) {
      assert.equal(readAsaaEventsConfig({ ASAA_EVENTS_URL: loopback, ASAA_EVENTS_TOKEN: TOKEN, ASAA_ORG_ID: ORG }).enabled, true, loopback);
    }
    assert.equal(readAsaaEventsConfig({ ASAA_EVENTS_URL: 'https://user:pw@asaa.example.com', ASAA_EVENTS_TOKEN: TOKEN, ASAA_ORG_ID: ORG }).enabled, false);
    assert.equal(readAsaaEventsConfig({ ASAA_EVENTS_URL: 'not a url', ASAA_EVENTS_TOKEN: TOKEN, ASAA_ORG_ID: ORG }).enabled, false);
    assert.equal(readAsaaEventsConfig({ ASAA_EVENTS_URL: 'https://asaa.example.com', ASAA_EVENTS_TOKEN: 'has space', ASAA_ORG_ID: ORG }).enabled, false);
  });

  test('envelopes are valid against the vendored v1 schema for every event type', () => {
    const cfg = { orgId: ORG };
    const envelopes = [
      buildEnvelope(cfg, { type: 'jarvis.task.completed', data: { taskId: 'task-abc123', operation: 'app:launch', outcome: 'VERIFIED_SUCCESS' } }),
      buildEnvelope(cfg, { type: 'jarvis.task.failed', data: { taskId: 'task-abc123', operation: 'file:write', outcome: 'VERIFIED_FAILURE' }, correlationId: 'corr-12345678' }),
      buildEnvelope(cfg, { type: 'jarvis.security.device-revoked', data: { reason: 'revoke-all' } }),
      buildEnvelope(cfg, { type: 'jarvis.security.audit-integrity-failed', data: { category: 'log-integrity' } }),
    ];
    for (const envelope of envelopes) assert.deepEqual(validateSchema(envelopeSchema, envelope), [], envelope.type);
    assert.equal(envelopes[3].severity, 'critical');
    assert.equal(envelopes[1].correlationId, 'corr-12345678');
    assert.equal(envelopes[0].source, 'jarvis');
    assert.equal(envelopes[0].project, 'JARVIS');
    assert.equal(envelopes[0].orgId, ORG);
    assert.equal(envelopes[0].specversion, 'asaa.event.v1');
    assert.notEqual(envelopes[0].id, envelopes[1].id);
  });

  test('task events carry the SSO subject as data.actor when known, and nothing else is added', () => {
    const sub = 'f3a1c2d4-0000-4000-8000-00000000abcd';
    const attributed = buildEnvelope({ orgId: ORG }, { type: 'jarvis.task.completed', data: { taskId: 'task-abc123', operation: 'app:launch', outcome: 'VERIFIED_SUCCESS', actor: sub, username: 'alice', deviceId: 'dev-1' } });
    assert.deepEqual(attributed.data, { taskId: 'task-abc123', operation: 'app:launch', outcome: 'VERIFIED_SUCCESS', actor: sub });
    assert.deepEqual(validateSchema(envelopeSchema, attributed), []);
    const unattributed = buildEnvelope({ orgId: ORG }, { type: 'jarvis.task.failed', data: { taskId: 'task-abc123', operation: 'app:launch', outcome: 'VERIFIED_FAILURE' } });
    assert.equal('actor' in unattributed.data, false);
    for (const bad of ['has space', 'x'.repeat(129), 'a/b', '']) {
      assert.equal('actor' in buildEnvelope({ orgId: ORG }, { type: 'jarvis.task.completed', data: { taskId: 'task-abc123', operation: 'x', outcome: 'x', actor: bad } }).data, false, `invalid actor ${bad}`);
    }
    assert.equal('actor' in buildEnvelope({ orgId: ORG }, { type: 'jarvis.security.device-revoked', data: { reason: 'revoke-all', actor: sub } }).data, false, 'only task events carry an actor');
  });

  test('payloads contain only fixed validated fields: no paths, user content, ids of devices or secrets', () => {
    const hostile = buildEnvelope({ orgId: ORG }, {
      type: 'jarvis.task.failed',
      data: { taskId: 'task-abc123', operation: 'C:\\Users\\owner\\secret.txt', outcome: 'password=hunter2', transcript: 'call my bank', filePath: 'C:\\x', token: TOKEN },
      correlationId: 'bad id with spaces',
    });
    assert.deepEqual(Object.keys(hostile.data).sort(), ['operation', 'outcome', 'taskId']);
    assert.equal(hostile.data.operation, 'unknown');
    assert.equal(hostile.data.outcome, 'UNCERTAIN');
    assert.equal(hostile.correlationId, undefined);
    assert.throws(() => buildEnvelope({ orgId: ORG }, { type: 'jarvis.task.completed', data: { taskId: '../../etc/passwd', operation: 'x', outcome: 'x' } }), /task id/);
    assert.deepEqual(buildEnvelope({ orgId: ORG }, { type: 'jarvis.security.device-revoked', data: { reason: 'my-device-id-123', deviceId: 'dev-1' } }).data, { reason: 'unspecified' });
    assert.deepEqual(buildEnvelope({ orgId: ORG }, { type: 'jarvis.security.audit-integrity-failed', data: { category: 'AUDIT_LOG_INVALID_JSON_AT_LINE_3' } }).data, { category: 'unknown' });
    assert.equal(JSON.stringify(hostile).includes(TOKEN), false);
    assert.equal(categorizeAuditFailure('AUDIT_LOG_INVALID_JSON_AT_LINE_3'), 'log-invalid');
    assert.equal(categorizeAuditFailure('AUDIT_LOG_WRITE_FAILED'), 'log-write-failed');
    assert.equal(categorizeAuditFailure('AUDIT_LOG_CONTENT_MISMATCH'), 'log-integrity');
    assert.equal(categorizeAuditFailure('something else'), 'unknown');
  });

  test('disabled by default: a no-op that writes nothing and sends nothing', async () => {
    const disabled = new AsaaEventProducer({ config: null, outboxPath: outbox(), fetchImpl: (async () => { throw new Error('must not be called'); }) as typeof fetch });
    disabled.taskFinished(task());
    disabled.deviceRevoked('revoke-all');
    disabled.auditIntegrityFailed('log-integrity');
    await disabled.flush();
    disabled.start();
    disabled.stop();
    assert.equal(disabled.enabled, false);
    assert.deepEqual(disabled.status(), { enabled: false, pending: 0, deadLetter: 0 });
    assert.equal(disabled.manifestCheck(), 'disabled');
    assert.equal(existsSync(outbox()), false);
    assert.equal(mock.requests.length, 0);
    const fromEmpty = AsaaEventProducer.fromEnvironment({}, { statePath: join(dir, 'state.json') });
    assert.equal(fromEmpty.enabled, false);
  });

  test('delivery: POSTs the envelope with bearer auth and X-Request-ID, then clears the outbox', async () => {
    const p = producer();
    p.taskFinished(task());
    await p.flush();
    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/api/v1/integration/events');
    assert.equal(request.headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(request.headers['content-type'], 'application/json');
    const envelope = JSON.parse(request.body) as AsaaEventEnvelope;
    assert.deepEqual(validateSchema(envelopeSchema, envelope), []);
    assert.equal(request.headers['x-request-id'], envelope.id);
    assert.equal(envelope.type, 'jarvis.task.completed');
    assert.deepEqual(envelope.data, { taskId: 'task-abc123', operation: 'system:get_os_info', outcome: 'VERIFIED_SUCCESS' });
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 });
    assert.equal(p.manifestCheck(), 'ok');
  });

  test('failed tasks, device revocation and audit failures produce the contracted event types', async () => {
    const p = producer();
    p.taskFinished({ ...task('task-fail01'), outcome: 'VERIFIED_FAILURE', failed: true });
    p.deviceRevoked('owner-recovery');
    p.auditIntegrityFailed('log-integrity');
    await p.flush();
    assert.deepEqual(mock.envelopes.map((e) => e.type).sort(), ['jarvis.security.audit-integrity-failed', 'jarvis.security.device-revoked', 'jarvis.task.failed']);
    const audit = mock.envelopes.find((e) => e.type === 'jarvis.security.audit-integrity-failed');
    assert.equal(audit?.severity, 'critical');
    assert.deepEqual(audit?.data, { category: 'log-integrity' });
  });

  test('retries on 5xx with exponential backoff and then delivers', async () => {
    mock.script = [503, 500];
    const p = producer();
    p.taskFinished(task());
    await p.flush();
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(p.status(), { enabled: true, pending: 1, deadLetter: 0 });
    await p.flush();
    assert.equal(mock.requests.length, 1, 'not retried before the backoff elapses');
    clock += 1_000;
    await p.flush();
    assert.equal(mock.requests.length, 2);
    clock += 1_999;
    await p.flush();
    assert.equal(mock.requests.length, 2, 'second backoff is doubled (2 s)');
    clock += 1;
    await p.flush();
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 });
    assert.equal(new Set(mock.envelopes.map((e) => e.id)).size, 1, 'retries re-send the same envelope id (idempotency key)');
  });

  test('retries after network errors, and degrades the manifest check while delivery keeps failing', async () => {
    let calls = 0;
    const flaky = (async (...args: Parameters<typeof fetch>) => {
      calls += 1;
      if (calls <= 3) throw new TypeError('fetch failed');
      return fetch(...args);
    }) as typeof fetch;
    const p = producer({ fetchImpl: flaky, maxAttempts: 10 });
    p.taskFinished(task());
    for (let i = 0; i < 3; i += 1) { await p.flush(); clock += 60_000; }
    assert.equal(calls, 3);
    assert.equal(p.manifestCheck(), 'degraded', 'three failed attempts degrade the check');
    await p.flush();
    assert.equal(mock.requests.length, 1);
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 });
    assert.equal(p.manifestCheck(), 'ok');
  });

  test('409 is treated as already delivered; other 4xx are dead-lettered without retry', async () => {
    mock.script = [409, 400, 401];
    const p = producer();
    p.taskFinished(task('task-conflict'));
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 }, '409 means ASAA already has it');
    p.taskFinished(task('task-bad-400'));
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 1 });
    p.taskFinished(task('task-bad-401'));
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 2 });
    clock += 3_600_000;
    await p.flush();
    assert.equal(mock.requests.length, 3, 'no retries for permanent rejections');
    assert.equal(p.manifestCheck(), 'degraded');
  });

  test('redirects are never followed (the bearer token cannot be forwarded) and are dead-lettered', async () => {
    mock.script = [307];
    const p = producer();
    p.taskFinished(task());
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 1 });
  });

  test('gives up after the maximum attempts and moves the event to dead-letter', async () => {
    mock.script = [500, 500, 500, 500, 500];
    const p = producer({ maxAttempts: 3 });
    p.taskFinished(task());
    for (let i = 0; i < 6; i += 1) { await p.flush(); clock += 120_000; }
    assert.equal(mock.requests.length, 3);
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 1 });
  });

  test('idempotent by envelope id: a re-enqueued or already delivered id is ignored', async () => {
    const p = producer();
    const envelope = buildEnvelope({ orgId: ORG }, { type: 'jarvis.security.device-revoked', data: { reason: 'revoke-all' } });
    assert.equal(p.enqueue(envelope), true);
    assert.equal(p.enqueue(envelope), false, 'duplicate while pending');
    await p.flush();
    assert.equal(mock.requests.length, 1);
    assert.equal(p.enqueue(envelope), false, 'duplicate after delivery');
    await p.flush();
    assert.equal(mock.requests.length, 1);
  });

  test('the outbox is bounded: overflow moves the oldest events to dead-letter, and dead-letter is capped', () => {
    const p = producer({ maxPending: 3, maxDeadLetter: 2, fetchImpl: (async () => new Response('', { status: 500 })) as typeof fetch, flushIntervalMs: 3_600_000 });
    for (let i = 0; i < 8; i += 1) p.enqueue(buildEnvelope({ orgId: ORG }, { type: 'jarvis.task.completed', data: { taskId: `task-${i}-xxxx`, operation: 'app:launch', outcome: 'VERIFIED_SUCCESS' } }));
    const status = p.status();
    assert.equal(status.pending, 3);
    assert.equal(status.deadLetter, 2);
  });

  test('the outbox persists across restarts (plain JSON without an owner token) and never stores the bearer token', async () => {
    mock.script = [503];
    const first = producer();
    first.taskFinished(task('task-persist1'));
    await first.flush();
    assert.deepEqual(first.status(), { enabled: true, pending: 1, deadLetter: 0 });
    const onDisk = readFileSync(outbox(), 'utf8');
    assert.equal(onDisk.includes(TOKEN), false);
    assert.equal(onDisk.includes('task-persist1'), true, 'plain JSON outbox when no owner token is configured');
    const second = producer();
    assert.deepEqual(second.status(), { enabled: true, pending: 1, deadLetter: 0 });
    clock += 1_000;
    await second.flush();
    assert.equal(mock.requests.length, 2);
    assert.deepEqual(second.status(), { enabled: true, pending: 0, deadLetter: 0 });
  });

  test('with an owner token the outbox is encrypted at rest', async () => {
    mock.script = [503];
    const p = producer({ ownerToken: OWNER_TOKEN });
    p.taskFinished(task('task-secretid1'));
    await p.flush();
    const onDisk = readFileSync(outbox(), 'utf8');
    assert.equal(onDisk.includes('task-secretid1'), false);
    assert.equal(onDisk.includes(TOKEN), false);
    const again = producer({ ownerToken: OWNER_TOKEN });
    assert.equal(again.status().pending, 1);
  });

  test('a corrupt outbox is reset instead of crashing the producer', () => {
    writeFileSync(outbox(), '{not json');
    const p = producer();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 });
  });

  test('requests and the outbox never contain the bearer token or user content', async () => {
    const p = producer();
    p.taskFinished({ taskId: 'task-clean-01', operation: 'file:write', outcome: 'VERIFIED_SUCCESS', failed: false });
    p.deviceRevoked('device-request');
    await p.flush();
    for (const request of mock.requests) assert.equal(request.body.includes(TOKEN), false);
    const stored = existsSync(outbox()) ? readFileSync(outbox(), 'utf8') : '';
    assert.equal(stored.includes(TOKEN), false);
  });

  test('core service hooks: finished tasks and device revocations are produced; audit failure is reported once', async () => {
    const auditPath = join(dir, 'audit.log');
    const service = new JarvisCoreService(new LocalHeuristicPlanner(), auditPath);
    const p = producer();
    service.integrationSink = p;
    service.audit.onFailClosed = (reason) => p.auditIntegrityFailed(categorizeAuditFailure(reason));

    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ]);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'Hook test device', keys.publicKey);
    assert.equal(enrolled.success, true);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
    assert.equal(session.success, true);

    const result = await service.submitRequest(session.sessionId!, 'What is the OS version?');
    assert.equal(result.state, 'COMPLETED');
    service.onDeviceRevoked(enrolled.deviceId!, 'owner-recovery');
    // Tamper with the audit log: the next integrity check fails closed and reports a critical event.
    writeFileSync(auditPath, readFileSync(auditPath, 'utf8') + 'tampered\n');
    assert.equal(service.audit.verifyIntegrity().valid, false);
    assert.equal(service.audit.verifyIntegrity().valid, false);
    await p.flush();

    const types = mock.envelopes.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t === 'jarvis.task.completed').length, 1);
    assert.deepEqual(types.filter((t) => t === 'jarvis.security.device-revoked').length, 1);
    assert.deepEqual(types.filter((t) => t === 'jarvis.security.audit-integrity-failed').length, 1, 'reported once per failure');
    const completed = mock.envelopes.find((e) => e.type === 'jarvis.task.completed')!;
    assert.equal(completed.data.taskId, result.taskId);
    assert.equal(JSON.stringify(mock.envelopes).includes(enrolled.deviceId!), false, 'device ids never leave JARVIS');
    assert.equal(JSON.stringify(mock.envelopes).includes('Hook test device'), false);
    assert.equal(JSON.stringify(mock.envelopes).includes('OS version'), false, 'request text never leaves JARVIS');
    for (const envelope of mock.envelopes) assert.deepEqual(validateSchema(envelopeSchema, envelope), []);
  });

  test('a task run by an SSO-attributed device is emitted with that person as actor (sub only)', async () => {
    const service = new JarvisCoreService(new LocalHeuristicPlanner(), join(dir, 'audit-actor.log'));
    const p = producer();
    service.integrationSink = p;
    const sub = 'f3a1c2d4-0000-4000-8000-00000000abcd';
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ], 120, { sub, username: 'alice' });
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'Alice device', keys.publicKey);
    assert.equal(enrolled.success, true);
    assert.equal(service.identity.getDevice(enrolled.deviceId!)?.ssoSub, sub);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
    assert.equal(session.success, true);
    await service.submitRequest(session.sessionId!, 'What is the OS version?');
    await p.flush();
    const completed = mock.envelopes.find((e) => e.type === 'jarvis.task.completed')!;
    assert.equal(completed.data.actor, sub);
    assert.deepEqual(Object.keys(completed.data).sort(), ['actor', 'operation', 'outcome', 'taskId']);
    const wire = JSON.stringify(mock.envelopes);
    assert.equal(wire.includes('alice'), false, 'the username never leaves JARVIS');
    assert.equal(wire.includes(enrolled.deviceId!), false);
    assert.deepEqual(validateSchema(envelopeSchema, completed), []);
    // The attribution is also in the hash-chained audit log at enrollment time.
    const logged = readFileSync(join(dir, 'audit-actor.log'), 'utf8');
    assert.ok(logged.includes(sub) && logged.includes('DEVICE_ENROLLED'));
  });

  test('server wiring: enabled by the three env vars, surfaced as checks.asaaEvents, disabled otherwise', async () => {
    const saved = { url: process.env.ASAA_EVENTS_URL, token: process.env.ASAA_EVENTS_TOKEN, org: process.env.ASAA_ORG_ID, owner: process.env.JARVIS_OWNER_CONTROL_TOKEN };
    process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
    process.env.ASAA_EVENTS_URL = mock.baseUrl;
    process.env.ASAA_EVENTS_TOKEN = TOKEN;
    process.env.ASAA_ORG_ID = ORG;
    const port = await freePort();
    const server = new JarvisServer(port, join(dir, 'server-audit.log'), join(dir, 'server-state.json'));
    await server.start();
    try {
      server.getService().onDeviceRevoked('some-device', 'revoke-all');
      const deadline = Date.now() + 5_000;
      while (mock.requests.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(mock.envelopes[0]?.type, 'jarvis.security.device-revoked');
      assert.deepEqual(mock.envelopes[0]?.data, { reason: 'revoke-all' });
      const manifest = await (await fetch(`http://127.0.0.1:${port}/.well-known/asaa-service`)).json() as { checks: Record<string, string> };
      assert.equal(manifest.checks.asaaEvents, 'ok');
    } finally {
      await server.stop();
      for (const [key, value] of [['ASAA_EVENTS_URL', saved.url], ['ASAA_EVENTS_TOKEN', saved.token], ['ASAA_ORG_ID', saved.org], ['JARVIS_OWNER_CONTROL_TOKEN', saved.owner]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    // With the variables unset, the same server builds with a disabled producer and no outbox file.
    process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
    const quietPort = await freePort();
    const quiet = new JarvisServer(quietPort, join(dir, 'quiet-audit.log'), join(dir, 'quiet-state.json'));
    await quiet.start();
    try {
      const manifest = await (await fetch(`http://127.0.0.1:${quietPort}/.well-known/asaa-service`)).json() as { checks: Record<string, string> };
      assert.equal(manifest.checks.asaaEvents, 'disabled');
      assert.equal(existsSync(join(dir, 'quiet-state.json.asaa-events')), false);
    } finally {
      await quiet.stop();
      if (saved.owner === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN; else process.env.JARVIS_OWNER_CONTROL_TOKEN = saved.owner;
    }
  });
});
