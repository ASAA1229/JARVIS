import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { JarvisCoreService } from '../src/core/service.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, RiskTier, TaskState } from '../src/core/types.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

const auditPath = `./data/test_rejection_permissions_${process.pid}.log`;

function enrollSession(
  jarvis: JarvisCoreService,
  name: string,
  permissions: Permission[],
) {
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = jarvis.identity.createEnrollmentChallenge(permissions);
  const enrolled = jarvis.identity.enrollDevice(challenge.challengeToken, name, keys.publicKey);
  assert.equal(enrolled.success, true);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey);
  const session = jarvis.identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
  assert.equal(session.success, true);
  return { deviceId: enrolled.deviceId!, sessionId: session.sessionId! };
}

afterEach(() => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
});

test('rejecting a desktop approval requires APP_LAUNCH permission', async () => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
  const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), auditPath);
  const requester = enrollSession(jarvis, 'requester', [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH]);
  const readOnlyApprover = enrollSession(jarvis, 'read-only-approver', [Permission.SYSTEM_INFO_READ]);

  const pending = await jarvis.submitRequest(requester.sessionId, 'Please launch Notepad');
  assert.equal(pending.state, TaskState.AWAITING_APPROVAL);
  await assert.rejects(
    () => jarvis.rejectTask(pending.approvalId!, readOnlyApprover.sessionId),
    /lacks permission for this action/i,
  );
  assert.equal(jarvis.policy.getApproval(pending.approvalId!)?.rejected, undefined);
});

test('a stale approval cannot reject a task already awaiting recovery', async () => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
  const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), auditPath);
  const requester = enrollSession(jarvis, 'requester-stale-reject', [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH]);
  const approver = enrollSession(jarvis, 'approver-stale-reject', [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH]);

  const pending = await jarvis.submitRequest(requester.sessionId, 'Please launch Notepad');
  assert.equal(pending.state, TaskState.AWAITING_APPROVAL);
  const approvalId = pending.approvalId!;
  const task = jarvis.getTask(pending.taskId);
  assert.ok(task);

  // Simulate an interruption/recovery transition after the approval was issued.
  task.state = TaskState.AWAITING_RECOVERY;
  await assert.rejects(
    () => jarvis.rejectTask(approvalId, approver.sessionId),
    /task is no longer awaiting approval/i,
  );

  const approval = jarvis.policy.getApproval(approvalId);
  assert.equal(approval?.approved, false);
  assert.equal(approval?.rejected, undefined);
  assert.ok(approval, 'approval record must remain available');
  assert.notEqual(approval.consumed, true);
  assert.equal(jarvis.getTask(pending.taskId)?.state, TaskState.AWAITING_RECOVERY);
  assert.equal(jarvis.audit.getRecords().filter((event) => event.eventType === 'REJECTION_FAILED_TASK_NOT_PENDING').length, 1);
});

test('rejecting a personal-memory approval requires DEVICE_MANAGE permission', async () => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
  const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), auditPath);
  const readOnlyApprover = enrollSession(jarvis, 'read-only-approver', [Permission.SYSTEM_INFO_READ]);
  const approval = jarvis.policy.createApprovalRequest(
    'task-memory-test',
    'device-owner',
    'memory:delete',
    { id: 'memory-id' },
    RiskTier.HIGH,
  );

  await assert.rejects(
    () => jarvis.rejectTask(approval.id, readOnlyApprover.sessionId),
    /lacks DEVICE_MANAGE permission for personal memory/i,
  );
  assert.equal(jarvis.policy.getApproval(approval.id)?.rejected, undefined);
});
