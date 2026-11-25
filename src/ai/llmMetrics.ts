/**
 * Performance and spend monitoring. Stores a rolling window of numeric samples only: provider,
 * model name, task type, timings, token counts, cost and an error kind. Prompts, responses and
 * credentials are never recorded (record() copies a fixed whitelist of fields).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { roundUsd } from './llmPricing.js';
import type { LlmProviderId, LlmTaskType } from './llmTypes.js';

export interface MetricSample {
  /** Epoch ms. */
  t: number;
  provider: LlmProviderId;
  model: string;
  task: LlmTaskType;
  ok: boolean;
  errorKind?: string;
  /** Time to first token (streaming only), ms. */
  ttftMs?: number;
  totalMs: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerSec?: number;
  /** True when this attempt happened after an earlier provider failed. */
  fallback: boolean;
  costUsd: number;
}

export interface MetricSummary {
  provider: LlmProviderId;
  model: string;
  calls: number;
  errors: number;
  errorRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgTtftMs: number | null;
  avgTokensPerSec: number | null;
  fallbacks: number;
  costUsd: number;
  /** Most recent total latencies (oldest first) for a sparkline. */
  latencySeries: number[];
}

const MAX_SAMPLES = 2000;
const MAX_AGE_MS = 14 * 24 * 3600 * 1000;
const SERIES_LENGTH = 30;

function round(value: number, digits = 1): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function monthKey(time: number): string {
  const date = new Date(time);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

export interface SpendLedger {
  month: string;
  totalUsd: number;
  byProvider: Partial<Record<LlmProviderId, number>>;
}

interface PersistedState {
  samples: MetricSample[];
  spend: SpendLedger;
}

export class LlmMetrics {
  private samples: MetricSample[] = [];
  private spend: SpendLedger;
  private readonly file: string | null;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(dir: string | null = resolve(process.env['JARVIS_LLM_DIR'] || './data/llm'), private readonly now: () => number = Date.now) {
    this.file = dir ? join(dir, 'usage.json') : null;
    this.spend = { month: monthKey(now()), totalUsd: 0, byProvider: {} };
    if (this.file && existsSync(this.file)) {
      try {
        const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<PersistedState>;
        if (Array.isArray(parsed.samples)) this.samples = parsed.samples.filter(LlmMetrics.isSample).slice(-MAX_SAMPLES);
        const spend = parsed.spend;
        if (spend && typeof spend.month === 'string' && typeof spend.totalUsd === 'number' && spend.totalUsd >= 0) {
          this.spend = { month: spend.month, totalUsd: spend.totalUsd, byProvider: typeof spend.byProvider === 'object' && spend.byProvider ? spend.byProvider : {} };
        }
      } catch { /* start clean */ }
    }
    this.rollMonth();
  }

  private static isSample(value: unknown): value is MetricSample {
    const v = value as MetricSample;
    return Boolean(v) && typeof v.t === 'number' && typeof v.provider === 'string' && typeof v.model === 'string' && typeof v.totalMs === 'number' && typeof v.ok === 'boolean';
  }

  private rollMonth(): void {
    const key = monthKey(this.now());
    if (this.spend.month !== key) this.spend = { month: key, totalUsd: 0, byProvider: {} };
  }

  /** Record one attempt. Only whitelisted numeric/enum fields are copied. */
  record(sample: MetricSample): void {
    this.rollMonth();
    const clean: MetricSample = {
      t: sample.t,
      provider: sample.provider,
      model: String(sample.model).slice(0, 128),
      task: sample.task,
      ok: Boolean(sample.ok),
      ...(sample.errorKind ? { errorKind: String(sample.errorKind).slice(0, 32) } : {}),
      ...(sample.ttftMs !== undefined ? { ttftMs: round(sample.ttftMs) } : {}),
      totalMs: round(sample.totalMs),
      inputTokens: Math.max(0, Math.round(sample.inputTokens)),
      outputTokens: Math.max(0, Math.round(sample.outputTokens)),
      ...(sample.tokensPerSec !== undefined ? { tokensPerSec: round(sample.tokensPerSec) } : {}),
      fallback: Boolean(sample.fallback),
      costUsd: roundUsd(Math.max(0, sample.costUsd)),
    };
    this.samples.push(clean);
    const cutoff = this.now() - MAX_AGE_MS;
    while (this.samples.length > MAX_SAMPLES || (this.samples[0] && this.samples[0].t < cutoff)) this.samples.shift();
    if (clean.costUsd > 0) {
      this.spend.totalUsd = roundUsd(this.spend.totalUsd + clean.costUsd);
      this.spend.byProvider[clean.provider] = roundUsd((this.spend.byProvider[clean.provider] ?? 0) + clean.costUsd);
    }
    this.scheduleFlush();
  }

  spentThisMonth(): number {
    this.rollMonth();
    return this.spend.totalUsd;
  }

  ledger(): SpendLedger {
    this.rollMonth();
    return { month: this.spend.month, totalUsd: this.spend.totalUsd, byProvider: { ...this.spend.byProvider } };
  }

  /** Fallback count per provider that failed and caused a fallback is derivable from samples; this counts fallback attempts. */
  summaries(): MetricSummary[] {
    const groups = new Map<string, MetricSample[]>();
    for (const sample of this.samples) {
      const key = sample.provider + '\u0000' + sample.model;
      const list = groups.get(key);
      if (list) list.push(sample); else groups.set(key, [sample]);
    }
    const out: MetricSummary[] = [];
    for (const list of groups.values()) {
      const first = list[0]!;
      const okSamples = list.filter((s) => s.ok);
      const latencies = okSamples.map((s) => s.totalMs).sort((a, b) => a - b);
      const ttfts = okSamples.map((s) => s.ttftMs).filter((v): v is number => v !== undefined);
      const rates = okSamples.map((s) => s.tokensPerSec).filter((v): v is number => v !== undefined);
      const avg = (values: number[]) => values.reduce((sum, v) => sum + v, 0) / values.length;
      out.push({
        provider: first.provider,
        model: first.model,
        calls: list.length,
        errors: list.length - okSamples.length,
        errorRate: round((list.length - okSamples.length) / list.length, 3),
        avgLatencyMs: latencies.length ? round(avg(latencies)) : 0,
        p95LatencyMs: latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))]! : 0,
        avgTtftMs: ttfts.length ? round(avg(ttfts)) : null,
        avgTokensPerSec: rates.length ? round(avg(rates)) : null,
        fallbacks: list.filter((s) => s.fallback).length,
        costUsd: roundUsd(list.reduce((sum, s) => sum + s.costUsd, 0)),
        latencySeries: okSamples.slice(-SERIES_LENGTH).map((s) => s.totalMs),
      });
    }
    return out.sort((a, b) => b.calls - a.calls);
  }

  /** Per-provider fallback counts: how often each provider was reached only after another failed. */
  fallbackCounts(): Partial<Record<LlmProviderId, number>> {
    const counts: Partial<Record<LlmProviderId, number>> = {};
    for (const sample of this.samples) if (sample.fallback) counts[sample.provider] = (counts[sample.provider] ?? 0) + 1;
    return counts;
  }

  recent(limit = 100): MetricSample[] {
    return this.samples.slice(-limit);
  }

  private scheduleFlush(): void {
    if (!this.file || this.flushTimer) return;
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, 2000);
    this.flushTimer.unref?.();
  }

  flush(): void {
    if (!this.file) return;
    try {
      mkdirSync(join(this.file, '..'), { recursive: true });
      const temp = this.file + '.tmp';
      writeFileSync(temp, JSON.stringify({ samples: this.samples, spend: this.spend } satisfies PersistedState), { encoding: 'utf8', mode: 0o600 });
      renameSync(temp, this.file);
    } catch { /* monitoring must never break inference */ }
  }
}
