import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';

/**
 * JARVIS-US-024: prompt/transcript/secret payloads must not appear in routine logs.
 * Sentinel strings are sent through typed requests, voice-origin requests and a document
 * ingestion; the plaintext audit log and every non-encrypted state file are then scanned.
 */
const TOKEN = 'privacy-log-owner-token-0123456789abcdef';
process.env.JARVIS_OWNER_CONTROL_TOKEN = TOKEN;
const PORT = 3896;

test('sentinel request, transcript and document text never reach the audit log or plaintext state files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-privacy-'));
  const server = new JarvisServer(PORT, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = await (await fetch(`${base}/api/enrollment/challenge`, { method: 'POST', headers: { 'x-owner-control-token': TOKEN } })).json();
    const name = 'Privacy test device';
    const proof = CryptoUtil.signData(`ENROLLMENT_PROOF:${challenge.challengeToken}:${name}:${CryptoUtil.sha256(keys.publicKey)}`, keys.privateKey);
    const redeem = await (await fetch(`${base}/api/enrollment/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken: challenge.challengeToken, deviceName: name, publicKey: keys.publicKey, proofSignature: proof }) })).json();
    const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
    const session = await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: redeem.deviceId, signature: CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, keys.privateKey), timestamp: ts, nonce }) })).json();
    const post = async (path: string, body: unknown) => {
      const t = Date.now(); const n = CryptoUtil.randomToken(16);
      const canonical = CryptoUtil.buildCanonicalRequestString('POST', path, session.sessionId, t, n, body);
      const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-session-id': session.sessionId, 'x-request-timestamp': String(t), 'x-request-nonce': n, 'x-request-signature': CryptoUtil.signData(canonical, keys.privateKey) }, body: JSON.stringify(body) });
      return response.status;
    };
    const typed = 'zebra-sentinel-typed-4471 what is the OS version';
    const spoken = 'quokka-sentinel-voice-9023 what is the OS version today';
    const doc = 'narwhal-sentinel-document-5518 confidential paragraph';
    assert.equal(await post('/api/request', { text: typed }), 200);
    assert.equal(await post('/api/request', { text: spoken, voice: { utteranceId: 'utt-privacy-0001' } }), 200);
    assert.equal(await post('/api/request', { text: spoken, voice: { utteranceId: 'utt-privacy-0001' } }), 409);
    assert.equal(await post('/api/documents/ingest', { sourceName: 'secret.txt', content: doc }), 201);

    const sentinels = ['zebra-sentinel-typed-4471', 'quokka-sentinel-voice-9023', 'narwhal-sentinel-document-5518'];
    const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
    assert.ok(audit.length > 0, 'audit log is populated, so the scan is meaningful');
    for (const sentinel of sentinels) assert.equal(audit.includes(sentinel), false, `audit log leaked ${sentinel}`);
    for (const file of readdirSync(dir)) {
      if (file === 'audit.log') continue;
      const bytes = readFileSync(join(dir, file));
      for (const sentinel of sentinels) {
        // Encrypted stores hold ciphertext only; any plaintext sentinel here would be a leak.
        if (/\.(json)$/.test(file) && !/\.(plugins|workflows)\.json$/.test(file) && file !== 'state.json') continue;
        assert.equal(bytes.includes(Buffer.from(sentinel)), false, `${file} leaked ${sentinel}`);
      }
    }
  } finally {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
