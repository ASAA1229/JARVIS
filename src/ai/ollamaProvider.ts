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
}

type FetchImplementation = typeof fetch;

const MAX_RESPONSE_BYTES = 256 * 1024;
const RETRYABLE_STATUS = new Set([502, 503, 504]);

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
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

export class OllamaProvider implements AIProvider {
  readonly id = 'ollama';
  readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

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
    this.baseUrl = parsed.origin;
    this.model = config.model;
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
      const kind = response!.status === 429 ? 'rate_limited' : 'http_error';
      log('warn', 'request_failed', { model: this.model, kind, status: response!.status, elapsedMs: Date.now() - startedAt });
      throw new AIProviderError(kind, response!.status);
    }

    let raw: string;
    try {
      raw = await response!.text();
    } catch {
      throw new AIProviderError(requestAbort.aborted ? 'timeout' : 'invalid_response');
    }
    if (!raw || new TextEncoder().encode(raw).byteLength > MAX_RESPONSE_BYTES) {
      throw new AIProviderError('invalid_response');
    }

    let payload: { message?: { content?: unknown }; error?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      throw new AIProviderError('invalid_response');
    }
    if (typeof payload.message?.content !== 'string' || !payload.message.content.trim()) {
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
    if (!response.ok || !response.body) throw new AIProviderError('http_error', response.status);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            const item = JSON.parse(line) as { message?: { content?: unknown }; done?: boolean; error?: unknown };
            if (item.error) throw new AIProviderError('invalid_response');
            if (typeof item.message?.content === 'string' && item.message.content) yield item.message.content;
            if (item.done) return;
          }
          newline = buffer.indexOf('\n');
        }
        if (done) break;
      }
      if (buffer.trim()) {
        const item = JSON.parse(buffer) as { message?: { content?: unknown }; error?: unknown };
        if (item.error) throw new AIProviderError('invalid_response');
        if (typeof item.message?.content === 'string' && item.message.content) yield item.message.content;
      }
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError(requestAbort.aborted ? 'timeout' : 'invalid_response');
    } finally {
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
      if (!response.ok) return { available: false, modelAvailable: false, model: this.model };
      const payload = await response.json() as { models?: Array<{ name?: unknown }>; version?: unknown };
      const models = Array.isArray(payload.models) ? payload.models : [];
      const modelAvailable = models.some((item) => item && (item.name === this.model ||
        (typeof item.name === 'string' && !this.model.includes(':') && item.name.split(':', 1)[0] === this.model)));
      return {
        available: true,
        modelAvailable,
        model: this.model,
        ...(typeof payload.version === 'string' ? { version: payload.version } : {}),
      };
    } catch {
      return { available: false, modelAvailable: false, model: this.model };
    }
  }
}
