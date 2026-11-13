import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationSessionStore } from '../src/conversation/conversationSessionStore.js';

/** JARVIS-GAP-014: reconcile conversation persistence behavior: path, encryption, restart and expiry. */
const TOKEN = 'conversation-persistence-owner-token-0123456789';
const realNow = Date.now.bind(Date);
let skew = 0;
afterEach(() => { mock.restoreAll(); skew = 0; });
function dir(): string { return mkdtempSync(join(tmpdir(), 'jarvis-conv-persist-')); }

test('canonical path: derived from the state path, falling back to ./data/conversations.enc', () => {
  assert.equal(ConversationSessionStore.resolvePath('C:/state/jarvis.json'), 'C:/state/jarvis.json.conversations');
  assert.equal(ConversationSessionStore.resolvePath(), './data/conversations.enc');
});

test('describe() reports exactly what is configured: persistent+encrypted only with a path and owner token', () => {
  const withoutToken = new ConversationSessionStore().describe();
  assert.deepEqual([withoutToken.persistent, withoutToken.encryptedAtRest, withoutToken.survivesRestart], [false, false, false]);
  const directory = dir();
  try {
    const persistent = new ConversationSessionStore(join(directory, 'c.enc'), TOKEN).describe();
    assert.deepEqual([persistent.persistent, persistent.encryptedAtRest, persistent.survivesRestart], [true, true, true]);
    assert.equal(persistent.idleExpiryMinutes, 30);
    assert.equal(persistent.maxSessions, 200);
    assert.equal(persistent.maxMessagesPerSession, 20);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('without an owner token nothing is written to disk and history does not survive a restart', () => {
  const directory = dir();
  try {
    const store = new ConversationSessionStore();
    const created = store.getOrCreate('dev')!;
    store.appendTurn(created.id, 'dev', 'hello', 'hi');
    assert.equal(existsSync(join(directory, 'anything')), false);
    assert.deepEqual(new ConversationSessionStore().getOrCreate('dev', created.id)?.history, [], 'a restarted process-local store starts empty');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('encrypted file never contains plaintext and a different owner token cannot read it', () => {
  const directory = dir();
  try {
    const path = join(directory, 'c.enc');
    const store = new ConversationSessionStore(path, TOKEN);
    const created = store.getOrCreate('dev')!;
    store.appendTurn(created.id, 'dev', 'my plaintext question about saffron', 'the plaintext answer about saffron');
    const raw = readFileSync(path);
    assert.equal(raw.includes(Buffer.from('saffron')), false);
    assert.throws(() => new ConversationSessionStore(path, 'a-different-owner-control-token-0123456789'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('idle expiry: a conversation older than 30 minutes is gone after restart and cannot be appended to', () => {
  mock.method(Date, 'now', () => realNow() + skew);
  const directory = dir();
  try {
    const path = join(directory, 'c.enc');
    const store = new ConversationSessionStore(path, TOKEN);
    const stale = store.getOrCreate('dev')!;
    store.appendTurn(stale.id, 'dev', 'old question', 'old answer');
    skew = 31 * 60_000;
    assert.equal(store.appendTurn(stale.id, 'dev', 'late', 'late'), false, 'expired in-memory session refuses appends');
    const restarted = new ConversationSessionStore(path, TOKEN);
    assert.deepEqual(restarted.getOrCreate('dev', stale.id)?.history, [], 'expired history is not restored');
    // Expired data is also purged from disk, not merely hidden.
    assert.equal(new ConversationSessionStore(path, TOKEN).getOrCreate('dev', stale.id)?.history.length, 0);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('a conversation just inside the idle window is restored after restart', () => {
  mock.method(Date, 'now', () => realNow() + skew);
  const directory = dir();
  try {
    const path = join(directory, 'c.enc');
    const store = new ConversationSessionStore(path, TOKEN);
    const created = store.getOrCreate('dev')!;
    store.appendTurn(created.id, 'dev', 'q', 'a');
    skew = 29 * 60_000;
    assert.equal(new ConversationSessionStore(path, TOKEN).getOrCreate('dev', created.id)?.history.length, 2);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('activity refreshes the idle window, and bounds (20 messages, 200 sessions) hold across restart', () => {
  mock.method(Date, 'now', () => realNow() + skew);
  const directory = dir();
  try {
    const path = join(directory, 'c.enc');
    const store = new ConversationSessionStore(path, TOKEN);
    const active = store.getOrCreate('dev')!;
    for (let minute = 0; minute < 5; minute++) {
      skew = minute * 20 * 60_000; // each turn is 20 minutes after the last, so the session never idles out
      assert.equal(store.appendTurn(active.id, 'dev', `q${minute}`, `a${minute}`), true);
    }
    assert.equal(new ConversationSessionStore(path, TOKEN).getOrCreate('dev', active.id)?.history.length, 10);
    for (let i = 0; i < 15; i++) store.appendTurn(active.id, 'dev', `more ${i}`, `reply ${i}`);
    assert.ok((new ConversationSessionStore(path, TOKEN).getOrCreate('dev', active.id)?.history.length ?? 99) <= 20);
    for (let i = 0; i < 205; i++) store.getOrCreate('dev');
    // The oldest session was evicted to honor the 200-session bound, durably.
    assert.deepEqual(new ConversationSessionStore(path, TOKEN).getOrCreate('dev', active.id)?.history, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('clear() removes history durably and another device can never read or clear it', () => {
  const directory = dir();
  try {
    const path = join(directory, 'c.enc');
    const store = new ConversationSessionStore(path, TOKEN);
    const created = store.getOrCreate('owner')!;
    store.appendTurn(created.id, 'owner', 'secret', 'reply');
    assert.equal(store.clear(created.id, 'intruder'), false);
    assert.equal(new ConversationSessionStore(path, TOKEN).getOrCreate('intruder', created.id), null);
    assert.equal(store.clear(created.id, 'owner'), true);
    assert.deepEqual(new ConversationSessionStore(path, TOKEN).getOrCreate('owner', created.id)?.history, []);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
