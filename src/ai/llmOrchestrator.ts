/**
 * Multi-LLM orchestrator: task-based model selection, fallback chain with per-provider circuit
 * breakers, cost control and performance monitoring.
 *
 * Mandatory rules (unchanged from the original provider router):
 *  - Private data never goes to a cloud (or any non-loopback) provider. The privacy flag must be
 *    explicitly false; a missing or invalid flag is treated as private.
 *  - A paid provider is used only when the owner authorized cloud, per request/task or through the
 *    global owner setting, and only within the monthly budget (a hard stop; budget 0 = no paid spend).
 *  - Zero cost is the default: local models first, nothing paid without authorization.
 *  - Fallback never moves from local to a paid provider unless that provider was itself eligible.
 */
import { CircuitBreaker } from './circuitBreaker.js';
import { OllamaBackend, OpenAiBackend } from './llmBackends.js';
import { LlmConfigStore, type LlmRoutingConfig, type TaskRule } from './llmConfig.js';
import { LlmMetrics } from './llmMetrics.js';
import { costUsd, estimateMessageTokens, estimateTokens, lookupPrice, PRICING_NOTE, TIER_RANK, type ModelPrice } from './llmPricing.js';
import { capabilitiesFor, familyOf, ModelCatalog, type CatalogModel } from './modelCatalog.js';
import { loadBackends } from './providerEnv.js';
import { cloudAllowedTasks, routingMode, type TaskType } from './providerRouter.js';
import {
  LLM_PROVIDER_IDS, LlmError,
  type LlmBackend, type LlmChunk, type LlmHealth, type LlmMessage, type LlmOptions, type LlmProviderId, type LlmResult, type LlmTaskType, type LlmUsage,
} from './llmTypes.js';

type Env = Record<string, string | undefined>;

export interface LlmRequest {
  task: LlmTaskType;
  messages: LlmMessage[];
  /** Must be explicitly false for any non-loopback provider (fail closed). */
  containsPrivateData: boolean;
  /** Owner authorized cloud for this request/task. */
  cloudAuthorized?: boolean;
  options?: LlmOptions;
  /** Restrict to one provider (and optionally model), e.g. the owner's "test a model" button. Eligibility still applies. */
  only?: { provider: LlmProviderId; model?: string };
}

export interface Candidate {
  provider: LlmProviderId;
  model: string;
  local: boolean;
  paid: boolean;
  estCostUsd: number;
}

export interface SkippedProvider {
  provider: LlmProviderId;
  model?: string;
  reason: string;
}

export interface Plan {
  candidates: Candidate[];
  skipped: SkippedProvider[];
}

export interface Attempt {
  provider: LlmProviderId;
  model: string;
  ok: boolean;
  error?: string;
}

export interface LlmResponse {
  text: string;
  provider: LlmProviderId;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
  costUsd: number;
  latencyMs: number;
  /** True when an earlier candidate failed or was skipped by its circuit breaker. */
  fellBack: boolean;
  attempts: Attempt[];
}

export type StreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; provider: LlmProviderId; model: string; usage: { inputTokens: number; outputTokens: number }; costUsd: number; ttftMs: number | null; totalMs: number; fellBack: boolean; attempts: Attempt[] };

export class LlmRoutingError extends Error {
  constructor(readonly code: 'no_eligible_provider' | 'all_providers_failed', readonly plan: Plan, readonly attempts: Attempt[]) {
    super(code);
    this.name = 'LlmRoutingError';
  }
}

export interface ProviderStatusView {
  id: LlmProviderId;
  label: string;
  configured: boolean;
  local: boolean;
  paid: boolean;
  defaultModel?: string;
  breaker?: { state: string; consecutiveFailures: number; retryInSeconds?: number };
  health?: { ok: boolean; detail?: string; latencyMs?: number; checkedAt: number };
}

const LABELS: Record<LlmProviderId, string> = {
  ollama: 'Ollama', 'local-openai': 'Local OpenAI-compatible server', openai: 'OpenAI', 'azure-openai': 'Azure OpenAI', anthropic: 'Anthropic Claude', gemini: 'Google Gemini',
};

const LEGACY_TASKS: Record<TaskType, LlmTaskType> = { conversation: 'chat', agent: 'reasoning', site: 'chat', developer: 'code', summarize: 'summarize' };
/** Map a task type of the original provider router to the new task taxonomy. */
export function legacyTaskToLlm(task: TaskType): LlmTaskType {
  return LEGACY_TASKS[task] ?? 'chat';
}

const EMBED_MODEL = /embed/i;
const DEFAULT_MAX_OUTPUT_ESTIMATE = 1024;
const MAX_LOCAL_PER_BACKEND = 2;
const HEALTH_TIMEOUT_MS = 5000;
const ENV_KEYS = [
  'OLLAMA_URL', 'JARVIS_AI_BASE_URL', 'OLLAMA_MODEL', 'JARVIS_AI_MODEL', 'JARVIS_AI_ALLOW_REMOTE', 'JARVIS_LOCAL_OPENAI_BASE_URL', 'JARVIS_LOCAL_OPENAI_MODEL', 'JARVIS_LOCAL_OPENAI_API_KEY',
  'JARVIS_CLOUD_OPENAI_API_KEY', 'JARVIS_CLOUD_OPENAI_MODEL', 'JARVIS_CLOUD_OPENAI_BASE_URL',
  'JARVIS_CLOUD_AZURE_OPENAI_API_KEY', 'JARVIS_CLOUD_AZURE_OPENAI_ENDPOINT', 'JARVIS_CLOUD_AZURE_OPENAI_DEPLOYMENT', 'JARVIS_CLOUD_AZURE_OPENAI_API_VERSION',
  'JARVIS_CLOUD_ANTHROPIC_API_KEY', 'JARVIS_CLOUD_ANTHROPIC_MODEL', 'JARVIS_CLOUD_ANTHROPIC_BASE_URL',
  'JARVIS_CLOUD_GEMINI_API_KEY', 'JARVIS_CLOUD_GEMINI_MODEL', 'JARVIS_CLOUD_GEMINI_BASE_URL',
] as const;

export interface OrchestratorOptions {
  env?: () => Env;
  now?: () => number;
  /** Fixed backends (tests); default: built from the environment. */
  backends?: () => LlmBackend[];
  config?: LlmConfigStore;
  metrics?: LlmMetrics;
  fetchImpl?: typeof fetch;
}

export class LlmOrchestrator {
  readonly config: LlmConfigStore;
  readonly metrics: LlmMetrics;
  private readonly env: () => Env;
  private readonly now: () => number;
  private readonly backendSource: () => LlmBackend[];
  private readonly breakers = new Map<LlmProviderId, CircuitBreaker>();
  private readonly healthResults = new Map<LlmProviderId, { ok: boolean; detail?: string; latencyMs?: number; checkedAt: number }>();
  private readonly catalogCache: ModelCatalog;
  private readonly openAiModelCache = new Map<string, { at: number; models: string[] }>();
  private cached: { key: string; list: LlmBackend[] } | null = null;

  constructor(options: OrchestratorOptions = {}) {
    this.env = options.env ?? (() => process.env);
    this.now = options.now ?? Date.now;
    this.config = options.config ?? new LlmConfigStore();
    this.metrics = options.metrics ?? new LlmMetrics(undefined, this.now);
    const fetchImpl = options.fetchImpl ?? fetch;
    this.backendSource = options.backends ?? (() => {
      const env = this.env();
      const key = JSON.stringify(ENV_KEYS.map((name) => env[name] ?? ''));
      if (!this.cached || this.cached.key !== key) this.cached = { key, list: loadBackends(env, fetchImpl) };
      return this.cached.list;
    });
    this.catalogCache = new ModelCatalog(() => {
      const ollama = this.backends().find((backend) => backend instanceof OllamaBackend && backend.local);
      return ollama instanceof OllamaBackend ? ollama : null;
    }, 60_000, this.now);
  }

  backends(): LlmBackend[] {
    return this.backendSource();
  }

  private backend(id: LlmProviderId): LlmBackend | undefined {
    return this.backends().find((backend) => backend.id === id);
  }

  private breaker(id: LlmProviderId): CircuitBreaker {
    const cfg = this.config.get().breaker;
    const options = { failureThreshold: cfg.failureThreshold, openMs: cfg.openSeconds * 1000 };
    let breaker = this.breakers.get(id);
    if (!breaker) {
      breaker = new CircuitBreaker(options, this.now);
      this.breakers.set(id, breaker);
    } else {
      breaker.configure(options);
    }
    return breaker;
  }

  // ---------------------------------------------------------------- catalog

  /** Local models (Ollama catalog plus any OpenAI-compatible local server). */
  async localModels(force = false): Promise<Array<CatalogModel & { provider: LlmProviderId }>> {
    const out: Array<CatalogModel & { provider: LlmProviderId }> = [];
    for (const backend of this.backends()) {
      if (!backend.local) continue;
      if (backend instanceof OllamaBackend) {
        for (const model of await this.catalogCache.models(force)) out.push({ ...model, provider: 'ollama' });
      } else if (backend instanceof OpenAiBackend) {
        for (const name of await this.openAiModels(backend, force)) {
          out.push({ name, family: familyOf(name), capabilities: capabilitiesFor(name), provider: 'local-openai' });
        }
      }
    }
    return out;
  }

  private async openAiModels(backend: OpenAiBackend, force: boolean): Promise<string[]> {
    const hit = this.openAiModelCache.get(backend.id);
    if (!force && hit && this.now() - hit.at < 60_000) return hit.models;
    let models: string[] = [];
    try {
      models = await backend.listModels(AbortSignal.timeout(5000));
    } catch { /* unreachable server: no models */ }
    this.openAiModelCache.set(backend.id, { at: this.now(), models });
    return models;
  }

  /** Configured cloud models with their (editable, unverified) prices; no credentials or URLs. */
  cloudModels(): Array<{ provider: LlmProviderId; model: string; isDefault: boolean } & ModelPrice> {
    const cfg = this.config.get();
    const out: Array<{ provider: LlmProviderId; model: string; isDefault: boolean } & ModelPrice> = [];
    for (const backend of this.backends()) {
      if (backend.local) continue;
      const models = [...new Set([backend.defaultModel, ...(cfg.cloudModels[backend.id] ?? [])])];
      for (const model of models) out.push({ provider: backend.id, model, isDefault: model === backend.defaultModel, ...lookupPrice(cfg.pricing, backend.id, model, backend.paid) });
    }
    return out;
  }

  // ---------------------------------------------------------------- planning

  private localRank(rule: TaskRule, model: CatalogModel): [number, number] {
    const name = model.name.toLowerCase();
    const index = rule.preferModels.findIndex((fragment) => name.includes(fragment.toLowerCase()));
    const pref = index < 0 ? 99 : index;
    const size = model.sizeBillions ?? 1000;
    return rule.sizeBias === 'small' ? [size, pref] : rule.sizeBias === 'large' ? [pref, -size] : [pref, size];
  }

  private authorization(request: LlmRequest, cfg: LlmRoutingConfig): string | null {
    if (request.cloudAuthorized === true) return 'request';
    if (cfg.cloud.authorizedTasks.includes(request.task)) return 'task';
    if (cfg.cloud.globalAuthorized) return 'global';
    for (const legacy of cloudAllowedTasks(this.env())) if (legacyTaskToLlm(legacy) === request.task) return 'env';
    return null;
  }

  /** Decide the ordered candidate list (local first, then eligible cloud by cheapest adequate model). */
  async plan(request: LlmRequest): Promise<Plan> {
    const cfg = this.config.get();
    const rule = cfg.rules[request.task];
    const mode = routingMode(this.env());
    const skipped: SkippedProvider[] = [];
    const candidates: Candidate[] = [];
    const inputTokens = estimateMessageTokens(request.messages);
    const maxOut = request.task === 'embed' ? 0 : request.options?.maxTokens ?? DEFAULT_MAX_OUTPUT_ESTIMATE;
    const wantsOnly = request.only;
    const required = request.task === 'embed' ? 'embeddings' : request.task === 'vision' ? 'vision' : rule.requireCapability ?? 'chat';

    // ---- local (loopback) providers: always eligible, zero cost
    const localModels = await this.localModels();
    for (const backend of this.backends().filter((item) => item.local)) {
      if (wantsOnly && wantsOnly.provider !== backend.id) continue;
      if (request.task === 'embed' && !backend.supportsEmbeddings) { skipped.push({ provider: backend.id, reason: 'embeddings unsupported' }); continue; }
      if (wantsOnly?.model) {
        candidates.push({ provider: backend.id, model: wantsOnly.model, local: true, paid: false, estCostUsd: 0 });
        continue;
      }
      const known = localModels.filter((model) => model.provider === backend.id);
      if (known.length === 0) {
        // Catalog unavailable (server down or no models yet): try the configured default and let fallback handle failure.
        candidates.push({ provider: backend.id, model: backend.defaultModel, local: true, paid: false, estCostUsd: 0 });
        continue;
      }
      let usable = known.filter((model) => model.capabilities.includes(required));
      if (rule.maxLocalSizeBillions !== undefined) {
        const small = usable.filter((model) => model.sizeBillions === undefined || model.sizeBillions <= rule.maxLocalSizeBillions!);
        if (small.length > 0) usable = small;
      }
      if (usable.length === 0) { skipped.push({ provider: backend.id, reason: `no local model with ${required} capability` }); continue; }
      usable.sort((a, b) => {
        const ra = this.localRank(rule, a);
        const rb = this.localRank(rule, b);
        return ra[0] - rb[0] || ra[1] - rb[1] || a.name.localeCompare(b.name);
      });
      for (const model of usable.slice(0, MAX_LOCAL_PER_BACKEND)) candidates.push({ provider: backend.id, model: model.name, local: true, paid: false, estCostUsd: 0 });
    }

    // ---- non-loopback providers (paid cloud, or a remote Ollama)
    const authorizedBy = this.authorization(request, cfg);
    const spent = this.metrics.spentThisMonth();
    const cloud: Candidate[] = [];
    const pairs: Array<{ backend: LlmBackend; model: string; price: ModelPrice }> = [];
    for (const backend of this.backends().filter((item) => !item.local)) {
      if (wantsOnly && wantsOnly.provider !== backend.id) continue;
      const block = (reason: string) => skipped.push({ provider: backend.id, reason });
      if (mode !== 'local-first') { block(`routing mode ${mode} forbids cloud providers`); continue; }
      if (request.containsPrivateData !== false) { block('request is private or its privacy classification is missing; local only'); continue; }
      if (!authorizedBy) { block('cloud use not authorized by the owner for this task'); continue; }
      if (request.task === 'embed' && !backend.supportsEmbeddings) { block('embeddings unsupported'); continue; }
      const configured = [...new Set([backend.defaultModel, ...(cfg.cloudModels[backend.id] ?? [])])];
      const models = wantsOnly?.model ? [wantsOnly.model] : configured.filter((model) => (request.task === 'embed') === EMBED_MODEL.test(model));
      if (models.length === 0) { block(request.task === 'embed' ? 'no embedding model configured' : 'no model configured'); continue; }
      for (const model of models) pairs.push({ backend, model, price: lookupPrice(cfg.pricing, backend.id, model, backend.paid) });
    }
    // Cheapest adequate model: keep models at or above the task's minimum tier when any exist.
    const adequate = wantsOnly?.model ? pairs : pairs.filter((pair) => TIER_RANK[pair.price.tier] >= TIER_RANK[rule.cloudMinTier]);
    for (const { backend, model, price } of adequate.length > 0 ? adequate : pairs) {
      const estCostUsd = backend.paid ? costUsd(price, inputTokens, maxOut) : 0;
      if (backend.paid) {
        if (cfg.cloud.monthlyBudgetUsd <= 0) { skipped.push({ provider: backend.id, model, reason: 'monthly budget is 0: no paid spend allowed' }); continue; }
        if (estCostUsd > cfg.cloud.perRequestMaxUsd) { skipped.push({ provider: backend.id, model, reason: 'estimated cost exceeds the per-request limit' }); continue; }
        if (spent + estCostUsd > cfg.cloud.monthlyBudgetUsd) { skipped.push({ provider: backend.id, model, reason: 'monthly budget would be exceeded' }); continue; }
      }
      cloud.push({ provider: backend.id, model, local: false, paid: backend.paid, estCostUsd });
    }
    cloud.sort((a, b) => a.estCostUsd - b.estCostUsd || a.provider.localeCompare(b.provider));
    candidates.push(...cloud);
    return { candidates, skipped };
  }

  // ---------------------------------------------------------------- execution

  private signalFor(candidate: Candidate, external?: AbortSignal): AbortSignal {
    const cfg = this.config.get().timeouts;
    const timeout = AbortSignal.timeout((candidate.local ? cfg.localSeconds : cfg.cloudSeconds) * 1000);
    return external ? AbortSignal.any([external, timeout]) : timeout;
  }

  private priceFor(candidate: Candidate): ModelPrice {
    return lookupPrice(this.config.get().pricing, candidate.provider, candidate.model, candidate.paid);
  }

  private finish(request: LlmRequest, candidate: Candidate, index: number, startedAt: number, text: string, usage: LlmUsage | undefined, ttftMs: number | undefined): { usage: { inputTokens: number; outputTokens: number }; costUsd: number; totalMs: number } {
    const inputTokens = usage?.inputTokens ?? estimateMessageTokens(request.messages);
    const outputTokens = usage?.outputTokens ?? estimateTokens(text);
    const cost = candidate.paid ? costUsd(this.priceFor(candidate), inputTokens, outputTokens) : 0;
    const totalMs = this.now() - startedAt;
    this.metrics.record({
      t: this.now(), provider: candidate.provider, model: candidate.model, task: request.task, ok: true,
      ...(ttftMs !== undefined ? { ttftMs } : {}), totalMs, inputTokens, outputTokens,
      ...(totalMs > 0 && outputTokens > 0 ? { tokensPerSec: outputTokens / (totalMs / 1000) } : {}), fallback: index > 0, costUsd: cost,
    });
    this.breaker(candidate.provider).recordSuccess();
    return { usage: { inputTokens, outputTokens }, costUsd: cost, totalMs };
  }

  private fail(request: LlmRequest, candidate: Candidate, index: number, startedAt: number, error: unknown): string {
    const kind = error instanceof LlmError ? error.kind : 'error';
    // A missing model says nothing about the provider's health.
    if (kind === 'model_missing' || kind === 'unsupported') this.breaker(candidate.provider).releaseProbe();
    else this.breaker(candidate.provider).recordFailure();
    this.metrics.record({
      t: this.now(), provider: candidate.provider, model: candidate.model, task: request.task, ok: false, errorKind: kind,
      totalMs: this.now() - startedAt, inputTokens: 0, outputTokens: 0, fallback: index > 0, costUsd: 0,
    });
    return kind;
  }

  private async prepare(request: LlmRequest): Promise<Plan> {
    if (!Array.isArray(request.messages) || request.messages.length === 0) throw new LlmError('invalid_response');
    const plan = await this.plan(request);
    if (plan.candidates.length === 0) throw new LlmRoutingError('no_eligible_provider', plan, []);
    return plan;
  }

  /** Non-streaming chat with fallback. */
  async chat(request: LlmRequest, signal?: AbortSignal): Promise<LlmResponse> {
    const plan = await this.prepare(request);
    const attempts: Attempt[] = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      const backend = this.backend(candidate.provider);
      if (!backend) continue;
      if (!this.breaker(candidate.provider).canAttempt()) { attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, error: 'circuit_open' }); continue; }
      const startedAt = this.now();
      try {
        const result: LlmResult = await backend.chat(candidate.model, request.messages, request.options ?? {}, this.signalFor(candidate, signal));
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: true });
        const done = this.finish(request, candidate, index, startedAt, result.text, result.usage, undefined);
        return { text: result.text, provider: candidate.provider, model: candidate.model, usage: done.usage, costUsd: done.costUsd, latencyMs: done.totalMs, fellBack: attempts.length > 1, attempts };
      } catch (error) {
        if (signal?.aborted) { this.breaker(candidate.provider).releaseProbe(); throw new DOMException('Aborted', 'AbortError'); }
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, error: this.fail(request, candidate, index, startedAt, error) });
      }
    }
    throw new LlmRoutingError('all_providers_failed', plan, attempts);
  }

  /**
   * Streaming chat. Falls back to the next candidate only before the first token is emitted;
   * once text has been delivered an error is surfaced instead (no mixed output).
   */
  async *stream(request: LlmRequest, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const plan = await this.prepare(request);
    const attempts: Attempt[] = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      const backend = this.backend(candidate.provider);
      if (!backend) continue;
      if (!this.breaker(candidate.provider).canAttempt()) { attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, error: 'circuit_open' }); continue; }
      const startedAt = this.now();
      let ttft: number | undefined;
      let text = '';
      let usage: LlmUsage | undefined;
      try {
        const iterator: AsyncIterable<LlmChunk> = backend.stream(candidate.model, request.messages, request.options ?? {}, this.signalFor(candidate, signal));
        for await (const chunk of iterator) {
          if (chunk.usage) usage = { ...usage, ...chunk.usage };
          if (chunk.text) {
            ttft ??= this.now() - startedAt;
            text += chunk.text;
            yield { type: 'delta', text: chunk.text };
          }
        }
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: true });
        const done = this.finish(request, candidate, index, startedAt, text, usage, ttft);
        yield { type: 'done', provider: candidate.provider, model: candidate.model, usage: done.usage, costUsd: done.costUsd, ttftMs: ttft ?? null, totalMs: done.totalMs, fellBack: attempts.length > 1, attempts };
        return;
      } catch (error) {
        if (signal?.aborted) { this.breaker(candidate.provider).releaseProbe(); throw new DOMException('Aborted', 'AbortError'); }
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, error: this.fail(request, candidate, index, startedAt, error) });
        if (text) throw new LlmRoutingError('all_providers_failed', plan, attempts);
      }
    }
    throw new LlmRoutingError('all_providers_failed', plan, attempts);
  }

  /** Embeddings with the same routing rules (task "embed"). */
  async embed(input: string[], options: { containsPrivateData: boolean; cloudAuthorized?: boolean; only?: LlmRequest['only'] }, signal?: AbortSignal): Promise<{ vectors: number[][]; provider: LlmProviderId; model: string; costUsd: number; attempts: Attempt[] }> {
    const request: LlmRequest = { task: 'embed', messages: input.map((content) => ({ role: 'user' as const, content })), containsPrivateData: options.containsPrivateData, ...(options.cloudAuthorized !== undefined ? { cloudAuthorized: options.cloudAuthorized } : {}), ...(options.only ? { only: options.only } : {}) };
    const plan = await this.prepare(request);
    const attempts: Attempt[] = [];
    for (const [index, candidate] of plan.candidates.entries()) {
      const backend = this.backend(candidate.provider);
      if (!backend) continue;
      if (!this.breaker(candidate.provider).canAttempt()) { attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, error: 'circuit_open' }); continue; }
      const startedAt = this.now();
      try {
        const result = await backend.embed(candidate.model, input, this.signalFor(candidate, signal));
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: true });
        const done = this.finish({ ...request, messages: request.messages }, candidate, index, startedAt, '', { inputTokens: result.usage?.inputTokens ?? estimateMessageTokens(request.messages), outputTokens: 0 }, undefined);
        return { vectors: result.vectors, provider: candidate.provider, model: candidate.model, costUsd: done.costUsd, attempts };
      } catch (error) {
        if (signal?.aborted) { this.breaker(candidate.provider).releaseProbe(); throw new DOMException('Aborted', 'AbortError'); }
        attempts.push({ provider: candidate.provider, model: candidate.model, ok: false, error: this.fail(request, candidate, index, startedAt, error) });
      }
    }
    throw new LlmRoutingError('all_providers_failed', plan, attempts);
  }

  // ---------------------------------------------------------------- status and health

  /** Run health checks (all providers or one) and remember the results. */
  async checkHealth(only?: LlmProviderId): Promise<Record<string, LlmHealth>> {
    const results: Record<string, LlmHealth> = {};
    await Promise.all(this.backends().filter((backend) => !only || backend.id === only).map(async (backend) => {
      const health = await backend.health(AbortSignal.timeout(HEALTH_TIMEOUT_MS));
      this.healthResults.set(backend.id, { ok: health.ok, ...(health.detail ? { detail: health.detail } : {}), ...(health.latencyMs !== undefined ? { latencyMs: health.latencyMs } : {}), checkedAt: this.now() });
      results[backend.id] = health;
    }));
    return results;
  }

  /** Safe status for owner views: no URLs, no credentials. */
  status(): { mode: string; providers: ProviderStatusView[]; budget: { monthlyBudgetUsd: number; spentUsd: number; remainingUsd: number; perRequestMaxUsd: number; month: string; byProvider: Record<string, number>; globalAuthorized: boolean; authorizedTasks: LlmTaskType[] }; pricingNote: string } {
    const cfg = this.config.get();
    const backends = this.backends();
    const ledger = this.metrics.ledger();
    return {
      mode: routingMode(this.env()),
      providers: LLM_PROVIDER_IDS.map((id) => {
        const backend = backends.find((item) => item.id === id);
        const health = this.healthResults.get(id);
        return {
          id, label: LABELS[id], configured: Boolean(backend), local: backend?.local ?? (id === 'ollama' || id === 'local-openai'),
          paid: backend?.paid ?? !(id === 'ollama' || id === 'local-openai'),
          ...(backend ? { defaultModel: backend.defaultModel, breaker: this.breaker(id).snapshot() } : {}),
          ...(health ? { health } : {}),
        };
      }),
      budget: {
        monthlyBudgetUsd: cfg.cloud.monthlyBudgetUsd, spentUsd: ledger.totalUsd, remainingUsd: Math.max(0, cfg.cloud.monthlyBudgetUsd - ledger.totalUsd),
        perRequestMaxUsd: cfg.cloud.perRequestMaxUsd, month: ledger.month, byProvider: { ...ledger.byProvider } as Record<string, number>,
        globalAuthorized: cfg.cloud.globalAuthorized, authorizedTasks: [...cfg.cloud.authorizedTasks],
      },
      pricingNote: PRICING_NOTE,
    };
  }

  /** Owner "test a model": one short chat through the normal eligibility rules (no fallback to other providers). */
  async test(provider: LlmProviderId, model: string | undefined, prompt: string, signal?: AbortSignal): Promise<LlmResponse> {
    return this.chat({
      task: 'chat', messages: [{ role: 'user', content: prompt }], containsPrivateData: false,
      options: { maxTokens: 200, temperature: 0.2 }, only: { provider, ...(model ? { model } : {}) },
    }, signal);
  }
}

let shared: LlmOrchestrator | undefined;
/** Process-wide orchestrator (lazy so importing this module has no side effects). */
export function getLlmOrchestrator(): LlmOrchestrator {
  shared ??= new LlmOrchestrator();
  return shared;
}
