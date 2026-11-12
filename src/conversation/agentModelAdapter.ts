/**
 * OpenAI-compatible adapter for advisory JARVIS agents.
 * Local endpoint is the default. Remote providers require explicit opt-in.
 */
import { providerRouter, type ProviderId } from '../ai/providerRouter.js';
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
  const rawUrl = process.env.OLLAMA_URL || (process.env.JARVIS_AI_BASE_URL || 'http://localhost:11434').replace(/\\/v1\\/?$/i, '');
  const model = process.env.OLLAMA_MODEL || process.env.JARVIS_AI_MODEL || 'llama3.2:latest';
  const apiKey = process.env.JARVIS_AI_API_KEY;
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    return { status: { status: 'disabled', reason: 'invalid_url' } as AgentModelConfigStatus };
  }

  const local = endpoint.hostname === '127.0.0.1' || endpoint.hostname === 'localhost' || endpoint.hostname === '[::1]';
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
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

/**
 * Validated model endpoint for in-process callers (for example the site AI gateway).
 * Applies the same local-first / explicit-remote-opt-in rules as the agents.
 */
export function getModelEndpoint(): { id: ProviderId; format: 'openai' | 'anthropic'; baseUrl: string; model: string; apiKey?: string } | null {
  // Site gateway traffic (US-059): local unless the owner allows cloud for site requests,
  // either with JARVIS_SITE_GATEWAY_ALLOW_CLOUD=true or 'site' in JARVIS_CLOUD_ALLOWED_TASKS.
  // The gateway converts Anthropic Messages streams to OpenAI chunks itself.
  const decision = providerRouter.route({
    taskType: 'site',
    containsPrivateData: false,
    cloudAuthorized: process.env.JARVIS_SITE_GATEWAY_ALLOW_CLOUD === 'true',
    formats: ['ollama', 'openai', 'anthropic'],
  });
  const provider = decision.provider;
  if (!provider) return null;
  // The public site gateway remains OpenAI-compatible. Ollama supports that
  // compatibility route, while first-party JARVIS inference uses native /api/chat.
  const format = provider.format === 'ollama' ? 'openai' : provider.format;
  const baseUrl = provider.format === 'ollama' ? provider.baseUrl + '/v1' : provider.baseUrl;
  return { id: provider.id, format, baseUrl, model: provider.model, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}) };
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

// Agent prompts carry conversation history and owner memory, so they are routed as
// private (local-only). Agents need OpenAI-compatible JSON mode.
const AGENT_ROUTE = { taskType: 'agent', containsPrivateData: true, formats: ['ollama', 'openai'] } as const;

export function createConfiguredAgentModelAdapter(): AgentModelAdapter | null {
  const initialProvider = providerRouter.route({ ...AGENT_ROUTE, formats: [...AGENT_ROUTE.formats] }).provider;
  if (!initialProvider) return null;

  return {
    timeoutMs: initialProvider.timeoutMs,
    async generate(prompt, signal): Promise<unknown> {
      const provider = providerRouter.route({ ...AGENT_ROUTE, formats: [...AGENT_ROUTE.formats] }).provider;
      if (!provider) throw new AgentModelProviderError('network');
      const { baseUrl, model, apiKey } = provider;
      let response: Response | undefined;
      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
        try {
          const isOllama = provider.format === 'ollama';
          response = await fetch(isOllama ? baseUrl + '/api/chat' : baseUrl + '/chat/completions', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(!isOllama && apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
            },
            body: JSON.stringify(isOllama ? {
              model,
              stream: false,
              format: 'json',
              options: { temperature: 0.2 },
              messages: prompt.messages.map((message) => ({
                ...message,
                role: message.role === 'developer' ? 'system' : message.role,
              })),
            } : {
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
          providerRouter.reportFailure(provider.id);
          throw new AgentModelProviderError('network');
        }

        if (response.status !== 429 || attempt === MAX_RATE_LIMIT_RETRIES) break;
        const retryDelay = getRetryDelayMs(response);
        if (retryDelay === null) break;
        try { await response.body?.cancel(); } catch { /* best-effort cleanup */ }
        await waitForRetry(retryDelay, signal);
      }
      if (!response) throw new AgentModelProviderError('network');
      if (!response.ok) {
        if (response.status >= 500) providerRouter.reportFailure(provider.id);
        throw new AgentModelProviderError('http', response.status);
      }
      providerRouter.reportSuccess(provider.id);

      let payload: {
        choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
        message?: { content?: unknown };
      };
      try {
        const body = await readBoundedResponse(response);
        payload = JSON.parse(body) as typeof payload;
      } catch (error) {
        if (error instanceof AgentModelProviderError) throw error;
        throw new AgentModelProviderError('provider_response');
      }
      const message = provider.format === 'ollama' ? payload.message : payload.choices?.[0]?.message;
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
