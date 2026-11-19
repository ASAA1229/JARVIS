import test, { afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceIdentityManager } from '../src/core/identity.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { Permission } from '../src/core/types.js';

/** JAR-E05/E08, US-001/US-003: device session security beyond the existing lifecycle tests. */
const realNow = Date.now.bind(Date);
let skew = 0;
afterEach(() => { mock.restoreAll(); skew = 0; });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-session-extra-'));
  const identity = new DeviceIdentityManager(new AuditLogger(join(dir, 'audit.log')), join(dir, 'devices.json'));
  const enroll = (name: string) => {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = identity.createEnrollmentChallenge([Permission.SYSTEM_INFO_READ]);
    const result = identity.enrollDevice(challenge.challengeToken, name, keys.publicKey);
    assert.equal(result.success, true);
    return { id: result.deviceId!, keys };
  };
  const login = (device: { id: string; keys: { privateKey: string } }, signWith = device.keys.privateKey, timestamp = Date.now(), ttl?: number) => {
    const nonce = CryptoUtil.randomToken(16);
    return identity.createSession(device.id, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, signWith), timestamp, nonce, ttl);
  };
  return { dir, identity, enroll, login, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('a session cannot be created with another device key, a future timestamp or a stale timestamp', () => {
  const s = setup();
  try {
    const a = s.enroll('A'); const b = s.enroll('B');
    assert.equal(s.login(a, b.keys.privateKey).success, false, 'signature from a different enrolled device is refused');
    assert.equal(s.login(a, a.keys.privateKey, Date.now() + 5 * 60_000).success, false, 'future timestamp');
    assert.equal(s.login(a, a.keys.privateKey, Date.now() - 5 * 60_000).success, false, 'stale timestamp');
    assert.equal(s.identity.createSession('device-that-does-not-exist', 'sig', Date.now(), CryptoUtil.randomToken(16)).success, false);
    assert.equal(s.login(a).success, true);
  } finally { s.cleanup(); }
});

test('session ids are high-entropy, unique, and garbage or hostile ids never validate', () => {
  const s = setup();
  try {
    const a = s.enroll('A');
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) { const session = s.login(a); assert.equal(session.success, true); ids.add(session.sessionId!); }
    assert.equal(ids.size, 25);
    for (const id of ids) assert.match(id, /^sess-[a-f0-9]{32,}$/);
    for (const hostile of ['', 'sess-', '__proto__', 'constructor', 'sess-' + 'f'.repeat(5000), '../x', 'null', undefined as unknown as string]) {
      assert.equal(s.identity.validateDeviceSession(hostile).valid, false, String(hostile).slice(0, 20));
    }
  } finally { s.cleanup(); }
});

test('sessions expire at their TTL and a custom short TTL is honored', () => {
  mock.method(Date, 'now', () => realNow() + skew);
  const s = setup();
  try {
    const a = s.enroll('A');
    const short = s.login(a, a.keys.privateKey, Date.now(), 30);
    const long = s.login(a, a.keys.privateKey, Date.now());
    assert.equal(s.identity.validateDeviceSession(short.sessionId!).valid, true);
    skew = 31_000;
    assert.equal(s.identity.validateDeviceSession(short.sessionId!).valid, false);
    assert.equal(s.identity.validateDeviceSession(long.sessionId!).valid, true);
    skew = 3601_000;
    assert.equal(s.identity.validateDeviceSession(long.sessionId!).valid, false);
    assert.equal(s.login(a, a.keys.privateKey, Date.now(), 86401).success, false, 'TTL above the cap is refused');
  } finally { s.cleanup(); }
});

test('revoking a device invalidates every live session at once, blocks new ones, and other devices are unaffected', () => {
  const s = setup();
  try {
    const a = s.enroll('A'); const b = s.enroll('B');
    const sessionsA = [s.login(a).sessionId!, s.login(a).sessionId!, s.login(a).sessionId!];
    const sessionB = s.login(b).sessionId!;
    assert.equal(s.identity.revokeDevice(a.id, 'lost phone'), true);
    for (const id of sessionsA) assert.equal(s.identity.validateDeviceSession(id).valid, false);
    assert.equal(s.login(a).success, false);
    assert.equal(s.identity.validateDeviceSession(sessionB).valid, true);
  } finally { s.cleanup(); }
});

test('revocation and enrolled devices survive a restart (persisted identity state fails closed)', () => {
  const s = setup();
  try {
    const a = s.enroll('A');
    s.identity.revokeDevice(a.id, 'compromised');
    const restarted = new DeviceIdentityManager(new AuditLogger(join(s.dir, 'audit2.log')), join(s.dir, 'devices.json'));
    const timestamp = Date.now(); const nonce = CryptoUtil.randomToken(16);
    const attempt = restarted.createSession(a.id, CryptoUtil.signData(`SESSION_REQUEST:${timestamp}:${nonce}`, a.keys.privateKey), timestamp, nonce);
    assert.equal(attempt.success, false);
    assert.match(attempt.error ?? '', /revoked/i);
  } finally { s.cleanup(); }
});
