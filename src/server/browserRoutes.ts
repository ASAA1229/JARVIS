/**
 * JARVIS browser extension API (E3:D4.21).
 *
 * Extension routes: a BROWSER KEY only (scope browser:use), loopback only, rate limited, audited.
 *   GET    /api/browser/ext/ping
 *   POST   /api/browser/ext/chat            SSE; {question, pages[], sessionId?, history?, save?}
 *   POST   /api/browser/ext/summarize       {page, save?}
 *   POST   /api/browser/ext/explain         {page, selection?, question?}
 *   POST   /api/browser/ext/extract         {page, structured, question?}
 *   POST   /api/browser/ext/analyze-form    {page, forms}   (field descriptions only, never values)
 *   GET|POST /api/browser/ext/sessions      list / create {name}
 *   GET|PATCH|DELETE /api/browser/ext/sessions/:id
 *   POST   /api/browser/ext/sessions/:id/tabs         {page}
 *   POST   /api/browser/ext/sessions/:id/tabs/remove  {url}
 *   GET|DELETE /api/browser/ext/history     (?limit, ?sessionId)
 * Owner routes: signed DEVICE_MANAGE session (Studio Learning page).
 *   GET    /api/browser/admin/keys            POST .../keys/create {name}   POST .../keys/revoke {id}
 *   GET    /api/browser/admin/pages?status=   POST .../pages/approve|reject {id}   POST .../pages/delete-all
 *   GET    /api/browser/admin/sessions        POST .../sessions/delete {id}
 *
 * A browser key is accepted ONLY by /api/browser/ext/*; owner session routes never accept it and it
 * never reaches any other API. Page content is passed to the local model as untrusted reference data.
 * Pages read through the extension are saved PENDING; only owner approval indexes them as knowledge.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AuditLogger } from '../audit/audit.js';
import { AIProviderError, type AIMessage } from '../ai/aiProvider.js';
import { OllamaProvider } from '../ai/ollamaProvider.js';
import { providerRouter } from '../ai/providerRouter.js';
import { AgentRequestLimiter } from '../conversation/agentRequestLimiter.js';
import { Permission, type DeviceRecord } from '../core/types.js';
import { BrowserKeyStore } from '../browser/browserKeys.js';
import {
  BrowserStore, BrowserValidationError, BROWSING_COLLECTION, pageToText, sanitizePage, sanitizeUrl, type HistoryKind, type PageInput, type StoredPage,
} from '../browser/browserStore.js';
import { buildMessages, MAX_PAGES_PER_REQUEST, MAX_TOTAL_CHARS, type BrowserAction } from '../browser/prompts.js';
import { redactBrowserDeep, redactBrowserText } from '../browser/redaction.js';
import type { StudioProviderHandle } from './studioRoutes.js';

export const BROWSER_PREFIX = '/api/browser/';
const EXT_PREFIX = '/api/browser/ext/';
const ADMIN_PREFIX = '/api/browser/admin/';
const MAX_REQUEST_BYTES = 700 * 1024;
const MAX_STRUCTURED_BYTES = 40 * 1024;
const MAX_QUESTION = 2000;
const MAX_SELECTION = 6000;
const MAX_HISTORY_TURNS = 10;
const LLM_LIMIT_PER_5_MIN = 40;
const EXTENSION_ORIGIN = /^(?:chrome-extension|moz-extension|extension):\/\/[a-z0-9-]{1,64}$/i;
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export interface BrowserRoutesDeps {
  store: BrowserStore | undefined;
  keys: BrowserKeyStore;
  audit: Pick<AuditLogger, 'record'>;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
  /** Index an approved page into the `browsing` document collection; returns the document id when available. */
  indexPage?: (deviceId: string, stored: StoredPage, text: string) => string | undefined;
  removeDocuments?: (deviceId: string, documentIds: string[]) => void;
  /** Search approved browsing knowledge only. */
  searchKnowledge?: (deviceId: string, query: string, limit: number) => Promise<Array<{ content: string; source: { sourceName: string } }>>;
  /** Test seam; the default resolves the router's local Ollama provider. */
  providerFactory?: () => StudioProviderHandle | null;
}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const presentedKey = (req: IncomingMessage): string | undefined => {
  const direct = req.headers['x-jarvis-browser-key'];
  if (typeof direct === 'string') return direct.trim();
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  return undefined;
};

/** Remove any field value a form description could carry: the assistant never sees what the user typed. */
export function stripFormValues<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => stripFormValues(item)) as unknown as T;
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (/^(value|defaultValue|checked|selectedValue|currentValue)$/i.test(key)) continue;
      out[key] = stripFormValues(item);
    }
    return out as T;
  }
  return value;
}

function clampPages(pages: PageInput[]): PageInput[] {
  let budget = MAX_TOTAL_CHARS;
  return pages.slice(0, MAX_PAGES_PER_REQUEST).map((page) => {
    const text = page.text.slice(0, Math.max(0, budget));
    budget -= text.length;
    return { ...page, text };
  });
}

export class BrowserRoutes {
  private readonly limiter = new AgentRequestLimiter(LLM_LIMIT_PER_5_MIN);
  private readonly active = new Map<string, AbortController>();
  private lastAuthFailureAudit = 0;

  constructor(private deps: BrowserRoutesDeps) {}

  setProviderFactory(factory: BrowserRoutesDeps['providerFactory']): void {
    this.deps = { ...this.deps, providerFactory: factory };
  }

  private defaultProvider(): StudioProviderHandle | null {
    const decision = providerRouter.route({ taskType: 'conversation', containsPrivateData: true, formats: ['ollama'] });
    const config = decision.provider;
    if (!config || !config.local) return null;
    return {
      provider: new OllamaProvider({ baseUrl: config.baseUrl, model: config.model, ...(config.timeoutMs ? { timeoutMs: config.timeoutMs } : {}) }),
      model: config.model,
      report: (ok) => (ok ? providerRouter.reportSuccess(config.id) : providerRouter.reportFailure(config.id)),
    };
  }

  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { json } = this.deps;
    const remote = req.socket.remoteAddress || '';
    if (!LOOPBACK_ADDRESSES.has(remote)) {
      this.deps.audit.record('BROWSER_API_REJECTED', { reason: 'non_loopback' });
      return json(res, 403, { error: 'The browser API is loopback only' });
    }
    if (url.pathname.startsWith(EXT_PREFIX)) return this.handleExtension(req, res, url);
    if (url.pathname.startsWith(ADMIN_PREFIX)) return this.handleAdmin(req, res, url);
    return json(res, 404, { error: 'Unknown browser route' });
  }

  // =============================== extension routes (browser key) ===============================

  private applyCors(req: IncomingMessage, res: ServerResponse): boolean {
    const origin = req.headers['origin'];
    if (origin === undefined) return true;
    if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) return false;
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-jarvis-browser-key');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '600');
    return true;
  }

  private async handleExtension(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { json, keys, audit } = this.deps;
    // Web pages may not call this API; only extension origins (or non-browser clients with no Origin) pass.
    if (!this.applyCors(req, res)) return json(res, 403, { error: 'Origin not allowed' });
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const key = keys.authenticate(presentedKey(req));
    if (!key) {
      const now = Date.now();
      if (now - this.lastAuthFailureAudit > 10_000) { this.lastAuthFailureAudit = now; audit.record('BROWSER_AUTH_FAILED', {}); }
      return json(res, 401, { error: 'A valid browser key is required' });
    }
    if (!keys.allow(key)) {
      audit.record('BROWSER_RATE_LIMITED', { keyId: key.id });
      res.setHeader('Retry-After', '60');
      return json(res, 429, { error: 'Browser rate limit exceeded' });
    }
    const store = this.deps.store;
    const path = url.pathname.slice(EXT_PREFIX.length);
    if (method === 'GET' && path === 'ping') { keys.recordUsage(key.id, true); return json(res, 200, { ok: true, scope: key.scope, storage: Boolean(store) }); }
    if (!store) return json(res, 503, { error: 'Encrypted browser storage is unavailable; configure owner control first' });

    const hasBody = method === 'POST' || method === 'PATCH';
    let body: Record<string, unknown> = {};
    if (hasBody) {
      const raw = await this.deps.readJsonBody(req, MAX_REQUEST_BYTES);
      if (!isObject(raw)) return json(res, 400, { error: 'JSON body must be an object' });
      body = raw;
    }
    try {
      const done = await this.routeExtension(req, res, method, path, body, store, key.id, url);
      keys.recordUsage(key.id, done !== false);
    } catch (error) {
      keys.recordUsage(key.id, false);
      if (error instanceof BrowserValidationError) return json(res, 400, { error: error.message });
      throw error;
    }
  }

  /** Returns false when the request was rejected (counts against the key's rejected usage). */
  private async routeExtension(req: IncomingMessage, res: ServerResponse, method: string, path: string, body: Record<string, unknown>, store: BrowserStore, keyId: string, url: URL): Promise<boolean> {
    const { json, audit } = this.deps;

    if (method === 'POST' && (path === 'chat' || path === 'summarize' || path === 'explain' || path === 'extract' || path === 'analyze-form')) {
      return this.ask(req, res, path as BrowserAction, body, store, keyId);
    }

    if (path === 'sessions') {
      if (method === 'GET') { json(res, 200, { sessions: store.listSessions() }); return true; }
      if (method === 'POST') {
        const session = store.createSession(body['name']);
        audit.record('BROWSER_SESSION_CREATED', { sessionId: session.id, keyId });
        json(res, 201, { session });
        return true;
      }
    }
    const sessionMatch = /^sessions\/([a-f0-9]{12})(?:\/(tabs|tabs\/remove))?$/.exec(path);
    if (sessionMatch) {
      const id = sessionMatch[1]!;
      const sub = sessionMatch[2];
      const session = store.getSession(id);
      if (!session) { json(res, 404, { error: 'Session not found' }); return false; }
      if (!sub) {
        if (method === 'GET') { json(res, 200, { session }); return true; }
        if (method === 'PATCH') { json(res, 200, { session: store.renameSession(id, body['name']) }); return true; }
        if (method === 'DELETE') {
          store.deleteSession(id);
          audit.record('BROWSER_SESSION_DELETED', { sessionId: id, keyId });
          json(res, 200, { success: true });
          return true;
        }
      } else if (method === 'POST' && sub === 'tabs') {
        const page = sanitizePage(body['page']);
        const saved = store.savePending(page, keyId);
        const updated = store.addTab(id, { url: page.url, title: page.title, pageId: saved?.page.id ?? '' });
        audit.record('BROWSER_TAB_ADDED', { sessionId: id, keyId, savedPending: Boolean(saved && !saved.duplicate) });
        json(res, 200, { session: updated, saved: Boolean(saved), status: saved?.page.status ?? null });
        return true;
      } else if (method === 'POST' && sub === 'tabs/remove') {
        const target = sanitizeUrl(body['url']);
        json(res, 200, { session: store.removeTab(id, target) });
        return true;
      }
    }

    if (path === 'history') {
      if (method === 'GET') {
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        json(res, 200, { history: store.listHistory(Number.isFinite(limit) ? limit : 50, sessionId) });
        return true;
      }
      if (method === 'DELETE') {
        const removed = store.clearHistory();
        audit.record('BROWSER_HISTORY_CLEARED', { removed, keyId });
        json(res, 200, { removed });
        return true;
      }
    }
    json(res, 404, { error: 'Unknown browser route' });
    return false;
  }

  /** chat (SSE) and the one-shot actions share page handling, pending save and the local provider. */
  private async ask(req: IncomingMessage, res: ServerResponse, action: BrowserAction, body: Record<string, unknown>, store: BrowserStore, keyId: string): Promise<boolean> {
    const { json, audit } = this.deps;
    const question = optionalText(body['question'], MAX_QUESTION, 'question');
    const selection = optionalText(body['selection'], MAX_SELECTION, 'selection');
    const rawPages = Array.isArray(body['pages']) ? body['pages'] : body['page'] !== undefined ? [body['page']] : [];
    if (rawPages.length > MAX_PAGES_PER_REQUEST) throw new BrowserValidationError(`At most ${MAX_PAGES_PER_REQUEST} pages per request`);
    const pages = rawPages.map(sanitizePage);
    const sessionId = body['sessionId'];
    if (sessionId !== undefined && !BrowserStore.isId(sessionId)) throw new BrowserValidationError('sessionId is invalid');
    if (typeof sessionId === 'string') {
      if (!store.getSession(sessionId)) { json(res, 404, { error: 'Session not found' }); return false; }
      for (const stored of store.sessionPages(sessionId)) {
        if (!pages.some((p) => p.url === stored.url)) pages.push({ url: stored.url, title: stored.title, text: stored.text, headings: stored.headings, meta: stored.meta });
      }
    }
    if (!pages.length) throw new BrowserValidationError('Provide the page (or pages) to read; page content is only read on a user action in the browser.');
    const used = clampPages(pages);

    const extra: Array<{ label: string; content: unknown }> = [];
    if (action === 'extract' || action === 'analyze-form') {
      const field = action === 'extract' ? 'structured' : 'forms';
      const data = body[field];
      if (data === undefined) throw new BrowserValidationError(`${field} is required`);
      const cleaned = redactBrowserDeep(action === 'analyze-form' ? stripFormValues(data) : data);
      if (Buffer.byteLength(JSON.stringify(cleaned), 'utf8') > MAX_STRUCTURED_BYTES) throw new BrowserValidationError(`${field} is too large`);
      extra.push({ label: action === 'extract' ? 'Structured data found on the page' : 'Forms found on the page (field descriptions only)', content: cleaned });
    }

    const history = parseHistory(body['history']);
    const limit = this.limiter.consume(keyId);
    if (!limit.allowed) {
      audit.record('BROWSER_RATE_LIMITED', { keyId, scope: 'model' });
      res.setHeader('Retry-After', String(limit.retryAfterSeconds));
      json(res, 429, { error: 'Browser model rate limit reached.', retryAfterSeconds: limit.retryAfterSeconds });
      return false;
    }
    const handle = (this.deps.providerFactory ?? (() => this.defaultProvider()))();
    if (!handle) { json(res, 503, { error: 'No local AI provider is available. Start Ollama and check OLLAMA_URL / OLLAMA_MODEL.' }); return false; }

    // Pages read on a user action are stored PENDING (best effort). They are not knowledge until approved.
    const saveRequested = body['save'] !== false;
    let savedPending = 0;
    if (saveRequested) for (const page of pages) { try { if (store.savePending(page, keyId)) savedPending += 1; } catch { /* storage is best effort */ } }

    // Approved browsing knowledge (owner-approved pages only) supplements the answer.
    const ownerDevice = store.ownerDeviceId;
    if (this.deps.searchKnowledge && ownerDevice && (action === 'chat' || question)) {
      try {
        const hits = await this.deps.searchKnowledge(ownerDevice, question ?? used[0]!.title, 3);
        if (hits.length) extra.push({ label: 'Approved browsing knowledge', content: hits.slice(0, 3).map((h) => ({ source: h.source.sourceName, content: h.content.slice(0, 1200) })) });
      } catch { /* optional */ }
    }

    const messages = buildMessages({ action, pages: used, ...(question ? { question } : {}), ...(selection ? { selection } : {}), history, extra });
    const sources = used.map((page, index) => ({ ref: index + 1, url: page.url, title: page.title }));
    const kind: HistoryKind = action;
    const primary = used[0]!;
    const record = (answer: string) => {
      if (!answer.trim()) return;
      store.addHistory({ kind, url: primary.url, title: primary.title, ...(typeof sessionId === 'string' ? { sessionId } : {}), ...(question ? { question } : {}), answer });
    };
    audit.record('BROWSER_REQUEST', { action, keyId, pages: used.length, savedPending, requestChars: (question ?? '').length, sessionLinked: typeof sessionId === 'string' });

    if (action !== 'chat') {
      try {
        const answer = redactBrowserText(await handle.provider.chat(messages, { temperature: 0.2 }));
        handle.report?.(true);
        record(answer);
        json(res, 200, { action, result: answer, sources, savedPending, model: handle.model });
        return true;
      } catch (error) {
        handle.report?.(false);
        const kindName = error instanceof AIProviderError ? error.kind : 'invalid_response';
        json(res, 502, { error: `The local model did not complete the request (${kindName}). Check that Ollama is running.` });
        return false;
      }
    }

    if (this.active.has(keyId)) { json(res, 409, { error: 'A reply is already streaming for this browser key' }); return false; }
    return this.streamChat(res, handle, messages, sources, savedPending, record, keyId);
  }

  private async streamChat(res: ServerResponse, handle: StudioProviderHandle, messages: AIMessage[], sources: unknown[], savedPending: number, record: (answer: string) => void, keyId: string): Promise<boolean> {
    const controller = new AbortController();
    this.active.set(keyId, controller);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const sse = (event: string, data: unknown) => { if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    sse('meta', { model: handle.model, sources, savedPending });
    let reply = '';
    let failed = false;
    try {
      for await (const chunk of handle.provider.stream(messages, { temperature: 0.4 }, controller.signal)) {
        if (controller.signal.aborted) break;
        const room = 16_000 - reply.length;
        if (room <= 0) break;
        const piece = redactBrowserText(chunk.slice(0, room));
        reply += piece;
        sse('delta', { text: piece });
      }
      if (!controller.signal.aborted) handle.report?.(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        failed = true;
        handle.report?.(false);
        const kindName = error instanceof AIProviderError ? error.kind : 'invalid_response';
        sse('error', { error: `The local model did not complete the reply (${kindName}). Check that Ollama is running.` });
      }
    } finally {
      this.active.delete(keyId);
    }
    if (!failed) { record(reply); sse('done', { stopped: controller.signal.aborted }); }
    if (!res.writableEnded) res.end();
    return !failed;
  }

  // =============================== owner routes (signed session) ===============================

  private async handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const { json, keys, audit } = this.deps;
    const sessionId = req.headers['x-session-id'];
    if (typeof sessionId !== 'string') return json(res, 401, { error: 'Missing authenticated device session' });
    const method = req.method ?? 'GET';
    const body = method === 'GET' ? undefined : await this.deps.readJsonBody(req);
    if (method !== 'GET' && !isObject(body)) return json(res, 400, { error: 'JSON body must be an object' });
    const auth = this.deps.authorize(req, sessionId, url.pathname, body);
    if (!auth.valid || !auth.device) return json(res, 401, { error: auth.error || 'Signed request authentication failed' });
    const device = auth.device;
    if (!device.permissions.includes(Permission.DEVICE_MANAGE)) return json(res, 403, { error: 'Browser controls require device-management permission' });
    const input = (body ?? {}) as Record<string, unknown>;
    const path = url.pathname.slice(ADMIN_PREFIX.length);

    if (method === 'GET' && path === 'keys') return json(res, 200, { keys: keys.list() });
    if (method === 'POST' && path === 'keys/create') {
      try {
        const rpm = input['requestsPerMinute'];
        const { key, browserKey } = keys.create(String(input['name'] ?? ''), typeof rpm === 'number' ? rpm : undefined);
        audit.record('BROWSER_KEY_CREATED', { keyId: key.id, name: key.name }, device.id);
        return json(res, 201, { key, browserKey, notice: 'The key is shown once and is not stored in plaintext.' });
      } catch (error) {
        return json(res, 400, { error: error instanceof Error ? error.message : 'Key creation failed' });
      }
    }
    if (method === 'POST' && path === 'keys/revoke') {
      try {
        const key = keys.revoke(String(input['id'] ?? ''));
        audit.record('BROWSER_KEY_REVOKED', { keyId: key.id, name: key.name }, device.id);
        return json(res, 200, { key });
      } catch (error) {
        return json(res, 404, { error: error instanceof Error ? error.message : 'Key revoke failed' });
      }
    }

    const store = this.deps.store;
    if (!store) return json(res, 503, { error: 'Encrypted browser storage is unavailable; configure owner control first' });

    if (method === 'GET' && path === 'pages') {
      const status = url.searchParams.get('status');
      if (status !== null && !['pending', 'approved', 'rejected'].includes(status)) return json(res, 400, { error: 'status must be pending, approved or rejected' });
      return json(res, 200, { pages: store.listPages((status ?? undefined) as 'pending' | 'approved' | 'rejected' | undefined) });
    }
    if (method === 'POST' && (path === 'pages/approve' || path === 'pages/reject')) {
      const id = input['id'];
      if (typeof id !== 'string') return json(res, 400, { error: 'id is required' });
      try {
        if (path === 'pages/approve') {
          const pending = store.getPage(id);
          if (!pending) return json(res, 404, { error: 'No page with that id.' });
          if (pending.status !== 'pending') return json(res, 409, { error: `Page is already ${pending.status}.` });
          let documentId: string | undefined;
          try { documentId = this.deps.indexPage?.(device.id, pending, pageToText(pending)); } catch { documentId = undefined; }
          const stored = store.approvePage(id, device.id, documentId);
          audit.record('BROWSER_PAGE_APPROVED', { pageId: id, indexed: Boolean(documentId) }, device.id);
          return json(res, 200, { id, status: stored.status, indexed: Boolean(documentId) });
        }
        const stored = store.rejectPage(id);
        audit.record('BROWSER_PAGE_REJECTED', { pageId: id }, device.id);
        return json(res, 200, { id, status: stored.status });
      } catch (error) {
        return json(res, 409, { error: error instanceof Error ? error.message : 'Decision failed' });
      }
    }
    if (method === 'POST' && path === 'pages/delete-all') {
      const { removed, documentIds } = store.deleteAllPages();
      try { this.deps.removeDocuments?.(device.id, documentIds); } catch { /* derived index; the encrypted source is already gone */ }
      audit.record('BROWSER_PAGES_DELETED_ALL', { removed }, device.id);
      return json(res, 200, { removed });
    }
    if (method === 'GET' && path === 'sessions') return json(res, 200, { sessions: store.listSessions() });
    if (method === 'POST' && path === 'sessions/delete') {
      const id = input['id'];
      if (typeof id !== 'string' || !store.deleteSession(id)) return json(res, 404, { error: 'No session with that id.' });
      audit.record('BROWSER_SESSION_DELETED', { sessionId: id }, device.id);
      return json(res, 200, { success: true });
    }
    return json(res, 404, { error: 'Unknown browser route' });
  }
}

function optionalText(value: unknown, max: number, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new BrowserValidationError(`${name} must be a string up to ${max} characters`);
  const text = redactBrowserText(value.trim());
  return text || undefined;
}

function parseHistory(value: unknown): Array<{ role: 'user' | 'assistant'; content: string }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BrowserValidationError('history must be an array');
  return value.slice(-MAX_HISTORY_TURNS).flatMap((turn) => {
    if (!isObject(turn) || (turn['role'] !== 'user' && turn['role'] !== 'assistant') || typeof turn['content'] !== 'string') return [];
    return [{ role: turn['role'] as 'user' | 'assistant', content: redactBrowserText(turn['content'].slice(0, 4000)) }];
  });
}

export { BROWSING_COLLECTION };
