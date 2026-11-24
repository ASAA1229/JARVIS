/**
 * JARVIS Studio conversation store. One AES-256-GCM encrypted file (EncryptedJsonFile,
 * same scheme as personal memory) holding chats, the owner's persona and settings.
 */
import { randomUUID } from 'node:crypto';
import { EncryptedJsonFile } from '../memory/encryptedJsonFile.js';

export const MAX_CONVERSATIONS = 500;
export const MAX_MESSAGES_PER_CONVERSATION = 400;
export const MAX_MESSAGE_CHARS = 16_000;
export const MAX_TITLE_CHARS = 80;
export const MAX_PERSONA_CHARS = 4000;
export const DEFAULT_TITLE = 'New chat';

export const DEFAULT_PERSONA = 'You are JARVIS, the owner\'s personal assistant. Be concise, accurate and honest about what you do not know. Prefer plain language and give code in fenced blocks.';

export interface StudioMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: number;
  model?: string;
  rating?: 'up' | 'down';
  /** The owner pressed Stop; the text is whatever had streamed so far. */
  stopped?: boolean;
  error?: boolean;
  /** Names of memory/document context used for this reply (never the content). */
  sources?: string[];
}

export interface StudioConversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** Owner opted this conversation into training-data export. */
  useForTraining: boolean;
  messages: StudioMessage[];
}

export interface StudioConversationSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  useForTraining: boolean;
  messageCount: number;
}

interface StudioState {
  version: 1;
  persona: string;
  baseModel: string;
  conversations: Record<string, StudioConversation>;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isStudioId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value);
}

function clampTitle(title: string): string {
  return title.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
}

export class StudioStore {
  private readonly file: EncryptedJsonFile<StudioState>;
  private state: StudioState;

  constructor(path: string, ownerControlToken: string) {
    this.file = new EncryptedJsonFile<StudioState>(path, ownerControlToken, 'jarvis-studio-v1');
    const loaded = this.file.read();
    this.state = loaded && loaded.version === 1 && typeof loaded.conversations === 'object'
      ? loaded
      : { version: 1, persona: '', baseModel: '', conversations: {} };
  }

  private save(): void {
    this.file.write(this.state);
  }

  list(query?: string): StudioConversationSummary[] {
    const needle = query?.trim().toLowerCase().slice(0, 100);
    return Object.values(this.state.conversations)
      .filter((conversation) => !needle || conversation.title.toLowerCase().includes(needle)
        || conversation.messages.some((message) => message.content.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((conversation) => ({
        id: conversation.id, title: conversation.title, createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt, useForTraining: conversation.useForTraining, messageCount: conversation.messages.length,
      }));
  }

  all(): StudioConversation[] {
    return Object.values(this.state.conversations);
  }

  get(id: string): StudioConversation | undefined {
    return this.state.conversations[id];
  }

  create(title?: string): StudioConversation {
    if (Object.keys(this.state.conversations).length >= MAX_CONVERSATIONS) {
      throw new Error(`At most ${MAX_CONVERSATIONS} conversations are kept; delete one first.`);
    }
    const now = Date.now();
    const conversation: StudioConversation = {
      id: randomUUID(), title: clampTitle(title ?? '') || DEFAULT_TITLE, createdAt: now, updatedAt: now, useForTraining: false, messages: [],
    };
    this.state.conversations[conversation.id] = conversation;
    this.save();
    return conversation;
  }

  update(id: string, changes: { title?: string; useForTraining?: boolean }): StudioConversation | undefined {
    const conversation = this.state.conversations[id];
    if (!conversation) return undefined;
    if (changes.title !== undefined) {
      const title = clampTitle(changes.title);
      if (!title) throw new Error('Title cannot be empty.');
      conversation.title = title;
    }
    if (changes.useForTraining !== undefined) conversation.useForTraining = changes.useForTraining;
    this.save();
    return conversation;
  }

  delete(id: string): boolean {
    if (!this.state.conversations[id]) return false;
    delete this.state.conversations[id];
    this.save();
    return true;
  }

  appendMessage(id: string, message: Omit<StudioMessage, 'id' | 'createdAt'>): StudioMessage {
    const conversation = this.state.conversations[id];
    if (!conversation) throw new Error('Conversation not found');
    if (conversation.messages.length >= MAX_MESSAGES_PER_CONVERSATION) throw new Error('This conversation is full; start a new chat.');
    const stored: StudioMessage = { ...message, content: message.content.slice(0, MAX_MESSAGE_CHARS), id: randomUUID(), createdAt: Date.now() };
    conversation.messages.push(stored);
    conversation.updatedAt = stored.createdAt;
    if (conversation.title === DEFAULT_TITLE && stored.role === 'user') {
      conversation.title = clampTitle(stored.content.split('\n')[0] ?? '').slice(0, 48) || DEFAULT_TITLE;
    }
    this.save();
    return stored;
  }

  rate(id: string, messageId: string, rating: 'up' | 'down' | null): StudioMessage | undefined {
    const message = this.state.conversations[id]?.messages.find((item) => item.id === messageId);
    if (!message || message.role !== 'assistant') return undefined;
    if (rating === null) delete message.rating;
    else message.rating = rating;
    this.save();
    return message;
  }

  persona(): string {
    return this.state.persona;
  }

  baseModel(): string {
    return this.state.baseModel;
  }

  setPersona(persona: string, baseModel?: string): void {
    if (persona.length > MAX_PERSONA_CHARS) throw new Error(`Persona is limited to ${MAX_PERSONA_CHARS} characters.`);
    this.state.persona = persona.trim();
    if (baseModel !== undefined) this.state.baseModel = baseModel;
    this.save();
  }
}
