/**
 * Learning episode ingestion (E3:D4.17).
 *
 *   POST /api/learning/episodes            ingest key only (scope episodes:post); stores PENDING episodes
 *   GET  /api/learning/episodes            owner session: list (?status=pending|approved|rejected)
 *   POST /api/learning/episodes/approve    owner session {id}
 *   POST /api/learning/episodes/reject     owner session {id}
 *   POST /api/learning/episodes/delete-all owner session {}
 *   GET  /api/learning/recipes             owner session: approved episodes as prompt -> steps -> commands -> outcome
 *   POST /api/learning/search              owner session {query, limit?}: "how did we fix X"
 *   GET  /api/learning/export              owner session: training export (assistant content excluded by default)
 *   GET|POST /api/learning/settings        owner session: allowAssistantContentInExport (default false)
 *   GET  /api/learning/ingest-keys         owner session: list
 *   POST /api/learning/ingest-keys/create  owner session {name, requestsPerMinute?}
 *   POST /api/learning/ingest-keys/revoke  owner session {id}
 *
 * An ingest key is accepted ONLY by the first route. Owner routes need a signed DEVICE_MANAGE session.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLogger } from '../audit/audit.js';
import { Permission, type DeviceRecord } from '../core/types.js';
import { EpisodeStore, EpisodeValidationError, episodeToText, type StoredEpisode } from '../learning/episodeStore.js';
import { IngestKeyStore } from '../learning/ingestKeys.js';

export const LEARNING_COLLECTION = 'dev-episodes';

export interface LearningIngestContext {
  store: EpisodeStore | undefined;
  keys: IngestKeyStore;
  audit: Pick<AuditLogger, 'record'>;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
  /** Index an approved episode into document/RAG knowledge; returns the document id or undefined when unavailable. */
  indexEpisode?: (deviceId: string, stored: StoredEpisode, text: string) => string | undefined;
  /** Remove indexed episode documents (best effort). */
  removeDocuments?: (deviceId: string, documentIds: string[]) => void;
}

export const LEARNING_PREFIX = '/api/learning/';
const MAX_EPISODE_REQUEST_BYTES = 300 * 1024;
let lastAuthFailureAudit = 0;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function presentedIngestKey(req: IncomingMessage): string | undefined {
  const direct = req.headers['x-jarvis-ingest-key'];
  if (typeof direct === 'string') return direct.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return undefined;
}

export async function handleLearningRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: LearningIngestContext): Promise<void> {
  const path = url.pathname;

  // ---------------- ingest: ingest key only ----------------
  if (req.method === 'POST' && path === '/api/learning/episodes') {
    const key = ctx.keys.authenticate(presentedIngestKey(req));
    if (!key) {
      const now = Date.now();
      if (now - lastAuthFailureAudit > 10_000) {
        lastAuthFailureAudit = now;
        ctx.audit.record('LEARNING_INGEST_AUTH_FAILED', {});
      }
      return ctx.json(res, 401, { error: 'A valid ingest key is required' });
    }
    if (!ctx.keys.allow(key)) {
      ctx.audit.record('LEARNING_INGEST_RATE_LIMITED', { keyId: key.id });
      res.setHeader('Retry-After', '60');
      return ctx.json(res, 429, { error: 'Ingest rate limit exceeded' });
    }
    if (!ctx.store) return ctx.json(res, 503, { error: 'Encrypted episode storage is unavailable; configure owner control first' });
    const body = await ctx.readJsonBody(req, MAX_EPISODE_REQUEST_BYTES);
    try {
      const { stored, duplicate } = ctx.store.ingest(body, key.id);
      ctx.keys.recordUsage(key.id, true);
      if (!duplicate) ctx.audit.record('LEARNING_EPISODE_RECEIVED', { episodeId: stored.id, source: stored.episode.source, steps: stored.episode.steps.length, keyId: key.id });
      return ctx.json(res, duplicate ? 200 : 201, { id: stored.id, status: stored.status, duplicate });
    } catch (error) {
      ctx.keys.recordUsage(key.id, false);
      if (error instanceof EpisodeValidationError) return ctx.json(res, 400, { error: error.message });
      throw error;
    }
  }

  // ---------------- owner routes: signed DEVICE_MANAGE session ----------------
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') return ctx.json(res, 401, { error: 'Missing authenticated device session' });
  const body = req.method === 'GET' ? undefined : await ctx.readJsonBody(req);
  if (req.method !== 'GET' && !isObject(body)) return ctx.json(res, 400, { error: 'JSON body must be an object' });
  const auth = ctx.authorize(req, sessionId, path, body);
  if (!auth.valid || !auth.device) return ctx.json(res, 401, { error: auth.error || 'Signed request authentication failed' });
  const device = auth.device;
  if (!device.permissions.includes(Permission.DEVICE_MANAGE)) return ctx.json(res, 403, { error: 'Learning controls require device-management permission' });
  const input = (body ?? {}) as Record<string, unknown>;

  // Ingest-key management does not need episode storage.
  if (req.method === 'GET' && path === '/api/learning/ingest-keys') return ctx.json(res, 200, { keys: ctx.keys.list() });
  if (req.method === 'POST' && path === '/api/learning/ingest-keys/create') {
    try {
      const rpm = input['requestsPerMinute'];
      const { key, ingestKey } = ctx.keys.create(String(input['name'] ?? ''), typeof rpm === 'number' ? rpm : undefined);
      ctx.audit.record('LEARNING_INGEST_KEY_CREATED', { keyId: key.id, name: key.name }, device.id);
      return ctx.json(res, 201, { key, ingestKey, notice: 'The key is shown once and is not stored in plaintext.' });
    } catch (error) {
      return ctx.json(res, 400, { error: error instanceof Error ? error.message : 'Key creation failed' });
    }
  }
  if (req.method === 'POST' && path === '/api/learning/ingest-keys/revoke') {
    try {
      const key = ctx.keys.revoke(String(input['id'] ?? ''));
      ctx.audit.record('LEARNING_INGEST_KEY_REVOKED', { keyId: key.id, name: key.name }, device.id);
      return ctx.json(res, 200, { key });
    } catch (error) {
      return ctx.json(res, 404, { error: error instanceof Error ? error.message : 'Key revoke failed' });
    }
  }

  const store = ctx.store;
  if (!store) return ctx.json(res, 503, { error: 'Encrypted episode storage is unavailable; configure owner control first' });

  if (req.method === 'GET' && path === '/api/learning/episodes') {
    const status = url.searchParams.get('status');
    if (status !== null && !['pending', 'approved', 'rejected'].includes(status)) return ctx.json(res, 400, { error: 'status must be pending, approved or rejected' });
    return ctx.json(res, 200, { episodes: store.list((status ?? undefined) as 'pending' | 'approved' | 'rejected' | undefined) });
  }
  if (req.method === 'POST' && (path === '/api/learning/episodes/approve' || path === '/api/learning/episodes/reject')) {
    const id = input['id'];
    if (typeof id !== 'string') return ctx.json(res, 400, { error: 'id is required' });
    try {
      if (path.endsWith('/approve')) {
        const pending = store.get(id);
        if (!pending) return ctx.json(res, 404, { error: 'No episode with that id.' });
        if (pending.status !== 'pending') return ctx.json(res, 409, { error: `Episode is already ${pending.status}.` });
        let documentId: string | undefined;
        try { documentId = ctx.indexEpisode?.(device.id, pending, episodeToText(pending)); } catch { documentId = undefined; }
        const stored = store.approve(id, documentId);
        ctx.audit.record('LEARNING_EPISODE_APPROVED', { episodeId: id, indexed: Boolean(documentId) }, device.id);
        return ctx.json(res, 200, { id, status: stored.status, indexed: Boolean(documentId) });
      }
      const stored = store.reject(id);
      ctx.audit.record('LEARNING_EPISODE_REJECTED', { episodeId: id }, device.id);
      return ctx.json(res, 200, { id, status: stored.status });
    } catch (error) {
      return ctx.json(res, 409, { error: error instanceof Error ? error.message : 'Decision failed' });
    }
  }
  if (req.method === 'POST' && path === '/api/learning/episodes/delete-all') {
    const { removed, documentIds } = store.deleteAll();
    try { ctx.removeDocuments?.(device.id, documentIds); } catch { /* derived index; the encrypted source is already gone */ }
    ctx.audit.record('LEARNING_EPISODES_DELETED_ALL', { removed }, device.id);
    return ctx.json(res, 200, { removed });
  }
  if (req.method === 'GET' && path === '/api/learning/recipes') return ctx.json(res, 200, { recipes: store.recipes() });
  if (req.method === 'POST' && path === '/api/learning/search') {
    if (typeof input['query'] !== 'string') return ctx.json(res, 400, { error: 'query is required' });
    return ctx.json(res, 200, { results: store.search(input['query'], typeof input['limit'] === 'number' ? input['limit'] : 5) });
  }
  if (req.method === 'GET' && path === '/api/learning/export') {
    ctx.audit.record('LEARNING_EPISODES_EXPORTED', { assistantContentIncluded: store.settings.allowAssistantContentInExport }, device.id);
    res.setHeader('Content-Disposition', `attachment; filename="jarvis-episodes-${new Date().toISOString().slice(0, 10)}.json"`);
    return ctx.json(res, 200, { format: 'jarvis-learning-episodes', version: 1, assistantContentIncluded: store.settings.allowAssistantContentInExport, episodes: store.export() });
  }
  if (path === '/api/learning/settings') {
    if (req.method === 'GET') return ctx.json(res, 200, store.settings);
    if (req.method === 'POST') {
      if (typeof input['allowAssistantContentInExport'] !== 'boolean') return ctx.json(res, 400, { error: 'allowAssistantContentInExport must be boolean' });
      store.setAllowAssistantContentInExport(input['allowAssistantContentInExport']);
      ctx.audit.record('LEARNING_SETTINGS_CHANGED', { allowAssistantContentInExport: input['allowAssistantContentInExport'] }, device.id);
      return ctx.json(res, 200, store.settings);
    }
  }
  return ctx.json(res, 404, { error: 'Unknown learning route' });
}
