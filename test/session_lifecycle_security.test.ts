import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuditLogger } from '../src/audit/audit.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { DeviceIdentityManager } from '../src/core/identity.js';
import { Permission } from '../src/core/types.js';

test('IDENTITY-SESSION-01: invalid session TTL values are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-session-ttl-'));
  try {
    const identity = new DeviceIdentityManager(new AuditLogger(join(directory, 'audit.log')));
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 86401]) {
      const result = identity.createSession('missing-device', 'signature', Date.now(), 'a'.repeat(32), ttlSeconds);
      assert.equal(result.success, false);
      assert.match(result.error || '', /TTL must be an integer/i);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('IDENTITY-SESSION-02: audit failure cannot leave a newly created session active', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-session-audit-'));
  const auditPath = join(directory, 'audit.log');
  const statePath = join(directory, 'devices.json');
  try {
    const audit = new AuditLogger(auditPath);
    const identity = new DeviceIdentityManager(audit, statePath);
    const keyPair = CryptoUtil.generateEd25519KeyPair();
    const challenge = identity.createEnrollmentChallenge();
    const enrolled = identity.enrollDevice(challenge.challengeToken, 'Session Audit Test', keyPair.publicKey);
    assert.equal(enrolled.success, true);
    assert.ok(enrolled.deviceId);
    rmSync(auditPath, { force: true });
    mkdirSync(auditPath);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData('SESSION_REQUEST:' + timestamp + ':' + nonce, keyPair.privateKey);
    const result = identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
    assert.equal(result.success, false);
    assert.match(result.error || '', /durably audited/i);
    assert.equal(result.sessionId, undefined);
    assert.equal(identity.hasActiveSession(enrolled.deviceId!), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('IDENTITY-ENROLL-01: invalid enrollment challenge TTL values are rejected', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-enroll-ttl-'));
  try {
    const identity = new DeviceIdentityManager(new AuditLogger(join(directory, 'audit.log')));
    for (const ttlSeconds of [0, -1, 1.5, Number.NaN, 3601]) {
      assert.throws(() => identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ], ttlSeconds), /Enrollment challenge TTL/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('IDENTITY-ENROLL-02: enrolled permissions are a copy of the challenge allowlist', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-enroll-copy-'));
  try {
    const identity = new DeviceIdentityManager(new AuditLogger(join(directory, 'audit.log')));
    const permissions = [Permission.SYSTEM_INFO_READ];
    const challenge = identity.createEnrollmentChallenge(permissions);
    permissions.push(Permission.DEVICE_MANAGE);
    const keyPair = CryptoUtil.generateEd25519KeyPair();
    const enrolled = identity.enrollDevice(challenge.challengeToken, 'Copy Test', keyPair.publicKey);
    assert.equal(enrolled.success, true);
    const device = identity.getDevice(enrolled.deviceId!);
    assert.deepEqual(device?.permissions, [Permission.SYSTEM_INFO_READ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('IDENTITY-SESSION-03: a session is unusable at its exact expiry instant', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-session-exact-'));
  try {
    const identity = new DeviceIdentityManager(new AuditLogger(join(directory, 'audit.log')));
    const keyPair = CryptoUtil.generateEd25519KeyPair();
    const challenge = identity.createEnrollmentChallenge();
    const enrolled = identity.enrollDevice(challenge.challengeToken, 'Exact Expiry', keyPair.publicKey);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData('SESSION_REQUEST:' + timestamp + ':' + nonce, keyPair.privateKey);
    const created = identity.createSession(enrolled.deviceId!, signature, timestamp, nonce, 60);
    assert.equal(created.success, true);
    const session = (identity as unknown as { sessions: Map<string, { expiresAt: number }> }).sessions.get(created.sessionId!);
    assert.ok(session);
    const originalNow = Date.now;
    Date.now = () => session.expiresAt;
    try {
      const validation = identity.validateDeviceSession(created.sessionId!);
      assert.equal(validation.valid, false);
      assert.match(validation.error || '', /expired/i);
    } finally {
      Date.now = originalNow;
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
