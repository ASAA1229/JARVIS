import { randomUUID } from 'node:crypto';

export interface AndroidInventoryApp {
  label: string;
  packageName: string;
}

export interface AndroidInventoryCommand {
  id: string;
  operation: 'android.app.list';
  targetDeviceId: string;
  requesterDeviceId: string;
  createdAt: number;
  expiresAt: number;
  state: 'PENDING' | 'CLAIMED' | 'COMPLETED' | 'EXPIRED';
  claimedAt?: number;
  completedAt?: number;
  apps?: AndroidInventoryApp[];
}

/**
 * In-memory, bounded, expiring command channel. It intentionally supports only
 * read-only app inventory. Restart drops pending commands rather than replaying them.
 */
export class AndroidCommandQueue {
  private readonly commands = new Map<string, AndroidInventoryCommand>();
  private readonly maxCommands = 200;

  create(targetDeviceId: string, requesterDeviceId: string, ttlMs = 60_000): AndroidInventoryCommand {
    this.prune();
    if (this.commands.size >= this.maxCommands) throw new Error('Android command queue is full');
    if (!targetDeviceId || !requesterDeviceId || targetDeviceId === requesterDeviceId) {
      throw new Error('Android command target and requester must be distinct valid devices');
    }
    const now = Date.now();
    const command: AndroidInventoryCommand = {
      id: randomUUID(), operation: 'android.app.list', targetDeviceId, requesterDeviceId,
      createdAt: now, expiresAt: now + Math.min(Math.max(ttlMs, 1000), 60_000), state: 'PENDING',
    };
    this.commands.set(command.id, command);
    return { ...command };
  }

  claimNext(targetDeviceId: string): AndroidInventoryCommand | undefined {
    this.prune();
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
    if (!command || command.targetDeviceId !== targetDeviceId || command.state !== 'CLAIMED' ||
        Date.now() >= command.expiresAt) return false;
    command.state = 'COMPLETED';
    command.completedAt = Date.now();
    command.apps = apps.slice(0, 300).map(({ label, packageName }) => ({
      label: label.slice(0, 120), packageName: packageName.slice(0, 240),
    }));
    return true;
  }

  resultsForRequester(requesterDeviceId: string): Array<{
    id: string; targetDeviceId: string; state: AndroidInventoryCommand['state'];
    createdAt: number; completedAt?: number; apps?: AndroidInventoryApp[];
  }> {
    this.prune();
    return Array.from(this.commands.values())
      .filter((item) => item.requesterDeviceId === requesterDeviceId)
      .slice(-30)
      .map(({ id, targetDeviceId, state, createdAt, completedAt, apps }) => ({
        id, targetDeviceId, state, createdAt, completedAt, ...(apps ? { apps: apps.map((app) => ({ ...app })) } : {}),
      }));
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, command] of this.commands) {
      if (now >= command.expiresAt || (command.state === 'COMPLETED' && now - (command.completedAt ?? now) > 10 * 60_000)) {
        this.commands.delete(id);
      }
    }
  }
}
