import {
  AIProviderError,
  type AIChatOptions,
  type AIMessage,
  type AIProvider,
  type AIProviderHealth,
} from './aiProvider.js';

export interface OllamaProviderConfig {
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  embeddingModel?: string;
}

type FetchImplementation = typeof fetch;

const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_HEALTH_BYTES = 1024 * 1024;
const MAX_STREAM_BYTES = 2 * 1024 * 1024;
const MAX_STREAM_LINE_CHARS = 256 * 1024;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new AIProviderError('invalid_response');
  }
  if (!response.body) throw new AIProviderError('invalid_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new AIProviderError('invalid_response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

function log(level: 'info' | 'warn', event: string, fields: Record<string, string | number | boolean>): void {
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    component: 'ai.ollama',
    event,
    ...fields,
  });
  if (level === 'warn') console.warn(entry);
  else console.info(entry);
}

function toOllamaMessages(messages: AIMessage[]) {
  return messages.map((message) => ({
    role: message.role === 'developer' ? 'system' : message.role,
    content: message.content,
  }));
}

function classifyHttpError(status: number): AIProviderError {
  return new AIProviderError(status === 429 ? 'rate_limited' : 'http_error', status);
}

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly embeddingModel?: string;

  constructor(
    config: OllamaProviderConfig,
    private readonly fetchImpl: FetchImplementation = fetch,
  ) {
    const parsed = new URL(config.baseUrl);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
        parsed.search || parsed.hash || parsed.pathname !== '/') {
      throw new Error('Ollama base URL must be an HTTP(S) origin without credentials or a path.');
    }
    if (!config.model || config.model.length > 128) throw new Error('Ollama model name is invalid.');
    if (config.embeddingModel !== undefined && (!config.embeddingModel || config.embeddingModel.length > 128)) {
      throw new Error('Ollama embedding model name is invalid.');
    }
    this.baseUrl = parsed.origin;
    this.model = config.model;
    this.embeddingModel = config.embeddingModel;
    this.timeoutMs = config.timeoutMs ?? 120_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 600_000) {
      throw new Error('Ollama timeout must be between 1000 and 600000 milliseconds.');
    }
  }

  async chat(messages: AIMessage[], options: AIChatOptions = {}, signal?: AbortSignal): Promise<string> {
    const startedAt = Date.now();
    const requestAbort = requestSignal(signal, this.timeoutMs);
    log('info', 'request_started', { model: this.model, messageCount: messages.length });
    let response: Response;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        response = await this.fetchImpl(this.baseUrl + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: toOllamaMessages(messages),
            stream: false,
            ...(options.json ? { format: 'json' } : {}),
            options: {
              ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
              ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
            },
          }),
          signal: requestAbort,
        });
      } catch {
        const kind = requestAbort.aborted ? 'timeout' : 'network';
        log('warn', 'request_failed', { model: this.model, kind, elapsedMs: Date.now() - startedAt });
        throw new AIProviderError(kind);
      }
      if (RETRYABLE_STATUS.has(response.status) && attempt === 0) {
        await response.body?.cancel().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      const error = classifyHttpError(response!.status);
      log('warn', 'request_failed', { model: this.model, kind: error.kind, status: response!.status, elapsedMs: Date.now() - startedAt });
      await response!.body?.cancel().catch(() => undefined);
      throw error;
    }

    let raw: string;
    try {
      raw = await readBoundedText(response!, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError(requestAbort.aborted ? 'timeout' : 'invalid_response');
    }
    if (!raw) throw new AIProviderError('invalid_response');

    let payload: { message?: { content?: unknown }; error?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      throw new AIProviderError('invalid_response');
    }
    if (payload.error || typeof payload.message?.content !== 'string' || !payload.message.content.trim()) {
      throw new AIProviderError('invalid_response');
    }
    log('info', 'request_completed', {
      model: this.model,
      elapsedMs: Date.now() - startedAt,
      responseChars: payload.message.content.length,
    });
    return payload.message.content;
  }

  async *stream(messages: AIMessage[], options: AIChatOptions = {}, signal?: AbortSignal): AsyncIterable<string> {
    const requestAbort = requestSignal(signal, this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl + '/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
        body: JSON.stringify({
          model: this.model,
          messages: toOllamaMessages(messages),
          stream: true,
          ...(options.json ? { format: 'json' } : {}),
          options: {
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            ...(options.maxTokens !== undefined ? { num_predict: options.maxTokens } : {}),
          },
        }),
        signal: requestAbort,
      });
    } catch {
      throw new AIProviderError(requestAbort.aborted ? 'timeout' : 'network');
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw classifyHttpError(response.status);
    }
    if (!response.body) throw new AIProviderError('invalid_response');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let totalBytes = 0;
    let sawDone = false;
    const parseLine = (line: string): { content?: string; done: boolean } => {
      let item: { message?: { content?: unknown }; done?: unknown; error?: unknown };
      try {
        item = JSON.parse(line) as typeof item;
      } catch {
        throw new AIProviderError('invalid_response');
      }
      if (item.error) throw new AIProviderError('invalid_response');
      if (item.message?.content !== undefined && typeof item.message.content !== 'string') {
        throw new AIProviderError('invalid_response');
      }
      return {
        ...(typeof item.message?.content === 'string' && item.message.content ? { content: item.message.content } : {}),
        done: item.done === true,
      };
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          totalBytes += value.byteLength;
          if (totalBytes > MAX_STREAM_BYTES) throw new AIProviderError('invalid_response');
          buffer += decoder.decode(value, { stream: !done });
        } else if (done) {
          buffer += decoder.decode();
        }
        if (buffer.length > MAX_STREAM_LINE_CHARS && !buffer.includes('\n')) {
          throw new AIProviderError('invalid_response');
        }
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line.length > MAX_STREAM_LINE_CHARS) throw new AIProviderError('invalid_response');
          if (line) {
            const item = parseLine(line);
            if (item.content) yield item.content;
            if (item.done) {
              sawDone = true;
              return;
            }
          }
          newline = buffer.indexOf('\n');
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const item = parseLine(buffer.trim());
        if (item.content) yield item.content;
        sawDone = item.done;
      }
      if (!sawDone) throw new AIProviderError(requestAbort.aborted ? 'timeout' : 'invalid_response');
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError(requestAbort.aborted ? 'timeout' : 'invalid_response');
    } finally {
      if (!sawDone) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  async healthCheck(signal?: AbortSignal): Promise<AIProviderHealth> {
    const requestAbort = requestSignal(signal, Math.min(this.timeoutMs, 15_000));
    try {
      const response = await this.fetchImpl(this.baseUrl + '/api/tags', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: requestAbort,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { available: false, modelAvailable: false, model: this.model };
      }
      const raw = await readBoundedText(response, MAX_HEALTH_BYTES);
      const payload = JSON.parse(raw) as { models?: Array<{ name?: unknown }>; version?: unknown };
      const models = Array.isArray(payload.models) ? payload.models : [];
      const hasModel = (name: string) => models.some((item) => item && (
        item.name === name || (!name.includes(':') && typeof item.name === 'string' && item.name.split(':', 1)[0] === name)
      ));
      const modelAvailable = hasModel(this.model);
      return {
        available: true,
        modelAvailable,
        model: this.model,
        ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
        ...(this.embeddingModel ? {
          embeddingModel: this.embeddingModel,
          embeddingModelAvailable: hasModel(this.embeddingModel),
        } : {}),
      };
    } catch {
      return { available: false, modelAvailable: false, model: this.model,
        ...(this.embeddingModel ? { embeddingModel: this.embeddingModel, embeddingModelAvailable: false } : {}) };
    }
  }
}
