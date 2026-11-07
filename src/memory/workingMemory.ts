/**
 * Working Memory (JARVIS-US-057): RAM-like, short-lived context for one
 * conversation, task or agent run. Never written to disk, bounded in size and
 * isolated per device + scope. Entries expire automatically.
 */

export type WorkingScopeKind = 'conversation' | 'task' | 'agent';

export interface WorkingMemoryEntry {
  id: string;
  deviceId: string;
  scope: { kind: WorkingScopeKind; id: string };
  /** Short label such as "user_goal", "tool_result", "observation". */
  label: string;
  content: string;
  createdAt: number;
  expiresAt: number;
}

export interface WorkingMemoryLimits {
  maxEntriesPerScope: number;
  maxScopes: number;
  maxEntryChars: number;
  defaultTtlMs: number;
}

export const DEFAULT_WORKING_LIMITS: WorkingMemoryLimits = {
  maxEntriesPerScope: 50,
  maxScopes: 200,
  maxEntryChars: 4000,
  defaultTtlMs: 2 * 60 * 60 * 1000,
};

let counter = 0;
const nextId = () => `wm-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export class WorkingMemory {
  private readonly scopes = new Map<string, WorkingMemoryEntry[]>();

  constructor(
    private readonly limits: WorkingMemoryLimits = DEFAULT_WORKING_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  private key(deviceId: string, kind: WorkingScopeKind, id: string): string {
    return `${deviceId}\u0000${kind}\u0000${id}`;
  }

  put(deviceId: string, kind: WorkingScopeKind, scopeId: string, label: string, content: string, ttlMs?: number): WorkingMemoryEntry {
    if (!deviceId || !scopeId) throw new Error('Working memory requires a device and scope.');
    const text = String(content).trim().slice(0, this.limits.maxEntryChars);
    if (!text) throw new Error('Working memory content must not be empty.');
    this.expire();
    const key = this.key(deviceId, kind, scopeId);
    let entries = this.scopes.get(key);
    if (!entries) {
      // Evict the least-recently-touched scope when the scope budget is exhausted.
      if (this.scopes.size >= this.limits.maxScopes) {
        const oldest = this.scopes.keys().next().value;
        if (oldest !== undefined) this.scopes.delete(oldest);
      }
      entries = [];
    } else {
      this.scopes.delete(key); // refresh insertion order (LRU)
    }
    const created = this.now();
    const entry: WorkingMemoryEntry = {
      id: nextId(),
      deviceId,
      scope: { kind, id: scopeId },
      label: String(label || 'note').slice(0, 40),
      content: text,
      createdAt: created,
      expiresAt: created + Math.max(1_000, Math.min(ttlMs ?? this.limits.defaultTtlMs, 24 * 60 * 60 * 1000)),
    };
    entries.push(entry);
    while (entries.length > this.limits.maxEntriesPerScope) entries.shift();
    this.scopes.set(key, entries);
    return { ...entry, scope: { ...entry.scope } };
  }

  /** Entries for one scope of one device only (scope isolation). */
  list(deviceId: string, kind: WorkingScopeKind, scopeId: string): WorkingMemoryEntry[] {
    this.expire();
    return (this.scopes.get(this.key(deviceId, kind, scopeId)) ?? []).map((entry) => ({ ...entry, scope: { ...entry.scope } }));
  }

  get(deviceId: string, entryId: string): WorkingMemoryEntry | undefined {
    this.expire();
    for (const entries of this.scopes.values()) {
      const found = entries.find((entry) => entry.id === entryId && entry.deviceId === deviceId);
      if (found) return { ...found, scope: { ...found.scope } };
    }
    return undefined;
  }

  clearScope(deviceId: string, kind: WorkingScopeKind, scopeId: string): number {
    const key = this.key(deviceId, kind, scopeId);
    const count = this.scopes.get(key)?.length ?? 0;
    this.scopes.delete(key);
    return count;
  }

  /** Drop everything a device holds (used on device revocation). */
  clearDevice(deviceId: string): number {
    let removed = 0;
    for (const [key, entries] of this.scopes) {
      if (entries[0]?.deviceId === deviceId) {
        removed += entries.length;
        this.scopes.delete(key);
      }
    }
    return removed;
  }

  /** Remove any working entry that quotes deleted long-term text. */
  scrubContent(text: string): number {
    const needle = text.trim().toLowerCase();
    if (!needle) return 0;
    let removed = 0;
    for (const [key, entries] of this.scopes) {
      const kept = entries.filter((entry) => !entry.content.toLowerCase().includes(needle));
      removed += entries.length - kept.length;
      if (kept.length) this.scopes.set(key, kept);
      else this.scopes.delete(key);
    }
    return removed;
  }

  expire(): number {
    const now = this.now();
    let removed = 0;
    for (const [key, entries] of this.scopes) {
      const kept = entries.filter((entry) => entry.expiresAt > now);
      removed += entries.length - kept.length;
      if (kept.length) this.scopes.set(key, kept);
      else this.scopes.delete(key);
    }
    return removed;
  }

  stats(): { scopes: number; entries: number } {
    this.expire();
    let entries = 0;
    for (const list of this.scopes.values()) entries += list.length;
    return { scopes: this.scopes.size, entries };
  }
}
