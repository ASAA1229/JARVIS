import test from 'node:test';
import assert from 'node:assert/strict';
import { AuditLogger } from '../src/audit/audit.js';
import { Scheduler } from '../src/scheduler/scheduler.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('dispatches independent due schedules concurrently without duplicate in-flight runs', async () => {
  const audit = new AuditLogger();
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const scheduler = new Scheduler(audit, async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await delay(25);
    active--;
    return { state: 'COMPLETED' };
  });

  const dueAt = Date.now() + 60_000;
  assert.equal(scheduler.create('device-a', 'first safe read-only task', dueAt).ok, true);
  assert.equal(scheduler.create('device-b', 'second safe read-only task', dueAt).ok, true);

  const firstTick = scheduler.tick(dueAt + 1);
  await scheduler.tick(dueAt + 1);
  await firstTick;

  assert.equal(calls, 2, 'each due schedule should execute exactly once');
  assert.equal(maximum, 2, 'independent jobs should overlap');
  assert.equal(scheduler.list().every((job) => job.runCount === 1), true);
});
