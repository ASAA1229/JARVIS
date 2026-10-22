import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { JarvisServer } from '../src/server/server.js';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { TaskState, Permission } from '../src/core/types.js';
import { rmSync, existsSync } from 'node:fs';

const TEST_AUDIT_LOG = './data/test_audit_e2e_recovery.log';
const TEST_STATE_FILE = './data/test_state_e2e_recovery.json';
const TEST_PORT = 3899;

describe('JARVIS Milestone 6: Live HTTP Runtime, Recovery & Persistence Verification', () => {
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
    assert.strictEqual(statusData.auditIntegrity.valid, true);

    // 2. Generate Enrollment Challenge
    const challengeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/enrollment/challenge`, { method: 'POST' });
    const challengeData = await challengeRes.json();
    assert.ok(challengeData.challengeToken);

    // 3. Redeem Challenge
    const redeemRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/enrollment/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeToken: challengeData.challengeToken,
        deviceName: 'Android Companion (E2E Test Device)',
        publicKey: companionKeypair.publicKey,
      }),
    });
    const redeemData = await redeemRes.json();
    assert.strictEqual(redeemData.success, true);
    companionDeviceId = redeemData.deviceId;

    // 4. Authenticate & Create Session
    const timestamp = Date.now();
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}`, companionKeypair.privateKey);
    const sessionRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: companionDeviceId,
        signature: sig,
        timestamp,
      }),
    });
    const sessionData = await sessionRes.json();
    assert.strictEqual(sessionData.success, true);
    companionSessionId = sessionData.sessionId;

    // 5. Submit Read-Only Request (OS Facts)
    const req1Res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': companionSessionId,
      },
      body: JSON.stringify({ text: 'What is the OS version?' }),
    });
    const req1Data = await req1Res.json();
    assert.strictEqual(req1Data.state, 'COMPLETED');
    assert.ok(req1Data.data.platform);

    // 6. Submit State-Changing Request (Launch Notepad)
    const req2Res = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': companionSessionId,
      },
      body: JSON.stringify({ text: 'Please launch Notepad' }),
    });
    const req2Data = await req2Res.json();
    assert.strictEqual(req2Data.state, 'AWAITING_APPROVAL');
    assert.ok(req2Data.approvalId);

    // 7. Approve Task via Authorized Session
    const approveRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/approval/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': companionSessionId,
      },
      body: JSON.stringify({ approvalId: req2Data.approvalId }),
    });
    const approveData = await approveRes.json();
    assert.strictEqual(approveData.success, true);
    assert.strictEqual(approveData.state, 'COMPLETED');

    // 8. Revoke Device
    const revokeRes = await fetch(`http://127.0.0.1:${TEST_PORT}/api/device/revoke`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': companionSessionId,
      },
      body: JSON.stringify({ deviceId: companionDeviceId }),
    });
    const revokeData = await revokeRes.json();
    assert.strictEqual(revokeData.success, true);

    // 9. Subsequent request must be rejected
    const reqAfterRevoke = await fetch(`http://127.0.0.1:${TEST_PORT}/api/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-id': companionSessionId,
      },
      body: JSON.stringify({ text: 'What is the OS version?' }),
    });
    assert.strictEqual(reqAfterRevoke.status, 500); // Throws auth rejection
  });

  test('RECOVER-01: Persistent device revocation remains enforced after server restart', async () => {
    // 1. Enroll and then revoke a device
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Phone Persist Test', kp.publicKey);
    assert.strictEqual(enroll.success, true);

    const ts = Date.now();
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${ts}`, kp.privateKey);
    const sess = server.getService().identity.createSession(enroll.deviceId!, sig, ts);
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
      const sig2 = CryptoUtil.signData(`SESSION_REQUEST:${ts2}`, kp.privateKey);
      const sessAfterRestart = restartedServer.getService().identity.createSession(enroll.deviceId!, sig2, ts2);
      assert.strictEqual(sessAfterRestart.success, false);
      assert.match(sessAfterRestart.error || '', /Device is revoked/);
    } finally {
      await restartedServer.stop();
    }
  });

  test('RECOVER-02: Compromised audit chain causes fail-closed execution block', async () => {
    // 1. Enroll valid device and establish session
    const challenge = server.getService().identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = server.getService().identity.enrollDevice(challenge.challengeToken, 'Audit Compromise Device', kp.publicKey);
    const ts = Date.now();
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${ts}`, kp.privateKey);
    const sess = server.getService().identity.createSession(enroll.deviceId!, sig, ts);

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
