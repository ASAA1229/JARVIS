/**
 * Site API clients for the JARVIS personal AI gateway.
 *
 * Each website (portfolio today, other sites later) receives its own key. Only a
 * SHA-256 hash of the key is stored; the plaintext key is shown once at creation.
 * Keys grant text generation only — never device, memory, planner or tool access.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SiteClientLimits {
  /** Requests allowed per rolling minute. */
  requestsPerMinute: number;
  /** Upper bound for max_tokens a request may ask for. */
  maxOutputTokens: number;
}

/** Per-site usage counters (metadata only; never prompts or outputs). */
export interface SiteClientUsage {
  requests: number;
  errors: number;
  inputChars: number;
  outputChars: number;
  lastUsedAt?: string;
}

export interface SiteClientRecord {
  id: string;
  name: string;
  keyHash: string;
  createdAt: string;
  revokedAt?: string;
  limits: SiteClientLimits;
  /** When non-empty, requests must name one of these profiles (site identity scope). */
  allowedProfiles?: string[];
  usage?: SiteClientUsage;
}

export type PublicSiteClient = Omit<SiteClientRecord, 'keyHash'>;

interface StoreFile {
  schemaVersion: 1;
  clients: SiteClientRecord[];
}

export const DEFAULT_SITE_LIMITS: SiteClientLimits = { requestsPerMinute: 20, maxOutputTokens: 800 };
const KEY_PATTERN = /^jrv_([a-f0-9]{12})_([A-Za-z0-9_-]{43})$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/;
const MAX_CLIENTS = 100;
const PROFILE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_ALLOWED_PROFILES = 20;

function validProfiles(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_ALLOWED_PROFILES &&
    value.every((item) => typeof item === 'string' && PROFILE_ID.test(item)) &&
    new Set(value).size === value.length;
}

function normalizeProfiles(value: unknown): string[] {
  if (value === undefined) return [];
  if (!validProfiles(value)) throw new Error('allowedProfiles must be up to 20 unique lowercase profile ids.');
  return [...value];
}

function emptyUsage(): SiteClientUsage {
  return { requests: 0, errors: 0, inputChars: 0, outputChars: 0 };
}

function hashKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

function toPublic(record: SiteClientRecord): PublicSiteClient {
  const { keyHash: _keyHash, ...rest } = record;
  return {
    ...rest,
    limits: { ...rest.limits },
    allowedProfiles: [...(rest.allowedProfiles ?? [])],
    usage: { ...emptyUsage(), ...(rest.usage ?? {}) },
  };
}

function validLimits(value: unknown): value is SiteClientLimits {
  const limits = value as SiteClientLimits;
  return Boolean(limits) &&
    Number.isSafeInteger(limits.requestsPerMinute) && limits.requestsPerMinute >= 1 && limits.requestsPerMinute <= 600 &&
    Number.isSafeInteger(limits.maxOutputTokens) && limits.maxOutputTokens >= 16 && limits.maxOutputTokens <= 4096;
}

export class SiteClientStore {
  private clients: SiteClientRecord[] = [];

  constructor(private readonly path: string) {
    this.load();
  }

  /** Reload from disk so CLI changes (create/revoke) apply to a running gateway. */
  load(): void {
    if (!existsSync(this.path)) {
      this.clients = [];
      return;
    }
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<StoreFile>;
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.clients)) {
      throw new Error('Site client store has an unsupported schema; refusing to start the gateway.');
    }
    const seen = new Set<string>();
    for (const client of parsed.clients) {
      if (!client || typeof client.id !== 'string' || !/^[a-f0-9]{12}$/.test(client.id) || seen.has(client.id) ||
          typeof client.name !== 'string' || !NAME_PATTERN.test(client.name) ||
          typeof client.keyHash !== 'string' || !/^[a-f0-9]{64}$/.test(client.keyHash) ||
          typeof client.createdAt !== 'string' || !validLimits(client.limits) ||
          (client.allowedProfiles !== undefined && !validProfiles(client.allowedProfiles))) {
        throw new Error('Site client store contains an invalid record; refusing to start the gateway.');
      }
      seen.add(client.id);
    }
    this.clients = parsed.clients;
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    const file: StoreFile = { schemaVersion: 1, clients: this.clients };
    writeFileSync(temporary, JSON.stringify(file, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    renameSync(temporary, this.path);
  }

  list(): PublicSiteClient[] {
    return this.clients.map(toPublic);
  }

  /** Create a client and return its key. The key is never stored or retrievable again. */
  create(name: string, limits: Partial<SiteClientLimits> = {}, allowedProfiles?: string[]): { client: PublicSiteClient; apiKey: string } {
    const profiles = normalizeProfiles(allowedProfiles);
    if (!NAME_PATTERN.test(name)) throw new Error('Site name must be 2-48 lowercase letters, digits or hyphens.');
    if (this.clients.some((client) => client.name === name && !client.revokedAt)) {
      throw new Error(`An active client named "${name}" already exists; revoke it first or choose another name.`);
    }
    if (this.clients.length >= MAX_CLIENTS) throw new Error('Site client limit reached.');
    const merged = { ...DEFAULT_SITE_LIMITS, ...limits };
    if (!validLimits(merged)) throw new Error('Invalid site limits.');
    let id = randomBytes(6).toString('hex');
    while (this.clients.some((client) => client.id === id)) id = randomBytes(6).toString('hex');
    const apiKey = `jrv_${id}_${randomBytes(32).toString('base64url')}`;
    const record: SiteClientRecord = {
      id, name, keyHash: hashKey(apiKey), createdAt: new Date().toISOString(), limits: merged,
      ...(profiles.length ? { allowedProfiles: profiles } : {}),
      usage: emptyUsage(),
    };
    this.clients.push(record);
    this.persist();
    return { client: toPublic(record), apiKey };
  }

  revoke(idOrName: string): PublicSiteClient {
    const record = this.clients.find((client) => !client.revokedAt && (client.id === idOrName || client.name === idOrName));
    if (!record) throw new Error('No active site client matches that id or name.');
    record.revokedAt = new Date().toISOString();
    this.persist();
    return toPublic(record);
  }

  /** Change an active client's limits and/or profile scope (owner action). */
  updateSettings(idOrName: string, changes: { limits?: Partial<SiteClientLimits>; allowedProfiles?: string[] }): PublicSiteClient {
    const record = this.clients.find((client) => !client.revokedAt && (client.id === idOrName || client.name === idOrName));
    if (!record) throw new Error('No active site client matches that id or name.');
    const limits = { ...record.limits, ...(changes.limits ?? {}) };
    if (!validLimits(limits)) throw new Error('Invalid site limits.');
    const profiles = changes.allowedProfiles === undefined ? record.allowedProfiles : normalizeProfiles(changes.allowedProfiles);
    record.limits = limits;
    if (profiles && profiles.length) record.allowedProfiles = profiles;
    else delete record.allowedProfiles;
    this.persist();
    return toPublic(record);
  }

  /**
   * Add one request to a client's usage counters. Re-reads the file first so a key
   * created or revoked by the CLI in the meantime is not overwritten.
   */
  recordUsage(clientId: string, delta: { inputChars: number; outputChars: number; error: boolean }): void {
    this.load();
    const record = this.clients.find((client) => client.id === clientId);
    if (!record) return;
    const usage = { ...emptyUsage(), ...(record.usage ?? {}) };
    usage.requests += 1;
    if (delta.error) usage.errors += 1;
    usage.inputChars += Math.max(0, Math.floor(delta.inputChars));
    usage.outputChars += Math.max(0, Math.floor(delta.outputChars));
    usage.lastUsedAt = new Date().toISOString();
    record.usage = usage;
    this.persist();
  }

  /** Resolve an API key to an active client using a constant-time hash comparison. */
  authenticate(key: unknown): PublicSiteClient | null {
    if (typeof key !== 'string' || key.length > 80) return null;
    const match = KEY_PATTERN.exec(key);
    if (!match) return null;
    const record = this.clients.find((client) => client.id === match[1]);
    const presented = Buffer.from(hashKey(key), 'hex');
    // Compare against a dummy hash when the id is unknown so timing does not reveal ids.
    const expected = Buffer.from(record?.keyHash ?? '0'.repeat(64), 'hex');
    const equal = timingSafeEqual(presented, expected);
    if (!record || !equal || record.revokedAt) return null;
    return toPublic(record);
  }
}
