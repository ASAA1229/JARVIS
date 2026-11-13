import test, { afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCoreService, type TaskLifecycleRecord } from '../src/core/service.js';
import { TaskJournal } from '../src/core/taskJournal.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';
import { TaskCoordinator, TaskQueueTimeoutError } from '../src/core/taskCoordinator.js';
import { WorkflowBranchExecutor } from '../src/workflows/workflowExecution.js';
import type { WorkflowStep } from '../src/workflows/workflowStore.js';

/**
 * JARVIS-GAP-001/002/003: branch approval race/expiry/replay/revocation, restart
 * recovery (in-flight branches become uncertain and are never replayed), explicit
 * owner-reconciled DAG resume, and resource-lock leak checks. No test approves a
 * real application launch: approvals are only rejected, expired, revoked or lost.
 */
const OWNER_TOKEN = 'owner-control-token-for-dag-recovery-tests-0123456789';
const realNow = Date.now.bind(Date);
let skewMs = 0;
let directory: string;
const services: JarvisCoreService[] = [];

beforeEach(() => {
  skewMs = 0;
  directory = mkdtempSync(join(tmpdir(), 'jarvis-dag-recovery-'));
});
afterEach(() => {
  mock.restoreAll();
  for (const service of services.splice(0)) service.stopBackgroundServices();
  rmSync(directory, { recursive: true, force: true });
});

function makeService(): JarvisCoreService {
  const service = new JarvisCoreService(new LocalHeuristicPlanner(), join(directory, 'audit.log'), join(directory, 'state'), OWNER_TOKEN);
  services.push(service);
  return service;
}
function enroll(service: JarvisCoreService, name: string, permissions: Permission[]) {
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, name, keys.publicKey);
  assert.equal(enrolled.success, true);
  return { deviceId: enrolled.deviceId!, keys };
}
function login(service: JarvisCoreService, device: { deviceId: string; keys: { privateKey: string } }): string {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, device.keys.privateKey);
  const session = service.identity.createSession(device.deviceId, signature, timestamp, nonce);
  assert.equal(session.success, true);
  return session.sessionId!;
}
const OWNER_PERMS = [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE, Permission.APP_LAUNCH];

async function startGatedWorkflow(service: JarvisCoreService, sessionId: string) {
  const result = await service.submitOperations(sessionId, 'Open the development workspace', [
    { operation: 'workflow:run', parameters: { name: 'open-dev-workspace' } },
  ]);
  const parent = service.getTask(result.taskId)!;
  const explorer = service.listTasks().find((task) => task.workflowParentTaskId === parent.id && task.workflowStepId === 'explorer')!;
  assert.ok(explorer.approvalId, 'the first branch must await its own approval');
  return { parent, explorer };
}
const branch = (service: JarvisCoreService, parentId: string, stepId: string) =>
  service.getTask(parentId as never)?.workflowRun?.branches.find((item) => item.stepId === stepId);

test('GAP-002 expired branch approval fails the branch, blocks descendants and starts nothing', async () => {
  mock.method(Date, 'now', () => realNow() + skewMs);
  const service = makeService();
  const owner = enroll(service, 'owner', OWNER_PERMS);
  const sessionId = login(service, owner);
  const { parent, explorer } = await startGatedWorkflow(service, sessionId);
  skewMs = 24 * 60 * 60 * 1000;
  const refreshed = login(service, owner);
  const outcome = await service.approveTask(explorer.approvalId!, refreshed);
  assert.equal(outcome.success, false);
  assert.equal(service.getTask(explorer.id)?.state, TaskState.EXPIRED);
  assert.equal(branch(service, parent.id, 'explorer')?.status, 'failed');
  assert.equal(branch(service, parent.id, 'editor')?.status, 'blocked');
  assert.equal(branch(service, parent.id, 'repos')?.status, 'blocked');
  assert.ok(service.audit.getRecords().some((entry) => entry.eventType === 'APPROVAL_FAILED_EXPIRED'));
  // Replaying the expired approval id must not execute anything either.
  await assert.rejects(service.approveTask(explorer.approvalId!, refreshed), /no longer awaiting approval/);
});

test('GAP-002 a rejected branch approval cannot be replayed or approved afterwards', async () => {
  const service = makeService();
  const owner = enroll(service, 'owner', OWNER_PERMS);
  const sessionId = login(service, owner);
  const { parent, explorer } = await startGatedWorkflow(service, sessionId);
  assert.equal((await service.rejectTask(explorer.approvalId!, sessionId)).success, true);
  assert.equal(branch(service, parent.id, 'explorer')?.status, 'failed');
  await assert.rejects(service.approveTask(explorer.approvalId!, sessionId));
  const second = await service.rejectTask(explorer.approvalId!, sessionId).catch(() => ({ success: false }));
  assert.equal(second.success, false);
  assert.notEqual(service.getTask(explorer.id)?.state, TaskState.COMPLETED);
  assert.equal(branch(service, parent.id, 'editor')?.status, 'blocked');
});

test('GAP-002 concurrent rejections of one branch approval resolve exactly once', async () => {
  const service = makeService();
  const owner = enroll(service, 'owner', OWNER_PERMS);
  const sessionId = login(service, owner);
  const { explorer } = await startGatedWorkflow(service, sessionId);
  const settled = await Promise.allSettled([
    service.rejectTask(explorer.approvalId!, sessionId),
    service.rejectTask(explorer.approvalId!, sessionId),
    service.rejectTask(explorer.approvalId!, sessionId),
  ]);
  const wins = settled.filter((item) => item.status === 'fulfilled' && item.value.success);
  assert.equal(wins.length, 1, 'only one racing resolution may win');
  assert.equal(service.audit.getRecords().filter((entry) => entry.eventType === 'WORKFLOW_BRANCH_APPROVAL_RESOLVED').length, 1);
});

test('GAP-002 approvals require an authenticated approver with permission; revoked approvers are refused', async () => {
  const service = makeService();
  const owner = enroll(service, 'owner', OWNER_PERMS);
  const limited = enroll(service, 'limited viewer', [Permission.SYSTEM_INFO_READ]);
  const ownerSession = login(service, owner);
  const limitedSession = login(service, limited);
  const { parent, explorer } = await startGatedWorkflow(service, ownerSession);

  await assert.rejects(service.approveTask(explorer.approvalId!, limitedSession));
  await assert.rejects(service.approveTask(explorer.approvalId!, 'forged-session-id'), /not authenticated/);
  assert.equal(service.getTask(explorer.id)?.state, TaskState.AWAITING_APPROVAL);

  // Revoke the owner: its existing session must no longer approve or reject.
  assert.equal(service.identity.revokeDevice(owner.deviceId, 'test revocation'), true);
  await assert.rejects(service.approveTask(explorer.approvalId!, ownerSession), /not authenticated/);
  await assert.rejects(service.rejectTask(explorer.approvalId!, ownerSession));
  assert.equal(service.getTask(explorer.id)?.state, TaskState.AWAITING_APPROVAL);
  assert.equal(branch(service, parent.id, 'explorer')?.status, 'awaiting_approval');
});

test('GAP-003 restart invalidates a pending branch approval and never dispatches the branch', async () => {
  const first = makeService();
  const owner = enroll(first, 'owner', OWNER_PERMS);
  const { parent, explorer } = await startGatedWorkflow(first, login(first, owner));
  const staleApproval = explorer.approvalId!;
  first.stopBackgroundServices();

  const second = makeService();
  const restored = second.getTask(parent.id)!;
  assert.equal(restored.state, TaskState.AWAITING_RECOVERY);
  assert.equal(second.getTask(explorer.id)?.state, TaskState.AWAITING_RECOVERY);
  assert.equal(restored.workflowRun?.branches.find((item) => item.stepId === 'explorer')?.status, 'cancelled');
  await assert.rejects(second.approveTask(staleApproval, login(second, owner)));
  assert.notEqual(second.getTask(explorer.id)?.state, TaskState.COMPLETED);
  assert.equal(second.audit.getRecords().filter((entry) => entry.eventType === 'WORKFLOW_BRANCH_TASK_CREATED').length, 1,
    'restart must not create or run replacement branch tasks');
});

/** Builds a durable journal whose DAG was killed mid-flight, then restarts on it. */
async function killedMidFlight() {
  const first = makeService();
  const owner = enroll(first, 'owner', OWNER_PERMS);
  const sessionId = login(first, owner);
  const run = await first.submitOperations(sessionId, 'Run independent morning brief branches', [
    { operation: 'workflow:run', parameters: { name: 'morning-brief' } },
  ]);
  const parentId = run.taskId;
  assert.equal(first.getTask(parentId)?.state, TaskState.COMPLETED);
  const records = first.listTasks() as TaskLifecycleRecord[];
  first.stopBackgroundServices();

  // Simulate SIGKILL: the 'memory' branch was dispatched but never finished, 'disk' not yet started.
  const journal = new TaskJournal(join(directory, 'state.tasks'), OWNER_TOKEN);
  const parent = structuredClone(records.find((item) => item.id === parentId)!);
  parent.state = TaskState.EXECUTING;
  const memory = parent.workflowRun!.branches.find((item) => item.stepId === 'memory')!;
  memory.status = 'running'; memory.outcome = undefined; memory.message = undefined;
  const disk = parent.workflowRun!.branches.find((item) => item.stepId === 'disk')!;
  disk.status = 'pending'; disk.outcome = undefined; disk.message = undefined; disk.startedAt = undefined; disk.attempts = 0;
  parent.workflowRun!.status = 'running';
  journal.save(parent);
  const memoryChild = structuredClone(records.find((item) => item.id === `${parentId}:memory`)!);
  memoryChild.state = TaskState.EXECUTING;
  journal.save(memoryChild);

  const second = makeService();
  return { second, owner, parentId };
}

test('GAP-003 process kill marks in-flight branches uncertain and does not replay anything on restart', async () => {
  const { second, parentId } = await killedMidFlight();
  const parent = second.getTask(parentId as never)!;
  assert.equal(parent.state, TaskState.AWAITING_RECOVERY);
  assert.equal(parent.workflowRun?.status, 'uncertain');
  const memory = parent.workflowRun!.branches.find((item) => item.stepId === 'memory')!;
  assert.equal(memory.status, 'uncertain');
  assert.equal(memory.outcome, 'uncertain');
  assert.equal(second.getTask(`${parentId}:memory` as never)?.state, TaskState.AWAITING_RECOVERY);
  assert.equal(second.audit.getRecords().filter((entry) => entry.eventType === 'WORKFLOW_DAG_STARTED').length, 1,
    'restart alone must not start any DAG execution');
});

test('GAP-003 explicit owner-reconciled resume re-attempts only the named uncertain branch', async () => {
  const { second, owner, parentId } = await killedMidFlight();
  const sessionId = login(second, owner);
  const outsider = enroll(second, 'outsider', [Permission.SYSTEM_INFO_READ]);
  const outsiderSession = login(second, outsider);

  await assert.rejects(second.resumeWorkflowRun(parentId as never, 'forged', ['memory'], 'owner reviewed no effect'), /not authenticated/);
  await assert.rejects(second.resumeWorkflowRun(parentId as never, outsiderSession, ['memory'], 'owner reviewed no effect'), /Only the requesting device or an owner/);
  await assert.rejects(second.resumeWorkflowRun(parentId as never, sessionId, ['battery'], 'owner reviewed no effect'), /not awaiting uncertain-outcome/);
  await assert.rejects(second.resumeWorkflowRun(parentId as never, sessionId, ['memory'], 'short'), /Recovery note/);
  const noop = await second.resumeWorkflowRun(parentId as never, sessionId, [], 'owner reviewed nothing');
  assert.equal(noop.success, false);
  assert.equal(second.getTask(parentId as never)?.workflowRun?.branches.find((item) => item.stepId === 'memory')?.status, 'uncertain');

  const resumed = await second.resumeWorkflowRun(parentId as never, sessionId, ['memory'], 'Owner confirmed memory query had no side effect');
  assert.equal(resumed.success, true);
  const parent = second.getTask(parentId as never)!;
  const byId = Object.fromEntries(parent.workflowRun!.branches.map((item) => [item.stepId, item]));
  assert.equal(byId.memory.status, 'completed');
  assert.equal(byId.memory.attempts, 2, 'the reconciled branch gets exactly one new attempt');
  assert.equal(byId.battery.attempts, 1, 'already-verified branches are not re-run');
  assert.equal(parent.state, TaskState.COMPLETED);
  assert.ok(second.audit.getRecords().some((entry) => entry.eventType === 'WORKFLOW_RESUME_AUTHORIZED'));
  await assert.rejects(second.resumeWorkflowRun(parentId as never, sessionId, ['memory'], 'Owner confirmed memory query had no side effect'), /not awaiting recovery/);
});

// ---- Lock leaks (GAP-001 criterion 7) ----
const step = (id: string, dependsOn: string[] = []): WorkflowStep => ({ id, operation: 'system:get_memory_info', parameters: {}, dependsOn });
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('GAP-001 a branch that throws releases its resource lock so the next branch can run', async () => {
  const order: string[] = [];
  const result = await new WorkflowBranchExecutor().run([step('a'), step('b')], {
    runId: 'lock-throw', maxParallel: 2, resourcesForStep: () => ['shared'],
    checkpoint: async () => undefined,
    executeStep: async (item) => { order.push(item.id); if (item.id === 'a') throw new Error('adapter crashed'); return { status: 'completed' }; },
  });
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(result.branches.find((item) => item.stepId === 'a')?.status, 'uncertain');
  assert.equal(result.branches.find((item) => item.stepId === 'b')?.status, 'completed');
});

test('GAP-001 cancellation mid-run releases locks and never starts queued branches', async () => {
  const controller = new AbortController();
  const started: string[] = [];
  const result = await new WorkflowBranchExecutor().run([step('a'), step('b')], {
    runId: 'lock-cancel', maxParallel: 2, signal: controller.signal, resourcesForStep: () => ['shared'],
    checkpoint: async () => undefined,
    executeStep: async (item) => { started.push(item.id); controller.abort(); await delay(5); return { status: 'completed' }; },
  });
  assert.deepEqual(started, ['a']);
  assert.equal(result.branches.find((item) => item.stepId === 'a')?.status, 'uncertain');
  assert.equal(result.branches.find((item) => item.stepId === 'b')?.status, 'cancelled');
});

test('GAP-001 coordinator releases resource locks after queue timeout, abort and work failure', async () => {
  const coordinator = new TaskCoordinator(2, 2, 10, 30);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const holder = coordinator.run({ taskId: 'holder', deviceId: 'd', resources: ['desktop:x'] }, async () => held);
  const timedOut = coordinator.run({ taskId: 'timeout', deviceId: 'd', resources: ['desktop:x'], queueTimeoutMs: 10 }, async () => undefined);
  await assert.rejects(timedOut, TaskQueueTimeoutError);
  const controller = new AbortController();
  const aborted = coordinator.run({ taskId: 'abort', deviceId: 'd', resources: ['desktop:x'], signal: controller.signal }, async () => undefined);
  controller.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
  release();
  await holder;
  await assert.rejects(coordinator.run({ taskId: 'boom', deviceId: 'd', resources: ['desktop:x'] }, async () => { throw new Error('boom'); }), /boom/);
  assert.equal(coordinator.snapshot().lockedResourceCount, 0);
  assert.equal(coordinator.snapshot().active, 0);
  assert.equal(await coordinator.run({ taskId: 'after', deviceId: 'd', resources: ['desktop:x'] }, async () => 'ok'), 'ok');
});
