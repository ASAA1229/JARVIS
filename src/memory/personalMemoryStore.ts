import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryVersionHistory } from './memoryVersions.js';

export type MemoryCategory = 'preference' | 'project' | 'routine' | 'general';

export interface PersonalMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  /** Where an approved learned memory came from (JARVIS-US-058 attribution). */
  source?: { kind: string; ref?: string; approvedAt: number };
}

interface MemoryPayload { version: 1; records: PersonalMemory[]; }
interface EncryptedEnvelope { version: 1; salt: string; iv: string; tag: string; ciphertext: string; }

const DENIED_CONTENT = /\b(password|passphrase|private key|api key|access token|refresh token|cvv|pin code|bank account|card number|payment credential|seed phrase|recovery phrase)\b/i;
const DENIED_CATEGORIES = new Set(['credential', 'secret', 'financial', 'payment', 'biometric', 'medical', 'health']);
// Text that tries to act as an instruction to the assistant is data from an untrusted source,
// not a fact about the owner, and must never be stored as trusted memory.
const INSTRUCTION_LIKE = /(ignore (?:all |any |the )?(?:previous|prior|above|earlier) (?:instructions|rules)|disregard (?:your|the) (?:instructions|rules|policy)|you (?:must|should) now |system prompt|<\/?(?:system|assistant|tool)>|act as (?:an? )?(?:administrator|root)|bypass (?:the )?(?:policy|approval|security))/i;
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'what', 'my', 'me', 'i', 'you', 'it', 'do', 'does', 'with', 'about', 'tell']);

/** Raised when a correction was based on an outdated copy of the memory. */
export class MemoryConflictError extends Error {
  constructor(readonly current: PersonalMemory) {
    super('This memory changed since it was read; review the current version before correcting it.');
  }
}

/** Normalized form used for exact-duplicate detection. */
export function normalizeMemoryText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export class PersonalMemoryStore {
  private readonly key: Buffer;
  private records = new Map<string, PersonalMemory>();
  private healthy = true;
  private versions?: MemoryVersionHistory;

  /** Keep previous contents on correction and purge them on deletion (J-E06). */
  public attachVersionHistory(history: MemoryVersionHistory): void {
    this.versions = history;
  }

  constructor(private readonly filePath: string, ownerControlToken: string) {
    if (ownerControlToken.length < 32) throw new Error('Personal memory requires a configured owner control token of at least 32 characters.');
    this.key = scryptSync(ownerControlToken, 'JARVIS-PERSONAL-MEMORY-V1', 32);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const envelope = JSON.parse(readFileSync(this.filePath, 'utf8')) as EncryptedEnvelope;
      if (envelope.version !== 1) throw new Error('Unsupported memory format.');
      const salt = Buffer.from(envelope.salt, 'base64');
      if (salt.length !== 16) throw new Error('Invalid memory salt.');
      const key = scryptSync(this.key, salt, 32);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      const payload = JSON.parse(plain) as MemoryPayload;
      if (payload.version !== 1 || !Array.isArray(payload.records)) throw new Error('Invalid memory payload.');
      for (const record of payload.records) {
        if (this.isValidRecord(record)) this.records.set(record.id, record);
      }
      if (this.pruneExpired()) this.persist();
    } catch {
      this.healthy = false;
      this.records.clear();
      throw new Error('Personal memory could not be decrypted or validated; writes are disabled to avoid overwriting data.');
    }
  }

  private isValidRecord(value: unknown): value is PersonalMemory {
    if (!value || typeof value !== 'object') return false;
    const r = value as Record<string, unknown>;
    return typeof r.id === 'string' && typeof r.content === 'string' &&
      ['preference', 'project', 'routine', 'general'].includes(String(r.category)) &&
      typeof r.createdAt === 'number' && typeof r.updatedAt === 'number';
  }

  private pruneExpired(): boolean {
    const now = Date.now();
    let removed = false;
    for (const [id, record] of this.records) {
      if (record.expiresAt !== undefined && record.expiresAt <= now) {
        this.records.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  private persist(): void {
    if (!this.healthy) throw new Error('Memory store is unhealthy; persistence is fail-closed.');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(this.key, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload: MemoryPayload = { version: 1, records: [...this.records.values()] };
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const envelope: EncryptedEnvelope = {
      version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    };
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.tmp-' + randomBytes(6).toString('hex');
    writeFileSync(temporary, JSON.stringify(envelope), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  public list(): PersonalMemory[] {
    if (!this.healthy) throw new Error('Memory store is unhealthy.');
    if (this.pruneExpired()) this.persist();
    return [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((r) => ({ ...r }));
  }

  /** Validate category and content without storing anything (used for learning candidates). */
  public assertStorable(category: MemoryCategory, content: string): void {
    if (!['preference', 'project', 'routine', 'general'].includes(category) || DENIED_CATEGORIES.has(category)) {
      throw new Error('This memory category is not permitted.');
    }
    if (typeof content !== 'string' || !content.trim() || content.length > 4000) {
      throw new Error('Memory content must contain 1–4000 characters.');
    }
    if (DENIED_CONTENT.test(content)) throw new Error('This content appears to contain credentials or sensitive financial data and cannot be stored.');
    if (INSTRUCTION_LIKE.test(content)) throw new Error('This content reads like an instruction to the assistant, so it cannot be stored as trusted memory.');
  }

  public save(category: MemoryCategory, content: string, ttlDays?: number, source?: PersonalMemory['source']): PersonalMemory {
    if (!this.healthy) throw new Error('Memory store is unhealthy.');
    this.assertStorable(category, content);
    if (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650)) {
      throw new Error('Memory TTL must be an integer from 1 to 3650 days.');
    }
    // Exact duplicates (same category, same normalized text) return the existing record.
    const duplicate = this.findExactDuplicate(category, content);
    if (duplicate) return duplicate;
    const now = Date.now();
    const record: PersonalMemory = {
      id: randomBytes(16).toString('hex'), category, content: content.trim(),
      createdAt: now, updatedAt: now,
      expiresAt: ttlDays === undefined ? undefined : now + ttlDays * 24 * 60 * 60 * 1000,
      ...(source ? { source } : {}),
    };
    this.records.set(record.id, record);
    try { this.persist(); } catch (error) { this.records.delete(record.id); throw error; }
    return { ...record };
  }

  public get(id: string): PersonalMemory | undefined {
    const record = this.records.get(id);
    return record ? { ...record } : undefined;
  }

  public findExactDuplicate(category: MemoryCategory, content: string): PersonalMemory | undefined {
    const normalized = normalizeMemoryText(content);
    if (!normalized) return undefined;
    for (const record of this.records.values()) {
      if (record.category === category && normalizeMemoryText(record.content) === normalized &&
          (record.expiresAt === undefined || record.expiresAt > Date.now())) {
        return { ...record };
      }
    }
    return undefined;
  }

  /**
   * Correct an existing memory's text. Same content rules as save; category, id and expiry
   * are unchanged. When expectedUpdatedAt is supplied and the record changed since, a
   * MemoryConflictError is raised instead of silently overwriting newer owner data.
   */
  public update(id: string, content: string, expectedUpdatedAt?: number): PersonalMemory | undefined {
    if (!this.healthy) throw new Error('Memory store is unhealthy.');
    const existing = this.records.get(id);
    if (!existing) return undefined;
    if (expectedUpdatedAt !== undefined && existing.updatedAt !== expectedUpdatedAt) throw new MemoryConflictError({ ...existing });
    if (typeof content !== 'string' || !content.trim() || content.length > 4000) throw new Error('Memory content must contain 1–4000 characters.');
    if (DENIED_CONTENT.test(content)) throw new Error('This content appears to contain credentials or sensitive financial data and cannot be stored.');
    if (INSTRUCTION_LIKE.test(content)) throw new Error('This content reads like an instruction to the assistant, so it cannot be stored as trusted memory.');
    if (existing.content === content.trim()) return { ...existing };
    const updated: PersonalMemory = { ...existing, content: content.trim(), updatedAt: Date.now() };
    this.records.set(id, updated);
    try { this.persist(); } catch (error) { this.records.set(id, existing); throw error; }
    // The previous text is kept in the encrypted, bounded version history.
    this.versions?.record(id, existing.content, existing.updatedAt);
    return { ...updated };
  }

  /**
   * Retrieve only memories that share meaningful words with the request, so planning and
   * conversation receive relevant context instead of the owner's whole memory.
   */
  /** Active (unexpired) records, for ranking by the Memory Manager. */
  public active(): PersonalMemory[] {
    if (!this.healthy) return [];
    const now = Date.now();
    return [...this.records.values()].filter((record) => record.expiresAt === undefined || record.expiresAt > now).map((record) => ({ ...record }));
  }

  /** Number of meaningful query words that appear in the text. */
  public static lexicalScore(query: string, text: string): number {
    const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
    if (words.size === 0) return 0;
    return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => words.has(word)).length;
  }

  public relevant(query: string, limit = 5): PersonalMemory[] {
    if (!this.healthy) return [];
    const words = new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
    if (words.size === 0) return [];
    return [...this.records.values()]
      .filter((record) => record.expiresAt === undefined || record.expiresAt > Date.now())
      .map((record) => ({ record, score: record.content.toLowerCase().split(/[^a-z0-9]+/).filter((word) => words.has(word)).length }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.record.updatedAt - a.record.updatedAt)
      .slice(0, limit)
      .map((entry) => ({ ...entry.record }));
  }

  /** Re-read and decrypt the file from disk to prove a deleted record is really gone. */
  public verifyAbsentOnDisk(id: string): boolean {
    try {
      const envelope = JSON.parse(readFileSync(this.filePath, 'utf8')) as EncryptedEnvelope;
      const key = scryptSync(this.key, Buffer.from(envelope.salt, 'base64'), 32);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      const payload = JSON.parse(plain) as MemoryPayload;
      return Array.isArray(payload.records) && !payload.records.some((record) => record.id === id);
    } catch {
      return false;
    }
  }

  public delete(id: string): boolean {
    if (!this.healthy) throw new Error('Memory store is unhealthy.');
    const existing = this.records.get(id);
    if (!existing) return false;
    this.records.delete(id);
    try { this.persist(); } catch (error) { this.records.set(id, existing); throw error; }
    // Previous versions are part of the record and go with it.
    this.versions?.purge(id);
    return true;
  }

  public status(): { healthy: boolean; count: number; encryptedAtRest: true } {
    return { healthy: this.healthy, count: this.records.size, encryptedAtRest: true };
  }
}
