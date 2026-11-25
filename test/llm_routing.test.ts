import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CircuitBreaker } from '../src/ai/circuitBreaker.js';
import { OllamaBackend } from '../src/ai/llmBackends.js';
import { LlmConfigStore, validateConfig } from '../src/ai/llmConfig.js';
import { LlmMetrics } from '../src/ai/llmMetrics.js';
import { legacyTaskToLlm, LlmOrchestrator, LlmRoutingError, type LlmRequest } from '../src/ai/llmOrchestrator.js';
import { ProviderRouter, providerRouter, loadProviders, cloudAllowedTasks, routingMode, ProviderRouter as PR2 } from '../src/ai/providerRouter.js';
import { OllamaProvider } from '../src/ai/ollamaProvider.js';
import type { LlmBackend, LlmChunk } from '../src/ai/llmTypes.js';
import { FakeBackend } from './helpers/fakeLlm.js';

const TAGS = { models: [
  { name: 'qwen2.5-coder:7b', details: { parameter_size: '7.6B' } },
  { name: 'llama3.2:3b', details: { parameter_size: '3.2B' } },
  { name: 'gemma2:9b', details: { parameter_size: '9.2B' } },
  { name: 'nomic-embed-text:latest', details: { parameter_size: '137M' } },
  { name: 'llava:7b', details: { parameter_size: '7B' } },
  { name: 'deepseek-r1:14b', details: { parameter_size: '14.8B' } },
  { name: 'mistral:7b', details: { parameter_size: '7.2B' } },
] };

/** Ollama backend over an in-memory fetch: serves the catalog and chat. */
function ollamaWithCatalog(chat: (model: string) => Response | Promise<Response> = () => new Response(JSON.stringify({ message: { content: 'ok' }, prompt_eval_count: 5, eval_count: 5 }))): OllamaBackend {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify(TAGS));
    if (url.endsWith('/api/show')) return new Response(JSON.stringify({ details: {}, capabilities: undefined }));
    if (url.endsWith('/api/chat')) return chat(JSON.parse(String(init?.body)).model);
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return new OllamaBackend({ baseUrl: 'http://127.0.0.1:11434', defaultModel: 'llama3.2:3b', local: true, fetchImpl });
}

function orchestrator(backends: LlmBackend[], options: { config?: Parameters<typeof validateConfig>[0]; env?: Record<string, string>; now?: () => number } = {}) {
  const store = new LlmConfigStore(null);
  if (options.config) store.set(validateConfig(options.config, store.get()).config);
  const metrics = new LlmMetrics(null, options.now);
  const llm = new LlmOrchestrator({ backends: () => backends, config: store, metrics, env: () => options.env ?? {}, ...(options.now ? { now: options.now } : {}) });
  return { llm, store, metrics };
}

const msg = (content = 'hello') => [{ role: 'user' as const, content }];
const req = (task: LlmRequest['task'], extra: Partial<LlmRequest> = {}): LlmRequest => ({ task, messages: msg(), containsPrivateData: false, ...extra });
const cloudBackends = () => [
  new FakeBackend('openai', false, true, 'gpt-4o-mini'),
  new FakeBackend('anthropic', false, true, 'claude-haiku-4-5'),
  new FakeBackend('gemini', false, true, 'gemini-2.5-flash'),
];

test('task routing: each task picks the right local model from the catalog', async () => {
  const { llm } = orchestrator([ollamaWithCatalog()]);
  const first = async (task: LlmRequest['task']) => (await llm.plan(req(task))).candidates[0]!.model;
  assert.equal(await first('code'), 'qwen2.5-coder:7b');
  assert.equal(await first('embed'), 'nomic-embed-text:latest');
  assert.equal(await first('vision'), 'llava:7b');
  assert.equal(await first('reasoning'), 'deepseek-r1:14b');
  assert.equal(await first('extract'), 'llama3.2:3b', 'smallest chat-capable model, never an embedding model');
  assert.equal(await first('chat'), 'llama3.2:3b');
  assert.equal(await first('summarize'), 'llama3.2:3b');
  const embedPlan = await llm.plan(req('embed'));
  assert.ok(embedPlan.candidates.every((c) => /embed/.test(c.model)));
  const chatPlan = await llm.plan(req('chat'));
  assert.ok(chatPlan.candidates.every((c) => !/embed/.test(c.model)), 'embedding-only models are never used for chat');
  assert.ok(chatPlan.candidates.every((c) => c.local && !c.paid && c.estCostUsd === 0));
});

test('task routing follows the owner-editable rules', async () => {
  const { llm } = orchestrator([ollamaWithCatalog()], { config: { rules: { code: { preferModels: ['mistral'] }, extract: { sizeBias: 'large', preferModels: ['gemma'], maxLocalSizeBillions: null } } } });
  assert.equal((await llm.plan(req('code'))).candidates[0]!.model, 'mistral:7b');
  assert.equal((await llm.plan(req('extract'))).candidates[0]!.model, 'gemma2:9b');
});

test('when no catalog is available the configured default model is attempted', async () => {
  const dead = new OllamaBackend({ baseUrl: 'http://127.0.0.1:11434', defaultModel: 'llama3.2:latest', local: true, fetchImpl: (async () => { throw new Error('down'); }) as typeof fetch });
  const { llm } = orchestrator([dead]);
  assert.deepEqual((await llm.plan(req('chat'))).candidates.map((c) => c.model), ['llama3.2:latest']);
});

test('private data is never sent to cloud, even when cloud is fully authorized and funded', async () => {
  const cloud = cloudBackends();
  const local = new FakeBackend('ollama', true, false, 'llama3.2:latest');
  local.failWith = 'network';
  const { llm } = orchestrator([local, ...cloud], { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 100, perRequestMaxUsd: 10 } } });
  const plan = await llm.plan(req('chat', { containsPrivateData: true, cloudAuthorized: true }));
  assert.ok(plan.candidates.every((c) => c.local));
  assert.ok(plan.skipped.filter((s) => !['ollama'].includes(s.provider)).every((s) => /private/.test(s.reason)));
  await assert.rejects(() => llm.chat(req('chat', { containsPrivateData: true, cloudAuthorized: true })), LlmRoutingError);
  assert.ok(cloud.every((backend) => backend.calls.length === 0), 'no cloud backend was ever called');
  // a missing or malformed privacy flag fails closed
  for (const flag of [undefined, null, 'false', 0]) {
    const unsure = await llm.plan({ task: 'chat', messages: msg(), containsPrivateData: flag as unknown as boolean, cloudAuthorized: true });
    assert.ok(unsure.candidates.every((c) => c.local), `flag ${String(flag)} must be treated as private`);
  }
});

test('private data also never goes to a remote (non-loopback) Ollama', async () => {
  const remote = new OllamaBackend({ baseUrl: 'https://ollama.example.com', defaultModel: 'llama3.2', local: false, fetchImpl: (async () => new Response('{}')) as typeof fetch });
  const { llm } = orchestrator([remote], { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } } });
  assert.equal((await llm.plan(req('chat', { containsPrivateData: true }))).candidates.length, 0);
  assert.equal((await llm.plan(req('chat'))).candidates.length, 1, 'non-private, authorized: allowed (free, but off-machine)');
});

test('a paid provider is blocked without authorization and with a zero budget; allowed when authorized within budget', async () => {
  const cloud = cloudBackends();
  const none = orchestrator(cloud);
  const blocked = await none.llm.plan(req('chat'));
  assert.equal(blocked.candidates.length, 0);
  assert.ok(blocked.skipped.every((s) => /not authorized/.test(s.reason)));

  // per-request authorization alone does not spend money while the budget is 0
  const zero = await none.llm.plan(req('chat', { cloudAuthorized: true }));
  assert.equal(zero.candidates.length, 0);
  assert.ok(zero.skipped.every((s) => /budget is 0/.test(s.reason)));

  // per-task authorization from the owner config
  const perTask = orchestrator(cloud, { config: { cloud: { authorizedTasks: ['chat'], monthlyBudgetUsd: 5 } } });
  assert.ok((await perTask.llm.plan(req('chat'))).candidates.length > 0);
  assert.equal((await perTask.llm.plan(req('code'))).candidates.length, 0, 'other tasks stay blocked');

  // global authorization
  const global = orchestrator(cloud, { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } } });
  assert.ok((await global.llm.plan(req('code'))).candidates.length > 0);

  // legacy environment allowlist still works (with a budget)
  const legacy = orchestrator(cloud, { env: { JARVIS_CLOUD_ALLOWED_TASKS: 'conversation' }, config: { cloud: { monthlyBudgetUsd: 5 } } });
  assert.ok((await legacy.llm.plan(req('chat'))).candidates.length > 0);

  // routing modes forbid cloud entirely
  const localOnly = orchestrator(cloud, { env: { JARVIS_ROUTING_MODE: 'local-only' }, config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } } });
  assert.equal((await localOnly.llm.plan(req('chat'))).candidates.length, 0);
});

test('the monthly budget is a hard stop and spend is recorded', async () => {
  const cloud = cloudBackends();
  const openai = cloud[0]!;
  openai.usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }; // 0.15 + 0.60 = $0.75 per call at default prices
  const { llm, metrics } = orchestrator([openai], { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 1, perRequestMaxUsd: 1 } } });
  const first = await llm.chat(req('chat', { options: { maxTokens: 100 } }));
  assert.equal(first.provider, 'openai');
  assert.equal(first.costUsd, 0.75);
  assert.equal(metrics.spentThisMonth(), 0.75);
  // $0.75 spent of $1: a call whose estimate would cross the cap is refused
  const big = req('chat', { messages: msg('x'.repeat(4_000_000)), options: { maxTokens: 10 } }); // ~1M input tokens ~ $0.15 -> total 0.90 ok
  assert.ok((await llm.plan(big)).candidates.length > 0);
  const bigger = req('chat', { messages: msg('x'.repeat(8_000_000)), options: { maxTokens: 10 } }); // ~2M tokens ~ $0.30 -> 1.05 > 1
  const refused = await llm.plan(bigger);
  assert.equal(refused.candidates.length, 0);
  assert.match(refused.skipped[0]!.reason, /budget would be exceeded/);
  await assert.rejects(() => llm.chat(bigger), (error: unknown) => error instanceof LlmRoutingError && error.code === 'no_eligible_provider');
  assert.equal(openai.calls.length, 1, 'the refused request never reached the provider');
  // per-request ceiling
  const tight = orchestrator([openai], { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 100, perRequestMaxUsd: 0.0001 } } });
  assert.match((await tight.llm.plan(req('chat', { options: { maxTokens: 4000 } }))).skipped[0]!.reason, /per-request/);
});

test('cheapest adequate cloud model is chosen first', async () => {
  const cloud = cloudBackends();
  const { llm } = orchestrator(cloud, { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 50, perRequestMaxUsd: 5 }, cloudModels: { anthropic: ['claude-opus-4-5'], openai: ['gpt-4o'] } } });
  // chat needs only "small": cheapest first
  const chat = (await llm.plan(req('chat'))).candidates.map((c) => c.model);
  assert.equal(chat[0], 'gpt-4o-mini');
  assert.equal(chat[1], 'gemini-2.5-flash');
  // code needs "medium": the small models drop out
  const code = (await llm.plan(req('code'))).candidates.map((c) => c.model);
  assert.ok(!code.includes('gpt-4o-mini') && !code.includes('gemini-2.5-flash'));
  assert.equal(code[0], 'gpt-4o');
  // reasoning needs "large": only opus qualifies
  assert.deepEqual((await llm.plan(req('reasoning'))).candidates.map((c) => c.model), ['claude-opus-4-5']);
  // embeddings use an embedding model, never a chat model
  const embed = await llm.plan(req('embed'));
  assert.equal(embed.candidates.length, 0);
});

test('fallback chain: a failing local provider falls through to the next local provider and records it', async () => {
  const a = new FakeBackend('ollama', true, false, 'llama3.2:latest');
  const b = new FakeBackend('local-openai', true, false, 'lmstudio-model');
  a.failWith = 'network';
  const { llm, metrics } = orchestrator([a, b]);
  const result = await llm.chat(req('chat'));
  assert.equal(result.provider, 'local-openai');
  assert.equal(result.fellBack, true);
  assert.deepEqual(result.attempts.map((x) => [x.provider, x.ok, x.error]), [['ollama', false, 'network'], ['local-openai', true, undefined]]);
  assert.equal(metrics.fallbackCounts()['local-openai'], 1);
  const summary = metrics.summaries().find((s) => s.provider === 'ollama')!;
  assert.equal(summary.errorRate, 1);
});

test('fallback never moves from local to paid cloud without authorization', async () => {
  const local = new FakeBackend('ollama', true, false, 'llama3.2:latest');
  local.failWith = 'timeout';
  const cloud = cloudBackends();
  const { llm } = orchestrator([local, ...cloud]);
  await assert.rejects(() => llm.chat(req('chat')), (error: unknown) => error instanceof LlmRoutingError && error.code === 'all_providers_failed');
  assert.ok(cloud.every((backend) => backend.calls.length === 0));
});

test('with authorization and budget, fallback reaches paid cloud and charges for it', async () => {
  const local = new FakeBackend('ollama', true, false, 'llama3.2:latest');
  local.failWith = 'http_error';
  const cloud = cloudBackends();
  cloud[0]!.usage = { inputTokens: 1000, outputTokens: 1000 };
  const { llm, metrics } = orchestrator([local, ...cloud], { config: { cloud: { authorizedTasks: ['chat'], monthlyBudgetUsd: 5 } } });
  const result = await llm.chat(req('chat'));
  assert.equal(result.provider, 'openai');
  assert.equal(result.fellBack, true);
  assert.ok(result.costUsd > 0);
  assert.equal(metrics.ledger().byProvider['openai'], result.costUsd);
});

test('model_missing moves to the next candidate without tripping the provider breaker', async () => {
  const a = new FakeBackend('ollama', true, false, 'ghost');
  const b = new FakeBackend('local-openai', true, false, 'real');
  a.failWith = 'model_missing';
  const { llm } = orchestrator([a, b], { config: { breaker: { failureThreshold: 1, openSeconds: 60 } } });
  assert.equal((await llm.chat(req('chat'))).provider, 'local-openai');
  assert.equal(llm.status().providers.find((p) => p.id === 'ollama')!.breaker!.state, 'closed');
  assert.equal((await llm.chat(req('chat'))).attempts[0]!.provider, 'ollama', 'still tried again');
});

test('circuit breaker: opens after repeated failures, skips the provider, half-opens after the cooldown', () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 3, openMs: 10_000 }, () => now);
  assert.equal(breaker.canAttempt(), true);
  breaker.recordFailure(); breaker.recordFailure();
  assert.equal(breaker.state(), 'closed');
  breaker.recordFailure();
  assert.equal(breaker.state(), 'open');
  assert.equal(breaker.canAttempt(), false);
  assert.equal(breaker.snapshot().retryInSeconds, 10);
  now = 10_000;
  assert.equal(breaker.state(), 'half-open');
  assert.equal(breaker.canAttempt(), true, 'one probe');
  assert.equal(breaker.canAttempt(), false, 'only one probe at a time');
  breaker.recordFailure(); // probe failed: re-open immediately
  assert.equal(breaker.state(), 'open');
  now = 20_000;
  assert.equal(breaker.canAttempt(), true);
  breaker.recordSuccess();
  assert.equal(breaker.state(), 'closed');
  assert.equal(breaker.snapshot().consecutiveFailures, 0);
});

test('orchestrator breaker: an open provider is skipped until the cooldown, then probed and recovered', async () => {
  let now = 1_000_000;
  const flaky = new FakeBackend('ollama', true, false, 'llama3.2:latest');
  const steady = new FakeBackend('local-openai', true, false, 'lm');
  flaky.failWith = 'network';
  const { llm } = orchestrator([flaky, steady], { now: () => now, config: { breaker: { failureThreshold: 2, openSeconds: 30 } } });
  for (let i = 0; i < 2; i += 1) await llm.chat(req('chat'));
  assert.equal(flaky.calls.length, 2);
  const skipped = await llm.chat(req('chat'));
  assert.equal(flaky.calls.length, 2, 'breaker open: provider not called');
  assert.equal(skipped.attempts[0]!.error, 'circuit_open');
  assert.equal(skipped.provider, 'local-openai');
  assert.equal(llm.status().providers.find((p) => p.id === 'ollama')!.breaker!.state, 'open');
  now += 31_000;
  flaky.failWith = null;
  const recovered = await llm.chat(req('chat'));
  assert.equal(recovered.provider, 'ollama');
  assert.equal(llm.status().providers.find((p) => p.id === 'ollama')!.breaker!.state, 'closed');
});

test('streaming: falls back before the first token, surfaces errors after it, records time to first token', async () => {
  const a = new FakeBackend('ollama', true, false, 'm1');
  const b = new FakeBackend('local-openai', true, false, 'm2');
  a.failWith = 'network';
  const { llm, metrics } = orchestrator([a, b]);
  const events = [];
  for await (const event of llm.stream(req('chat'))) events.push(event);
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text).join(''), 'hello');
  const done = events.at(-1)!;
  assert.equal(done.type, 'done');
  assert.equal((done as { provider: string }).provider, 'local-openai');
  assert.equal((done as { fellBack: boolean }).fellBack, true);
  assert.ok(metrics.summaries().find((s) => s.provider === 'local-openai')!.avgTtftMs !== null);

  const c = new FakeBackend('ollama', true, false, 'm3');
  const d = new FakeBackend('local-openai', true, false, 'm4');
  c.failAfterFirstPart = 'network';
  const second = orchestrator([c, d]).llm;
  const seen: string[] = [];
  await assert.rejects(async () => { for await (const event of second.stream(req('chat'))) if (event.type === 'delta') seen.push(event.text); }, LlmRoutingError);
  assert.deepEqual(seen, ['he']);
  assert.equal(d.calls.length, 0, 'no mixed output from a second provider after tokens were sent');
});

test('embeddings follow the same routing', async () => {
  const local = new FakeBackend('ollama', true, false, 'nomic-embed-text');
  const result = await orchestrator([local]).llm.embed(['a', 'b'], { containsPrivateData: true });
  assert.equal(result.vectors.length, 2);
  assert.equal(result.provider, 'ollama');
  // private text is never embedded by a cloud provider
  const cloud = new FakeBackend('openai', false, true, 'text-embedding-3-small');
  const gated = orchestrator([cloud], { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } } }).llm;
  await assert.rejects(() => gated.embed(['secret'], { containsPrivateData: true }), LlmRoutingError);
  assert.equal((await gated.embed(['public'], { containsPrivateData: false })).provider, 'openai');
});

test('metrics record numbers only: no prompt or reply text, no credentials, in memory or on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-llm-metrics-'));
  try {
    const metrics = new LlmMetrics(dir);
    const cloud = new FakeBackend('openai', false, true, 'gpt-4o-mini');
    cloud.reply = 'REPLY-SECRET-456';
    const store = new LlmConfigStore(null);
    store.set(validateConfig({ cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } }, store.get()).config);
    const llm = new LlmOrchestrator({ backends: () => [cloud], config: store, metrics, env: () => ({}) });
    await llm.chat(req('chat', { messages: msg('PROMPT-SECRET-123 sk-live-abcdef') }));
    for await (const event of llm.stream(req('summarize', { messages: msg('PROMPT-SECRET-123') }))) void event;
    metrics.flush();
    const everything = JSON.stringify([metrics.recent(), metrics.summaries(), metrics.ledger(), llm.status(), llm.cloudModels()]) + readFileSync(join(dir, 'usage.json'), 'utf8');
    assert.ok(!/SECRET|sk-live/.test(everything));
    const sample = metrics.recent()[0]!;
    const allowed = ['costUsd', 'errorKind', 'fallback', 'inputTokens', 'model', 'ok', 'outputTokens', 'provider', 't', 'task', 'tokensPerSec', 'totalMs', 'ttftMs'];
    assert.ok(Object.keys(sample).every((key) => allowed.includes(key)), 'only whitelisted numeric/enum fields are stored');
    assert.equal(sample.provider, 'openai');
    assert.ok(metrics.spentThisMonth() > 0);
    // ledger survives a reload
    assert.equal(new LlmMetrics(dir).spentThisMonth(), metrics.spentThisMonth());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('status and catalog expose neither API keys nor URLs; health checks are remembered', async () => {
  const cloud = new FakeBackend('openai', false, true, 'gpt-4o-mini');
  Object.assign(cloud, { apiKey: 'sk-should-never-appear', baseUrl: 'https://secret.example.com' });
  const { llm } = orchestrator([new FakeBackend('ollama', true, false, 'llama3.2:latest'), cloud]);
  const results = await llm.checkHealth();
  assert.equal(results['ollama']!.ok, true);
  const status = llm.status();
  assert.equal(status.providers.length, 6);
  assert.equal(status.providers.find((p) => p.id === 'openai')!.health!.ok, true);
  assert.equal(status.providers.find((p) => p.id === 'gemini')!.configured, false);
  assert.equal(status.providers.find((p) => p.id === 'ollama')!.local, true);
  assert.equal(status.providers.find((p) => p.id === 'openai')!.paid, true);
  assert.ok(!/sk-should|secret\.example/.test(JSON.stringify([status, llm.cloudModels()])));
});

test('owner test goes through eligibility: a paid provider is refused unless authorized and funded; no fallback to others', async () => {
  const local = new FakeBackend('ollama', true, false, 'llama3.2:latest');
  const cloud = new FakeBackend('openai', false, true, 'gpt-4o-mini');
  const closed = orchestrator([local, cloud]);
  await assert.rejects(() => closed.llm.test('openai', undefined, 'ping'), (error: unknown) => error instanceof LlmRoutingError && error.code === 'no_eligible_provider');
  assert.equal(cloud.calls.length, 0);
  assert.equal((await closed.llm.test('ollama', undefined, 'ping')).provider, 'ollama');
  const open = orchestrator([local, cloud], { config: { cloud: { globalAuthorized: true, monthlyBudgetUsd: 5 } } });
  assert.equal((await open.llm.test('openai', undefined, 'ping')).provider, 'openai');
  local.failWith = 'network';
  await assert.rejects(() => open.llm.test('ollama', undefined, 'ping'), (error: unknown) => error instanceof LlmRoutingError && error.code === 'all_providers_failed');
  assert.equal(cloud.calls.length, 1, 'a failed local test does not fall back to paid cloud');
});

test('backward compatibility: the original router exports and behaviour are unchanged', () => {
  for (const name of [ProviderRouter, providerRouter, loadProviders, cloudAllowedTasks, routingMode, PR2, OllamaProvider]) assert.ok(name);
  const router = new ProviderRouter(() => ({ JARVIS_CLOUD_OPENAI_API_KEY: 'k', JARVIS_CLOUD_OPENAI_MODEL: 'm' }));
  assert.equal(router.route({ taskType: 'conversation', containsPrivateData: false }).provider?.id, 'local');
  assert.deepEqual(loadProviders({}).map((p) => p.id), ['local']);
  assert.equal(legacyTaskToLlm('developer'), 'code');
  assert.equal(legacyTaskToLlm('conversation'), 'chat');
});

test('LlmChunk typing sanity', () => {
  const chunk: LlmChunk = { text: 'x' };
  assert.equal(chunk.text, 'x');
});
