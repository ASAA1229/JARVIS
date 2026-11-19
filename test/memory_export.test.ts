import assert from 'node:assert/strict';
import { freePort } from './helpers/freePort.js';
import { after, before, test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';

const PORT = await freePort();
let server: JarvisServer;
let dir: string;
const previousToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;

function enroll(permissions: Permission[]) {
  const service = server.getService();
  const keys = CryptoUtil.generateEd25519KeyPair();
  const challenge = service.identity.createEnrollmentChallenge(permissions);
  const enrolled = service.identity.enrollDevice(challenge.challengeToken, 'export-test', keys.publicKey);
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const session = service.identity.createSession(enrolled.deviceId!, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, keys.privateKey), timestamp, nonce);
  return { sessionId: session.sessionId!, privateKey: keys.privateKey };
}

function signedGet(path: string, who: { sessionId: string; privateKey: string }) {
  const timestamp = Date.now();
  const nonce = CryptoUtil.randomToken(16);
  const canonical = CryptoUtil.buildCanonicalRequestString('GET', path, who.sessionId, timestamp, nonce, undefined);
  return fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: {
      'x-session-id': who.sessionId,
      'x-request-timestamp': String(timestamp),
      'x-request-nonce': nonce,
      'x-request-signature': CryptoUtil.signData(canonical, who.privateKey),
    },
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'jarvis-memory-export-'));
  process.env.JARVIS_OWNER_CONTROL_TOKEN = 'memory-export-owner-token-0123456789abcdef';
  server = new JarvisServer(PORT, join(dir, 'audit.log'), join(dir, 'devices.json'));
  await server.start();
});

after(async () => {
  await server.stop();
  if (previousToken === undefined) delete process.env.JARVIS_OWNER_CONTROL_TOKEN;
  else process.env.JARVIS_OWNER_CONTROL_TOKEN = previousToken;
  rmSync(dir, { recursive: true, force: true });
});

test('owner device can export memories as a portable JSON download', async () => {
  const memory = server.getService().personalMemory!;
  memory.save('preference', 'Prefers dark mode in every editor');
  memory.save('project', 'Portfolio deploys on Cloudflare', 30);
  const owner = enroll([Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE]);

  const response = await signedGet('/api/memory/export', owner);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-disposition') ?? '', /attachment; filename="jarvis-memory-\d{4}-\d{2}-\d{2}\.json"/);
  const body = await response.json() as { format: string; version: number; records: Array<{ content: string; createdAt: string; expiresAt?: string }> };
  assert.equal(body.format, 'jarvis-personal-memory-export');
  assert.equal(body.version, 1);
  assert.deepEqual(body.records.map((record) => record.content).sort(), ['Portfolio deploys on Cloudflare', 'Prefers dark mode in every editor']);
  assert.ok(body.records.every((record) => !Number.isNaN(Date.parse(record.createdAt))));
  assert.equal(body.records.filter((record) => record.expiresAt).length, 1);

  // The audit trail records the export but never the memory text.
  const audit = readFileSync(join(dir, 'audit.log'), 'utf8');
  assert.match(audit, /PERSONAL_MEMORY_EXPORTED/);
  assert.equal(audit.includes('dark mode'), false);
});

test('devices without device-management permission cannot export', async () => {
  const reader = enroll([Permission.SYSTEM_INFO_READ]);
  const response = await signedGet('/api/memory/export', reader);
  assert.equal(response.status, 403);
});

test('unsigned export requests are rejected', async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/api/memory/export`);
  assert.equal(response.status, 401);
});
