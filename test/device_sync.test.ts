// NOTE: authored during a development-only phase; not yet executed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceStatus, Permission, type DeviceRecord } from '../src/core/types.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.js';
import { createPeerEnvelope, verifyPeerEnvelope } from '../src/sync/peerEnvelope.js';
import { SyncService, syncCategoriesFor } from '../src/sync/syncService.js';
import { SyncStateStore } from '../src/sync/syncStateStore.js';

const TOKEN = 'device-sync-test-owner-token-0123456789abcdef';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sync-'));
  const memory = new PersonalMemoryStore(join(dir, 'memory.enc'), TOKEN);
  const audit = new AuditLogger(join(dir, 'audit.log'));
  const devices = new Map<string, DeviceRecord>();
  const phone: DeviceRecord = { id: 'phone-a', name: 'Phone A', platform: 'Android', publicKey: 'pk', status: DeviceStatus.ACTIVE, permissions: [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE], enrolledAt: 0 };
  const reader: DeviceRecord = { ...phone, id: 'phone-b', name: 'Phone B', permissions: [Permission.SYSTEM_INFO_READ] };
  devices.set(phone.id, phone);
  devices.set(reader.id, reader);
  const submitted: string[] = [];
  const sync = new SyncService({
    store: new SyncStateStore(join(dir, 'sync.enc'), TOKEN),
    memory,
    audit,
    getDevice: (id) => devices.get(id),
    submitRequest: async (_session, text) => { submitted.push(text); return { taskId: 'task-' + submitted.length, state: 'AWAITING_APPROVAL' }; },
  });
  return { dir, memory, sync, phone, reader, devices, submitted };
}

const change = (seq: number, extra: Record<string, unknown>) => ({ changeId: 'chg' + String(seq).padStart(6, '0'), deviceSeq: seq, createdAt: Date.now(), ...extra });

test('memory changes are submitted for owner approval, never applied directly', async () => {
  const { dir, sync, phone, submitted, memory } = setup();
  try {
    const result = await sync.push(phone, 's', { changes: [change(1, { op: 'memory.create', category: 'preference', content: 'Likes dark mode' })] });
    assert.equal(result.results[0]?.outcome, 'pending_owner_approval');
    assert.deepEqual(submitted, ['remember preference: Likes dark mode']);
    assert.equal(memory.list().length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stale base versions become conflicts; identical content is a no-op; replays are duplicates', async () => {
  const { dir, sync, phone, memory, submitted } = setup();
  try {
    const record = memory.save('project', 'Portfolio on Cloudflare');
    const stale = await sync.push(phone, 's', { changes: [
      change(1, { op: 'memory.update', memoryId: record.id, baseUpdatedAt: record.updatedAt - 1, content: 'Portfolio on Vercel' }),
      change(2, { op: 'memory.update', memoryId: record.id, baseUpdatedAt: record.updatedAt - 1, content: 'Portfolio on Cloudflare' }),
    ] });
    assert.deepEqual(stale.results.map((r) => r.outcome), ['conflict', 'no_op']);
    assert.equal(submitted.length, 0);
    const replay = await sync.push(phone, 's', { changes: [change(1, { op: 'memory.update', memoryId: record.id, baseUpdatedAt: record.updatedAt, content: 'x' })] });
    assert.equal(replay.results[0]?.outcome, 'duplicate');
    assert.equal(sync.overview().conflicts.length, 1);
    // Conflict text is stored encrypted.
    assert.equal(readFileSync(join(dir, 'sync.enc'), 'utf8').includes('Vercel'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('expired changes are rejected and devices without DEVICE_MANAGE cannot sync memory', async () => {
  const { dir, sync, phone, reader } = setup();
  try {
    const expired = await sync.push(phone, 's', { changes: [{ ...change(1, { op: 'memory.create', category: 'general', content: 'old' }), createdAt: Date.now() - 10_000, ttlSeconds: 1 }] });
    assert.equal(expired.results[0]?.outcome, 'rejected');
    assert.deepEqual(syncCategoriesFor(reader), []);
    const denied = await sync.push(reader, 's', { changes: [change(1, { op: 'memory.create', category: 'general', content: 'hi' })] });
    assert.equal(denied.results[0]?.outcome, 'rejected');
    assert.deepEqual(sync.pull(reader, '0').index, []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('offline commands wait for the owner and are discarded when their device is revoked', async () => {
  const { dir, sync, phone, devices, submitted } = setup();
  try {
    const pushed = await sync.push(phone, 's', { changes: [change(1, { op: 'command.queue', text: 'open notepad' })] });
    assert.equal(pushed.results[0]?.outcome, 'queued_for_owner');
    assert.equal(submitted.length, 0);
    assert.equal(sync.overview().commands.length, 1);
    devices.set(phone.id, { ...phone, status: DeviceStatus.REVOKED });
    assert.equal(sync.overview().commands.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('peer envelopes verify against enrolled keys and reject tampering and replay', () => {
  const sender = CryptoUtil.generateEd25519KeyPair();
  const envelope = createPeerEnvelope({ from: 'phone-a', to: 'phone-b', seq: 3, type: 'sync.changes', payload: { hello: 1 }, privateKeyPem: sender.privateKey });
  const peers = [{ deviceId: 'phone-a', publicKey: sender.publicKey, p2p: true }];
  assert.deepEqual(verifyPeerEnvelope(envelope, { recipientId: 'phone-b', peers }), { ok: true, payload: { hello: 1 } });
  assert.equal(verifyPeerEnvelope({ ...envelope, payload: Buffer.from('{"hello":2}').toString('base64') }, { recipientId: 'phone-b', peers }).ok, false);
  assert.deepEqual(verifyPeerEnvelope(envelope, { recipientId: 'phone-b', peers, lastSeqFromSender: 3 }), { ok: false, reason: 'replayed' });
  assert.deepEqual(verifyPeerEnvelope(envelope, { recipientId: 'phone-b', peers: [] }), { ok: false, reason: 'unknown_sender' });
});

test('sync rejects malformed batches and invalid change shapes without submitting commands', async () => {
  const { dir, sync, phone, submitted } = setup();
  try {
    await assert.rejects(
      () => sync.push(phone, 's', { changes: [] }),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 400,
    );
    const result = await sync.push(phone, 's', { changes: [
      { ...change(1, { op: 'memory.create', category: 'general', content: '   ' }) },
      { ...change(2, { op: 'command.queue', text: '   ' }) },
      { ...change(3, { op: 'memory.create', category: 'admin', content: 'not allowed' }) },
      { ...change(4, { op: 'shell.execute', command: 'whoami' }) },
    ] });
    assert.deepEqual(result.results.map((item) => item.outcome), ['rejected', 'rejected', 'rejected', 'rejected']);
    assert.equal(submitted.length, 0);
    assert.equal(sync.overview().commands.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sync rejects future-dated changes and does not execute them', async () => {
  const { dir, sync, phone, submitted } = setup();
  try {
    const result = await sync.push(phone, 's', { changes: [
      { ...change(1, { op: 'command.queue', text: 'open notepad' }), createdAt: Date.now() + 6 * 60_000 },
    ] });
    assert.equal(result.results[0]?.outcome, 'rejected');
    assert.match(result.results[0]?.reason ?? '', /future/i);
    assert.equal(sync.overview().commands.length, 0);
    assert.equal(submitted.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('revoked devices cannot push or pull synchronization data', async () => {
  const { dir, sync, phone, devices } = setup();
  try {
    devices.set(phone.id, { ...phone, status: DeviceStatus.REVOKED });
    await assert.rejects(
      () => sync.push(phone, 's', { changes: [change(1, { op: 'command.queue', text: 'open notepad' })] }),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 403,
    );
    assert.throws(() => sync.pull(phone, '0'), /revoked or unknown/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only device-management owners may resolve conflicts and malformed merge text is rejected', async () => {
  const { dir, sync, phone, reader, memory } = setup();
  try {
    const record = memory.save('project', 'Original');
    const pushed = await sync.push(phone, 's', { changes: [
      change(1, { op: 'memory.update', memoryId: record.id, baseUpdatedAt: record.updatedAt - 1, content: 'Phone edit' }),
    ] });
    const conflictId = pushed.results[0]?.conflictId;
    assert.ok(conflictId);
    await assert.rejects(
      () => sync.resolveConflict(reader, 'reader-session', conflictId, 'keep_hub', undefined),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 403,
    );
    await assert.rejects(
      () => sync.resolveConflict(phone, 'owner-session', conflictId, 'merge', '   '),
      (error: unknown) => error instanceof Error && 'status' in error && error.status === 400,
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
