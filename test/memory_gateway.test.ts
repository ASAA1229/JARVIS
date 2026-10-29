import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisCoreService } from '../src/core/service.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState, VerificationOutcome } from '../src/core/types.js';

const TOKEN = 'owner-control-token-for-memory-gateway-tests-01';

async function enrolledService(permissions: Permission[]) {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-memory-gw-'));
  const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), join(directory, 'audit.log'), join(directory, 'devices.json'), TOKEN);
  const keyPair = CryptoUtil.generateEd25519KeyPair();
  const challenge = jarvis.identity.createEnrollmentChallenge(permissions);
  const enrolled = jarvis.identity.enrollDevice(challenge.challengeToken, 'Memory Device', keyPair.publicKey);
  assert.equal(enrolled.success, true);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const signature = CryptoUtil.signData('SESSION_REQUEST:' + timestamp + ':' + nonce, keyPair.privateKey);
  const session = jarvis.identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
  assert.equal(session.success, true);
  return { directory, jarvis, sessionId: session.sessionId! };
}

test('memory save/list/update/delete require DEVICE_MANAGE and pass the policy gateway', async () => {
  const denied = await enrolledService([Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH]);
  try {
    const blocked = await denied.jarvis.submitRequest(denied.sessionId, 'remember project: JARVIS gateway test');
    assert.equal(blocked.state, TaskState.FAILED);
    assert.match(blocked.message || '', /missing permission/i);
  } finally {
    rmSync(denied.directory, { recursive: true, force: true });
  }

  const allowed = await enrolledService([Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE]);
  try {
    const pending = await allowed.jarvis.submitRequest(allowed.sessionId, 'remember project: JARVIS gateway test');
    assert.equal(pending.state, TaskState.AWAITING_APPROVAL);
    assert.ok(pending.approvalId);
    const saved = await allowed.jarvis.approveTask(pending.approvalId!, allowed.sessionId);
    assert.equal(saved.state, TaskState.COMPLETED);
    const memoryId = (saved.data as { id?: string } | undefined)?.id;
    assert.equal(typeof memoryId, 'string');

    const listed = await allowed.jarvis.submitRequest(allowed.sessionId, 'list my memories');
    assert.equal(listed.state, TaskState.COMPLETED);
    assert.equal(listed.outcome, VerificationOutcome.VERIFIED_SUCCESS);
    const records = listed.data as Array<{ id: string; content: string }>;
    assert.equal(records.some((record) => record.id === memoryId && record.content === 'JARVIS gateway test'), true);

    const updatePending = await allowed.jarvis.submitRequest(allowed.sessionId, 'update memory ' + memoryId + ' to corrected gateway fact');
    assert.equal(updatePending.state, TaskState.AWAITING_APPROVAL);
    const updated = await allowed.jarvis.approveTask(updatePending.approvalId!, allowed.sessionId);
    assert.equal(updated.state, TaskState.COMPLETED);

    const missing = await allowed.jarvis.submitRequest(allowed.sessionId, 'forget memory ' + 'ab'.repeat(16));
    assert.equal(missing.state, TaskState.AWAITING_APPROVAL);
    const missingResult = await allowed.jarvis.approveTask(missing.approvalId!, allowed.sessionId);
    assert.equal(missingResult.state, TaskState.FAILED);

    const deletePending = await allowed.jarvis.submitRequest(allowed.sessionId, 'forget memory ' + memoryId);
    const deleted = await allowed.jarvis.approveTask(deletePending.approvalId!, allowed.sessionId);
    assert.equal(deleted.state, TaskState.COMPLETED);
    assert.equal(allowed.jarvis.personalMemory?.list().length, 0);
  } finally {
    rmSync(allowed.directory, { recursive: true, force: true });
  }
});
