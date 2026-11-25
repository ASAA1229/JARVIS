/**
 * Encrypted browsing store (E3:D4.21): pending/approved/rejected "browsing knowledge" pages, research
 * sessions and research history. Lives in JARVIS (EncryptedJsonFile), never in the browser.
 *
 * Pages arrive PENDING. Only owner-approved pages are indexed into the document-RAG collection
 * `browsing` and become searchable knowledge; nothing is learned without approval.
 */
import { createHash, randomBytes } from 'node:crypto';
import { EncryptedJsonFile } from '../memory/encryptedJsonFile.js';
import { redactBrowserText } from './redaction.js';

export const BROWSING_COLLECTION = 'browsing';
export type PageStatus = 'pending' | 'approved' | 'rejected';
export type HistoryKind = 'chat' | 'summarize' | 'explain' | 'extract' | 'analyze-form';

export class BrowserValidationError extends Error {}

export interface PageMeta {
  description?: string; canonical?: string; author?: string; published?: string; modified?: string; siteName?: string;
}
export interface PageInput { url: string; title: string; text: string; headings: string[]; meta: PageMeta }
export interface StoredPage extends PageInput {
  id: string; receivedAt: string; status: PageStatus; keyId: string; decidedAt?: string; documentId?: string;
}
export interface SessionTab { url: string; title: string; pageId: string; addedAt: string }
export interface ResearchSession { id: string; name: string; createdAt: string; updatedAt: string; tabs: SessionTab[] }
export interface HistoryEntry {
  id: string; at: string; kind: HistoryKind; url?: string; title?: string; sessionId?: string; question?: string; answer: string;
}

interface Payload { version: 1; ownerDeviceId?: string; pages: StoredPage[]; sessions: ResearchSession[]; history: HistoryEntry[] }

export const MAX_PAGES = 1000;
export const MAX_SESSIONS = 100;
export const MAX_TABS = 20;
export const MAX_HISTORY = 300;
export const LIMITS = { text: 20_000, title: 200, url: 500, heading: 200, headings: 40, metaField: 300, name: 80, question: 500, answer: 4000 };

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) : value);
const newId = () => randomBytes(6).toString('hex');
const ID = /^[a-f0-9]{12}$/;

/** Page URLs are stored without query string or fragment: those often carry tokens and identifiers. */
export function sanitizeUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 2048) throw new BrowserValidationError('url must be an http(s) URL');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new BrowserValidationError('url must be an http(s) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new BrowserValidationError('url must be an http(s) URL');
  return clip(`${parsed.origin}${parsed.pathname}`, LIMITS.url);
}

function metaString(source: Record<string, unknown>, key: keyof PageMeta): string | undefined {
  const v = source[key];
  if (typeof v !== 'string' || !v.trim()) return undefined;
  return redactBrowserText(clip(v.trim(), LIMITS.metaField));
}

/** Validate, bound and redact a page sent by the extension. Never keeps form values or unknown fields. */
export function sanitizePage(raw: unknown): PageInput {
  if (!isObject(raw)) throw new BrowserValidationError('page must be an object');
  const url = sanitizeUrl(raw['url']);
  const title = typeof raw['title'] === 'string' ? redactBrowserText(clip(raw['title'].trim(), LIMITS.title)) : '';
  const text = typeof raw['text'] === 'string' ? redactBrowserText(clip(raw['text'], LIMITS.text)) : '';
  const headings = Array.isArray(raw['headings'])
    ? raw['headings'].filter((h): h is string => typeof h === 'string').slice(0, LIMITS.headings).map((h) => redactBrowserText(clip(h, LIMITS.heading)))
    : [];
  const meta: PageMeta = {};
  if (isObject(raw['meta'])) {
    for (const key of ['description', 'canonical', 'author', 'published', 'modified', 'siteName'] as const) {
      const v = metaString(raw['meta'], key);
      if (v !== undefined) meta[key] = key === 'canonical' ? safeCanonical(v) : v;
    }
  }
  return { url, title, text, headings, meta };
}

function safeCanonical(value: string): string {
  try { return sanitizeUrl(value); } catch { return ''; }
}

export function pageToText(page: StoredPage): string {
  const lines = [`${page.title || page.url}`, `URL: ${page.url}`];
  if (page.meta.author) lines.push(`Author: ${page.meta.author}`);
  if (page.meta.published) lines.push(`Published: ${page.meta.published}`);
  if (page.headings.length) lines.push('Headings: ' + page.headings.slice(0, 15).join(' | '));
  lines.push('', page.text);
  return lines.join('\n');
}

export class BrowserStore {
  private readonly file: EncryptedJsonFile<Payload>;
  private payload: Payload = { version: 1, pages: [], sessions: [], history: [] };

  constructor(filePath: string, ownerControlToken: string) {
    this.file = new EncryptedJsonFile<Payload>(filePath, ownerControlToken, 'JARVIS-BROWSER-KNOWLEDGE-V1');
    const loaded = this.file.read();
    if (loaded !== undefined) {
      if (!loaded || loaded.version !== 1 || !Array.isArray(loaded.pages) || !Array.isArray(loaded.sessions) || !Array.isArray(loaded.history) || loaded.pages.length > MAX_PAGES) {
        throw new Error('Browser store failed validation; refusing to overwrite it.');
      }
      this.payload = { version: 1, ...(loaded.ownerDeviceId ? { ownerDeviceId: loaded.ownerDeviceId } : {}), pages: loaded.pages, sessions: loaded.sessions, history: loaded.history };
    }
  }

  // ---------------- pages ----------------

  /** Store a read page as PENDING (deduplicated by URL + content). Returns undefined when the store is full. */
  savePending(input: PageInput, keyId: string): { page: StoredPage; duplicate: boolean } | undefined {
    const id = createHash('sha256').update(input.url + '\n' + input.text).digest('hex').slice(0, 32);
    const existing = this.payload.pages.find((p) => p.id === id);
    if (existing) return { page: structuredClone(existing), duplicate: true };
    if (this.payload.pages.length >= MAX_PAGES) {
      const oldestRejected = this.payload.pages.findIndex((p) => p.status === 'rejected');
      if (oldestRejected < 0) return undefined;
      this.payload.pages.splice(oldestRejected, 1);
    }
    const page: StoredPage = { ...input, id, receivedAt: new Date().toISOString(), status: 'pending', keyId };
    this.payload.pages.push(page);
    this.persist();
    return { page: structuredClone(page), duplicate: false };
  }

  listPages(status?: PageStatus): StoredPage[] {
    return this.payload.pages.filter((p) => status === undefined || p.status === status).map((p) => structuredClone(p));
  }

  getPage(id: string): StoredPage | undefined {
    const found = this.payload.pages.find((p) => p.id === id);
    return found ? structuredClone(found) : undefined;
  }

  approvePage(id: string, deviceId: string, documentId?: string): StoredPage {
    const found = this.mustFindPending(id);
    found.status = 'approved';
    found.decidedAt = new Date().toISOString();
    if (documentId) found.documentId = documentId;
    this.payload.ownerDeviceId = deviceId;
    this.persist();
    return structuredClone(found);
  }

  /** Reject drops the page body; only url, title and the decision remain. */
  rejectPage(id: string): StoredPage {
    const found = this.mustFindPending(id);
    found.status = 'rejected';
    found.decidedAt = new Date().toISOString();
    found.text = '';
    found.headings = [];
    found.meta = {};
    this.persist();
    return structuredClone(found);
  }

  deleteAllPages(): { removed: number; documentIds: string[] } {
    const documentIds = this.payload.pages.flatMap((p) => (p.documentId ? [p.documentId] : []));
    const removed = this.payload.pages.length;
    this.payload.pages = [];
    for (const session of this.payload.sessions) for (const tab of session.tabs) tab.pageId = '';
    this.persist();
    return { removed, documentIds };
  }

  /** Device whose document library holds approved browsing knowledge (set at approval time). */
  get ownerDeviceId(): string | undefined { return this.payload.ownerDeviceId; }

  // ---------------- sessions ----------------

  listSessions(): ResearchSession[] { return this.payload.sessions.map((s) => structuredClone(s)); }

  getSession(id: string): ResearchSession | undefined {
    const found = this.payload.sessions.find((s) => s.id === id);
    return found ? structuredClone(found) : undefined;
  }

  createSession(name: unknown): ResearchSession {
    const clean = cleanName(name);
    if (this.payload.sessions.length >= MAX_SESSIONS) throw new BrowserValidationError('Session limit reached; delete a session first.');
    const now = new Date().toISOString();
    const session: ResearchSession = { id: newId(), name: clean, createdAt: now, updatedAt: now, tabs: [] };
    this.payload.sessions.push(session);
    this.persist();
    return structuredClone(session);
  }

  renameSession(id: string, name: unknown): ResearchSession {
    const session = this.mustFindSession(id);
    session.name = cleanName(name);
    session.updatedAt = new Date().toISOString();
    this.persist();
    return structuredClone(session);
  }

  deleteSession(id: string): boolean {
    const index = this.payload.sessions.findIndex((s) => s.id === id);
    if (index < 0) return false;
    this.payload.sessions.splice(index, 1);
    this.persist();
    return true;
  }

  addTab(sessionId: string, tab: { url: string; title: string; pageId: string }): ResearchSession {
    const session = this.mustFindSession(sessionId);
    const existing = session.tabs.find((t) => t.url === tab.url);
    if (existing) { existing.title = tab.title; existing.pageId = tab.pageId; }
    else {
      if (session.tabs.length >= MAX_TABS) throw new BrowserValidationError(`A session holds at most ${MAX_TABS} tabs.`);
      session.tabs.push({ ...tab, addedAt: new Date().toISOString() });
    }
    session.updatedAt = new Date().toISOString();
    this.persist();
    return structuredClone(session);
  }

  removeTab(sessionId: string, url: string): ResearchSession {
    const session = this.mustFindSession(sessionId);
    session.tabs = session.tabs.filter((t) => t.url !== url);
    session.updatedAt = new Date().toISOString();
    this.persist();
    return structuredClone(session);
  }

  /** Pages (pending or approved, never rejected) linked from a session's tabs, for cross-tab chat context. */
  sessionPages(sessionId: string): StoredPage[] {
    const session = this.payload.sessions.find((s) => s.id === sessionId);
    if (!session) return [];
    return session.tabs.flatMap((tab) => {
      const page = this.payload.pages.find((p) => p.id === tab.pageId && p.status !== 'rejected');
      return page ? [structuredClone(page)] : [];
    });
  }

  // ---------------- history ----------------

  addHistory(entry: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
    const stored: HistoryEntry = {
      id: newId(), at: new Date().toISOString(), kind: entry.kind,
      ...(entry.url ? { url: entry.url } : {}), ...(entry.title ? { title: clip(entry.title, LIMITS.title) } : {}),
      ...(entry.sessionId ? { sessionId: entry.sessionId } : {}),
      ...(entry.question ? { question: redactBrowserText(clip(entry.question, LIMITS.question)) } : {}),
      answer: redactBrowserText(clip(entry.answer, LIMITS.answer)),
    };
    this.payload.history.push(stored);
    if (this.payload.history.length > MAX_HISTORY) this.payload.history.splice(0, this.payload.history.length - MAX_HISTORY);
    this.persist();
    return structuredClone(stored);
  }

  listHistory(limit = 50, sessionId?: string): HistoryEntry[] {
    const rows = this.payload.history.filter((h) => sessionId === undefined || h.sessionId === sessionId);
    return rows.slice(-Math.min(Math.max(limit, 1), MAX_HISTORY)).reverse().map((h) => structuredClone(h));
  }

  clearHistory(): number {
    const removed = this.payload.history.length;
    this.payload.history = [];
    this.persist();
    return removed;
  }

  static isId(value: unknown): value is string { return typeof value === 'string' && ID.test(value); }

  private mustFindPending(id: string): StoredPage {
    const found = this.payload.pages.find((p) => p.id === id);
    if (!found) throw new BrowserValidationError('No page with that id.');
    if (found.status !== 'pending') throw new BrowserValidationError(`Page is already ${found.status}.`);
    return found;
  }

  private mustFindSession(id: string): ResearchSession {
    const found = this.payload.sessions.find((s) => s.id === id);
    if (!found) throw new BrowserValidationError('No session with that id.');
    return found;
  }

  private persist(): void { this.file.write(this.payload); }
}

function cleanName(name: unknown): string {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > LIMITS.name) throw new BrowserValidationError(`name must be 1-${LIMITS.name} characters`);
  return redactBrowserText(name.trim());
}
