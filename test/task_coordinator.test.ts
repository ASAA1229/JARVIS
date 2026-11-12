import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskCoordinator, TaskAlreadyRunningError, TaskQueueTimeoutError } from '../src/core/taskCoordinator.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('bounds global and per-device concurrency', async () => {
  const coordinator = new TaskCoordinator(2, 1, 10, 1000);
  let active = 0;
  let maximum = 0;
  const work = async () => {
    active++;
    maximum = Math.max(maximum, active);
    await delay(20);
    active--;
  };
  await Promise.all([
    coordinator.run({ taskId: 'a1', deviceId: 'a' }, work),
    coordinator.run({ taskId: 'a2', deviceId: 'a' }, work),
    coordinator.run({ taskId: 'b1', deviceId: 'b' }, work),
  ]);
  assert.equal(maximum, 2);
  assert.equal(coordinator.snapshot().active, 0);
});

test('serializes tasks that require the same resource while allowing unrelated resources', async () => {
  const coordinator = new TaskCoordinator(3, 3);
  const events: string[] = [];
  let shared = 0;
  const critical = async (id: string, resource: string) => coordinator.run(
    { taskId: id, deviceId: id, resources: [resource] },
    async () => {
      if (resource === 'desktop:device-1') {
        shared++;
        assert.equal(shared, 1, 'shared desktop lock must be exclusive');
      }
      events.push(`start:${id}`);
      await delay(15);
      events.push(`end:${id}`);
      if (resource === 'desktop:device-1') shared--;
    },
  );
  await Promise.all([critical('one', 'desktop:device-1'), critical('two', 'desktop:device-1'), critical('three', 'files:workspace')]);
  assert.ok(events.indexOf('end:one') < events.indexOf('start:two') || events.indexOf('end:two') < events.indexOf('start:one'));
  assert.equal(coordinator.snapshot().lockedResources.length, 0);
});

test('atomically acquires sorted resource sets so opposite lock order cannot deadlock', async () => {
  const coordinator = new TaskCoordinator(2, 2);
  const order: string[] = [];
  await Promise.all([
    coordinator.run({ taskId: 'left', deviceId: 'a', resources: ['resource:a', 'resource:b'] }, async () => { order.push('left'); await delay(10); }),
    coordinator.run({ taskId: 'right', deviceId: 'b', resources: ['resource:b', 'resource:a'] }, async () => { order.push('right'); await delay(10); }),
  ]);
  assert.equal(order.length, 2);
  assert.equal(coordinator.snapshot().queued, 0);
});

test('queued cancellation removes work before any side effect starts', async () => {
  const coordinator = new TaskCoordinator(1, 1);
  const first = new AbortController();
  let secondRan = false;
  const running = coordinator.run({ taskId: 'running', deviceId: 'a' }, async () => { await delay(30); });
  const queued = coordinator.run({ taskId: 'queued', deviceId: 'a', signal: first.signal }, async () => { secondRan = true; });
  first.abort();
  await assert.rejects(queued, { name: 'AbortError' });
  await running;
  assert.equal(secondRan, false);
});

test('queue timeout rejects without starting the operation', async () => {
  const coordinator = new TaskCoordinator(1, 1, 5, 10);
  let started = false;
  const running = coordinator.run({ taskId: 'busy', deviceId: 'a' }, async () => { await delay(30); });
  const queued = coordinator.run({ taskId: 'waiting', deviceId: 'b', queueTimeoutMs: 5 }, async () => { started = true; });
  await assert.rejects(queued, TaskQueueTimeoutError);
  await running;
  assert.equal(started, false);
});

test('rejects duplicate active task identifiers', async () => {
  const coordinator = new TaskCoordinator(1, 1);
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const first = coordinator.run({ taskId: 'duplicate', deviceId: 'a' }, async () => held);
  await assert.rejects(coordinator.run({ taskId: 'duplicate', deviceId: 'a' }, async () => undefined), TaskAlreadyRunningError);
  release();
  await first;
});

test('failed work always releases slots and resource locks', async () => {
  const coordinator = new TaskCoordinator(1, 1);
  await assert.rejects(coordinator.run({ taskId: 'failure', deviceId: 'a', resources: ['desktop:a'] }, async () => { throw new Error('expected'); }), /expected/);
  assert.equal(coordinator.snapshot().active, 0);
  assert.deepEqual(coordinator.snapshot().lockedResources, []);
});
