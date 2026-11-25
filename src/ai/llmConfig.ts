/**
 * Owner-editable routing configuration (JSON file under JARVIS_LLM_DIR, default ./data/llm/routing.json).
 *
 * Defaults are zero-cost: cloud is not authorized, the monthly budget is 0 (no paid spend), and each
 * task prefers local models. The owner can edit rules, pricing and cloud settings through the
 * authenticated /api/llm/config route; changes that can increase spend (isEscalation) need a fresh
 * authenticator code.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DEFAULT_PRICING, TIER_RANK, type ModelPrice, type ModelTier } from './llmPricing.js';
import { LLM_PROVIDER_IDS, LLM_TASK_TYPES, type LlmCapability, type LlmProviderId, type LlmTaskType } from './llmTypes.js';

export interface TaskRule {
  /** Case-insensitive substrings of local model names, best first. Unmatched models rank after these. */
  preferModels: string[];
  /** Local models must have this capability (derived from the catalog). */
  requireCapability?: LlmCapability;
  /** small: smallest/fastest first; large: biggest first; any: preference order only. */
  sizeBias: 'small' | 'large' | 'any';
  /** Ignore local models larger than this many billion parameters (keeps fast tasks fast). */
  maxLocalSizeBillions?: number;
  /** When cloud is authorized, only models at or above this tier are considered (if any exist). */
  cloudMinTier: ModelTier;
}

export interface CloudSettings {
  /** Global owner authorization: any non-private task may use paid cloud, within the budget. */
  globalAuthorized: boolean;
  /** Per-task owner authorization (used when globalAuthorized is false). */
  authorizedTasks: LlmTaskType[];
  /** Hard monthly cap in USD. 0 means no paid spend is allowed at all. */
  monthlyBudgetUsd: number;
  /** A single request whose estimated cost exceeds this is refused. */
  perRequestMaxUsd: number;
}

export interface LlmRoutingConfig {
  version: 1;
  cloud: CloudSettings;
  rules: Record<LlmTaskType, TaskRule>;
  pricing: Record<string, ModelPrice>;
  /** Extra cloud model ids per provider (beyond the env-configured default), for cheapest-adequate choice. */
  cloudModels: Partial<Record<LlmProviderId, string[]>>;
  breaker: { failureThreshold: number; openSeconds: number };
  timeouts: { localSeconds: number; cloudSeconds: number };
}

export const DEFAULT_RULES: Record<LlmTaskType, TaskRule> = {
  chat: { preferModels: ['llama', 'qwen', 'mistral', 'gemma', 'phi'], sizeBias: 'any', cloudMinTier: 'small' },
  code: { preferModels: ['coder', 'codestral', 'deepseek', 'qwen', 'codellama', 'llama'], sizeBias: 'any', cloudMinTier: 'medium' },
  reasoning: { preferModels: ['deepseek-r1', 'qwq', 'qwen', 'llama', 'mistral'], sizeBias: 'large', cloudMinTier: 'large' },
  summarize: { preferModels: ['llama', 'mistral', 'gemma', 'qwen', 'phi'], sizeBias: 'any', cloudMinTier: 'small' },
  extract: { preferModels: ['qwen', 'phi', 'gemma', 'llama', 'mistral'], sizeBias: 'small', maxLocalSizeBillions: 9, cloudMinTier: 'small' },
  embed: { preferModels: ['nomic-embed', 'mxbai', 'bge', 'minilm', 'embed'], requireCapability: 'embeddings', sizeBias: 'small', cloudMinTier: 'small' },
  vision: { preferModels: ['llava', 'vision', 'minicpm-v', 'qwen2.5vl', 'gemma3', 'moondream'], requireCapability: 'vision', sizeBias: 'any', cloudMinTier: 'small' },
};

export function defaultConfig(): LlmRoutingConfig {
  return {
    version: 1,
    cloud: { globalAuthorized: false, authorizedTasks: [], monthlyBudgetUsd: 0, perRequestMaxUsd: 0.5 },
    rules: JSON.parse(JSON.stringify(DEFAULT_RULES)) as Record<LlmTaskType, TaskRule>,
    pricing: JSON.parse(JSON.stringify(DEFAULT_PRICING)) as Record<string, ModelPrice>,
    cloudModels: {},
    breaker: { failureThreshold: 3, openSeconds: 60 },
    timeouts: { localSeconds: 120, cloudSeconds: 60 },
  };
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PRICE_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,160}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export interface ValidationResult {
  ok: boolean;
  config: LlmRoutingConfig;
  errors: string[];
}

/** Validate untrusted input over the defaults; unknown keys are dropped, bad values reported. */
export function validateConfig(input: unknown, base: LlmRoutingConfig = defaultConfig()): ValidationResult {
  const config: LlmRoutingConfig = JSON.parse(JSON.stringify(base)) as LlmRoutingConfig;
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, config, errors: ['config must be an object'] };

  const cloud = input['cloud'];
  if (cloud !== undefined) {
    if (!isRecord(cloud)) errors.push('cloud must be an object');
    else {
      if (cloud['globalAuthorized'] !== undefined) {
        if (typeof cloud['globalAuthorized'] === 'boolean') config.cloud.globalAuthorized = cloud['globalAuthorized'];
        else errors.push('cloud.globalAuthorized must be a boolean');
      }
      if (cloud['authorizedTasks'] !== undefined) {
        const tasks = cloud['authorizedTasks'];
        if (Array.isArray(tasks) && tasks.every((t) => typeof t === 'string' && (LLM_TASK_TYPES as readonly string[]).includes(t))) {
          config.cloud.authorizedTasks = [...new Set(tasks as LlmTaskType[])];
        } else errors.push('cloud.authorizedTasks must list valid task types');
      }
      for (const [key, max] of [['monthlyBudgetUsd', 100_000], ['perRequestMaxUsd', 1000]] as const) {
        if (cloud[key] === undefined) continue;
        const value = boundedNumber(cloud[key], 0, max);
        if (value === null) errors.push(`cloud.${key} must be a number from 0 to ${max}`);
        else config.cloud[key] = value;
      }
    }
  }

  const rules = input['rules'];
  if (rules !== undefined) {
    if (!isRecord(rules)) errors.push('rules must be an object');
    else {
      for (const [task, raw] of Object.entries(rules)) {
        if (!(LLM_TASK_TYPES as readonly string[]).includes(task)) { errors.push(`unknown task type ${task.slice(0, 32)}`); continue; }
        if (!isRecord(raw)) { errors.push(`rules.${task} must be an object`); continue; }
        const rule = config.rules[task as LlmTaskType];
        if (raw['preferModels'] !== undefined) {
          const list = raw['preferModels'];
          if (Array.isArray(list) && list.length <= 20 && list.every((item) => typeof item === 'string' && item.length >= 1 && item.length <= 64 && /^[A-Za-z0-9._:/-]+$/.test(item))) rule.preferModels = list as string[];
          else errors.push(`rules.${task}.preferModels must be up to 20 model name fragments`);
        }
        if (raw['requireCapability'] !== undefined) {
          if (raw['requireCapability'] === null) delete rule.requireCapability;
          else if (['chat', 'code', 'embeddings', 'vision'].includes(String(raw['requireCapability']))) rule.requireCapability = raw['requireCapability'] as LlmCapability;
          else errors.push(`rules.${task}.requireCapability is invalid`);
        }
        if (raw['sizeBias'] !== undefined) {
          if (['small', 'large', 'any'].includes(String(raw['sizeBias']))) rule.sizeBias = raw['sizeBias'] as TaskRule['sizeBias'];
          else errors.push(`rules.${task}.sizeBias must be small, large or any`);
        }
        if (raw['maxLocalSizeBillions'] !== undefined) {
          if (raw['maxLocalSizeBillions'] === null) delete rule.maxLocalSizeBillions;
          else {
            const value = boundedNumber(raw['maxLocalSizeBillions'], 0.1, 2000);
            if (value === null) errors.push(`rules.${task}.maxLocalSizeBillions must be between 0.1 and 2000`);
            else rule.maxLocalSizeBillions = value;
          }
        }
        if (raw['cloudMinTier'] !== undefined) {
          if (String(raw['cloudMinTier']) in TIER_RANK) rule.cloudMinTier = raw['cloudMinTier'] as ModelTier;
          else errors.push(`rules.${task}.cloudMinTier must be small, medium or large`);
        }
      }
    }
  }

  const pricing = input['pricing'];
  if (pricing !== undefined) {
    if (!isRecord(pricing) || Object.keys(pricing).length > 200) errors.push('pricing must be an object with at most 200 entries');
    else {
      const next: Record<string, ModelPrice> = {};
      for (const [key, raw] of Object.entries(pricing)) {
        const inputPer1M = isRecord(raw) ? boundedNumber(raw['inputPer1M'], 0, 10_000) : null;
        const outputPer1M = isRecord(raw) ? boundedNumber(raw['outputPer1M'], 0, 10_000) : null;
        const tier = isRecord(raw) && String(raw['tier']) in TIER_RANK ? raw['tier'] as ModelTier : null;
        if (!PRICE_KEY.test(key) || inputPer1M === null || outputPer1M === null || tier === null) { errors.push(`pricing entry ${key.slice(0, 40)} is invalid`); continue; }
        next[key] = { inputPer1M, outputPer1M, tier };
      }
      config.pricing = next;
    }
  }

  const cloudModels = input['cloudModels'];
  if (cloudModels !== undefined) {
    if (!isRecord(cloudModels)) errors.push('cloudModels must be an object');
    else {
      const next: LlmRoutingConfig['cloudModels'] = {};
      for (const [provider, list] of Object.entries(cloudModels)) {
        if (!(LLM_PROVIDER_IDS as readonly string[]).includes(provider) || !Array.isArray(list) || list.length > 20 || !list.every((m) => typeof m === 'string' && MODEL_ID.test(m))) {
          errors.push(`cloudModels.${provider.slice(0, 32)} is invalid`);
          continue;
        }
        next[provider as LlmProviderId] = [...new Set(list as string[])];
      }
      config.cloudModels = next;
    }
  }

  const breaker = input['breaker'];
  if (breaker !== undefined) {
    if (!isRecord(breaker)) errors.push('breaker must be an object');
    else {
      const threshold = breaker['failureThreshold'] === undefined ? config.breaker.failureThreshold : boundedNumber(breaker['failureThreshold'], 1, 50);
      const seconds = breaker['openSeconds'] === undefined ? config.breaker.openSeconds : boundedNumber(breaker['openSeconds'], 1, 3600);
      if (threshold === null || !Number.isInteger(threshold)) errors.push('breaker.failureThreshold must be an integer from 1 to 50');
      else config.breaker.failureThreshold = threshold;
      if (seconds === null) errors.push('breaker.openSeconds must be from 1 to 3600');
      else config.breaker.openSeconds = seconds;
    }
  }

  const timeouts = input['timeouts'];
  if (timeouts !== undefined) {
    if (!isRecord(timeouts)) errors.push('timeouts must be an object');
    else {
      for (const key of ['localSeconds', 'cloudSeconds'] as const) {
        if (timeouts[key] === undefined) continue;
        const value = boundedNumber(timeouts[key], 1, 600);
        if (value === null) errors.push(`timeouts.${key} must be from 1 to 600`);
        else config.timeouts[key] = value;
      }
    }
  }
  return { ok: errors.length === 0, config, errors };
}

/**
 * True when `next` could let more money be spent than `prev`: enabling global authorization,
 * authorizing more tasks, raising either cap, adding paid models, or adding/lowering prices.
 * These need a fresh authenticator code.
 */
export function isEscalation(prev: LlmRoutingConfig, next: LlmRoutingConfig): boolean {
  if (!prev.cloud.globalAuthorized && next.cloud.globalAuthorized) return true;
  if (next.cloud.authorizedTasks.some((task) => !prev.cloud.authorizedTasks.includes(task))) return true;
  if (next.cloud.monthlyBudgetUsd > prev.cloud.monthlyBudgetUsd || next.cloud.perRequestMaxUsd > prev.cloud.perRequestMaxUsd) return true;
  for (const [provider, models] of Object.entries(next.cloudModels)) {
    const before = prev.cloudModels[provider as LlmProviderId] ?? [];
    if ((models ?? []).some((model) => !before.includes(model))) return true;
  }
  for (const [key, price] of Object.entries(next.pricing)) {
    const before = prev.pricing[key];
    if (!before || price.inputPer1M < before.inputPer1M || price.outputPer1M < before.outputPer1M) return true;
  }
  return false;
}

export class LlmConfigStore {
  private config: LlmRoutingConfig = defaultConfig();
  private readonly file: string | null;

  /** @param dir storage directory; null keeps the config in memory (tests). */
  constructor(dir: string | null = resolve(process.env['JARVIS_LLM_DIR'] || './data/llm')) {
    this.file = dir ? join(dir, 'routing.json') : null;
    if (this.file && existsSync(this.file)) {
      try {
        const parsed = validateConfig(JSON.parse(readFileSync(this.file, 'utf8')));
        this.config = parsed.config; // invalid fields fall back to safe defaults
      } catch { /* keep defaults */ }
    }
  }

  get(): LlmRoutingConfig {
    return this.config;
  }

  set(config: LlmRoutingConfig): void {
    this.config = config;
    if (!this.file) return;
    mkdirSync(join(this.file, '..'), { recursive: true });
    const temp = this.file + '.tmp';
    writeFileSync(temp, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
    renameSync(temp, this.file);
  }
}
