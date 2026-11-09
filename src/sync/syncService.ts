/**
 * Laptop-hub synchronization engine (JARVIS-US-060 / US-027).
 *
 * Rules:
 * - Devices push offline changes with a monotonic per-device sequence and a
 *   bounded TTL; changes are revalidated on arrival (device active, permitted
 *   categories, size, age). Replays and duplicates are idempotent.
 * - Memory changes never bypass the policy gateway: each accepted change is
 *   submitted through the normal planner path and therefore needs the owner's
 *   fresh approval before it touches long-term memory.
 * - Concurrent edits are never resolved by silent last-writer-wins. A change
 *   whose base version no longer matches the hub becomes an owner-reviewable
 *   conflict. Only byte-identical content is auto-resolved (no-op).
 * - Offline-queued commands are held for the owner to run explicitly; they are
 *   never executed automatically on reconnect.
 * - Devices only sync memory categories their permissions allow.
 */
import { randomBytes } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import { DeviceStatus, Permission, type DeviceRecord } from '../core/types.js';
import type { MemoryCategory, PersonalMemory, PersonalMemoryStore } from '../memory/personalMemoryStore.js';
import type { SyncStateStore } from './syncStateStore.js';
import {
  DEFAULT_CHANGE_TTL_SECONDS, HUB_CAPABILITIES, MAX_CHANGE_CONTENT_CHARS, MAX_CHANGE_TTL_SECONDS, MAX_CHANGES_PER_PUSH,
  MAX_COMMAND_TEXT_CHARS, SYNC_PROTOCOL_VERSION,
  type ChangeResult, type DeviceCapability, type DeviceSyncCursor, type QueuedCommand, type SyncChange, type SyncConflict, type SyncStateFile,
} from './syncTypes.js';

const ALL_CATEGORIES: readonly MemoryCategory[] = ['preference', 'project', 'routine', 'general'];
const MEMORY_ID = /^[a-f0-9]{32}$/;
const CHANGE_ID = /^[A-Za-z0-9_-]{8,64}$/;
const RECENT_CHANGE_WINDOW = 500;
const MAX_OPEN_CONFLICTS = 200;
const MAX_PENDING_COMMANDS = 100;

export interface SubmitResult { taskId: string; state: string; approvalId?: string; message?: string }

export interface SyncServiceDeps {
  store: SyncStateStore;
  memory: PersonalMemoryStore;
  audit: AuditLogger;
  getDevice(id: string): DeviceRecord | undefined;
  /** Submit text through the authenticated planner/policy path as the given session. */
  submitRequest(sessionId: string, text: string): Promise<SubmitResult>;
  now?: () => number;
}

/** Memory categories a device may sync. Long-term memory is owner data: DEVICE_MANAGE only. */
export function syncCategoriesFor(device: Pick<DeviceRecord, 'permissions'>): MemoryCategory[] {
  return device.permissions.includes(Permission.DEVICE_MANAGE) ? [...ALL_CATEGORIES] : [];
}

export class SyncError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export class SyncService {
  private readonly now: () => number;

  constructor(private readonly deps: SyncServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  private cursorFor(state: SyncStateFile, deviceId: string): DeviceSyncCursor {
    let cursor = state.cursors.find((item) => item.deviceId === deviceId);
    if (!cursor) {
      cursor = { deviceId, lastDeviceSeq: 0, capabilities: ['hub-sync'], recentChangeIds: [] };
      state.cursors.push(cursor);
    }
    return cursor;
  }

  private assertActive(device: DeviceRecord): void {
    const current = this.deps.getDevice(device.id);
    if (!current || current.status === DeviceStatus.REVOKED) throw new SyncError(403, 'Device is revoked or unknown.');
  }

  /** Capability negotiation: the device declares what it supports; the hub answers with the intersection. */
  negotiate(device: DeviceRecord, requested: unknown): { protocolVersion: number; capabilities: DeviceCapability[] } {
    this.assertActive(device);
    const asked = Array.isArray(requested) ? requested.filter((item): item is DeviceCapability => HUB_CAPABILITIES.includes(item as DeviceCapability)) : [];
    const capabilities = [...new Set<DeviceCapability>(['hub-sync', ...asked])];
    const state = this.deps.store.load();
    this.cursorFor(state, device.id).capabilities = capabilities;
    this.deps.store.save(state);
    this.deps.audit.record('SYNC_CAPABILITIES_NEGOTIATED', { capabilities }, device.id);
    return { protocolVersion: SYNC_PROTOCOL_VERSION, capabilities };
  }

  private validateChange(raw: unknown): SyncChange {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Change must be an object.');
    const change = raw as Record<string, unknown>;
    if (typeof change['changeId'] !== 'string' || !CHANGE_ID.test(change['changeId'])) throw new Error('Invalid changeId.');
    if (!Number.isSafeInteger(change['deviceSeq']) || (change['deviceSeq'] as number) < 1) throw new Error('Invalid deviceSeq.');
    if (!Number.isSafeInteger(change['createdAt'])) throw new Error('Invalid createdAt.');
    const ttl = change['ttlSeconds'];
    if (ttl !== undefined && (!Number.isSafeInteger(ttl) || (ttl as number) < 1 || (ttl as number) > MAX_CHANGE_TTL_SECONDS)) throw new Error('Invalid ttlSeconds.');
    const op = change['op'];
    const text = (key: string, max: number) => {
      const value = change[key];
      if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${key}.`);
      return value;
    };
    const memoryId = () => {
      const value = change['memoryId'];
      if (typeof value !== 'string' || !MEMORY_ID.test(value)) throw new Error('Invalid memoryId.');
      return value;
    };
    const base = () => {
      const value = change['baseUpdatedAt'];
      if (!Number.isSafeInteger(value)) throw new Error('Invalid baseUpdatedAt.');
      return value as number;
    };
    const common = { changeId: change['changeId'], deviceSeq: change['deviceSeq'] as number, createdAt: change['createdAt'] as number, ...(ttl !== undefined ? { ttlSeconds: ttl as number } : {}) };
    switch (op) {
      case 'memory.create': {
        const category = change['category'];
        if (!ALL_CATEGORIES.includes(category as MemoryCategory)) throw new Error('Invalid category.');
        return { ...common, op, category: category as MemoryCategory, content: text('content', MAX_CHANGE_CONTENT_CHARS) };
      }
      case 'memory.update':
        return { ...common, op, memoryId: memoryId(), baseUpdatedAt: base(), content: text('content', MAX_CHANGE_CONTENT_CHARS) };
      case 'memory.delete':
        return { ...common, op, memoryId: memoryId(), baseUpdatedAt: base() };
      case 'command.queue':
        return { ...common, op, text: text('text', MAX_COMMAND_TEXT_CHARS) };
      default:
        throw new Error('Unsupported op.');
    }
  }

  /**
   * Apply a batch of offline changes from one device. Changes are processed in
   * deviceSeq order; each gets an individual outcome.
   */
  async push(device: DeviceRecord, sessionId: string, body: unknown): Promise<{ results: ChangeResult[]; lastDeviceSeq: number }> {
    this.assertActive(device);
    const changes = (body as { changes?: unknown })?.changes;
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES_PER_PUSH) {
      throw new SyncError(400, `changes must be an array of 1-${MAX_CHANGES_PER_PUSH} items.`);
    }
    const state = this.deps.store.load();
    const cursor = this.cursorFor(state, device.id);
    const allowed = syncCategoriesFor(device);
    const now = this.now();
    const results: ChangeResult[] = [];
    const parsed: SyncChange[] = [];
    for (const raw of changes) {
      try {
        parsed.push(this.validateChange(raw));
      } catch (error) {
        const changeId = typeof (raw as { changeId?: unknown })?.changeId === 'string' ? String((raw as { changeId: string }).changeId).slice(0, 64) : 'invalid';
        results.push({ changeId, outcome: 'rejected', reason: error instanceof Error ? error.message : 'Invalid change.' });
      }
    }
    parsed.sort((a, b) => a.deviceSeq - b.deviceSeq);

    for (const change of parsed) {
      if (cursor.recentChangeIds.includes(change.changeId) || change.deviceSeq <= cursor.lastDeviceSeq) {
        results.push({ changeId: change.changeId, outcome: 'duplicate' });
        continue;
      }
      const ttlMs = (change.ttlSeconds ?? DEFAULT_CHANGE_TTL_SECONDS) * 1000;
      if (change.createdAt > now + 5 * 60_000) {
        results.push({ changeId: change.changeId, outcome: 'rejected', reason: 'createdAt is in the future.' });
      } else if (change.createdAt + ttlMs <= now) {
        results.push({ changeId: change.changeId, outcome: 'rejected', reason: 'Change expired before it reached the hub.' });
      } else {
        results.push(await this.applyChange(state, device, sessionId, change, allowed, now));
      }
      cursor.lastDeviceSeq = Math.max(cursor.lastDeviceSeq, change.deviceSeq);
      cursor.recentChangeIds.push(change.changeId);
      if (cursor.recentChangeIds.length > RECENT_CHANGE_WINDOW) cursor.recentChangeIds.splice(0, cursor.recentChangeIds.length - RECENT_CHANGE_WINDOW);
    }
    cursor.lastPushAt = now;
    this.deps.store.save(state);
    const counts: Record<string, number> = {};
    for (const result of results) counts[result.outcome] = (counts[result.outcome] ?? 0) + 1;
    this.deps.audit.record('SYNC_PUSH', { received: changes.length, outcomes: counts, lastDeviceSeq: cursor.lastDeviceSeq }, device.id);
    return { results, lastDeviceSeq: cursor.lastDeviceSeq };
  }

  private findMemory(id: string): PersonalMemory | undefined {
    return this.deps.memory.list().find((record) => record.id === id);
  }

  private openConflict(state: SyncStateFile, conflict: Omit<SyncConflict, 'id' | 'status' | 'detectedAt'>): SyncConflict {
    const open = state.conflicts.filter((item) => item.status === 'open');
    if (open.length >= MAX_OPEN_CONFLICTS) throw new SyncError(409, 'Too many unresolved sync conflicts; resolve some first.');
    // Keep resolved history bounded.
    if (state.conflicts.length > MAX_OPEN_CONFLICTS * 2) {
      state.conflicts = state.conflicts.filter((item) => item.status === 'open').concat(state.conflicts.filter((item) => item.status !== 'open').slice(-MAX_OPEN_CONFLICTS));
    }
    const record: SyncConflict = { ...conflict, id: 'cfl-' + randomBytes(10).toString('hex'), status: 'open', detectedAt: this.now() };
    state.conflicts.push(record);
    return record;
  }

  private async submit(sessionId: string, text: string, change: SyncChange): Promise<ChangeResult> {
    const result = await this.deps.submitRequest(sessionId, text);
    return {
      changeId: change.changeId,
      outcome: 'pending_owner_approval',
      taskId: result.taskId,
      reason: result.state === 'AWAITING_APPROVAL' ? 'Awaiting owner approval.' : `Task state ${result.state}.`,
    };
  }

  private async applyChange(state: SyncStateFile, device: DeviceRecord, sessionId: string, change: SyncChange, allowed: MemoryCategory[], now: number): Promise<ChangeResult> {
    if (change.op === 'command.queue') {
      const pending = state.commands.filter((item) => item.status === 'pending');
      if (pending.length >= MAX_PENDING_COMMANDS) return { changeId: change.changeId, outcome: 'rejected', reason: 'Too many queued commands awaiting the owner.' };
      const ttlMs = (change.ttlSeconds ?? DEFAULT_CHANGE_TTL_SECONDS) * 1000;
      state.commands.push({
        id: 'cmd-' + randomBytes(10).toString('hex'),
        deviceId: device.id,
        text: change.text.trim(),
        createdAt: change.createdAt,
        receivedAt: now,
        expiresAt: change.createdAt + ttlMs,
        status: 'pending',
      });
      return { changeId: change.changeId, outcome: 'queued_for_owner', reason: 'Held for the owner to run explicitly; offline commands never execute automatically.' };
    }

    if (change.op === 'memory.create') {
      if (!allowed.includes(change.category)) return { changeId: change.changeId, outcome: 'rejected', reason: 'This device may not sync that memory category.' };
      const existing = this.deps.memory.list().find((record) => record.content === change.content.trim() && record.category === change.category);
      if (existing) return { changeId: change.changeId, outcome: 'no_op', reason: 'Identical memory already exists.' };
      return this.submit(sessionId, `remember ${change.category}: ${change.content.trim()}`, change);
    }

    const hub = this.findMemory(change.memoryId);
    if (hub && !allowed.includes(hub.category)) return { changeId: change.changeId, outcome: 'rejected', reason: 'This device may not sync that memory category.' };
    if (!allowed.length) return { changeId: change.changeId, outcome: 'rejected', reason: 'This device may not sync memory.' };

    if (change.op === 'memory.update') {
      if (!hub) {
        const conflict = this.openConflict(state, {
          memoryId: change.memoryId, category: 'general', kind: 'deleted_on_hub', hubContent: '', hubUpdatedAt: null,
          deviceContent: change.content.trim(), deviceId: device.id, deviceBaseUpdatedAt: change.baseUpdatedAt,
        });
        return { changeId: change.changeId, outcome: 'conflict', conflictId: conflict.id, reason: 'The memory was deleted on the hub.' };
      }
      if (hub.content === change.content.trim()) return { changeId: change.changeId, outcome: 'no_op', reason: 'Content already identical.' };
      if (hub.updatedAt !== change.baseUpdatedAt) {
        const conflict = this.openConflict(state, {
          memoryId: hub.id, category: hub.category, kind: 'concurrent_update', hubContent: hub.content, hubUpdatedAt: hub.updatedAt,
          deviceContent: change.content.trim(), deviceId: device.id, deviceBaseUpdatedAt: change.baseUpdatedAt,
        });
        return { changeId: change.changeId, outcome: 'conflict', conflictId: conflict.id, reason: 'The hub copy changed since this device last synced.' };
      }
      return this.submit(sessionId, `update memory ${hub.id} to ${change.content.trim()}`, change);
    }

    // memory.delete
    if (!hub) return { changeId: change.changeId, outcome: 'no_op', reason: 'Already deleted on the hub.' };
    if (hub.updatedAt !== change.baseUpdatedAt) {
      const conflict = this.openConflict(state, {
        memoryId: hub.id, category: hub.category, kind: 'update_vs_delete', hubContent: hub.content, hubUpdatedAt: hub.updatedAt,
        deviceContent: '', deviceId: device.id, deviceBaseUpdatedAt: change.baseUpdatedAt,
      });
      return { changeId: change.changeId, outcome: 'conflict', conflictId: conflict.id, reason: 'The hub copy changed after this device deleted it.' };
    }
    return this.submit(sessionId, `forget memory ${hub.id}`, change);
  }

  /**
   * Pull: a snapshot of permitted memory ids/versions (deletions are ids that
   * disappeared), full content only for records changed since the cursor, and
   * this device's open conflicts. No other device's identity data is returned.
   */
  pull(device: DeviceRecord, sinceRaw: string | null): {
    protocolVersion: number; serverTime: number;
    index: Array<{ id: string; category: MemoryCategory; updatedAt: number }>;
    changed: Array<Pick<PersonalMemory, 'id' | 'category' | 'content' | 'createdAt' | 'updatedAt' | 'expiresAt'>>;
    conflicts: Array<Pick<SyncConflict, 'id' | 'memoryId' | 'kind' | 'detectedAt'>>;
  } {
    this.assertActive(device);
    const since = sinceRaw && /^\d{1,16}$/.test(sinceRaw) ? Number(sinceRaw) : 0;
    const allowed = new Set(syncCategoriesFor(device));
    const records = this.deps.memory.list().filter((record) => allowed.has(record.category));
    const serverTime = this.now();
    const state = this.deps.store.load();
    const cursor = this.cursorFor(state, device.id);
    cursor.lastPullAt = serverTime;
    this.deps.store.save(state);
    const changed = records.filter((record) => record.updatedAt > since).slice(0, 500)
      .map(({ id, category, content, createdAt, updatedAt, expiresAt }) => ({ id, category, content, createdAt, updatedAt, ...(expiresAt !== undefined ? { expiresAt } : {}) }));
    this.deps.audit.record('SYNC_PULL', { indexCount: records.length, changedCount: changed.length }, device.id);
    return {
      protocolVersion: SYNC_PROTOCOL_VERSION,
      serverTime,
      index: records.map((record) => ({ id: record.id, category: record.category, updatedAt: record.updatedAt })),
      changed,
      conflicts: state.conflicts.filter((item) => item.status === 'open' && item.deviceId === device.id)
        .map(({ id, memoryId, kind, detectedAt }) => ({ id, memoryId, kind, detectedAt })),
    };
  }

  /** Discard pending work from revoked devices and expire stale queued commands (audited). */
  private sweep(state: SyncStateFile): boolean {
    let changed = false;
    const now = this.now();
    for (const command of state.commands) {
      if (command.status !== 'pending') continue;
      const owner = this.deps.getDevice(command.deviceId);
      if (!owner || owner.status === DeviceStatus.REVOKED) {
        command.status = 'discarded';
        command.decidedAt = now;
        command.text = '[discarded: device revoked]';
        this.deps.audit.record('SYNC_COMMAND_DISCARDED_REVOKED', { commandId: command.id }, command.deviceId);
        changed = true;
      } else if (command.expiresAt <= now) {
        command.status = 'expired';
        command.decidedAt = now;
        changed = true;
      }
    }
    for (const conflict of state.conflicts) {
      if (conflict.status !== 'open') continue;
      const owner = this.deps.getDevice(conflict.deviceId);
      if (!owner || owner.status === DeviceStatus.REVOKED) {
        conflict.status = 'resolved';
        conflict.resolution = 'keep_hub';
        conflict.resolvedAt = now;
        conflict.resolvedBy = 'system:device-revoked';
        conflict.deviceContent = '';
        this.deps.audit.record('SYNC_CONFLICT_DISCARDED_REVOKED', { conflictId: conflict.id }, conflict.deviceId);
        changed = true;
      }
    }
    return changed;
  }

  overview(): {
    devices: Array<{ deviceId: string; name: string; platform?: string; status: string; capabilities: DeviceCapability[]; lastPushAt?: number; lastPullAt?: number; lastDeviceSeq: number }>;
    conflicts: SyncConflict[];
    commands: QueuedCommand[];
  } {
    const state = this.deps.store.load();
    if (this.sweep(state)) this.deps.store.save(state);
    return {
      devices: state.cursors.map((cursor) => {
        const device = this.deps.getDevice(cursor.deviceId);
        return {
          deviceId: cursor.deviceId,
          name: device?.name ?? 'unknown device',
          ...(device?.platform ? { platform: device.platform } : {}),
          status: device?.status ?? 'UNKNOWN',
          capabilities: cursor.capabilities,
          ...(cursor.lastPushAt ? { lastPushAt: cursor.lastPushAt } : {}),
          ...(cursor.lastPullAt ? { lastPullAt: cursor.lastPullAt } : {}),
          lastDeviceSeq: cursor.lastDeviceSeq,
        };
      }),
      conflicts: state.conflicts.filter((item) => item.status === 'open'),
      commands: state.commands.filter((item) => item.status === 'pending'),
    };
  }

  /**
   * Owner resolves a conflict. keep_hub closes it; keep_device / merge submit the
   * chosen text through the planner, so the change still needs approval.
   */
  async resolveConflict(resolver: DeviceRecord, resolverSessionId: string, id: unknown, resolution: unknown, merged: unknown): Promise<{ conflict: SyncConflict; taskId?: string }> {
    if (!resolver.permissions.includes(Permission.DEVICE_MANAGE)) throw new SyncError(403, 'Resolving sync conflicts requires device-management permission.');
    if (!['keep_hub', 'keep_device', 'merge'].includes(String(resolution))) throw new SyncError(400, 'resolution must be keep_hub, keep_device or merge.');
    const state = this.deps.store.load();
    this.sweep(state);
    const conflict = state.conflicts.find((item) => item.id === id && item.status === 'open');
    if (!conflict) throw new SyncError(404, 'Open conflict not found.');
    let text: string | undefined;
    if (resolution === 'merge') {
      if (typeof merged !== 'string' || !merged.trim() || merged.length > MAX_CHANGE_CONTENT_CHARS) throw new SyncError(400, 'merge requires mergedContent.');
      text = merged.trim();
    } else if (resolution === 'keep_device') {
      text = conflict.deviceContent;
    }
    let taskId: string | undefined;
    if (text !== undefined) {
      const hub = this.findMemory(conflict.memoryId);
      const request = !text
        ? (hub ? `forget memory ${hub.id}` : undefined)
        : hub ? `update memory ${hub.id} to ${text}` : `remember ${conflict.category}: ${text}`;
      if (request) taskId = (await this.deps.submitRequest(resolverSessionId, request)).taskId;
    }
    conflict.status = 'resolved';
    conflict.resolution = resolution as SyncConflict['resolution'];
    conflict.resolvedAt = this.now();
    conflict.resolvedBy = resolver.id;
    // Resolved conflicts keep no copies of owner text.
    conflict.hubContent = '';
    conflict.deviceContent = '';
    this.deps.store.save(state);
    this.deps.audit.record('SYNC_CONFLICT_RESOLVED', { conflictId: conflict.id, resolution, taskId }, resolver.id);
    return { conflict: { ...conflict }, ...(taskId ? { taskId } : {}) };
  }

  /** Owner explicitly runs or discards an offline-queued command. Running goes through policy/approval. */
  async decideCommand(resolver: DeviceRecord, resolverSessionId: string, id: unknown, decision: unknown): Promise<{ command: QueuedCommand; taskId?: string; state?: string }> {
    if (!resolver.permissions.includes(Permission.DEVICE_MANAGE)) throw new SyncError(403, 'Deciding queued commands requires device-management permission.');
    if (decision !== 'run' && decision !== 'discard') throw new SyncError(400, 'decision must be run or discard.');
    const state = this.deps.store.load();
    this.sweep(state);
    const command = state.commands.find((item) => item.id === id && item.status === 'pending');
    if (!command) {
      this.deps.store.save(state);
      throw new SyncError(404, 'Pending command not found (it may have expired or its device was revoked).');
    }
    let result: SubmitResult | undefined;
    if (decision === 'run') {
      result = await this.deps.submitRequest(resolverSessionId, command.text);
      command.status = 'submitted';
      command.taskId = result.taskId;
    } else {
      command.status = 'discarded';
    }
    command.decidedAt = this.now();
    command.decidedBy = resolver.id;
    command.text = command.status === 'discarded' ? '[discarded]' : command.text;
    this.deps.store.save(state);
    this.deps.audit.record('SYNC_COMMAND_DECIDED', { commandId: command.id, decision, taskId: result?.taskId }, resolver.id);
    return { command: { ...command }, ...(result ? { taskId: result.taskId, state: result.state } : {}) };
  }
}
