import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCoreService } from '../src/core/service.js';
import { TaskJournal } from '../src/core/taskJournal.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';

const OWNER_TOKEN = 'memory-scrub-owner-token-0123456789abcdef';

function enroll(jarvis: JarvisCoreService) {
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = jarvis.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);
  const enrolled = jarvis.identity.enrollDevice(challenge.challengeToken, 'memory-owner', keys.publicKey);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = jarvis.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  return session.sessionId!;
}

async function run(jarvis: JarvisCoreService, sessionId: string, text: string) {
  const pending = await jarvis.submitRequest(sessionId, text);
  if (pending.state !== TaskState.AWAITING_APPROVAL) return pending;
  return jarvis.approveTask(pending.approvalId!, sessionId);
}

test('deleting a memory also removes its text from task history and the encrypted journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-memory-scrub-'));
  try {
    const statePath = join(dir, 'devices.json');
    const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), join(dir, 'audit.log'), statePath, OWNER_TOKEN);
    const session = enroll(jarvis);
    const secretFact = 'Zephyrine Quillborough';

    const saved = await run(jarvis, session, `remember my name is ${secretFact}`);
    assert.equal(saved.state, TaskState.COMPLETED, saved.message);
    const listed = await run(jarvis, session, 'what do you remember about me');
    assert.equal(listed.state, TaskState.COMPLETED, listed.message);
    const memoryId = jarvis.personalMemory!.list()[0]!.id;

    const containsFact = (tasks: unknown[]) => JSON.stringify(tasks).includes(secretFact);
    assert.equal(containsFact(new TaskJournal(statePath + '.tasks', OWNER_TOKEN).list()), true, 'precondition: journal holds the text');

    const removed = await run(jarvis, session, `forget memory ${memoryId}`);
    assert.equal(removed.state, TaskState.COMPLETED, removed.message);
    assert.equal(jarvis.personalMemory!.list().length, 0);

    // Re-read and decrypt the journal from disk: no copy of the deleted text remains.
    const journal = new TaskJournal(statePath + '.tasks', OWNER_TOKEN).list();
    assert.equal(containsFact(journal), false);
    assert.equal(containsFact([...jarvis.listTasks?.() ?? journal]), false);
    // Task history itself is kept (scrubbed, not erased) for auditability.
    assert.ok(journal.some((task) => task.requestText === '[deleted personal memory]'));
    const deleteAudit = jarvis.audit.getRecords().filter((record) => record.eventType === 'PERSONAL_MEMORY_DELETE').at(-1);
    assert.equal(deleteAudit?.details['diskVerified'], true);
    assert.ok(Number(deleteAudit?.details['secondaryTasksScrubbed']) >= 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
