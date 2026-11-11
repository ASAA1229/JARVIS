import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import { AndroidCommandQueue } from '../src/android/commandQueue.js';

const PORT = 3986;
const OWNER_TOKEN = 'owner-recovery-test-token-0123456789abcdef';
const base = `http://127.0.0.1:${PORT}`;
let server: JarvisServer;
let dir: string;
const previousToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;

function enroll(permissions: Permission[], name = 'recovery-test') {
  const service = server.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, name, keys.publicKey);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  return { deviceId: enrolled.deviceId!, sessionId: session.sessionId!, keys };
}

function signedHeaders(who: { sessionId: string; keys: { privateKey: string } }, method: string, path: string, body?: unknown) {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const canonical = CryptoUtil.buildCanonicalRequestString(method, path, who.sessionId, timestamp, nonce, body);
  return {
    'Content-Type': 'application/json', 'x-session-id': who.sessionId,
    'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce,
    'x-request-signature': CryptoUtil.signData(canonical, who.keys.privateKey),
  };
}

const recover = (body: unknown, token: string | null = OWNER_TOKEN) => fetch(`${base}/api/owner/recovery`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { 'x-owner-control-token': token } : {}) },
  body: JSON.stringify(body),
});

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-owner-recovery-'));
  process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
  server = new JarvisServer(PORT, join(dir, 'audit.log'), join(dir, 'devices.json'));
  await server.start();
});

after(async () => {
  await server.stop();
  if (previousToken === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN;
  else process.env.JARVIS_OWNER_CONTROL_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

test('recovery requires the owner token and an explicit confirmation', async () => {
  assert.equal((await recover({ action: 'reset_authenticator', confirm: 'RECOVER' }, null)).status, 401);
  assert.equal((await recover({ action: 'reset_authenticator', confirm: 'RECOVER' }, 'x'.repeat(OWNER_TOKEN.length))).status, 401);
  assert.equal((await recover({ action: 'reset_authenticator' })).status, 400);
  assert.equal((await recover({ action: 'delete_everything', confirm: 'RECOVER' })).status, 400);
  const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
  assert.equal(audit.includes(OWNER_TOKEN), false);
});

test('authenticator loss: owner token resets TOTP without any device session', async () => {
  const response = await recover({ action: 'reset_authenticator', confirm: 'RECOVER' });
  assert.equal(response.status, 200);
  assert.equal(server.getService().deviceSecurity!.getTotpStatus(), 'DISABLED');
  assert.ok(server.getService().audit.getRecords().some((r) => r.eventType === 'OWNER_RECOVERY_AUTHENTICATOR_RESET'));
});

test('lost phone: owner revokes it; its session and signed requests stop immediately', async () => {
  const phone = enroll([Permission.SYSTEM_INFO_READ]);
  const before = await fetch(`${base}/api/tasks`, { headers: signedHeaders(phone, 'GET', '/api/tasks') });
  assert.notEqual(before.status, 401);
  const response = await recover({ action: 'revoke_device', deviceId: phone.deviceId, confirm: 'RECOVER' });
  assert.equal(response.status, 200);
  const replay = await fetch(`${base}/api/tasks`, { headers: signedHeaders(phone, 'GET', '/api/tasks') });
  assert.equal(replay.status, 401);
  assert.equal((await recover({ action: 'revoke_device', deviceId: phone.deviceId, confirm: 'RECOVER' })).status, 404);
});

test('loss of every management device: revoke all, then fresh enrollment needs a NEW key', async () => {
  const manager = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE], 'old-manager');
  const response = await recover({ action: 'revoke_all_devices', confirm: 'RECOVER' });
  assert.equal(response.status, 200);
  const payload = await response.json() as { revokedDeviceIds: string[] };
  assert.ok(payload.revokedDeviceIds.includes(manager.deviceId));
  assert.ok(server.getService().identity.listDevices().every((d) => d.status !== 'ACTIVE'));

  // Bootstrap enrollment reopens with the owner token...
  const challenge = await fetch(`${base}/api/enrollment/challenge`, { method: 'POST', headers: { 'x-owner-control-token': OWNER_TOKEN } });
  assert.equal(challenge.status, 201);
  // ...but the revoked device cannot regain access with its old key.
  const service = server.getService();
  const reuse = service.identity.enrollDevice(service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ]).challengeToken, 'old-manager', manager.keys.publicKey);
  assert.equal(reuse.success, false);
});

test('revoke-all preserves the authenticator when any device revocation cannot be persisted', async () => {
  const manager = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE], 'storage-failure-manager');
  const statePath = join(dir, 'devices.json');
  const backupPath = join(dir, 'devices.json.backup');
  const service = server.getService();
  const resetsBefore = service.audit.getRecords().filter((record) => record.eventType === 'OWNER_RECOVERY_AUTHENTICATOR_RESET').length;

  // Make the device-state destination unusable after enrollment so revocation cannot
  // be durably committed. Restore the original file even if an assertion fails.
  renameSync(statePath, backupPath);
  mkdirSync(statePath);
  try {
    const response = await recover({ action: 'revoke_all_devices', confirm: 'RECOVER' });
    assert.equal(response.status, 409);
    const payload = await response.json() as { success: boolean; error: string; next: string };
    assert.equal(payload.success, false);
    assert.match(payload.error, /authenticator reset was not performed/);
    assert.match(payload.next, /retry recovery/);
    const resetsAfter = service.audit.getRecords().filter((record) => record.eventType === 'OWNER_RECOVERY_AUTHENTICATOR_RESET').length;
    assert.equal(resetsAfter, resetsBefore);
    const persisted = JSON.parse(readFileSync(backupPath, 'utf8')) as { devices: Array<{ id: string; status: string }> };
    assert.equal(persisted.devices.find((device) => device.id === manager.deviceId)?.status, 'ACTIVE');
  } finally {
    rmSync(statePath, { recursive: true, force: true });
    renameSync(backupPath, statePath);
  }
});

test('repeated wrong tokens are rate limited', async () => {
  let last = 0;
  for (let i = 0; i < 6; i++) last = (await recover({ action: 'reset_authenticator', confirm: 'RECOVER' }, 'wrong-token')).status;
  assert.equal(last, 429);
});

test('offline queue: revalidation, idempotent completion and cancellation', () => {
  const queue = new AndroidCommandQueue();
  // Authorization lapsed while the phone was offline -> never handed out.
  const stale = queue.create('phone-a', 'owner');
  assert.equal(queue.claimNext('phone-a', () => false), undefined);
  assert.equal(queue.resultsForRequester('owner').find((r) => r.id === stale.id)?.cancelReason, 'revalidation_failed');

  const command = queue.create('phone-a', 'owner');
  assert.equal(queue.claimNext('phone-a', () => true)?.id, command.id);
  const apps = [{ label: 'Settings', packageName: 'com.android.settings' }];
  assert.equal(queue.completeDetailed('phone-a', command.id, apps), 'completed');
  assert.equal(queue.completeDetailed('phone-a', command.id, [{ label: 'Other', packageName: 'x.y' }]), 'duplicate');
  assert.deepEqual(queue.resultsForRequester('owner').find((r) => r.id === command.id)?.apps, apps);

  const pending = queue.create('phone-a', 'owner');
  assert.equal(queue.cancel('owner', pending.id), 'cancelled');
  assert.equal(queue.cancel('owner', pending.id), 'already_cancelled');
  assert.equal(queue.cancel('intruder', pending.id), 'not_found');
  assert.equal(queue.cancel('owner', command.id), 'not_cancellable');
});
