/**
 * Local-first semantic retrieval for long-term memory (J-E06).
 *
 * Embeddings come only from a LOCAL Ollama instance (POST /api/embed). If
 * OLLAMA_URL points anywhere other than loopback, embeddings are disabled:
 * personal memory is never sent to a remote or cloud provider. When the model is
 * missing or unreachable, callers fall back to lexical scoring and the method used
 * is reported honestly.
 *
 * The vectors are stored in an encrypted index file next to the memory file and
 * rebuilt lazily (only records whose content hash changed are re-embedded).
 */
import { createHash } from 'node:crypto';
import { EncryptedJsonFile } from './encryptedJsonFile.js';
import { ProviderRouter } from '../ai/providerRouter.js';

export type RetrievalMethod = 'semantic' | 'lexical';

export interface Embedder {
  readonly model: string;
  embed(text: string, signal?: AbortSignal): Promise<number[]>;
}

export class EmbeddingUnavailableError extends Error {}

/**
 * Resolve the local Ollama embedding endpoint; null when there is no loopback local provider.
 * The endpoint comes from the provider router (E2:D4.7), so embeddings follow the same single
 * routing policy as chat: loopback only, never a cloud or remote host, in every routing mode.
 */
export function resolveLocalEmbeddingEndpoint(env: NodeJS.ProcessEnv = process.env): { url: string; model: string } | null {
  const provider = new ProviderRouter(() => env).localProvider();
  if (!provider) return null;
  const model = env.JARVIS_EMBED_MODEL || 'nomic-embed-text';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(model)) return null;
  return { url: `${provider.baseUrl}/api/embed`, model };
}

const MAX_EMBEDDING_RESPONSE_BYTES = 128 * 1024;

async function readEmbeddingResponse(response: Response): Promise<string> {
  const length = response.headers.get('content-length');
  if (length !== null && /^\d+$/.test(length) && Number(length) > MAX_EMBEDDING_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new EmbeddingUnavailableError('Local embedding response exceeded its safe size limit.');
  }
  if (!response.body) throw new EmbeddingUnavailableError('Local embedding response was empty.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EMBEDDING_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new EmbeddingUnavailableError('Local embedding response exceeded its safe size limit.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

export class OllamaEmbedder implements Embedder {
  private unavailableUntil = 0;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: { url: string; model: string },
    private readonly fetchImpl: typeof fetch = fetch,
    timeoutMs = 15_000,
  ) {
    const parsed = new URL(endpoint.url);
    if (!['http:', 'https:'].includes(parsed.protocol) ||
        !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) ||
        parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/api/embed') {
      throw new Error('Embedding endpoint must be the local Ollama /api/embed endpoint.');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/.test(endpoint.model)) {
      throw new Error('Embedding model name is invalid.');
    }
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120_000) {
      throw new Error('Embedding timeout must be between 1000 and 120000 milliseconds.');
    }
    this.timeoutMs = timeoutMs;
  }

  get model(): string {
    return this.endpoint.model;
  }

  async embed(text: string, signal?: AbortSignal): Promise<number[]> {
    if (Date.now() < this.unavailableUntil) throw new EmbeddingUnavailableError('Local embedding model recently unavailable.');
    if (typeof text !== 'string' || !text.trim()) throw new EmbeddingUnavailableError('Embedding input must not be empty.');
    const requestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
      : AbortSignal.timeout(this.timeoutMs);
    try {
      const response = await this.fetchImpl(this.endpoint.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ model: this.endpoint.model, input: text.slice(0, 8000) }),
        signal: requestSignal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new EmbeddingUnavailableError(`Local embedding model returned HTTP ${response.status}.`);
      }
      const raw = await readEmbeddingResponse(response);
      let payload: { embeddings?: unknown };
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        throw new EmbeddingUnavailableError('Local embedding model returned invalid JSON.');
      }
      const vectors = payload.embeddings;
      const vector = Array.isArray(vectors) ? vectors[0] : undefined;
      if (!Array.isArray(vector) || vector.length === 0 || vector.length > 8192 ||
          !vector.every((value) => typeof value === 'number' && Number.isFinite(value))) {
        throw new EmbeddingUnavailableError('Local embedding model returned an invalid vector.');
      }
      return vector as number[];
    } catch (error) {
      if (signal?.aborted) throw new EmbeddingUnavailableError('Embedding request was cancelled.');
      // Back off for a minute so a missing model does not slow every request.
      this.unavailableUntil = Date.now() + 60_000;
      throw error instanceof EmbeddingUnavailableError ? error : new EmbeddingUnavailableError('Local embedding model is not reachable.');
    }
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface IndexEntry { hash: string; vector: number[] }
interface IndexFile { version: 1; model: string; entries: Record<string, IndexEntry> }

const contentHash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export class SemanticMemoryIndex {
  private readonly file: EncryptedJsonFile<IndexFile>;
  private data: IndexFile;
  private lastMethod: RetrievalMethod = 'lexical';
  private lastReason = 'not yet used';

  constructor(filePath: string, ownerControlToken: string, private readonly embedder: Embedder | null) {
    this.file = new EncryptedJsonFile<IndexFile>(filePath, ownerControlToken, 'JARVIS-MEMORY-EMBEDDINGS-V1');
    let loaded: IndexFile | undefined;
    try {
      loaded = this.file.read();
    } catch {
      // The index is derived data: an unreadable index is rebuilt rather than trusted.
      loaded = undefined;
    }
    const model = embedder?.model ?? 'none';
    this.data = loaded && loaded.version === 1 && loaded.model === model && loaded.entries ? loaded : { version: 1, model, entries: {} };
  }

  get available(): boolean {
    return this.embedder !== null;
  }

  status(): { method: RetrievalMethod; reason: string; model: string | null; indexed: number } {
    return { method: this.lastMethod, reason: this.lastReason, model: this.embedder?.model ?? null, indexed: Object.keys(this.data.entries).length };
  }

  private note(method: RetrievalMethod, reason: string): void {
    this.lastMethod = method;
    this.lastReason = reason;
  }

  /** Embed records that are new or changed; drop entries for records that no longer exist. */
  async sync(records: Array<{ id: string; content: string }>, signal?: AbortSignal): Promise<boolean> {
    if (!this.embedder) {
      this.note('lexical', 'Embeddings disabled: no loopback Ollama endpoint configured.');
      return false;
    }
    let changed = false;
    const live = new Set(records.map((record) => record.id));
    for (const id of Object.keys(this.data.entries)) {
      if (!live.has(id)) {
        delete this.data.entries[id];
        changed = true;
      }
    }
    try {
      for (const record of records) {
        const hash = contentHash(record.content);
        if (this.data.entries[record.id]?.hash === hash) continue;
        this.data.entries[record.id] = { hash, vector: await this.embedder.embed(record.content, signal) };
        changed = true;
      }
    } catch (error) {
      if (changed) this.file.write(this.data);
      this.note('lexical', error instanceof Error ? error.message : 'Local embedding model unavailable.');
      return false;
    }
    if (changed) this.file.write(this.data);
    return true;
  }

  /** Semantic similarity of the query to each indexed record, or null when unavailable. */
  async scores(query: string, records: Array<{ id: string; content: string }>, signal?: AbortSignal): Promise<Map<string, number> | null> {
    if (!(await this.sync(records, signal)) || !this.embedder) return null;
    let queryVector: number[];
    try {
      queryVector = await this.embedder.embed(query, signal);
    } catch (error) {
      this.note('lexical', error instanceof Error ? error.message : 'Local embedding model unavailable.');
      return null;
    }
    const scores = new Map<string, number>();
    for (const record of records) {
      const entry = this.data.entries[record.id];
      if (entry) scores.set(record.id, cosineSimilarity(queryVector, entry.vector));
    }
    this.note('semantic', `Local embeddings (${this.embedder.model}).`);
    return scores;
  }

  /** Nearest existing record to a piece of text (for near-duplicate detection). */
  async nearest(text: string, records: Array<{ id: string; content: string }>): Promise<{ id: string; similarity: number } | null> {
    const scores = await this.scores(text, records);
    if (!scores) return null;
    let best: { id: string; similarity: number } | null = null;
    for (const [id, similarity] of scores) if (!best || similarity > best.similarity) best = { id, similarity };
    return best;
  }

  remove(memoryId: string): boolean {
    if (!(memoryId in this.data.entries)) return false;
    delete this.data.entries[memoryId];
    this.file.write(this.data);
    return true;
  }

  verifyRemoved(memoryId: string): boolean {
    try {
      const onDisk = this.file.read();
      return !onDisk || !(memoryId in onDisk.entries);
    } catch {
      return false;
    }
  }
}
