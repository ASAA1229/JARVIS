/**
 * Ingest keys for the JARVIS Learn VS Code extension (E3:D4.17).
 *
 * A key authorises exactly one operation: POST /api/learning/episodes. It is never accepted by any other
 * route (chat, memory, device API), so a leaked key can at worst add pending episodes the owner can reject.
 * Only a SHA-256 hash is stored; the plaintext key is shown once at creation.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const INGEST_SCOPE = 'episodes:post' as const;

export interface IngestKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  scope: typeof INGEST_SCOPE;
  createdAt: string;
  revokedAt?: string;
  requestsPerMinute: number;
  usage: { accepted: number; rejected: number; lastUsedAt?: string };
}
export type PublicIngestKey = Omit<IngestKeyRecord, 'keyHash'>;

const KEY_PATTERN = /^jli_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const MAX_KEYS = 50;
const hashKey = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');
const toPublic = ({ keyHash: _hash, ...rest }: IngestKeyRecord): PublicIngestKey => ({ ...rest, usage: { ...rest.usage } });

export class IngestKeyStore {
  private keys: IngestKeyRecord[] = [];
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly path: string) { this.load(); }

  /** Reload from disk so CLI changes (create/revoke) apply to a running server. */
  load(): void {
    if (!existsSync(this.path)) { this.keys = []; return; }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as { schemaVersion?: number; keys?: IngestKeyRecord[] };
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.keys)) throw new Error('Ingest key store has an unsupported schema.');
    for (const key of parsed.keys) {
      if (!key || !/^[a-f0-9]{12}$/.test(key.id) || !NAME_PATTERN.test(key.name) || !/^[a-f0-9]{64}$/.test(key.keyHash) || key.scope !== INGEST_SCOPE) {
        throw new Error('Ingest key store contains an invalid record.');
      }
    }
    this.keys = parsed.keys;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ schemaVersion: 1, keys: this.keys }, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }

  list(): PublicIngestKey[] { this.load(); return this.keys.map(toPublic); }

  create(name: string, requestsPerMinute = 120): { key: PublicIngestKey; ingestKey: string } {
    this.load();
    if (!NAME_PATTERN.test(name)) throw new Error('Key name must be 2-48 lowercase letters, digits or hyphens.');
    if (!Number.isSafeInteger(requestsPerMinute) || requestsPerMinute < 1 || requestsPerMinute > 600) throw new Error('requestsPerMinute must be 1-600.');
    if (this.keys.some((key) => key.name === name && !key.revokedAt)) throw new Error(`An active ingest key named "${name}" already exists.`);
    if (this.keys.length >= MAX_KEYS) throw new Error('Ingest key limit reached; revoke unused keys.');
    let id = randomBytes(6).toString('hex');
    while (this.keys.some((key) => key.id === id)) id = randomBytes(6).toString('hex');
    const ingestKey = `jli_${id}_${randomBytes(32).toString('base64url')}`;
    const record: IngestKeyRecord = {
      id, name, keyHash: hashKey(ingestKey), scope: INGEST_SCOPE, createdAt: new Date().toISOString(),
      requestsPerMinute, usage: { accepted: 0, rejected: 0 },
    };
    this.keys.push(record);
    this.persist();
    return { key: toPublic(record), ingestKey };
  }

  revoke(idOrName: string): PublicIngestKey {
    this.load();
    const record = this.keys.find((key) => !key.revokedAt && (key.id === idOrName || key.name === idOrName));
    if (!record) throw new Error('No active ingest key matches that id or name.');
    record.revokedAt = new Date().toISOString();
    this.persist();
    return toPublic(record);
  }

  /** Constant-time hash comparison; returns the active key or null. */
  authenticate(presented: unknown): PublicIngestKey | null {
    if (typeof presented !== 'string' || presented.length > 80) return null;
    const match = KEY_PATTERN.exec(presented);
    if (!match) return null;
    this.load();
    const record = this.keys.find((key) => key.id === match[1]);
    if (!record || record.revokedAt) return null;
    const expected = Buffer.from(record.keyHash, 'hex');
    const actual = Buffer.from(hashKey(presented), 'hex');
    return expected.length === actual.length && timingSafeEqual(expected, actual) ? toPublic(record) : null;
  }

  /** Sliding one-minute window; false when the key is over its limit. */
  allow(key: PublicIngestKey, now = Date.now()): boolean {
    const recent = (this.windows.get(key.id) ?? []).filter((time) => now - time < 60_000);
    if (recent.length >= key.requestsPerMinute) { this.windows.set(key.id, recent); return false; }
    recent.push(now);
    this.windows.set(key.id, recent);
    return true;
  }

  recordUsage(id: string, accepted: boolean): void {
    this.load();
    const record = this.keys.find((key) => key.id === id);
    if (!record) return;
    if (accepted) record.usage.accepted += 1; else record.usage.rejected += 1;
    record.usage.lastUsedAt = new Date().toISOString();
    this.persist();
  }
}
