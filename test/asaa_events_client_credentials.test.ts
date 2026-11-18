import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AsaaEventProducer, ClientCredentialsTokenSource, readAsaaEventsConfig, type AsaaEventsConfig } from '../src/integration/asaaEvents.js';

const CLIENT_SECRET = 'cc-test-client-secret-do-not-use-0123456789';
const STATIC_TOKEN = 'static-fallback-token-do-not-use';
const ORG = 'org-test-0001';
const OWNER_TOKEN = 'test-owner-control-token-0123456789abcdef';

interface Recorded { method: string; url: string; headers: IncomingMessage['headers']; body: string }

/** Tiny in-process HTTP server used as a MOCK (clearly not Keycloak and not ASAA). */
class MockServer {
  readonly requests: Recorded[] = [];
  /** Scripted handler results consumed in order; falls back to `fallback`. */
  script: Array<(request: Recorded) => { status: number; body?: unknown }> = [];
  fallback: (request: Recorded) => { status: number; body?: unknown } = () => ({ status: 202, body: {} });
  baseUrl = '';
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const recorded: Recorded = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
        this.requests.push(recorded);
        const result = (this.script.shift() ?? this.fallback)(recorded);
        res.writeHead(result.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body ?? {}));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}

describe('ASAA event producer: client-credentials access tokens (MOCK token endpoint and MOCK ASAA)', () => {
  let dir: string;
  let idp: MockServer;
  let asaa: MockServer;
  let clock: number;
  let issued: number;
  let logged: string[];
  const restore: Array<() => void> = [];

  const outbox = () => join(dir, 'outbox.json');
  const tokenUrl = () => `${idp.baseUrl}/realms/asaa/protocol/openid-connect/token`;
  const config = (): AsaaEventsConfig => ({ baseUrl: asaa.baseUrl, orgId: ORG, clientCredentials: { tokenUrl: tokenUrl(), clientId: 'jarvis-events', clientSecret: CLIENT_SECRET } });
  const producer = (overrides: Partial<ConstructorParameters<typeof AsaaEventProducer>[0]> = {}) => new AsaaEventProducer({
    config: config(), outboxPath: outbox(), now: () => clock, backoffBaseMs: 1_000, backoffMaxMs: 60_000, maxAttempts: 6, timeoutMs: 2_000, ...overrides,
  });
  const taskEvent = (p: AsaaEventProducer, id: string) => p.taskFinished({ taskId: id, operation: 'system:get_os_info', outcome: 'VERIFIED_SUCCESS', failed: false });
  const bearerOf = (request: Recorded) => String(request.headers.authorization ?? '').replace(/^Bearer /, '');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-asaa-cc-'));
    idp = new MockServer();
    asaa = new MockServer();
    await idp.start();
    await asaa.start();
    clock = 1_700_000_000_000;
    issued = 0;
    // Mock token endpoint: every call mints a distinct token (token-1, token-2, ...) valid for 100 s.
    idp.fallback = () => ({ status: 200, body: { access_token: `token-${++issued}`, token_type: 'Bearer', expires_in: 100 } });
    // Mock ASAA accepts any token issued so far except those listed as revoked.
    asaa.fallback = () => ({ status: 202, body: {} });
    logged = [];
    for (const method of ['log', 'info', 'warn', 'error'] as const) {
      const original = console[method];
      console[method] = (...args: unknown[]) => { logged.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')); };
      restore.push(() => { console[method] = original; });
    }
  });

  afterEach(async () => {
    while (restore.length) restore.pop()!();
    await idp.stop();
    await asaa.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test('configuration: client credentials need token URL and secret; client id defaults to jarvis-events; https unless loopback', () => {
    const base = { ASAA_EVENTS_URL: 'https://asaa.example.com', ASAA_ORG_ID: ORG };
    const ok = readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN_URL: 'https://sso.example.com/realms/asaa/protocol/openid-connect/token', ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET });
    assert.equal(ok.enabled, true);
    const cc = (ok as { config: AsaaEventsConfig }).config;
    assert.equal(cc.token, undefined);
    assert.deepEqual(cc.clientCredentials, { tokenUrl: 'https://sso.example.com/realms/asaa/protocol/openid-connect/token', clientId: 'jarvis-events', clientSecret: CLIENT_SECRET });
    assert.equal((readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN_URL: 'http://127.0.0.1:8280/t', ASAA_EVENTS_CLIENT_ID: 'custom-client', ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET }) as { config: AsaaEventsConfig }).config.clientCredentials?.clientId, 'custom-client');
    assert.deepEqual(readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN_URL: 'http://sso.example.com/t', ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET }), { enabled: false, reason: 'invalid-client-credentials' });
    assert.deepEqual(readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN_URL: 'https://u:p@sso.example.com/t', ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET }), { enabled: false, reason: 'invalid-client-credentials' });
    assert.deepEqual(readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN_URL: 'https://sso.example.com/t', ASAA_EVENTS_CLIENT_SECRET: 'has space' }), { enabled: false, reason: 'invalid-client-credentials' });
    assert.deepEqual(readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN_URL: 'https://sso.example.com/t', ASAA_EVENTS_CLIENT_ID: 'bad id!', ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET }), { enabled: false, reason: 'invalid-client-credentials' });
    // A half-configured client-credentials set never falls back to the static token.
    for (const partial of [{ ASAA_EVENTS_TOKEN_URL: 'https://sso.example.com/t' }, { ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET }, { ASAA_EVENTS_CLIENT_ID: 'jarvis-events' }]) {
      assert.deepEqual(readAsaaEventsConfig({ ...base, ASAA_EVENTS_TOKEN: STATIC_TOKEN, ...partial }), { enabled: false, reason: 'incomplete' });
    }
    // Still disabled without URL or org id.
    assert.deepEqual(readAsaaEventsConfig({ ASAA_ORG_ID: ORG, ASAA_EVENTS_TOKEN_URL: 'https://sso.example.com/t', ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET }), { enabled: false, reason: 'incomplete' });
    assert.deepEqual(readAsaaEventsConfig({}), { enabled: false, reason: 'not-configured' });
  });

  test('static token configuration is unchanged when no client credentials are set', async () => {
    const result = readAsaaEventsConfig({ ASAA_EVENTS_URL: asaa.baseUrl, ASAA_EVENTS_TOKEN: STATIC_TOKEN, ASAA_ORG_ID: ORG });
    assert.deepEqual(result, { enabled: true, config: { baseUrl: asaa.baseUrl, token: STATIC_TOKEN, orgId: ORG } });
    const p = producer({ config: (result as { config: AsaaEventsConfig }).config });
    taskEvent(p, 'task-static1');
    await p.flush();
    assert.equal(asaa.requests.length, 1);
    assert.equal(bearerOf(asaa.requests[0]), STATIC_TOKEN);
    assert.equal(idp.requests.length, 0, 'no token endpoint call in static mode');
  });

  test('both configured: client credentials win and a single warning is logged without any secret', async () => {
    const env = {
      ASAA_EVENTS_URL: asaa.baseUrl, ASAA_ORG_ID: ORG, ASAA_EVENTS_TOKEN: STATIC_TOKEN,
      ASAA_EVENTS_TOKEN_URL: tokenUrl(), ASAA_EVENTS_CLIENT_SECRET: CLIENT_SECRET,
    };
    const p = AsaaEventProducer.fromEnvironment(env, { statePath: join(dir, 'state.json') }, { now: () => clock, timeoutMs: 2_000 });
    assert.equal(p.enabled, true);
    const warnings = logged.filter((line) => line.includes('ASAA_EVENTS_TOKEN is ignored'));
    assert.equal(warnings.length, 1);
    taskEvent(p, 'task-both001');
    await p.flush();
    assert.equal(bearerOf(asaa.requests[0]), 'token-1', 'the client-credentials token is used');
    assert.equal(asaa.requests.some((request) => bearerOf(request) === STATIC_TOKEN), false);
    for (const line of logged) for (const secret of [STATIC_TOKEN, CLIENT_SECRET, 'token-1']) assert.equal(line.includes(secret), false, 'no secret in logs');
  });

  test('requests an access token with client_credentials and client_secret_basic, then uses it as the bearer', async () => {
    const p = producer();
    taskEvent(p, 'task-cc-0001');
    await p.flush();
    assert.equal(idp.requests.length, 1);
    const tokenRequest = idp.requests[0];
    assert.equal(tokenRequest.method, 'POST');
    assert.equal(tokenRequest.url, '/realms/asaa/protocol/openid-connect/token');
    assert.equal(tokenRequest.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(tokenRequest.body, 'grant_type=client_credentials', 'the secret is not in the body');
    const basic = Buffer.from(String(tokenRequest.headers.authorization).replace(/^Basic /, ''), 'base64').toString('utf8');
    assert.equal(basic, `jarvis-events:${encodeURIComponent(CLIENT_SECRET)}`);
    assert.equal(asaa.requests.length, 1);
    assert.equal(bearerOf(asaa.requests[0]), 'token-1');
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 });
  });

  test('the token is cached across events and shared by concurrent deliveries', async () => {
    const p = producer();
    for (let i = 0; i < 5; i += 1) taskEvent(p, `task-cache-0${i}`);
    await p.flush();
    assert.equal(asaa.requests.length, 5);
    assert.equal(idp.requests.length, 1, 'one token fetch for five events');
    taskEvent(p, 'task-cache-more');
    await p.flush();
    assert.equal(idp.requests.length, 1, 'still cached on a later delivery');
    assert.equal(new Set(asaa.requests.map(bearerOf)).size, 1);
  });

  test('the token is refreshed about 30 s before it expires (from expires_in, not from the JWT)', async () => {
    const p = producer();
    taskEvent(p, 'task-exp-0001');
    await p.flush();
    assert.equal(idp.requests.length, 1);
    clock += 69_000; // 100 s lifetime, refresh at 70 s
    taskEvent(p, 'task-exp-0002');
    await p.flush();
    assert.equal(idp.requests.length, 1, 'still valid at 69 s');
    assert.equal(bearerOf(asaa.requests[1]), 'token-1');
    clock += 2_000; // 71 s
    taskEvent(p, 'task-exp-0003');
    await p.flush();
    assert.equal(idp.requests.length, 2, 'refreshed after the margin');
    assert.equal(bearerOf(asaa.requests[2]), 'token-2');
  });

  test('a 401 refreshes the token once and re-sends; a second 401 is retried later and never dead-letters', async () => {
    const p = producer();
    asaa.script = [() => ({ status: 401 })]; // the first delivery attempt is rejected as unauthorized
    taskEvent(p, 'task-401-0001');
    await p.flush();
    assert.equal(idp.requests.length, 2, 'one extra token fetch after the 401');
    assert.deepEqual(asaa.requests.map(bearerOf), ['token-1', 'token-2']);
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 }, 'delivered with the refreshed token');

    asaa.requests.length = 0;
    asaa.script = [() => ({ status: 401 }), () => ({ status: 401 })];
    taskEvent(p, 'task-401-0002');
    await p.flush();
    assert.equal(asaa.requests.length, 2, 'exactly one refresh and one re-send, no loop');
    assert.deepEqual(p.status(), { enabled: true, pending: 1, deadLetter: 0 }, 'kept for a backoff retry, not dead-lettered');
    clock += 1_000;
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 }, 'delivered on the retry');
  });

  test('a token fetch failure is transient: events stay queued, back off, and are never dead-lettered by it', async () => {
    const p = producer({ maxAttempts: 50 });
    idp.script = [() => ({ status: 500 }), () => ({ status: 200, body: { nope: true } }), () => ({ status: 200, body: { access_token: 'bad token with spaces', expires_in: 100 } })];
    taskEvent(p, 'task-fail-0001');
    await p.flush();
    assert.equal(asaa.requests.length, 0, 'no event is sent without a token');
    assert.deepEqual(p.status(), { enabled: true, pending: 1, deadLetter: 0 });
    for (let i = 0; i < 2; i += 1) {
      clock += 120_000;
      await p.flush();
      assert.deepEqual(p.status(), { enabled: true, pending: 1, deadLetter: 0 }, 'malformed token responses are transient too');
    }
    clock += 120_000;
    await p.flush(); // the token endpoint now issues a good token
    assert.equal(asaa.requests.length, 1);
    assert.equal(bearerOf(asaa.requests[0]), 'token-1');
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 0 });
  });

  test('an unreachable token endpoint is transient (network error)', async () => {
    const unreachable = new MockServer();
    await unreachable.start();
    const closedUrl = `${unreachable.baseUrl}/token`;
    await unreachable.stop();
    const p = producer({ config: { baseUrl: asaa.baseUrl, orgId: ORG, clientCredentials: { tokenUrl: closedUrl, clientId: 'jarvis-events', clientSecret: CLIENT_SECRET } } });
    taskEvent(p, 'task-net-0001');
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 1, deadLetter: 0 });
    assert.equal(asaa.requests.length, 0);
  });

  test('permanent rejections by ASAA (for example 403 producer binding) still dead-letter after a valid token', async () => {
    const p = producer();
    asaa.script = [() => ({ status: 403 })];
    taskEvent(p, 'task-403-0001');
    await p.flush();
    assert.deepEqual(p.status(), { enabled: true, pending: 0, deadLetter: 1 });
    assert.equal(idp.requests.length, 1, 'a 403 does not trigger a token refresh');
  });

  test('the client secret and tokens never reach disk, the outbox, event bodies or logs', async () => {
    for (const ownerToken of [undefined, OWNER_TOKEN]) {
      const path = join(dir, ownerToken ? 'encrypted-outbox.json' : 'plain-outbox.json');
      const p = producer({ outboxPath: path, ...(ownerToken ? { ownerToken } : {}) });
      asaa.script = [() => ({ status: 503 })]; // force the event to persist in the outbox
      taskEvent(p, ownerToken ? 'task-secret-enc' : 'task-secret-pln');
      await p.flush();
      assert.equal(p.status().pending, 1);
      assert.ok(existsSync(path));
      const onDisk = readFileSync(path, 'utf8');
      for (const secret of [CLIENT_SECRET, encodeURIComponent(CLIENT_SECRET), STATIC_TOKEN, 'token-1', 'token-2', 'Bearer ', 'Basic ']) {
        assert.equal(onDisk.includes(secret), false, `outbox contains ${secret.slice(0, 10)}`);
      }
      clock += 120_000;
      await p.flush();
    }
    for (const request of asaa.requests) {
      assert.equal(request.body.includes(CLIENT_SECRET), false, 'event bodies never contain the secret');
      assert.equal(request.body.includes('token-'), false, 'event bodies never contain tokens');
    }
    for (const request of idp.requests) assert.equal(request.body.includes(CLIENT_SECRET), false, 'the secret is sent in the Authorization header only');
    for (const line of logged) for (const secret of [CLIENT_SECRET, 'token-1', 'token-2']) assert.equal(line.includes(secret), false, 'logs never contain secrets');
  });

  test('the token source on its own: caching, forced refresh and single-flight', async () => {
    const source = new ClientCredentialsTokenSource({ tokenUrl: tokenUrl(), clientId: 'jarvis-events', clientSecret: CLIENT_SECRET }, { now: () => clock });
    const [a, b, c] = await Promise.all([source.get(), source.get(), source.get()]);
    assert.deepEqual([a, b, c], ['token-1', 'token-1', 'token-1']);
    assert.equal(idp.requests.length, 1, 'concurrent requests share one fetch');
    assert.equal(await source.get(), 'token-1');
    assert.equal(await source.get(true), 'token-2', 'forced refresh fetches a new token');
    source.invalidate();
    assert.equal(await source.get(), 'token-3');
    // A non-bearer token type is refused.
    idp.script = [() => ({ status: 200, body: { access_token: 'abc', token_type: 'mac', expires_in: 100 } })];
    source.invalidate();
    await assert.rejects(source.get(), /token fetch failed \(response\)/);
  });
});
