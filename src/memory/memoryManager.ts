/**
 * Memory Manager (JARVIS-US-057 / US-058).
 *
 * One entry point over the two memory tiers:
 *   - Working Memory: RAM-only, per device + conversation/task/agent scope, expiring.
 *   - Long-Term Memory: the encrypted PersonalMemoryStore (approved facts/preferences).
 *
 * Consent-based learning: feedback and working-memory items never go straight to
 * long-term memory. They become *candidates* with an attributed source, which the
 * owner approves or rejects. Learning can be disabled entirely. Nothing here trains
 * or fine-tunes a model, and nothing is sent to a cloud provider.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { PersonalMemoryStore, normalizeMemoryText, type MemoryCategory, type PersonalMemory } from './personalMemoryStore.js';
import type { WorkingMemory, WorkingScopeKind } from './workingMemory.js';
import { MemoryVersionHistory, type MemoryVersion } from './memoryVersions.js';
import { LearningQualityEvaluator, type LearningQualityInput, type LearningQualitySummary } from './learningQualityEvaluator.js';
import { OllamaEmbedder, SemanticMemoryIndex, resolveLocalEmbeddingEndpoint, type RetrievalMethod } from './semanticIndex.js';

/** Raised when proposed content duplicates an existing long-term memory. */
export class DuplicateMemoryError extends Error {
  constructor(readonly existingId: string, readonly match: 'exact' | 'near', readonly similarity?: number) {
    super(match === 'exact' ? 'This is already stored in long-term memory.' : 'A very similar memory is already stored.');
  }
}

/** Cosine similarity at or above this counts as a near-duplicate. */
export const NEAR_DUPLICATE_THRESHOLD = 0.95;
/** Ranking weights: semantic similarity, lexical overlap, recency. */
const RANK_WEIGHTS = { semantic: 0.6, lexical: 0.3, recency: 0.1 };
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

export type CandidateSourceKind = 'feedback' | 'conversation' | 'task' | 'working_memory';

export interface LearningCandidate {
  id: string;
  deviceId: string;
  category: MemoryCategory;
  content: string;
  source: { kind: CandidateSourceKind; ref?: string };
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  decidedAt?: number;
  /** Long-term memory id created on approval. */
  memoryId?: string;
}

export interface ContextItem {
  tier: 'working' | 'long_term';
  label: string;
  content: string;
  /** Ranking score for long-term items (0..1). */
  score?: number;
}

export interface MemoryManagerOptions {
  /** Encrypted embedding index (derived data). Defaults next to the candidates file. */
  index?: SemanticMemoryIndex;
  /** Encrypted correction history. Defaults next to the candidates file. */
  versions?: MemoryVersionHistory;
}

interface CandidateFile {
  version: 1;
  learningEnabled: boolean;
  candidates: LearningCandidate[];
}

const MAX_CANDIDATES = 500;
const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'is', 'are', 'what', 'my', 'me', 'i', 'you', 'it', 'do', 'with', 'about']);

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2 && !STOP_WORDS.has(word)));
}

export class MemoryManager {
  private readonly key: Buffer;
  private data: CandidateFile = { version: 1, learningEnabled: true, candidates: [] };
  readonly index: SemanticMemoryIndex;
  readonly versions: MemoryVersionHistory;
  readonly quality: LearningQualityEvaluator;
  private lastRetrieval: { method: RetrievalMethod; at: number } | null = null;

  constructor(
    readonly longTerm: PersonalMemoryStore,
    readonly working: WorkingMemory,
    private readonly candidatesPath: string,
    ownerControlToken: string,
    options: MemoryManagerOptions = {},
  ) {
    if (ownerControlToken.length < 32) throw new Error('Memory manager requires a configured owner control token.');
    this.key = scryptSync(ownerControlToken, 'JARVIS-MEMORY-CANDIDATES-V1', 32);
    this.load();
    const endpoint = resolveLocalEmbeddingEndpoint();
    this.index = options.index ?? new SemanticMemoryIndex(`${candidatesPath}.embeddings`, ownerControlToken, endpoint ? new OllamaEmbedder(endpoint) : null);
    this.versions = options.versions ?? new MemoryVersionHistory(`${candidatesPath}.versions`, ownerControlToken);
    this.quality = new LearningQualityEvaluator(`${candidatesPath}.quality`, ownerControlToken);
    longTerm.attachVersionHistory(this.versions);
    // Drop history for memories that expired or were removed while JARVIS was offline.
    this.versions.reconcile(new Set(longTerm.active().map((record) => record.id)));
  }

  // ---- persistence (AES-256-GCM, same scheme as long-term memory) ----

  private load(): void {
    if (!existsSync(this.candidatesPath)) return;
    const envelope = JSON.parse(readFileSync(this.candidatesPath, 'utf8')) as { salt: string; iv: string; tag: string; ciphertext: string };
    const key = scryptSync(this.key, Buffer.from(envelope.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    const parsed = JSON.parse(plain) as CandidateFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.candidates)) throw new Error('Learning candidates file is invalid.');
    this.data = parsed;
  }

  private persist(): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(this.key, salt, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(this.data), 'utf8'), cipher.final()]);
    mkdirSync(dirname(this.candidatesPath), { recursive: true });
    const temporary = `${this.candidatesPath}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(temporary, JSON.stringify({
      version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    }), { mode: 0o600 });
    renameSync(temporary, this.candidatesPath);
  }

  // ---- retrieval ----

  /**
   * Bounded, relevant context for a model prompt: the current scope's working
   * memory first, then matching long-term memories (only when the caller is
   * permitted to read them). Context is untrusted data, never instructions.
   */
  retrieveContext(options: {
    deviceId: string;
    query: string;
    scope?: { kind: WorkingScopeKind; id: string };
    includeLongTerm: boolean;
    maxItems?: number;
    maxChars?: number;
  }): ContextItem[] {
    const maxItems = Math.max(1, Math.min(options.maxItems ?? 8, 20));
    const maxChars = Math.max(200, Math.min(options.maxChars ?? 4000, 16_000));
    const items: ContextItem[] = [];
    if (options.scope) {
      const recent = this.working.list(options.deviceId, options.scope.kind, options.scope.id).slice(-Math.ceil(maxItems / 2));
      for (const entry of recent) items.push({ tier: 'working', label: entry.label, content: entry.content });
    }
    if (options.includeLongTerm) {
      for (const memory of this.longTerm.relevant(options.query, maxItems)) {
        items.push({ tier: 'long_term', label: memory.category, content: memory.content });
      }
    }
    const bounded: ContextItem[] = [];
    let used = 0;
    for (const item of items.slice(0, maxItems)) {
      const room = maxChars - used;
      if (room <= 0) break;
      const content = item.content.slice(0, room);
      used += content.length;
      bounded.push({ ...item, content });
    }
    return bounded;
  }

  /**
   * Ranked two-tier context (J-E06): working memory for the current scope, then
   * long-term memories ranked by local semantic similarity + lexical overlap +
   * recency. Without a local embedding model it falls back to lexical + recency
   * and reports the method honestly via status().retrieval.
   */
  async retrieveContextRanked(options: {
    deviceId: string;
    query: string;
    scope?: { kind: WorkingScopeKind; id: string };
    includeLongTerm: boolean;
    maxItems?: number;
    maxChars?: number;
    signal?: AbortSignal;
  }): Promise<ContextItem[]> {
    const maxItems = Math.max(1, Math.min(options.maxItems ?? 8, 20));
    const maxChars = Math.max(200, Math.min(options.maxChars ?? 4000, 16_000));
    const items: ContextItem[] = [];
    if (options.scope) {
      const recent = this.working.list(options.deviceId, options.scope.kind, options.scope.id).slice(-Math.ceil(maxItems / 2));
      for (const entry of recent) items.push({ tier: 'working', label: entry.label, content: entry.content });
    }
    if (options.includeLongTerm) {
      for (const ranked of await this.rankLongTerm(options.query, maxItems, options.signal)) {
        items.push({ tier: 'long_term', label: ranked.memory.category, content: ranked.memory.content, score: Number(ranked.score.toFixed(3)) });
      }
    }
    const bounded: ContextItem[] = [];
    let used = 0;
    for (const item of items.slice(0, maxItems)) {
      const room = maxChars - used;
      if (room <= 0) break;
      const content = item.content.slice(0, room);
      used += content.length;
      bounded.push({ ...item, content });
    }
    return bounded;
  }

  /** Rank active long-term memories for a query; only clearly relevant ones are returned. */
  async rankLongTerm(query: string, limit = 5, signal?: AbortSignal): Promise<Array<{ memory: PersonalMemory; score: number }>> {
    const records = this.longTerm.active();
    if (!records.length || !query.trim()) return [];
    const semantic = await this.index.scores(query, records, signal);
    this.lastRetrieval = { method: semantic ? 'semantic' : 'lexical', at: Date.now() };
    const lexical = records.map((record) => PersonalMemoryStore.lexicalScore(query, record.content));
    const maxLexical = Math.max(1, ...lexical);
    const now = Date.now();
    return records
      .map((memory, i) => {
        const lex = lexical[i]! / maxLexical;
        const sem = semantic ? Math.max(0, semantic.get(memory.id) ?? 0) : 0;
        const recency = Math.pow(0.5, Math.max(0, now - memory.updatedAt) / RECENCY_HALF_LIFE_MS);
        const score = semantic
          ? RANK_WEIGHTS.semantic * sem + RANK_WEIGHTS.lexical * lex + RANK_WEIGHTS.recency * recency
          : 0.75 * lex + 0.25 * recency;
        // Without lexical overlap, require strong semantic similarity to avoid noise.
        const relevant = lexical[i]! > 0 || (semantic !== null && sem >= 0.55);
        return { memory, score, relevant };
      })
      .filter((entry) => entry.relevant)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(({ memory, score }) => ({ memory, score }));
  }

  /** Exact or near-duplicate of existing long-term memory, if any. */
  async findDuplicate(category: MemoryCategory, content: string): Promise<{ id: string; match: 'exact' | 'near'; similarity?: number } | null> {
    const exact = this.longTerm.findExactDuplicate(category, content);
    if (exact) return { id: exact.id, match: 'exact' };
    const sameCategory = this.longTerm.active().filter((record) => record.category === category);
    if (!sameCategory.length) return null;
    const nearest = await this.index.nearest(content, sameCategory);
    if (nearest && nearest.similarity >= NEAR_DUPLICATE_THRESHOLD) {
      return { id: nearest.id, match: 'near', similarity: Number(nearest.similarity.toFixed(3)) };
    }
    return null;
  }

  /**
   * Propose with duplicate detection against long-term memory (exact + local semantic).
   * Duplicates raise DuplicateMemoryError carrying the existing memory id.
   */
  async proposeChecked(deviceId: string, category: MemoryCategory, content: string, source: LearningCandidate['source']): Promise<LearningCandidate> {
    if (!this.data.learningEnabled) throw new Error('Learning is disabled by the owner.');
    this.longTerm.assertStorable(category, content);
    const duplicate = await this.findDuplicate(category, content);
    if (duplicate) throw new DuplicateMemoryError(duplicate.id, duplicate.match, duplicate.similarity);
    return this.propose(deviceId, category, content, source);
  }

  /** Correct a long-term memory with conflict detection; previous text goes to version history. */
  correct(memoryId: string, content: string, expectedUpdatedAt?: number): PersonalMemory | undefined {
    return this.longTerm.update(memoryId, content, expectedUpdatedAt);
  }

  versionsOf(memoryId: string): MemoryVersion[] {
    return this.versions.list(memoryId);
  }

  /** Deterministic, local summary of a working scope (no model call). */
  summarizeScope(deviceId: string, kind: WorkingScopeKind, scopeId: string, maxChars = 1200): string {
    const entries = this.working.list(deviceId, kind, scopeId);
    const lines: string[] = [];
    let used = 0;
    for (const entry of [...entries].reverse()) {
      const line = `- ${entry.label}: ${entry.content.replace(/\s+/g, ' ').slice(0, 240)}`;
      if (used + line.length > maxChars) break;
      lines.unshift(line);
      used += line.length + 1;
    }
    return lines.join('\n');
  }

  // ---- consent-based learning ----

  isLearningEnabled(): boolean {
    return this.data.learningEnabled;
  }

  setLearningEnabled(enabled: boolean): void {
    this.data.learningEnabled = enabled;
    this.persist();
  }

  /** Propose a long-term memory from feedback or a conversation/task outcome. */
  propose(deviceId: string, category: MemoryCategory, content: string, source: LearningCandidate['source']): LearningCandidate {
    if (!this.data.learningEnabled) throw new Error('Learning is disabled by the owner.');
    // Same content rules as long-term memory: no secrets, no instruction-like text.
    this.longTerm.assertStorable(category, content);
    const normalized = normalizeMemoryText(content);
    const duplicate = this.data.candidates.find((candidate) => candidate.status === 'pending' && normalizeMemoryText(candidate.content) === normalized);
    if (duplicate) return { ...duplicate };
    if (this.data.candidates.length >= MAX_CANDIDATES) {
      // Drop the oldest decided candidates first; never silently drop pending ones.
      const index = this.data.candidates.findIndex((candidate) => candidate.status !== 'pending');
      if (index < 0) throw new Error('Too many pending learning candidates; review some first.');
      this.data.candidates.splice(index, 1);
    }
    const candidate: LearningCandidate = {
      id: randomBytes(12).toString('hex'),
      deviceId,
      category,
      content: content.trim(),
      source: { kind: source.kind, ...(source.ref ? { ref: String(source.ref).slice(0, 80) } : {}) },
      status: 'pending',
      createdAt: Date.now(),
    };
    this.data.candidates.push(candidate);
    this.persist();
    return { ...candidate };
  }

  /** Promote a working-memory entry: creates a pending candidate, never a direct write. */
  proposeFromWorking(deviceId: string, entryId: string, category: MemoryCategory): LearningCandidate {
    const entry = this.working.get(deviceId, entryId);
    if (!entry) throw new Error('Working memory entry not found or expired.');
    return this.propose(deviceId, category, entry.content, { kind: 'working_memory', ref: `${entry.scope.kind}:${entry.scope.id}` });
  }

  listCandidates(status?: LearningCandidate['status']): LearningCandidate[] {
    return this.data.candidates.filter((candidate) => !status || candidate.status === status).map((candidate) => ({ ...candidate, source: { ...candidate.source } }));
  }

  approve(candidateId: string, ttlDays?: number): { candidate: LearningCandidate; memory: PersonalMemory } {
    const candidate = this.data.candidates.find((item) => item.id === candidateId);
    if (!candidate || candidate.status !== 'pending') throw new Error('Learning candidate not found or already decided.');
    const memory = this.longTerm.save(candidate.category, candidate.content, ttlDays, {
      kind: candidate.source.kind,
      ...(candidate.source.ref ? { ref: candidate.source.ref } : {}),
      approvedAt: Date.now(),
    });
    candidate.status = 'approved';
    candidate.decidedAt = Date.now();
    candidate.memoryId = memory.id;
    this.persist();
    try { this.quality.recordCandidateDecision('approved'); } catch { /* Quality telemetry must not turn a committed approval into a reported failure. */ }
    return { candidate: { ...candidate }, memory };
  }

  reject(candidateId: string): LearningCandidate {
    const candidate = this.data.candidates.find((item) => item.id === candidateId);
    if (!candidate || candidate.status !== 'pending') throw new Error('Learning candidate not found or already decided.');
    candidate.status = 'rejected';
    candidate.decidedAt = Date.now();
    // A rejected candidate keeps no copy of the text.
    candidate.content = '[rejected]';
    this.persist();
    try { this.quality.recordCandidateDecision('rejected'); } catch { /* Quality telemetry must not turn a committed rejection into a reported failure. */ }
    return { ...candidate };
  }

  /**
   * Called after a long-term memory is deleted: remove derived copies in this manager's
   * stores - working memory, learning candidates, the embedding index and version history.
   */
  scrubDeleted(memoryId: string, content: string): {
    workingRemoved: number; candidatesScrubbed: number; indexRemoved: boolean; versionsPurged: boolean; derivedVerified: boolean;
  } {
    const workingRemoved = this.working.scrubContent(content);
    const indexRemoved = this.index.remove(memoryId);
    const versionsPurged = this.versions.purge(memoryId);
    const derivedVerified = this.index.verifyRemoved(memoryId) && this.versions.verifyPurged(memoryId);
    let candidatesScrubbed = 0;
    for (const candidate of this.data.candidates) {
      if (candidate.memoryId === memoryId || candidate.content === content.trim()) {
        candidate.content = '[deleted personal memory]';
        candidatesScrubbed += 1;
      }
    }
    if (candidatesScrubbed) this.persist();
    return { workingRemoved, candidatesScrubbed, indexRemoved, versionsPurged, derivedVerified };
  }

  recordRetrievalEvaluation(input: LearningQualityInput): LearningQualitySummary {
    return this.quality.record(input);
  }

  status(): {
    quality: LearningQualitySummary;
    longTerm: ReturnType<PersonalMemoryStore['status']>;
    working: ReturnType<WorkingMemory['stats']>;
    learningEnabled: boolean;
    pendingCandidates: number;
    retrieval: ReturnType<SemanticMemoryIndex['status']> & { lastUsedAt: number | null };
  } {
    return {
      quality: this.quality.summary(),
      longTerm: this.longTerm.status(),
      working: this.working.stats(),
      learningEnabled: this.data.learningEnabled,
      pendingCandidates: this.data.candidates.filter((candidate) => candidate.status === 'pending').length,
      retrieval: { ...this.index.status(), lastUsedAt: this.lastRetrieval?.at ?? null },
    };
  }

  /** Relevance score helper exposed for callers ranking their own context. */
  static overlap(a: string, b: string): number {
    const left = words(a);
    let score = 0;
    for (const word of words(b)) if (left.has(word)) score += 1;
    return score;
  }
}
