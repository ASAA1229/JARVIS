import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';
import process from 'node:process';
import { TOTP } from 'otpauth';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceIdentityManager } from '../src/core/identity.js';
import { DeviceSecurityService } from '../src/core/deviceSecurity.js';
import { Permission } from '../src/core/types.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { JarvisServer } from '../src/server/server.js';
import { PolicyGateway } from '../src/policy/gateway.js';

const OWNER_TOKEN = 'test-owner-token-device-security-0123456789abcdef';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-device-security-'));
  const audit = new AuditLogger(join(dir, 'audit.log'));
  const identity = new DeviceIdentityManager(audit, join(dir, 'devices.json'));
  const ownerKeys = CryptoUtil.generateEd25519KeyPair();
  const challenge = identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const ownerEnroll = identity.enrollDevice(challenge.challengeToken, 'Owner browser', ownerKeys.publicKey);
  assert.equal(ownerEnroll.success, true);
  const owner = identity.getDevice(ownerEnroll.deviceId!)!;
  const security = new DeviceSecurityService(identity, audit, new PolicyGateway(audit), OWNER_TOKEN, join(dir, 'security.json'));
  return { dir, audit, identity, owner, ownerKeys, security };
}

function codeFor(secret: string, at = Date.now()) {
  return new TOTP({ issuer: 'JARVIS', label: 'JARVIS Owner', algorithm: 'SHA1', digits: 6, period: 30, secret }).generate({ timestamp: at });
}

test('TOTP provisioning creates a standards QR, verifies server-side, and encrypts the secret at rest', async () => {
  const f = fixture();
  const originalNow = Date.now;
  try {
    const setup = await f.security.startTotpSetup(f.owner);
    assert.match(setup.otpauth, /^otpauth:\/\/totp\/JARVIS:JARVIS%20Owner\?/);
    assert.match(setup.qrSvg, /^<svg/);
    assert.equal(f.security.getTotpStatus(), 'PENDING');
    assert.equal(f.security.verifyTotpSetup(f.owner, '000000'), false);
    const now = Date.now();
    Date.now = () => now + 30_000;
    assert.equal(f.security.verifyTotpSetup(f.owner, codeFor(setup.secret, now + 30_000)), true);
    assert.equal(f.security.getTotpStatus(), 'ENABLED');
    const encrypted = readFileSync(join(f.dir, 'security.json'), 'utf8');
    assert.equal(encrypted.includes(setup.secret), false);
    assert.equal(f.audit.getRecords().some((r) => JSON.stringify(r).includes(setup.secret)), false);
  } finally { Date.now = originalNow; rmSync(f.dir, { recursive: true, force: true }); }
});

test('enrollment QR creates a pending request; owner TOTP approval enrolls only the bound device', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const setup = await f.security.startTotpSetup(f.owner);
    now += 30_000;
    assert.equal(f.security.verifyTotpSetup(f.owner, codeFor(setup.secret, now)), true);
    now += 30_000;
    const created = await f.security.createEnrollment(f.owner, codeFor(setup.secret, now));
    assert.match(created.qrSvg, /^<svg/);
    assert.equal(f.identity.listDevices().length, 1);
    assert.deepEqual(f.security.getEnrollmentDetails(created.transactionId, created.code)?.permissions, [Permission.SYSTEM_INFO_READ]);

    const newKeys = CryptoUtil.generateEd25519KeyPair();
    const name = 'Phone A'; const platform = 'Android';
    const details = f.security.getEnrollmentDetails(created.transactionId, created.code)!;
    const requestHash = CryptoUtil.canonicalHash({ transactionId: created.transactionId, name, platform, publicKey: newKeys.publicKey, permissions: details.permissions, expiresAt: created.expiresAt });
    const proofSignature = CryptoUtil.signData(`JARVIS_ENROLLMENT_V1:${created.transactionId}:${requestHash}:${created.code}`, newKeys.privateKey);
    assert.throws(() => f.security.exchangeEnrollment({ transactionId: created.transactionId, code: created.code, name, platform, publicKey: newKeys.publicKey, proofSignature: 'A'.repeat(88) }), /proof verification failed/);
    assert.equal(f.security.exchangeEnrollment({ transactionId: created.transactionId, code: created.code, name, platform, publicKey: newKeys.publicKey, proofSignature }).state, 'AWAITING_OWNER_AUTHORIZATION');
    assert.equal(f.identity.listDevices().length, 1, 'the scanned request must not activate an identity');
    const [pending] = f.security.listPending(f.owner);
    assert.equal(pending.requestHash, requestHash);
    now += 30_000;
    await assert.rejects(f.security.approve(f.owner, created.transactionId, 'altered-request-hash', codeFor(setup.secret, now)), /expired or changed/);
    now += 30_000;
    const enrolled = f.security.approve(f.owner, created.transactionId, requestHash, codeFor(setup.secret, now));
    assert.equal(f.identity.getDevice(enrolled.deviceId)?.platform, 'Android');
    assert.deepEqual(f.identity.getDevice(enrolled.deviceId)?.permissions, [Permission.SYSTEM_INFO_READ]);
    assert.equal(f.security.status(created.transactionId)?.state, 'ENROLLED');
    assert.throws(() => f.security.exchangeEnrollment({ transactionId: created.transactionId, code: created.code, name, platform, publicKey: newKeys.publicKey, proofSignature }), /invalid, expired, or already used/);
  } finally { Date.now = originalNow; rmSync(f.dir, { recursive: true, force: true }); }
});

test('TOTP replay and repeated invalid codes fail closed; transaction cancellation invalidates its code', async () => {
  const f = fixture();
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const setup = await f.security.startTotpSetup(f.owner);
    now += 30_000;
    const valid = codeFor(setup.secret, now);
    assert.equal(f.security.verifyTotpSetup(f.owner, valid), true);
    assert.equal(f.security.verifyStepUp(f.owner, valid), false, 'an accepted step cannot be replayed');
    now += 30_000;
    const transaction = await f.security.createEnrollment(f.owner, codeFor(setup.secret, now));
    assert.equal(f.security.cancel(f.owner, transaction.transactionId), true);
    assert.equal(f.security.getEnrollmentDetails(transaction.transactionId, transaction.code), undefined);
    for (let i = 0; i < 5; i++) assert.equal(f.security.verifyStepUp(f.owner, '111111'), false);
    now += 15 * 60_000 + 1000;
    assert.equal(f.security.verifyStepUp(f.owner, codeFor(setup.secret, now)), true);
  } finally { Date.now = originalNow; rmSync(f.dir, { recursive: true, force: true }); }
});

test('a device without DEVICE_MANAGE cannot create an enrollment transaction', async () => {
  const f = fixture();
  try {
    f.owner.permissions = [Permission.SYSTEM_INFO_READ];
    await assert.rejects(f.security.createEnrollment(f.owner, '123456'), /lacks active device-management permission/);
    assert.equal(f.identity.listDevices().length, 1);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an enrollment transaction expires after its 120-second lifetime and cannot be exchanged', async () => {
  const f = fixture(); const originalNow = Date.now; let now = originalNow(); Date.now = () => now;
  try {
    const setup = await f.security.startTotpSetup(f.owner);
    now += 30_000;
    assert.equal(f.security.verifyTotpSetup(f.owner, codeFor(setup.secret, now)), true);
    now += 30_000;
    const tx = await f.security.createEnrollment(f.owner, codeFor(setup.secret, now));
    now += 121_000;
    assert.equal(f.security.statusForEnrollment(tx.transactionId, tx.code)?.state, 'EXPIRED');
    assert.equal(f.security.getEnrollmentDetails(tx.transactionId, tx.code), undefined);
  } finally { Date.now = originalNow; rmSync(f.dir, { recursive: true, force: true }); }
});

test('HTTP security routes require a signed DEVICE_MANAGE session and TOTP step-up', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-device-security-http-'));
  const oldToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;
  process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'devices.json'));
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    await server.start();
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = server.getService().identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const enrollment = server.getService().identity.enrollDevice(challenge.challengeToken, 'Owner', keys.publicKey);
    const nonce = CryptoUtil.randomToken(16);
    const sessionProof = CryptoUtil.signData(`SESSION_REQUEST:${now}:${nonce}`, keys.privateKey);
    const session = server.getService().identity.createSession(enrollment.deviceId!, sessionProof, now, nonce);
    assert.equal(session.success, true);
    const signed = (method: string, path: string, body?: unknown) => {
      const timestamp = Date.now(); const requestNonce = CryptoUtil.randomToken(16);
      const canonical = CryptoUtil.buildCanonicalRequestString(method, path, session.sessionId!, timestamp, requestNonce, body);
      return { 'Content-Type': 'application/json', 'x-session-id': session.sessionId!, 'x-request-timestamp': String(timestamp), 'x-request-nonce': requestNonce, 'x-request-signature': CryptoUtil.signData(canonical, keys.privateKey) };
    };
    const denied = await fetch(`http://127.0.0.1:${port}/api/enrollment/pending`);
    assert.equal(denied.status, 401);
    const setupResponse = await fetch(`http://127.0.0.1:${port}/api/security/totp/setup`, { method: 'POST', headers: signed('POST', '/api/security/totp/setup', {}), body: '{}' });
    assert.equal(setupResponse.status, 201);
    const setup = await setupResponse.json() as { secret: string; qrSvg: string };
    now += 30_000;
    const setupCode = codeFor(setup.secret, now);
    const verifyBody = { code: setupCode };
    const verified = await fetch(`http://127.0.0.1:${port}/api/security/totp/verify-setup`, { method: 'POST', headers: signed('POST', '/api/security/totp/verify-setup', verifyBody), body: JSON.stringify(verifyBody) });
    assert.equal(verified.status, 200);
    assert.match(setup.qrSvg, /^<svg/);
    now += 30_000;
    const transactionBody = { totpCode: codeFor(setup.secret, now), permissions: [Permission.SYSTEM_INFO_READ] };
    const transactionResponse = await fetch(`http://127.0.0.1:${port}/api/enrollment/transactions`, { method: 'POST', headers: signed('POST', '/api/enrollment/transactions', transactionBody), body: JSON.stringify(transactionBody) });
    assert.equal(transactionResponse.status, 201);
    const transaction = await transactionResponse.json() as { transactionId: string; code: string; qrSvg: string };
    assert.match(transaction.qrSvg, /^<svg/);
    assert.equal(server.getService().deviceSecurity?.status(transaction.transactionId)?.state, 'WAITING_FOR_SCAN');
    assert.equal(JSON.stringify(server.getService().audit.getRecords()).includes(transaction.code), false);
    const statusBody = { transactionId: transaction.transactionId, code: transaction.code };
    const privateStatus = await fetch(`http://127.0.0.1:${port}/api/enrollment/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statusBody) });
    assert.equal((await privateStatus.json() as { state: string }).state, 'WAITING_FOR_SCAN');
    const unboundStatus = await fetch(`http://127.0.0.1:${port}/api/enrollment/status?transactionId=${encodeURIComponent(transaction.transactionId)}`);
    assert.equal(unboundStatus.status, 404);
    const detailsBody = { transactionId: transaction.transactionId, code: transaction.code };
    const detailsResponse = await fetch(`http://127.0.0.1:${port}/api/enrollment/details`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(detailsBody) });
    const details = await detailsResponse.json() as { permissions: Permission[]; expiresAt: number };
    const phoneKeys = CryptoUtil.generateEd25519KeyPair();
    const name = 'Owner-approved phone'; const platform = 'Android';
    const requestHash = CryptoUtil.canonicalHash({ transactionId: transaction.transactionId, name, platform, publicKey: phoneKeys.publicKey, permissions: details.permissions, expiresAt: details.expiresAt });
    const proofSignature = CryptoUtil.signData(`JARVIS_ENROLLMENT_V1:${transaction.transactionId}:${requestHash}:${transaction.code}`, phoneKeys.privateKey);
    const exchangeBody = { transactionId: transaction.transactionId, code: transaction.code, name, platform, publicKey: phoneKeys.publicKey, proofSignature };
    const exchange = await fetch(`http://127.0.0.1:${port}/api/enrollment/exchange`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(exchangeBody) });
    assert.equal(exchange.status, 202);
    assert.equal(server.getService().identity.listDevices().length, 1, 'QR exchange alone must not enroll a device');
    const pendingResponse = await fetch(`http://127.0.0.1:${port}/api/enrollment/pending`, { headers: signed('GET', '/api/enrollment/pending') });
    const pending = await pendingResponse.json() as { requests: Array<{ transactionId: string; requestHash: string; permissions: Permission[] }> };
    assert.equal(pending.requests[0]?.requestHash, requestHash);
    assert.deepEqual(pending.requests[0]?.permissions, [Permission.SYSTEM_INFO_READ]);
    now += 30_000;
    const approvalBody = { transactionId: transaction.transactionId, requestHash, totpCode: codeFor(setup.secret, now) };
    const approval = await fetch(`http://127.0.0.1:${port}/api/enrollment/approve`, { method: 'POST', headers: signed('POST', '/api/enrollment/approve', approvalBody), body: JSON.stringify(approvalBody) });
    assert.equal(approval.status, 200);
    const approved = await approval.json() as { deviceId: string };
    const finalStatusResponse = await fetch(`http://127.0.0.1:${port}/api/enrollment/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(statusBody) });
    const finalStatus = await finalStatusResponse.json() as { state: string; deviceId: string };
    assert.equal(finalStatus.state, 'ENROLLED');
    assert.equal(finalStatus.deviceId, approved.deviceId);
    assert.equal(server.getService().identity.getDevice(approved.deviceId)?.platform, 'Android');

    const phoneTimestamp = Date.now(); const phoneNonce = CryptoUtil.randomToken(16);
    const phoneSignature = CryptoUtil.signData(`SESSION_REQUEST:${phoneTimestamp}:${phoneNonce}`, phoneKeys.privateKey);
    const phoneSessionResponse = await fetch(`http://127.0.0.1:${port}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: approved.deviceId, signature: phoneSignature, timestamp: phoneTimestamp, nonce: phoneNonce }) });
    const phoneSession = await phoneSessionResponse.json() as { sessionId: string; success: boolean };
    assert.equal(phoneSessionResponse.status, 200);
    assert.equal(phoneSession.success, true);
    now += 30_000;
    const revokeBody = { deviceId: approved.deviceId, reason: 'HTTP enrollment test', totpCode: codeFor(setup.secret, now) };
    const revoked = await fetch(`http://127.0.0.1:${port}/api/device/revoke`, { method: 'POST', headers: signed('POST', '/api/device/revoke', revokeBody), body: JSON.stringify(revokeBody) });
    assert.equal(revoked.status, 200);
    const protectedBody = { text: 'What is the OS version?' };
    const phoneReqNonce = CryptoUtil.randomToken(16); const phoneReqTime = Date.now();
    const phoneReqSignature = CryptoUtil.signData(CryptoUtil.buildCanonicalRequestString('POST', '/api/request', phoneSession.sessionId, phoneReqTime, phoneReqNonce, protectedBody), phoneKeys.privateKey);
    const phoneRequest = await fetch(`http://127.0.0.1:${port}/api/request`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-id': phoneSession.sessionId, 'x-request-timestamp': String(phoneReqTime), 'x-request-nonce': phoneReqNonce, 'x-request-signature': phoneReqSignature }, body: JSON.stringify(protectedBody) });
    assert.equal(phoneRequest.status, 401);
  } finally {
    Date.now = originalNow;
    await server.stop();
    if (oldToken === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN; else process.env.JARVIS_OWNER_CONTROL_TOKEN = oldToken;
    rmSync(dir, { recursive: true, force: true });
  }
});
