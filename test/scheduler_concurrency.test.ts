import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { Scheduler } from '../src/scheduler/scheduler.js';

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('dispatches independent due schedules concurrently without duplicate in-flight runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-scheduler-concurrency-'));
  const audit = new AuditLogger(join(directory, 'audit.log'));
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
  rmSync(directory, { recursive: true, force: true });
});

test('caps scheduled dispatch fan-out and leaves remaining due jobs for the next tick', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-scheduler-cap-'));
  const audit = new AuditLogger(join(directory, 'audit.log'));
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const scheduler = new Scheduler(audit, async () => {
    calls++;
    active++;
    maximum = Math.max(maximum, active);
    await delay(15);
    active--;
    return { state: 'COMPLETED' };
  });
  const dueAt = Date.now() + 60_000;
  for (let i = 0; i < 6; i++) assert.equal(scheduler.create(`device-${i}`, `read-only task ${i}`, dueAt).ok, true);
  await scheduler.tick(dueAt + 1);
  assert.equal(calls, 4);
  await scheduler.tick(dueAt + 2);
  assert.equal(calls, 6);
  assert.equal(maximum, 4);
  rmSync(directory, { recursive: true, force: true });
});
