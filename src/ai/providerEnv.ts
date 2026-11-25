/**
 * Builds LLM backends from environment variables. Cloud credentials are read from the environment
 * only; they are never logged, never written to config/metrics files and never sent to the UI.
 *
 * Environment variables
 *   Local (zero cost)
 *     OLLAMA_URL (or legacy JARVIS_AI_BASE_URL), OLLAMA_MODEL (or JARVIS_AI_MODEL), OLLAMA_TIMEOUT,
 *     JARVIS_AI_ALLOW_REMOTE=true   a non-loopback Ollama counts as "remote": never gets private data
 *     JARVIS_LOCAL_OPENAI_BASE_URL  loopback OpenAI-compatible server, e.g. http://127.0.0.1:1234/v1
 *     JARVIS_LOCAL_OPENAI_MODEL, JARVIS_LOCAL_OPENAI_API_KEY (optional)
 *   Cloud (paid; owner authorization and budget required at routing time)
 *     OpenAI:        JARVIS_CLOUD_OPENAI_API_KEY, JARVIS_CLOUD_OPENAI_MODEL, JARVIS_CLOUD_OPENAI_BASE_URL
 *     Azure OpenAI:  JARVIS_CLOUD_AZURE_OPENAI_API_KEY, JARVIS_CLOUD_AZURE_OPENAI_ENDPOINT,
 *                    JARVIS_CLOUD_AZURE_OPENAI_DEPLOYMENT, JARVIS_CLOUD_AZURE_OPENAI_API_VERSION
 *     Anthropic:     JARVIS_CLOUD_ANTHROPIC_API_KEY, JARVIS_CLOUD_ANTHROPIC_MODEL, JARVIS_CLOUD_ANTHROPIC_BASE_URL
 *     Google Gemini: JARVIS_CLOUD_GEMINI_API_KEY, JARVIS_CLOUD_GEMINI_MODEL, JARVIS_CLOUD_GEMINI_BASE_URL
 *   Policy
 *     JARVIS_ROUTING_MODE = local-first (default) | local-only | offline
 *     JARVIS_CLOUD_ALLOWED_TASKS (legacy per-task allowlist; still honoured)
 *     JARVIS_LLM_DIR  storage for routing.json and usage.json (default ./data/llm)
 */
import { AnthropicBackend, GeminiBackend, OllamaBackend, OpenAiBackend } from './llmBackends.js';
import type { LlmBackend } from './llmTypes.js';

type Env = Record<string, string | undefined>;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export interface ParsedUrl {
  url: string;
  loopback: boolean;
}

export function parseBaseUrl(raw: string | undefined): ParsedUrl | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  return { url: url.toString().replace(/\/+$/, ''), loopback: LOOPBACK.has(url.hostname) };
}

function cloudUrl(raw: string | undefined): string | null {
  const parsed = parseBaseUrl(raw);
  return parsed && !parsed.loopback && parsed.url.startsWith('https://') ? parsed.url : null;
}

const DEFAULT_MODELS = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-4-5',
  gemini: 'gemini-2.5-flash',
} as const;

export const DEFAULT_AZURE_API_VERSION = '2024-10-21'; // verify the currently supported version

/** Never throws; unconfigured or invalid providers are simply absent. */
export function loadBackends(env: Env = process.env, fetchImpl: typeof fetch = fetch): LlmBackend[] {
  const backends: LlmBackend[] = [];

  const legacyUrl = (env['JARVIS_AI_BASE_URL'] || '').replace(/\/v1\/?$/i, '');
  const ollama = parseBaseUrl(env['OLLAMA_URL'] || legacyUrl || 'http://localhost:11434');
  const ollamaModel = env['OLLAMA_MODEL'] || env['JARVIS_AI_MODEL'] || 'llama3.2:latest';
  if (ollama && MODEL_PATTERN.test(ollamaModel) && new URL(ollama.url).pathname === '/' && (ollama.loopback || env['JARVIS_AI_ALLOW_REMOTE'] === 'true')) {
    backends.push(new OllamaBackend({ baseUrl: ollama.url, defaultModel: ollamaModel, local: ollama.loopback, fetchImpl }));
  }

  const localOpenAi = parseBaseUrl(env['JARVIS_LOCAL_OPENAI_BASE_URL']);
  const localOpenAiModel = env['JARVIS_LOCAL_OPENAI_MODEL'] || 'local-model';
  if (localOpenAi?.loopback && MODEL_PATTERN.test(localOpenAiModel)) {
    backends.push(new OpenAiBackend({
      id: 'local-openai', label: 'Local OpenAI-compatible server', baseUrl: localOpenAi.url, defaultModel: localOpenAiModel,
      ...(env['JARVIS_LOCAL_OPENAI_API_KEY'] ? { apiKey: env['JARVIS_LOCAL_OPENAI_API_KEY'] } : {}), fetchImpl,
    }));
  }

  const openaiKey = env['JARVIS_CLOUD_OPENAI_API_KEY'];
  const openaiUrl = cloudUrl(env['JARVIS_CLOUD_OPENAI_BASE_URL'] || 'https://api.openai.com/v1');
  const openaiModel = env['JARVIS_CLOUD_OPENAI_MODEL'] || DEFAULT_MODELS.openai;
  if (openaiKey && openaiUrl && MODEL_PATTERN.test(openaiModel)) {
    backends.push(new OpenAiBackend({ id: 'openai', label: 'OpenAI', baseUrl: openaiUrl, defaultModel: openaiModel, apiKey: openaiKey, fetchImpl }));
  }

  const azureKey = env['JARVIS_CLOUD_AZURE_OPENAI_API_KEY'];
  const azureEndpoint = cloudUrl(env['JARVIS_CLOUD_AZURE_OPENAI_ENDPOINT']);
  const azureDeployment = env['JARVIS_CLOUD_AZURE_OPENAI_DEPLOYMENT'];
  const azureVersion = env['JARVIS_CLOUD_AZURE_OPENAI_API_VERSION'] || DEFAULT_AZURE_API_VERSION;
  if (azureKey && azureEndpoint && azureDeployment && MODEL_PATTERN.test(azureDeployment) && /^[0-9A-Za-z.-]{4,40}$/.test(azureVersion)) {
    backends.push(new OpenAiBackend({
      id: 'azure-openai', label: 'Azure OpenAI', baseUrl: azureEndpoint, defaultModel: azureDeployment, apiKey: azureKey, apiVersion: azureVersion, fetchImpl,
    }));
  }

  const anthropicKey = env['JARVIS_CLOUD_ANTHROPIC_API_KEY'];
  const anthropicUrl = cloudUrl(env['JARVIS_CLOUD_ANTHROPIC_BASE_URL'] || 'https://api.anthropic.com/v1');
  const anthropicModel = env['JARVIS_CLOUD_ANTHROPIC_MODEL'] || DEFAULT_MODELS.anthropic;
  if (anthropicKey && anthropicUrl && MODEL_PATTERN.test(anthropicModel)) {
    backends.push(new AnthropicBackend({ baseUrl: anthropicUrl, defaultModel: anthropicModel, apiKey: anthropicKey, fetchImpl }));
  }

  const geminiKey = env['JARVIS_CLOUD_GEMINI_API_KEY'];
  const geminiUrl = cloudUrl(env['JARVIS_CLOUD_GEMINI_BASE_URL'] || 'https://generativelanguage.googleapis.com/v1beta');
  const geminiModel = env['JARVIS_CLOUD_GEMINI_MODEL'] || DEFAULT_MODELS.gemini;
  if (geminiKey && geminiUrl && MODEL_PATTERN.test(geminiModel)) {
    backends.push(new GeminiBackend({ baseUrl: geminiUrl, defaultModel: geminiModel, apiKey: geminiKey, fetchImpl }));
  }
  return backends;
}
