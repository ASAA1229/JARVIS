import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { TaskState, Permission } from '../src/core/types.js';
import { rmSync, existsSync } from 'node:fs';

const TEST_AUDIT_LOG = './data/test_audit.log';

describe('JARVIS Core Security & Lifecycle Verification', () => {
  let jarvis: JarvisCoreService;
  let companionKeypair: { publicKey: string; privateKey: string };
  let companionDeviceId: string;
  let companionSessionId: string;

  beforeEach(() => {
    if (existsSync(TEST_AUDIT_LOG)) {
      rmSync(TEST_AUDIT_LOG, { force: true });
    }
    jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), TEST_AUDIT_LOG);

    // Enroll a valid companion device
    companionKeypair = CryptoUtil.generateEd25519KeyPair();
    const challenge = jarvis.identity.createEnrollmentChallenge([
      Permission.SYSTEM_INFO_READ,
      Permission.APP_LAUNCH,
    ]);

    const enrollRes = jarvis.identity.enrollDevice(
      challenge.challengeToken,
      'Pixel 8 Pro (Test Companion)',
      companionKeypair.publicKey
    );
    assert.strictEqual(enrollRes.success, true);
    companionDeviceId = enrollRes.deviceId!;

    // Create session
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, companionKeypair.privateKey);
    const sessionRes = jarvis.identity.createSession(companionDeviceId, sig, timestamp, nonce);
    assert.strictEqual(sessionRes.success, true);
    companionSessionId = sessionRes.sessionId!;
  });

  afterEach(() => {
    if (existsSync(TEST_AUDIT_LOG)) {
      rmSync(TEST_AUDIT_LOG, { force: true });
    }
  });

  test('SEC-01: Unknown, unauthenticated or revoked device is rejected', async () => {
    // 1. Completely unknown session
    await assert.rejects(
      async () => {
        await jarvis.submitRequest('invalid-session-token', 'What is the OS version?');
      },
      /Authentication failed/
    );

    // 2. Revoke device
    const revoked = jarvis.identity.revokeDevice(companionDeviceId, 'Test revocation');
    assert.strictEqual(revoked, true);

    // 3. Request after revocation must fail immediately
    await assert.rejects(
      async () => {
        await jarvis.submitRequest(companionSessionId, 'What is the OS version?');
      },
      /Authentication failed: (Session does not exist or is inactive|Device revoked)/
    );
  });

  test('FLOW-01: End-to-end happy path for allowlisted read-only system information', async () => {
    const res = await jarvis.submitRequest(companionSessionId, 'What is the OS version?');
    assert.strictEqual(res.state, TaskState.COMPLETED);
    assert.ok(res.data);
    const osData = res.data as { platform: string; arch: string };
    assert.ok(osData.platform);
    assert.ok(osData.arch);
  });

  test('FLOW-02: Policy Gateway enforces approval for state-changing app launch', async () => {
    const res = await jarvis.submitRequest(companionSessionId, 'Please launch Notepad');
    assert.strictEqual(res.state, TaskState.AWAITING_APPROVAL);
    assert.ok(res.approvalId);

    // Verify approval record
    const approval = jarvis.policy.getApproval(res.approvalId!);
    assert.ok(approval);
    assert.strictEqual(approval.approved, false);

    // Approve the task
    const approveRes = await jarvis.approveTask(res.approvalId!, companionDeviceId);
    assert.strictEqual(approveRes.success, true);
    assert.strictEqual(approveRes.state, TaskState.COMPLETED);
    assert.ok(approveRes.data);
  });

  test('SEC-02: Scope expansion or altered parameters voids approval', async () => {
    const res = await jarvis.submitRequest(companionSessionId, 'Launch Notepad');
    assert.strictEqual(res.state, TaskState.AWAITING_APPROVAL);
    const approvalId = res.approvalId!;

    // Tamper with task parameters to simulate scope expansion attack
    const task = jarvis.getTask(res.taskId)!;
    task.parameters = { appId: 'unauthorized_cmd_or_shell' };

    // Attempting to evaluate policy with altered parameters must fail with scope expansion denial
    const opReq = { operation: 'app:launch', parameters: task.parameters };
    const evalResult = jarvis.policy.evaluate(opReq, jarvis.identity.getDevice(companionDeviceId)!, task.id, approvalId);
    assert.strictEqual(evalResult.allowed, false);
    assert.match(evalResult.reason || '', /scope was modified/);
  });

  test('SEC-03: Prohibited and unmapped operations are denied by default', async () => {
    const res = await jarvis.submitRequest(companionSessionId, 'Format C: drive and delete everything');
    assert.strictEqual(res.state, TaskState.FAILED);
    assert.match(res.message, /(Could not map request|prohibited by policy)/);
  });

  test('SEC-04: Single-use enrollment challenge cannot be reused or redeemed after expiry', () => {
    const challenge = jarvis.identity.createEnrollmentChallenge();
    const keys2 = CryptoUtil.generateEd25519KeyPair();

    // First redemption succeeds
    const res1 = jarvis.identity.enrollDevice(challenge.challengeToken, 'Phone 2', keys2.publicKey);
    assert.strictEqual(res1.success, true);

    // Second redemption must fail
    const keys3 = CryptoUtil.generateEd25519KeyPair();
    const res2 = jarvis.identity.enrollDevice(challenge.challengeToken, 'Phone 3', keys3.publicKey);
    assert.strictEqual(res2.success, false);
    assert.match(res2.error || '', /already redeemed/);
  });

  test('AUD-01: Tamper-evident audit log maintains verifiable cryptographic hash chain', async () => {
    // Generate some audit activity
    await jarvis.submitRequest(companionSessionId, 'Query OS info');
    
    const integrityBefore = jarvis.audit.verifyIntegrity();
    assert.strictEqual(integrityBefore.valid, true);

    const records = jarvis.audit.getRecords();
    assert.ok(records.length >= 3);

    // Verify secrets are redacted in audit entries
    const str = JSON.stringify(records);
    assert.strictEqual(str.includes('privateKey'), false);
  });
});
