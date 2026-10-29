import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommunicationsAdapter, parseEmailDraft } from '../src/adapters/communications.js';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { JarvisCoreService } from '../src/core/service.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState, VerificationOutcome } from '../src/core/types.js';
import { WindowsAppLauncherAdapter } from '../src/adapters/windowsAppLauncher.js';

test('email drafts are validated and never reported as sent', async () => {
  assert.equal(parseEmailDraft({ to: 'not-an-email', subject: 'Hi', body: 'Hello' }).ok, false);
  const adapter = new CommunicationsAdapter();
  const result = await adapter.handoffEmail({
    to: 'owner@example.com',
    subject: 'Review',
    body: 'Please review this draft.',
  });
  assert.equal(result.success, true);
  assert.equal(result.outcome, VerificationOutcome.PARTIAL_SUCCESS);
  assert.equal(result.evidence.deliveryVerified, false);
  assert.equal((result.data as { sent?: boolean }).sent, false);
});

test('planner requires a complete email draft and refuses silent send', async () => {
  const planner = new LocalHeuristicPlanner();
  const context = { requesterName: 'owner', timestamp: Date.now() };
  const incomplete = await planner.generatePlan('send an email to the team', context);
  assert.equal(incomplete.operations.length, 0);
  assert.match(incomplete.explanation, /will not send/i);
  const complete = await planner.generatePlan('draft email to owner@example.com subject "Hello" body "Please review"', context);
  assert.equal(complete.operations[0]?.operation, 'comms:handoff_email');
  assert.equal(complete.operations[0]?.parameters.to, 'owner@example.com');
});

test('unsupported communications channels are explicit failures', async () => {
  const planner = new LocalHeuristicPlanner();
  const plan = await planner.generatePlan('send a WhatsApp message to Alice', { requesterName: 'owner', timestamp: Date.now() });
  assert.equal(plan.operations[0]?.operation, 'comms:unsupported');
  const adapter = new CommunicationsAdapter();
  const result = adapter.unsupported('whatsapp');
  assert.equal(result.success, false);
  assert.equal(result.failureKind, 'unsupported');
  assert.equal(result.evidence.deliveryVerified, false);
});

test('app inventory lists allowlisted capabilities without launching', async () => {
  const inventory = await new WindowsAppLauncherAdapter().inventory();
  assert.equal(inventory.success, true);
  const data = inventory.data as { allowlisted: Array<{ applicationId: string; supportedOperations: string[] }> };
  assert.ok(data.allowlisted.some((app) => app.applicationId === 'notepad' && app.supportedOperations.includes('app:launch')));
});

test('email handoff is policy-gated and parameter-bound', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-comms-'));
  try {
    const jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), join(directory, 'audit.log'), join(directory, 'devices.json'));
    const keyPair = CryptoUtil.generateEd25519KeyPair();
    const challenge = jarvis.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH]);
    const enrolled = jarvis.identity.enrollDevice(challenge.challengeToken, 'Comms Device', keyPair.publicKey);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const session = jarvis.identity.createSession(
      enrolled.deviceId!,
      CryptoUtil.signData('SESSION_REQUEST:' + timestamp + ':' + nonce, keyPair.privateKey),
      timestamp,
      nonce,
    );
    const pending = await jarvis.submitRequest(session.sessionId!, 'draft email to owner@example.com subject "Hello" body "Please review"');
    assert.equal(pending.state, TaskState.AWAITING_APPROVAL);
    const approved = await jarvis.approveTask(pending.approvalId!, session.sessionId!);
    assert.equal(approved.state, TaskState.PARTIAL);
    assert.equal(approved.outcome, VerificationOutcome.PARTIAL_SUCCESS);
    assert.equal((approved.data as { sent?: boolean }).sent, false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
