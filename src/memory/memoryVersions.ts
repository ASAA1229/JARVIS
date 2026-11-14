/**
 * Encrypted, bounded version history for long-term memory corrections (J-E06).
 * Each correction keeps the previous content; deleting a memory purges its history.
 */
import { EncryptedJsonFile } from './encryptedJsonFile.js';

export interface MemoryVersion {
  content: string;
  /** updatedAt of the record when this content was current. */
  validUntil: number;
  replacedAt: number;
}

interface VersionFile {
  version: 1;
  history: Record<string, MemoryVersion[]>;
}

export const MAX_VERSIONS_PER_MEMORY = 10;

export class MemoryVersionHistory {
  private readonly file: EncryptedJsonFile<VersionFile>;
  private data: VersionFile = { version: 1, history: {} };

  constructor(filePath: string, ownerControlToken: string) {
    this.file = new EncryptedJsonFile<VersionFile>(filePath, ownerControlToken, 'JARVIS-MEMORY-VERSIONS-V1');
    const loaded = this.file.read();
    if (loaded) {
      if (loaded.version !== 1 || typeof loaded.history !== 'object' || !loaded.history) {
        throw new Error('Memory version history is invalid; refusing to overwrite it.');
      }
      this.data = loaded;
    }
  }

  record(memoryId: string, previousContent: string, previousUpdatedAt: number): void {
    const list = this.data.history[memoryId] ?? [];
    list.push({ content: previousContent, validUntil: previousUpdatedAt, replacedAt: Date.now() });
    while (list.length > MAX_VERSIONS_PER_MEMORY) list.shift();
    this.data.history[memoryId] = list;
    this.file.write(this.data);
  }

  list(memoryId: string): MemoryVersion[] {
    return (this.data.history[memoryId] ?? []).map((entry) => ({ ...entry }));
  }

  purge(memoryId: string): boolean {
    if (!(memoryId in this.data.history)) return false;
    delete this.data.history[memoryId];
    this.file.write(this.data);
    return true;
  }

  /** Drop history for memories that no longer exist (expiry, sync deletes). */
  reconcile(liveIds: Set<string>): number {
    let removed = 0;
    for (const id of Object.keys(this.data.history)) {
      if (!liveIds.has(id)) {
        delete this.data.history[id];
        removed += 1;
      }
    }
    if (removed) this.file.write(this.data);
    return removed;
  }

  /** True when no history entry for this memory remains on disk. */
  verifyPurged(memoryId: string): boolean {
    try {
      const onDisk = this.file.read();
      return !onDisk || !(memoryId in onDisk.history);
    } catch {
      return false;
    }
  }
}
