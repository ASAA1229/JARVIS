/**
 * Advisory-agent provider adapter.
 * First-party JARVIS inference uses native Ollama; authorized cloud providers
 * continue through the shared provider client.
 */
import { chatCompletion, ProviderCallError } from '../ai/providerClient.js';
import { providerRouter, type ProviderId } from '../ai/providerRouter.js';
import { AgentModelAdapter, AgentModelProviderError } from './agentOrchestrator.js';

const MAX_MODEL_CONTENT_LENGTH = 32 * 1024;
const MAX_RATE_LIMIT_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;

export type AgentModelConfigStatus =
  | { status: 'ready'; mode: 'local' | 'remote'; model: string; apiKeyConfigured: boolean }
  | { status: 'disabled'; reason: 'invalid_url' | 'remote_not_opted_in' | 'insecure_remote_url' | 'invalid_model' };

function readConfiguration() {
  const rawUrl = process.env.OLLAMA_URL ||
    (process.env.JARVIS_AI_BASE_URL || 'http://localhost:11434').replace(/\/v1\/?$/i, '');
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
 * The separate public site gateway retains its OpenAI-compatible streaming contract.
 * Ollama supports that compatibility route; first-party JARVIS chat uses /api/chat.
 */
export function getModelEndpoint(): { id: ProviderId; format: 'openai' | 'anthropic'; baseUrl: string; model: string; apiKey?: string } | null {
  const decision = providerRouter.route({
    taskType: 'site',
    containsPrivateData: false,
    cloudAuthorized: process.env.JARVIS_SITE_GATEWAY_ALLOW_CLOUD === 'true',
    formats: ['ollama', 'openai', 'anthropic'],
  });
  const provider = decision.provider;
  if (!provider) return null;
  const format = provider.format === 'ollama' ? 'openai' : provider.format;
  const baseUrl = provider.format === 'ollama' ? provider.baseUrl + '/v1' : provider.baseUrl;
  return { id: provider.id, format, baseUrl, model: provider.model, ...(provider.apiKey ? { apiKey: provider.apiKey } : {}) };
}

export function getAgentModelConfigStatus(): AgentModelConfigStatus {
  return readConfiguration().status;
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

const AGENT_ROUTE = { taskType: 'agent', containsPrivateData: true, formats: ['ollama', 'openai'] } as const;

export function createConfiguredAgentModelAdapter(): AgentModelAdapter | null {
  const route = () => providerRouter.route({ ...AGENT_ROUTE, formats: [...AGENT_ROUTE.formats] });
  const initialProvider = route().provider;
  if (!initialProvider) return null;

  return {
    timeoutMs: initialProvider.timeoutMs,
    async generate(prompt, signal): Promise<unknown> {
      const provider = route().provider;
      if (!provider) throw new AgentModelProviderError('network');

      for (let attempt = 0; attempt <= MAX_RATE_LIMIT_RETRIES; attempt += 1) {
        try {
          const messages = prompt.messages.map((message) => ({
            role: message.role,
            content: message.content,
          }));
          const content = await chatCompletion(provider, messages, {
            temperature: 0.2,
            json: true,
          }, signal);
          providerRouter.reportSuccess(provider.id);
          if (content.length > MAX_MODEL_CONTENT_LENGTH) {
            throw new AgentModelProviderError('response_too_large');
          }
          try {
            return JSON.parse(content) as unknown;
          } catch {
            return content;
          }
        } catch (error) {
          if (error instanceof AgentModelProviderError) throw error;
          if (!(error instanceof ProviderCallError)) {
            throw new AgentModelProviderError('provider_response');
          }
          if (error.kind === 'rate_limited' && attempt < MAX_RATE_LIMIT_RETRIES) {
            await waitForRetry(DEFAULT_RETRY_DELAY_MS, signal);
            continue;
          }
          if (error.kind === 'network' || error.kind === 'timeout' ||
              (error.kind === 'http_error' && (error.status ?? 0) >= 500)) {
            providerRouter.reportFailure(provider.id);
          }
          if (error.kind === 'network') throw new AgentModelProviderError('network');
          if (error.kind === 'http_error' || error.kind === 'rate_limited') {
            throw new AgentModelProviderError('http', error.status);
          }
          if (error.kind === 'timeout') throw new Error('agent_model_aborted');
          throw new AgentModelProviderError('provider_response');
        }
      }
      throw new AgentModelProviderError('network');
    },
  };
}
