import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';

test('voice synthesis endpoint redacts local executable and model diagnostics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-voice-redaction-'));
  const previousExecutable = process.env.JARVIS_PIPER_EXECUTABLE;
  const previousModel = process.env.JARVIS_PIPER_MODEL;
  const secretPath = 'C:\\Users\\owner\\private\\jarvis-secret-piper.exe';
  const secretModel = 'C:\\Users\\owner\\private\\secret-voice-model.onnx';
  const probe = createNetServer();
  let server: JarvisServer | undefined;
  try {
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

    process.env.JARVIS_PIPER_EXECUTABLE = secretPath;
    process.env.JARVIS_PIPER_MODEL = secretModel;
    server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'devices.json'));
    await server.start();

    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = server.getService().identity.createEnrollmentChallenge([
      Permission.SYSTEM_INFO_READ,
      Permission.APP_LAUNCH,
    ]);
    const enrolled = server.getService().identity.enrollDevice(challenge.challengeToken, 'voice-redaction-test', keys.publicKey);
    assert.equal(enrolled.success, true);
    const timestamp = Date.now();
    const nonce = CryptoUtil.randomToken(16);
    const sessionProof = CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey);
    const session = server.getService().identity.createSession(enrolled.deviceId!, sessionProof, timestamp, nonce);
    assert.equal(session.success, true);

    const body = { text: 'Hello JARVIS' };
    const requestTimestamp = Date.now();
    const requestNonce = CryptoUtil.randomToken(16);
    const canonical = CryptoUtil.buildCanonicalRequestString(
      'POST', '/api/voice/synthesize', session.sessionId!, requestTimestamp, requestNonce, body,
    );
    const response = await fetch(`http://127.0.0.1:${port}/api/voice/synthesize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-session-id': session.sessionId!,
        'x-request-timestamp': String(requestTimestamp),
        'x-request-nonce': requestNonce,
        'x-request-signature': CryptoUtil.signData(canonical, keys.privateKey),
      },
      body: JSON.stringify(body),
    });

    assert.equal(response.status, 502);
    const responseText = await response.text();
    assert.match(responseText, /Local speech generation failed/);
    assert.doesNotMatch(responseText, /jarvis-secret-piper|secret-voice-model|C:\\\\Users/i);
  } finally {
    if (server) await server.stop();
    else if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()));
    if (previousExecutable === undefined) delete process.env.JARVIS_PIPER_EXECUTABLE;
    else process.env.JARVIS_PIPER_EXECUTABLE = previousExecutable;
    if (previousModel === undefined) delete process.env.JARVIS_PIPER_MODEL;
    else process.env.JARVIS_PIPER_MODEL = previousModel;
    rmSync(dir, { recursive: true, force: true });
  }
});
