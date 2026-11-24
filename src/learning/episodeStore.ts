/**
 * Learning episodes from the JARVIS Learn VS Code extension (E3:D4.17).
 *
 * An episode is one owner prompt (or commit / terminal / diagnostics event) with the steps that followed.
 * Episodes arrive PENDING, encrypted at rest (EncryptedJsonFile); only owner-approved episodes become
 * searchable "how I did this" knowledge and recipes. Content written by an AI assistant is flagged
 * assistantGenerated and is excluded from training exports unless the owner explicitly allows it.
 */
import { createHash, randomUUID } from 'node:crypto';
import { EncryptedJsonFile } from '../memory/encryptedJsonFile.js';
import { redactDeep, redactText, isExcludedPath } from './redaction.js';

export type EpisodeStatus = 'pending' | 'approved' | 'rejected';
export type StepKind = 'edit' | 'write' | 'command' | 'diagnostics' | 'commit' | 'save';
export type CommandClass = 'build' | 'test' | 'lint' | 'git' | 'other';

export interface EpisodeStep {
  kind: StepKind;
  /** True when an AI assistant produced this step (its edits, its commands). */
  assistantGenerated: boolean;
  path?: string;
  command?: string;
  commandClass?: CommandClass;
  exitCode?: number;
  summary?: string;
  outputTail?: string;
  diffStat?: { files?: number; insertions?: number; deletions?: number };
  diff?: string;
  diagnostics?: { before?: number; after?: number; messages?: string[] };
}

export interface Episode {
  schemaVersion: 1;
  id?: string;
  source: string;
  startedAt: string;
  endedAt?: string;
  workspace?: string;
  /** The owner's prompt. */
  prompt?: string;
  /** The assistant's closing summary (assistant-written). */
  assistantSummary?: string;
  /** True when any content in this episode was written by an AI assistant. */
  assistantGenerated: boolean;
  steps: EpisodeStep[];
  outcome?: { status: 'success' | 'failure' | 'unknown'; summary?: string };
  linkedEpisodeIds?: string[];
}

export interface StoredEpisode {
  id: string;
  receivedAt: string;
  status: EpisodeStatus;
  keyId: string;
  decidedAt?: string;
  documentId?: string;
  episode: Episode;
}

export interface EpisodeSettings {
  /** Default false: exports exclude assistant-generated content. */
  allowAssistantContentInExport: boolean;
}

interface Payload { version: 1; settings: EpisodeSettings; episodes: StoredEpisode[] }

export const MAX_EPISODES = 2000;
export const MAX_EPISODE_BYTES = 256 * 1024;
const MAX_STEPS = 200;
const STEP_KINDS: StepKind[] = ['edit', 'write', 'command', 'diagnostics', 'commit', 'save'];
const COMMAND_CLASSES: CommandClass[] = ['build', 'test', 'lint', 'git', 'other'];
const LIMITS = { prompt: 8000, summary: 4000, command: 2000, output: 4000, diff: 20000, path: 500, message: 500 };

export class EpisodeValidationError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const clip = (value: string, max: number) => (value.length > max ? value.slice(0, max) + '…[truncated]' : value);

function optString(source: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = source[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new EpisodeValidationError(`${key} must be a string`);
  return clip(v, max);
}
function optInt(source: Record<string, unknown>, key: string): number | undefined {
  const v = source[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v) || Math.abs(v) > 1e9) throw new EpisodeValidationError(`${key} must be an integer`);
  return v;
}
function isoDate(value: unknown, key: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || value.length > 40) throw new EpisodeValidationError(`${key} must be an ISO date string`);
  return value;
}

function validateStep(raw: unknown): EpisodeStep | null {
  if (!isObject(raw)) throw new EpisodeValidationError('each step must be an object');
  if (typeof raw['kind'] !== 'string' || !STEP_KINDS.includes(raw['kind'] as StepKind)) throw new EpisodeValidationError('invalid step kind');
  if (typeof raw['assistantGenerated'] !== 'boolean') throw new EpisodeValidationError('step.assistantGenerated must be boolean');
  const path = optString(raw, 'path', LIMITS.path);
  // Paths that name secret-bearing files are dropped entirely, never stored.
  if (path !== undefined && isExcludedPath(path)) return null;
  const step: EpisodeStep = { kind: raw['kind'] as StepKind, assistantGenerated: raw['assistantGenerated'] };
  if (path !== undefined) step.path = path;
  const command = optString(raw, 'command', LIMITS.command);
  if (command !== undefined) step.command = command;
  if (raw['commandClass'] !== undefined) {
    if (typeof raw['commandClass'] !== 'string' || !COMMAND_CLASSES.includes(raw['commandClass'] as CommandClass)) throw new EpisodeValidationError('invalid commandClass');
    step.commandClass = raw['commandClass'] as CommandClass;
  }
  const exitCode = optInt(raw, 'exitCode');
  if (exitCode !== undefined) step.exitCode = exitCode;
  for (const [key, max] of [['summary', LIMITS.summary], ['outputTail', LIMITS.output], ['diff', LIMITS.diff]] as const) {
    const v = optString(raw, key, max);
    if (v !== undefined) step[key] = v;
  }
  if (raw['diffStat'] !== undefined) {
    if (!isObject(raw['diffStat'])) throw new EpisodeValidationError('diffStat must be an object');
    const stat: NonNullable<EpisodeStep['diffStat']> = {};
    for (const key of ['files', 'insertions', 'deletions'] as const) { const v = optInt(raw['diffStat'], key); if (v !== undefined) stat[key] = v; }
    step.diffStat = stat;
  }
  if (raw['diagnostics'] !== undefined) {
    const d = raw['diagnostics'];
    if (!isObject(d)) throw new EpisodeValidationError('diagnostics must be an object');
    const out: NonNullable<EpisodeStep['diagnostics']> = {};
    const before = optInt(d, 'before'); if (before !== undefined) out.before = before;
    const after = optInt(d, 'after'); if (after !== undefined) out.after = after;
    if (d['messages'] !== undefined) {
      if (!Array.isArray(d['messages']) || d['messages'].length > 20 || !d['messages'].every((m) => typeof m === 'string')) throw new EpisodeValidationError('diagnostics.messages must be up to 20 strings');
      out.messages = (d['messages'] as string[]).map((m) => clip(m, LIMITS.message));
    }
    step.diagnostics = out;
  }
  return step;
}

/** Validate the wire schema and return a sanitized copy (bounded, excluded paths dropped). Not yet redacted. */
export function validateEpisode(raw: unknown): Episode {
  if (!isObject(raw)) throw new EpisodeValidationError('episode must be a JSON object');
  if (raw['schemaVersion'] !== 1) throw new EpisodeValidationError('schemaVersion must be 1');
  if (typeof raw['source'] !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(raw['source'])) throw new EpisodeValidationError('source must be a short lowercase identifier');
  if (typeof raw['assistantGenerated'] !== 'boolean') throw new EpisodeValidationError('assistantGenerated must be boolean');
  if (!Array.isArray(raw['steps']) || raw['steps'].length > MAX_STEPS) throw new EpisodeValidationError(`steps must be an array of at most ${MAX_STEPS}`);
  const episode: Episode = {
    schemaVersion: 1,
    source: raw['source'],
    startedAt: isoDate(raw['startedAt'], 'startedAt'),
    assistantGenerated: raw['assistantGenerated'],
    steps: [],
  };
  if (raw['id'] !== undefined) {
    if (typeof raw['id'] !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(raw['id'])) throw new EpisodeValidationError('id must be 8-64 URL-safe characters');
    episode.id = raw['id'];
  }
  if (raw['endedAt'] !== undefined) episode.endedAt = isoDate(raw['endedAt'], 'endedAt');
  const workspace = optString(raw, 'workspace', 120); if (workspace !== undefined) episode.workspace = workspace;
  const prompt = optString(raw, 'prompt', LIMITS.prompt); if (prompt !== undefined) episode.prompt = prompt;
  const summary = optString(raw, 'assistantSummary', LIMITS.summary); if (summary !== undefined) episode.assistantSummary = summary;
  for (const step of raw['steps']) { const valid = validateStep(step); if (valid) episode.steps.push(valid); }
  if (raw['outcome'] !== undefined) {
    const o = raw['outcome'];
    if (!isObject(o) || !['success', 'failure', 'unknown'].includes(String(o['status']))) throw new EpisodeValidationError('invalid outcome');
    const outcome: NonNullable<Episode['outcome']> = { status: o['status'] as 'success' | 'failure' | 'unknown' };
    const s = optString(o, 'summary', LIMITS.summary); if (s !== undefined) outcome.summary = s;
    episode.outcome = outcome;
  }
  if (raw['linkedEpisodeIds'] !== undefined) {
    const ids = raw['linkedEpisodeIds'];
    if (!Array.isArray(ids) || ids.length > 20 || !ids.every((i) => typeof i === 'string' && i.length <= 64)) throw new EpisodeValidationError('linkedEpisodeIds must be up to 20 ids');
    episode.linkedEpisodeIds = ids as string[];
  }
  if (Buffer.byteLength(JSON.stringify(episode), 'utf8') > MAX_EPISODE_BYTES) throw new EpisodeValidationError('episode exceeds the size limit');
  return episode;
}

export function recipeOf(stored: StoredEpisode) {
  const { episode } = stored;
  return {
    id: stored.id,
    title: clip((episode.prompt ?? episode.steps.find((s) => s.summary)?.summary ?? `${episode.source} episode`).split('\n')[0] ?? '', 120),
    prompt: episode.prompt ?? null,
    steps: episode.steps.map((s) => ({
      kind: s.kind,
      text: s.command ? s.command : s.path ? `${s.kind} ${s.path}` : (s.summary ?? s.kind),
      ...(s.summary && (s.command || s.path) ? { note: s.summary } : {}),
    })),
    commands: episode.steps.filter((s) => s.command).map((s) => ({ command: s.command!, class: s.commandClass ?? 'other', exitCode: s.exitCode ?? null })),
    outcome: episode.outcome ?? { status: 'unknown' as const },
    startedAt: episode.startedAt,
  };
}

/** Plain-text rendering used for the document/RAG index and keyword search. */
export function episodeToText(stored: StoredEpisode): string {
  const { episode } = stored;
  const lines = [`How I did this (${episode.source}, ${episode.startedAt.slice(0, 10)})`];
  if (episode.workspace) lines.push(`Project: ${episode.workspace}`);
  if (episode.prompt) lines.push(`Prompt: ${episode.prompt}`);
  for (const s of episode.steps) {
    if (s.command) lines.push(`Command [${s.commandClass ?? 'other'}]: ${s.command}${s.exitCode !== undefined ? ` (exit ${s.exitCode})` : ''}`);
    else if (s.path) lines.push(`${s.kind}: ${s.path}${s.summary ? ' - ' + s.summary : ''}`);
    else if (s.summary) lines.push(`${s.kind}: ${s.summary}`);
    if (s.diagnostics) lines.push(`Diagnostics ${s.diagnostics.before ?? '?'} -> ${s.diagnostics.after ?? '?'}: ${(s.diagnostics.messages ?? []).join('; ')}`);
  }
  if (episode.outcome) lines.push(`Outcome: ${episode.outcome.status}${episode.outcome.summary ? ' - ' + episode.outcome.summary : ''}`);
  return lines.join('\n');
}

/**
 * Training-set export. Assistant-generated content is excluded unless the owner has explicitly allowed it:
 * AI providers' terms restrict training models on their outputs. Owner prompts, the owner's own commands,
 * saves, commits and exit codes remain.
 */
export function exportEpisodes(episodes: StoredEpisode[], allowAssistantContent: boolean) {
  return episodes.filter((s) => s.status === 'approved').map((s) => {
    const e = s.episode;
    if (allowAssistantContent) return { id: s.id, ...e };
    const steps = e.steps.filter((st) => !st.assistantGenerated);
    const out: Record<string, unknown> = {
      id: s.id, schemaVersion: 1, source: e.source, startedAt: e.startedAt, assistantGenerated: false,
      ...(e.workspace ? { workspace: e.workspace } : {}),
      ...(e.prompt ? { prompt: e.prompt } : {}),
      steps,
      ...(e.outcome ? { outcome: { status: e.outcome.status } } : {}),
      assistantContentExcluded: e.assistantGenerated,
    };
    return out;
  });
}

export class EpisodeStore {
  private readonly file: EncryptedJsonFile<Payload>;
  private payload: Payload = { version: 1, settings: { allowAssistantContentInExport: false }, episodes: [] };

  constructor(filePath: string, ownerControlToken: string) {
    this.file = new EncryptedJsonFile<Payload>(filePath, ownerControlToken, 'JARVIS-LEARNING-EPISODES-V1');
    const loaded = this.file.read();
    if (loaded !== undefined) {
      if (!loaded || loaded.version !== 1 || !Array.isArray(loaded.episodes) || loaded.episodes.length > MAX_EPISODES) {
        throw new Error('Episode store failed validation; refusing to overwrite it.');
      }
      this.payload = { version: 1, settings: { allowAssistantContentInExport: loaded.settings?.allowAssistantContentInExport === true }, episodes: loaded.episodes };
    }
  }

  /** Validate, re-redact (defence in depth), and store as pending. Returns the stored record and whether it was new. */
  ingest(raw: unknown, keyId: string): { stored: StoredEpisode; duplicate: boolean } {
    const valid = validateEpisode(raw);
    const episode = redactDeep(valid);
    const id = episode.id ?? createHash('sha256').update(JSON.stringify(episode)).digest('hex').slice(0, 32);
    const existing = this.payload.episodes.find((e) => e.id === id);
    if (existing) return { stored: existing, duplicate: true };
    if (this.payload.episodes.length >= MAX_EPISODES) throw new EpisodeValidationError('Episode store is full; approve, reject or delete episodes first.');
    const stored: StoredEpisode = { id, receivedAt: new Date().toISOString(), status: 'pending', keyId, episode: { ...episode, id } };
    this.payload.episodes.push(stored);
    this.persist();
    return { stored, duplicate: false };
  }

  list(status?: EpisodeStatus): StoredEpisode[] {
    return this.payload.episodes.filter((e) => status === undefined || e.status === status).map((e) => structuredClone(e));
  }

  get(id: string): StoredEpisode | undefined {
    const found = this.payload.episodes.find((e) => e.id === id);
    return found ? structuredClone(found) : undefined;
  }

  approve(id: string, documentId?: string): StoredEpisode {
    const found = this.mustFindPending(id);
    found.status = 'approved';
    found.decidedAt = new Date().toISOString();
    if (documentId) found.documentId = documentId;
    this.persist();
    return structuredClone(found);
  }

  /** Reject drops the episode body; only its id and decision remain. */
  reject(id: string): StoredEpisode {
    const found = this.mustFindPending(id);
    found.status = 'rejected';
    found.decidedAt = new Date().toISOString();
    found.episode = { schemaVersion: 1, source: found.episode.source, startedAt: found.episode.startedAt, assistantGenerated: found.episode.assistantGenerated, steps: [] };
    this.persist();
    return structuredClone(found);
  }

  /** Removes every episode (and returns indexed document ids so the caller can drop them). */
  deleteAll(): { removed: number; documentIds: string[] } {
    const documentIds = this.payload.episodes.flatMap((e) => (e.documentId ? [e.documentId] : []));
    const removed = this.payload.episodes.length;
    this.payload.episodes = [];
    this.persist();
    return { removed, documentIds };
  }

  recipes() { return this.payload.episodes.filter((e) => e.status === 'approved').map(recipeOf); }

  /** Keyword search over approved episodes ("how did we fix X", "what command builds Y"). */
  search(query: string, limit = 5): Array<{ id: string; score: number; text: string }> {
    const terms = [...new Set(redactText(query).toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 2))];
    if (!terms.length) return [];
    return this.payload.episodes.filter((e) => e.status === 'approved').map((e) => {
      const text = episodeToText(e);
      const lower = text.toLowerCase();
      const score = terms.filter((t) => lower.includes(t)).length / terms.length;
      return { id: e.id, score, text };
    }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, Math.min(Math.max(limit, 1), 20));
  }

  get settings(): EpisodeSettings { return { ...this.payload.settings }; }
  setAllowAssistantContentInExport(allow: boolean): void { this.payload.settings.allowAssistantContentInExport = allow; this.persist(); }

  export() { return exportEpisodes(this.payload.episodes, this.payload.settings.allowAssistantContentInExport); }

  private mustFindPending(id: string): StoredEpisode {
    const found = this.payload.episodes.find((e) => e.id === id);
    if (!found) throw new EpisodeValidationError('No episode with that id.');
    if (found.status !== 'pending') throw new EpisodeValidationError(`Episode is already ${found.status}.`);
    return found;
  }

  private persist(): void { this.file.write(this.payload); }
}

export const newEpisodeId = () => randomUUID().replace(/-/g, '');
