/**
 * Non-streaming chat completion across provider formats (JARVIS-US-059).
 * Native local Ollama plus OpenAI-compatible and Anthropic Messages APIs.
 * Errors carry a safe kind only; provider bodies and credentials are never surfaced.
 */
import type { ProviderConfig } from './providerRouter.js';
import { AIProviderError } from './aiProvider.js';
import { OllamaProvider } from './ollamaProvider.js';

export interface ChatMessage {
  /** 'developer' is sent as-is to OpenAI-compatible APIs and folded into the system prompt for Anthropic. */
  role: 'system' | 'developer' | 'user' | 'assistant';
  content: string;
}

export type ProviderErrorKind = 'network' | 'timeout' | 'http_error' | 'rate_limited' | 'invalid_response';

export class ProviderCallError extends Error {
  constructor(readonly kind: ProviderErrorKind, readonly status?: number) {
    super(`provider_${kind}`);
  }
}

export interface ChatOptions {
  temperature?: number;
  /** Ask for a JSON object (OpenAI response_format; Anthropic relies on the prompt). */
  json?: boolean;
  maxTokens?: number;
}

const MAX_RESPONSE_CHARS = 256 * 1024;

export async function chatCompletion(provider: ProviderConfig, messages: ChatMessage[], options: ChatOptions, signal: AbortSignal): Promise<string> {
  if (provider.format === 'ollama') {
    const ollama = new OllamaProvider({
      baseUrl: provider.baseUrl,
      model: provider.model,
      timeoutMs: provider.timeoutMs ?? 120_000,
    });
    try {
      return await ollama.chat(messages, options, signal);
    } catch (error) {
      if (error instanceof AIProviderError) throw new ProviderCallError(error.kind, error.status);
      throw new ProviderCallError(signal.aborted ? 'timeout' : 'network');
    }
  }

  let response: Response;
  try {
    if (provider.format === 'anthropic') {
      const system = messages.filter((message) => message.role === 'system' || message.role === 'developer').map((message) => message.content).join('\n\n');
      response = await fetch(provider.baseUrl + '/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': provider.apiKey ?? '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: options.maxTokens ?? 1024,
          ...(system ? { system } : {}),
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          messages: messages.filter((message) => message.role === 'user' || message.role === 'assistant'),
        }),
        redirect: 'error',
        signal,
      });
    } else {
      response = await fetch(provider.baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.apiKey ? { Authorization: 'Bearer ' + provider.apiKey } : {}),
        },
        body: JSON.stringify({
          model: provider.model,
          messages,
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens !== undefined ? { max_tokens: options.maxTokens } : {}),
          ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        }),
        redirect: 'error',
        signal,
      });
    }
  } catch {
    throw new ProviderCallError(signal.aborted ? 'timeout' : 'network');
  }
  if (response.status === 429) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderCallError('rate_limited', 429);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ProviderCallError('http_error', response.status);
  }
  const text = await response.text().catch(() => '');
  if (!text || text.length > MAX_RESPONSE_CHARS) throw new ProviderCallError('invalid_response');
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new ProviderCallError('invalid_response');
  }
  const content = provider.format === 'anthropic'
    ? (payload as { content?: Array<{ type?: unknown; text?: unknown }> }).content?.find((part) => part.type === 'text')?.text
    : (payload as { choices?: Array<{ message?: { content?: unknown } }> }).choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new ProviderCallError('invalid_response');
  return content;
}
