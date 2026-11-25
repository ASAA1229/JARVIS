/**
 * HTTP backends for the multi-LLM layer. fetch only; no SDK dependencies.
 *
 * Credentials: cloud API keys come from the environment only (see providerEnv.ts for the variable
 * names), are placed in request headers (never URLs), are never logged and are never returned to
 * any UI. Errors carry a kind and status only, never a provider body.
 */
import {
  LlmError,
  type LlmBackend, type LlmChunk, type LlmHealth, type LlmMessage, type LlmOptions, type LlmResult, type LlmUsage,
} from './llmTypes.js';

type FetchImpl = typeof fetch;

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_BYTES = 4 * 1024 * 1024;
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function assertModelName(model: string): void {
  if (!NAME_PATTERN.test(model)) throw new LlmError('model_missing');
}

function classifyStatus(status: number): LlmError {
  if (status === 429) return new LlmError('rate_limited', status);
  if (status === 401 || status === 403) return new LlmError('auth', status);
  if (status === 404) return new LlmError('model_missing', status);
  return new LlmError('http_error', status);
}

async function send(fetchImpl: FetchImpl, url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let response: Response;
  try {
    response = await fetchImpl(url, { ...init, redirect: 'error', signal });
  } catch {
    throw new LlmError(signal.aborted ? 'timeout' : 'network');
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw classifyStatus(response.status);
  }
  return response;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const declared = response.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new LlmError('invalid_response');
  }
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new LlmError('network');
  }
  if (!text || text.length > MAX_BODY_BYTES) throw new LlmError('invalid_response');
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fall through */ }
  throw new LlmError('invalid_response');
}

/** Yield each complete line of a streamed body (bounded). */
async function* lines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new LlmError('invalid_response');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    while (true) {
      let part: { done: boolean; value?: Uint8Array };
      try {
        part = await reader.read();
      } catch {
        throw new LlmError('network');
      }
      if (part.done) break;
      total += part.value?.byteLength ?? 0;
      if (total > MAX_STREAM_BYTES) throw new LlmError('invalid_response');
      buffer += decoder.decode(part.value ?? new Uint8Array(), { stream: true });
      if (buffer.length > 512 * 1024 && !buffer.includes('\n')) throw new LlmError('invalid_response');
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) yield buffer.replace(/\r$/, '');
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Server-sent events: yield parsed JSON of each `data:` line; stops at [DONE]. */
async function* sseJson(response: Response): AsyncGenerator<Record<string, unknown>> {
  for await (const line of lines(response)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data) continue;
    if (data === '[DONE]') return;
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>;
    } catch {
      throw new LlmError('invalid_response');
    }
  }
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function usage(input: unknown, output: unknown): LlmUsage | undefined {
  const inputTokens = num(input);
  const outputTokens = num(output);
  if (inputTokens === undefined && outputTokens === undefined) return undefined;
  return { ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function first(value: unknown): Record<string, unknown> {
  return asRecord(Array.isArray(value) ? value[0] : undefined);
}

function splitDataUrl(image: string): { mime: string; data: string } {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.+)$/i.exec(image);
  return match ? { mime: match[1]!.toLowerCase(), data: match[2]! } : { mime: 'image/png', data: image };
}

async function timedHealth(run: () => Promise<string | undefined>): Promise<LlmHealth> {
  const start = Date.now();
  try {
    const detail = await run();
    return { ok: true, ...(detail ? { detail } : {}), latencyMs: Date.now() - start };
  } catch (error) {
    const kind = error instanceof LlmError ? error.kind + (error.status ? ' ' + error.status : '') : 'error';
    return { ok: false, detail: kind, latencyMs: Date.now() - start };
  }
}

export interface BaseBackendConfig {
  baseUrl: string;
  defaultModel: string;
  apiKey?: string;
  fetchImpl?: FetchImpl;
}

abstract class BaseBackend {
  protected readonly fetchImpl: FetchImpl;
  protected readonly baseUrl: string;
  protected readonly apiKey: string | undefined;
  readonly defaultModel: string;

  constructor(config: BaseBackendConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.defaultModel = config.defaultModel;
  }
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions format: OpenAI, Azure OpenAI and local OpenAI-compatible servers
// (LM Studio, llama.cpp server, vLLM).
// ---------------------------------------------------------------------------

export interface OpenAiBackendConfig extends BaseBackendConfig {
  id: 'openai' | 'azure-openai' | 'local-openai';
  label: string;
  /** Azure only: api-version query value (verify the currently supported version). */
  apiVersion?: string;
}

function openAiContent(message: LlmMessage): unknown {
  if (!message.images?.length) return message.content;
  return [
    { type: 'text', text: message.content },
    ...message.images.map((image) => {
      const { mime, data } = splitDataUrl(image);
      return { type: 'image_url', image_url: { url: `data:${mime};base64,${data}` } };
    }),
  ];
}

export class OpenAiBackend extends BaseBackend implements LlmBackend {
  readonly id: OpenAiBackendConfig['id'];
  readonly label: string;
  readonly local: boolean;
  readonly paid: boolean;
  readonly supportsEmbeddings = true;
  private readonly apiVersion: string | undefined;

  constructor(config: OpenAiBackendConfig) {
    super(config);
    this.id = config.id;
    this.label = config.label;
    this.local = config.id === 'local-openai';
    this.paid = !this.local;
    this.apiVersion = config.apiVersion;
  }

  private url(path: string, model: string): string {
    if (this.id === 'azure-openai') {
      return `${this.baseUrl}/openai/deployments/${encodeURIComponent(model)}${path}?api-version=${encodeURIComponent(this.apiVersion ?? '2024-10-21')}`;
    }
    return this.baseUrl + path;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) {
      if (this.id === 'azure-openai') headers['api-key'] = this.apiKey;
      else headers['Authorization'] = 'Bearer ' + this.apiKey;
    }
    return headers;
  }

  private body(model: string, messages: LlmMessage[], options: LlmOptions, stream: boolean): string {
    const limitKey = this.id === 'local-openai' ? 'max_tokens' : 'max_completion_tokens';
    return JSON.stringify({
      // Azure routes by deployment in the URL.
      ...(this.id === 'azure-openai' ? {} : { model }),
      messages: messages.map((message) => ({ role: message.role === 'developer' ? 'system' : message.role, content: openAiContent(message) })),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.maxTokens !== undefined ? { [limitKey]: options.maxTokens } : {}),
      ...(options.json ? { response_format: { type: 'json_object' } } : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    });
  }

  async chat(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): Promise<LlmResult> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.url('/chat/completions', model), { method: 'POST', headers: this.headers(), body: this.body(model, messages, options, false) }, signal);
    const payload = await readJson(response);
    const content = asRecord(first(payload['choices'])['message'])['content'];
    if (typeof content !== 'string') throw new LlmError('invalid_response');
    const u = asRecord(payload['usage']);
    const parsed = usage(u['prompt_tokens'], u['completion_tokens']);
    return { text: content, ...(parsed ? { usage: parsed } : {}) };
  }

  async *stream(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): AsyncGenerator<LlmChunk> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.url('/chat/completions', model), { method: 'POST', headers: this.headers(), body: this.body(model, messages, options, true) }, signal);
    for await (const event of sseJson(response)) {
      const delta = asRecord(first(event['choices'])['delta'])['content'];
      if (typeof delta === 'string' && delta) yield { text: delta };
      const u = asRecord(event['usage']);
      const parsed = usage(u['prompt_tokens'], u['completion_tokens']);
      if (parsed) yield { usage: parsed };
    }
  }

  async embed(model: string, input: string[], signal: AbortSignal): Promise<{ vectors: number[][]; usage?: LlmUsage }> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.url('/embeddings', model), {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ ...(this.id === 'azure-openai' ? {} : { model }), input }),
    }, signal);
    const payload = await readJson(response);
    const data = Array.isArray(payload['data']) ? payload['data'] : [];
    const vectors = data.map((item) => asRecord(item)['embedding']).filter((v): v is number[] => Array.isArray(v));
    if (vectors.length !== input.length) throw new LlmError('invalid_response');
    const parsed = usage(asRecord(payload['usage'])['prompt_tokens'], 0);
    return { vectors, ...(parsed ? { usage: parsed } : {}) };
  }

  health(signal: AbortSignal): Promise<LlmHealth> {
    const url = this.id === 'azure-openai' ? `${this.baseUrl}/openai/models?api-version=${encodeURIComponent(this.apiVersion ?? '2024-10-21')}` : this.baseUrl + '/models';
    return timedHealth(async () => {
      const response = await send(this.fetchImpl, url, { method: 'GET', headers: this.headers() }, signal);
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    });
  }

  /** Model ids served by an OpenAI-compatible local server (GET /models). */
  async listModels(signal: AbortSignal): Promise<string[]> {
    const response = await send(this.fetchImpl, this.baseUrl + '/models', { method: 'GET', headers: this.headers() }, signal);
    const payload = await readJson(response);
    return (Array.isArray(payload['data']) ? payload['data'] : [])
      .map((item) => asRecord(item)['id']).filter((id): id is string => typeof id === 'string' && NAME_PATTERN.test(id)).slice(0, 200);
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

export class AnthropicBackend extends BaseBackend implements LlmBackend {
  readonly id = 'anthropic' as const;
  readonly label = 'Anthropic Claude';
  readonly local = false;
  readonly paid = true;
  readonly supportsEmbeddings = false;

  private headers(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-api-key': this.apiKey ?? '', 'anthropic-version': '2023-06-01' };
  }

  private body(model: string, messages: LlmMessage[], options: LlmOptions, stream: boolean): string {
    let system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n\n');
    if (options.json) system = (system ? system + '\n\n' : '') + 'Respond with a single valid JSON object and nothing else.';
    return JSON.stringify({
      model,
      max_tokens: options.maxTokens ?? 1024,
      ...(system ? { system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(stream ? { stream: true } : {}),
      messages: messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [...m.images.map((image) => { const { mime, data } = splitDataUrl(image); return { type: 'image', source: { type: 'base64', media_type: mime, data } }; }), { type: 'text', text: m.content }]
          : m.content,
      })),
    });
  }

  async chat(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): Promise<LlmResult> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.baseUrl + '/messages', { method: 'POST', headers: this.headers(), body: this.body(model, messages, options, false) }, signal);
    const payload = await readJson(response);
    if (!Array.isArray(payload['content'])) throw new LlmError('invalid_response');
    const text = payload['content'].map((part) => asRecord(part)).filter((part) => part['type'] === 'text' && typeof part['text'] === 'string').map((part) => part['text'] as string).join('');
    const u = asRecord(payload['usage']);
    const parsed = usage(u['input_tokens'], u['output_tokens']);
    return { text, ...(parsed ? { usage: parsed } : {}) };
  }

  async *stream(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): AsyncGenerator<LlmChunk> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.baseUrl + '/messages', { method: 'POST', headers: this.headers(), body: this.body(model, messages, options, true) }, signal);
    let inputTokens: number | undefined;
    for await (const event of sseJson(response)) {
      const type = event['type'];
      if (type === 'message_start') {
        inputTokens = num(asRecord(asRecord(event['message'])['usage'])['input_tokens']);
      } else if (type === 'content_block_delta') {
        const delta = asRecord(event['delta']);
        if (delta['type'] === 'text_delta' && typeof delta['text'] === 'string' && delta['text']) yield { text: delta['text'] };
      } else if (type === 'message_delta') {
        const parsed = usage(inputTokens, asRecord(event['usage'])['output_tokens']);
        if (parsed) yield { usage: parsed };
      } else if (type === 'error') {
        throw new LlmError('http_error');
      }
    }
  }

  async embed(): Promise<{ vectors: number[][] }> {
    throw new LlmError('unsupported');
  }

  health(signal: AbortSignal): Promise<LlmHealth> {
    return timedHealth(async () => {
      const response = await send(this.fetchImpl, this.baseUrl + '/models?limit=1', { method: 'GET', headers: this.headers() }, signal);
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    });
  }
}

// ---------------------------------------------------------------------------
// Google Gemini (generateContent / streamGenerateContent)
// ---------------------------------------------------------------------------

export class GeminiBackend extends BaseBackend implements LlmBackend {
  readonly id = 'gemini' as const;
  readonly label = 'Google Gemini';
  readonly local = false;
  readonly paid = true;
  readonly supportsEmbeddings = true;

  private headers(): Record<string, string> {
    // The key travels in a header, not the URL, so it cannot leak through URL logging.
    return { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey ?? '' };
  }

  private body(messages: LlmMessage[], options: LlmOptions): string {
    const system = messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content).join('\n\n');
    return JSON.stringify({
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      contents: messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [
          { text: m.content },
          ...(m.images ?? []).map((image) => { const { mime, data } = splitDataUrl(image); return { inlineData: { mimeType: mime, data } }; }),
        ],
      })),
      generationConfig: {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { maxOutputTokens: options.maxTokens } : {}),
        ...(options.json ? { responseMimeType: 'application/json' } : {}),
      },
    });
  }

  private static textOf(payload: Record<string, unknown>): string | undefined {
    const parts = asRecord(first(payload['candidates'])['content'])['parts'];
    if (!Array.isArray(parts)) return undefined;
    return parts.map((part) => asRecord(part)['text']).filter((t): t is string => typeof t === 'string').join('');
  }

  private static usageOf(payload: Record<string, unknown>): LlmUsage | undefined {
    const u = asRecord(payload['usageMetadata']);
    return usage(u['promptTokenCount'], u['candidatesTokenCount']);
  }

  async chat(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): Promise<LlmResult> {
    assertModelName(model);
    const response = await send(this.fetchImpl, `${this.baseUrl}/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: this.headers(), body: this.body(messages, options) }, signal);
    const payload = await readJson(response);
    const text = GeminiBackend.textOf(payload);
    if (text === undefined) throw new LlmError('invalid_response');
    const parsed = GeminiBackend.usageOf(payload);
    return { text, ...(parsed ? { usage: parsed } : {}) };
  }

  async *stream(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): AsyncGenerator<LlmChunk> {
    assertModelName(model);
    const response = await send(this.fetchImpl, `${this.baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, { method: 'POST', headers: this.headers(), body: this.body(messages, options) }, signal);
    let last: LlmUsage | undefined;
    for await (const event of sseJson(response)) {
      const text = GeminiBackend.textOf(event);
      if (text) yield { text };
      last = GeminiBackend.usageOf(event) ?? last;
    }
    if (last) yield { usage: last };
  }

  async embed(model: string, input: string[], signal: AbortSignal): Promise<{ vectors: number[][] }> {
    assertModelName(model);
    const response = await send(this.fetchImpl, `${this.baseUrl}/models/${encodeURIComponent(model)}:batchEmbedContents`, {
      method: 'POST', headers: this.headers(),
      body: JSON.stringify({ requests: input.map((text) => ({ model: 'models/' + model, content: { parts: [{ text }] } })) }),
    }, signal);
    const payload = await readJson(response);
    const vectors = (Array.isArray(payload['embeddings']) ? payload['embeddings'] : []).map((item) => asRecord(item)['values']).filter((v): v is number[] => Array.isArray(v));
    if (vectors.length !== input.length) throw new LlmError('invalid_response');
    return { vectors };
  }

  health(signal: AbortSignal): Promise<LlmHealth> {
    return timedHealth(async () => {
      const response = await send(this.fetchImpl, this.baseUrl + '/models?pageSize=1', { method: 'GET', headers: this.headers() }, signal);
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    });
  }
}

// ---------------------------------------------------------------------------
// Native Ollama (/api/chat NDJSON, /api/embed, /api/tags, /api/show)
// ---------------------------------------------------------------------------

export class OllamaBackend extends BaseBackend implements LlmBackend {
  readonly id = 'ollama' as const;
  readonly label = 'Ollama';
  readonly paid = false;
  readonly supportsEmbeddings = true;
  readonly local: boolean;

  constructor(config: BaseBackendConfig & { local: boolean }) {
    super(config);
    this.local = config.local;
  }

  private body(model: string, messages: LlmMessage[], options: LlmOptions, stream: boolean): string {
    return JSON.stringify({
      model,
      stream,
      messages: messages.map((m) => ({
        role: m.role === 'developer' ? 'system' : m.role,
        content: m.content,
        ...(m.images?.length ? { images: m.images.map((image) => splitDataUrl(image).data) } : {}),
      })),
      ...(options.json ? { format: 'json' } : {}),
      options: {
        ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
        ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
      },
    });
  }

  async chat(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): Promise<LlmResult> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.baseUrl + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: this.body(model, messages, options, false) }, signal);
    const payload = await readJson(response);
    const content = asRecord(payload['message'])['content'];
    if (typeof content !== 'string') throw new LlmError('invalid_response');
    const parsed = usage(payload['prompt_eval_count'], payload['eval_count']);
    return { text: content, ...(parsed ? { usage: parsed } : {}) };
  }

  async *stream(model: string, messages: LlmMessage[], options: LlmOptions, signal: AbortSignal): AsyncGenerator<LlmChunk> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.baseUrl + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: this.body(model, messages, options, true) }, signal);
    for await (const line of lines(response)) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = asRecord(JSON.parse(line));
      } catch {
        throw new LlmError('invalid_response');
      }
      if (typeof event['error'] === 'string') throw new LlmError('http_error');
      const content = asRecord(event['message'])['content'];
      if (typeof content === 'string' && content) yield { text: content };
      if (event['done'] === true) {
        const parsed = usage(event['prompt_eval_count'], event['eval_count']);
        if (parsed) yield { usage: parsed };
        return;
      }
    }
  }

  async embed(model: string, input: string[], signal: AbortSignal): Promise<{ vectors: number[][]; usage?: LlmUsage }> {
    assertModelName(model);
    const response = await send(this.fetchImpl, this.baseUrl + '/api/embed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model, input }) }, signal);
    const payload = await readJson(response);
    const vectors = (Array.isArray(payload['embeddings']) ? payload['embeddings'] : []).filter((v): v is number[] => Array.isArray(v));
    if (vectors.length !== input.length) throw new LlmError('invalid_response');
    const parsed = usage(payload['prompt_eval_count'], 0);
    return { vectors, ...(parsed ? { usage: parsed } : {}) };
  }

  health(signal: AbortSignal): Promise<LlmHealth> {
    return timedHealth(async () => {
      const response = await send(this.fetchImpl, this.baseUrl + '/api/version', { method: 'GET' }, signal);
      const payload = await readJson(response).catch(() => ({} as Record<string, unknown>));
      return typeof payload['version'] === 'string' ? 'v' + payload['version'] : undefined;
    });
  }

  /** Raw /api/tags payload (the data behind `ollama list`). */
  async tags(signal: AbortSignal): Promise<unknown> {
    return readJson(await send(this.fetchImpl, this.baseUrl + '/api/tags', { method: 'GET' }, signal));
  }

  /** Raw /api/show payload for one model. */
  async show(model: string, signal: AbortSignal): Promise<unknown> {
    assertModelName(model);
    return readJson(await send(this.fetchImpl, this.baseUrl + '/api/show', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model }) }, signal));
  }
}
