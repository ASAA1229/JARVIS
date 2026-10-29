import assert from 'node:assert/strict';
import test from 'node:test';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

test('categorized memory save preserves the chosen category', async () => {
  const planner = new LocalHeuristicPlanner();
  const plan = await planner.generatePlan('remember project: JARVIS', { requesterName: 'owner', timestamp: 1800000000000 });
  assert.equal(plan.operations[0].operation, 'memory:save');
  assert.equal(plan.operations[0].parameters.category, 'project');
  assert.equal(plan.operations[0].parameters.content, 'JARVIS');
});

test('memory review routes to a read-only list operation', async () => {
  const plan = await new LocalHeuristicPlanner().generatePlan('list my memories', { requesterName: 'owner', timestamp: 1800000000000 });
  assert.equal(plan.operations[0].operation, 'memory:list');
});
