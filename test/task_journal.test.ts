import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskJournal } from '../src/core/taskJournal.js';
import type { TaskLifecycleRecord } from '../src/core/service.js';
import { TaskState, VerificationOutcome, Permission, RiskTier } from '../src/core/types.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { JarvisCoreService } from '../src/core/service.js';
import type { IAIPlannerProvider } from '../src/planner/planner.js';

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

test('manual recovery reconciliation records an owner decision without replaying a task', () => withTempDir((directory) => {
  const statePath = join(directory, 'state');
  const auditPath = join(directory, 'audit.log');
  new TaskJournal(statePath + '.tasks', TOKEN).save(record({ state: TaskState.AWAITING_RECOVERY, interrupted: true }));
  const service = new JarvisCoreService({} as IAIPlannerProvider, auditPath, statePath, TOKEN);
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'Recovery owner', keys.publicKey);
    assert.equal(enrolled.success, true);
    const timestamp = Date.now();
    const nonce = 'a'.repeat(32);
    const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey);
    const session = service.identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
    assert.equal(session.success, true);

    const result = service.reconcileTask(
      'task-test-001' as TaskLifecycleRecord['id'],
      session.sessionId!,
      'confirmed_no_effect',
      'Checked the target application and confirmed no change occurred.',
    );
    assert.equal(result.success, true);
    assert.equal(result.state, TaskState.FAILED);
    const stored = service.getTask('task-test-001' as TaskLifecycleRecord['id'])!;
    assert.equal(stored.reconciliation?.disposition, 'confirmed_no_effect');
    assert.match(stored.error || '', /will not be replayed/i);
    assert.equal(service.audit.getRecords().some((entry) => entry.eventType === 'TASK_RECOVERY_RECONCILED'), true);
    assert.equal(service.listTasks().length, 1, 'reconciliation must not create or execute a replacement task');
  } finally {
    service.stopBackgroundServices();
    rmSync(directory, { recursive: true, force: true });
  }
}));

test('a stale approval cannot execute a task already awaiting recovery', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-recovery-approval-'));
  const statePath = join(directory, 'state');
  try {
    new TaskJournal(statePath + '.tasks', TOKEN).save(record({ state: TaskState.AWAITING_RECOVERY, interrupted: true }));
    const service = new JarvisCoreService({} as IAIPlannerProvider, join(directory, 'audit.log'), statePath, TOKEN);
    try {
      const keys = CryptoUtil.generateEd25519KeyPair();
      const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE]);
      const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'Approval owner', keys.publicKey);
      assert.equal(enrolled.success, true);
      const timestamp = Date.now();
      const nonce = 'c'.repeat(32);
      const session = service.identity.createSession(
        enrolled.deviceId!,
        CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey),
        timestamp,
        nonce,
      );
      assert.equal(session.success, true);

      const approval = service.policy.createApprovalRequest(
        'task-test-001',
        enrolled.deviceId!,
        'unsupported:test',
        {},
        RiskTier.HIGH,
      );
      await assert.rejects(
        () => service.approveTask(approval.id, session.sessionId!),
        /no longer awaiting approval/i,
      );
      assert.equal(service.policy.getApproval(approval.id)?.approved, false, 'stale approval must not be consumed');
      assert.equal(service.getTask('task-test-001' as TaskLifecycleRecord['id'])?.state, TaskState.AWAITING_RECOVERY);
      assert.equal(service.audit.getRecords().some((entry) => entry.eventType === 'APPROVAL_FAILED_TASK_NOT_PENDING'), true);
    } finally {
      service.stopBackgroundServices();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('manual recovery never promotes a user observation to verified success', () => withTempDir((directory) => {
  const statePath = join(directory, 'state');
  new TaskJournal(statePath + '.tasks', TOKEN).save(record({ state: TaskState.AWAITING_RECOVERY, interrupted: true }));
  const service = new JarvisCoreService({} as IAIPlannerProvider, join(directory, 'audit.log'), statePath, TOKEN);
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'Recovery owner', keys.publicKey);
    assert.equal(enrolled.success, true);
    const timestamp = Date.now();
    const nonce = 'b'.repeat(32);
    const session = service.identity.createSession(
      enrolled.deviceId!,
      CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey),
      timestamp,
      nonce,
    );
    assert.equal(session.success, true);

    const observed = service.reconcileTask('task-test-001' as TaskLifecycleRecord['id'], session.sessionId!, 'effect_observed', 'The target app shows the change but persistence is unverified.');
    assert.equal(observed.state, TaskState.PARTIAL);
    assert.notEqual(observed.state, TaskState.COMPLETED);
  } finally {
    service.stopBackgroundServices();
    rmSync(directory, { recursive: true, force: true });
  }
}));



test('still-unknown recovery disposition leaves the task awaiting recovery without retry', () => withTempDir((directory) => {
  const statePath = join(directory, 'state');
  new TaskJournal(statePath + '.tasks', TOKEN).save(record({ state: TaskState.AWAITING_RECOVERY, interrupted: true }));
  const service = new JarvisCoreService({} as IAIPlannerProvider, join(directory, 'audit.log'), statePath, TOKEN);
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
    const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'Recovery owner', keys.publicKey);
    assert.equal(enrolled.success, true);
    const timestamp = Date.now();
    const nonce = 'd'.repeat(32);
    const session = service.identity.createSession(
      enrolled.deviceId!,
      CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey),
      timestamp,
      nonce,
    );
    assert.equal(session.success, true);
    const result = service.reconcileTask(
      'task-test-001' as TaskLifecycleRecord['id'],
      session.sessionId!,
      'still_unknown',
      'Checked available evidence but cannot determine whether the action completed.',
    );
    assert.equal(result.success, true);
    assert.equal(result.state, TaskState.AWAITING_RECOVERY);
    assert.match(result.message, /no retry/i);
    assert.equal(service.getTask('task-test-001' as TaskLifecycleRecord['id'])?.reconciliation?.disposition, 'still_unknown');
    assert.equal(service.listTasks().length, 1);
  } finally {
    service.stopBackgroundServices();
  }
}));

test('core service restores interrupted journal tasks without resuming them', () => withTempDir((directory) => {
  const statePath = join(directory, 'state');
  new TaskJournal(statePath + '.tasks', TOKEN).save(record());
  const service = new JarvisCoreService({} as IAIPlannerProvider, join(directory, 'audit.log'), statePath, TOKEN);
  const restored = service.getTask('task-test-001' as TaskLifecycleRecord['id']);
  assert.ok(restored);
  assert.equal(restored.state, TaskState.AWAITING_RECOVERY);
  assert.equal(restored.interrupted, true);
  assert.match(restored.error || '', /reconcile external state before any retry/i);
  assert.equal(service.listTasks().length, 1);
  service.stopBackgroundServices();
}));
