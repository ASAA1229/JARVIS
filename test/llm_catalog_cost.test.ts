import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { defaultConfig, isEscalation, LlmConfigStore, validateConfig } from '../src/ai/llmConfig.js';
import { costUsd, DEFAULT_PRICING, estimateMessageTokens, estimateTokens, lookupPrice, PRICING_NOTE, UNKNOWN_PAID_PRICE } from '../src/ai/llmPricing.js';
import { applyOllamaShow, ModelCatalog, familyOf, parseOllamaListText, parseOllamaTags } from '../src/ai/modelCatalog.js';

// Fixtures modelled on `ollama list` output and the /api/tags and /api/show payloads.
const LIST_TEXT = `NAME                        ID              SIZE      MODIFIED
qwen2.5-coder:7b            2b0496514337    4.7 GB    2 days ago
llama3.2:3b                 a80c4f17acd5    2.0 GB    3 weeks ago
nomic-embed-text:latest     0a109f422b47    274 MB    4 weeks ago
deepseek-r1:14b             ea35dfe18182    9.0 GB    5 weeks ago
`;

const TAGS = {
  models: [
    { name: 'qwen2.5-coder:7b', size: 4_683_087_332, details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' } },
    { name: 'llama3.2:3b', size: 2_019_393_189, details: { family: 'llama', parameter_size: '3.2B', quantization_level: 'Q4_K_M' } },
    { name: 'nomic-embed-text:latest', size: 274_302_450, details: { family: 'nomic-bert', parameter_size: '137M', quantization_level: 'F16' } },
    { name: 'llava:7b', size: 4_700_000_000, details: { family: 'llama', parameter_size: '7B', quantization_level: 'Q4_0' } },
    { name: 'gemma2:9b', size: 5_400_000_000, details: { family: 'gemma2', parameter_size: '9.2B' } },
    { name: 'phi3:mini', size: 2_200_000_000, details: { family: 'phi3', parameter_size: '3.8B' } },
    { name: 'mistral:7b', size: 4_100_000_000, details: { family: 'llama', parameter_size: '7.2B' } },
    { name: 'deepseek-r1:14b', size: 9_000_000_000, details: { family: 'qwen2', parameter_size: '14.8B' } },
    { name: 'bad name with spaces', size: 1 },
  ],
};

const SHOW_QWEN = { details: { family: 'qwen2', parameter_size: '7.6B', quantization_level: 'Q4_K_M' }, model_info: { 'general.architecture': 'qwen2', 'qwen2.context_length': 32768 }, capabilities: ['completion', 'tools'] };
const SHOW_EMBED = { details: { family: 'nomic-bert', parameter_size: '137M' }, model_info: { 'nomic-bert.context_length': 2048 }, capabilities: ['embedding'] };
const SHOW_VISION = { details: { family: 'llama', parameter_size: '7B' }, model_info: { 'llama.context_length': 4096 }, capabilities: ['completion', 'vision'] };

test('catalog: families are recognised from names and details', () => {
  assert.equal(familyOf('llama3.2:3b'), 'llama');
  assert.equal(familyOf('mistral:7b'), 'mistral');
  assert.equal(familyOf('mixtral:8x7b'), 'mistral');
  assert.equal(familyOf('deepseek-r1:14b'), 'deepseek');
  assert.equal(familyOf('gemma2:9b'), 'gemma');
  assert.equal(familyOf('qwen2.5-coder:7b'), 'qwen');
  assert.equal(familyOf('phi3:mini'), 'phi');
  assert.equal(familyOf('custom-model'), 'other');
});

test('catalog: parses the `ollama list` text table', () => {
  const models = parseOllamaListText(LIST_TEXT);
  assert.deepEqual(models.map((m) => m.name), ['qwen2.5-coder:7b', 'llama3.2:3b', 'nomic-embed-text:latest', 'deepseek-r1:14b']);
  const coder = models[0]!;
  assert.equal(coder.family, 'qwen');
  assert.equal(coder.sizeBillions, 7);
  assert.equal(coder.diskBytes, 4_700_000_000);
  assert.ok(coder.capabilities.includes('code') && coder.capabilities.includes('chat'));
  assert.deepEqual(models[2]!.capabilities, ['embeddings']);
});

test('catalog: parses /api/tags, skips invalid names, derives size and capabilities', () => {
  const models = parseOllamaTags(TAGS);
  assert.equal(models.length, 8);
  const by = Object.fromEntries(models.map((m) => [m.name, m]));
  assert.equal(by['qwen2.5-coder:7b']!.parameterSize, '7.6B');
  assert.equal(by['qwen2.5-coder:7b']!.sizeBillions, 7.6);
  assert.equal(by['qwen2.5-coder:7b']!.quantization, 'Q4_K_M');
  assert.equal(by['nomic-embed-text:latest']!.sizeBillions, 0.137);
  assert.deepEqual(by['nomic-embed-text:latest']!.capabilities, ['embeddings']);
  assert.ok(by['llava:7b']!.capabilities.includes('vision'));
  assert.equal(by['phi3:mini']!.family, 'phi');
  assert.deepEqual(parseOllamaTags({}), []);
  assert.deepEqual(parseOllamaTags(null), []);
});

test('catalog: /api/show adds context length and reported capabilities', () => {
  const base = parseOllamaTags(TAGS);
  const coder = applyOllamaShow(base.find((m) => m.name === 'qwen2.5-coder:7b')!, SHOW_QWEN);
  assert.equal(coder.contextLength, 32768);
  assert.ok(coder.capabilities.includes('chat') && coder.capabilities.includes('code'));
  const embed = applyOllamaShow(base.find((m) => m.name === 'nomic-embed-text:latest')!, SHOW_EMBED);
  assert.equal(embed.contextLength, 2048);
  assert.deepEqual(embed.capabilities, ['embeddings']);
  const vision = applyOllamaShow(base.find((m) => m.name === 'llava:7b')!, SHOW_VISION);
  assert.deepEqual(vision.capabilities.sort(), ['chat', 'vision']);
  // Malformed show data leaves the entry usable.
  assert.equal(applyOllamaShow(base[0]!, 'nonsense').name, base[0]!.name);
});

test('catalog: refresh combines tags and show, caches, and tolerates an unreachable server', async () => {
  let tagCalls = 0;
  const shows: string[] = [];
  const catalog = new ModelCatalog(() => ({
    async tags() { tagCalls += 1; return TAGS; },
    async show(model: string) { shows.push(model); if (model === 'llava:7b') throw new Error('boom'); return model.includes('embed') ? SHOW_EMBED : SHOW_QWEN; },
  }), 60_000, () => 1000);
  const models = await catalog.models();
  assert.equal(models.find((m) => m.name === 'qwen2.5-coder:7b')!.contextLength, 32768);
  assert.ok(models.find((m) => m.name === 'llava:7b')!.capabilities.includes('vision'), 'falls back to the tags view when show fails');
  await catalog.models();
  assert.equal(tagCalls, 1, 'second call is served from cache');
  await catalog.models(true);
  assert.equal(tagCalls, 2);
  const down = new ModelCatalog(() => ({ async tags() { throw new Error('down'); }, async show() { return {}; } }));
  assert.deepEqual(await down.models(), []);
  assert.deepEqual(await new ModelCatalog(() => null).models(), []);
});

test('token estimator: Latin text, CJK, images and message overhead', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('你好世界'), 4);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
  assert.equal(estimateMessageTokens([{ role: 'user', content: 'a'.repeat(400) }]), 3 + 4 + 100);
  assert.equal(estimateMessageTokens([{ role: 'user', content: '', images: ['x'] }]), 3 + 4 + 800);
});

test('pricing: per-request cost, prefix matching, free local, unknown paid models priced high', () => {
  const table = defaultConfig().pricing;
  const mini = lookupPrice(table, 'openai', 'gpt-4o-mini', true);
  assert.equal(costUsd(mini, 1_000_000, 1_000_000), 0.15 + 0.6);
  assert.equal(costUsd(mini, 1000, 500), (1000 * 0.15 + 500 * 0.6) / 1e6);
  // dated model ids resolve by longest prefix; "gpt-4o-mini-..." must not match the cheaper-named "gpt-4o"
  assert.deepEqual(lookupPrice(table, 'openai', 'gpt-4o-mini-2024-07-18', true), DEFAULT_PRICING['gpt-4o-mini']);
  assert.deepEqual(lookupPrice(table, 'anthropic', 'claude-sonnet-4-5-20250929', true), DEFAULT_PRICING['claude-sonnet']);
  assert.deepEqual(lookupPrice(table, 'azure-openai', 'gpt-4o', true), DEFAULT_PRICING['gpt-4o']);
  assert.equal(lookupPrice(table, 'ollama', 'llama3.2', false).inputPer1M, 0);
  assert.equal(lookupPrice(table, 'openai', 'mystery-model', true), UNKNOWN_PAID_PRICE);
  // provider-scoped override wins
  const custom = { ...table, 'openai/gpt-4o-mini': { inputPer1M: 9, outputPer1M: 9, tier: 'small' as const } };
  assert.equal(lookupPrice(custom, 'openai', 'gpt-4o-mini', true).inputPer1M, 9);
  assert.match(PRICING_NOTE, /Verify current pricing/i);
});

test('config: defaults are zero-cost; validation rejects bad input; escalation detection', () => {
  const cfg = defaultConfig();
  assert.equal(cfg.cloud.globalAuthorized, false);
  assert.equal(cfg.cloud.monthlyBudgetUsd, 0);
  assert.deepEqual(cfg.cloud.authorizedTasks, []);
  assert.ok(cfg.rules.code.preferModels.includes('coder'));
  assert.equal(cfg.rules.extract.sizeBias, 'small');
  assert.equal(cfg.rules.embed.requireCapability, 'embeddings');

  const bad = validateConfig({ cloud: { monthlyBudgetUsd: -1, authorizedTasks: ['nope'] }, rules: { chat: { sizeBias: 'huge' }, wat: {} }, pricing: { x: { inputPer1M: 'a' } } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 4);
  assert.equal(bad.config.cloud.monthlyBudgetUsd, 0, 'invalid values never leak into the result');

  const good = validateConfig({ cloud: { monthlyBudgetUsd: 5, authorizedTasks: ['chat'] }, rules: { chat: { preferModels: ['gemma'], sizeBias: 'small' } }, unknownKey: 1 });
  assert.equal(good.ok, true);
  assert.deepEqual(good.config.rules.chat.preferModels, ['gemma']);
  assert.equal((good.config as unknown as Record<string, unknown>)['unknownKey'], undefined);

  assert.equal(isEscalation(cfg, cfg), false);
  assert.equal(isEscalation(cfg, validateConfig({ cloud: { globalAuthorized: true } }, cfg).config), true);
  assert.equal(isEscalation(cfg, validateConfig({ cloud: { monthlyBudgetUsd: 1 } }, cfg).config), true);
  assert.equal(isEscalation(cfg, validateConfig({ cloud: { authorizedTasks: ['code'] } }, cfg).config), true);
  assert.equal(isEscalation(cfg, validateConfig({ cloudModels: { openai: ['gpt-4o'] } }, cfg).config), true);
  assert.equal(isEscalation(cfg, validateConfig({ pricing: { 'gpt-4o': { inputPer1M: 0.01, outputPer1M: 0.01, tier: 'medium' } } }, cfg).config), true);
  const withCloud = validateConfig({ cloud: { globalAuthorized: true, monthlyBudgetUsd: 10 } }, cfg).config;
  assert.equal(isEscalation(withCloud, validateConfig({ cloud: { globalAuthorized: false, monthlyBudgetUsd: 2 } }, withCloud).config), false, 'tightening is not an escalation');
  assert.equal(isEscalation(cfg, validateConfig({ rules: { chat: { preferModels: ['gemma'] } } }, cfg).config), false);
});

test('config store persists to disk and reloads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-llm-cfg-'));
  try {
    const store = new LlmConfigStore(dir);
    store.set(validateConfig({ cloud: { monthlyBudgetUsd: 7 } }, store.get()).config);
    assert.equal(new LlmConfigStore(dir).get().cloud.monthlyBudgetUsd, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
