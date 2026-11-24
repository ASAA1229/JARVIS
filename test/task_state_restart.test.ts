import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { freePort } from './helpers/freePort.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission, TaskState } from '../src/core/types.js';

const OWNER_TOKEN = 'task-state-restart-token-0123456789abcdef';
const previousToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;
const dir = mkdtempSync(join(tmpdir(), 'jarvis-task-restart-'));
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
after(() => {
  if (previousToken === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN;
  else process.env.JARVIS_OWNER_CONTROL_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

type Who = { deviceId: string; sessionId: string; keys: { privateKey: string; publicKey: string } };
function session(server: JarvisServer, deviceId: string, keys: Who['keys']): Who {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const created = server.getService().identity.createSession(deviceId, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  assert.equal(created.success, true);
  return { deviceId, sessionId: created.sessionId!, keys };
}
function signed(who: Who, method: string, path: string) {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const canonical = CryptoUtil.buildCanonicalRequestString(method, path, who.sessionId, timestamp, nonce, undefined);
  return { 'x-session-id': who.sessionId, 'x-request-timestamp': String(timestamp), 'x-request-nonce': nonce, 'x-request-signature': CryptoUtil.signData(canonical, who.keys.privateKey) };
}
async function apiTasks(port: number, who: Who) {
  const response = await fetch(`http://127.0.0.1:${port}/api/tasks`, { headers: signed(who, 'GET', '/api/tasks') });
  assert.equal(response.status, 200);
  return (await response.json() as { tasks: Array<{ id: string; state: string; lifecycle: string; needsOwnerReview: boolean }> }).tasks;
}

test('E2:D4.8 tasks and approvals persisted before a restart give consistent task.state events and /api/tasks state', async () => {
  const paths = [join(dir, 'audit.log'), join(dir, 'devices.json')] as const;
  const port1 = await freePort();
  const first = new JarvisServer(port1, ...paths);
  await first.start();
  const service1 = first.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service1.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE]);
  const enrolled = service1.identity.enrollDevice(challenge.challengeToken, 'restart-owner', keys.publicKey);
  assert.equal(enrolled.success, true);
  const who1 = session(first, enrolled.deviceId!, keys);

  const waiting = await service1.submitOperations(who1.sessionId, 'Write a note', [{ operation: 'memory:save', parameters: { category: 'preference', content: 'restart test' } }]);
  assert.equal(waiting.state, TaskState.AWAITING_APPROVAL);
  const uncertain = await service1.submitOperations(who1.sessionId, 'Launch an app', [{ operation: 'app:launch', parameters: { appId: 'notepad' } }]);
  service1.appAdapter.launchApp = async () => { throw new Error('adapter crash'); };
  const recovered = await service1.approveTask(uncertain.approvalId!, who1.sessionId);
  assert.equal(recovered.state, TaskState.AWAITING_RECOVERY);
  const completed = await service1.submitRequest(who1.sessionId, 'What is the OS version?');
  assert.equal(completed.state, TaskState.COMPLETED);
  const before = new Map((await apiTasks(port1, who1)).map((t) => [t.id, t]));
  await first.stop();

  const port2 = await freePort();
  const second = new JarvisServer(port2, ...paths);
  await second.start();
  try {
    const service2 = second.getService();
    const who2 = session(second, enrolled.deviceId!, keys);
    const after = new Map((await apiTasks(port2, who2)).map((t) => [t.id, t]));

    // Same tasks, same states: nothing lost, nothing auto-approved or resumed.
    assert.equal(after.get(waiting.taskId)?.state, 'AWAITING_APPROVAL');
    assert.equal(after.get(waiting.taskId)?.lifecycle, 'queued');
    assert.equal(after.get(uncertain.taskId)?.state, 'AWAITING_RECOVERY');
    assert.equal(after.get(uncertain.taskId)?.needsOwnerReview, true);
    assert.equal(after.get(completed.taskId)?.state, 'COMPLETED');
    assert.equal(after.get(completed.taskId)?.needsOwnerReview, false);
    for (const [id, task] of before) assert.equal(after.get(id)?.state, task.state);
    assert.ok(service2.policy.getApproval(waiting.approvalId!), 'pending approval is recovered undecided');

    // Any task.state event the new process has emitted agrees with /api/tasks.
    const latestEvents = () => {
      const latest = new Map<string, Record<string, unknown>>();
      for (const e of service2.events.since(0, { deviceId: who2.deviceId, owner: true }, 500).events) {
        if (e.type === 'task.state') latest.set(String(e.data.taskId), e.data);
      }
      return latest;
    };
    for (const [id, data] of latestEvents()) assert.equal(data.state, after.get(id)?.state, `event/API state mismatch for ${id}`);

    // A new transition after restart emits an event matching the API view.
    const rejected = await service2.rejectTask(waiting.approvalId!, who2.sessionId);
    assert.equal(rejected.success, true);
    const final = new Map((await apiTasks(port2, who2)).map((t) => [t.id, t]));
    const event = latestEvents().get(waiting.taskId);
    assert.ok(event, 'a task.state event was published for the post-restart transition');
    assert.equal(event!.state, final.get(waiting.taskId)?.state);
    assert.equal(event!.lifecycle, final.get(waiting.taskId)?.lifecycle);
    assert.equal(final.get(waiting.taskId)?.lifecycle, 'cancelled');
  } finally {
    await second.stop();
  }
});
