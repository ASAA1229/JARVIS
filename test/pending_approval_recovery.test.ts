import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';
import { lifecycleFromTaskState } from '../src/core/commandLifecycle.js';

const TOKEN = 'owner-control-token-for-approval-recovery-0123456789';
let directory: string;
const services: JarvisCoreService[] = [];
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'jarvis-approval-recovery-')); });
afterEach(() => { for (const s of services.splice(0)) s.stopBackgroundServices(); rmSync(directory, { recursive: true, force: true }); });

function make(): JarvisCoreService {
  const s = new JarvisCoreService(new LocalHeuristicPlanner(), join(directory, 'audit.log'), join(directory, 'state'), TOKEN);
  services.push(s);
  return s;
}
function enroll(s: JarvisCoreService) {
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = s.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE, Permission.APP_LAUNCH]);
  const enrolled = s.identity.enrollDevice(challenge.challengeToken, 'owner', keys.publicKey);
  assert.equal(enrolled.success, true);
  return { deviceId: enrolled.deviceId!, keys };
}
function login(s: JarvisCoreService, d: { deviceId: string; keys: { privateKey: string } }): string {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, d.keys.privateKey);
  return s.identity.createSession(d.deviceId, signature, timestamp, nonce).sessionId!;
}

async function pending(s: JarvisCoreService, session: string) {
  const result = await s.submitOperations(session, 'Write a note', [{ operation: 'memory:save', parameters: { category: 'preference', content: 'recovery test' } }]);
  assert.equal(result.state, TaskState.AWAITING_APPROVAL);
  return result;
}

test('a pending approval survives restart undecided and is never auto-approved', async () => {
  const first = make();
  const owner = enroll(first);
  const result = await pending(first, login(first, owner));
  first.stopBackgroundServices();

  const second = make();
  const task = second.getTask(result.taskId)!;
  assert.equal(task.state, TaskState.AWAITING_APPROVAL);
  const approval = second.policy.getApproval(result.approvalId!)!;
  assert.equal(approval.approved, false);
  assert.equal(approval.rejected ?? false, false);
  assert.equal(second.lifecycleOf(task), 'queued');
});

test('an expired pending approval is not recovered and its task expires safely', async () => {
  const first = make();
  const owner = enroll(first);
  const result = await pending(first, login(first, owner));
  first.stopBackgroundServices();

  const real = Date.now;
  Date.now = () => real() + 10 * 60_000;
  try {
    const second = make();
    const task = second.getTask(result.taskId)!;
    assert.notEqual(task.state, TaskState.AWAITING_APPROVAL);
    assert.equal(second.policy.getApproval(result.approvalId!), undefined);
  } finally { Date.now = real; }
});

test('lifecycle vocabulary maps every task state to one of six states', () => {
  assert.equal(lifecycleFromTaskState(TaskState.EXECUTING), 'running');
  assert.equal(lifecycleFromTaskState(TaskState.EXPIRED), 'timed_out');
  assert.equal(lifecycleFromTaskState(TaskState.INTERRUPTED), 'failed');
  assert.equal(lifecycleFromTaskState(TaskState.CANCELLED), 'cancelled');
});
