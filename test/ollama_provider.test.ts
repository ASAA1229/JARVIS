import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OllamaProvider } from '../src/ai/ollamaProvider.js';
import { AIProviderError } from '../src/ai/aiProvider.js';
import { chatCompletion } from '../src/ai/providerClient.js';

test('uses native Ollama /api/chat and maps JSON mode and developer messages', async () => {
  let capturedUrl = '';
  let capturedBody: Record<string, unknown> = {};
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
    timeoutMs: 120_000,
  }, async (input, init) => {
    capturedUrl = String(input);
    capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message: { content: '{"answer":"hello"}' } });
  });

  const result = await provider.chat([
    { role: 'developer', content: 'Use JSON.' },
    { role: 'user', content: 'Hello' },
  ], { temperature: 0.2, json: true });

  assert.equal(result, '{"answer":"hello"}');
  assert.equal(capturedUrl, 'http://localhost:11434/api/chat');
  assert.equal(capturedBody.model, 'llama3.2:latest');
  assert.equal(capturedBody.stream, false);
  assert.equal(capturedBody.format, 'json');
  assert.deepEqual(capturedBody.messages, [
    { role: 'system', content: 'Use JSON.' },
    { role: 'user', content: 'Hello' },
  ]);
});

test('checks Ollama health and installed model availability', async () => {
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
    embeddingModel: 'nomic-embed-text',
  }, async () => Response.json({
    models: [{ name: 'llama3.2:latest' }, { name: 'nomic-embed-text:latest' }],
    version: '0.5.0',
  }));

  assert.deepEqual(await provider.healthCheck(), {
    available: true,
    modelAvailable: true,
    model: 'llama3.2:latest',
    version: '0.5.0',
    embeddingModel: 'nomic-embed-text',
    embeddingModelAvailable: true,
  });
});

test('reports a missing configured model without claiming Ollama is offline', async () => {
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
  }, async () => Response.json({ models: [{ name: 'other:latest' }] }));

  assert.deepEqual(await provider.healthCheck(), {
    available: true,
    modelAvailable: false,
    model: 'llama3.2:latest',
  });
});

test('rejects unsafe or malformed Ollama base URLs', () => {
  assert.throws(() => new OllamaProvider({
    baseUrl: 'http://user:pass@localhost:11434',
    model: 'llama3.2:latest',
  }), /base URL/);
});

test('retries a transient Ollama gateway response once', async () => {
  let calls = 0;
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
  }, async () => {
    calls += 1;
    return calls === 1
      ? new Response('', { status: 503 })
      : Response.json({ message: { content: 'recovered' } });
  });
  assert.equal(await provider.chat([{ role: 'user', content: 'Hello' }]), 'recovered');
  assert.equal(calls, 2);
});

test('streams newline-delimited Ollama chat chunks', async () => {
  const body = [
    JSON.stringify({ message: { content: 'Hello' }, done: false }),
    JSON.stringify({ message: { content: ' there' }, done: false }),
    JSON.stringify({ message: { content: '' }, done: true }),
  ].join('\n') + '\n';
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
  }, async () => new Response(body, { status: 200 }));
  const chunks: string[] = [];
  for await (const chunk of provider.stream([{ role: 'user', content: 'Hello' }])) chunks.push(chunk);
  assert.deepEqual(chunks, ['Hello', ' there']);
});

test('rejects oversized non-streaming responses before JSON parsing', async () => {
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
  }, async () => new Response('x'.repeat(300 * 1024)));
  await assert.rejects(
    () => provider.chat([{ role: 'user', content: 'Hello' }]),
    (error: unknown) => error instanceof AIProviderError && error.kind === 'invalid_response',
  );
});

test('stream requires an explicit Ollama done event', async () => {
  const body = JSON.stringify({ message: { content: 'partial' }, done: false }) + '\n';
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
  }, async () => new Response(body, { status: 200 }));
  await assert.rejects(async () => {
    for await (const _chunk of provider.stream([{ role: 'user', content: 'Hello' }])) { /* consume */ }
  }, (error: unknown) => error instanceof AIProviderError && error.kind === 'invalid_response');
});

test('classifies Ollama rate limits in streaming mode', async () => {
  const provider = new OllamaProvider({
    baseUrl: 'http://localhost:11434',
    model: 'llama3.2:latest',
  }, async () => new Response('', { status: 429 }));
  await assert.rejects(async () => {
    for await (const _chunk of provider.stream([{ role: 'user', content: 'Hello' }])) { /* consume */ }
  }, (error: unknown) => error instanceof AIProviderError && error.kind === 'rate_limited' && error.status === 429);
});

test('shared provider client sends first-party Ollama requests to native /api/chat', async () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = '';
  let requestBody: Record<string, unknown> = {};
  globalThis.fetch = async (input, init) => {
    requestedUrl = String(input);
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ message: { content: 'native response' } });
  };
  try {
    const result = await chatCompletion({
      id: 'local',
      format: 'ollama',
      baseUrl: 'http://localhost:11434',
      model: 'llama3.2:latest',
      local: true,
      cost: 'free',
      timeoutMs: 5000,
    }, [{ role: 'user', content: 'Hello' }], { temperature: 0.1 }, AbortSignal.timeout(5000));
    assert.equal(result, 'native response');
    assert.equal(requestedUrl, 'http://localhost:11434/api/chat');
    assert.equal(requestBody.model, 'llama3.2:latest');
    assert.equal(requestBody.stream, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
