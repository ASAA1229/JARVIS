import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRouter, cloudAllowedTasks, loadProviders } from '../src/ai/providerRouter.js';
import { VoiceProviderRegistry, readVoicePrivacySettings, type SpeechToTextProvider } from '../src/voice/providers.js';
import { getAgentModelConfigStatus } from '../src/conversation/agentModelAdapter.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { freePort } from './helpers/freePort.js';

/**
 * Local/cloud separation and zero-cost defaults (JAR-E07, JARVIS-US-004, US-024).
 * Proves: no paid provider exists by default; cloud speech is off by default; no audio or
 * transcript reaches a non-loopback address in a default configuration; cloud use needs
 * explicit owner enablement at every layer.
 */
const OWNER_TOKEN = 'local-cloud-separation-owner-token-0123456789abcdef';
const CLOUD_ENV = ['JARVIS_ALLOW_CLOUD_SPEECH', 'JARVIS_CLOUD_OPENAI_API_KEY', 'JARVIS_CLOUD_OPENAI_MODEL', 'JARVIS_CLOUD_ANTHROPIC_API_KEY', 'JARVIS_CLOUD_ANTHROPIC_MODEL', 'JARVIS_CLOUD_ALLOWED_TASKS', 'JARVIS_AI_ALLOW_REMOTE', 'JARVIS_AI_API_KEY', 'JARVIS_AI_BASE_URL', 'OLLAMA_URL', 'JARVIS_SITE_GATEWAY_ALLOW_CLOUD', 'JARVIS_PEER_DISCOVERY'];

function cleanEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of CLOUD_ENV) delete env[key];
  return env;
}
const loopbackHost = (host: unknown) => typeof host === 'string' && ['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1', '0.0.0.0'].includes(host);

test('zero-cost defaults: with no configuration the only provider is free local Ollama and no cloud task is allowed', () => {
  const env = cleanEnv();
  const providers = loadProviders(env);
  assert.deepEqual(providers.map((p) => [p.id, p.local, p.cost]), [['local', true, 'free']]);
  assert.equal(providers.some((p) => p.cost === 'paid' || !p.local), false, 'no paid or remote provider is enabled by default');
  assert.equal(cloudAllowedTasks(env).size, 0);
  const router = new ProviderRouter(() => env);
  for (const taskType of ['conversation', 'agent', 'site', 'developer', 'summarize'] as const) {
    assert.equal(router.route({ taskType }).provider?.id, 'local');
    assert.equal(router.route({ taskType }).provider?.cost, 'free');
  }
  assert.deepEqual(router.status().cloudAllowedTasks, []);
});

test('API keys alone never enable cloud: without owner authorization a cloud provider is never routed, even if local is down', () => {
  const env = { ...cleanEnv(), JARVIS_CLOUD_OPENAI_API_KEY: 'sk-test-not-real', JARVIS_CLOUD_OPENAI_MODEL: 'gpt-x', JARVIS_CLOUD_ANTHROPIC_API_KEY: 'sk-ant-not-real', JARVIS_CLOUD_ANTHROPIC_MODEL: 'claude-x' };
  const router = new ProviderRouter(() => env);
  assert.ok(loadProviders(env).some((p) => p.cost === 'paid'), 'configured cloud adapters exist but are inert');
  assert.equal(router.route({ taskType: 'conversation' }).provider?.id, 'local');
  router.reportFailure('local');
  const down = router.route({ taskType: 'conversation', containsPrivateData: false });
  assert.equal(down.provider, null, 'local outage does not silently fall back to a paid provider');
  assert.ok(down.skipped.some((s) => /not authorized by the owner/.test(s.reason)));
  assert.equal(router.route({ taskType: 'conversation', cloudAuthorized: true, containsPrivateData: true }).provider, null, 'private data stays local even when cloud is authorized');
  assert.equal(router.route({ taskType: 'conversation', cloudAuthorized: true, containsPrivateData: false }).provider?.local, false, 'explicit authorization is the only way to a cloud provider');
});

test('speech defaults: cloud speech is off, no local STT is assumed, and cloud STT can only be registered after explicit opt-in', async () => {
  const saved = process.env.JARVIS_ALLOW_CLOUD_SPEECH;
  delete process.env.JARVIS_ALLOW_CLOUD_SPEECH;
  try {
    assert.equal(readVoicePrivacySettings().allowCloudSpeech, false);
    const cloudStt: SpeechToTextProvider = { id: 'cloud-stt', local: false, isAvailable: async () => true, transcribe: async () => ({ text: 'x', provider: 'cloud-stt', local: false }) };
    const registry = new VoiceProviderRegistry(readVoicePrivacySettings());
    assert.throws(() => registry.register(cloudStt), /disabled by the voice privacy settings/);
    assert.equal((await registry.describe()).cloudSpeechAllowed, false);
    for (const value of ['', '0', 'true', 'yes', ' 1']) {
      process.env.JARVIS_ALLOW_CLOUD_SPEECH = value;
      assert.equal(readVoicePrivacySettings().allowCloudSpeech, false, `"${value}" must not enable cloud speech`);
    }
    process.env.JARVIS_ALLOW_CLOUD_SPEECH = '1';
    const opted = new VoiceProviderRegistry(readVoicePrivacySettings());
    opted.register(cloudStt);
    assert.equal((await opted.describe()).cloudSpeechAllowed, true);
    assert.equal(await opted.pickLocalStt(), undefined, 'even when cloud speech is enabled, local transcription never picks a cloud provider');
  } finally {
    if (saved === undefined) delete process.env.JARVIS_ALLOW_CLOUD_SPEECH; else process.env.JARVIS_ALLOW_CLOUD_SPEECH = saved;
  }
});

test('the first-party agent model refuses remote endpoints unless the owner opts in (and never over plain http)', () => {
  const keys = ['OLLAMA_URL', 'JARVIS_AI_BASE_URL', 'JARVIS_AI_ALLOW_REMOTE'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    assert.equal(getAgentModelConfigStatus().status === 'ready' && (getAgentModelConfigStatus() as { mode: string }).mode, 'local');
    process.env.OLLAMA_URL = 'https://models.example.com';
    assert.deepEqual(getAgentModelConfigStatus(), { status: 'disabled', reason: 'remote_not_opted_in' });
    process.env.JARVIS_AI_ALLOW_REMOTE = 'true';
    // The router never selects a remote Ollama endpoint for private agent requests, so it is not reported ready.
    assert.deepEqual(getAgentModelConfigStatus(), { status: 'disabled', reason: 'no_eligible_provider' });
    process.env.OLLAMA_URL = 'http://models.example.com';
    assert.deepEqual(getAgentModelConfigStatus(), { status: 'disabled', reason: 'insecure_remote_url' });
  } finally {
    for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});

test('network egress: in the default configuration no connection or datagram leaves loopback during typed, voice and document flows', async () => {
  const saved: Record<string, string | undefined> = {};
  for (const key of CLOUD_ENV) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
  const external: string[] = [];
  const realConnect = net.Socket.prototype.connect;
  mock.method(net.Socket.prototype, 'connect', function (this: net.Socket, ...args: unknown[]) {
    const first = args[0] as { host?: string; path?: string } | number | string;
    const host = typeof first === 'object' && first ? (first.host ?? (first.path ? 'ipc' : 'localhost')) : typeof args[1] === 'string' ? args[1] : 'localhost';
    if (host !== 'ipc' && !loopbackHost(host)) external.push(String(host));
    return (realConnect as (...a: unknown[]) => net.Socket).apply(this, args);
  } as never);
  const realSend = dgram.Socket.prototype.send;
  mock.method(dgram.Socket.prototype, 'send', function (this: dgram.Socket, ...args: unknown[]) { external.push('udp'); return (realSend as (...a: unknown[]) => void).apply(this, args); } as never);

  const dir = mkdtempSync(join(tmpdir(), 'jarvis-egress-'));
  const port = await freePort();
  const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
  await server.start();
  const base = `http://127.0.0.1:${port}`;
  try {
    const keys = CryptoUtil.generateEd25519KeyPair();
    const challenge = await (await fetch(`${base}/api/enrollment/challenge`, { method: 'POST', headers: { 'x-owner-control-token': OWNER_TOKEN } })).json();
    const name = 'Egress test device';
    const proof = CryptoUtil.signData(`ENROLLMENT_PROOF:${challenge.challengeToken}:${name}:${CryptoUtil.sha256(keys.publicKey)}`, keys.privateKey);
    const redeem = await (await fetch(`${base}/api/enrollment/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken: challenge.challengeToken, deviceName: name, publicKey: keys.publicKey, proofSignature: proof }) })).json();
    const ts = Date.now(); const nonce = CryptoUtil.randomToken(16);
    const session = await (await fetch(`${base}/api/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceId: redeem.deviceId, signature: CryptoUtil.signData(`SESSION_REQUEST:${ts}:${nonce}`, keys.privateKey), timestamp: ts, nonce }) })).json();
    const call = async (method: string, path: string, body?: unknown) => {
      const t = Date.now(); const n = CryptoUtil.randomToken(16);
      const canonical = CryptoUtil.buildCanonicalRequestString(method, path, session.sessionId, t, n, body);
      const response = await fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-session-id': session.sessionId, 'x-request-timestamp': String(t), 'x-request-nonce': n, 'x-request-signature': CryptoUtil.signData(canonical, keys.privateKey) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
    };
    assert.equal((await call('POST', '/api/request', { text: 'What is the OS version?' })).status, 200);
    assert.equal((await call('POST', '/api/request', { text: 'What is the battery level?', voice: { utteranceId: 'utt-egress-0001' } })).status, 200);
    assert.equal((await call('POST', '/api/documents/ingest', { sourceName: 'n.txt', content: 'private transcript-like text about egress' })).status, 201);
    // Speech endpoints in a default install: no local STT or TTS is configured, so they refuse instead of calling a cloud service.
    const transcribe = await call('POST', '/api/voice/transcribe', { audioBase64: Buffer.alloc(64).toString('base64') });
    assert.ok([400, 422, 503].includes(transcribe.status), `transcribe status ${transcribe.status}`);
    const capabilities = (await call('GET', '/api/voice/capabilities')).json as { cloudSpeechAllowed: boolean };
    assert.equal(capabilities.cloudSpeechAllowed, false);
    assert.deepEqual(external, [], `unexpected non-loopback egress: ${external.join(', ')}`);
  } finally {
    await server.stop();
    mock.restoreAll();
    rmSync(dir, { recursive: true, force: true });
    for (const key of CLOUD_ENV) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});
