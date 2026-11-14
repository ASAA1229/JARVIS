import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceStatus, Permission, type DeviceRecord } from '../src/core/types.js';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.js';
import { SyncService } from '../src/sync/syncService.js';
import { SyncStateStore } from '../src/sync/syncStateStore.js';

/** JARVIS-GAP-013: cross-device queue replay, conflict, revocation and crash-recovery behavior. */
const TOKEN = 'sync-durability-owner-token-0123456789abcdef';

function env(options: { failOn?: (text: string) => boolean; delayMs?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sync-dur-'));
  const memory = new PersonalMemoryStore(join(dir, 'memory.enc'), TOKEN);
  const audit = new AuditLogger(join(dir, 'audit.log'));
  const devices = new Map<string, DeviceRecord>();
  const owner: DeviceRecord = { id: 'owner-phone', name: 'Owner', platform: 'Android', publicKey: 'pk', status: DeviceStatus.ACTIVE, permissions: [Permission.SYSTEM_INFO_READ, Permission.DEVICE_MANAGE], enrolledAt: 0 };
  const second: DeviceRecord = { ...owner, id: 'second-phone', name: 'Second' };
  devices.set(owner.id, owner); devices.set(second.id, second);
  const submitted: string[] = [];
  const build = () => new SyncService({
    store: new SyncStateStore(join(dir, 'sync.enc'), TOKEN),
    memory, audit,
    getDevice: (id) => devices.get(id),
    submitRequest: async (_session, text) => {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (options.failOn?.(text)) throw new Error('process killed');
      submitted.push(text);
      return { taskId: 'task-' + submitted.length, state: 'AWAITING_APPROVAL' };
    },
  });
  return { dir, memory, devices, owner, second, submitted, build, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const change = (seq: number, extra: Record<string, unknown>) => ({ changeId: 'chg' + String(seq).padStart(6, '0'), deviceSeq: seq, createdAt: Date.now(), ...extra });
const create = (seq: number, content: string) => change(seq, { op: 'memory.create', category: 'preference', content });

test('replayed batches are duplicates, sequence is monotonic, and the cursor survives a hub restart', async () => {
  const e = env();
  try {
    const hub1 = e.build();
    const first = await hub1.push(e.owner, 's', { changes: [create(1, 'Alpha pref'), create(2, 'Beta pref')] });
    assert.deepEqual(first.results.map((r) => r.outcome), ['pending_owner_approval', 'pending_owner_approval']);
    assert.equal(first.lastDeviceSeq, 2);

    const hub2 = e.build(); // restart: new service over the same encrypted state file
    const replay = await hub2.push(e.owner, 's', { changes: [create(1, 'Alpha pref'), create(2, 'Beta pref')] });
    assert.deepEqual(replay.results.map((r) => r.outcome), ['duplicate', 'duplicate']);
    // A forged lower sequence with a fresh change id is also refused (monotonic cursor).
    const lower = await hub2.push(e.owner, 's', { changes: [{ ...create(1, 'Different text'), changeId: 'fresh-id-000001' }] });
    assert.equal(lower.results[0].outcome, 'duplicate');
    // Out-of-order delivery inside one batch is processed in deviceSeq order.
    const mixed = await hub2.push(e.owner, 's', { changes: [create(4, 'Delta pref'), create(3, 'Gamma pref')] });
    assert.deepEqual(mixed.results.map((r) => r.changeId), ['chg000003', 'chg000004']);
    assert.equal(mixed.lastDeviceSeq, 4);
    assert.deepEqual(e.submitted, ['remember preference: Alpha pref', 'remember preference: Beta pref', 'remember preference: Gamma pref', 'remember preference: Delta pref']);
  } finally { e.cleanup(); }
});

test('crash in the middle of a batch: completed changes are checkpointed and never re-applied on retry', async () => {
  const e = env({ failOn: (text) => text.includes('Crash') });
  try {
    const hub = e.build();
    const batch = [create(1, 'Safe one'), create(2, 'Crash here'), create(3, 'Never reached')];
    await assert.rejects(hub.push(e.owner, 's', { changes: batch }), /process killed/);
    assert.deepEqual(e.submitted, ['remember preference: Safe one']);

    // Restart: a fresh hub instance over the same encrypted state file.
    const hub2 = new SyncService({
      store: new SyncStateStore(join(e.dir, 'sync.enc'), TOKEN), memory: e.memory,
      audit: new AuditLogger(join(e.dir, 'audit.log')), getDevice: (id) => e.devices.get(id),
      submitRequest: async (_s, text) => { e.submitted.push(text); return { taskId: 'task-r' + e.submitted.length, state: 'AWAITING_APPROVAL' }; },
    });
    const retry = await hub2.push(e.owner, 's', { changes: batch });
    assert.equal(retry.results[0].outcome, 'duplicate', 'the change that completed before the crash is not re-applied');
    assert.equal(retry.results[1].outcome, 'pending_owner_approval');
    assert.equal(retry.results[2].outcome, 'pending_owner_approval');
    assert.equal(e.submitted.filter((text) => text.includes('Safe one')).length, 1, 'exactly one approval task for the pre-crash change');
  } finally { e.cleanup(); }
});

test('two concurrent deliveries of the same batch create exactly one task per change', async () => {
  const e = env({ delayMs: 15 });
  try {
    const hub = e.build();
    const batch = [create(1, 'Concurrent one'), create(2, 'Concurrent two')];
    const [a, b] = await Promise.all([hub.push(e.owner, 's', { changes: batch }), hub.push(e.owner, 's', { changes: batch })]);
    const outcomes = [...a.results, ...b.results].map((r) => r.outcome).sort();
    assert.deepEqual(outcomes, ['duplicate', 'duplicate', 'pending_owner_approval', 'pending_owner_approval']);
    assert.equal(e.submitted.length, 2);
  } finally { e.cleanup(); }
});

test('offline command queue: owner decision runs a command exactly once, even under a race or replay', async () => {
  const e = env({ delayMs: 15 });
  try {
    const hub = e.build();
    await hub.push(e.second, 's', { changes: [change(1, { op: 'command.queue', text: 'launch notepad' })] });
    const queued = hub.overview().commands.find((c) => c.status === 'pending')!;
    assert.ok(queued);
    const settled = await Promise.allSettled([hub.decideCommand(e.owner, 'owner-session', queued.id, 'run'), hub.decideCommand(e.owner, 'owner-session', queued.id, 'run')]);
    assert.equal(settled.filter((s) => s.status === 'fulfilled').length, 1, 'only one racing decision wins');
    assert.equal(settled.filter((s) => s.status === 'rejected').length, 1);
    assert.deepEqual(e.submitted, ['launch notepad']);
    await assert.rejects(hub.decideCommand(e.owner, 'owner-session', queued.id, 'run'), /Pending command not found/);
    assert.equal(hub.overview().commands.length, 0, 'the command is no longer pending');
  } finally { e.cleanup(); }
});

test('a failed command submission restores the command to pending instead of losing or double-running it', async () => {
  let fail = true;
  const e = env({ failOn: () => fail });
  try {
    const hub = e.build();
    await hub.push(e.second, 's', { changes: [change(1, { op: 'command.queue', text: 'open settings' })] });
    const queued = hub.overview().commands[0];
    await assert.rejects(hub.decideCommand(e.owner, 'owner-session', queued.id, 'run'), /process killed/);
    assert.equal(hub.overview().commands[0].status, 'pending');
    fail = false;
    const ok = await hub.decideCommand(e.owner, 'owner-session', queued.id, 'run');
    assert.equal(ok.command.status, 'submitted');
    assert.deepEqual(e.submitted, ['open settings']);
  } finally { e.cleanup(); }
});

test('revoked devices cannot push, and their still-pending queued commands cannot be run afterwards', async () => {
  const e = env();
  try {
    const hub = e.build();
    await hub.push(e.second, 's', { changes: [change(1, { op: 'command.queue', text: 'delete everything' })] });
    const queued = hub.overview().commands[0];
    e.devices.set(e.second.id, { ...e.second, status: DeviceStatus.REVOKED, revokedAt: Date.now() });
    await assert.rejects(hub.push(e.devices.get(e.second.id)!, 's', { changes: [create(2, 'late change')] }), /revoked|not active/i);
    const after = hub.overview().commands.find((c) => c.id === queued.id);
    assert.ok(!after || after.status !== 'pending', 'revoked device commands are no longer runnable');
    await assert.rejects(hub.decideCommand(e.owner, 'owner-session', queued.id, 'run'), /not found/);
    assert.deepEqual(e.submitted, []);
  } finally { e.cleanup(); }
});

test('an update/update conflict from a stale base is stored for the owner and survives restart without overwriting', async () => {
  const e = env();
  try {
    const record = e.memory.save('preference', 'Original wording of the preference.');
    const hub = e.build();
    await new Promise((resolve) => setTimeout(resolve, 5));
    e.memory.update(record.id, 'Hub-side edit made while the phone was offline.');
    const result = await hub.push(e.owner, 's', { changes: [change(1, { op: 'memory.update', memoryId: record.id, baseUpdatedAt: record.updatedAt, content: 'Phone-side edit made offline.' })] });
    assert.equal(result.results[0].outcome, 'conflict');
    const reloaded = e.build().overview();
    assert.equal(reloaded.conflicts.filter((c) => c.status === 'open').length, 1);
    assert.match(e.memory.get(record.id)?.content ?? '', /Hub-side edit/, 'conflict never overwrites the hub copy');
  } finally { e.cleanup(); }
});

test('tampered or foreign-key sync state fails closed and is never silently replaced', () => {
  const e = env();
  try {
    const store = new SyncStateStore(join(e.dir, 'sync.enc'), TOKEN);
    store.save({ version: 1, cursors: [], conflicts: [], commands: [] });
    const original = readFileSync(join(e.dir, 'sync.enc'), 'utf8');
    assert.throws(() => new SyncStateStore(join(e.dir, 'sync.enc'), 'another-owner-token-0123456789abcdefghij').load(), /could not be decrypted/);
    writeFileSync(join(e.dir, 'sync.enc'), original.replace(/"tag":"(.)/, (_m, c: string) => `"tag":"${c === 'A' ? 'B' : 'A'}`));
    assert.throws(() => store.load(), /could not be decrypted/);
  } finally { e.cleanup(); }
});
