import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';

const OWNER_TOKEN = 'owner-control-token-for-live-workflow-dag-tests';

test('live workflow run creates isolated child tasks and checkpoints independent branches', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-live-dag-'));
  const service = new JarvisCoreService(
    new LocalHeuristicPlanner(),
    join(directory, 'audit.log'),
    join(directory, 'state'),
    OWNER_TOKEN,
  );
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge([
      Permission.SYSTEM_INFO_READ,
      Permission.DEVICE_MANAGE,
      Permission.APP_LAUNCH,
    ]);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'DAG test owner', keys.publicKey);
    assert.equal(enrolled.success, true);

    const timestamp = Date.now();
    const nonce = 'e'.repeat(32);
    const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey);
    const session = service.identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
    assert.equal(session.success, true);

    const result = await service.submitOperations(session.sessionId!, 'Run independent morning brief branches', [
      { operation: 'workflow:run', parameters: { name: 'morning-brief' } },
    ]);

    const parent = service.getTask(result.taskId);
    assert.ok(parent);
    assert.ok(parent.workflowRun, 'live workflow should persist its DAG checkpoint');
    assert.equal(parent.workflowRun?.branches.length, 4);
    assert.ok(parent.workflowRun?.branches.every((branch) => branch.startedAt !== undefined),
      'all independent branches should be admitted without waiting on unrelated branches');

    const children = service.listTasks().filter((task) => task.workflowParentTaskId === parent.id);
    assert.equal(children.length, 4);
    assert.equal(new Set(children.map((task) => task.id)).size, 4);
    assert.ok(children.every((task) => task.workflowStepId && task.operations?.length === 1));
    assert.ok(children.every((task) => task.id !== parent.id));

    const branchStates = parent.workflowRun!.branches.map((branch) => branch.status);
    assert.ok(branchStates.every((status) => ['completed', 'failed', 'partial', 'uncertain'].includes(status)));
    assert.ok([TaskState.COMPLETED, TaskState.PARTIAL, TaskState.FAILED, TaskState.AWAITING_RECOVERY].includes(parent.state));
    assert.ok(service.audit.getRecords().some((entry) => entry.eventType === 'WORKFLOW_DAG_STARTED'));
    assert.ok(service.audit.getRecords().some((entry) => entry.eventType === 'WORKFLOW_BRANCH_TASK_CREATED'));

    // A state-changing branch must receive its own child-task approval.
    const gatedResult = await service.submitOperations(session.sessionId!, 'Open the development workspace', [
      { operation: 'workflow:run', parameters: { name: 'open-dev-workspace' } },
    ]);
    const gatedParent = service.getTask(gatedResult.taskId);
    assert.ok(gatedParent?.workflowRun);
    const explorer = service.listTasks().find((task) =>
      task.workflowParentTaskId === gatedParent!.id && task.workflowStepId === 'explorer',
    );
    assert.ok(explorer?.approvalId, 'state-changing branch should own its approval reference');
    assert.notEqual(explorer.id, gatedParent.id);
    assert.equal(gatedParent.workflowRun!.branches.find((branch) => branch.stepId === 'explorer')?.status, 'awaiting_approval');

    const rejected = await service.rejectTask(explorer.approvalId!, session.sessionId!);
    assert.equal(rejected.success, true);
    const resolvedParent = service.getTask(gatedParent.id);
    assert.equal(resolvedParent?.workflowRun?.branches.find((branch) => branch.stepId === 'explorer')?.status, 'failed');
    assert.equal(resolvedParent?.workflowRun?.branches.find((branch) => branch.stepId === 'editor')?.status, 'blocked');
    assert.equal(resolvedParent?.workflowRun?.branches.find((branch) => branch.stepId === 'repos')?.status, 'blocked');
    assert.ok(service.audit.getRecords().some((entry) => entry.eventType === 'WORKFLOW_BRANCH_APPROVAL_RESOLVED'));
  } finally {
    service.stopBackgroundServices();
    rmSync(directory, { recursive: true, force: true });
  }
});
