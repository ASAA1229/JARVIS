/**
 * Bounded conversation history, encrypted at rest when owner control is configured.
 * Conversations are isolated by authenticated device and contain only visible user/assistant turns.
 */
import { randomUUID } from 'node:crypto';
import { EncryptedJsonFile } from '../memory/encryptedJsonFile.js';

export type ConversationRole = 'user' | 'assistant';
export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  createdAt: number;
}
interface ConversationRecord {
  id: string;
  ownerDeviceId: string;
  messages: ConversationMessage[];
  createdAt: number;
  updatedAt: number;
}
interface PersistedConversationState {
  version: 1;
  sessions: ConversationRecord[];
}

const MAX_SESSIONS = 200;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_CHARACTERS = 12000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ConversationSessionStore {
  private readonly sessions = new Map<string, ConversationRecord>();
  private readonly locks = new Map<string, Promise<void>>();
  private readonly persistence?: EncryptedJsonFile<PersistedConversationState>;

  /**
   * Persistence is enabled only when both a file path and owner token are supplied.
   * Existing callers without owner control retain process-local behavior.
   */
  constructor(filePath?: string, ownerControlToken?: string) {
    if (Boolean(filePath) !== Boolean(ownerControlToken)) {
      throw new Error('Conversation persistence requires both a state path and owner control token.');
    }
    if (filePath && ownerControlToken) {
      this.persistence = new EncryptedJsonFile<PersistedConversationState>(
        filePath,
        ownerControlToken,
        'JARVIS-CONVERSATION-HISTORY-V1',
      );
      this.load();
    }
  }

  private load(): void {
    const payload = this.persistence?.read();
    if (payload === undefined) return;
    if (!payload || payload.version !== 1 || !Array.isArray(payload.sessions) || payload.sessions.length > MAX_SESSIONS) {
      throw new Error('Conversation history could not be validated; persistence is disabled to avoid overwriting data.');
    }
    const now = Date.now();
    for (const record of payload.sessions) {
      if (!this.isValidRecord(record)) {
        throw new Error('Conversation history could not be validated; persistence is disabled to avoid overwriting data.');
      }
      if (now - record.updatedAt <= SESSION_TTL_MS) this.sessions.set(record.id, record);
    }
    if (this.sessions.size !== payload.sessions.length) this.persist();
  }

  private isValidRecord(value: unknown): value is ConversationRecord {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    if (typeof record.id !== 'string' || !CONVERSATION_ID_PATTERN.test(record.id) ||
        typeof record.ownerDeviceId !== 'string' || !record.ownerDeviceId || record.ownerDeviceId.length > 256 ||
        typeof record.createdAt !== 'number' || !Number.isFinite(record.createdAt) ||
        typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt) ||
        !Array.isArray(record.messages) || record.messages.length > MAX_MESSAGES || record.messages.length % 2 !== 0) return false;
    let characters = 0;
    for (let index = 0; index < record.messages.length; index += 1) {
      const message = record.messages[index] as Record<string, unknown>;
      const expectedRole = index % 2 === 0 ? 'user' : 'assistant';
      if (!message || message.role !== expectedRole || typeof message.content !== 'string' ||
          message.content.length > MAX_MESSAGE_LENGTH || typeof message.createdAt !== 'number' ||
          !Number.isFinite(message.createdAt)) return false;
      characters += message.content.length;
    }
    return characters <= MAX_HISTORY_CHARACTERS;
  }

  private persist(): void {
    this.persistence?.write({ version: 1, sessions: [...this.sessions.values()] });
  }

  /**
   * Serializes work for one conversation so concurrent messages cannot read
   * the same stale history and then persist in the wrong order.
   */
  public async runExclusive<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.locks.set(id, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(id) === current) this.locks.delete(id);
    }
  }

  public isValidId(value: unknown): value is string {
    return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
  }

  public getOrCreate(ownerDeviceId: string, requestedId?: string): { id: string; history: ConversationMessage[] } | null {
    const pruned = this.prune();
    const id = requestedId || randomUUID();
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.ownerDeviceId !== ownerDeviceId) {
        if (pruned) this.persist();
        return null;
      }
      existing.updatedAt = Date.now();
      this.sessions.delete(id);
      this.sessions.set(id, existing);
      this.persist();
      return { id, history: existing.messages.map((message) => ({ ...message })) };
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const now = Date.now();
    this.sessions.set(id, { id, ownerDeviceId, messages: [], createdAt: now, updatedAt: now });
    this.persist();
    return { id, history: [] };
  }

  public appendTurn(id: string, ownerDeviceId: string, userText: string, assistantText: string): boolean {
    const record = this.sessions.get(id);
    if (!record || record.ownerDeviceId !== ownerDeviceId || Date.now() - record.updatedAt > SESSION_TTL_MS) return false;
    const now = Date.now();
    record.messages.push(
      { role: 'user', content: userText.slice(0, MAX_MESSAGE_LENGTH), createdAt: now },
      { role: 'assistant', content: assistantText.slice(0, MAX_MESSAGE_LENGTH), createdAt: now },
    );
    while (record.messages.length > MAX_MESSAGES ||
      record.messages.reduce((total, message) => total + message.content.length, 0) > MAX_HISTORY_CHARACTERS) {
      record.messages.splice(0, 2);
    }
    record.updatedAt = now;
    this.persist();
    return true;
  }

  public clear(id: string, ownerDeviceId: string): boolean {
    const record = this.sessions.get(id);
    if (!record || record.ownerDeviceId !== ownerDeviceId) return false;
    this.sessions.delete(id);
    this.persist();
    return true;
  }

  private prune(): boolean {
    const cutoff = Date.now() - SESSION_TTL_MS;
    let changed = false;
    for (const [id, record] of this.sessions) {
      if (record.updatedAt < cutoff) {
        this.sessions.delete(id);
        changed = true;
      }
    }
    return changed;
  }
}
