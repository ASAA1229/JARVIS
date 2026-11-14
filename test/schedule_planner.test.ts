import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

const planner = new LocalHeuristicPlanner();

test('SCHEDULE-PLANNER-01: delayed recurring schedule preserves initial delay and repeat interval', async () => {
  const timestamp = 1_800_000_000_000;
  const plan = await planner.generatePlan(
    'schedule in 10 minutes then every 30 minutes to check system memory',
    { requesterName: 'owner', timestamp },
  );

  assert.equal(plan.operations.length, 1);
  assert.equal(plan.operations[0].operation, 'schedule:create');
  assert.equal(plan.operations[0].parameters.requestText, 'check system memory');
  assert.equal(plan.operations[0].parameters.runAt, timestamp + 10 * 60_000);
  assert.equal(plan.operations[0].parameters.everyMinutes, 30);
});

test('SCHEDULE-PLANNER-02: delayed recurring schedule supports hour units', async () => {
  const timestamp = 1_800_000_000_000;
  const plan = await planner.generatePlan(
    'schedule in 2 hours then every 3 hours to check system memory',
    { requesterName: 'owner', timestamp },
  );

  assert.equal(plan.operations[0].operation, 'schedule:create');
  assert.equal(plan.operations[0].parameters.runAt, timestamp + 2 * 60 * 60_000);
  assert.equal(plan.operations[0].parameters.everyMinutes, 180);
});

test('SCHEDULE-PLANNER-03: schedule listing remains a read-only schedule operation', async () => {
  const plan = await planner.generatePlan('list my schedules', {
    requesterName: 'owner',
    timestamp: 1_800_000_000_000,
  });

  assert.equal(plan.operations[0].operation, 'schedule:list');
});
