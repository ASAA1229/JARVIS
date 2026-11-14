import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowExecutionBatches, type WorkflowStep } from '../src/workflows/workflowStore.js';

const step = (id: string, dependsOn: string[] = []): WorkflowStep => ({
  id,
  operation: 'system:get_memory_info',
  parameters: {},
  dependsOn,
});

test('groups independent DAG steps into bounded deterministic execution waves', () => {
  const batches = workflowExecutionBatches([
    step('root-a'),
    step('root-b'),
    step('root-c'),
    step('child-a', ['root-a']),
    step('child-b', ['root-b']),
    step('final', ['child-a', 'child-b', 'root-c']),
  ], 2);

  assert.deepEqual(batches.map((batch) => batch.map((item) => item.id)), [
    ['root-a', 'root-b'],
    ['root-c'],
    ['child-a', 'child-b'],
    ['final'],
  ]);
  assert.equal(batches.every((batch) => batch.length <= 2), true);
});

test('rejects cyclic, unknown and self-referencing workflow dependencies', () => {
  assert.throws(() => workflowExecutionBatches([step('a', ['b']), step('b', ['a'])]), /cycle/);
  assert.throws(() => workflowExecutionBatches([step('a', ['missing'])]), /unknown or self dependency/);
  assert.throws(() => workflowExecutionBatches([step('a', ['a'])]), /unknown or self dependency/);
});

test('rejects invalid workflow parallelism limits', () => {
  assert.throws(() => workflowExecutionBatches([step('a')], 0), /maxParallel/);
  assert.throws(() => workflowExecutionBatches([step('a')], 21), /maxParallel/);
});
