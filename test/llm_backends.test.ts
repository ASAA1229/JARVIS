import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicBackend, GeminiBackend, OllamaBackend, OpenAiBackend } from '../src/ai/llmBackends.js';
import { LlmError, type LlmChunk } from '../src/ai/llmTypes.js';
import { loadBackends } from '../src/ai/providerEnv.js';
import { sendJson, sendSse, startFakeServer } from './helpers/fakeLlm.js';

const signal = () => AbortSignal.timeout(5000);
const messages = [
  { role: 'system' as const, content: 'Be brief.' },
  { role: 'user' as const, content: 'Hi' },
  { role: 'assistant' as const, content: 'Hello' },
  { role: 'user' as const, content: 'Count' },
];

async function collect(stream: AsyncIterable<LlmChunk>): Promise<{ text: string; usage?: LlmChunk['usage'] }> {
  let text = '';
  let usage: LlmChunk['usage'];
  for await (const chunk of stream) {
    if (chunk.text) text += chunk.text;
    if (chunk.usage) usage = chunk.usage;
  }
  return { text, ...(usage ? { usage } : {}) };
}

test('Azure OpenAI: deployment URL, api-version, api-key header, request/response and stream mapping', async () => {
  const server = await startFakeServer((request, res) => {
    const body = JSON.parse(request.body || '{}');
    if (body.stream) {
      sendSse(res, [{ choices: [{ delta: { content: 'Hel' } }] }, { choices: [{ delta: { content: 'lo' } }] }, { choices: [], usage: { prompt_tokens: 12, completion_tokens: 3 } }], true);
    } else if (request.url.includes('/embeddings')) {
      sendJson(res, { data: [{ embedding: [1, 2] }, { embedding: [3, 4] }], usage: { prompt_tokens: 5 } });
    } else {
      sendJson(res, { choices: [{ message: { content: 'azure says hi' } }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
    }
  });
  try {
    const azure = new OpenAiBackend({ id: 'azure-openai', label: 'Azure OpenAI', baseUrl: server.baseUrl, defaultModel: 'my-dep', apiKey: 'azure-key-123', apiVersion: '2024-10-21' });
    const result = await azure.chat('my-dep', messages, { json: true, maxTokens: 50, temperature: 0.1 }, signal());
    assert.deepEqual(result, { text: 'azure says hi', usage: { inputTokens: 20, outputTokens: 4 } });
    const first = server.requests[0]!;
    assert.equal(first.url, '/openai/deployments/my-dep/chat/completions?api-version=2024-10-21');
    assert.equal(first.headers['api-key'], 'azure-key-123');
    assert.equal(first.headers['authorization'], undefined);
    const sent = JSON.parse(first.body);
    assert.equal(sent.model, undefined, 'the deployment in the URL selects the model');
    assert.equal(sent.max_completion_tokens, 50);
    assert.deepEqual(sent.response_format, { type: 'json_object' });
    assert.equal(sent.messages[0].role, 'system');

    const streamed = await collect(azure.stream('my-dep', messages, {}, signal()));
    assert.deepEqual(streamed, { text: 'Hello', usage: { inputTokens: 12, outputTokens: 3 } });
    assert.equal(JSON.parse(server.requests[1]!.body).stream, true);

    const embedded = await azure.embed('emb-dep', ['a', 'b'], signal());
    assert.deepEqual(embedded.vectors, [[1, 2], [3, 4]]);
    assert.match(server.requests[2]!.url, /^\/openai\/deployments\/emb-dep\/embeddings\?api-version=/);
  } finally { await server.close(); }
});

test('OpenAI and local OpenAI-compatible servers: bearer auth, token limit key, developer role folded', async () => {
  const server = await startFakeServer((request, res) => {
    if (request.url === '/models') return sendJson(res, { data: [{ id: 'qwen-local' }, { id: 'bad name!' }] });
    sendJson(res, { choices: [{ message: { content: 'fine' } }] });
  });
  try {
    const openai = new OpenAiBackend({ id: 'openai', label: 'OpenAI', baseUrl: server.baseUrl, defaultModel: 'gpt-4o-mini', apiKey: 'sk-abc' });
    const result = await openai.chat('gpt-4o-mini', [{ role: 'developer', content: 'rules' }, { role: 'user', content: 'x', images: ['data:image/jpeg;base64,AAAA'] }], { maxTokens: 9 }, signal());
    assert.equal(result.text, 'fine');
    assert.equal(result.usage, undefined);
    const sent = JSON.parse(server.requests[0]!.body);
    assert.equal(server.requests[0]!.headers['authorization'], 'Bearer sk-abc');
    assert.equal(sent.max_completion_tokens, 9);
    assert.equal(sent.messages[0].role, 'system');
    assert.deepEqual(sent.messages[1].content[1], { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } });

    const local = new OpenAiBackend({ id: 'local-openai', label: 'LM Studio', baseUrl: server.baseUrl, defaultModel: 'qwen-local' });
    assert.equal(local.local, true);
    assert.equal(local.paid, false);
    await local.chat('qwen-local', messages, { maxTokens: 5 }, signal());
    assert.equal(JSON.parse(server.requests[1]!.body).max_tokens, 5);
    assert.equal(server.requests[1]!.headers['authorization'], undefined);
    assert.deepEqual(await local.listModels(signal()), ['qwen-local']);
  } finally { await server.close(); }
});

test('Anthropic: Messages API request, response and SSE stream mapping', async () => {
  const server = await startFakeServer((request, res) => {
    const body = JSON.parse(request.body);
    if (body.stream) {
      sendSse(res, [
        { type: 'message_start', message: { usage: { input_tokens: 25 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Cla' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ude' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } },
        { type: 'message_stop' },
      ]);
    } else {
      sendJson(res, { content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there' }], usage: { input_tokens: 11, output_tokens: 2 } });
    }
  });
  try {
    const claude = new AnthropicBackend({ baseUrl: server.baseUrl, defaultModel: 'claude-haiku-4-5', apiKey: 'ant-key' });
    const result = await claude.chat('claude-haiku-4-5', messages, { json: true }, signal());
    assert.deepEqual(result, { text: 'Hello there', usage: { inputTokens: 11, outputTokens: 2 } });
    const request = server.requests[0]!;
    assert.equal(request.url, '/messages');
    assert.equal(request.headers['x-api-key'], 'ant-key');
    assert.equal(request.headers['anthropic-version'], '2023-06-01');
    const sent = JSON.parse(request.body);
    assert.match(sent.system, /^Be brief\./);
    assert.match(sent.system, /valid JSON/);
    assert.equal(sent.max_tokens, 1024);
    assert.deepEqual(sent.messages.map((m: { role: string }) => m.role), ['user', 'assistant', 'user']);

    const streamed = await collect(claude.stream('claude-haiku-4-5', messages, {}, signal()));
    assert.deepEqual(streamed, { text: 'Claude', usage: { inputTokens: 25, outputTokens: 7 } });
    await assert.rejects(() => claude.embed(), (error: unknown) => error instanceof LlmError && error.kind === 'unsupported');
  } finally { await server.close(); }
});

test('Gemini: generateContent / streamGenerateContent mapping; the key travels in a header, not the URL', async () => {
  const server = await startFakeServer((request, res) => {
    if (request.url.includes(':streamGenerateContent')) {
      sendSse(res, [
        { candidates: [{ content: { parts: [{ text: 'Gem' }] } }] },
        { candidates: [{ content: { parts: [{ text: 'ini' }] } }], usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 4 } },
      ]);
    } else if (request.url.includes(':batchEmbedContents')) {
      sendJson(res, { embeddings: [{ values: [0.5, 0.25] }] });
    } else if (request.url.includes(':generateContent')) {
      sendJson(res, { candidates: [{ content: { parts: [{ text: 'Hi ' }, { text: 'Gemini' }] } }], usageMetadata: { promptTokenCount: 6, candidatesTokenCount: 2 } });
    } else {
      sendJson(res, { models: [] });
    }
  });
  try {
    const gemini = new GeminiBackend({ baseUrl: server.baseUrl + '/v1beta', defaultModel: 'gemini-2.5-flash', apiKey: 'g-key-777' });
    const result = await gemini.chat('gemini-2.5-flash', messages, { json: true, maxTokens: 33, temperature: 0.3 }, signal());
    assert.deepEqual(result, { text: 'Hi Gemini', usage: { inputTokens: 6, outputTokens: 2 } });
    const request = server.requests[0]!;
    assert.equal(request.url, '/v1beta/models/gemini-2.5-flash:generateContent');
    assert.equal(request.headers['x-goog-api-key'], 'g-key-777');
    assert.ok(!request.url.includes('g-key-777'));
    const sent = JSON.parse(request.body);
    assert.deepEqual(sent.systemInstruction, { parts: [{ text: 'Be brief.' }] });
    assert.deepEqual(sent.contents.map((c: { role: string }) => c.role), ['user', 'model', 'user']);
    assert.deepEqual(sent.generationConfig, { temperature: 0.3, maxOutputTokens: 33, responseMimeType: 'application/json' });

    const streamed = await collect(gemini.stream('gemini-2.5-flash', messages, {}, signal()));
    assert.deepEqual(streamed, { text: 'Gemini', usage: { inputTokens: 9, outputTokens: 4 } });
    assert.equal(server.requests[1]!.url, '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');

    const embedded = await gemini.embed('text-embedding-004', ['x'], signal());
    assert.deepEqual(embedded.vectors, [[0.5, 0.25]]);
    assert.equal((await gemini.health(signal())).ok, true);
  } finally { await server.close(); }
});

test('Ollama: NDJSON stream with usage, json mode, 404 maps to model_missing', async () => {
  const server = await startFakeServer((request, res) => {
    if (request.url === '/api/version') return sendJson(res, { version: '0.5.1' });
    const body = request.body ? JSON.parse(request.body) : {};
    if (request.url === '/api/chat' && body.model === 'ghost') return sendJson(res, { error: 'model not found' }, 404);
    if (request.url === '/api/chat' && body.stream) {
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
      res.write(JSON.stringify({ message: { content: 'Lla' }, done: false }) + '\n');
      res.write(JSON.stringify({ message: { content: 'ma' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { content: '' }, done: true, prompt_eval_count: 8, eval_count: 2 }) + '\n');
      return;
    }
    if (request.url === '/api/chat') return sendJson(res, { message: { content: '{"a":1}' }, prompt_eval_count: 3, eval_count: 5 });
    sendJson(res, { embeddings: [[1, 2, 3]] });
  });
  try {
    const ollama = new OllamaBackend({ baseUrl: server.baseUrl, defaultModel: 'llama3.2:latest', local: true });
    const result = await ollama.chat('llama3.2:latest', messages, { json: true, maxTokens: 20 }, signal());
    assert.deepEqual(result, { text: '{"a":1}', usage: { inputTokens: 3, outputTokens: 5 } });
    const sent = JSON.parse(server.requests[0]!.body);
    assert.equal(sent.format, 'json');
    assert.equal(sent.options.num_predict, 20);
    assert.deepEqual(await collect(ollama.stream('llama3.2:latest', messages, {}, signal())), { text: 'Llama', usage: { inputTokens: 8, outputTokens: 2 } });
    await assert.rejects(() => ollama.chat('ghost', messages, {}, signal()), (error: unknown) => error instanceof LlmError && error.kind === 'model_missing');
    assert.deepEqual((await ollama.embed('nomic-embed-text', ['q'], signal())).vectors, [[1, 2, 3]]);
    const health = await ollama.health(signal());
    assert.equal(health.ok, true);
    assert.equal(health.detail, 'v0.5.1');
  } finally { await server.close(); }
});

test('errors carry a kind and status only: provider bodies never leak', async () => {
  const server = await startFakeServer((request, res) => {
    if (request.url.includes('rate')) return sendJson(res, { error: { message: 'LEAKED-BODY sk-live-secret' } }, 429);
    if (request.url.includes('auth')) return sendJson(res, { error: 'LEAKED-BODY' }, 401);
    sendJson(res, { error: 'LEAKED-BODY' }, 503);
  });
  try {
    const claude = new AnthropicBackend({ baseUrl: server.baseUrl + '/rate', defaultModel: 'm', apiKey: 'k' });
    const auth = new AnthropicBackend({ baseUrl: server.baseUrl + '/auth', defaultModel: 'm', apiKey: 'k' });
    const down = new AnthropicBackend({ baseUrl: server.baseUrl + '/down', defaultModel: 'm', apiKey: 'k' });
    for (const [backend, kind] of [[claude, 'rate_limited'], [auth, 'auth'], [down, 'http_error']] as const) {
      await assert.rejects(() => backend.chat('claude-x', messages, {}, signal()), (error: unknown) => {
        assert.ok(error instanceof LlmError);
        assert.equal(error.kind, kind);
        assert.ok(!/LEAKED|sk-live/.test(String(error.message) + JSON.stringify(error)));
        return true;
      });
    }
    const dead = new AnthropicBackend({ baseUrl: 'http://127.0.0.1:1', defaultModel: 'm', apiKey: 'k' });
    await assert.rejects(() => dead.chat('claude-x', messages, {}, signal()), (error: unknown) => error instanceof LlmError && error.kind === 'network');
  } finally { await server.close(); }
});

test('environment loading: cloud needs https and a key, local needs loopback, nothing configured by default except Ollama', () => {
  assert.deepEqual(loadBackends({}).map((b) => b.id), ['ollama']);
  const env = {
    JARVIS_CLOUD_OPENAI_API_KEY: 'k1',
    JARVIS_CLOUD_AZURE_OPENAI_API_KEY: 'k2', JARVIS_CLOUD_AZURE_OPENAI_ENDPOINT: 'https://example.openai.azure.com', JARVIS_CLOUD_AZURE_OPENAI_DEPLOYMENT: 'dep1',
    JARVIS_CLOUD_ANTHROPIC_API_KEY: 'k3', JARVIS_CLOUD_GEMINI_API_KEY: 'k4',
    JARVIS_LOCAL_OPENAI_BASE_URL: 'http://127.0.0.1:1234/v1',
  };
  const ids = loadBackends(env).map((b) => b.id);
  assert.deepEqual(ids, ['ollama', 'local-openai', 'openai', 'azure-openai', 'anthropic', 'gemini']);
  // insecure or remote-looking endpoints are refused
  assert.deepEqual(loadBackends({ JARVIS_CLOUD_OPENAI_API_KEY: 'k', JARVIS_CLOUD_OPENAI_BASE_URL: 'http://api.example.com/v1' }).map((b) => b.id), ['ollama']);
  assert.deepEqual(loadBackends({ JARVIS_LOCAL_OPENAI_BASE_URL: 'https://example.com/v1' }).map((b) => b.id), ['ollama']);
  assert.deepEqual(loadBackends({ JARVIS_CLOUD_AZURE_OPENAI_API_KEY: 'k', JARVIS_CLOUD_AZURE_OPENAI_ENDPOINT: 'https://x.openai.azure.com' }).map((b) => b.id), ['ollama']);
});
