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
import type { MemoryCategory, PersonalMemory, PersonalMemoryStore } from './personalMemoryStore.js';
import type { WorkingMemory, WorkingScopeKind } from './workingMemory.js';

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

  constructor(
    readonly longTerm: PersonalMemoryStore,
    readonly working: WorkingMemory,
    private readonly candidatesPath: string,
    ownerControlToken: string,
  ) {
    if (ownerControlToken.length < 32) throw new Error('Memory manager requires a configured owner control token.');
    this.key = scryptSync(ownerControlToken, 'JARVIS-MEMORY-CANDIDATES-V1', 32);
    this.load();
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
    const duplicate = this.data.candidates.find((candidate) => candidate.status === 'pending' && candidate.content === content.trim());
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
    return { ...candidate };
  }

  /** Called after a long-term memory is deleted: remove derived copies in this manager's stores. */
  scrubDeleted(memoryId: string, content: string): { workingRemoved: number; candidatesScrubbed: number } {
    const workingRemoved = this.working.scrubContent(content);
    let candidatesScrubbed = 0;
    for (const candidate of this.data.candidates) {
      if (candidate.memoryId === memoryId || candidate.content === content.trim()) {
        candidate.content = '[deleted personal memory]';
        candidatesScrubbed += 1;
      }
    }
    if (candidatesScrubbed) this.persist();
    return { workingRemoved, candidatesScrubbed };
  }

  status(): { longTerm: ReturnType<PersonalMemoryStore['status']>; working: ReturnType<WorkingMemory['stats']>; learningEnabled: boolean; pendingCandidates: number } {
    return {
      longTerm: this.longTerm.status(),
      working: this.working.stats(),
      learningEnabled: this.data.learningEnabled,
      pendingCandidates: this.data.candidates.filter((candidate) => candidate.status === 'pending').length,
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
