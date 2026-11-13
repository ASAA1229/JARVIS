import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationSessionStore } from '../src/conversation/conversationSessionStore.js';

const TOKEN = 'conversation-history-owner-token-0123456789';

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-conversations-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('conversation history is encrypted and survives store reconstruction', () => withTempDir((directory) => {
  const path = join(directory, 'conversations.enc');
  const first = new ConversationSessionStore(path, TOKEN);
  const created = first.getOrCreate('device-owner-a');
  assert.ok(created);
  assert.equal(first.appendTurn(created.id, 'device-owner-a', 'Hello Jarvis', 'Hello, sir.'), true);

  const raw = readFileSync(path, 'utf8');
  assert.ok(!raw.includes('Hello Jarvis'));
  assert.ok(!raw.includes('Hello, sir.'));

  const reopened = new ConversationSessionStore(path, TOKEN);
  const restored = reopened.getOrCreate('device-owner-a', created.id);
  assert.deepEqual(restored?.history.map((message) => [message.role, message.content]), [
    ['user', 'Hello Jarvis'],
    ['assistant', 'Hello, sir.'],
  ]);
}));

test('persisted conversations remain isolated to their authenticated device', () => withTempDir((directory) => {
  const store = new ConversationSessionStore(join(directory, 'conversations.enc'), TOKEN);
  const created = store.getOrCreate('device-owner-a');
  assert.ok(created);
  assert.equal(store.appendTurn(created.id, 'device-owner-a', 'private question', 'private answer'), true);

  const reopened = new ConversationSessionStore(join(directory, 'conversations.enc'), TOKEN);
  assert.equal(reopened.getOrCreate('device-owner-b', created.id), null);
  assert.equal(reopened.getOrCreate('device-owner-a', created.id)?.history.length, 2);
}));

test('clearing a conversation is durable across restarts', () => withTempDir((directory) => {
  const path = join(directory, 'conversations.enc');
  const store = new ConversationSessionStore(path, TOKEN);
  const created = store.getOrCreate('device-owner-a');
  assert.ok(created);
  assert.equal(store.appendTurn(created.id, 'device-owner-a', 'question', 'answer'), true);
  assert.equal(store.clear(created.id, 'device-owner-a'), true);

  const reopened = new ConversationSessionStore(path, TOKEN);
  assert.deepEqual(reopened.getOrCreate('device-owner-a', created.id)?.history, []);
}));

test('tampered encrypted conversation history fails closed', () => withTempDir((directory) => {
  const path = join(directory, 'conversations.enc');
  const store = new ConversationSessionStore(path, TOKEN);
  const created = store.getOrCreate('device-owner-a');
  assert.ok(created);
  store.appendTurn(created.id, 'device-owner-a', 'question', 'answer');

  const envelope = JSON.parse(readFileSync(path, 'utf8')) as { ciphertext: string };
  envelope.ciphertext = Buffer.from('tampered').toString('base64');
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => new ConversationSessionStore(path, TOKEN));
}));

test('conversation persistence requires both path and owner token', () => {
  assert.throws(() => new ConversationSessionStore('./data/conversations.enc'), /requires both/i);
  assert.throws(() => new ConversationSessionStore(undefined, TOKEN), /requires both/i);
});
