import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOTP } from 'otpauth';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceIdentityManager } from '../src/core/identity.js';
import { DeviceSecurityService } from '../src/core/deviceSecurity.js';
import { DeviceStatus, Permission } from '../src/core/types.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { PolicyGateway } from '../src/policy/gateway.js';

/** JARVIS-US-003 follow-ups: replacement devices after revocation, and emergency revocation invalidating pending enrollment. */
const OWNER_TOKEN = 'test-owner-token-revoke-followups-0123456789abcdef';
const OWNER = [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-revoke-followups-'));
  const audit = new AuditLogger(join(dir, 'audit.log'));
  const identity = new DeviceIdentityManager(audit, join(dir, 'devices.json'));
  const enroll = (permissions: Permission[] = OWNER) => {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = identity.createEnrollmentChallenge(permissions);
    const result = identity.enrollDevice(challenge.challengeToken, 'device', keys.publicKey);
    assert.equal(result.success, true);
    return { id: result.deviceId!, keys };
  };
  const login = (device: { id: string; keys: { privateKey: string } }) => {
    const ts = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    return identity.createSession(device.id, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, device.keys.privateKey), ts, nonce);
  };
  const security = new DeviceSecurityService(identity, audit, new PolicyGateway(audit), OWNER_TOKEN, join(dir, 'security.json'));
  return { dir, audit, identity, enroll, login, security, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const codeFor = (secret: string, at: number) => new TOTP({ issuer: 'JARVIS', label: 'JARVIS Owner', algorithm: 'SHA1', digits: 6, period: 30, secret }).generate({ timestamp: at });

test('a replacement device enrolls with a NEW key after a revocation; the revoked device and its key stay blocked', () => {
  const f = fixture();
  try {
    const lost = f.enroll();
    const lostSession = f.login(lost);
    assert.equal(lostSession.success, true);
    assert.equal(f.identity.revokeDevice(lost.id, 'lost phone'), true);
    assert.equal(f.login(lost).success, false, 'the revoked device cannot start a session');

    const replacement = f.enroll();
    assert.notEqual(replacement.id, lost.id);
    assert.equal(f.identity.getDevice(replacement.id)?.status, DeviceStatus.ACTIVE);
    assert.equal(f.login(replacement).success, true, 'the replacement device works');
    assert.equal(f.identity.getDevice(lost.id)?.status, DeviceStatus.REVOKED, 'the lost device stays revoked');

    // The lost device's old key cannot be re-enrolled, even with a valid fresh challenge.
    const challenge = f.identity.createEnrollmentChallenge(OWNER);
    const reuse = f.identity.enrollDevice(challenge.challengeToken, 'old key again', lost.keys.publicKey);
    assert.equal(reuse.success, false);
    assert.match(reuse.error ?? '', /already enrolled/i);
  } finally { f.cleanup(); }
});

test('revoke-all invalidates unredeemed enrollment challenges (owner-token and SSO issued) but leaves expired ones alone', () => {
  const f = fixture();
  try {
    const owner = f.enroll();
    const ownerLogin = f.login(owner);
    assert.equal(ownerLogin.success, true);
    const pending = f.identity.createEnrollmentChallenge(OWNER);
    const ssoIssued = f.identity.createEnrollmentChallenge(OWNER, 120, { sub: 'sub-1', username: 'alice' });
    const result = f.identity.revokeAllDevices(owner.id);
    assert.equal(result.success, true);

    for (const challenge of [pending, ssoIssued]) {
      const keys = CryptoUtil.generateEd25519KeyPair();
      const attempt = f.identity.enrollDevice(challenge.challengeToken, 'after revoke-all', keys.publicKey);
      assert.equal(attempt.success, false, 'a challenge that predates revoke-all cannot enroll a device');
      assert.match(attempt.error ?? '', /already redeemed/i);
    }
    const records = f.audit.getRecords();
    const summary = records.find((record) => record.eventType === 'ENROLLMENT_CHALLENGES_INVALIDATED');
    assert.equal(summary?.details.count, 2);
    assert.equal(summary?.details.reason, 'revoke-all');
    assert.equal(records.find((record) => record.eventType === 'DEVICE_REVOKE_ALL')?.details.pendingEnrollmentsEnded, 2);
    assert.equal(JSON.stringify(records).includes(pending.challengeToken), false, 'tokens are never audited');
    assert.equal(f.audit.verifyIntegrity().valid, true);

    // A challenge issued after the emergency works normally (recovery path).
    const fresh = f.identity.createEnrollmentChallenge(OWNER);
    assert.equal(f.identity.enrollDevice(fresh.challengeToken, 'recovery device', CryptoUtil.generateEd25519KeyPair().publicKey).success, true);
  } finally { f.cleanup(); }
});

test('a refused revoke-all (not an owner device) does not touch pending challenges', () => {
  const f = fixture();
  try {
    const phone = f.enroll([Permission.SYSTEM_INFO_READ]);
    const pending = f.identity.createEnrollmentChallenge(OWNER);
    assert.equal(f.identity.revokeAllDevices(phone.id).success, false);
    assert.equal(f.identity.enrollDevice(pending.challengeToken, 'still valid', CryptoUtil.generateEd25519KeyPair().publicKey).success, true);
  } finally { f.cleanup(); }
});

test('QR enrollment transactions: cancelAllPending and creator revocation stop unfinished enrollments, finished ones are untouched', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const owner = f.enroll();
    const ownerDevice = f.identity.getDevice(owner.id)!;
    const setup = await f.security.startTotpSetup(ownerDevice);
    now += 30_000;
    assert.equal(f.security.verifyTotpSetup(ownerDevice, codeFor(setup.secret, now)), true);
    const stepUp = () => { now += 30_000; return codeFor(setup.secret, now); };

    const first = await f.security.createEnrollment(ownerDevice, stepUp());
    const second = await f.security.createEnrollment(ownerDevice, stepUp());
    assert.ok(f.security.getEnrollmentDetails(first.transactionId, first.code));
    assert.equal(f.security.cancelAllPending('revoke-all'), 2);
    assert.equal(f.security.getEnrollmentDetails(first.transactionId, first.code), undefined, 'a cancelled code can no longer be scanned');
    assert.equal(f.security.status(second.transactionId)?.state, 'CANCELLED');
    assert.equal(f.audit.getRecords().filter((record) => record.eventType === 'ENROLLMENT_TRANSACTIONS_CANCELLED').length, 1);

    // Revoking the device that created a transaction cancels its unfinished transactions.
    const third = await f.security.createEnrollment(ownerDevice, stepUp());
    assert.equal(f.security.cancelPendingCreatedBy('someone-else'), 0);
    assert.equal(f.security.cancelPendingCreatedBy(owner.id), 1);
    assert.equal(f.security.status(third.transactionId)?.state, 'CANCELLED');
    assert.equal(f.security.cancelAllPending('again'), 0, 'nothing left to cancel');
  } finally {
    Date.now = originalNow;
    f.cleanup();
  }
});
