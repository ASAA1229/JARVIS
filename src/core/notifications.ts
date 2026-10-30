/**
 * In-memory notification feed for approvals, blocked actions, failures,
 * uncertain outcomes and completed tasks. It holds short, non-sensitive
 * summaries only (never command text, file contents, or secrets) and a bounded
 * number of entries; the HUD and companion read it through an authenticated API.
 */

export type NotificationLevel = 'info' | 'warning' | 'error';

export type NotificationKind =
  | 'approval_required'
  | 'task_completed'
  | 'task_failed'
  | 'task_uncertain'
  | 'task_blocked'
  | 'task_cancelled'
  | 'task_expired'
  | 'schedule_triggered'
  | 'schedule_blocked'
  | 'device_revoked'
  | 'health';

export interface JarvisNotification {
  id: number;
  at: number;
  level: NotificationLevel;
  kind: NotificationKind;
  message: string;
  taskId?: string;
  deviceId?: string;
}

export class NotificationCenter {
  private readonly entries: JarvisNotification[] = [];
  private nextId = 1;

  constructor(private readonly capacity = 100) {}

  public push(level: NotificationLevel, kind: NotificationKind, message: string, refs: { taskId?: string; deviceId?: string } = {}): JarvisNotification {
    const entry: JarvisNotification = { id: this.nextId++, at: Date.now(), level, kind, message: message.slice(0, 200), ...refs };
    this.entries.push(entry);
    if (this.entries.length > this.capacity) this.entries.splice(0, this.entries.length - this.capacity);
    return entry;
  }

  /** Entries newer than `sinceId`, optionally limited to one device (plus device-less system entries). */
  public list(options: { sinceId?: number; deviceId?: string } = {}): JarvisNotification[] {
    return this.entries.filter((entry) =>
      entry.id > (options.sinceId ?? 0) &&
      (options.deviceId === undefined || entry.deviceId === undefined || entry.deviceId === options.deviceId));
  }

  public get size(): number {
    return this.entries.length;
  }
}
