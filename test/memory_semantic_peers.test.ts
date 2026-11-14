import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalMemoryStore, MemoryConflictError } from '../src/memory/personalMemoryStore.js';
import { WorkingMemory } from '../src/memory/workingMemory.js';
import { MemoryManager, DuplicateMemoryError } from '../src/memory/memoryManager.js';
import { SemanticMemoryIndex, resolveLocalEmbeddingEndpoint, OllamaEmbedder, type Embedder } from '../src/memory/semanticIndex.js';
import { MemoryVersionHistory } from '../src/memory/memoryVersions.js';
import { PeerRegistry } from '../src/peers/peerRegistry.js';
import { PeerDiscoveryService, isPrivateLanAddress } from '../src/peers/peerDiscovery.js';
import { createPeerEnvelope } from '../src/sync/peerEnvelope.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { DeviceStatus, Permission, type DeviceRecord } from '../src/core/types.js';

const TOKEN = 'worker-m-owner-token-0123456789abcdef-xyz';

/** Deterministic fake embedder: bag-of-letters vector. */
const fakeEmbedder: Embedder = {
  model: 'fake',
  async embed(text: string) {
    const vector = new Array(26).fill(0);
    for (const ch of text.toLowerCase()) if (ch >= 'a' && ch <= 'z') vector[ch.charCodeAt(0) - 97] += 1;
    return vector;
  },
};

function setup(embedder: Embedder | null) {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-worker-m-'));
  const store = new PersonalMemoryStore(join(dir, 'memory.enc'), TOKEN);
  const index = new SemanticMemoryIndex(join(dir, 'index.enc'), TOKEN, embedder);
  const versions = new MemoryVersionHistory(join(dir, 'versions.enc'), TOKEN);
  const manager = new MemoryManager(store, new WorkingMemory(), join(dir, 'candidates.enc'), TOKEN, { index, versions });
  return { dir, store, manager, index, versions };
}

test('embeddings are only resolved for loopback Ollama', () => {
  assert.equal(resolveLocalEmbeddingEndpoint({ JARVIS_AI_BASE_URL: 'https://api.openai.com/v1' } as NodeJS.ProcessEnv), null);
  assert.equal(resolveLocalEmbeddingEndpoint({ JARVIS_AI_BASE_URL: 'http://127.0.0.1:11434/v1' } as NodeJS.ProcessEnv)?.url, 'http://127.0.0.1:11434/api/embed');
  assert.equal(resolveLocalEmbeddingEndpoint({ OLLAMA_URL: 'http://localhost:11434' } as NodeJS.ProcessEnv)?.url, 'http://localhost:11434/api/embed');
});

test('Ollama embedder uses native /api/embed and validates returned vectors', async () => {
  let requestedUrl = '';
  let requestBody: Record<string, unknown> = {};
  const embedder = new OllamaEmbedder({
    url: 'http://localhost:11434/api/embed',
    model: 'nomic-embed-text',
  }, async (input, init) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ embeddings: [[0.1, 0.2, 0.3]] });
  });
  assert.deepEqual(await embedder.embed('local semantic search'), [0.1, 0.2, 0.3]);
  assert.equal(requestedUrl, 'http://localhost:11434/api/embed');
  assert.deepEqual(requestBody, { model: 'nomic-embed-text', input: 'local semantic search' });
});

test('Ollama embedder refuses non-loopback endpoints', () => {
  assert.throws(() => new OllamaEmbedder({
    url: 'https://remote.example/api/embed',
    model: 'nomic-embed-text',
  }), /local Ollama/);
  assert.equal(resolveLocalEmbeddingEndpoint({ OLLAMA_URL: 'http://localhost:11434/base?x=1' } as NodeJS.ProcessEnv), null);
});

test('ranked retrieval reports semantic or lexical honestly', async () => {
  for (const embedder of [fakeEmbedder, null]) {
    const { dir, store, manager } = setup(embedder);
    try {
      store.save('preference', 'Prefers dark mode in every editor');
      store.save('project', 'Portfolio deploys on Cloudflare');
      const items = await manager.retrieveContextRanked({ deviceId: 'd', query: 'which editor theme do I like dark', includeLongTerm: true });
      assert.ok(items.some((item) => item.content.includes('dark mode')));
      assert.equal(manager.status().retrieval.method, embedder ? 'semantic' : 'lexical');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('duplicates are detected and corrections keep encrypted versions; deletion purges derived data', async () => {
  const { dir, store, manager, index, versions } = setup(fakeEmbedder);
  try {
    const saved = store.save('preference', 'Likes green tea');
    assert.equal(store.save('preference', 'likes GREEN tea!').id, saved.id);
    await assert.rejects(() => manager.proposeChecked('d', 'preference', 'Likes green tea.', { kind: 'feedback' }), DuplicateMemoryError);
    const corrected = manager.correct(saved.id, 'Likes jasmine green tea', saved.updatedAt)!;
    assert.equal(manager.versionsOf(saved.id)[0]?.content, 'Likes green tea');
    assert.throws(() => manager.correct(saved.id, 'Something else', saved.updatedAt), MemoryConflictError);
    await manager.retrieveContextRanked({ deviceId: 'd', query: 'tea', includeLongTerm: true });
    store.delete(saved.id);
    const scrub = manager.scrubDeleted(saved.id, corrected.content);
    assert.equal(scrub.derivedVerified, true);
    assert.equal(index.verifyRemoved(saved.id), true);
    assert.equal(versions.verifyPurged(saved.id), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LAN peers: explicit pairing, signed messages, replay protection, revocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-peers-'));
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const phone: DeviceRecord = { id: 'phone-1', name: 'Phone', publicKey: keys.publicKey, status: DeviceStatus.ACTIVE, permissions: [Permission.SYSTEM_INFO_READ], enrolledAt: 0, lastSeenAt: 0 };
    const devices = new Map([[phone.id, phone]]);
    const registry = new PeerRegistry(join(dir, 'peers.enc'), TOKEN, (id) => devices.get(id));
    const discovery = new PeerDiscoveryService(registry, () => undefined, false);
    const message = (seq: number) => Buffer.from(JSON.stringify(createPeerEnvelope({ from: phone.id, to: 'jarvis-hub', seq, type: 'presence', payload: {}, privateKeyPem: keys.privateKey })));

    // Not paired yet: rejected.
    assert.equal(discovery.handle(message(1), { address: '192.168.1.20' }).type, 'rejected');
    const { code } = registry.startPairing(phone.id, 'owner-device');
    assert.throws(() => registry.confirmPairing(phone, '000000' === code ? '111111' : '000000'));
    registry.confirmPairing(phone, code);

    assert.deepEqual(discovery.handle(message(1), { address: '192.168.1.20' }), { type: 'accepted', deviceId: phone.id, message: 'presence' });
    assert.equal(discovery.handle(message(1), { address: '192.168.1.20' }).type, 'rejected'); // replay
    assert.equal(discovery.handle(message(2), { address: '8.8.8.8' }).type, 'rejected'); // not LAN
    assert.equal(isPrivateLanAddress('10.0.0.5'), true);

    // Revoking the device removes the peer automatically.
    devices.set(phone.id, { ...phone, status: DeviceStatus.REVOKED });
    assert.equal(registry.isPeer(phone.id), false);
    assert.equal(discovery.handle(message(3), { address: '192.168.1.20' }).type, 'rejected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
