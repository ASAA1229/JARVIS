export type AIMessageRole = 'system' | 'developer' | 'user' | 'assistant';

export interface AIMessage {
  role: AIMessageRole;
  content: string;
}

export interface AIChatOptions {
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
}

export type AIProviderErrorKind = 'network' | 'timeout' | 'http_error' | 'rate_limited' | 'invalid_response';

export class AIProviderError extends Error {
  constructor(readonly kind: AIProviderErrorKind, readonly status?: number) {
    super('ai_provider_' + kind);
    this.name = 'AIProviderError';
  }
}

export interface AIProviderHealth {
  available: boolean;
  modelAvailable: boolean;
  model: string;
  version?: string;
  embeddingModel?: string;
  embeddingModelAvailable?: boolean;
}

export interface AIProvider {
  readonly id: string;
  readonly model: string;
  chat(messages: AIMessage[], options?: AIChatOptions, signal?: AbortSignal): Promise<string>;
  stream(messages: AIMessage[], options?: AIChatOptions, signal?: AbortSignal): AsyncIterable<string>;
  healthCheck(signal?: AbortSignal): Promise<AIProviderHealth>;
}
