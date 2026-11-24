/**
 * Registry of owner-approved knowledge collections (E:D4.8).
 *
 * When a registry is attached to the document store, retrieval and ingestion are restricted to
 * collections the owner explicitly approved here. The registry holds only collection slugs and
 * approval metadata, never document content, and it invents no sources: it starts empty, so with
 * enforcement on nothing is retrievable until the owner approves a collection.
 */
import { EncryptedJsonFile } from './encryptedJsonFile.js';

export interface ApprovedKnowledgeSource {
  collection: string;
  approvedAt: number;
  approvedBy: string;
}

interface RegistryPayload { version: 1; sources: ApprovedKnowledgeSource[] }

const COLLECTION_PATTERN = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const MAX_SOURCES = 100;

export class KnowledgeSourceRegistry {
  private readonly sources = new Map<string, ApprovedKnowledgeSource>();
  private readonly file?: EncryptedJsonFile<RegistryPayload>;

  /** With a path and owner token the registry is encrypted at rest; without, it is session-local. */
  constructor(filePath?: string, ownerControlToken?: string) {
    if (!filePath || !ownerControlToken) return;
    this.file = new EncryptedJsonFile<RegistryPayload>(filePath, ownerControlToken, 'JARVIS-KNOWLEDGE-SOURCES-V1');
    const payload = this.file.read();
    if (payload === undefined) return;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.sources) || payload.sources.length > MAX_SOURCES ||
        !payload.sources.every((item) => item && typeof item.collection === 'string' && COLLECTION_PATTERN.test(item.collection) &&
          typeof item.approvedAt === 'number' && typeof item.approvedBy === 'string')) {
      throw new Error('Knowledge source registry failed validation; refusing to overwrite it.');
    }
    for (const item of payload.sources) this.sources.set(item.collection, item);
  }

  public isApproved(collection: string | undefined): boolean {
    return collection !== undefined && this.sources.has(collection);
  }

  public list(): ApprovedKnowledgeSource[] {
    return [...this.sources.values()].map((item) => ({ ...item }));
  }

  public approve(collection: string, approvedBy: string): ApprovedKnowledgeSource {
    if (typeof collection !== 'string' || !COLLECTION_PATTERN.test(collection)) throw new Error('Collection must be 1-40 lowercase letters, digits, hyphens or underscores.');
    if (!this.sources.has(collection) && this.sources.size >= MAX_SOURCES) throw new Error('Too many approved knowledge sources.');
    const record = this.sources.get(collection) ?? { collection, approvedAt: Date.now(), approvedBy: String(approvedBy).slice(0, 100) };
    this.sources.set(collection, record);
    this.persist();
    return { ...record };
  }

  public revoke(collection: string): boolean {
    const removed = this.sources.delete(collection);
    if (removed) this.persist();
    return removed;
  }

  private persist(): void {
    this.file?.write({ version: 1, sources: [...this.sources.values()] });
  }
}
