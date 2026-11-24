/**
 * ASAA ecosystem event producer (contracts/asaa-ecosystem/v1/event-envelope.schema.json).
 *
 * Disabled by default: it is active only when ASAA_EVENTS_URL, ASAA_EVENTS_TOKEN and
 * ASAA_ORG_ID are all set. Otherwise every call is a no-op and JARVIS runs standalone.
 *
 * Events carry no user content: no transcripts, request text, file paths, device ids or
 * secrets. Payloads are built from fixed, validated fields only. Delivery uses a bounded,
 * persistent outbox (encrypted with the owner token when one is configured) with exponential
 * backoff, a dead-letter list and idempotency by envelope id. Producing events never changes
 * JARVIS behaviour: emit methods never throw and never block a request.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { currentRequestId } from '../core/requestContext.js';
import { EncryptedJsonFile } from '../memory/encryptedJsonFile.js';
import type { CheckValue } from './serviceManifest.js';

export const EVENT_SPEC_VERSION = 'asaa.event.v1';
export const EVENT_SOURCE = 'jarvis';
export const EVENT_PROJECT = 'JARVIS';
export const EVENTS_PATH = '/api/v1/integration/events';

export type AsaaEventType =
  | 'jarvis.task.completed'
  | 'jarvis.task.failed'
  | 'jarvis.security.device-revoked'
  | 'jarvis.security.audit-integrity-failed';
export type AsaaSeverity = 'info' | 'warning' | 'critical';

export interface AsaaEventEnvelope {
  specversion: typeof EVENT_SPEC_VERSION;
  id: string;
  source: typeof EVENT_SOURCE;
  type: AsaaEventType;
  time: string;
  orgId: string;
  project: typeof EVENT_PROJECT;
  subject?: string;
  correlationId?: string;
  severity: AsaaSeverity;
  data: Record<string, string>;
}

export type DeviceRevokeReason = 'owner-recovery' | 'revoke-all' | 'device-request' | 'unspecified';
export type AuditFailureCategory = 'log-integrity' | 'log-write-failed' | 'log-read-failed' | 'log-truncated' | 'log-invalid' | 'unknown';

/** Hooks the core service and audit log call; implemented by the producer. */
export interface IntegrationEventSink {
  taskFinished(info: { taskId: string; operation: string; outcome: string; failed: boolean; actor?: string }): void;
  deviceRevoked(reason: DeviceRevokeReason): void;
}

// ---------------------------------------------------------------- configuration

/** OAuth2 client-credentials settings (Keycloak service account). The secret lives in memory only. */
export interface ClientCredentialsConfig {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
}

export const DEFAULT_EVENTS_CLIENT_ID = 'jarvis-events';

export interface AsaaEventsConfig {
  /** Base URL without a trailing slash; events are POSTed to `${baseUrl}/api/v1/integration/events`. */
  baseUrl: string;
  /** Static bearer token (fallback). Ignored when `clientCredentials` is set. */
  token?: string;
  /** Preferred: obtain short-lived access tokens with the client-credentials grant. */
  clientCredentials?: ClientCredentialsConfig;
  orgId: string;
}

export type AsaaEventsConfigResult =
  | { enabled: true; config: AsaaEventsConfig; warnings?: string[] }
  | { enabled: false; reason: 'not-configured' | 'incomplete' | 'invalid-url' | 'insecure-url' | 'invalid-org' | 'invalid-token' | 'invalid-client-credentials' };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function readAsaaEventsConfig(env: NodeJS.ProcessEnv = process.env): AsaaEventsConfigResult {
  const url = env.ASAA_EVENTS_URL?.trim() ?? '';
  const token = env.ASAA_EVENTS_TOKEN?.trim() ?? '';
  const orgId = env.ASAA_ORG_ID?.trim() ?? '';
  const tokenUrl = env.ASAA_EVENTS_TOKEN_URL?.trim() ?? '';
  const clientIdRaw = env.ASAA_EVENTS_CLIENT_ID?.trim() ?? '';
  const clientSecret = env.ASAA_EVENTS_CLIENT_SECRET?.trim() ?? '';
  const ccIntent = Boolean(tokenUrl || clientSecret || clientIdRaw);
  if (!url && !token && !orgId && !ccIntent) return { enabled: false, reason: 'not-configured' };
  // Credentials: client credentials (token URL + secret) or the static token. A half-configured
  // client-credentials set never silently falls back to the static token.
  if (ccIntent && !(tokenUrl && clientSecret)) return { enabled: false, reason: 'incomplete' };
  if (!url || !orgId || !(ccIntent || token)) return { enabled: false, reason: 'incomplete' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { enabled: false, reason: 'invalid-url' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    return { enabled: false, reason: 'invalid-url' };
  }
  // HTTPS is required unless the target is this machine.
  if (parsed.protocol !== 'https:' && !LOOPBACK_HOSTS.has(parsed.hostname)) return { enabled: false, reason: 'insecure-url' };
  if (orgId.length > 128 || /[\u0000-\u001f\u007f]/.test(orgId)) return { enabled: false, reason: 'invalid-org' };
  const baseUrl = parsed.toString().replace(/\/+$/, '');
  if (!ccIntent) {
    if (/[\s\u0000-\u001f\u007f]/.test(token)) return { enabled: false, reason: 'invalid-token' };
    return { enabled: true, config: { baseUrl, token, orgId } };
  }
  let tokenEndpoint: URL;
  try {
    tokenEndpoint = new URL(tokenUrl);
  } catch {
    return { enabled: false, reason: 'invalid-client-credentials' };
  }
  const clientId = clientIdRaw || DEFAULT_EVENTS_CLIENT_ID;
  if (!['http:', 'https:'].includes(tokenEndpoint.protocol) || tokenEndpoint.username || tokenEndpoint.password || tokenEndpoint.search || tokenEndpoint.hash ||
      (tokenEndpoint.protocol !== 'https:' && !LOOPBACK_HOSTS.has(tokenEndpoint.hostname)) ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(clientId) || clientSecret.length > 512 || /[\s\u0000-\u001f\u007f]/.test(clientSecret)) {
    return { enabled: false, reason: 'invalid-client-credentials' };
  }
  // Client credentials and a static token are mutually exclusive: client credentials win.
  const warnings = token ? ['ASAA_EVENTS_TOKEN is ignored because client credentials are configured.'] : undefined;
  return { enabled: true, config: { baseUrl, orgId, clientCredentials: { tokenUrl: tokenEndpoint.toString(), clientId, clientSecret } }, ...(warnings ? { warnings } : {}) };
}

// ---------------------------------------------------------------- access tokens

/** A token could not be obtained. Treated as transient by the sender: never dead-letters events by itself. */
export class TokenFetchError extends Error {
  constructor(readonly category: 'network' | 'status' | 'response') {
    super(`token fetch failed (${category})`);
    this.name = 'TokenFetchError';
  }
}

const TOKEN_REFRESH_MARGIN_MS = 30_000;
const TOKEN_DEFAULT_TTL_SECONDS = 60;
const TOKEN_MAX_RESPONSE_CHARS = 64 * 1024;

/**
 * OAuth2 client-credentials token source (client_secret_basic). Tokens are cached in memory until
 * about 30 s before they expire (from `expires_in`; the JWT is not parsed) and concurrent requests
 * share one fetch. The client secret and the token are never logged or persisted.
 */
export class ClientCredentialsTokenSource {
  private cached: { token: string; refreshAt: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(
    private readonly credentials: ClientCredentialsConfig,
    private readonly options: { fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number } = {},
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async get(forceRefresh = false): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (!forceRefresh && this.cached && now < this.cached.refreshAt) return this.cached.token;
    if (forceRefresh) this.cached = undefined;
    if (!this.inFlight) {
      this.inFlight = this.fetchToken().finally(() => { this.inFlight = undefined; });
    }
    return this.inFlight;
  }

  private async fetchToken(): Promise<string> {
    const { tokenUrl, clientId, clientSecret } = this.credentials;
    const basic = Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`, 'utf8').toString('base64');
    let response: Response;
    try {
      response = await (this.options.fetchImpl ?? fetch)(tokenUrl, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', Authorization: `Basic ${basic}` },
        body: 'grant_type=client_credentials',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
    } catch {
      throw new TokenFetchError('network');
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new TokenFetchError('network');
    }
    if (!response.ok) throw new TokenFetchError('status');
    let parsed: unknown;
    try {
      if (text.length > TOKEN_MAX_RESPONSE_CHARS) throw new Error('too large');
      parsed = JSON.parse(text);
    } catch {
      throw new TokenFetchError('response');
    }
    const body = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    const accessToken = body.access_token;
    const tokenType = body.token_type;
    if (typeof accessToken !== 'string' || !accessToken || accessToken.length > 8192 || /[\s\u0000-\u001f\u007f]/.test(accessToken) ||
        (typeof tokenType === 'string' && tokenType.toLowerCase() !== 'bearer')) {
      throw new TokenFetchError('response');
    }
    const expiresIn = typeof body.expires_in === 'number' && Number.isFinite(body.expires_in) && body.expires_in > 0 ? body.expires_in : TOKEN_DEFAULT_TTL_SECONDS;
    const ttlMs = expiresIn * 1000;
    const issuedAt = (this.options.now ?? Date.now)();
    // Refresh ~30 s early; very short-lived tokens are refreshed at half their lifetime instead.
    this.cached = { token: accessToken, refreshAt: issuedAt + ttlMs - Math.min(TOKEN_REFRESH_MARGIN_MS, ttlMs / 2) };
    return accessToken;
  }
}

// ---------------------------------------------------------------- envelope building

const TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** SSO subject identifiers (for example a UUID); never a username or device id. */
const ACTOR_ID = /^[A-Za-z0-9._:@-]{1,128}$/;
const OPERATION_ID = /^[a-z][a-z0-9:_-]{0,63}$/;
const CORRELATION_ID = /^[A-Za-z0-9._-]{8,64}$/;
const OUTCOMES = new Set(['VERIFIED_SUCCESS', 'VERIFIED_FAILURE', 'PARTIAL_SUCCESS', 'UNCERTAIN']);
const REVOKE_REASONS = new Set<DeviceRevokeReason>(['owner-recovery', 'revoke-all', 'device-request', 'unspecified']);
const AUDIT_CATEGORIES = new Set<AuditFailureCategory>(['log-integrity', 'log-write-failed', 'log-read-failed', 'log-truncated', 'log-invalid', 'unknown']);

export interface EnvelopeInput {
  type: AsaaEventType;
  data: Record<string, unknown>;
  severity?: AsaaSeverity;
  subject?: string;
  correlationId?: string;
  id?: string;
  now?: Date;
}

/** Maps an internal audit failure code to a coarse category; internal codes are never sent. */
export function categorizeAuditFailure(reason: string | undefined): AuditFailureCategory {
  const code = String(reason ?? '');
  if (code === 'AUDIT_LOG_WRITE_FAILED') return 'log-write-failed';
  if (code === 'AUDIT_LOG_READ_FAILED') return 'log-read-failed';
  if (code === 'AUDIT_LOG_TRUNCATED') return 'log-truncated';
  if (/^AUDIT_LOG_INVALID_(JSON|RECORD)/.test(code)) return 'log-invalid';
  if (/^AUDIT_LOG_(INTEGRITY_FAILURE|CONTENT_MISMATCH)/.test(code) || /hash|chain|index/i.test(code)) return 'log-integrity';
  return 'unknown';
}

/** Builds a schema-valid envelope. Data is rebuilt from validated fields; nothing else is copied. */
export function buildEnvelope(config: Pick<AsaaEventsConfig, 'orgId'>, input: EnvelopeInput): AsaaEventEnvelope {
  let data: Record<string, string>;
  let subject: string | undefined;
  let severity: AsaaSeverity = input.severity ?? 'info';
  switch (input.type) {
    case 'jarvis.task.completed':
    case 'jarvis.task.failed': {
      const taskId = String(input.data.taskId ?? '');
      if (!TASK_ID.test(taskId)) throw new Error('A task event needs a valid task id.');
      const operation = String(input.data.operation ?? '');
      const outcome = String(input.data.outcome ?? '');
      data = {
        taskId,
        operation: OPERATION_ID.test(operation) ? operation : 'unknown',
        outcome: OUTCOMES.has(outcome) ? outcome : 'UNCERTAIN',
        // Attribution: the SSO subject of the person whose device ran the task (only when known).
        ...(typeof input.data.actor === 'string' && ACTOR_ID.test(input.data.actor) ? { actor: input.data.actor } : {}),
      };
      subject = `task/${taskId}`;
      severity = input.severity ?? (input.type === 'jarvis.task.failed' ? 'warning' : 'info');
      break;
    }
    case 'jarvis.security.device-revoked': {
      const reason = String(input.data.reason ?? '') as DeviceRevokeReason;
      data = { reason: REVOKE_REASONS.has(reason) ? reason : 'unspecified' };
      severity = input.severity ?? 'warning';
      break;
    }
    case 'jarvis.security.audit-integrity-failed': {
      const category = String(input.data.category ?? '') as AuditFailureCategory;
      data = { category: AUDIT_CATEGORIES.has(category) ? category : 'unknown' };
      severity = 'critical';
      break;
    }
    default:
      throw new Error('Unsupported event type.');
  }
  const envelope: AsaaEventEnvelope = {
    specversion: EVENT_SPEC_VERSION,
    id: input.id ?? randomUUID(),
    source: EVENT_SOURCE,
    type: input.type,
    time: (input.now ?? new Date()).toISOString(),
    orgId: config.orgId,
    project: EVENT_PROJECT,
    severity,
    data,
  };
  if (subject) envelope.subject = subject.slice(0, 200);
  if (input.correlationId && CORRELATION_ID.test(input.correlationId)) envelope.correlationId = input.correlationId;
  return envelope;
}

// ---------------------------------------------------------------- outbox

export interface OutboxEntry {
  envelope: AsaaEventEnvelope;
  attempts: number;
  nextAttemptAt: number;
  /** Set on dead-lettered entries: coarse reason only. */
  deadReason?: string;
  /** Set (time of the last refusal) while ASAA refuses our credentials or producer binding (401/403). */
  authBlockedAt?: number;
}

export interface OutboxState {
  version: 1;
  pending: OutboxEntry[];
  dead: OutboxEntry[];
  /** Recently delivered ids (bounded) so a re-enqueue of the same id is ignored. */
  delivered: string[];
}

const EMPTY_STATE = (): OutboxState => ({ version: 1, pending: [], dead: [], delivered: [] });

interface OutboxStore {
  read(): OutboxState | undefined;
  write(state: OutboxState): void;
}

class PlainJsonStore implements OutboxStore {
  constructor(private readonly path: string) {}
  read(): OutboxState | undefined {
    if (!existsSync(this.path)) return undefined;
    return JSON.parse(readFileSync(this.path, 'utf8')) as OutboxState;
  }
  write(state: OutboxState): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(state), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}

export interface ProducerOptions {
  config: AsaaEventsConfig | null;
  /** Why the producer is disabled (for diagnostics only). */
  disabledReason?: string;
  outboxPath: string;
  /** When set (32+ chars), the outbox is AES-256-GCM encrypted like other JARVIS stores. */
  ownerToken?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  maxPending?: number;
  maxDeadLetter?: number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  timeoutMs?: number;
  flushIntervalMs?: number;
  /** Wait after a 401/403 refusal (default 15 minutes). */
  authBackoffMs?: number;
}

export interface ProducerStatus {
  enabled: boolean;
  pending: number;
  deadLetter: number;
}

const DELIVERED_MEMORY = 1000;

export class AsaaEventProducer implements IntegrationEventSink {
  private readonly config: AsaaEventsConfig | null;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly maxPending: number;
  private readonly maxDead: number;
  private readonly maxAttempts: number;
  private readonly backoffBase: number;
  private readonly backoffMax: number;
  private readonly timeoutMs: number;
  private readonly flushIntervalMs: number;
  private store: OutboxStore | undefined;
  private state: OutboxState = EMPTY_STATE();
  private timer: ReturnType<typeof setInterval> | undefined;
  private flushing: Promise<void> | undefined;
  private warnedPersistence = false;
  private tokenSource: ClientCredentialsTokenSource | undefined;
  private readonly authBackoff: number;

  constructor(private readonly options: ProducerOptions) {
    this.config = options.config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.maxPending = options.maxPending ?? 500;
    this.maxDead = options.maxDeadLetter ?? 200;
    this.maxAttempts = options.maxAttempts ?? 8;
    this.backoffBase = options.backoffBaseMs ?? 2_000;
    this.backoffMax = options.backoffMaxMs ?? 15 * 60_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.flushIntervalMs = options.flushIntervalMs ?? 5_000;
    // Credential or producer-binding refusals wait at least 15 minutes between attempts.
    this.authBackoff = Math.max(options.authBackoffMs ?? 15 * 60_000, 0);
    if (this.config?.clientCredentials) {
      this.tokenSource = new ClientCredentialsTokenSource(this.config.clientCredentials, { fetchImpl: this.fetchImpl, now: this.now, timeoutMs: this.timeoutMs });
    }
    if (this.config) this.load();
  }

  /** Reads the environment; returns a disabled no-op producer unless all three variables are valid. */
  static fromEnvironment(env: NodeJS.ProcessEnv, location: { statePath?: string; ownerToken?: string }, overrides: Partial<ProducerOptions> = {}): AsaaEventProducer {
    const result = readAsaaEventsConfig(env);
    if (!result.enabled && result.reason !== 'not-configured') {
      // Misconfiguration is reported once, without echoing any configured value.
      console.warn(`[JARVIS] ASAA event producer disabled: ${result.reason}.`);
    }
    if (result.enabled) for (const warning of result.warnings ?? []) console.warn(`[JARVIS] ${warning}`);
    return new AsaaEventProducer({
      config: result.enabled ? result.config : null,
      disabledReason: result.enabled ? undefined : result.reason,
      outboxPath: location.statePath ? `${location.statePath}.asaa-events` : './data/asaa-events.enc',
      ownerToken: location.ownerToken,
      ...overrides,
    });
  }

  get enabled(): boolean {
    return this.config !== null;
  }

  // ------------------------------------------------------------ persistence

  private load(): void {
    const token = this.options.ownerToken;
    this.store = token && token.length >= 32
      ? new EncryptedJsonFile<OutboxState>(this.options.outboxPath, token, 'JARVIS-ASAA-EVENTS-V1')
      : new PlainJsonStore(this.options.outboxPath);
    try {
      const loaded = this.store.read();
      if (loaded && loaded.version === 1 && Array.isArray(loaded.pending) && Array.isArray(loaded.dead) && Array.isArray(loaded.delivered)) {
        this.state = loaded;
      }
    } catch {
      // Unreadable or tampered outbox: undelivered telemetry is dropped, never replayed from untrusted content.
      console.warn('[JARVIS] ASAA event outbox was unreadable and has been reset.');
      this.state = EMPTY_STATE();
    }
  }

  private persist(): void {
    if (!this.store) return;
    try {
      this.store.write(this.state);
    } catch {
      if (!this.warnedPersistence) {
        this.warnedPersistence = true;
        console.warn('[JARVIS] ASAA event outbox could not be persisted; events stay in memory only.');
      }
    }
  }

  // ------------------------------------------------------------ producing

  status(): ProducerStatus {
    return { enabled: this.enabled, pending: this.state.pending.length, deadLetter: this.state.dead.length };
  }

  /** Manifest `checks.asaaEvents` value. */
  manifestCheck(): CheckValue {
    if (!this.enabled) return 'disabled';
    const stuck = this.state.pending.some((entry) => entry.attempts >= 3 || entry.authBlockedAt !== undefined);
    return this.state.dead.length > 0 || stuck ? 'degraded' : 'ok';
  }

  /** Adds an envelope to the outbox (idempotent by id) and schedules delivery. Never throws. */
  enqueue(envelope: AsaaEventEnvelope): boolean {
    if (!this.config) return false;
    try {
      const id = envelope.id;
      if (this.state.delivered.includes(id) || this.state.pending.some((e) => e.envelope.id === id) || this.state.dead.some((e) => e.envelope.id === id)) return false;
      this.state.pending.push({ envelope, attempts: 0, nextAttemptAt: this.now() });
      while (this.state.pending.length > this.maxPending) {
        // Bounded: the oldest undelivered event moves to dead-letter instead of growing without limit.
        const dropped = this.state.pending.shift()!;
        this.deadLetter(dropped, 'outbox-full');
      }
      this.persist();
      queueMicrotask(() => { void this.flush(); });
      return true;
    } catch {
      return false;
    }
  }

  private emit(input: Omit<EnvelopeInput, 'now'>): void {
    if (!this.config) return;
    try {
      this.enqueue(buildEnvelope(this.config, { ...input, correlationId: input.correlationId ?? currentRequestId(), now: new Date(this.now()) }));
    } catch {
      // A malformed event is dropped; producing events must never affect the assistant.
    }
  }

  taskFinished(info: { taskId: string; operation: string; outcome: string; failed: boolean; actor?: string }): void {
    this.emit({
      type: info.failed ? 'jarvis.task.failed' : 'jarvis.task.completed',
      data: { taskId: info.taskId, operation: info.operation, outcome: info.outcome, ...(info.actor ? { actor: info.actor } : {}) },
    });
  }

  deviceRevoked(reason: DeviceRevokeReason): void {
    this.emit({ type: 'jarvis.security.device-revoked', data: { reason } });
  }

  auditIntegrityFailed(category: AuditFailureCategory): void {
    this.emit({ type: 'jarvis.security.audit-integrity-failed', severity: 'critical', data: { category } });
  }

  // ------------------------------------------------------------ delivery

  start(): void {
    if (!this.config || this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.flushIntervalMs);
    this.timer.unref();
    queueMicrotask(() => { void this.flush(); });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private deadLetter(entry: OutboxEntry, reason: string): void {
    this.state.dead.push({ ...entry, deadReason: reason });
    while (this.state.dead.length > this.maxDead) this.state.dead.shift();
  }

  private markDelivered(id: string): void {
    this.state.delivered.push(id);
    while (this.state.delivered.length > DELIVERED_MEMORY) this.state.delivered.shift();
  }

  /** Attempts delivery of every due entry. Concurrent calls share one run. */
  flush(): Promise<void> {
    if (!this.config) return Promise.resolve();
    if (!this.flushing) {
      this.flushing = this.runFlush().finally(() => { this.flushing = undefined; });
    }
    return this.flushing;
  }

  private async runFlush(): Promise<void> {
    const config = this.config!;
    // Events enqueued while a run is in flight are picked up by the next pass of this loop; an entry
    // is attempted at most once per run, so retries always wait for their backoff.
    const attempted = new Set<OutboxEntry>();
    let dueAny = false;
    for (;;) {
      const due = this.state.pending.filter((entry) => entry.nextAttemptAt <= this.now() && !attempted.has(entry));
      if (due.length === 0) break;
      dueAny = true;
      await this.deliverBatch(config, due, attempted);
    }
    if (dueAny) this.persist();
  }

  private async deliverBatch(config: AsaaEventsConfig, due: OutboxEntry[], attempted: Set<OutboxEntry>): Promise<void> {
    for (const entry of due) {
      attempted.add(entry);
      const outcome = await this.send(config, entry.envelope);
      const index = this.state.pending.indexOf(entry);
      if (index < 0) continue;
      if (outcome === 'delivered') {
        this.state.pending.splice(index, 1);
        this.markDelivered(entry.envelope.id);
      } else if (outcome === 'permanent') {
        this.state.pending.splice(index, 1);
        this.deadLetter(entry, 'rejected');
      } else if (outcome === 'auth') {
        // ASAA refuses our credentials or producer binding (401 after a refresh, or 403): an operator problem, not a
        // property of the event. Keep every pending event, back off for a long time and never consume an attempt.
        const now = this.now();
        entry.authBlockedAt = now;
        entry.nextAttemptAt = now + this.authBackoff;
        for (const other of due) {
          if (attempted.has(other) || !this.state.pending.includes(other)) continue;
          other.authBlockedAt = now; // do not hammer ASAA once per queued event
          other.nextAttemptAt = now + this.authBackoff;
        }
        return;
      } else {
        delete entry.authBlockedAt;
        entry.attempts += 1;
        if (entry.attempts >= this.maxAttempts) {
          this.state.pending.splice(index, 1);
          this.deadLetter(entry, 'max-attempts');
        } else {
          entry.nextAttemptAt = this.now() + Math.min(this.backoffMax, this.backoffBase * 2 ** (entry.attempts - 1));
        }
      }
    }
  }

  /**
   * 2xx and 409 (already delivered) are success. 5xx, 408, 429 and network or timeout errors are
   * retried with backoff. Every other response, including redirects (never followed, so the
   * bearer token cannot be forwarded) and other 4xx, is permanent.
   *
   * Authentication and producer-binding refusals (401 after the one allowed refresh, and 403 such as
   * producer_not_authorized/producer_mismatch before ASAA's producer mapping is configured) return 'auth':
   * the events stay queued with a long backoff and consume no attempts, so they are never dead-lettered
   * for it. 400/413/422 and other 4xx remain permanent.
   *
   * With client credentials: failing to obtain a token is transient (retry), and a 401 refreshes the
   * token once and re-sends.
   */
  private async send(config: AsaaEventsConfig, envelope: AsaaEventEnvelope): Promise<'delivered' | 'retry' | 'permanent' | 'auth'> {
    const post = async (bearer: string): Promise<number> => {
      const response = await this.fetchImpl(`${config.baseUrl}${EVENTS_PATH}`, {
        method: 'POST',
        redirect: 'manual',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`,
          'X-Request-ID': envelope.correlationId ?? envelope.id,
        },
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      // Drain nothing sensitive; the body is never logged.
      void response.body?.cancel().catch(() => undefined);
      return response.status;
    };
    try {
      let status: number;
      if (this.tokenSource) {
        let bearer: string;
        try {
          bearer = await this.tokenSource.get();
        } catch {
          return 'retry';
        }
        status = await post(bearer);
        if (status === 401) {
          try {
            bearer = await this.tokenSource.get(true);
          } catch {
            return 'retry';
          }
          status = await post(bearer);
          if (status === 401) return 'auth';
        }
      } else {
        status = await post(config.token ?? '');
      }
      if (status >= 200 && status < 300) return 'delivered';
      if (status === 409) return 'delivered';
      if (status === 401 || status === 403) return 'auth';
      if (status >= 500 || status === 408 || status === 429) return 'retry';
      return 'permanent';
    } catch {
      return 'retry';
    }
  }
}
