import test from 'node:test';
import assert from 'node:assert/strict';
import { answerConversationalMessage } from '../src/conversation/conversationalAssistant.js';

test('answers greetings in natural English', async () => {
  assert.equal(await answerConversationalMessage('Hello Jarvis'), 'Hello, sir. How can I help you today?');
});

test('answers assistant identity consistently', async () => {
  const answer = await answerConversationalMessage('Who are you?');
  assert.ok(answer?.startsWith('I am JARVIS, your personal AI assistant'));
  assert.ok(!answer?.startsWith('{'));
});

test('answers creator identity', async () => {
  assert.match(await answerConversationalMessage('Who created you?') || '', /You created me, sir/);
});

test('does not invent owner memories when none are available', async () => {
  assert.match(await answerConversationalMessage('Tell me about myself') || '', /do not have any owner memories available/);
});

test('uses authorized supplied memories for owner questions', async () => {
  const answer = await answerConversationalMessage('What do you know about me?', [
    { content: 'The owner is building JARVIS.' },
  ]);
  assert.match(answer || '', /The owner is building JARVIS/);
});

test('routes action requests to the existing planner', async () => {
  assert.equal(await answerConversationalMessage('Open Notepad'), null);
  assert.equal(await answerConversationalMessage('Delete file report.txt'), null);
});

test('answers common AI definitions without a model provider', async () => {
  assert.match(await answerConversationalMessage('What is artificial intelligence?') || '', /field of computing/);
});

test('routes system fact queries to the deterministic action planner', async () => {
  assert.equal(await answerConversationalMessage('What is the OS version?'), null);
  assert.equal(await answerConversationalMessage('Check system memory and RAM'), null);
  assert.equal(await answerConversationalMessage('Show disk space'), null);
});

test('routes schedule-management requests to the action planner', async () => {
  assert.equal(await answerConversationalMessage('List my schedules'), null);
  assert.equal(await answerConversationalMessage('Schedule in 10 minutes then every 30 minutes to check system memory'), null);
});
