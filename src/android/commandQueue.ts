import { randomUUID } from 'node:crypto';
import { isPaymentTarget } from '../policy/exclusions.js';
import { lifecycleFromAndroidState, type CommandLifecycleState } from '../core/commandLifecycle.js';

export interface AndroidInventoryApp {
  label: string;
  packageName: string;
}

export type AndroidInventoryCommandState = 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'EXPIRED' | 'CANCELLED';

export interface AndroidInventoryCommand {
  id: string;
  operation: 'android.app.list';
  targetDeviceId: string;
  requesterDeviceId: string;
  createdAt: number;
  expiresAt: number;
  state: AndroidInventoryCommandState;
  claimedAt?: number;
  completedAt?: number;
  cancelledAt?: number;
  /** Why a command ended without completing (never contains device data). */
  cancelReason?: 'requester_cancelled' | 'device_revoked' | 'revalidation_failed';
  apps?: AndroidInventoryApp[];
}

/** Called after every state change (including expiry), so the event bus mirrors the queue exactly. */
export type AndroidCommandTransitionListener = (command: Readonly<AndroidInventoryCommand>, lifecycle: CommandLifecycleState) => void;

export type AndroidCompletionResult = 'completed' | 'duplicate' | 'expired' | 'cancelled' | 'not_found' | 'invalid';
export type AndroidCancelResult = 'cancelled' | 'already_cancelled' | 'not_cancellable' | 'not_found';

/**
 * Re-checks, at claim and completion time, that the requester and target are still
 * active and permitted. A phone that reconnects later can never act on work whose
 * authorization lapsed while it was offline.
 */
export type AndroidCommandAuthorization = (command: Readonly<AndroidInventoryCommand>) => boolean;

/**
 * In-memory, bounded, expiring command channel. It intentionally supports only
 * read-only app inventory: state-changing phone actions are never queued for later
 * delivery and must be requested and approved live. Restart drops pending commands
 * rather than replaying them, and queued work is revalidated at claim and completion.
 */
export class AndroidCommandQueue {
  private readonly commands = new Map<string, AndroidInventoryCommand>();
  private readonly maxCommands = 200;
  private readonly maxAppsPerCommand = 300;
  private readonly retentionMs = 10 * 60_000;

  constructor(private readonly onTransition?: AndroidCommandTransitionListener) {}

  private notify(command: AndroidInventoryCommand): void {
    if (!this.onTransition) return;
    try { this.onTransition({ ...command }, lifecycleFromAndroidState(command.state)); } catch { /* observers never affect the queue */ }
  }

  create(targetDeviceId: string, requesterDeviceId: string, ttlMs = 60_000): AndroidInventoryCommand {
    this.prune();
    if (this.commands.size >= this.maxCommands) throw new Error('Android command queue is full');
    if (!this.isDeviceId(targetDeviceId) || !this.isDeviceId(requesterDeviceId) ||
        targetDeviceId === requesterDeviceId) {
      throw new Error('Android command target and requester must be distinct valid devices');
    }
    const requestedTtl = Number.isFinite(ttlMs) ? Math.trunc(ttlMs) : 60_000;
    const now = Date.now();
    const command: AndroidInventoryCommand = {
      id: randomUUID(), operation: 'android.app.list', targetDeviceId, requesterDeviceId,
      createdAt: now, expiresAt: now + Math.min(Math.max(requestedTtl, 1000), 60_000), state: 'PENDING',
    };
    this.commands.set(command.id, command);
    this.notify(command);
    return { ...command };
  }

  claimNext(targetDeviceId: string, isAuthorized?: AndroidCommandAuthorization): AndroidInventoryCommand | undefined {
    this.prune();
    if (!this.isDeviceId(targetDeviceId)) return undefined;
    for (const command of this.commands.values()) {
      if (command.targetDeviceId !== targetDeviceId || command.state !== 'PENDING') continue;
      // Revalidate queued work before handing it to a (possibly long-offline) phone.
      if (isAuthorized && !isAuthorized(command)) {
        this.markCancelled(command, 'revalidation_failed');
        continue;
      }
      command.state = 'CLAIMED';
      command.claimedAt = Date.now();
      this.notify(command);
      return { ...command };
    }
    return undefined;
  }

  /** Backwards-compatible boolean form: true only for the first successful completion. */
  complete(targetDeviceId: string, commandId: string, apps: AndroidInventoryApp[], isAuthorized?: AndroidCommandAuthorization): boolean {
    return this.completeDetailed(targetDeviceId, commandId, apps, isAuthorized) === 'completed';
  }

  /**
   * Idempotent completion: a repeated result for an already-completed command from
   * the same phone is reported as a duplicate and never overwrites the stored result.
   */
  completeDetailed(targetDeviceId: string, commandId: string, apps: AndroidInventoryApp[], isAuthorized?: AndroidCommandAuthorization): AndroidCompletionResult {
    this.prune();
    const command = this.commands.get(commandId);
    if (!command || !this.isDeviceId(targetDeviceId) || command.targetDeviceId !== targetDeviceId) return 'not_found';
    if (command.state === 'COMPLETED') return 'duplicate';
    if (command.state === 'EXPIRED') return 'expired';
    if (command.state === 'CANCELLED') return 'cancelled';
    if (command.state !== 'CLAIMED') return 'invalid';
    if (Date.now() >= command.expiresAt) {
      command.state = 'EXPIRED';
      delete command.apps;
      this.notify(command);
      return 'expired';
    }
    // Reject malformed entries instead of storing partial or attacker-shaped inventory.
    if (!Array.isArray(apps) || apps.length > this.maxAppsPerCommand || apps.some((app) => !this.isValidApp(app))) return 'invalid';
    if (isAuthorized && !isAuthorized(command)) {
      this.markCancelled(command, 'revalidation_failed');
      return 'cancelled';
    }
    // Payment and financial apps are never retained, even if a client sends them.
    command.apps = apps
      .filter(({ label, packageName }) => !isPaymentTarget(label) && !isPaymentTarget(packageName))
      .map(({ label, packageName }) => ({
        label: label.trim().slice(0, 120),
        packageName: packageName.trim().slice(0, 240),
      }));
    command.state = 'COMPLETED';
    command.completedAt = Date.now();
    this.notify(command);
    return 'completed';
  }

  /** Requester cancellation; cancelling an already-cancelled command is a no-op success. */
  cancel(requesterDeviceId: string, commandId: string): AndroidCancelResult {
    this.prune();
    const command = this.commands.get(commandId);
    if (!command || !this.isDeviceId(requesterDeviceId) || command.requesterDeviceId !== requesterDeviceId) return 'not_found';
    if (command.state === 'CANCELLED') return 'already_cancelled';
    if (command.state !== 'PENDING' && command.state !== 'CLAIMED') return 'not_cancellable';
    this.markCancelled(command, 'requester_cancelled');
    return 'cancelled';
  }

  /** Expire overdue commands (and drop old terminal ones); called periodically by the server. */
  sweep(): void { this.prune(); }

  /** Cancel every queued or in-flight command requested by one device, or by all devices (stop). */
  cancelForStop(requesterDeviceId?: string): number {
    this.prune();
    let cancelled = 0;
    for (const command of this.commands.values()) {
      if (requesterDeviceId !== undefined && command.requesterDeviceId !== requesterDeviceId) continue;
      if (command.state === 'PENDING' || command.state === 'CLAIMED') {
        this.markCancelled(command, 'requester_cancelled');
        cancelled++;
      }
    }
    return cancelled;
  }

  /** Cancel work involving a revoked device, whether it requested or was targeted by it. */
  cancelForDevice(deviceId: string): number {
    this.prune();
    if (!this.isDeviceId(deviceId)) return 0;
    let cancelled = 0;
    for (const command of this.commands.values()) {
      if ((command.targetDeviceId === deviceId || command.requesterDeviceId === deviceId) &&
          (command.state === 'PENDING' || command.state === 'CLAIMED')) {
        this.markCancelled(command, 'device_revoked');
        cancelled++;
      }
    }
    return cancelled;
  }

  resultsForRequester(requesterDeviceId: string): Array<{
    id: string; targetDeviceId: string; state: AndroidInventoryCommandState;
    createdAt: number; expiresAt: number; completedAt?: number; cancelledAt?: number;
    cancelReason?: AndroidInventoryCommand['cancelReason']; apps?: AndroidInventoryApp[];
    lifecycle: CommandLifecycleState;
  }> {
    this.prune();
    if (!this.isDeviceId(requesterDeviceId)) return [];
    return Array.from(this.commands.values())
      .filter((item) => item.requesterDeviceId === requesterDeviceId)
      .slice(-30)
      .map(({ id, targetDeviceId, state, createdAt, expiresAt, completedAt, cancelledAt, cancelReason, apps }) => ({
        id, targetDeviceId, state, lifecycle: lifecycleFromAndroidState(state), createdAt, expiresAt,
        ...(completedAt ? { completedAt } : {}),
        ...(cancelledAt ? { cancelledAt } : {}),
        ...(cancelReason ? { cancelReason } : {}),
        ...(apps ? { apps: apps.map((app) => ({ ...app })) } : {}),
      }));
  }

  private markCancelled(command: AndroidInventoryCommand, reason: NonNullable<AndroidInventoryCommand['cancelReason']>): void {
    command.state = 'CANCELLED';
    command.cancelledAt = Date.now();
    command.cancelReason = reason;
    delete command.apps;
    this.notify(command);
  }

  private isDeviceId(value: unknown): value is string {
    return typeof value === 'string' && value.length <= 100 &&
      value.trim() === value && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);
  }

  private isValidApp(value: unknown): value is AndroidInventoryApp {
    if (typeof value !== 'object' || value === null) return false;
    const app = value as Partial<AndroidInventoryApp>;
    return typeof app.label === 'string' && app.label.trim().length > 0 &&
      app.label.length <= 500 && !/[\u0000-\u001f\u007f]/.test(app.label) &&
      typeof app.packageName === 'string' && app.packageName.trim().length > 0 &&
      app.packageName.length <= 300 && !/[\u0000-\u001f\u007f]/.test(app.packageName);
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, command] of this.commands) {
      if (now >= command.expiresAt && (command.state === 'PENDING' || command.state === 'CLAIMED')) {
        command.state = 'EXPIRED';
        delete command.apps;
        this.notify(command);
      }
      const terminalAt = command.completedAt ?? command.cancelledAt ?? command.expiresAt;
      if (['COMPLETED', 'EXPIRED', 'CANCELLED'].includes(command.state) && now - terminalAt > this.retentionMs) {
        this.commands.delete(id);
      }
    }
  }
}
