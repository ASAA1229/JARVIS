import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskJournal } from '../src/core/taskJournal.js';
import type { TaskLifecycleRecord } from '../src/core/service.js';
import { TaskState, VerificationOutcome } from '../src/core/types.js';

const TOKEN = 'owner-control-token-for-task-journal-tests-01';

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-task-journal-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

function record(overrides: Partial<TaskLifecycleRecord> = {}): TaskLifecycleRecord {
  return {
    id: 'task-test-001',
    deviceId: 'dev-test-001',
    requestText: 'open Notepad and type a harmless test',
    state: TaskState.EXECUTING,
    createdAt: 100,
    updatedAt: 101,
    operations: [{ operation: 'app:launch', parameters: { appId: 'Notepad' } }],
    operationIndex: 0,
    approvalId: 'approval-stale-after-restart',
    steps: [{ index: 0, operation: 'app:launch', status: 'completed', outcome: VerificationOutcome.VERIFIED_SUCCESS, at: 101 }],
    ...overrides,
  };
}

test('task journal encrypts checkpoints and restores them as recovery-required after restart', () => withTempDir((directory) => {
  const path = join(directory, 'tasks.enc');
  const journal = new TaskJournal(path, TOKEN);
  journal.save(record());
  const raw = readFileSync(path, 'utf8');
  assert.equal(raw.includes('open Notepad and type a harmless test'), false);
  assert.equal(raw.includes('approval-stale-after-restart'), false);

  const restored = new TaskJournal(path, TOKEN).get('task-test-001');
  assert.ok(restored);
  assert.equal(restored.state, TaskState.AWAITING_RECOVERY);
  assert.equal(restored.interrupted, true);
  assert.equal(restored.approvalId, undefined);
  assert.match(restored.error || '', /automatic resume is disabled/i);
  assert.equal(restored.requestText, 'open Notepad and type a harmless test');
}));

test('terminal task states remain terminal when restored', () => withTempDir((directory) => {
  const path = join(directory, 'tasks.enc');
  const journal = new TaskJournal(path, TOKEN);
  journal.save(record({ state: TaskState.COMPLETED, approvalId: undefined }));
  const restored = new TaskJournal(path, TOKEN).get('task-test-001');
  assert.equal(restored?.state, TaskState.COMPLETED);
  assert.equal(restored?.interrupted, undefined);
}));

test('task journal returns defensive copies and rejects malformed checkpoints', () => withTempDir((directory) => {
  const journal = new TaskJournal(join(directory, 'tasks.enc'), TOKEN);
  journal.save(record());
  const snapshot = journal.get('task-test-001')!;
  snapshot.operations![0].parameters.appId = 'tampered';
  snapshot.steps![0].message = 'tampered';
  assert.equal(journal.get('task-test-001')?.operations?.[0].parameters.appId, 'Notepad');
  assert.notEqual(journal.get('task-test-001')?.steps?.[0].message, 'tampered');
  assert.throws(() => journal.save(record({ id: '' })), /checkpoint is invalid/i);
}));

test('task journal fails closed on tampered ciphertext and wrong owner token', () => withTempDir((directory) => {
  const path = join(directory, 'tasks.enc');
  new TaskJournal(path, TOKEN).save(record());
  const envelope = JSON.parse(readFileSync(path, 'utf8')) as { ciphertext: string };
  envelope.ciphertext = Buffer.from('tampered').toString('base64');
  writeFileSync(path, JSON.stringify(envelope));
  assert.throws(() => new TaskJournal(path, TOKEN), /could not be decrypted or validated/i);
  assert.throws(() => new TaskJournal(path, 'different-owner-control-token-for-tests-02'), /could not be decrypted or validated/i);
}));

test('task journal requires a strong owner control token', () => withTempDir((directory) => {
  assert.throws(() => new TaskJournal(join(directory, 'tasks.enc'), 'short'), /at least 32 characters/i);
}));
