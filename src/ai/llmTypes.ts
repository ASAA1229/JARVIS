/**
 * Shared types for the multi-LLM layer (task routing, fallback, cost control, monitoring).
 * Nothing here holds prompt content or credentials.
 */

export type LlmTaskType = 'chat' | 'code' | 'reasoning' | 'summarize' | 'extract' | 'embed' | 'vision';
export const LLM_TASK_TYPES: readonly LlmTaskType[] = ['chat', 'code', 'reasoning', 'summarize', 'extract', 'embed', 'vision'];

export type LlmProviderId = 'ollama' | 'local-openai' | 'openai' | 'azure-openai' | 'anthropic' | 'gemini';
export const LLM_PROVIDER_IDS: readonly LlmProviderId[] = ['ollama', 'local-openai', 'openai', 'azure-openai', 'anthropic', 'gemini'];

export type LlmCapability = 'chat' | 'code' | 'embeddings' | 'vision';

export interface LlmMessage {
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
  /** Base64 image data (raw or a data: URL) for vision requests. Never stored or logged. */
  images?: string[];
}

export interface LlmOptions {
  temperature?: number;
  json?: boolean;
  maxTokens?: number;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface LlmResult {
  text: string;
  usage?: LlmUsage;
}

export interface LlmChunk {
  text?: string;
  usage?: LlmUsage;
}

export type LlmErrorKind = 'network' | 'timeout' | 'http_error' | 'rate_limited' | 'auth' | 'model_missing' | 'invalid_response' | 'unsupported';

/** Safe error: a kind and HTTP status only. Provider bodies and credentials are never surfaced. */
export class LlmError extends Error {
  constructor(readonly kind: LlmErrorKind, readonly status?: number) {
    super('llm_' + kind);
    this.name = 'LlmError';
  }
}

export interface LlmHealth {
  ok: boolean;
  /** Short safe detail such as "http 401"; never a body. */
  detail?: string;
  latencyMs?: number;
}

export interface LlmBackend {
  readonly id: LlmProviderId;
  readonly label: string;
  /** Loopback inference: private data may be sent here. */
  readonly local: boolean;
  /** Metered cloud API: needs owner authorization and counts against the budget. */
  readonly paid: boolean;
  /** Model used when the router has no better choice (env-configured). */
  readonly defaultModel: string;
  readonly supportsEmbeddings: boolean;
  chat(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): Promise<LlmResult>;
  stream(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): AsyncIterable<LlmChunk>;
  embed(model: string, input: string[], signal: AbortSignal): Promise<{ vectors: number[][]; usage?: LlmUsage }>;
  health(signal: AbortSignal): Promise<LlmHealth>;
}
