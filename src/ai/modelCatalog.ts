/**
 * Local model catalog: understands Ollama model families and reads size, context length and
 * capabilities (chat, code, embeddings, vision) from `ollama list` / /api/tags and /api/show.
 * Pure parsers are exported for fixtures; ModelCatalog adds a TTL-cached refresh.
 */
import type { LlmCapability } from './llmTypes.js';

export type ModelFamily = 'llama' | 'mistral' | 'deepseek' | 'gemma' | 'qwen' | 'phi' | 'other';

export interface CatalogModel {
  /** Full name as listed, e.g. "qwen2.5-coder:7b". */
  name: string;
  family: ModelFamily;
  parameterSize?: string;
  /** Parameter count in billions when known. */
  sizeBillions?: number;
  quantization?: string;
  /** On-disk size in bytes. */
  diskBytes?: number;
  contextLength?: number;
  capabilities: LlmCapability[];
}

const FAMILY_PATTERNS: Array<[ModelFamily, RegExp]> = [
  ['deepseek', /deepseek/i],
  ['qwen', /qwen|qwq/i],
  ['mistral', /mistral|mixtral|codestral|ministral/i],
  ['gemma', /gemma/i],
  ['phi', /(^|[/:-])phi\d?/i],
  ['llama', /llama|llava/i],
];

export function familyOf(name: string, hint?: string): ModelFamily {
  const text = `${name} ${hint ?? ''}`;
  for (const [family, pattern] of FAMILY_PATTERNS) if (pattern.test(text)) return family;
  return 'other';
}

const EMBED_NAME = /embed|bge-|minilm|nomic|mxbai|gte-|e5-/i;
const CODE_NAME = /code|coder|starcoder|codestral|codegemma|devstral/i;
const VISION_NAME = /llava|vision|minicpm-v|moondream|bakllava|qwen[\d.]*-?vl|-vl\b/i;

function parseSizeBillions(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /^\s*([\d.]+)\s*([KMBT])/i.exec(text);
  if (!match) return undefined;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return undefined;
  const unit = match[2]!.toUpperCase();
  return unit === 'B' ? value : unit === 'M' ? value / 1000 : unit === 'T' ? value * 1000 : value / 1e6;
}

/** Capabilities from /api/show `capabilities` (newer Ollama) with name-based hints as fallback. */
export function capabilitiesFor(name: string, reported?: string[]): LlmCapability[] {
  const caps = new Set<LlmCapability>();
  const reportedLower = (reported ?? []).map((item) => item.toLowerCase());
  const embedding = reportedLower.includes('embedding') || (reportedLower.length === 0 && EMBED_NAME.test(name));
  if (embedding) caps.add('embeddings');
  if (!embedding || reportedLower.includes('completion')) caps.add('chat');
  if (reportedLower.includes('vision') || (reportedLower.length === 0 && VISION_NAME.test(name))) caps.add('vision');
  if (!embedding && CODE_NAME.test(name)) caps.add('code');
  return [...caps];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Parse the JSON behind `ollama list` (GET /api/tags). */
export function parseOllamaTags(payload: unknown): CatalogModel[] {
  const models = record(payload)['models'];
  if (!Array.isArray(models)) return [];
  const out: CatalogModel[] = [];
  for (const item of models.slice(0, 200)) {
    const entry = record(item);
    const name = entry['name'] ?? entry['model'];
    if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(name)) continue;
    const details = record(entry['details']);
    const parameterSize = typeof details['parameter_size'] === 'string' ? details['parameter_size'] : undefined;
    const quantization = typeof details['quantization_level'] === 'string' ? details['quantization_level'] : undefined;
    const family = typeof details['family'] === 'string' ? details['family'] : undefined;
    const sizeBillions = parseSizeBillions(parameterSize) ?? parseSizeBillions(/[:-](\d+(?:\.\d+)?[bm])\b/i.exec(name)?.[1]);
    out.push({
      name,
      family: familyOf(name, family),
      ...(parameterSize ? { parameterSize } : {}),
      ...(sizeBillions !== undefined ? { sizeBillions } : {}),
      ...(quantization ? { quantization } : {}),
      ...(typeof entry['size'] === 'number' ? { diskBytes: entry['size'] } : {}),
      capabilities: capabilitiesFor(name),
    });
  }
  return out;
}

/** Parse the text table printed by `ollama list` (NAME ID SIZE MODIFIED). */
export function parseOllamaListText(text: string): CatalogModel[] {
  const out: CatalogModel[] = [];
  const rows = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const row of rows) {
    if (/^NAME\s+ID\s+SIZE/i.test(row)) continue;
    const match = /^(\S+)\s+(\S+)\s+([\d.]+)\s*(KB|MB|GB|TB)\b/i.exec(row);
    if (!match || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(match[1]!)) continue;
    const factor = { KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 }[match[4]!.toUpperCase() as 'KB' | 'MB' | 'GB' | 'TB'];
    const name = match[1]!;
    const sizeBillions = parseSizeBillions(/[:-](\d+(?:\.\d+)?[bm])\b/i.exec(name)?.[1]);
    out.push({
      name, family: familyOf(name), ...(sizeBillions !== undefined ? { sizeBillions } : {}),
      diskBytes: Math.round(Number(match[3]) * factor), capabilities: capabilitiesFor(name),
    });
  }
  return out;
}

/** Merge /api/show data into a catalog entry: context length, parameter size, capabilities. */
export function applyOllamaShow(model: CatalogModel, payload: unknown): CatalogModel {
  const show = record(payload);
  const details = record(show['details']);
  const info = record(show['model_info']);
  const parameterSize = typeof details['parameter_size'] === 'string' ? details['parameter_size'] : model.parameterSize;
  const quantization = typeof details['quantization_level'] === 'string' ? details['quantization_level'] : model.quantization;
  const sizeBillions = parseSizeBillions(parameterSize) ?? model.sizeBillions;
  let contextLength: number | undefined;
  for (const [key, value] of Object.entries(info)) {
    if (/\.context_length$/.test(key) && typeof value === 'number' && value > 0) { contextLength = value; break; }
  }
  const reported = Array.isArray(show['capabilities']) ? show['capabilities'].filter((item): item is string => typeof item === 'string') : undefined;
  const family = typeof details['family'] === 'string' ? details['family'] : undefined;
  return {
    name: model.name,
    family: familyOf(model.name, family),
    ...(parameterSize ? { parameterSize } : {}),
    ...(sizeBillions !== undefined ? { sizeBillions } : {}),
    ...(quantization ? { quantization } : {}),
    ...(model.diskBytes !== undefined ? { diskBytes: model.diskBytes } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    capabilities: capabilitiesFor(model.name, reported),
  };
}

export interface CatalogSource {
  tags(signal: AbortSignal): Promise<unknown>;
  show(model: string, signal: AbortSignal): Promise<unknown>;
}

const SHOW_LIMIT = 60;
const SHOW_CONCURRENCY = 4;

export class ModelCatalog {
  private cached: { at: number; models: CatalogModel[] } | null = null;
  private inflight: Promise<CatalogModel[]> | null = null;

  constructor(private readonly source: () => CatalogSource | null, private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  /** Cached catalog; refreshed when older than the TTL. Never throws: an unreachable server gives []. */
  async models(force = false): Promise<CatalogModel[]> {
    if (!force && this.cached && this.now() - this.cached.at < this.ttlMs) return this.cached.models;
    this.inflight ??= this.load().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async load(): Promise<CatalogModel[]> {
    const source = this.source();
    if (!source) return this.cached?.models ?? [];
    try {
      const listed = parseOllamaTags(await source.tags(AbortSignal.timeout(5000)));
      const enriched: CatalogModel[] = [...listed];
      for (let start = 0; start < Math.min(listed.length, SHOW_LIMIT); start += SHOW_CONCURRENCY) {
        await Promise.all(listed.slice(start, start + SHOW_CONCURRENCY).map(async (model, offset) => {
          try {
            enriched[start + offset] = applyOllamaShow(model, await source.show(model.name, AbortSignal.timeout(5000)));
          } catch { /* keep the /api/tags view */ }
        }));
      }
      this.cached = { at: this.now(), models: enriched };
      return enriched;
    } catch {
      // Keep the last known catalog but retry soon.
      this.cached = { at: this.now() - this.ttlMs + 5000, models: this.cached?.models ?? [] };
      return this.cached.models;
    }
  }
}
