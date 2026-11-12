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
    ['Jarvis, open Notepad please', 'notepad'],
    ['OK Jarvis open calculator', 'calc'],
    ['okay jarvis: launch paint', 'mspaint'],
    ['Hey Jarvis could you please open Notepad?', 'notepad'],
    // Defense in depth when the browser recognizer clips the first syllable.
    ['pen Notepad', 'notepad'],
    ['pen up Notepad', 'notepad'],
  ] as const;

  for (const [request, appId] of cases) {
    const plan = await planner.generatePlan(request, context);
    assert.equal(plan.operations[0]?.operation, 'app:launch', request);
    assert.equal(plan.operations[0]?.parameters.appId, appId, request);
  }
});

test('wake-prefix stripping does not turn non-launch speech into a launch', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'launch-phrasing-test', timestamp: Date.now() };
  for (const request of ['Jarvis, what is Notepad?', 'Jarvisopen Notepad', 'Tell Jarvis about Notepad']) {
    const plan = await planner.generatePlan(request, context);
    assert.notEqual(plan.operations[0]?.operation, 'app:launch', request);
  }
});

test('planner supports opening a discovered app and dictating text into it', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'app-command-test', timestamp: Date.now() };
  const plan = await planner.generatePlan('Open Notepad and write ------', context);
  assert.equal(plan.operations[0]?.operation, 'desktop:launch_and_type');
  assert.equal(plan.operations[0]?.parameters.appId, 'notepad');
  assert.equal(plan.operations[0]?.parameters.text, '------');

  const generic = await planner.generatePlan('Open Visual Studio Code and type hello world', context);
  assert.equal(generic.operations[0]?.operation, 'desktop:launch_and_type');
  assert.equal(generic.operations[0]?.parameters.appId, 'Visual Studio Code');
  assert.equal(generic.operations[0]?.parameters.text, 'hello world');
});

test('planner creates a browser-scoped web search operation', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'browser-search-test', timestamp: Date.now() };
  const plan = await planner.generatePlan('Search for weather tomorrow on Chrome', context);
  assert.equal(plan.operations[0]?.operation, 'desktop:browser_search');
  assert.equal(plan.operations[0]?.parameters.appId, 'Google Chrome');
  assert.equal(plan.operations[0]?.parameters.query, 'weather tomorrow');
});
