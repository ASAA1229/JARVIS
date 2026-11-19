import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';
import { freePort } from './helpers/freePort.js';

/**
 * JARVIS-US-008 criteria 1 and 4: the owner-specified wake wording is preserved exactly, and a
 * text-to-speech failure cannot affect task correctness or authorization.
 */
const OWNER_TOKEN = 'wake-ack-tts-isolation-owner-token-0123456789a';
process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;

const hud = readFileSync(new URL('../src/companion/hud.js', import.meta.url), 'utf8');

test('the spoken wake acknowledgement is exactly "Hi sir, I am ready to work." everywhere it is spoken', () => {
  assert.match(hud, /const WAKE_ACKNOWLEDGEMENT = 'Hi sir, I am ready to work\.';/);
  const spoken = [...hud.matchAll(/speakResponse\(\s*'([^']*ready to work[^']*)'\s*\)/g)].map((match) => match[1]);
  assert.ok(spoken.length >= 3, 'the acknowledgement is spoken in the wake flows');
  for (const phrase of spoken) assert.equal(phrase, 'Hi sir, I am ready to work.');
  assert.match(hud, /speakResponse\(WAKE_ACKNOWLEDGEMENT\)/);
  assert.equal(hud.includes('ready to work!'), false);
});

test('the wake phrase "Hey Jarvis" is a recognised wake phrase and the local detector is the audio path', () => {
  assert.match(hud, /const WAKE_PHRASES = \[[^\]]*'hey jarvis'[^\]]*\];/);
  assert.match(hud, /No wake audio is uploaded/);
});

test('TTS failure is isolated: synthesis errors reveal nothing, and tasks, authorization and audit are unaffected', async () => {
  const saved = { exe: process.env.JARVIS_PIPER_EXECUTABLE, model: process.env.JARVIS_PIPER_MODEL };
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-tts-isolation-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  const service = server.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ]);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'tts-test', keys.publicKey);
  const ts = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, keys.privateKey), ts, nonce);
  assert.equal(session.success, true);
  const post = async (path: string, body: unknown, sign = true) => {
    const t = Date.now();
    const n = CryptoUtil.randomToken(16);
    const canonical = CryptoUtil.buildCanonicalRequestString('POST', path, session.sessionId!, t, n, body);
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-id': session.sessionId!, 'x-request-timestamp': String(t), 'x-request-nonce': n, 'x-request-signature': sign ? CryptoUtil.signData(canonical, keys.privateKey) : 'bad' },
      body: JSON.stringify(body),
    });
    return { status: response.status, text: await response.text() };
  };
  try {
    const phrase = 'TTSISOLATIONSENTINEL spoken text';
    // 1. Piper not configured: a clean 503 that mentions no path or text.
    delete process.env.JARVIS_PIPER_EXECUTABLE;
    delete process.env.JARVIS_PIPER_MODEL;
    const notConfigured = await post('/api/voice/synthesize', { text: phrase });
    assert.equal(notConfigured.status, 503);
    assert.equal(notConfigured.text.includes('TTSISOLATIONSENTINEL'), false);
    // 2. Piper configured but broken: a clean 5xx with no executable or model paths.
    process.env.JARVIS_PIPER_EXECUTABLE = join(dir, 'missing-piper-binary.exe');
    process.env.JARVIS_PIPER_MODEL = join(dir, 'missing-voice.onnx');
    const broken = await post('/api/voice/synthesize', { text: phrase });
    assert.ok([502, 503].includes(broken.status), `unexpected ${broken.status}`);
    assert.equal(broken.text.includes('missing-piper-binary'), false);
    assert.equal(broken.text.includes('missing-voice'), false);
    assert.equal(broken.text.includes('TTSISOLATIONSENTINEL'), false);
    // 3. An unsigned synthesis request is still refused: TTS never bypasses authorization.
    assert.equal((await post('/api/voice/synthesize', { text: 'x' }, false)).status, 401);

    // Task correctness and authorization are unchanged after the failures.
    const result = await service.submitRequest(session.sessionId!, 'What is the OS version?');
    assert.equal(result.state, 'COMPLETED');
    assert.equal(result.verified, true);
    assert.equal(service.audit.verifyIntegrity().valid, true);
    assert.equal(readFileSync(join(dir, 'audit.log'), 'utf8').includes('TTSISOLATIONSENTINEL'), false, 'spoken text is never audited');
    const denied = await service.submitRequest(session.sessionId!, 'Please launch Notepad');
    assert.notEqual(denied.state, 'COMPLETED', 'a TTS failure does not widen permissions (this device has no launch permission)');
  } finally {
    await server.stop();
    for (const [key, value] of [['JARVIS_PIPER_EXECUTABLE', saved.exe], ['JARVIS_PIPER_MODEL', saved.model]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
