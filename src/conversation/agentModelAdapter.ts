/**
 * OpenAI-compatible adapter for advisory JARVIS agents.
 * Local endpoint is the default. Remote providers require explicit opt-in.
 */
import { AgentModelAdapter, AgentModelProviderError } from './agentOrchestrator.js';

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_CONTENT_LENGTH = 32 * 1024;
const MAX_RATE_LIMIT_RETRIES = 1;
const MAX_RETRY_DELAY_MS = 2000;
const DEFAULT_RETRY_DELAY_MS = 250;

export type AgentModelConfigStatus =
  | { status: 'ready'; mode: 'local' | 'remote'; model: string; apiKeyConfigured: boolean }
  | { status: 'disabled'; reason: 'invalid_url' | 'remote_not_opted_in' | 'insecure_remote_url' | 'invalid_model' };

function readConfiguration() {
  const rawUrl = process.env.JARVIS_AI_BASE_URL || 'http://127.0.0.1:11434/v1';
  const model = process.env.JARVIS_AI_MODEL || 'llama3.2';
  const apiKey = process.env.JARVIS_AI_API_KEY;
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    return { status: { status: 'disabled', reason: 'invalid_url' } as AgentModelConfigStatus };
  }

  const local = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]';
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash) {
    return { status: { status: 'disabled', reason: 'invalid_url' } as AgentModelConfigStatus };
  }
  if (!local && endpoint.protocol !== 'https:') {
    return { status: { status: 'disabled', reason: 'insecure_remote_url' } as AgentModelConfigStatus };
  }
  if (!local && process.env.JARVIS_AI_ALLOW_REMOTE !== 'true') {
    return { status: { status: 'disabled', reason: 'remote_not_opted_in' } as AgentModelConfigStatus };
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) {
    return { status: { status: 'disabled', reason: 'invalid_model' } as AgentModelConfigStatus };
  }

  const baseUrl = endpoint.toString().replace(/\/$/, '');
  return {
    baseUrl,
    model,
    apiKey,
    status: { status: 'ready', mode: local ? 'local' : 'remote', model, apiKeyConfigured: Boolean(apiKey) } as AgentModelConfigStatus,
  };
}

/** Exposes only safe startup diagnostics; never returns endpoint or credential values. */
export function getAgentModelConfigStatus(): AgentModelConfigStatus {
  return readConfiguration().status;
}

function getRetryDelayMs(response: Response): number | null {
  const retryAfter = response.headers.get('retry-after');
  if (!retryAfter) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(retryAfter);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - Date.now();
  if (!Number.isFinite(delay) || delay < 0 || delay > MAX_RETRY_DELAY_MS) return null;
  return Math.min(delay, MAX_RETRY_DELAY_MS);
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error('agent_model_aborted'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => { cleanup(); resolve(); }, delayMs);
    const onAbort = () => { clearTimeout(timer); cleanup(); reject(new Error('agent_model_aborted')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AgentModelProviderError('response_too_large');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new AgentModelProviderError('response_too_large');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AgentModelProviderError('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createConfiguredAgentModelAdapter(): AgentModelAdapter | null {
  const config = readConfiguration();
  if (config.status.status !== 'ready' || !('baseUrl' in config)) return null;
  const { baseUrl, model, apiKey } = config;

  return {
    async generate(prompt, signal): Promise<unknown> {
      let response: Response | undefined;
      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
        try {
          response = await fetch(baseUrl + '/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
            },
            body: JSON.stringify({
              model,
              temperature: 0.2,
              response_format: { type: 'json_object' },
              messages: prompt.messages,
            }),
            signal,
          });
        } catch {
          if (signal.aborted) throw new Error('agent_model_aborted');
          // Network failure is ambiguous; never retry a possibly accepted request.
          throw new AgentModelProviderError('network');
        }

        if (response.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) break;
        const retryDelay = getRetryDelayMs(response);
        if (retryDelay === null) break;
        try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
        await waitForRetry(retryDelay, signal);
      }
      if (!response) throw new AgentModelProviderError('network');
      if (!response.ok) throw new AgentModelProviderError('http', response.status);

      let payload: {
        choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
      };
      try {
        const body = await readBoundedResponse(response);
        payload = JSON.parse(body) as typeof payload;
      } catch (error) {
        if (error instanceof AgentModelProviderError) throw error;
        throw new AgentModelProviderError('provider_response');
      }
      const message = payload.choices?.[0]?.message;
      if (typeof message?.refusal === 'string' && message.refusal.trim()) {
        throw new AgentModelProviderError('refusal');
      }
      if (typeof message?.content !== 'string') throw new AgentModelProviderError('provider_response');
      if (message.content.length > MAX_MODEL_CONTENT_LENGTH) {
        throw new AgentModelProviderError('response_too_large');
      }
      try {
        return JSON.parse(message.content) as unknown;
      } catch {
        return message.content;
      }
    },
  };
}
