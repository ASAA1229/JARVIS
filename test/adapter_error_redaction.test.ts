import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, rmSync } from 'node:fs';
import { JarvisCoreService } from '../src/core/service.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { needsOwnerReview } from '../src/core/commandLifecycle.js';

const auditPath = `./data/test_adapter_error_redaction_${process.pid}.log`;

afterEach(() => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
});

test('adapter exceptions do not leak private diagnostic details into task results or audit records', async () => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
  const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), auditPath);
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = jarvis.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ]);
  const enrolled = jarvis.identity.enrollDevice(challenge.challengeToken, 'redaction-test', keys.publicKey);
  assert.equal(enrolled.success, true);

  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const signature = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey);
  const session = jarvis.identity.createSession(enrolled.deviceId!, signature, timestamp, nonce);
  assert.equal(session.success, true);

  const secretDiagnostic = 'C:\\Users\\owner\\private\\secret-token.txt';
  jarvis.systemAdapter.getOsInfo = async () => {
    throw new Error(secretDiagnostic);
  };

  const result = await jarvis.submitRequest(session.sessionId!, 'What is the OS version?');
  assert.equal(result.state, TaskState.FAILED);
  assert.match(result.message, /operation failed inside its adapter/i);
  assert.doesNotMatch(result.message, /secret-token|private/i);
  assert.doesNotMatch(JSON.stringify(jarvis.audit.getPublicRecords()), /secret-token|private/i);
  assert.ok(jarvis.audit.getPublicRecords().some((record) =>
    record.eventType === 'EXECUTION_COMPLETED' && record.details.errorType === 'Error',
  ));
});

test('E2:D4.8 adapter exception after dispatch of a side-effecting operation is uncertain and needs owner review', async () => {
  if (existsSync(auditPath)) rmSync(auditPath, { force: true });
  const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), auditPath);
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = jarvis.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH]);
  const enrolled = jarvis.identity.enrollDevice(challenge.challengeToken, 'uncertain-test', keys.publicKey);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = jarvis.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  jarvis.appAdapter.launchApp = async () => { throw new Error('C:\Users\owner\private\launcher.exe crashed'); };

  const pending = await jarvis.submitOperations(session.sessionId!, 'Launch an app', [{ operation: 'app:launch', parameters: { appId: 'notepad' } }]);
  assert.equal(pending.state, TaskState.AWAITING_APPROVAL);
  const result = await jarvis.approveTask(pending.approvalId!, session.sessionId!);
  // The launch may have partly happened: not a clean FAILED, but held for owner review.
  assert.equal(result.state, TaskState.AWAITING_RECOVERY);
  assert.equal(result.outcome, 'UNCERTAIN');
  assert.match(result.message, /owner review/i);
  assert.doesNotMatch(result.message, /launcher|private/i);
  assert.equal(needsOwnerReview(result.state), true);
  assert.ok(jarvis.events.since(0, { deviceId: enrolled.deviceId!, owner: true }).events
    .some((e) => e.type === 'task.state' && e.data.taskId === result.taskId && e.data.state === 'AWAITING_RECOVERY' && e.data.needsOwnerReview === true));
});
