/**
 * Token estimation and pricing for cost control.
 *
 * PRICING DEFAULTS BELOW ARE ILLUSTRATIVE STARTING POINTS. VERIFY CURRENT PRICING with each
 * provider before relying on them; the owner can edit the table in the routing config. Unknown
 * models are priced with a deliberately high default so the budget guard errs on the safe side.
 * Local inference is always free.
 */
import type { LlmMessage, LlmProviderId } from './llmTypes.js';

export type ModelTier = 'small' | 'medium' | 'large';
export const TIER_RANK: Record<ModelTier, number> = { small: 0, medium: 1, large: 2 };

export interface ModelPrice {
  /** USD per 1,000,000 input tokens. */
  inputPer1M: number;
  /** USD per 1,000,000 output tokens. */
  outputPer1M: number;
  tier: ModelTier;
}

export const PRICING_NOTE = 'Default prices are examples only. Verify current pricing with each provider and edit this table.';

/** Keys are model ids (provider-agnostic, so an Azure deployment named like the model matches) or "provider/model". */
export const DEFAULT_PRICING: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6, tier: 'small' },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6, tier: 'small' },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10, tier: 'medium' },
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8, tier: 'medium' },
  'text-embedding-3-small': { inputPer1M: 0.02, outputPer1M: 0, tier: 'small' },
  'claude-haiku': { inputPer1M: 1, outputPer1M: 5, tier: 'small' },
  'claude-sonnet': { inputPer1M: 3, outputPer1M: 15, tier: 'medium' },
  'claude-opus': { inputPer1M: 5, outputPer1M: 25, tier: 'large' },
  'gemini-2.5-flash-lite': { inputPer1M: 0.1, outputPer1M: 0.4, tier: 'small' },
  'gemini-2.5-flash': { inputPer1M: 0.3, outputPer1M: 2.5, tier: 'small' },
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10, tier: 'large' },
  'text-embedding-004': { inputPer1M: 0, outputPer1M: 0, tier: 'small' },
};

/** Used when a paid model has no entry: expensive on purpose. */
export const UNKNOWN_PAID_PRICE: ModelPrice = { inputPer1M: 10, outputPer1M: 30, tier: 'medium' };
export const FREE_PRICE: ModelPrice = { inputPer1M: 0, outputPer1M: 0, tier: 'small' };

const CJK = /[⺀-鿿가-힯＀-￯]/g;

/** Cheap, dependency-free estimate: ~4 chars per token for Latin text, 1 token per CJK character. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(CJK) ?? []).length;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function estimateMessageTokens(messages: LlmMessage[]): number {
  let total = 3;
  for (const message of messages) {
    total += 4 + estimateTokens(message.content);
    total += (message.images?.length ?? 0) * 800;
  }
  return total;
}

/** Longest-prefix match so "claude-sonnet-4-5-20250929" finds "claude-sonnet". */
export function lookupPrice(table: Record<string, ModelPrice>, provider: LlmProviderId, model: string, paid: boolean): ModelPrice {
  if (!paid) return FREE_PRICE;
  const exact = table[`${provider}/${model}`] ?? table[model];
  if (exact) return exact;
  const lower = model.toLowerCase();
  let best: { length: number; price: ModelPrice } | null = null;
  for (const [key, price] of Object.entries(table)) {
    const bare = (key.includes('/') ? key.slice(key.indexOf('/') + 1) : key).toLowerCase();
    if (key.includes('/') && !key.startsWith(provider + '/')) continue;
    if (lower.startsWith(bare) && (!best || bare.length > best.length)) best = { length: bare.length, price };
  }
  return best?.price ?? UNKNOWN_PAID_PRICE;
}

export function costUsd(price: ModelPrice, inputTokens: number, outputTokens: number): number {
  return (inputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000;
}

/** Round to a stable number of decimals for ledgers (avoids float drift). */
export function roundUsd(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}
