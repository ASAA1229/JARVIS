import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { JarvisServer } from '../src/server/server.js';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { TaskState, Permission } from '../src/core/types.js';
import { rmSync, existsSync, writeFileSync } from 'node:fs';

process.env.JARVIS_OWNER_CONTROL_TOKEN = 'test-owner-control-token';

const TEST_AUDIT_LOG = './data/test_audit_e2e_recovery.log';
const TEST_STATE_FILE = './data/test_state_e2e_recovery.json';
const TEST_PORT = 3899;

function signedHeaders(
  sessionId: string,
  privateKey: string,
  method: string,
  path: string,
  body?: unknown,
): Record<string, string> {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const canonical = CryptoUtil.buildCanonicalRequestString(method, path, sessionId, timestamp, nonce, body);
  const signature = CryptoUtil.signData(canonical, privateKey);
  return {
    'Content-Type': 'application/json',
    'x-session-id': sessionId,
    'x-request-timestamp': String(timestamp),
    'x-request-nonce': nonce,
    'x-request-signature': signature,
  };
}

describe('JARVIS Milestone 6: Live HTTP Runtime, Recovery & Persistence Verification', { concurrency: false }, () => {
  let server: JarvisServer;
  let companionKeypair: { publicKey: string; privateKey: string };
  let companionDeviceId: string;
  let companionSessionId: string;

  beforeEach(async () => {
    if (existsSync(TEST_AUDIT_LOG)) rmSync(TEST_AUDIT_LOG, { force: true });
    if (existsSync(TEST_STATE_FILE)) rmSync(TEST_STATE_FILE, { force: true });

    server = new JarvisServer(TEST_PORT, TEST_AUDIT_LOG, TEST_STATE_FILE);
    await server.start();

    companionKeypair = CryptoUtil.generateEd25519KeyPair();
  });

  afterEach(async () => {
    await server.stop();
    if (existsSync(TEST_AUDIT_LOG)) rmSync(TEST_AUDIT_LOG, { force: true });
    if (existsSync(TEST_STATE_FILE)) rmSync(TEST_STATE_FILE, { force: true });
  });

  test('E2E-LIVE-01: Full HTTP Lifecycle (Status -> Challenge -> Enroll -> Auth -> Request -> Approve -> Launch -> Revoke)', async () => {
    // 1. Status Check
    const statusRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
    const statusData = await statusRes.json();
    assert.strictEqual(statusData.status, 'ONLINE');
    assert.deepStrictEqual(Object.keys(statusData).sort(), ['status']);

    // 2. Generate Enrollment Challenge
    const challengeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/enrollment/challenge`, { method: 'POST', headers: { 'x-owner-control-token': 'test-owner-control-token' } });
    const challengeData = await challengeRes.json();
    assert.ok(challengeData.challengeToken);

    // 3. Redeem Challenge
    const enrollmentName = 'Android Companion (E2E Test Device)';
    const enrollmentProof = CryptoUtil.signData(
      `ENROLLMENT_PROOF:${challengeData.challengeToken}:${enrollmentName}:${CryptoUtil.sha256(companionKeypair.publicKey)}`,
      companionKeypair.privateKey,
    );
    const redeemRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/enrollment/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeToken: challengeData.challengeToken,
        deviceName: enrollmentName,
        publicKey: companionKeypair.publicKey,
        proofSignature: enrollmentProof,
      }),
    });
    const redeemData = await redeemRes.json();
    assert.strictEqual(redeemData.success, true);
    companionDeviceId = redeemData.deviceId;

    // 4. Authenticate & Create Session
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, companionKeypair.privateKey);
    const sessionRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: companionDeviceId,
        signature: sig,
        timestamp,
        nonce,
      }),
    });
    const sessionData = await sessionRes.json();
    assert.strictEqual(sessionData.success, true);
    companionSessionId = sessionData.sessionId;

    // 5. Submit Read-Only Request (OS Facts)
    const req1Body = { text: 'What is the OS version?' };
    const req1Res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers: signedHeaders(companionSessionId, companionKeypair.privateKey, 'POST', '/api/request', req1Body),
      body: JSON.stringify(req1Body),
    });
    const req1Data = await req1Res.json();
    assert.strictEqual(req1Data.state, 'COMPLETED');
    assert.ok(req1Data.data.platform);

    // 6. Submit State-Changing Request (Launch Notepad)
    const req2Body = { text: 'Please launch Notepad' };
    const req2Res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers: signedHeaders(companionSessionId, companionKeypair.privateKey, 'POST', '/api/request', req2Body),
      body: JSON.stringify(req2Body),
    });
    const req2Data = await req2Res.json();
    assert.strictEqual(req2Data.state, 'AWAITING_APPROVAL');
    assert.ok(req2Data.approvalId);

    // 7. Approve Task via Authorized Session
    const approveBody = { approvalId: req2Data.approvalId };
    const approveRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/approval/approve`, {
      method: 'POST',
      headers: signedHeaders(companionSessionId, companionKeypair.privateKey, 'POST', '/api/approval/approve', approveBody),
      body: JSON.stringify(approveBody),
    });
    const approveData = await approveRes.json();
    assert.strictEqual(approveData.success, true);
    assert.strictEqual(approveData.state, 'COMPLETED');

    // 8. Revoke Device
    const revokeBody = { deviceId: companionDeviceId };
    const revokeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/revoke`, {
      method: 'POST',
      headers: signedHeaders(companionSessionId, companionKeypair.privateKey, 'POST', '/api/device/revoke', revokeBody),
      body: JSON.stringify(revokeBody),
    });
    const revokeData = await revokeRes.json();
    assert.strictEqual(revokeData.success, true);

    // 9. Subsequent request must be rejected
    const afterRevokeBody = { text: 'What is the OS version?' };
    const reqAfterRevoke = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers: signedHeaders(companionSessionId, companionKeypair.privateKey, 'POST', '/api/request', afterRevokeBody),
      body: JSON.stringify(afterRevokeBody),
    });
    assert.strictEqual(reqAfterRevoke.status, 401); // Authentication failures use the correct HTTP status
  });


  test('SEC-API-00: Enrollment challenge rejects requests without owner control authorization', async () => {
    const probePort = TEST_PORT + 20;
    const probeServer = new JarvisServer(probePort, TEST_AUDIT_LOG + '.owner-auth', TEST_STATE_FILE + '.owner-auth');
    await probeServer.start();
    try {
      const denied = await fetch(`http://127.0.0.1:${probePort}/api/enrollment/challenge`, { method: 'POST' });
      assert.strictEqual(denied.status, 401);
      await denied.arrayBuffer();
    } finally {
      await probeServer.stop();
      for (const path of [TEST_AUDIT_LOG + '.owner-auth', TEST_STATE_FILE + '.owner-auth']) {
        if (existsSync(path)) rmSync(path, { force: true });
      }
    }
  });

  test('SEC-API-10: Enrollment rejects a public key without proof of private-key possession', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/enrollment/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeToken: challenge.challengeToken,
        deviceName: 'Invalid Proof Device',
        publicKey: kp.publicKey,
        proofSignature: 'invalid-signature',
      }),
    });
    assert.strictEqual(response.status, 401);
    const deviceId = `dev-${CryptoUtil.sha256(kp.publicKey).substring(0, 16)}`;
    assert.strictEqual(server.getService().identity.getDevice(deviceId), undefined);
  });

  test('SEC-API-01: HUD cannot provision a session without device-bound proof', async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/hud/session`, { method: 'POST' });
    assert.strictEqual(response.status, 503);
    const body = await response.json();
    assert.strictEqual(body.code, 'SECURE_HUD_ENROLLMENT_REQUIRED');
    assert.strictEqual('sessionId' in body, false);
  });

  test('SEC-API-02: Public status endpoint exposes only minimal health state', async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/status`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.deepStrictEqual(Object.keys(body), ['status']);
    assert.strictEqual(body.status, 'ONLINE');
  });

  test('SEC-API-03: Audit endpoint denies unauthenticated access', async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/audit`);
    assert.strictEqual(response.status, 401);
  });

  test('SEC-API-04: API rejects malformed JSON, wrong content type, and invalid session payloads', async () => {
    const malformed = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{',
    });
    assert.strictEqual(malformed.status, 400);

    const wrongType = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'not-json',
    });
    assert.strictEqual(wrongType.status, 415);

    const missingFields = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.strictEqual(missingFields.status, 400);
  });

  test('SEC-API-08: Protected requests require a valid signature over the exact body', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Signed Request Test', kp.publicKey);
    assert.strictEqual(enroll.success, true);
    const sessionTimestamp = Date.now();
    const sessionNonce = CryptoUtil.randomToken(16);
    const sessionSignature = CryptoUtil.signData(`SESSION_REQUEST:${sessionTimestamp}:${sessionNonce}`, kp.privateKey);
    const session = server.getService().identity.createSession(enroll.deviceId!, sessionSignature, sessionTimestamp, sessionNonce);
    assert.strictEqual(session.success, true);

    const signedBody = { text: 'What is the OS version?' };
    const tamperedBody = { text: 'Please launch Notepad' };
    const headers = signedHeaders(session.sessionId!, kp.privateKey, 'POST', '/api/request', signedBody);
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers,
      body: JSON.stringify(tamperedBody),
    });
    assert.strictEqual(response.status, 401);
  });

  test('SEC-API-09: A signed API request nonce is single-use', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Request Replay Test', kp.publicKey);
    assert.strictEqual(enroll.success, true);
    const sessionTimestamp = Date.now();
    const sessionNonce = CryptoUtil.randomToken(16);
    const sessionSignature = CryptoUtil.signData(`SESSION_REQUEST:${sessionTimestamp}:${sessionNonce}`, kp.privateKey);
    const session = server.getService().identity.createSession(enroll.deviceId!, sessionSignature, sessionTimestamp, sessionNonce);
    assert.strictEqual(session.success, true);

    const body = { text: 'What is the OS version?' };
    const headers = signedHeaders(session.sessionId!, kp.privateKey, 'POST', '/api/request', body);
    const first = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    assert.strictEqual(first.status, 200);
    const replay = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST', headers, body: JSON.stringify(body),
    });
    assert.strictEqual(replay.status, 401);
  });

  test('SEC-API-07: Fresh session signature cannot be replayed with the same nonce', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Session Replay Test', kp.publicKey);
    assert.strictEqual(enroll.success, true);

    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, kp.privateKey);
    const first = server.getService().identity.createSession(enroll.deviceId!, signature, timestamp, nonce);
    assert.strictEqual(first.success, true);

    const replay = server.getService().identity.createSession(enroll.deviceId!, signature, timestamp, nonce);
    assert.strictEqual(replay.success, false);
    assert.match(replay.error || '', /nonce has already been used/i);
  });

  test('SEC-API-05: API rejects oversized JSON payloads', async () => {
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ oversized: 'x'.repeat(70 * 1024) }),
    });
    assert.strictEqual(response.status, 413);
  });

  test('SEC-API-06: Authenticated ordinary device cannot read privileged audit records', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Audit Access Test', companionKeypair.publicKey);
    assert.strictEqual(enroll.success, true);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, companionKeypair.privateKey);
    const session = server.getService().identity.createSession(enroll.deviceId!, signature, timestamp, nonce);
    assert.strictEqual(session.success, true);

    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/audit`, {
      headers: signedHeaders(session.sessionId!, companionKeypair.privateKey, 'GET', '/api/audit'),
    });
    assert.strictEqual(response.status, 403);
  });

  test('SEC-API-11: Reject endpoint returns a stable not-found response for unknown approvals', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Reject Route Test', kp.publicKey);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, kp.privateKey);
    const session = server.getService().identity.createSession(enroll.deviceId!, signature, timestamp, nonce);
    assert.strictEqual(session.success, true);

    const body = { approvalId: 'appr-does-not-exist' };
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/approval/reject`, {
      method: 'POST',
      headers: signedHeaders(session.sessionId!, kp.privateKey, 'POST', '/api/approval/reject', body),
      body: JSON.stringify(body),
    });
    assert.strictEqual(response.status, 404);
  });

  test('SEC-API-12: Ordinary device cannot revoke a different device', async () => {
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Revocation Permission Test', kp.publicKey);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, kp.privateKey);
    const session = server.getService().identity.createSession(enroll.deviceId!, signature, timestamp, nonce);
    assert.strictEqual(session.success, true);

    const body = { deviceId: 'dev-another-device', reason: 'unauthorized cross-device revoke attempt' };
    const response = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/revoke`, {
      method: 'POST',
      headers: signedHeaders(session.sessionId!, kp.privateKey, 'POST', '/api/device/revoke', body),
      body: JSON.stringify(body),
    });
    assert.strictEqual(response.status, 403);
  });

  test('RECOVER-01: Persistent device revocation remains enforced after server restart', async () => {
    // 1. Enroll and then revoke a device
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Phone Persist Test', kp.publicKey);
    assert.strictEqual(enroll.success, true);

    const ts = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, kp.privateKey);
    const sess = server.getService().identity.createSession(enroll.deviceId!, sig, ts, nonce);
    assert.strictEqual(sess.success, true);

    // Revoke device
    server.getService().identity.revokeDevice(enroll.deviceId!, 'Revoked for restart test');

    // 2. Simulate Host Restart: Stop server and instantiate fresh server pointing to same state file
    await server.stop();

    const restartedServer = new JarvisServer(TEST_PORT + 1, TEST_AUDIT_LOG, TEST_STATE_FILE);
    await restartedServer.start();

    try {
      // Confirm device is still recognized as REVOKED
      const device = restartedServer.getService().identity.getDevice(enroll.deviceId!);
      assert.ok(device);
      assert.strictEqual(device.status, 'REVOKED');

      // Attempting session creation on restarted server must be rejected
      const ts2 = Date.now();
      const nonce2 = CryptoUtil.randomToken(16);
      const sig2 = CryptoUtil.signData(`SESSION_REQUEST:${ts2}:${nonce2}`, kp.privateKey);
      const sessAfterRestart = restartedServer.getService().identity.createSession(enroll.deviceId!, sig2, ts2, nonce2);
      assert.strictEqual(sessAfterRestart.success, false);
      assert.match(sessAfterRestart.error || '', /Device is revoked/);
    } finally {
      await restartedServer.stop();
    }
  });

  test('RECOVER-03: Corrupt persisted device state blocks enrollment and session creation', async () => {
    await server.stop();
    writeFileSync(TEST_STATE_FILE, '{ invalid-json', 'utf-8');
    server = new JarvisServer(TEST_PORT + 2, TEST_AUDIT_LOG, TEST_STATE_FILE);
    await server.start();

    const challenge = server.getService().identity.createEnrollmentChallenge();
    const enroll = server.getService().identity.enrollDevice(
      challenge.challengeToken,
      'Must Not Enroll',
      companionKeypair.publicKey,
    );
    assert.strictEqual(enroll.success, false);
    assert.match(enroll.error || '', /state is unhealthy/i);
    const health = await fetch(`http://127.0.0.1:${TEST_PORT + 2}/api/status`);
    assert.strictEqual(health.status, 200);
    assert.strictEqual((await health.json()).status, 'DEGRADED');
  });

  test('RECOVER-02: Compromised audit chain causes fail-closed execution block', async () => {
    // 1. Enroll valid device and establish session
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Audit Compromise Device', kp.publicKey);
    const ts = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, kp.privateKey);
    const sess = server.getService().identity.createSession(enroll.deviceId!, sig, ts, nonce);

    // Initial query succeeds
    const initialRes = await server.getService().submitRequest(sess.sessionId!, 'Check memory');
    assert.strictEqual(initialRes.state, TaskState.COMPLETED);

    // 2. Corrupt audit chain intentionally in-memory
    const records = server.getService().audit.getRecords() as unknown as { hash: string }[];
    records[0].hash = '0000000000000000000000000000000000000000000000000000000000000000';

    // 3. Subsequent execution must fail-closed due to audit integrity violation
    const compromisedRes = await server.getService().submitRequest(sess.sessionId!, 'Check memory');
    assert.strictEqual(compromisedRes.state, TaskState.FAILED);
    assert.match(compromisedRes.message, /Audit chain integrity violation/);
  });
});
