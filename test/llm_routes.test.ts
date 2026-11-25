import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { after, before, test } from 'node:test';
import { LlmConfigStore } from '../src/ai/llmConfig.js';
import { LlmMetrics } from '../src/ai/llmMetrics.js';
import { LlmOrchestrator } from '../src/ai/llmOrchestrator.js';
import { Permission, type DeviceRecord } from '../src/core/types.js';
import { handleModelRoute, isModelRoute } from '../src/server/modelRoutes.js';
import { FakeBackend } from './helpers/fakeLlm.js';

let server: Server;
let base = '';
let totpEnabled = false;
const audits: Array<{ type: string; details: unknown }> = [];
const local = new FakeBackend('ollama', true, false, 'llama3.2:latest');
const cloud = new FakeBackend('openai', false, true, 'gpt-4o-mini');
Object.assign(cloud, { apiKey: 'sk-route-secret' });
const orchestrator = new LlmOrchestrator({
  backends: () => [local, cloud], config: new LlmConfigStore(null), metrics: new LlmMetrics(null), env: () => ({}),
});

const ownerDevice = { id: 'owner-device', permissions: [Permission.DEVICE_MANAGE] } as unknown as DeviceRecord;
const readerDevice = { id: 'reader-device', permissions: [Permission.SYSTEM_INFO_READ] } as unknown as DeviceRecord;

before(async () => {
  const jarvis = {
    audit: { record: (type: string, details: unknown) => { audits.push({ type, details }); } },
    deviceSecurity: { getTotpStatus: () => (totpEnabled ? 'ENABLED' : 'DISABLED'), verifyStepUp: (_device: unknown, code: string) => code === '123456' },
  };
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!isModelRoute(url.pathname)) { res.writeHead(404); res.end(); return; }
    await handleModelRoute(req, res, url, {
      jarvis: jarvis as never,
      orchestrator,
      readJsonBody: async (request) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk as Buffer); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); },
      authorize: (request) => {
        const session = request.headers['x-session-id'];
        if (session === 'owner') return { valid: true, device: ownerDevice };
        if (session === 'reader') return { valid: true, device: readerDevice };
        return { valid: false, error: 'bad session' };
      },
      json: (response, status, data) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)); },
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });

function call(method: string, path: string, session: string | null, body?: unknown): Promise<Response> {
  return fetch(base + path, { method, headers: { ...(session ? { 'x-session-id': session } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

test('routes are owner-session only', async () => {
  for (const path of ['/api/llm/status', '/api/llm/catalog', '/api/llm/config', '/api/llm/metrics']) {
    assert.equal((await call('GET', path, null)).status, 401, path + ' without a session');
    assert.equal((await call('GET', path, 'nobody')).status, 401, path + ' with an invalid session');
    assert.equal((await call('GET', path, 'reader')).status, 403, path + ' without DEVICE_MANAGE');
    assert.equal((await call('GET', path, 'owner')).status, 200, path + ' as owner');
  }
  assert.equal((await call('POST', '/api/llm/test', 'reader', { provider: 'ollama', prompt: 'hi' })).status, 403);
  assert.equal((await call('POST', '/api/llm/config', 'reader', { config: {} })).status, 403);
});

test('status, catalog and config never include API keys', async () => {
  const text = [await (await call('GET', '/api/llm/status', 'owner')).text(), await (await call('GET', '/api/llm/catalog', 'owner')).text(), await (await call('GET', '/api/llm/config', 'owner')).text()].join('\n');
  assert.ok(!/sk-route-secret/.test(text));
  const status = JSON.parse(await (await call('GET', '/api/llm/status', 'owner')).text());
  assert.equal(status.providers.find((p: { id: string }) => p.id === 'openai').configured, true);
  assert.equal(status.budget.monthlyBudgetUsd, 0);
});

test('config update: non-escalating edits save directly; escalations need a fresh authenticator code when TOTP is enabled', async () => {
  const rules = (await (await call('GET', '/api/llm/config', 'owner')).json() as { config: { rules: Record<string, unknown> } }).config.rules;
  assert.ok(rules['code']);
  totpEnabled = true;
  const rule = await call('POST', '/api/llm/config', 'owner', { config: { rules: { chat: { preferModels: ['gemma'] } } } });
  assert.equal(rule.status, 200, 'editing rules is not an escalation');
  assert.equal((await rule.json() as { escalation: boolean }).escalation, false);

  const enable = { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } } };
  assert.equal((await call('POST', '/api/llm/config', 'owner', enable)).status, 401);
  assert.equal((await call('POST', '/api/llm/config', 'owner', { ...enable, totpCode: '000000' })).status, 401);
  assert.equal(orchestrator.config.get().cloud.globalAuthorized, false, 'rejected update changed nothing');
  const ok = await call('POST', '/api/llm/config', 'owner', { ...enable, totpCode: '123456' });
  assert.equal(ok.status, 200);
  assert.equal(orchestrator.config.get().cloud.monthlyBudgetUsd, 5);
  assert.ok(audits.some((entry) => entry.type === 'LLM_ROUTING_CONFIG_UPDATED' && (entry.details as { escalation: boolean }).escalation));

  // tightening needs no code
  const tighten = await call('POST', '/api/llm/config', 'owner', { config: { cloud: { globalAuthorized: false, monthlyBudgetUsd: 1 } } });
  assert.equal(tighten.status, 200);

  // invalid input is rejected with details and changes nothing
  const bad = await call('POST', '/api/llm/config', 'owner', { config: { cloud: { monthlyBudgetUsd: -5 } } });
  assert.equal(bad.status, 400);
  assert.ok((await bad.json() as { details: string[] }).details.length > 0);
  totpEnabled = false;
});

test('test route: local works; a paid provider is refused until authorized; prompt is validated and not stored', async () => {
  const good = await call('POST', '/api/llm/test', 'owner', { provider: 'ollama', prompt: 'PROMPT-NOT-STORED' });
  const body = await good.json() as { ok: boolean; provider: string; text: string };
  assert.equal(body.ok, true);
  assert.equal(body.provider, 'ollama');

  const refused = await (await call('POST', '/api/llm/test', 'owner', { provider: 'openai', prompt: 'hi' })).json() as { ok: boolean; code: string; skipped: Array<{ reason: string }> };
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'no_eligible_provider');
  assert.ok(refused.skipped.length > 0);
  assert.equal(cloud.calls.length, 0);

  assert.equal((await call('POST', '/api/llm/test', 'owner', { provider: 'bogus', prompt: 'hi' })).status, 400);
  assert.equal((await call('POST', '/api/llm/test', 'owner', { provider: 'ollama', prompt: '' })).status, 400);
  assert.equal((await call('POST', '/api/llm/test', 'owner', { provider: 'ollama', prompt: 'x'.repeat(501) })).status, 400);
  assert.equal((await call('POST', '/api/llm/test', 'owner', { provider: 'ollama', model: 'bad model!', prompt: 'hi' })).status, 400);

  const metrics = await (await call('GET', '/api/llm/metrics', 'owner')).text();
  assert.ok(!/PROMPT-NOT-STORED/.test(metrics));
  assert.ok(JSON.parse(metrics).summaries.some((s: { provider: string }) => s.provider === 'ollama'));
});

test('health route runs checks and returns status', async () => {
  const response = await call('POST', '/api/llm/health', 'owner', {});
  const body = await response.json() as { results: Record<string, { ok: boolean }>; status: { providers: Array<{ id: string; health?: { ok: boolean } }> } };
  assert.equal(body.results['ollama']!.ok, true);
  assert.equal(body.status.providers.find((p) => p.id === 'ollama')!.health!.ok, true);
  assert.equal((await call('POST', '/api/llm/health', 'owner', { provider: 'nope' })).status, 400);
});
