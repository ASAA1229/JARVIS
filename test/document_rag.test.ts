import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentRagStore } from '../src/memory/documentRagStore.js';
import type { Embedder } from '../src/memory/semanticIndex.js';

const TOKEN = 'document-rag-owner-token-0123456789abcdef';
const fakeEmbedder: Embedder = {
  model: 'test-embedding-model',
  async embed(text) {
    const vector = new Array(32).fill(0);
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word) vector[word.charCodeAt(0) % vector.length] += 1;
    }
    return vector;
  },
};

function withTempDir(run: (directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-document-rag-'));
  try { run(directory); } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('document text is encrypted at rest and searchable after restart with source citations', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'documents.enc');
    const store = new DocumentRagStore(path, TOKEN);
    const result = store.ingest({
      ownerDeviceId: 'device-a',
      sourceName: 'operations.md',
      title: 'Operations Guide',
      content: '# Recovery\n\nJARVIS uses checkpoint-based recovery and never automatically replays uncertain actions.',
    });
    assert.equal(result.duplicate, false);
    const raw = readFileSync(path, 'utf8');
    assert.ok(!raw.includes('checkpoint-based recovery'));
    const reopened = new DocumentRagStore(path, TOKEN);
    const matches = await reopened.search('device-a', 'checkpoint recovery uncertain actions');
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.source.title, 'Operations Guide');
    assert.equal(matches[0]?.source.sourceName, 'operations.md');
    assert.equal(matches[0]?.source.chunk, 1);
    assert.match(matches[0]?.content || '', /checkpoint-based recovery/);
  });
});

test('documents are isolated by device and duplicate content is detected per owner', () => {
  withTempDir((directory) => {
    const store = new DocumentRagStore(join(directory, 'documents.enc'), TOKEN);
    const first = store.ingest({ ownerDeviceId: 'device-a', sourceName: 'a.txt', content: 'Private document about JARVIS recovery.' });
    const duplicate = store.ingest({ ownerDeviceId: 'device-a', sourceName: 'copy.txt', content: 'Private document about JARVIS recovery.' });
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.documentId, first.documentId);
    const otherDevice = store.ingest({ ownerDeviceId: 'device-b', sourceName: 'b.txt', content: 'Private document about JARVIS recovery.' });
    assert.notEqual(otherDevice.documentId, first.documentId);
    assert.equal(store.list('device-a').length, 1);
    assert.equal(store.list('device-b').length, 1);
  });
});

test('chunking bounds long documents and retrieval returns chunk-level source positions', async () => {
  await withTempDir(async (directory) => {
    const store = new DocumentRagStore(join(directory, 'documents.enc'), TOKEN);
    const sections = Array.from({ length: 45 }, (_, index) => `Section ${index + 1}: unique checkpoint marker-${index + 1}. ` + 'operational detail '.repeat(20));
    const result = store.ingest({ ownerDeviceId: 'device-a', sourceName: 'long.txt', content: sections.join('\n\n') });
    assert.ok(result.chunkCount > 1);
    const matches = await store.search('device-a', 'marker-40');
    assert.ok(matches.length > 0);
    assert.ok(matches[0]!.source.totalChunks > 1);
    assert.ok(matches[0]!.source.chunk >= 1);
  });
});

test('unsupported binary formats, empty documents and oversized documents are rejected', () => {
  withTempDir((directory) => {
    const store = new DocumentRagStore(join(directory, 'documents.enc'), TOKEN);
    assert.throws(() => store.ingest({ ownerDeviceId: 'device-a', sourceName: 'manual.pdf', content: 'binary placeholder' }), /Unsupported document format/);
    assert.throws(() => store.ingest({ ownerDeviceId: 'device-a', sourceName: 'empty.txt', content: '   ' }), /must not be empty/);
    assert.throws(() => store.ingest({ ownerDeviceId: 'device-a', sourceName: 'large.txt', content: 'x'.repeat(1_000_001) }), /2 MB ingestion limit/);
    assert.throws(() => store.ingest({ ownerDeviceId: 'device-a', sourceName: '../secret.txt', content: 'secret' }), /plain filename/);
  });
});

test('lexical fallback works without embeddings and semantic retrieval uses local embedder when supplied', async () => {
  await withTempDir(async (directory) => {
    const lexical = new DocumentRagStore(join(directory, 'lexical.enc'), TOKEN);
    lexical.ingest({ ownerDeviceId: 'device-a', sourceName: 'guide.txt', content: 'Deadlock prevention uses canonical lock ordering.' });
    const lexicalResult = await lexical.search('device-a', 'deadlock canonical lock ordering');
    assert.equal(lexicalResult[0]?.method, 'lexical');

    const semantic = new DocumentRagStore(join(directory, 'semantic.enc'), TOKEN, fakeEmbedder);
    semantic.ingest({ ownerDeviceId: 'device-a', sourceName: 'guide.txt', content: 'Deadlock prevention uses canonical lock ordering.' });
    const semanticResult = await semantic.search('device-a', 'deadlock canonical lock ordering');
    assert.equal(semanticResult[0]?.method, 'semantic');
  });
});

test('document deletion removes document and derived vector records', async () => {
  await withTempDir(async (directory) => {
    const path = join(directory, 'documents.enc');
    const store = new DocumentRagStore(path, TOKEN, fakeEmbedder);
    const created = store.ingest({ ownerDeviceId: 'device-a', sourceName: 'guide.txt', content: 'Encrypted content for deletion verification.' });
    await store.search('device-a', 'deletion verification');
    assert.equal(store.delete('device-b', created.documentId), false);
    assert.equal(store.delete('device-a', created.documentId), true);
    assert.equal(store.list('device-a').length, 0);
    assert.equal((await store.search('device-a', 'deletion verification')).length, 0);
  });
});
