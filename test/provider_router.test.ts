import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ProviderRouter, loadProviders } from '../src/ai/providerRouter.js';

const cloudEnv = {
  JARVIS_CLOUD_OPENAI_API_KEY: 'sk-test-not-real',
  JARVIS_CLOUD_OPENAI_MODEL: 'gpt-4.1-mini',
  JARVIS_CLOUD_ANTHROPIC_API_KEY: 'anthropic-test-not-real',
  JARVIS_CLOUD_ANTHROPIC_MODEL: 'claude-test',
};

test('local is the default provider and cloud adapters exist only when configured', () => {
  assert.deepEqual(loadProviders({}).map((p) => p.id), ['local']);
  assert.deepEqual(loadProviders(cloudEnv).map((p) => p.id), ['local', 'openai', 'anthropic']);
  const router = new ProviderRouter(() => cloudEnv);
  const decision = router.route({ taskType: 'conversation', containsPrivateData: false, cloudAuthorized: true });
  assert.equal(decision.provider?.id, 'local');
});

test('cloud is never used without owner authorization, and never for private data', () => {
  let now = 0;
  const router = new ProviderRouter(() => cloudEnv, () => now);
  router.reportFailure('local');
  assert.equal(router.route({ taskType: 'conversation', containsPrivateData: false }).provider, null);
  const privateDecision = router.route({ taskType: 'conversation', containsPrivateData: true, cloudAuthorized: true });
  assert.equal(privateDecision.provider, null);
  assert.ok(privateDecision.skipped.some((item) => /private/.test(item.reason)));
  const authorized = router.route({ taskType: 'conversation', containsPrivateData: false, cloudAuthorized: true });
  assert.equal(authorized.provider?.id, 'openai');
  assert.match(authorized.reason, /authorized/);
  now = 61_000; // local cooldown expires
  assert.equal(router.route({ taskType: 'conversation', containsPrivateData: false, cloudAuthorized: true }).provider?.id, 'local');
});

test('cloud fallback fails closed when privacy classification is missing or invalid', () => {
  const router = new ProviderRouter(() => cloudEnv);
  router.reportFailure('local');
  for (const classification of [undefined, null, 0, 'false']) {
    const decision = router.route({
      taskType: 'conversation',
      containsPrivateData: classification,
      cloudAuthorized: true,
    });
    assert.equal(decision.provider, null);
    assert.ok(decision.skipped.some((item) => /privacy classification is missing\/invalid/.test(item.reason)));
  }
});

test('owner allowlist authorizes cloud per task type and format filters apply', () => {
  const router = new ProviderRouter(() => ({ ...cloudEnv, JARVIS_CLOUD_ALLOWED_TASKS: 'developer' }));
  router.reportFailure('local');
  assert.equal(router.route({ taskType: 'developer', containsPrivateData: false }).provider?.id, 'openai');
  assert.equal(router.route({ taskType: 'site', containsPrivateData: false }).provider, null);
  router.reportFailure('openai');
  assert.equal(router.route({ taskType: 'developer', containsPrivateData: false, formats: ['openai'] }).provider, null);
  assert.equal(router.route({ taskType: 'developer', containsPrivateData: false }).provider?.id, 'anthropic');
});

test('first-party Ollama-only routes never fall back to configured cloud providers', () => {
  const router = new ProviderRouter(() => ({ ...cloudEnv, JARVIS_CLOUD_ALLOWED_TASKS: 'conversation' }));
  router.reportFailure('local');
  const decision = router.route({
    taskType: 'conversation',
    containsPrivateData: false,
    cloudAuthorized: true,
    formats: ['ollama'],
  });
  assert.equal(decision.provider, null);
  assert.ok(decision.skipped.every((item) => item.id === 'local' || /incompatible format/.test(item.reason)));
});

test('status never exposes credentials or URLs', () => {
  const status = JSON.stringify(new ProviderRouter(() => cloudEnv).status());
  assert.equal(status.includes('sk-test-not-real'), false);
  assert.equal(status.includes('anthropic-test-not-real'), false);
  assert.equal(status.includes('https://'), false);
});

test('insecure remote endpoints are refused', () => {
  assert.deepEqual(loadProviders({ JARVIS_AI_BASE_URL: 'http://example.com/v1', JARVIS_AI_ALLOW_REMOTE: 'true' }).map((p) => p.id), []);
  assert.deepEqual(loadProviders({ ...cloudEnv, JARVIS_CLOUD_OPENAI_BASE_URL: 'http://api.example.com/v1' }).map((p) => p.id), ['local', 'anthropic']);
});

test('native Ollama settings select the configured model and timeout', () => {
  const [local] = loadProviders({
    OLLAMA_URL: 'http://localhost:11434',
    OLLAMA_MODEL: 'llama3.2:latest',
    OLLAMA_TIMEOUT: '120',
  });
  assert.equal(local?.format, 'ollama');
  assert.equal(local?.baseUrl, 'http://localhost:11434');
  assert.equal(local?.model, 'llama3.2:latest');
  assert.equal(local?.timeoutMs, 120_000);
});

test('legacy OpenAI-compatible local URL is normalized for native Ollama', () => {
  const [local] = loadProviders({
    JARVIS_AI_BASE_URL: 'http://127.0.0.1:11434/v1',
    JARVIS_AI_MODEL: 'llama3.2',
  });
  assert.equal(local?.format, 'ollama');
  assert.equal(local?.baseUrl, 'http://127.0.0.1:11434');
  assert.equal(local?.model, 'llama3.2');
});

test('invalid Ollama timeout disables the local provider instead of silently ignoring configuration', () => {
  assert.deepEqual(loadProviders({ OLLAMA_TIMEOUT: '0' }), []);
  assert.deepEqual(loadProviders({ OLLAMA_TIMEOUT: '601' }), []);
});

test('remote Ollama is not selected for private prompts without explicit cloud authorization', () => {
  const env = {
    OLLAMA_URL: 'https://ollama.example.com',
    OLLAMA_MODEL: 'llama3.2:latest',
    JARVIS_AI_ALLOW_REMOTE: 'true',
  };
  const router = new ProviderRouter(() => env);
  assert.equal(router.route({
    taskType: 'conversation',
    containsPrivateData: true,
    cloudAuthorized: true,
  }).provider, null);
  assert.equal(router.route({
    taskType: 'conversation',
    containsPrivateData: false,
  }).provider, null);
  assert.equal(router.route({
    taskType: 'conversation',
    containsPrivateData: false,
    cloudAuthorized: true,
  }).provider?.id, 'local');
});
