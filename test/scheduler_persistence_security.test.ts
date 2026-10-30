import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { Scheduler } from '../src/scheduler/scheduler.js';

test('scheduler fails closed when the at-most-once state cannot be persisted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-scheduler-persist-'));
  const stateDirectory = join(root, 'state');
  const statePath = join(stateDirectory, 'schedules.json');
  const audit = new AuditLogger(join(root, 'audit.log'));
  let runnerCalls = 0;

  try {
    const scheduler = new Scheduler(
      audit,
      async () => {
        runnerCalls++;
        return { state: 'COMPLETED' };
      },
      statePath,
      'test-owner-control-token-that-is-long-enough-123456',
    );

    const created = scheduler.create('device-test', 'read system memory', Date.now() + 60_000);
    assert.equal(created.ok, true);
    if (!created.ok) return;

    // Make the parent path unusable after creation to simulate a disk/permission failure.
    rmSync(stateDirectory, { recursive: true, force: true });
    writeFileSync(stateDirectory, 'not-a-directory');

    await scheduler.tick(Date.now() + 61_000);

    assert.equal(runnerCalls, 0, 'scheduled work must not execute without durable at-most-once state');
    assert.equal(scheduler.healthy, false, 'persistence failure must disable the scheduler');
    assert.ok(audit.getPublicRecords().some((record) => record.eventType === 'SCHEDULE_PERSIST_FAILED'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
