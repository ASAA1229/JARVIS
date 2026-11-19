import { test } from 'node:test';
import { freePort } from './helpers/freePort.js';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VoiceUtteranceGuard, WakeMetrics, isValidUtteranceId } from '../src/voice/utteranceGuard.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';

const OWNER_TOKEN = 'test-owner-control-token-0123456789abcdef';
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;

test('GAP-006 the same utterance id is accepted once and bound to exactly one task', () => {
  let now = 1_000;
  const guard = new VoiceUtteranceGuard(5_000, 600_000, 500, () => now);
  assert.deepEqual(guard.claim('dev', 'utt-aaaaaaaa', 'open notepad'), { accepted: true });
  guard.bindTask('dev', 'utt-aaaaaaaa', 'task-1');
  guard.bindTask('dev', 'utt-aaaaaaaa', 'task-2'); // a second bind never rewrites the first task
  now += 60_000;
  assert.deepEqual(guard.claim('dev', 'utt-aaaaaaaa', 'open notepad'), { accepted: false, reason: 'duplicate_utterance', taskId: 'task-1' });
});

test('GAP-006 a re-emitted final transcript with a new id is suppressed inside the duplicate window only', () => {
  let now = 0;
  const guard = new VoiceUtteranceGuard(5_000, 600_000, 500, () => now);
  assert.equal(guard.claim('dev', 'utt-00000001', 'Open Notepad.').accepted, true);
  guard.bindTask('dev', 'utt-00000001', 'task-1');
  now += 1_000;
  const dup = guard.claim('dev', 'utt-00000002', '  open   notepad ');
  assert.deepEqual(dup, { accepted: false, reason: 'duplicate_transcript', taskId: 'task-1' });
  // The suppressed id stays suppressed even after the text window closes.
  now += 10_000;
  assert.equal(guard.claim('dev', 'utt-00000002', 'open notepad').accepted, false);
  // A deliberate repeat after the window is a new utterance.
  assert.equal(guard.claim('dev', 'utt-00000003', 'open notepad').accepted, true);
});

test('GAP-006 duplicate suppression is per device, bounded and validates ids', () => {
  const guard = new VoiceUtteranceGuard(5_000, 600_000, 3);
  assert.equal(guard.claim('a', 'utt-00000001', 'same text').accepted, true);
  assert.equal(guard.claim('b', 'utt-00000001', 'same text').accepted, true, 'another device is independent');
  for (let i = 0; i < 10; i++) guard.claim('a', `utt-1000000${i}`, `different ${i}`);
  assert.ok(guard.size() <= 3, 'memory is bounded');
  assert.throws(() => guard.claim('a', 'bad id!', 'x'), /utteranceId/);
  assert.equal(isValidUtteranceId('short'), false);
  assert.equal(isValidUtteranceId('x'.repeat(65)), false);
});

test('GAP-006 wake metrics count events and compute false-accept / false-reject / duplicate rates', () => {
  const metrics = new WakeMetrics(() => 42);
  assert.equal(metrics.snapshot().falseAcceptRate, null, 'no fabricated rates without data');
  for (let i = 0; i < 10; i++) metrics.record('wake_detected');
  metrics.record('false_accept');
  metrics.record('false_accept');
  for (let i = 0; i < 2; i++) metrics.record('false_reject');
  for (let i = 0; i < 6; i++) metrics.record('command_dispatched');
  metrics.record('duplicate_suppressed');
  metrics.record('duplicate_suppressed');
  const snap = metrics.snapshot();
  assert.equal(snap.counts.wake_detected, 10);
  assert.equal(snap.falseAcceptRate, 0.2);
  assert.equal(snap.falseRejectRate, 2 / (8 + 2));
  assert.equal(snap.duplicateSuppressionRate, 2 / 8);
  assert.equal(snap.startedAt, 42);
  assert.throws(() => metrics.record('bogus' as never), /Unknown wake event/);
  assert.equal(WakeMetrics.isWakeEvent('false_accept'), true);
  assert.equal(JSON.stringify(snap).includes('transcript'), false, 'metrics never carry transcript text');
});

test('GAP-006 HTTP: a duplicate final transcript creates one task, and wake metrics are owner-only', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-voice-guard-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(directory, 'audit.log'), join(directory, 'state.json'));
  // The duplicate-transcript window is wall-clock based (5 s by default); on a loaded machine the signed
  // requests below can take longer than that, so the HTTP test uses a window that cannot expire mid-test.
  // Window expiry itself is covered deterministically by the injected-clock unit tests above.
  (server as unknown as { utteranceGuard: VoiceUtteranceGuard }).utteranceGuard = new VoiceUtteranceGuard(10 * 60_000);
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = await (await fetch(`${base}/api/enrollment/challenge`, { method: 'POST', headers: { 'x-owner-control-token': OWNER_TOKEN } })).json();
    const name = 'Voice guard test device';
    const proof = CryptoUtil.signData(`ENROLLMENT_PROOF:${challenge.challengeToken}:${name}:${CryptoUtil.sha256(keys.publicKey)}`, keys.privateKey);
    const redeem = await (await fetch(`${base}/api/enrollment/redeem`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeToken: challenge.challengeToken, deviceName: name, publicKey: keys.publicKey, proofSignature: proof }),
    })).json();
    assert.equal(redeem.success, true);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const session = await (await fetch(`${base}/api/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: redeem.deviceId, signature: CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce }),
    })).json();
    assert.equal(session.success, true);
    const signed = (method: string, path: string, body?: unknown) => {
      const ts = Date.now();
      const n = CryptoUtil.randomToken(16);
      const canonical = CryptoUtil.buildCanonicalRequestString(method, path, session.sessionId, ts, n, body);
      return {
        'Content-Type': 'application/json', 'x-session-id': session.sessionId, 'x-request-timestamp': String(ts),
        'x-request-nonce': n, 'x-request-signature': CryptoUtil.signData(canonical, keys.privateKey),
      };
    };
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: signed('POST', path, body), body: JSON.stringify(body) });
      return { status: response.status, json: await response.json() };
    };

    const first = await post('/api/request', { text: 'What is the OS version?', voice: { utteranceId: 'utt-http-0001' } });
    assert.equal(first.json.state, 'COMPLETED');
    const dupById = await post('/api/request', { text: 'What is the OS version?', voice: { utteranceId: 'utt-http-0001' } });
    assert.equal(dupById.status, 409);
    assert.equal(dupById.json.duplicate, true);
    assert.equal(dupById.json.taskId, first.json.taskId, 'duplicate points at the single original task');
    const dupByText = await post('/api/request', { text: 'what is the os version', voice: { utteranceId: 'utt-http-0002' } });
    assert.equal(dupByText.status, 409);
    assert.equal(dupByText.json.reason, 'duplicate_transcript');
    const bad = await post('/api/request', { text: 'hello', voice: { utteranceId: 'x' } });
    assert.equal(bad.status, 400);
    // Typed (non-voice) requests are never deduplicated.
    assert.equal((await post('/api/request', { text: 'What is the OS version?' })).status, 200);

    assert.equal((await post('/api/voice/wake-event', { event: 'wake_detected' })).status, 202);
    assert.equal((await post('/api/voice/wake-event', { event: 'not-real' })).status, 400);
    const metricsResponse = await fetch(`${base}/api/voice/metrics`, { headers: signed('GET', '/api/voice/metrics') });
    const metrics = await metricsResponse.json();
    assert.equal(metricsResponse.status, 200);
    assert.equal(metrics.counts.duplicate_suppressed, 2);
    assert.equal(metrics.counts.command_dispatched, 1);
    assert.equal(metrics.counts.wake_detected, 1);
    const tasks = server['jarvis'].listTasks().filter((task: { requestText: string }) => /os version/i.test(task.requestText));
    assert.equal(tasks.length, 2, 'one task for the voice utterance plus one for the typed request');
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
