import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

test('planner normalizes polite and punctuated common app launch requests', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'launch-phrasing-test', timestamp: Date.now() };
  const cases = [
    ['Open Notepad.', 'notepad'],
    ['Hey Jarvis open Notepad', 'notepad'],
    ['Hey Jarvis, open Notepad.', 'notepad'],
    ['Hey Jarvis, open Calculator please.', 'calc'],
    ['Run Paint for me', 'mspaint'],
  ] as const;

  for (const [request, appId] of cases) {
    const plan = await planner.generatePlan(request, context);
    assert.equal(plan.operations[0]?.operation, 'app:launch', request);
    assert.equal(plan.operations[0]?.parameters.appId, appId, request);
  }
});
