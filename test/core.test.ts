import { test, describe, beforeEach, afterEach } from 'node:test';
import { acquireDesktopLock } from './helpers/desktopLock.js';
import { desktopSkip } from './helpers/desktopSession.js';
import assert from 'node:assert';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { TaskState, Permission, VerificationOutcome } from '../src/core/types.js';
import { rmSync, existsSync } from 'node:fs';

const TEST_AUDIT_LOG = `./data/test_audit_${process.pid}.log`;

describe('JARVIS Core Security & Lifecycle Verification', { concurrency: false }, () => {
  let jarvis: JarvisCoreService;
  let companionKeypair: { publicKey: string; privateKey: string };
  let companionDeviceId: string;
  let companionSessionId: string;

  let releaseDesktop: (() => void) | undefined;

  beforeEach(async () => {
    releaseDesktop = await acquireDesktopLock();
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
    releaseDesktop?.();
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

  test('SEC-06: Expired sessions are rejected before request processing', async () => {
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const signature = CryptoUtil.signData(
      `SESSION_REQUEST:${timestamp}:${nonce}`,
      companionKeypair.privateKey,
    );
    const expiredSession = jarvis.identity.createSession(
      companionDeviceId,
      signature,
      timestamp,
      nonce,
      1,
    );
    assert.strictEqual(expiredSession.success, true);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    await assert.rejects(
      () => jarvis.submitRequest(expiredSession.sessionId!, 'What is the OS version?'),
      /Authentication failed: Session expired/,
    );
  });

  test('FLOW-01: End-to-end happy path for allowlisted read-only system information', async () => {
    const res = await jarvis.submitRequest(companionSessionId, 'What is the OS version?');
    assert.strictEqual(res.state, TaskState.COMPLETED);
    assert.strictEqual(res.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.strictEqual(res.verified, true);
    assert.ok(res.data);
    const osData = res.data as { platform: string; arch: string };
    assert.ok(osData.platform);
    assert.ok(osData.arch);
  });

  test('FLOW-PLANNER-FAIL: Planner exception returns a truthful failed result without executing an adapter', async () => {
    let adapterCalls = 0;
    jarvis.planner.generatePlan = async () => { throw new Error('private diagnostic detail'); };
    jarvis.systemAdapter.getOsInfo = async () => {
      adapterCalls++;
      throw new Error('must not execute');
    };

    const result = await jarvis.submitRequest(companionSessionId, 'What is the OS version?');
    assert.strictEqual(result.state, TaskState.FAILED);
    assert.strictEqual(result.outcome, VerificationOutcome.VERIFIED_FAILURE);
    assert.strictEqual(result.verified, false);
    assert.match(result.message, /planner failed/i);
    assert.doesNotMatch(result.message, /private diagnostic detail/);
    assert.strictEqual(adapterCalls, 0);
    assert.ok(jarvis.audit.getPublicRecords().some((record) => record.eventType === 'PLANNING_FAILED'));
    assert.ok(!JSON.stringify(jarvis.audit.getPublicRecords()).includes('private diagnostic detail'));
  });

  test('FLOW-SYSTEM-FACTS: Memory, battery, and disk prompts select their matching read-only adapters', async () => {
    const memory = await jarvis.submitRequest(companionSessionId, 'Check system memory and RAM');
    assert.strictEqual(memory.state, TaskState.COMPLETED);
    assert.strictEqual(memory.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.ok((memory.data as { totalBytes?: number })?.totalBytes);

    const battery = await jarvis.submitRequest(companionSessionId, 'What is the battery status?');
    assert.ok([TaskState.COMPLETED, TaskState.PARTIAL].includes(battery.state));
    assert.ok(battery.data);

    const disk = await jarvis.submitRequest(companionSessionId, 'Check C: drive disk space');
    assert.strictEqual(disk.state, TaskState.COMPLETED);
    assert.strictEqual(disk.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.ok((disk.data as { totalBytes?: number })?.totalBytes);
  });

  test('FLOW-WORKFLOW: multiple planned operations execute sequentially with independent policy evaluation', async () => {
    jarvis.planner.generatePlan = async () => ({
      intent: 'Read OS details then memory status',
      operations: [
        { operation: 'system:get_os_info', parameters: {}, justification: 'Read OS information' },
        { operation: 'system:get_memory_info', parameters: {}, justification: 'Read memory information' },
      ],
      confidence: 0.95,
      explanation: 'Two-step read-only workflow',
    });
    const result = await jarvis.submitRequest(companionSessionId, 'check system and memory');
    assert.strictEqual(result.state, TaskState.COMPLETED, result.message);
    assert.strictEqual(result.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    assert.ok(result.data);
    assert.ok(jarvis.audit.getPublicRecords().some((record) => record.eventType === 'WORKFLOW_STEP_VERIFIED'));
  });

  test('FLOW-UNSUPPORTED: Unsupported and destructive requests explain denial without running adapters', async () => {
    const unsupported = await jarvis.submitRequest(companionSessionId, 'Tell me a joke');
    assert.strictEqual(unsupported.state, TaskState.FAILED);
    assert.match(unsupported.message, /Could not map request/i);

    const destructive = await jarvis.submitRequest(companionSessionId, 'Delete system files');
    assert.strictEqual(destructive.state, TaskState.FAILED);
    assert.match(destructive.message, /prohibited/i);
  });

  test('FLOW-02a: Policy Gateway requires approval for state-changing app launch (no desktop needed)', async () => {
    const pending = await jarvis.submitRequest(companionSessionId, 'Please launch Notepad');
    assert.strictEqual(pending.state, TaskState.AWAITING_APPROVAL);
    assert.ok(pending.approvalId);
    const record = jarvis.policy.getApproval(pending.approvalId!);
    assert.ok(record);
    assert.strictEqual(record.approved, false);
  });

  test('FLOW-02: approved app launch executes against a real desktop', { skip: desktopSkip() }, async () => {
    const res = await jarvis.submitRequest(companionSessionId, 'Please launch Notepad');
    assert.strictEqual(res.state, TaskState.AWAITING_APPROVAL);
    assert.ok(res.approvalId);

    // Verify approval record
    const approval = jarvis.policy.getApproval(res.approvalId!);
    assert.ok(approval);
    assert.strictEqual(approval.approved, false);

    // Approve the task
    const approveRes = await jarvis.approveTask(res.approvalId!, companionSessionId);
    assert.strictEqual(approveRes.success, approveRes.state === TaskState.COMPLETED);
    assert.ok([TaskState.COMPLETED, TaskState.PARTIAL].includes(approveRes.state));
    if (approveRes.state === TaskState.PARTIAL) {
      assert.strictEqual(approveRes.outcome, VerificationOutcome.PARTIAL_SUCCESS);
      assert.strictEqual(approveRes.verified, false);
    } else {
      assert.strictEqual(approveRes.outcome, VerificationOutcome.VERIFIED_SUCCESS);
      assert.strictEqual(approveRes.verified, true);
    }
    assert.ok(approveRes.data);
  });

  test('FLOW-03: Partial adapter evidence is not represented as completed or verified', async () => {
    jarvis.systemAdapter.getOsInfo = async () => ({
      success: true,
      outcome: VerificationOutcome.PARTIAL_SUCCESS,
      data: { platform: 'win32' },
      evidence: { verified: false },
    });

    const result = await jarvis.submitRequest(companionSessionId, 'What is the OS version?');
    assert.strictEqual(result.state, TaskState.PARTIAL);
    assert.strictEqual(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
    assert.strictEqual(result.verified, false);
  });

  test('FLOW-04: Interrupting in-flight app execution reports an uncertain interrupted outcome', async () => {
    let startedExecution!: () => void;
    const executionStarted = new Promise<void>((resolve) => { startedExecution = resolve; });
    jarvis.appAdapter.launchApp = async (_appId, signal) => {
      startedExecution();
      return new Promise((resolve) => {
        signal?.addEventListener('abort', () => resolve({
          success: false,
          outcome: VerificationOutcome.UNCERTAIN,
          interrupted: true,
          error: 'Interrupted in test',
          evidence: { interrupted: true },
        }), { once: true });
      });
    };

    const pending = await jarvis.submitRequest(companionSessionId, 'Please launch Notepad');
    const approval = jarvis.approveTask(pending.approvalId!, companionSessionId);
    const taskId = pending.taskId;
    await executionStarted;
    assert.strictEqual(jarvis.interruptTask(taskId), true);

    const result = await approval;
    assert.strictEqual(result.state, TaskState.INTERRUPTED);
    assert.strictEqual(result.outcome, VerificationOutcome.UNCERTAIN);
    assert.strictEqual(result.verified, false);
    assert.strictEqual(result.success, false);
  });

  test('FLOW-05: An unpersisted completion audit is reported as awaiting recovery', async () => {
    const recordAuditEvent = jarvis.audit.record.bind(jarvis.audit);
    jarvis.audit.record = (eventType, details, deviceId, taskId) => {
      if (eventType === 'EXECUTION_COMPLETED') throw new Error('Simulated audit persistence failure');
      return recordAuditEvent(eventType, details, deviceId, taskId);
    };

    const result = await jarvis.submitRequest(companionSessionId, 'What is the OS version?');
    assert.strictEqual(result.state, TaskState.AWAITING_RECOVERY);
    assert.strictEqual(result.outcome, VerificationOutcome.UNCERTAIN);
    assert.strictEqual(result.verified, false);
    assert.match(result.message, /could not be durably audited/i);
  });

  test('SEC-05: Execution dispatcher is not exposed as a policy bypass', async () => {
    const pending = await jarvis.submitRequest(companionSessionId, 'Please launch Notepad');
    assert.strictEqual(pending.state, TaskState.AWAITING_APPROVAL);

    let launchCount = 0;
    jarvis.appAdapter.launchApp = async () => {
      launchCount++;
      return {
        success: true,
        outcome: VerificationOutcome.VERIFIED_SUCCESS,
        evidence: { test: true },
      };
    };

    assert.strictEqual(Reflect.get(jarvis, 'executeTask'), undefined);
    assert.strictEqual(launchCount, 0);
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
    assert.strictEqual(str.includes('Query OS info'), false);
  });
});

test('VOICE-INTENT: spoken "open note pad" resolves to the allowlisted Notepad action', async () => {
  const planner = new LocalHeuristicPlanner();
  const plan = await planner.generatePlan('open note pad', { requesterName: 'voice-test', timestamp: Date.now() });
  assert.strictEqual(plan.operations.length, 1);
  assert.strictEqual(plan.operations[0].operation, 'app:launch');
  assert.strictEqual(plan.operations[0].parameters.appId, 'notepad');
});

test('PLANNER-APP-INTENT: application names without an explicit launch verb do not launch apps', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'intent-test', timestamp: Date.now() };

  for (const request of [
    'What is Notepad?',
    'Is Calculator installed?',
    'Tell me about Paint',
    'Close Notepad',
  ]) {
    const plan = await planner.generatePlan(request, context);
    assert.equal(
      plan.operations.some((operation) => operation.operation === 'app:launch'),
      false,
      request,
    );
  }
});

test('PLANNER-APP-INTENT: explicit launch verbs still map common apps to the allowlist', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'intent-test', timestamp: Date.now() };

  for (const [request, appId] of [
    ['Hey Jarvis, open Notepad', 'notepad'],
    ['Please launch Calculator', 'calc'],
    ['Start Paint', 'mspaint'],
  ]) {
    const plan = await planner.generatePlan(request, context);
    assert.equal(plan.operations[0]?.operation, 'app:launch', request);
    assert.equal(plan.operations[0]?.parameters.appId, appId, request);
  }
});
