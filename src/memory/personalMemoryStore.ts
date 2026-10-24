import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type MemoryCategory = 'preference' | 'project' | 'routine' | 'general';

export interface PersonalMemory {
  id: string;
  category: MemoryCategory;
  content: string;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
}

interface MemoryPayload { version: 1; records: PersonalMemory[]; }
interface EncryptedEnvelope { version: 1; salt: string; iv: string; tag: string; ciphertext: string; }

const DENIED_CONTENT = /\b(password|passphrase|private key|api key|access token|refresh token|cvv|pin code|bank account|card number|payment credential|seed phrase|recovery phrase)\b/i;
const DENIED_CATEGORIES = new Set(['credential', 'secret', 'financial', 'payment', 'biometric', 'medical', 'health']);

export class PersonalMemoryStore {
  private readonly key: Buffer;
  private records = new Map<string, PersonalMemory>();
  private healthy = true;

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

  public save(category: MemoryCategory, content: string, ttlDays?: number): PersonalMemory {
    if (!this.healthy) throw new Error('Memory store is unhealthy.');
    if (!['preference', 'project', 'routine', 'general'].includes(category) || DENIED_CATEGORIES.has(category)) {
      throw new Error('This memory category is not permitted.');
    }
    if (typeof content !== 'string' || !content.trim() || content.length > 4000) {
      throw new Error('Memory content must contain 1–4000 characters.');
    }
    if (DENIED_CONTENT.test(content)) throw new Error('This content appears to contain credentials or sensitive financial data and cannot be stored.');
    if (ttlDays !== undefined && (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 3650)) {
      throw new Error('Memory TTL must be an integer from 1 to 3650 days.');
    }
    const now = Date.now();
    const record: PersonalMemory = {
      id: randomBytes(16).toString('hex'), category, content: content.trim(),
      createdAt: now, updatedAt: now,
      expiresAt: ttlDays === undefined ? undefined : now + ttlDays * 24 * 60 * 60 * 1000,
    };
    this.records.set(record.id, record);
    try { this.persist(); } catch (error) { this.records.delete(record.id); throw error; }
    return { ...record };
  }

  public delete(id: string): boolean {
    if (!this.healthy) throw new Error('Memory store is unhealthy.');
    const existing = this.records.get(id);
    if (!existing) return false;
    this.records.delete(id);
    try { this.persist(); } catch (error) { this.records.set(id, existing); throw error; }
    return true;
  }

  public status(): { healthy: boolean; count: number; encryptedAtRest: true } {
    return { healthy: this.healthy, count: this.records.size, encryptedAtRest: true };
  }
}
