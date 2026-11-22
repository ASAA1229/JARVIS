import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/freePort.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';

const OWNER_TOKEN = 'device-revocation-sweep-token-0123456789abcdef';
const previousToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;
const dir = mkdtempSync(join(tmpdir(), 'jarvis-revocation-sweep-'));
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
after(() => {
  if (previousToken === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN;
  else process.env.JARVIS_OWNER_CONTROL_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

type Keys = { privateKey: string; publicKey: string };
type Who = { deviceId: string; sessionId: string; keys: Keys };

function enroll(server: JarvisServer, permissions: Permission[], name: string, platform = 'Browser') {
  const service = server.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, name, keys.publicKey, platform);
  assert.equal(enrolled.success, true);
  return { deviceId: enrolled.deviceId!, keys };
}
function login(server: JarvisServer, d: { deviceId: string; keys: Keys }): Who {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const created = server.getService().identity.createSession(d.deviceId, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, d.keys.privateKey), timestamp, nonce);
  assert.equal(created.success, true);
  return { ...d, sessionId: created.sessionId! };
}
function headers(who: Who, method: string, path: string, body?: unknown) {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const canonical = CryptoUtil.buildCanonicalRequestString(method, path, who.sessionId, timestamp, nonce, body);
  return {
    'Content-Type': 'application/json', 'x-session-id': who.sessionId,
    'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce,
    'x-request-signature': CryptoUtil.signData(canonical, who.keys.privateKey),
  };
}
const call = (port: number, who: Who, method: string, path: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${port}${path}`, { method, headers: headers(who, method, path, body), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

test('E2:D4.5 a revoked device loses tokens, event stream, wake session, approvals and queued phone commands, including after restart', async () => {
  const paths = [join(dir, 'audit.log'), join(dir, 'devices.json')] as const;
  const port1 = await freePort();
  const first = new JarvisServer(port1, ...paths);
  await first.start();
  const service1 = first.getService();

  const owner = enroll(first, [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE], 'owner');
  const requester = enroll(first, [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE, Permission.APP_LAUNCH], 'requester');
  const phone = enroll(first, [Permission.SYSTEM_INFO_READ], 'phone', 'Android');
  const ownerWho = login(first, owner);
  const requesterWho = login(first, requester);
  const phoneWho = login(first, phone);

  // The requester has a pending approval, an armed wake session and a queued phone command.
  const pending = await service1.submitOperations(requesterWho.sessionId, 'Write a note', [{ operation: 'memory:save', parameters: { category: 'preference', content: 'revocation sweep' } }]);
  assert.equal(pending.state, TaskState.AWAITING_APPROVAL);
  assert.equal((await call(port1, requesterWho, 'POST', '/api/voice/wake-session', { action: 'wake' })).status, 200);
  const queued = await call(port1, requesterWho, 'POST', '/api/android/commands/create', { operation: 'android.app.list', targetDeviceId: phone.deviceId });
  assert.equal(queued.status, 201);
  const commandId = ((await queued.json()) as { command: { id: string } }).command.id;
  assert.equal((await call(port1, requesterWho, 'GET', '/api/events')).status, 200);

  // Owner revokes the requester through the token-gated recovery path.
  const revoked = await fetch(`http://127.0.0.1:${port1}/api/owner/recovery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-owner-control-token': OWNER_TOKEN },
    body: JSON.stringify({ action: 'revoke_device', deviceId: requester.deviceId, confirm: 'RECOVER' }),
  });
  assert.equal(revoked.status, 200);

  // Tokens, event stream and wake session are dead at once.
  for (const [method, path, body] of [['GET', '/api/events', undefined], ['GET', '/api/tasks', undefined], ['POST', '/api/voice/wake-session', { action: 'state' }]] as const) {
    assert.equal((await call(port1, requesterWho, method, path, body)).status, 401, `${path} must reject a revoked device`);
  }
  assert.equal(service1.identity.validateDeviceSession(requesterWho.sessionId).valid, false);
  // Pending approval is invalid and its task is cancelled; the approval can no longer be granted.
  assert.equal(service1.policy.getApproval(pending.approvalId!), undefined);
  assert.equal(service1.getTask(pending.taskId)?.state, TaskState.CANCELLED);
  assert.equal((await service1.approveTask(pending.approvalId!, ownerWho.sessionId)).success, false);
  // The queued phone command from the revoked requester is cancelled and never handed to the phone.
  const next = await call(port1, phoneWho, 'GET', '/api/android/commands/next');
  assert.equal(next.status, 200);
  assert.equal(((await next.json()) as { command: unknown }).command, null);
  const results = await call(port1, ownerWho, 'GET', '/api/android/commands/results');
  assert.equal(results.status, 200);
  assert.ok(!((await results.json()) as { results: Array<{ id: string; state: string }> }).results.some((r) => r.id === commandId && r.state === 'PENDING'));
  // The owner's own stream does not leak anything to the revoked device and still works.
  assert.equal((await call(port1, ownerWho, 'GET', '/api/events')).status, 200);
  await first.stop();

  // Restart: revocation is durable; no session is restored; the device cannot sign a new one.
  const port2 = await freePort();
  const second = new JarvisServer(port2, ...paths);
  await second.start();
  try {
    const service2 = second.getService();
    assert.equal(service2.identity.getDevice(requester.deviceId)?.status, 'REVOKED');
    assert.equal(service2.identity.validateDeviceSession(requesterWho.sessionId).valid, false);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const relogin = service2.identity.createSession(requester.deviceId, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, requester.keys.privateKey), timestamp, nonce);
    assert.equal(relogin.success, false);
    assert.notEqual(service2.getTask(pending.taskId)?.state, TaskState.AWAITING_APPROVAL);
    assert.equal(service2.policy.getApproval(pending.approvalId!), undefined);
    assert.equal(service2.identity.getDevice(owner.deviceId)?.status, 'ACTIVE');
  } finally {
    await second.stop();
  }
});
