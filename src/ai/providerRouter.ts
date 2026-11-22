/**
 * Adaptive AI provider routing (JARVIS-US-059).
 *
 * - Local inference (Ollama, OpenAI-compatible) is the default and zero-cost.
 * - Cloud adapters (OpenAI-compatible, Anthropic) exist only when configured via
 *   environment variables; credentials are never logged or returned.
 * - A cloud provider is eligible only when the owner authorized it: per request
 *   (`cloudAuthorized: true`, set by an owner-approved task) or via the
 *   JARVIS_CLOUD_ALLOWED_TASKS allowlist.
 * - Requests containing personal memory or other private context are local-only.
 * - Every decision records which provider was chosen, why, and what was skipped.
 */

export type ProviderId = 'local' | 'openai' | 'anthropic';
export type ProviderFormat = 'ollama' | 'openai' | 'anthropic';
export type TaskType = 'conversation' | 'agent' | 'site' | 'developer' | 'summarize';

export interface ProviderConfig {
  id: ProviderId;
  format: ProviderFormat;
  baseUrl: string;
  model: string;
  apiKey?: string;
  local: boolean;
  /** 'free' for local inference; 'paid' for metered cloud APIs. */
  cost: 'free' | 'paid';
  /** Request timeout in milliseconds; set for local Ollama inference. */
  timeoutMs?: number;
}

export interface RoutingRequest {
  taskType: TaskType;
  /** True when the prompt carries personal memory, conversation history or other private data. */
  containsPrivateData: boolean;
  /** Owner explicitly authorized cloud use for this task. */
  cloudAuthorized?: boolean;
  /** Only providers speaking these formats are acceptable (e.g. streaming site gateway needs 'openai'). */
  formats?: ProviderFormat[];
}

export interface RoutingDecision {
  provider: ProviderConfig | null;
  reason: string;
  skipped: Array<{ id: ProviderId; reason: string }>;
}

export interface ProviderStatus {
  id: ProviderId;
  configured: boolean;
  local: boolean;
  cost: 'free' | 'paid';
  model?: string;
  available: boolean;
  /** Seconds until a provider marked unavailable is retried. */
  retryInSeconds?: number;
}

type Env = Record<string, string | undefined>;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const UNAVAILABLE_COOLDOWN_MS = 60_000;
const TASK_TYPES: TaskType[] = ['conversation', 'agent', 'site', 'developer', 'summarize'];

function validBaseUrl(raw: string | undefined, requireHttps: boolean): { url: string; local: boolean } | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  const local = LOOPBACK.has(url.hostname);
  if (!local && (requireHttps || url.protocol !== 'https:')) {
    if (url.protocol !== 'https:') return null;
  }
  return { url: url.toString().replace(/\/$/, ''), local };
}

/** Build the provider list from environment configuration. Never throws. */
export function loadProviders(env: Env = process.env): ProviderConfig[] {
  const providers: ProviderConfig[] = [];

  // Native Ollama is the primary local provider. Legacy JARVIS_AI_* settings remain
  // supported during migration; a legacy /v1 suffix is removed for native /api routes.
  const legacyUrl = (env['JARVIS_AI_BASE_URL'] || '').replace(/\/v1\/?$/i, '');
  const localUrl = validBaseUrl(env['OLLAMA_URL'] || legacyUrl || 'http://localhost:11434', false);
  const localModel = env['OLLAMA_MODEL'] || env['JARVIS_AI_MODEL'] || 'llama3.2:latest';
  const timeoutRaw = env['OLLAMA_TIMEOUT'];
  const timeoutSeconds = timeoutRaw === undefined ? 120 : Number(timeoutRaw);
  const validTimeout = Number.isSafeInteger(timeoutSeconds) && timeoutSeconds >= 1 && timeoutSeconds <= 600;
  const rootEndpoint = localUrl ? new URL(localUrl.url).pathname === '/' : false;
  if (localUrl && rootEndpoint && validTimeout && MODEL_PATTERN.test(localModel) &&
      (localUrl.local || env['JARVIS_AI_ALLOW_REMOTE'] === 'true')) {
    providers.push({
      id: 'local',
      format: 'ollama',
      baseUrl: localUrl.url,
      model: localModel,
      timeoutMs: timeoutSeconds * 1000,
      local: localUrl.local,
      cost: localUrl.local ? 'free' : 'paid',
    });
  }

  const openaiKey = env['JARVIS_CLOUD_OPENAI_API_KEY'];
  const openaiModel = env['JARVIS_CLOUD_OPENAI_MODEL'];
  const openaiUrl = validBaseUrl(env['JARVIS_CLOUD_OPENAI_BASE_URL'] || 'https://api.openai.com/v1', true);
  if (openaiKey && openaiModel && MODEL_PATTERN.test(openaiModel) && openaiUrl && !openaiUrl.local) {
    providers.push({ id: 'openai', format: 'openai', baseUrl: openaiUrl.url, model: openaiModel, apiKey: openaiKey, local: false, cost: 'paid' });
  }

  const anthropicKey = env['JARVIS_CLOUD_ANTHROPIC_API_KEY'];
  const anthropicModel = env['JARVIS_CLOUD_ANTHROPIC_MODEL'];
  const anthropicUrl = validBaseUrl(env['JARVIS_CLOUD_ANTHROPIC_BASE_URL'] || 'https://api.anthropic.com/v1', true);
  if (anthropicKey && anthropicModel && MODEL_PATTERN.test(anthropicModel) && anthropicUrl && !anthropicUrl.local) {
    providers.push({ id: 'anthropic', format: 'anthropic', baseUrl: anthropicUrl.url, model: anthropicModel, apiKey: anthropicKey, local: false, cost: 'paid' });
  }
  return providers;
}

/** Task types the owner pre-approved for cloud use (JARVIS_CLOUD_ALLOWED_TASKS=conversation,developer). */
export function cloudAllowedTasks(env: Env = process.env): Set<TaskType> {
  const raw = (env['JARVIS_CLOUD_ALLOWED_TASKS'] || '').split(',').map((item) => item.trim()).filter(Boolean);
  return new Set(raw.filter((item): item is TaskType => (TASK_TYPES as string[]).includes(item)));
}

/**
 * Explicit, owner-configured routing mode (JARVIS_ROUTING_MODE):
 *  - local-first (default): local inference first; cloud only when owner-authorized per task.
 *  - local-only: cloud providers are never used, even if configured and authorized.
 *  - offline: like local-only, and additionally nothing but a loopback endpoint is contacted.
 * An unrecognised value fails closed to local-only.
 */
export type RoutingMode = 'local-first' | 'local-only' | 'offline';

export function routingMode(env: Env = process.env): RoutingMode {
  const raw = (env['JARVIS_ROUTING_MODE'] || '').trim().toLowerCase();
  if (raw === '') return 'local-first';
  if (raw === 'local-first' || raw === 'local-only' || raw === 'offline') return raw;
  return 'local-only';
}

export function cloudRoutingAllowed(env: Env = process.env): boolean {
  return routingMode(env) === 'local-first';
}

export class ProviderRouter {
  private readonly unavailableUntil = new Map<ProviderId, number>();
  private lastDecision: { at: number; taskType: TaskType; provider: ProviderId | null; reason: string } | null = null;

  constructor(
    private readonly env: () => Env = () => process.env,
    private readonly now: () => number = Date.now,
  ) {}

  providers(): ProviderConfig[] {
    return loadProviders(this.env());
  }

  /**
   * The loopback Ollama provider, for health checks and diagnostics. Goes through the same
   * provider list (and loopback rule) as route(), so no caller picks an endpoint on its own.
   */
  localProvider(): ProviderConfig | undefined {
    return this.providers().find((provider) => provider.id === 'local' && provider.format === 'ollama' && provider.local);
  }

  /** Mark a provider failed (network/5xx/timeout) so routing avoids it for a cooldown period. */
  reportFailure(id: ProviderId): void {
    this.unavailableUntil.set(id, this.now() + UNAVAILABLE_COOLDOWN_MS);
  }

  reportSuccess(id: ProviderId): void {
    this.unavailableUntil.delete(id);
  }

  private isAvailable(id: ProviderId): boolean {
    const until = this.unavailableUntil.get(id);
    return until === undefined || until <= this.now();
  }

  route(request: RoutingRequest): RoutingDecision {
    const providers = this.providers();
    const skipped: RoutingDecision['skipped'] = [];
    const allowed = cloudAllowedTasks(this.env());
    const cloudOk = request.cloudAuthorized === true || allowed.has(request.taskType);
    const formatOk = (provider: ProviderConfig) => !request.formats || request.formats.includes(provider.format);

    const configuredLocal = providers.find((provider) => provider.id === 'local');
    const local = providers.find((provider) => provider.id === 'local' && provider.local);
    if (local && formatOk(local) && this.isAvailable(local.id)) {
      return this.remember(request.taskType, { provider: local, reason: 'local Ollama provider is the default', skipped });
    }
    if (!configuredLocal) skipped.push({ id: 'local', reason: 'not configured' });
    else if (!configuredLocal.local) skipped.push({ id: 'local', reason: 'configured Ollama endpoint is remote; owner authorization is required' });
    else if (!formatOk(configuredLocal)) skipped.push({ id: 'local', reason: 'incompatible format' });
    else skipped.push({ id: 'local', reason: 'temporarily unavailable after a recent failure' });

    const mode = routingMode(this.env());
    for (const provider of providers.filter((item) => !item.local)) {
      if (mode !== 'local-first') { skipped.push({ id: provider.id, reason: `routing mode ${mode} forbids cloud providers` }); continue; }
      if (request.containsPrivateData !== false) { skipped.push({ id: provider.id, reason: 'request is private or privacy classification is missing/invalid; local only' }); continue; }
      if (!cloudOk) { skipped.push({ id: provider.id, reason: 'cloud use not authorized by the owner for this task' }); continue; }
      if (!formatOk(provider)) { skipped.push({ id: provider.id, reason: 'incompatible format' }); continue; }
      if (!this.isAvailable(provider.id)) { skipped.push({ id: provider.id, reason: 'temporarily unavailable after a recent failure' }); continue; }
      return this.remember(request.taskType, { provider, reason: `cloud fallback (${provider.id}) authorized by the owner`, skipped });
    }
    return this.remember(request.taskType, { provider: null, reason: 'no eligible provider', skipped });
  }

  private remember(taskType: TaskType, decision: RoutingDecision): RoutingDecision {
    this.lastDecision = { at: this.now(), taskType, provider: decision.provider?.id ?? null, reason: decision.reason };
    return decision;
  }

  /** Safe status for owner views: no URLs or credentials. */
  status(): { mode: RoutingMode; providers: ProviderStatus[]; cloudAllowedTasks: TaskType[]; lastDecision: ProviderRouter['lastDecision'] } {
    const configured = this.providers();
    const ids: ProviderId[] = ['local', 'openai', 'anthropic'];
    return {
      mode: routingMode(this.env()),
      providers: ids.map((id) => {
        const provider = configured.find((item) => item.id === id);
        const until = this.unavailableUntil.get(id);
        const available = this.isAvailable(id);
        return {
          id,
          configured: Boolean(provider),
          local: provider?.local ?? id === 'local',
          cost: provider?.cost ?? (id === 'local' ? 'free' : 'paid'),
          ...(provider ? { model: provider.model } : {}),
          available: Boolean(provider) && available,
          ...(!available && until ? { retryInSeconds: Math.ceil((until - this.now()) / 1000) } : {}),
        };
      }),
      cloudAllowedTasks: [...cloudAllowedTasks(this.env())],
      lastDecision: this.lastDecision,
    };
  }
}

/** Process-wide router shared by conversation, agents and the site gateway. */
export const providerRouter = new ProviderRouter();
