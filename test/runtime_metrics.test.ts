import test from 'node:test';
import assert from 'node:assert/strict';
import { hostname, tmpdir, userInfo } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import { PROVISIONAL_RUNTIME_BUDGETS, evaluateRuntimeBudgets, maxQueueWaitMs, summarizeMeasurements } from '../src/evaluation/runtimeBudgets.js';
import { freePort } from './helpers/freePort.js';

/** JARVIS-US-025 / GAP-015: privileged, secret-free runtime metrics with a provisional budget evaluation. */
const OWNER_TOKEN = 'runtime-metrics-owner-token-0123456789abcdef';
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;

const healthy = () => ({
  generatedAt: 1,
  uptimeSeconds: 10,
  core: { auditIntegrity: true, identityState: true, schedulerPersistence: true },
  host: { platform: 'test', logicalCores: 4, cpuUsagePercent: 20, memoryUsedPercent: 50, processRssBytes: 100 * 1024 * 1024, secretField: 'must-not-appear' },
  tasks: {
    total: 3, running: 0, awaitingApproval: 0, awaitingRecovery: 0, failed: 0,
    executionQueue: { active: 0, queued: 1, queuedTasks: [{ taskId: 'task-secret-id', waitedMs: 1200 }], activeTasks: ['task-other-id'], limits: { global: 4, perDevice: 2, queued: 50 }, planning: { queued: 0 } },
    reliability: { crashFreeCompletionRate: 1, verifiedOutcomeRate: 1 },
  },
  schedules: { active: 0 },
});

test('budget evaluation: measured values inside the provisional budgets are ok', () => {
  const evaluation = evaluateRuntimeBudgets(healthy());
  assert.equal(evaluation.provisional, false);
  assert.equal(evaluation.overall, 'ok');
  assert.deepEqual(evaluation.checks.map((check) => check.name), ['cpuUsagePercent', 'memoryUsedPercent', 'processRssBytes', 'queueWaitMs', 'queueFillRatio', 'crashFreeCompletionRate', 'verifiedOutcomeRate']);
  assert.equal(evaluation.checks.find((check) => check.name === 'queueWaitMs')?.observed, 1200);
  assert.equal(evaluation.checks.find((check) => check.name === 'queueFillRatio')?.observed, 0.02);
});

test('budget evaluation: exceeded values are flagged per check, and missing data is unknown rather than ok', () => {
  const stressed = healthy();
  stressed.host.cpuUsagePercent = 99;
  stressed.tasks.reliability.crashFreeCompletionRate = 0.5;
  stressed.tasks.executionQueue.queuedTasks = [{ taskId: 'x', waitedMs: 60_000 }];
  stressed.tasks.executionQueue.queued = 49;
  const evaluation = evaluateRuntimeBudgets(stressed);
  assert.equal(evaluation.overall, 'exceeded');
  const status = (name: string) => evaluation.checks.find((check) => check.name === name)?.status;
  assert.equal(status('cpuUsagePercent'), 'exceeded');
  assert.equal(status('crashFreeCompletionRate'), 'exceeded');
  assert.equal(status('queueWaitMs'), 'exceeded');
  assert.equal(status('queueFillRatio'), 'exceeded');
  assert.equal(status('memoryUsedPercent'), 'ok');

  const empty = evaluateRuntimeBudgets({ host: { cpuUsagePercent: null, memoryUsedPercent: 10, processRssBytes: 1 }, tasks: { reliability: { crashFreeCompletionRate: null, verifiedOutcomeRate: null }, executionQueue: { queued: 0, queuedTasks: [], limits: { queued: 50 } } } });
  assert.equal(empty.overall, 'unknown');
  assert.equal(empty.checks.find((check) => check.name === 'cpuUsagePercent')?.status, 'unknown');
  assert.equal(empty.checks.find((check) => check.name === 'queueWaitMs')?.observed, 0);
  assert.equal(evaluateRuntimeBudgets({}).overall, 'unknown');
  assert.equal(maxQueueWaitMs({}), null);
  assert.equal(PROVISIONAL_RUNTIME_BUDGETS.provisional, false);
});

test('the measurement summary keeps aggregates only: no task ids and no unknown fields', () => {
  const summary = JSON.stringify(summarizeMeasurements(healthy()));
  for (const forbidden of ['task-secret-id', 'task-other-id', 'must-not-appear']) assert.equal(summary.includes(forbidden), false, forbidden);
  const parsed = JSON.parse(summary) as { executionQueue: { maxWaitMs: number; queued: number } };
  assert.equal(parsed.executionQueue.maxWaitMs, 1200);
  assert.equal(parsed.executionQueue.queued, 1);
});

test('GET /api/metrics requires a signed owner (DEVICE_MANAGE) session and returns a secret-free, bounded document', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-metrics-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const service = server.getService();
  const device = (permissions: Permission[]) => {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge(permissions);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'metrics-test', keys.publicKey);
    const ts = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, keys.privateKey), ts, nonce);
    return { id: enrolled.deviceId!, sessionId: session.sessionId!, privateKey: keys.privateKey };
  };
  const get = async (who?: { sessionId: string; privateKey: string }) => {
    if (!who) { const r = await fetch(`${base}/api/metrics`); return { status: r.status, text: await r.text() }; }
    const t = Date.now();
    const n = CryptoUtil.randomToken(16);
    const canonical = CryptoUtil.buildCanonicalRequestString('GET', '/api/metrics', who.sessionId, t, n, undefined);
    const r = await fetch(`${base}/api/metrics`, { headers: { 'x-session-id': who.sessionId, 'x-request-timestamp': String(t), 'x-request-nonce': n, 'x-request-signature': CryptoUtil.signData(canonical, who.privateKey) } });
    return { status: r.status, text: await r.text() };
  };
  try {
    const owner = device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const ordinary = device([Permission.SYSTEM_INFO_READ]);
    assert.equal((await get()).status, 401);
    assert.equal((await get(ordinary)).status, 403);
    const ok = await get(owner);
    assert.equal(ok.status, 200);
    const body = JSON.parse(ok.text) as { measurements: Record<string, unknown>; budgets: { provisional: boolean; checks: unknown[]; overall: string }; note: string };
    assert.equal(body.budgets.provisional, false);
    assert.equal(body.budgets.checks.length, 7);
    assert.ok(['ok', 'exceeded', 'unknown'].includes(body.budgets.overall));
    assert.equal(body.note, 'owner-approved baseline 2026-11-18; revisit after field data');
    assert.ok(ok.text.length < 8_000, 'bounded response');
    for (const secret of [OWNER_TOKEN, dir, hostname(), userInfo().username, owner.id, ordinary.id, owner.sessionId, 'publicKey']) {
      if (secret.length < 4) continue;
      assert.equal(ok.text.includes(secret), false, `metrics leaked ${secret.slice(0, 8)}`);
    }
    // The endpoint is read-only: other methods are not served.
    assert.notEqual((await fetch(`${base}/api/metrics`, { method: 'POST' })).status, 200);
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
