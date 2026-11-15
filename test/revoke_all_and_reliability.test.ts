import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceIdentityManager } from '../src/core/identity.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { DeviceStatus, Permission, TaskState, VerificationOutcome } from '../src/core/types.js';
import { JarvisServer } from '../src/server/server.js';
import { freePort } from './helpers/freePort.js';

/** JARVIS-US-003 (revoke-all) and JARVIS-US-025 (reliability metrics). */
const OWNER_TOKEN = 'revoke-all-reliability-owner-token-0123456789a';
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;

function identityEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-revoke-all-'));
  const audit = new AuditLogger(join(dir, 'audit.log'));
  const statePath = join(dir, 'devices.json');
  const identity = new DeviceIdentityManager(audit, statePath);
  const enroll = (permissions: Permission[]) => {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = identity.createEnrollmentChallenge(permissions);
    const result = identity.enrollDevice(challenge.challengeToken, 'd', keys.publicKey);
    assert.equal(result.success, true);
    return { id: result.deviceId!, keys };
  };
  const login = (device: { id: string; keys: { privateKey: string } }) => {
    const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
    const session = identity.createSession(device.id, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, device.keys.privateKey), ts, nonce);
    assert.equal(session.success, true);
    return session.sessionId!;
  };
  return { dir, audit, identity, statePath, enroll, login, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const OWNER = [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE];

test('revoke-all is owner-only: a non-owner, a revoked owner and an unknown device change nothing', () => {
  const e = identityEnv();
  try {
    const owner = e.enroll(OWNER); const phone = e.enroll([Permission.SYSTEM_INFO_READ]);
    const phoneSession = e.login(phone); const ownerSession = e.login(owner);
    for (const actor of [phone.id, 'unknown-device']) {
      const result = e.identity.revokeAllDevices(actor);
      assert.equal(result.success, false);
      assert.deepEqual(result.revokedDeviceIds, []);
    }
    assert.equal(e.identity.validateDeviceSession(phoneSession).valid, true);
    assert.equal(e.identity.validateDeviceSession(ownerSession).valid, true);
    assert.ok(e.audit.getRecords().some((r) => r.eventType === 'DEVICE_REVOKE_ALL_DENIED'));
    e.identity.revokeDevice(owner.id);
    assert.equal(e.identity.revokeAllDevices(owner.id).success, false, 'a revoked owner cannot revoke others');
  } finally { e.cleanup(); }
});

test('revoke-all without keep invalidates every live session including the caller and revokes every device, audited with counts only', () => {
  const e = identityEnv();
  try {
    const owner = e.enroll(OWNER); const a = e.enroll([Permission.SYSTEM_INFO_READ]); const b = e.enroll([Permission.SYSTEM_INFO_READ]);
    const sessions = [e.login(owner), e.login(owner), e.login(a), e.login(b)];
    const result = e.identity.revokeAllDevices(owner.id, { reason: 'phone stolen' });
    assert.equal(result.success, true);
    assert.deepEqual([...result.revokedDeviceIds].sort(), [owner.id, a.id, b.id].sort());
    assert.equal(result.sessionsInvalidated, 4);
    for (const id of sessions) assert.equal(e.identity.validateDeviceSession(id).valid, false);
    for (const device of [owner, a, b]) assert.equal(e.identity.getDevice(device.id)?.status, DeviceStatus.REVOKED);
    const record = e.audit.getRecords().find((r) => r.eventType === 'DEVICE_REVOKE_ALL')!;
    assert.deepEqual({ revokedCount: record.details.revokedCount, loginsEnded: record.details.loginsEnded, callerKept: record.details.callerKept }, { revokedCount: 3, loginsEnded: 4, callerKept: false });
    assert.equal(JSON.stringify(record).includes('phone stolen'), false, 'the reason text is never written to the audit log');
  } finally { e.cleanup(); }
});

test('keepSessionId keeps exactly the caller\'s current session; its other sessions and all other devices are revoked', () => {
  const e = identityEnv();
  try {
    const owner = e.enroll(OWNER); const phone = e.enroll([Permission.SYSTEM_INFO_READ]);
    const keep = e.login(owner); const other = e.login(owner); const phoneSession = e.login(phone);
    const result = e.identity.revokeAllDevices(owner.id, { keepSessionId: keep });
    assert.equal(result.success, true);
    assert.deepEqual(result.revokedDeviceIds, [phone.id]);
    assert.equal(e.identity.validateDeviceSession(keep).valid, true);
    assert.equal(e.identity.validateDeviceSession(other).valid, false, 'the caller\'s other sessions are terminated');
    assert.equal(e.identity.validateDeviceSession(phoneSession).valid, false);
    assert.equal(e.identity.getDevice(owner.id)?.status, DeviceStatus.ACTIVE);
    // keepSessionId must be the caller's own live session.
    const fresh = identityEnv();
    try {
      const o = fresh.enroll(OWNER); const p = fresh.enroll([Permission.SYSTEM_INFO_READ]);
      const foreign = fresh.login(p); fresh.login(o);
      for (const bad of [foreign, 'sess-nonexistent', '']) {
        const refused = fresh.identity.revokeAllDevices(o.id, { keepSessionId: bad || 'sess-empty' });
        assert.equal(refused.success, false, bad);
      }
      assert.equal(fresh.identity.getDevice(p.id)?.status, DeviceStatus.ACTIVE, 'a refused call changes nothing');
      assert.equal(fresh.identity.validateDeviceSession(foreign).valid, true);
    } finally { fresh.cleanup(); }
  } finally { e.cleanup(); }
});

test('revoke-all survives a restart: revoked devices stay revoked, no session is restored, kept owner stays active; already revoked devices are untouched', () => {
  const e = identityEnv();
  try {
    const owner = e.enroll(OWNER); const old = e.enroll([Permission.SYSTEM_INFO_READ]); const phone = e.enroll([Permission.SYSTEM_INFO_READ]);
    e.identity.revokeDevice(old.id);
    const revokedAt = e.identity.getDevice(old.id)!.revokedAt;
    const keep = e.login(owner); e.login(phone);
    assert.equal(e.identity.revokeAllDevices(owner.id, { keepSessionId: keep }).success, true);
    assert.equal(e.identity.getDevice(old.id)!.revokedAt, revokedAt);
    const restarted = new DeviceIdentityManager(new AuditLogger(join(e.dir, 'audit2.log')), e.statePath);
    assert.equal(restarted.getDevice(phone.id)?.status, DeviceStatus.REVOKED);
    assert.equal(restarted.getDevice(owner.id)?.status, DeviceStatus.ACTIVE);
    assert.equal(restarted.validateDeviceSession(keep).valid, false, 'sessions are never restored after a restart');
    const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
    assert.equal(restarted.createSession(phone.id, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, phone.keys.privateKey), ts, nonce).success, false);
  } finally { e.cleanup(); }
});

async function bootServer() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-revoke-http-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  const service = server.getService();
  const device = (permissions: Permission[]) => {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge(permissions);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'http', keys.publicKey);
    const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
    const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, keys.privateKey), ts, nonce);
    return { id: enrolled.deviceId!, sessionId: session.sessionId!, privateKey: keys.privateKey };
  };
  const call = async (method: string, path: string, who: { sessionId: string; privateKey: string }, body?: unknown) => {
    const t = Date.now(); const n = CryptoUtil.randomToken(16);
    const canonical = CryptoUtil.buildCanonicalRequestString(method, path, who.sessionId, t, n, body);
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-session-id': who.sessionId, 'x-request-timestamp': String(t), 'x-request-nonce': n, 'x-request-signature': CryptoUtil.signData(canonical, who.privateKey) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, any> };
  };
  return { dir, server, service, device, call, cleanup: async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test('HTTP revoke-all: requires confirmation and owner permission; without keep the caller is signed out too; with keep the caller continues', async () => {
  const env = await bootServer();
  try {
    const owner = env.device(OWNER); const phone = env.device([Permission.SYSTEM_INFO_READ]);
    assert.equal((await env.call('POST', '/api/device/revoke-all', phone, { confirm: 'REVOKE_ALL_DEVICES' })).status, 403, 'non-owner refused');
    assert.equal((await env.call('POST', '/api/device/revoke-all', owner, {})).status, 400, 'confirmation phrase required');
    assert.equal((await env.call('GET', '/api/health', owner)).status, 200);
    const kept = await env.call('POST', '/api/device/revoke-all', owner, { confirm: 'REVOKE_ALL_DEVICES', keepCurrentSession: true });
    assert.equal(kept.status, 200);
    assert.deepEqual([kept.json.revokedCount, kept.json.callerKept], [1, true]);
    assert.equal((await env.call('GET', '/api/health', phone)).status, 401, 'the phone is signed out');
    assert.equal((await env.call('GET', '/api/health', owner)).status, 200, 'the kept caller continues');
    const all = await env.call('POST', '/api/device/revoke-all', owner, { confirm: 'REVOKE_ALL_DEVICES' });
    assert.equal(all.status, 200);
    assert.equal(all.json.callerKept, false);
    assert.equal((await env.call('GET', '/api/health', owner)).status, 401, 'the caller is signed out when not explicitly kept');
  } finally { await env.cleanup(); }
});

test('reliability metrics are derived from task records as bounded aggregates (rates, nulls when empty, excluded owner-driven endings)', async () => {
  const env = await bootServer();
  try {
    const owner = env.device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    assert.deepEqual([env.service.reliabilityMetrics().crashFreeCompletionRate, env.service.reliabilityMetrics().verifiedOutcomeRate], [null, null]);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await env.service.submitRequest(owner.sessionId, `What is the OS version? marker-sentinel-${i}-xyz`)).taskId);
    const set = (index: number, state: TaskState, outcome?: VerificationOutcome) => {
      const task = env.service.getTask(ids[index] as never)!;
      task.state = state;
      if (outcome) task.result = { success: outcome === VerificationOutcome.VERIFIED_SUCCESS, outcome, evidence: {} };
    };
    set(1, TaskState.FAILED, VerificationOutcome.VERIFIED_FAILURE);
    set(2, TaskState.INTERRUPTED, VerificationOutcome.UNCERTAIN);
    set(3, TaskState.PARTIAL, VerificationOutcome.PARTIAL_SUCCESS);
    set(4, TaskState.REJECTED);
    const m = env.service.reliabilityMetrics();
    assert.deepEqual([m.executedTasks, m.completed, m.interruptedOrRecovery, m.verifiedDefinitive, m.verifiedSuccess], [4, 1, 1, 2, 1]);
    assert.equal(m.crashFreeCompletionRate, 0.75);
    assert.equal(m.verifiedOutcomeRate, 0.5);
    assert.equal(m.verifiedSuccessRate, 0.25);
    assert.equal(m.window, 'retained-task-records');
  } finally { await env.cleanup(); }
});

test('reliability metrics are exposed on the owner-gated health endpoint and contain no prompts or ids', async () => {
  const env = await bootServer();
  try {
    const owner = env.device([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]); const ordinary = env.device([Permission.SYSTEM_INFO_READ]);
    const submitted = await env.service.submitRequest(owner.sessionId, 'What is the OS version? health-sentinel-4821');
    assert.equal((await env.call('GET', '/api/health', ordinary)).status, 403, 'same permission gate as the rest of health');
    const health = await env.call('GET', '/api/health', owner);
    assert.equal(health.status, 200);
    const reliability = health.json.tasks.reliability;
    assert.equal(reliability.executedTasks, 1);
    assert.equal(reliability.crashFreeCompletionRate, 1);
    assert.equal(reliability.verifiedOutcomeRate, 1);
    const serialized = JSON.stringify(reliability);
    assert.equal(serialized.includes('health-sentinel-4821'), false);
    assert.equal(serialized.includes(submitted.taskId), false);
    for (const value of Object.values(reliability)) assert.ok(value === null || typeof value === 'number' || typeof value === 'string');
  } finally { await env.cleanup(); }
});
