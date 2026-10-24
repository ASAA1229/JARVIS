import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { JarvisCoreService } from '../src/core/service.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, RiskTier, TaskState } from '../src/core/types.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

const auditPath = './data/test_rejection_permissions.log';

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
  assert.throws(
    () => jarvis.rejectTask(pending.approvalId!, readOnlyApprover.sessionId),
    /lacks permission for this action/i,
  );
  assert.equal(jarvis.policy.getApproval(pending.approvalId!)?.rejected, undefined);
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

  assert.throws(
    () => jarvis.rejectTask(approval.id, readOnlyApprover.sessionId),
    /lacks DEVICE_MANAGE permission for personal memory/i,
  );
  assert.equal(jarvis.policy.getApproval(approval.id)?.rejected, undefined);
});
