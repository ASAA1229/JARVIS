/**
 * Shared types for hub-based device synchronization (JARVIS-US-060 / US-027).
 * See docs/DEVICE_SYNC.md for the protocol.
 */
import type { MemoryCategory } from '../memory/personalMemoryStore.js';

export const SYNC_PROTOCOL_VERSION = 1;
export const MAX_CHANGES_PER_PUSH = 50;
export const MAX_CHANGE_CONTENT_CHARS = 4000;
export const MAX_COMMAND_TEXT_CHARS = 4000;
/** Offline changes older than this are discarded on arrival. */
export const MAX_CHANGE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_CHANGE_TTL_SECONDS = 24 * 60 * 60;

export type DeviceCapability = 'hub-sync' | 'offline-queue' | 'p2p-envelope';
export const HUB_CAPABILITIES: readonly DeviceCapability[] = ['hub-sync', 'offline-queue', 'p2p-envelope'];

export type SyncChange =
  | { changeId: string; deviceSeq: number; op: 'memory.create'; category: MemoryCategory; content: string; createdAt: number; ttlSeconds?: number }
  | { changeId: string; deviceSeq: number; op: 'memory.update'; memoryId: string; baseUpdatedAt: number; content: string; createdAt: number; ttlSeconds?: number }
  | { changeId: string; deviceSeq: number; op: 'memory.delete'; memoryId: string; baseUpdatedAt: number; createdAt: number; ttlSeconds?: number }
  | { changeId: string; deviceSeq: number; op: 'command.queue'; text: string; createdAt: number; ttlSeconds?: number };

export type ChangeOutcome =
  | 'pending_owner_approval' // submitted through planner/policy; an approval card was created
  | 'queued_for_owner'       // offline command held until the owner explicitly runs it
  | 'no_op'                  // identical content: deterministic auto-resolution
  | 'conflict'               // stored for owner review; nothing overwritten
  | 'duplicate'              // changeId/deviceSeq already processed
  | 'rejected';              // expired, malformed, not permitted

export interface ChangeResult {
  changeId: string;
  outcome: ChangeOutcome;
  reason?: string;
  conflictId?: string;
  taskId?: string;
}

export interface SyncConflict {
  id: string;
  memoryId: string;
  category: MemoryCategory;
  kind: 'concurrent_update' | 'deleted_on_hub' | 'update_vs_delete';
  /** Hub copy at detection time ('' when the hub copy was deleted). */
  hubContent: string;
  hubUpdatedAt: number | null;
  /** Incoming device copy ('' for a delete). */
  deviceContent: string;
  deviceId: string;
  deviceBaseUpdatedAt: number;
  detectedAt: number;
  status: 'open' | 'resolved';
  resolution?: 'keep_hub' | 'keep_device' | 'merge';
  resolvedAt?: number;
  resolvedBy?: string;
}

export interface QueuedCommand {
  id: string;
  deviceId: string;
  text: string;
  createdAt: number;
  receivedAt: number;
  expiresAt: number;
  status: 'pending' | 'submitted' | 'discarded' | 'expired';
  decidedAt?: number;
  decidedBy?: string;
  taskId?: string;
}

export interface DeviceSyncCursor {
  deviceId: string;
  lastDeviceSeq: number;
  lastPushAt?: number;
  lastPullAt?: number;
  capabilities: DeviceCapability[];
  /** Bounded window of recently processed change ids (idempotency). */
  recentChangeIds: string[];
}

export interface SyncStateFile {
  version: 1;
  cursors: DeviceSyncCursor[];
  conflicts: SyncConflict[];
  commands: QueuedCommand[];
}
