import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner, IAIPlannerProvider, MinimizedContext, PlanProposal } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { TaskState, Permission, RiskTier } from '../src/core/types.js';
import { JarvisServer } from '../src/server/server.js';
import { rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const TEST_AUDIT_LOG = './data/test_audit_hardening.log';

describe('JARVIS Milestone 5: Security Hardening, Multi-Device & Negative Verification', () => {
  let jarvis: JarvisCoreService;
  let phoneAKeypair: { publicKey: string; privateKey: string };
  let phoneBKeypair: { publicKey: string; privateKey: string };
  let phoneADeviceId: string;
  let phoneBDeviceId: string;
  let phoneASessionId: string;
  let phoneBSessionId: string;

  beforeEach(() => {
    if (existsSync(TEST_AUDIT_LOG)) {
      rmSync(TEST_AUDIT_LOG, { force: true });
    }
    jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), TEST_AUDIT_LOG);

    // Enroll Android Phone A (Pixel 8)
    phoneAKeypair = CryptoUtil.generateEd25519KeyPair();
    const challengeA = jarvis.identity.createEnrollmentChallenge([
      Permission.SYSTEM_INFO_READ,
      Permission.APP_LAUNCH,
    ]);
    const enrollA = jarvis.identity.enrollDevice(challengeA.challengeToken, 'Android Phone A (Pixel 8)', phoneAKeypair.publicKey);
    assert.strictEqual(enrollA.success, true);
    phoneADeviceId = enrollA.deviceId!;

    const tsA = Date.now();
    const sigA = CryptoUtil.signData(`SESSION_REQUEST:${tsA}`, phoneAKeypair.privateKey);
    const sessA = jarvis.identity.createSession(phoneADeviceId, sigA, tsA);
    assert.strictEqual(sessA.success, true);
    phoneASessionId = sessA.sessionId!;

    // Enroll Android Phone B (Galaxy S24)
    phoneBKeypair = CryptoUtil.generateEd25519KeyPair();
    const challengeB = jarvis.identity.createEnrollmentChallenge([
      Permission.SYSTEM_INFO_READ,
      Permission.APP_LAUNCH,
    ]);
    const enrollB = jarvis.identity.enrollDevice(challengeB.challengeToken, 'Android Phone B (Galaxy S24)', phoneBKeypair.publicKey);
    assert.strictEqual(enrollB.success, true);
    phoneBDeviceId = enrollB.deviceId!;

    const tsB = Date.now();
    const sigB = CryptoUtil.signData(`SESSION_REQUEST:${tsB}`, phoneBKeypair.privateKey);
    const sessB = jarvis.identity.createSession(phoneBDeviceId, sigB, tsB);
    assert.strictEqual(sessB.success, true);
    phoneBSessionId = sessB.sessionId!;
  });

  afterEach(() => {
    if (existsSync(TEST_AUDIT_LOG)) {
      rmSync(TEST_AUDIT_LOG, { force: true });
    }
  });

  test('SEC-HARD-01: Malformed and invalid public keys are rejected during enrollment', () => {
    const challenge = jarvis.identity.createEnrollmentChallenge();

    // Invalid non-key string
    const res1 = jarvis.identity.enrollDevice(challenge.challengeToken, 'Attacker Device', 'NOT_A_VALID_KEY');
    assert.strictEqual(res1.success, false);
    assert.match(res1.error || '', /Invalid or malformed public key/);

    // Malformed PEM header
    const res2 = jarvis.identity.enrollDevice(challenge.challengeToken, 'Attacker Device', '-----BEGIN PUBLIC KEY-----\ncorrupt==\n-----END PUBLIC KEY-----');
    assert.strictEqual(res2.success, false);
    assert.match(res2.error || '', /Invalid or malformed public key/);
  });

  test('SEC-HARD-02: Single-use approval consumption prevents approval reuse/replay attack', async () => {
    const res = await jarvis.submitRequest(phoneASessionId, 'Launch Notepad');
    assert.strictEqual(res.state, TaskState.AWAITING_APPROVAL);
    const approvalId = res.approvalId!;

    // Phone A approves the task -> succeeds
    const approveRes = await jarvis.approveTask(approvalId, phoneADeviceId);
    assert.strictEqual(approveRes.success, true);

    // Attacker or duplicate message tries to reuse the same approval ID
    const task = jarvis.getTask(res.taskId)!;
    const opReq = { operation: 'app:launch', parameters: task.parameters || {} };
    const reEval = jarvis.policy.evaluate(opReq, jarvis.identity.getDevice(phoneADeviceId)!, task.id, approvalId);
    
    assert.strictEqual(reEval.allowed, false);
    assert.match(reEval.reason || '', /already been consumed \(single-use\)/);
  });

  test('SEC-HARD-03: Multi-device independence — revoking Phone A leaves Phone B active', async () => {
    // Both phones submit read-only requests successfully initially
    const resA1 = await jarvis.submitRequest(phoneASessionId, 'Query OS info');
    assert.strictEqual(resA1.state, TaskState.COMPLETED);

    const resB1 = await jarvis.submitRequest(phoneBSessionId, 'Check memory status');
    assert.strictEqual(resB1.state, TaskState.COMPLETED);

    // Revoke Phone A
    jarvis.identity.revokeDevice(phoneADeviceId, 'Phone A lost');

    // Phone A requests must now immediately fail
    await assert.rejects(async () => {
      await jarvis.submitRequest(phoneASessionId, 'Query OS info');
    }, /Authentication failed/);

    // Phone B must remain completely functional and authorized
    const resB2 = await jarvis.submitRequest(phoneBSessionId, 'Check battery status');
    assert.strictEqual(resB2.state, TaskState.COMPLETED);
  });

  test('SEC-HARD-04: Approver verification — unauthorized or revoked phone cannot approve tasks', async () => {
    const res = await jarvis.submitRequest(phoneASessionId, 'Launch Calculator');
    assert.strictEqual(res.state, TaskState.AWAITING_APPROVAL);
    const approvalId = res.approvalId!;

    // 1. Fake/unknown device ID attempting approval
    await assert.rejects(async () => {
      await jarvis.approveTask(approvalId, 'dev-unknown-attacker');
    }, /Approver device not registered or revoked/);

    // 2. Revoked device attempting approval
    jarvis.identity.revokeDevice(phoneBDeviceId, 'Phone B compromised');
    await assert.rejects(async () => {
      await jarvis.approveTask(approvalId, phoneBDeviceId);
    }, /Approver device not registered or revoked/);
  });

  test('SEC-HARD-05: AI Planner schema validator rejects invalid operations and adversarial injections', async () => {
    // Define an adversarial mock planner attempting to inject shell commands into the plan
    class AdversarialPlanner implements IAIPlannerProvider {
      public readonly name = 'adversarial-mock';
      public async generatePlan(_req: string, _ctx: MinimizedContext): Promise<PlanProposal> {
        return {
          intent: 'Escalate privileges',
          operations: [
            {
              operation: 'cmd:exec_arbitrary',
              parameters: { command: 'del /f /s /q *' },
              justification: 'Malicious injection',
            },
          ],
          confidence: 0.99,
          explanation: 'Bypassing policy',
        };
      }
      public validatePlanSchema(plan: unknown) {
        return new LocalHeuristicPlanner().validatePlanSchema(plan);
      }
    }

    const hostileJarvis = new JarvisCoreService(new AdversarialPlanner(), TEST_AUDIT_LOG);
    const challenge = hostileJarvis.identity.createEnrollmentChallenge();
    const kp = CryptoUtil.generateEd25519KeyPair();
    const enroll = hostileJarvis.identity.enrollDevice(challenge.challengeToken, 'Test Device', kp.publicKey);
    const ts = Date.now();
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${ts}`, kp.privateKey);
    const sess = hostileJarvis.identity.createSession(enroll.deviceId!, sig, ts);

    // Request through hostile planner must fail validation before policy evaluation
    const res = await hostileJarvis.submitRequest(sess.sessionId!, 'Do something malicious');
    assert.strictEqual(res.state, TaskState.FAILED);
    assert.match(res.message, /Invalid AI plan proposal: Operation 'cmd:exec_arbitrary' at index 0 is not allowlisted/);
  });

  test('SEC-HARD-06: Tamper detection — detecting file modification and broken hash chain', () => {
    // Generate valid records
    jarvis.audit.record('SECURITY_CHECK_1', { data: 'val1' });
    jarvis.audit.record('SECURITY_CHECK_2', { data: 'val2' });
    jarvis.audit.record('SECURITY_CHECK_3', { data: 'val3' });

    const initialCheck = jarvis.audit.verifyIntegrity();
    assert.strictEqual(initialCheck.valid, true);

    // Tamper with records in memory
    const records = jarvis.audit.getRecords() as unknown as { details: Record<string, unknown> }[];
    records[1].details = { data: 'TAMPERED_CONTENT' };

    const tamperedCheck = jarvis.audit.verifyIntegrity();
    assert.strictEqual(tamperedCheck.valid, false);
    assert.strictEqual(tamperedCheck.corruptedIndex, 1);
    assert.match(tamperedCheck.reason || '', /Hash corruption/);
  });

  test('SEC-HARD-07: HTTP Server enforces session authentication on approval and revocation routes', async () => {
    const server = new JarvisServer(3456, TEST_AUDIT_LOG);
    await server.start();

    try {
      // 1. Unauthenticated request to /api/request (missing header)
      const res1 = await fetch('http://127.0.0.1:3456/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'What is the OS?' }),
      });
      assert.strictEqual(res1.status, 401);

      // 2. Unauthenticated approval (missing header)
      const res2 = await fetch('http://127.0.0.1:3456/api/approval/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approvalId: 'appr-fake' }),
      });
      assert.strictEqual(res2.status, 401);

      // 3. Unauthenticated device revocation (missing header)
      const res3 = await fetch('http://127.0.0.1:3456/api/device/revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceId: 'dev-fake' }),
      });
      assert.strictEqual(res3.status, 401);
    } finally {
      await server.stop();
    }
  });

  test('SEC-HARD-08: Stale and replay session requests are rejected', () => {
    const staleTimestamp = Date.now() - 120000; // 2 minutes in the past (> 60s limit)
    const sig = CryptoUtil.signData(`SESSION_REQUEST:${staleTimestamp}`, phoneAKeypair.privateKey);
    const sessionRes = jarvis.identity.createSession(phoneADeviceId, sig, staleTimestamp);

    assert.strictEqual(sessionRes.success, false);
    assert.match(sessionRes.error || '', /Timestamp is stale/);
  });
});
