/**
 * Bounded, process-local conversation history.
 * Conversations are isolated by authenticated device and contain only visible user/assistant turns.
 */
import { randomUUID } from 'node:crypto';

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

const MAX_SESSIONS = 200;
const MAX_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4000;
const MAX_HISTORY_CHARACTERS = 12000;
const SESSION_TTL_MS = 30 * 60 * 1000;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ConversationSessionStore {
  private readonly sessions = new Map<string, ConversationRecord>();

  public isValidId(value: unknown): value is string {
    return typeof value === 'string' && CONVERSATION_ID_PATTERN.test(value);
  }

  public getOrCreate(ownerDeviceId: string, requestedId?: string): { id: string; history: ConversationMessage[] } | null {
    this.prune();
    const id = requestedId || randomUUID();
    const existing = this.sessions.get(id);
    if (existing) {
      if (existing.ownerDeviceId !== ownerDeviceId) return null;
      existing.updatedAt = Date.now();
      // Map insertion order is used for capacity eviction; move active sessions to the end.
      this.sessions.delete(id);
      this.sessions.set(id, existing);
      return { id, history: existing.messages.map((message) => ({ ...message })) };
    }
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const now = Date.now();
    this.sessions.set(id, { id, ownerDeviceId, messages: [], createdAt: now, updatedAt: now });
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
      record.messages.shift();
    }
    record.updatedAt = now;
    return true;
  }

  public clear(id: string, ownerDeviceId: string): boolean {
    const record = this.sessions.get(id);
    if (!record || record.ownerDeviceId !== ownerDeviceId) return false;
    this.sessions.delete(id);
    return true;
  }

  private prune(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, record] of this.sessions) {
      if (record.updatedAt < cutoff) this.sessions.delete(id);
    }
  }
}
