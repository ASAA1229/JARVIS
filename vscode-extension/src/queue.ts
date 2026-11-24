import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface QueueItem { qid: string; queuedAt: string; episode: unknown; bytes: number }

/**
 * Durable offline queue stored in the extension's globalStorage. Holds episodes that are ALREADY redacted.
 * Capped by total serialised bytes: when full, the oldest episodes are dropped first.
 */
export class OfflineQueue {
  private items: QueueItem[] = [];
  private counter = 0;
  public droppedTotal = 0;

  constructor(private readonly file: string, public maxBytes: number) {
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8')) as { items?: QueueItem[] };
        if (Array.isArray(parsed.items)) this.items = parsed.items.filter((i) => i && typeof i.qid === 'string' && typeof i.bytes === 'number');
      } catch { this.items = []; }
    }
    this.enforceCap();
  }

  get length(): number { return this.items.length; }
  get totalBytes(): number { return this.items.reduce((sum, item) => sum + item.bytes, 0); }
  list(): readonly QueueItem[] { return this.items; }

  /** Returns false when the single episode is larger than the whole cap (it is never stored). */
  enqueue(episode: unknown): boolean {
    const bytes = Buffer.byteLength(JSON.stringify(episode), 'utf8');
    if (bytes > this.maxBytes) { this.droppedTotal += 1; return false; }
    this.items.push({ qid: `${Date.now().toString(36)}-${(this.counter++).toString(36)}`, queuedAt: new Date().toISOString(), episode, bytes });
    this.enforceCap();
    this.persist();
    return true;
  }

  remove(qid: string): void {
    this.items = this.items.filter((item) => item.qid !== qid);
    this.persist();
  }

  clear(): void { this.items = []; this.persist(); }

  setMaxBytes(maxBytes: number): void { this.maxBytes = maxBytes; this.enforceCap(); this.persist(); }

  private enforceCap(): void {
    let total = this.totalBytes;
    while (total > this.maxBytes && this.items.length) { total -= this.items.shift()!.bytes; this.droppedTotal += 1; }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, items: this.items }), { mode: 0o600 });
    renameSync(temporary, this.file);
  }
}
