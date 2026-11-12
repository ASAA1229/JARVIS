/**
 * Local-first, encrypted text-document retrieval.
 *
 * This first ingestion boundary intentionally accepts UTF-8 text only. Binary
 * formats (PDF/DOCX/etc.) require dedicated parsers and are rejected rather
 * than silently producing empty or misleading indexes.
 */
import { createHash, randomUUID } from 'node:crypto';
import { EncryptedJsonFile } from './encryptedJsonFile.js';
import type { Embedder } from './semanticIndex.js';
import { cosineSimilarity } from './semanticIndex.js';

export interface DocumentSource {
  documentId: string;
  title: string;
  sourceName: string;
  chunk: number;
  totalChunks: number;
  excerpt: string;
}
interface DocumentChunk {
  id: string;
  index: number;
  text: string;
  hash: string;
}
interface StoredDocument {
  id: string;
  ownerDeviceId: string;
  title: string;
  sourceName: string;
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  chunks: DocumentChunk[];
}
interface DocumentPayload { version: 1; documents: StoredDocument[] }
interface DocumentVector { hash: string; vector: number[] }
interface VectorPayload { version: 1; model: string; entries: Record<string, DocumentVector> }

const MAX_DOCUMENTS = 200;
const MAX_LIBRARY_CHARS = 20_000_000;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_DOCUMENT_CHARS = 1_000_000;
const MAX_CHUNKS = 500;
const CHUNK_SIZE = 1200;
const CHUNK_OVERLAP = 180;
const MAX_RESULTS = 8;
const MAX_RESULT_CHARS = 1200;
const ALLOWED_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.json', '.log', '.yaml', '.yml', '.xml', '.html']);
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function safeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
}

function splitIntoChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  let completed = false;
  while (start < text.length && chunks.length < MAX_CHUNKS) {
    let end = Math.min(start + CHUNK_SIZE, text.length);
    if (end < text.length) {
      const boundary = Math.max(text.lastIndexOf('\n', end), text.lastIndexOf('. ', end), text.lastIndexOf(' ', end));
      if (boundary > start + Math.floor(CHUNK_SIZE * 0.6)) end = boundary + 1;
    }
    const part = text.slice(start, end).trim();
    if (part) chunks.push(part);
    if (end >= text.length) { completed = true; break; }
    start = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  if (!completed) throw new Error('Document exceeds the maximum safe chunk count.');
  return chunks;
}

function lexicalScore(query: string, text: string): number {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((term) => term.length > 2))];
  if (!terms.length) return 0;
  const lower = text.toLowerCase();
  const matched = terms.filter((term) => lower.includes(term)).length;
  return matched / terms.length;
}

export class DocumentRagStore {
  private readonly file: EncryptedJsonFile<DocumentPayload>;
  private readonly vectorFile: EncryptedJsonFile<VectorPayload>;
  private documents = new Map<string, StoredDocument>();
  private vectors: VectorPayload;

  constructor(
    filePath: string,
    ownerControlToken: string,
    private readonly embedder: Embedder | null = null,
  ) {
    this.file = new EncryptedJsonFile(filePath, ownerControlToken, 'JARVIS-DOCUMENT-RAG-V1');
    this.vectorFile = new EncryptedJsonFile(filePath + '.vectors', ownerControlToken, 'JARVIS-DOCUMENT-RAG-VECTORS-V1');
    const payload = this.file.read();
    if (payload !== undefined) {
      if (!payload || payload.version !== 1 || !Array.isArray(payload.documents) || payload.documents.length > MAX_DOCUMENTS ||
          !payload.documents.every((doc) => this.validDocument(doc))) {
        throw new Error('Document library failed validation; refusing to overwrite it.');
      }
      this.documents = new Map(payload.documents.map((doc) => [doc.id, doc]));
    }
    let vectorPayload: VectorPayload | undefined;
    try { vectorPayload = this.vectorFile.read(); } catch {
      // Embeddings are derived data; rebuild them from the encrypted source documents.
      vectorPayload = undefined;
    }
    const validVectors = vectorPayload?.version === 1 &&
      vectorPayload.model === (embedder?.model ?? 'none') &&
      !!vectorPayload.entries && typeof vectorPayload.entries === 'object' && !Array.isArray(vectorPayload.entries) &&
      Object.values(vectorPayload.entries).every((entry) =>
        !!entry && typeof entry.hash === 'string' && Array.isArray(entry.vector) &&
        entry.vector.length > 0 && entry.vector.length <= 8192 &&
        entry.vector.every((value) => typeof value === 'number' && Number.isFinite(value)));
    this.vectors = validVectors
      ? vectorPayload!
      : { version: 1, model: embedder?.model ?? 'none', entries: {} };
    this.pruneVectors();
  }

  private validDocument(value: unknown): value is StoredDocument {
    if (!value || typeof value !== 'object') return false;
    const doc = value as Record<string, unknown>;
    if (typeof doc.id !== 'string' || typeof doc.ownerDeviceId !== 'string' || !doc.ownerDeviceId ||
        typeof doc.title !== 'string' || typeof doc.sourceName !== 'string' ||
        typeof doc.contentHash !== 'string' || typeof doc.createdAt !== 'number' ||
        typeof doc.updatedAt !== 'number' || !Array.isArray(doc.chunks) || doc.chunks.length > MAX_CHUNKS) return false;
    return doc.chunks.every((chunk, index) => {
      const item = chunk as Record<string, unknown>;
      return typeof item.id === 'string' && item.index === index && typeof item.text === 'string' &&
        item.text.length <= CHUNK_SIZE + 50 && typeof item.hash === 'string';
    });
  }

  private persist(): void {
    this.file.write({ version: 1, documents: [...this.documents.values()] });
  }

  private pruneVectors(): void {
    const live = new Set([...this.documents.values()].flatMap((doc) => doc.chunks.map((chunk) => chunk.id)));
    for (const id of Object.keys(this.vectors.entries)) if (!live.has(id)) delete this.vectors.entries[id];
    if (!this.embedder) this.vectors = { version: 1, model: 'none', entries: {} };
    this.vectorFile.write(this.vectors);
  }

  public ingest(input: {
    ownerDeviceId: string;
    sourceName: string;
    title?: string;
    content: string;
  }): { documentId: string; chunkCount: number; duplicate: boolean } {
    if (!input.ownerDeviceId || input.ownerDeviceId.length > 256) throw new Error('A valid authenticated owner device is required.');
    if (typeof input.content !== 'string' || !input.content.trim()) throw new Error('Document content must not be empty.');
    if (Buffer.byteLength(input.content, 'utf8') > MAX_DOCUMENT_BYTES || input.content.length > MAX_DOCUMENT_CHARS) {
      throw new Error('Document exceeds the 2 MB ingestion limit.');
    }
    const sourceName = input.sourceName.trim();
    if (!sourceName || sourceName.length > 240 || /[\\/]/.test(sourceName)) throw new Error('Source name must be a plain filename.');
    const extension = sourceName.includes('.') ? sourceName.slice(sourceName.lastIndexOf('.')).toLowerCase() : '';
    if (!ALLOWED_EXTENSIONS.has(extension)) throw new Error('Unsupported document format. Supported formats: TXT, Markdown, CSV, JSON, LOG, YAML, XML and HTML.');
    const normalized = safeText(input.content);
    if (!normalized) throw new Error('Document contains no usable text.');
    const contentHash = hash(normalized);
    const duplicate = [...this.documents.values()].find((doc) => doc.ownerDeviceId === input.ownerDeviceId && doc.contentHash === contentHash);
    if (duplicate) return { documentId: duplicate.id, chunkCount: duplicate.chunks.length, duplicate: true };
    if (this.documents.size >= MAX_DOCUMENTS) throw new Error('Document library limit reached; delete an existing document first.');
    const currentLibraryChars = [...this.documents.values()].reduce((total, doc) => total + doc.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), 0);
    if (currentLibraryChars + normalized.length > MAX_LIBRARY_CHARS) throw new Error('Document library storage limit reached; delete existing documents first.');
    const parts = splitIntoChunks(normalized);
    if (!parts.length || parts.length > MAX_CHUNKS) throw new Error('Document could not be safely divided within the chunk limit.');
    const now = Date.now();
    const id = randomUUID();
    const doc: StoredDocument = {
      id, ownerDeviceId: input.ownerDeviceId,
      title: (input.title?.trim() || sourceName).slice(0, 160),
      sourceName, contentHash, createdAt: now, updatedAt: now,
      chunks: parts.map((text, index) => ({ id: id + ':' + index, index, text, hash: hash(text) })),
    };
    this.documents.set(id, doc);
    this.persist();
    return { documentId: id, chunkCount: parts.length, duplicate: false };
  }

  public async search(ownerDeviceId: string, query: string, limit = 5, signal?: AbortSignal): Promise<Array<{ content: string; source: DocumentSource; score: number; method: 'semantic' | 'lexical' }>> {
    const normalizedQuery = query.trim();
    if (!normalizedQuery || normalizedQuery.length > 2000) throw new Error('Search query must contain 1–2000 characters.');
    const boundedLimit = Math.max(1, Math.min(Math.floor(limit), MAX_RESULTS));
    const docs = [...this.documents.values()].filter((doc) => doc.ownerDeviceId === ownerDeviceId);
    const chunks = docs.flatMap((doc) => doc.chunks.map((chunk) => ({ doc, chunk })));
    if (!chunks.length) return [];

    let queryVector: number[] | null = null;
    if (this.embedder) {
      try {
        for (const { chunk } of chunks) {
          const existing = this.vectors.entries[chunk.id];
          if (!existing || existing.hash !== chunk.hash) {
            this.vectors.entries[chunk.id] = { hash: chunk.hash, vector: await this.embedder.embed(chunk.text, signal) };
          }
        }
        queryVector = await this.embedder.embed(normalizedQuery, signal);
        this.vectorFile.write(this.vectors);
      } catch {
        queryVector = null;
      }
    }

    return chunks.map(({ doc, chunk }) => {
      const lexical = lexicalScore(normalizedQuery, chunk.text);
      const semantic = queryVector && this.vectors.entries[chunk.id]
        ? Math.max(0, cosineSimilarity(queryVector, this.vectors.entries[chunk.id]!.vector))
        : 0;
      return {
        content: chunk.text.slice(0, MAX_RESULT_CHARS),
        source: {
          documentId: doc.id, title: doc.title, sourceName: doc.sourceName,
          chunk: chunk.index + 1, totalChunks: doc.chunks.length,
          excerpt: chunk.text.slice(0, 240),
        },
        score: queryVector ? semantic * 0.7 + lexical * 0.3 : lexical,
        method: queryVector ? 'semantic' as const : 'lexical' as const,
      };
    }).filter((item) => item.method === 'semantic' ? item.score >= 0.18 : item.score > 0).sort((a, b) => b.score - a.score).slice(0, boundedLimit);
  }

  public list(ownerDeviceId: string): Array<{ id: string; title: string; sourceName: string; chunkCount: number; createdAt: number }> {
    return [...this.documents.values()].filter((doc) => doc.ownerDeviceId === ownerDeviceId)
      .map((doc) => ({ id: doc.id, title: doc.title, sourceName: doc.sourceName, chunkCount: doc.chunks.length, createdAt: doc.createdAt }));
  }

  public delete(ownerDeviceId: string, documentId: string): boolean {
    const doc = this.documents.get(documentId);
    if (!doc || doc.ownerDeviceId !== ownerDeviceId) return false;
    this.documents.delete(documentId);
    for (const chunk of doc.chunks) delete this.vectors.entries[chunk.id];
    this.persist();
    this.vectorFile.write(this.vectors);
    return true;
  }
}
