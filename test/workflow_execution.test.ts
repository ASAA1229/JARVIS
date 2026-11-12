import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowBranchExecutor } from '../src/workflows/workflowExecution.js';
import type { WorkflowStep } from '../src/workflows/workflowStore.js';

const step = (id: string, dependsOn: string[] = []): WorkflowStep => ({
  id, operation: 'system:get_memory_info', parameters: {}, dependsOn,
});

test('executes independent branches concurrently and joins dependent branches', async () => {
  const events: string[] = [];
  let active = 0;
  let maxActive = 0;
  const result = await new WorkflowBranchExecutor().run([
    step('a'), step('b'), step('join', ['a', 'b']),
  ], {
    runId: 'run-1', maxParallel: 2,
    checkpoint: async () => {},
    executeStep: async (item) => {
      active += 1; maxActive = Math.max(maxActive, active); events.push('start:' + item.id);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1; events.push('end:' + item.id);
      return { status: 'completed' };
    },
  });
  assert.equal(maxActive, 2);
  assert.equal(result.status, 'completed');
  assert.equal(result.branches.find((item) => item.stepId === 'join')?.status, 'completed');
  assert.ok(events.indexOf('end:a') < events.indexOf('start:join'));
  assert.ok(events.indexOf('end:b') < events.indexOf('start:join'));
});

test('approval pauses only its branch while unrelated branches continue', async () => {
  const calls: string[] = [];
  const result = await new WorkflowBranchExecutor().run([
    step('needs-approval'), step('independent'), step('dependent', ['needs-approval']),
  ], {
    runId: 'run-approval', maxParallel: 2,
    checkpoint: async () => {},
    executeStep: async (item) => {
      calls.push(item.id);
      return item.id === 'needs-approval'
        ? { status: 'awaiting_approval', approvalRef: 'approval-1' }
        : { status: 'completed' };
    },
  });
  assert.equal(result.status, 'awaiting_approval');
  assert.deepEqual(calls.sort(), ['independent', 'needs-approval']);
  assert.equal(result.branches.find((item) => item.stepId === 'dependent')?.status, 'pending');
  assert.equal(result.branches.find((item) => item.stepId === 'needs-approval')?.approvalRef, 'approval-1');
});

test('failed or uncertain branches block descendants but do not stop independent branches', async () => {
  const calls: string[] = [];
  const result = await new WorkflowBranchExecutor().run([
    step('bad'), step('child', ['bad']), step('other'),
  ], {
    runId: 'run-partial', maxParallel: 2,
    checkpoint: async () => {},
    executeStep: async (item) => {
      calls.push(item.id);
      return item.id === 'bad' ? { status: 'failed', message: 'verified failure' } : { status: 'completed' };
    },
  });
  assert.equal(result.status, 'partial');
  assert.deepEqual(calls.sort(), ['bad', 'other']);
  assert.equal(result.branches.find((item) => item.stepId === 'child')?.status, 'blocked');
  assert.equal(result.branches.find((item) => item.stepId === 'other')?.status, 'completed');
});

test('resource conflicts serialize otherwise independent branches', async () => {
  let active = 0;
  let maxActive = 0;
  const result = await new WorkflowBranchExecutor().run([step('a'), step('b')], {
    runId: 'run-lock', maxParallel: 2,
    resourcesForStep: () => ['desktop:host'],
    checkpoint: async () => {},
    executeStep: async () => {
      active += 1; maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { status: 'completed' };
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(maxActive, 1);
});

test('uncertain outcomes are never automatically retried', async () => {
  let calls = 0;
  const result = await new WorkflowBranchExecutor().run([step('side-effect')], {
    runId: 'run-uncertain',
    checkpoint: async () => {},
    executeStep: async () => { calls += 1; return { status: 'uncertain', message: 'timeout' }; },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.branches[0].status, 'uncertain');
});

test('checkpoint failure before execution prevents the side effect callback', async () => {
  let calls = 0;
  let writes = 0;
  const result = await new WorkflowBranchExecutor().run([step('a')], {
    runId: 'run-checkpoint-fail',
    checkpoint: async () => { writes += 1; if (writes === 2) throw new Error('disk full'); },
    executeStep: async () => { calls += 1; return { status: 'completed' }; },
  });
  assert.equal(calls, 0);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.branches[0].status, 'uncertain');
});

test('rejects cyclic and invalid workflow graphs', async () => {
  const runner = new WorkflowBranchExecutor();
  const options = { runId: 'invalid', checkpoint: async () => {}, executeStep: async () => ({ status: 'completed' as const }) };
  await assert.rejects(() => runner.run([step('a', ['b']), step('b', ['a'])], options), /cycle/);
  await assert.rejects(() => runner.run([step('a', ['missing'])], options), /unknown or self dependency/);
});
