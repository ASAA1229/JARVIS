import { randomUUID } from 'node:crypto';

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
  apps?: AndroidInventoryApp[];
}

/**
 * In-memory, bounded, expiring command channel. It intentionally supports only
 * read-only app inventory. Restart drops pending commands rather than replaying them.
 */
export class AndroidCommandQueue {
  private readonly commands = new Map<string, AndroidInventoryCommand>();
  private readonly maxCommands = 200;
  private readonly maxAppsPerCommand = 300;
  private readonly retentionMs = 10 * 60_000;

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
    return { ...command };
  }

  claimNext(targetDeviceId: string): AndroidInventoryCommand | undefined {
    this.prune();
    if (!this.isDeviceId(targetDeviceId)) return undefined;
    const command = Array.from(this.commands.values()).find((item) =>
      item.targetDeviceId === targetDeviceId && item.state === 'PENDING');
    if (!command) return undefined;
    command.state = 'CLAIMED';
    command.claimedAt = Date.now();
    return { ...command };
  }

  complete(targetDeviceId: string, commandId: string, apps: AndroidInventoryApp[]): boolean {
    this.prune();
    const command = this.commands.get(commandId);
    if (!command || !this.isDeviceId(targetDeviceId) || command.targetDeviceId !== targetDeviceId ||
        command.state !== 'CLAIMED' || Date.now() >= command.expiresAt || !Array.isArray(apps)) return false;

    // Reject malformed entries instead of storing partial or attacker-shaped inventory.
    if (apps.length > this.maxAppsPerCommand || apps.some((app) => !this.isValidApp(app))) return false;
    command.apps = apps.map(({ label, packageName }) => ({
      label: label.trim().slice(0, 120),
      packageName: packageName.trim().slice(0, 240),
    }));
    command.state = 'COMPLETED';
    command.completedAt = Date.now();
    return true;
  }

  /** Cancel work involving a revoked device, whether it requested or was targeted by it. */
  cancelForDevice(deviceId: string): number {
    this.prune();
    if (!this.isDeviceId(deviceId)) return 0;
    let cancelled = 0;
    const now = Date.now();
    for (const command of this.commands.values()) {
      if ((command.targetDeviceId === deviceId || command.requesterDeviceId === deviceId) &&
          (command.state === 'PENDING' || command.state === 'CLAIMED')) {
        command.state = 'CANCELLED';
        command.cancelledAt = now;
        delete command.apps;
        cancelled++;
      }
    }
    return cancelled;
  }

  resultsForRequester(requesterDeviceId: string): Array<{
    id: string; targetDeviceId: string; state: AndroidInventoryCommandState;
    createdAt: number; expiresAt: number; completedAt?: number; cancelledAt?: number; apps?: AndroidInventoryApp[];
  }> {
    this.prune();
    if (!this.isDeviceId(requesterDeviceId)) return [];
    return Array.from(this.commands.values())
      .filter((item) => item.requesterDeviceId === requesterDeviceId)
      .slice(-30)
      .map(({ id, targetDeviceId, state, createdAt, expiresAt, completedAt, cancelledAt, apps }) => ({
        id, targetDeviceId, state, createdAt, expiresAt,
        ...(completedAt ? { completedAt } : {}),
        ...(cancelledAt ? { cancelledAt } : {}),
        ...(apps ? { apps: apps.map((app) => ({ ...app })) } : {}),
      }));
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
      }
      const terminalAt = command.completedAt ?? command.cancelledAt ?? command.expiresAt;
      if (['COMPLETED', 'EXPIRED', 'CANCELLED'].includes(command.state) && now - terminalAt > this.retentionMs) {
        this.commands.delete(id);
      }
    }
  }
}
