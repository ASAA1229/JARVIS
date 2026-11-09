import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { SiteAiGateway, type ModelEndpoint } from '../src/gateway/siteAiGateway.js';
import { SiteClientStore } from '../src/gateway/siteClientStore.js';

const endpoint: ModelEndpoint = { baseUrl: 'http://model.test/v1', model: 'local-test-model' };

function sse(events: unknown[]): Response {
  const body = events.map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('');
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

describe('JARVIS site AI gateway', () => {
  let dir: string;
  let store: SiteClientStore;
  let audit: AuditLogger;
  let gateway: SiteAiGateway;
  let base: string;
  let key: string;
  let upstreamCalls: Array<{ url: string; body: Record<string, unknown> }>;
  let upstream: (body: Record<string, unknown>) => Response | Promise<Response>;
  let model: ModelEndpoint | null;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-gateway-'));
    store = new SiteClientStore(join(dir, 'site-clients.json'));
    audit = new AuditLogger(join(dir, 'audit.log'));
    key = store.create('portfolio', { requestsPerMinute: 10, maxOutputTokens: 300 }).apiKey;
    upstreamCalls = [];
    model = endpoint;
    upstream = () => Response.json({ choices: [{ message: { role: 'assistant', content: 'Hello from JARVIS' }, finish_reason: 'stop' }] });
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamCalls.push({ url: String(url), body });
      return upstream(body);
    }) as typeof fetch;
    gateway = new SiteAiGateway({ store, audit, modelEndpoint: () => model, fetchImpl: fakeFetch, keepAliveMs: 20, firstTokenTimeoutMs: 400, idleTimeoutMs: 150 });
    base = `http://127.0.0.1:${await gateway.start(0)}`;
  });

  afterEach(async () => {
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const chat = (body: unknown, token: string | null = key) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const hello = { messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: 'Hi' }] };

  test('health is public and reveals no configuration values', async () => {
    const response = await fetch(`${base}/v1/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', modelConfigured: true });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });

  test('requests without a valid, active key are rejected and audited without the key', async () => {
    assert.equal((await chat(hello, null)).status, 401);
    assert.equal((await chat(hello, key.slice(0, -1) + (key.endsWith('A') ? 'B' : 'A'))).status, 401);
    assert.equal((await chat(hello, 'sk-not-a-jarvis-key')).status, 401);
    store.revoke('portfolio');
    const revoked = await chat(hello);
    assert.equal(revoked.status, 401);
    assert.equal(revoked.headers.get('www-authenticate'), 'Bearer');
    assert.equal(upstreamCalls.length, 0);
    const log = readFileSync(join(dir, 'audit.log'), 'utf8');
    assert.equal(log.includes(key), false);
    assert.equal(audit.getRecords().filter((record) => record.eventType === 'SITE_AI_AUTH_FAILED').length, 4);
  });

  test('a non-streaming completion is returned in OpenAI format under the public model id', async () => {
    const response = await chat({ ...hello, model: 'gpt-4.1-mini', max_tokens: 5000, temperature: 0.3 });
    assert.equal(response.status, 200);
    const payload = await response.json() as { model: string; object: string; choices: Array<{ message: { content: string } }> };
    assert.equal(payload.object, 'chat.completion');
    assert.equal(payload.model, 'jarvis');
    assert.equal(payload.choices[0]?.message.content, 'Hello from JARVIS');
    // The site's model name is ignored, max_tokens is capped by the client limit.
    assert.equal(upstreamCalls[0]?.url, 'http://model.test/v1/chat/completions');
    assert.equal(upstreamCalls[0]?.body['model'], 'local-test-model');
    assert.equal(upstreamCalls[0]?.body['max_tokens'], 300);
    assert.equal(upstreamCalls[0]?.body['temperature'], 0.3);
    assert.deepEqual(upstreamCalls[0]?.body['messages'], hello.messages);
  });

  test('tools, functions and other unsupported parameters are refused before the model is called', async () => {
    for (const extra of [{ tools: [] }, { functions: [] }, { response_format: { type: 'json_object' } }]) {
      const response = await chat({ ...hello, ...extra });
      assert.equal(response.status, 400);
    }
    assert.equal((await chat({ messages: [{ role: 'tool', content: 'x' }] })).status, 400);
    assert.equal((await chat({ messages: [{ role: 'system', content: 'only system' }] })).status, 400);
    assert.equal(upstreamCalls.length, 0);
  });

  test('streaming relays only assistant text deltas and terminates with [DONE]', async () => {
    upstream = () => sse([
      { id: 'provider-id', model: 'secret-model-name', system_fingerprint: 'fp', choices: [{ delta: { role: 'assistant' } }] },
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      '[DONE]',
    ]);
    const response = await chat({ ...hello, stream: true });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/);
    const text = await response.text();
    assert.equal(text.includes('secret-model-name'), false);
    assert.equal(text.includes('system_fingerprint'), false);
    const events = text.split('\n\n').filter(Boolean);
    assert.equal(events.at(-1), 'data: [DONE]');
    const content = events.slice(0, -1).map((event) => JSON.parse(event.slice(6)) as { model: string; choices: Array<{ delta: { content?: string } }> });
    assert.equal(content.map((event) => event.choices[0]?.delta.content ?? '').join(''), 'Hello');
    assert.ok(content.every((event) => event.model === 'jarvis'));
  });

  test('per-site rate limit returns 429 with Retry-After', async () => {
    for (let i = 0; i < 10; i++) assert.equal((await chat(hello)).status, 200);
    const limited = await chat(hello);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal(upstreamCalls.length, 10);
  });

  test('model outages are reported honestly', async () => {
    model = null;
    assert.equal((await chat(hello)).status, 503);
    model = endpoint;
    upstream = () => { throw new TypeError('fetch failed'); };
    const unreachable = await chat(hello);
    assert.equal(unreachable.status, 503);
    assert.match((await unreachable.json() as { error: { message: string } }).error.message, /not reachable/);
    upstream = () => new Response('model "x" not found', { status: 404 });
    assert.equal((await chat(hello)).status, 503);
  });

  test('audit records request metadata only, never prompts or generated text', async () => {
    await chat({ messages: [{ role: 'user', content: 'my private question about salary' }] });
    const records = audit.getRecords().filter((record) => record.eventType === 'SITE_AI_REQUEST');
    assert.equal(records.length, 1);
    assert.equal(records[0]?.details['site'], 'portfolio');
    assert.equal(records[0]?.details['status'], 200);
    const log = readFileSync(join(dir, 'audit.log'), 'utf8');
    assert.equal(log.includes('private question'), false);
    assert.equal(log.includes('Hello from JARVIS'), false);
    assert.equal(audit.verifyIntegrity().valid, true);
  });

  test('keys are stored only as hashes and survive a reload', () => {
    const file = readFileSync(join(dir, 'site-clients.json'), 'utf8');
    assert.equal(file.includes(key), false);
    const reloaded = new SiteClientStore(join(dir, 'site-clients.json'));
    assert.equal(reloaded.authenticate(key)?.name, 'portfolio');
    assert.throws(() => reloaded.create('portfolio'), /already exists/);
    assert.throws(() => reloaded.create('Bad Name!'), /lowercase/);
  });

  test('streaming reports a model outage as an in-stream error event after early headers', async () => {
    upstream = () => { throw new TypeError('fetch failed'); };
    const response = await chat({ ...hello, stream: true });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /"error":\{"message":"The JARVIS model is not reachable/);
    assert.ok(text.trimEnd().endsWith('data: [DONE]'));
    const record = audit.getRecords().filter((r) => r.eventType === 'SITE_AI_REQUEST').at(-1);
    assert.equal(record?.details['status'], 503);
    assert.equal(record?.details['turnCount'], 2);
  });

  test('streaming sends keep-alives while the model is slow, then relays the answer', async () => {
    upstream = () => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        async start(controller) {
          await new Promise((resolve) => setTimeout(resolve, 120));
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"slow but ok"}}]}\n\n'));
          controller.close();
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const text = await (await chat({ ...hello, stream: true })).text();
    assert.match(text, /: keep-alive/);
    assert.match(text, /slow but ok/);
  });

  test('streaming ends with an error event when the model stalls mid-answer', async () => {
    upstream = () => {
      const encoder = new TextEncoder();
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));
          // never closes: the idle timeout must end the response
        },
      }), { headers: { 'Content-Type': 'text/event-stream' } });
    };
    const text = await (await chat({ ...hello, stream: true })).text();
    assert.match(text, /partial/);
    assert.match(text, /stopped responding mid-answer/);
    const record = audit.getRecords().filter((r) => r.eventType === 'SITE_AI_REQUEST').at(-1);
    assert.equal(record?.details['status'], 504);
  });
});
