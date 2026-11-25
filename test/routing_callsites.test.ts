import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cloudRoutingAllowed } from '../src/ai/providerRouter.js';
import { resolveLocalEmbeddingEndpoint } from '../src/memory/semanticIndex.js';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'companion' ? [] : sources(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

test('E2:D4.7 embeddings use the router local provider: loopback only, same policy in every routing mode', () => {
  for (const mode of ['local-first', 'local-only', 'offline']) {
    assert.equal(resolveLocalEmbeddingEndpoint({ JARVIS_ROUTING_MODE: mode, OLLAMA_URL: 'http://localhost:11434' } as NodeJS.ProcessEnv)?.url, 'http://localhost:11434/api/embed');
    // A remote host is never an embedding target, even if remote inference is opted in.
    assert.equal(resolveLocalEmbeddingEndpoint({ JARVIS_ROUTING_MODE: mode, OLLAMA_URL: 'https://example.com', JARVIS_AI_ALLOW_REMOTE: 'true' } as NodeJS.ProcessEnv), null);
  }
  // The router rejects an invalid local configuration, so embeddings cannot bypass it.
  assert.equal(resolveLocalEmbeddingEndpoint({ OLLAMA_TIMEOUT: '0' } as NodeJS.ProcessEnv), null);
});

test('E2:D4.7 browser speech (possible vendor cloud) is gated on the routing mode', () => {
  assert.equal(cloudRoutingAllowed({} as NodeJS.ProcessEnv), true);
  assert.equal(cloudRoutingAllowed({ JARVIS_ROUTING_MODE: 'local-only' } as NodeJS.ProcessEnv), false);
  assert.equal(cloudRoutingAllowed({ JARVIS_ROUTING_MODE: 'offline' } as NodeJS.ProcessEnv), false);
  assert.equal(cloudRoutingAllowed({ JARVIS_ROUTING_MODE: 'garbage' } as NodeJS.ProcessEnv), false);
});

test('E2:D4.7 model endpoints are only called from the provider client, Ollama client, LLM backends, site gateway and embedder', () => {
  const allowed = new Set(['ai/providerClient.ts', 'ai/ollamaProvider.ts', 'gateway/siteAiGateway.ts', 'memory/semanticIndex.ts', 'ai/providerRouter.ts', 'ai/llmBackends.ts'].map((p) => p.replaceAll('/', '\\')));
  const allowedPosix = new Set([...allowed].map((p) => p.replaceAll('\\', '/')));
  const pattern = /\/api\/chat|\/api\/embed|\/chat\/completions|['"`]\/messages['"`]|\/api\/generate/;
  const offenders = sources('src').filter((file) => {
    const rel = file.slice('src'.length + 1);
    return pattern.test(readFileSync(file, 'utf8').replace(/^\s*(\/\/|\*|\/\*).*$/gm, '')) && !allowed.has(rel) && !allowedPosix.has(rel.replaceAll('\\', '/'));
  });
  assert.deepEqual(offenders, []);
});
