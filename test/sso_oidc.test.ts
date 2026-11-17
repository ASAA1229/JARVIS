import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, generateKeyPairSync, sign as cryptoSign, randomUUID, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OidcSso, SsoError, readOidcConfig, type OidcConfig } from '../src/identity/ssoOidc.js';
import { JarvisServer } from '../src/server/server.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { freePort } from './helpers/freePort.js';

const CLIENT_ID = 'jarvis-companion';
const OWNER_TOKEN = 'test-owner-control-token-0123456789abcdef';
const b64 = (value: unknown) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

interface IssuedCode { nonce: string; challenge: string; claims: Record<string, unknown>; accessClaims?: Record<string, unknown>; header?: Record<string, unknown>; signWith?: KeyObject; mutate?: (jwt: string) => string }

/**
 * MOCK identity provider (in-process HTTP server with a freshly generated RSA key). It stands in
 * for the local Keycloak and is not a real IdP. It verifies PKCE S256 on the token endpoint.
 */
class MockIdp {
  readonly key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
  readonly kid = 'mock-key-1';
  readonly codes = new Map<string, IssuedCode>();
  tokenRequests: URLSearchParams[] = [];
  /** Optional override of the discovery document (hostile-discovery tests). */
  discoveryOverride: ((issuer: string) => Record<string, unknown>) | undefined;
  issuer = '';
  private server: Server | undefined;

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    this.issuer = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/realms/asaa`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  jwt(claims: Record<string, unknown>, header: Record<string, unknown> = {}, signWith: KeyObject = this.key.privateKey): string {
    const head = b64({ alg: 'RS256', typ: 'JWT', kid: this.kid, ...header });
    const body = b64(claims);
    return `${head}.${body}.${cryptoSign('RSA-SHA256', Buffer.from(`${head}.${body}`), signWith).toString('base64url')}`;
  }

  baseClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
      iss: this.issuer, aud: CLIENT_ID, azp: CLIENT_ID, sub: 'f3a1c2d4-0000-4000-8000-00000000abcd', preferred_username: 'alice',
      iat: now, exp: now + 300, amr: ['pwd', 'otp'], realm_access: { roles: ['jarvis-owner', 'offline_access'] }, ...overrides,
    };
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const path = new URL(req.url ?? '/', 'http://idp.test').pathname;
      const base = '/realms/asaa';
      if (path === `${base}/.well-known/openid-configuration`) {
        return send(200, this.discoveryOverride?.(this.issuer) ?? {
          issuer: this.issuer,
          authorization_endpoint: `${this.issuer}/protocol/openid-connect/auth`,
          token_endpoint: `${this.issuer}/protocol/openid-connect/token`,
          jwks_uri: `${this.issuer}/protocol/openid-connect/certs`,
        });
      }
      if (path === `${base}/protocol/openid-connect/certs`) {
        return send(200, { keys: [{ ...(this.key.publicKey.export({ format: 'jwk' }) as object), kid: this.kid, use: 'sig', alg: 'RS256' }] });
      }
      if (path === `${base}/protocol/openid-connect/token` && req.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        this.tokenRequests.push(form);
        const issued = this.codes.get(form.get('code') ?? '');
        this.codes.delete(form.get('code') ?? '');
        const verifierOk = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url') === issued?.challenge;
        if (!issued || form.get('grant_type') !== 'authorization_code' || form.get('client_id') !== CLIENT_ID || !verifierOk ||
            !/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(form.get('redirect_uri') ?? '')) {
          return send(400, { error: 'invalid_grant' });
        }
        let idToken = this.jwt({ ...issued.claims, nonce: issued.claims.nonce ?? issued.nonce }, issued.header, issued.signWith);
        if (issued.mutate) idToken = issued.mutate(idToken);
        return send(200, {
          token_type: 'Bearer', id_token: idToken,
          ...(issued.accessClaims ? { access_token: this.jwt(issued.accessClaims) } : {}),
        });
      }
      send(404, { error: 'not_found' });
    });
  }
}

describe('ASAA single sign-on (OIDC code + PKCE) against a MOCK identity provider', () => {
  let idp: MockIdp;
  let config: OidcConfig;
  let sso: OidcSso;

  beforeEach(async () => {
    idp = new MockIdp();
    await idp.start();
    const result = readOidcConfig({ JARVIS_OIDC_ISSUER: idp.issuer, JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000);
    assert.equal(result.enabled, true);
    config = (result as { config: OidcConfig }).config;
    sso = new OidcSso(config);
  });

  afterEach(async () => { await idp.stop(); });

  /** Runs a full login with the given token/claim shape and returns the outcome. */
  async function login(shape: Partial<IssuedCode> & { code?: string } = {}, claims: Record<string, unknown> = idp.baseClaims()) {
    const started = await sso.beginLogin();
    const params = new URL(started.url).searchParams;
    const code = shape.code ?? `code-${randomUUID()}`;
    idp.codes.set(code, { nonce: params.get('nonce')!, challenge: params.get('code_challenge')!, claims, ...shape });
    return { started, params, code, run: () => sso.completeLogin(code, started.state) };
  }

  const rejects = async (promise: Promise<unknown>, expected: string) => {
    await assert.rejects(promise, (error: unknown) => error instanceof SsoError && error.code === expected, `expected SsoError ${expected}`);
  };

  test('configuration: enabled only with issuer and client id; https required unless loopback', () => {
    assert.deepEqual(readOidcConfig({}, 3000), { enabled: false, reason: 'not-configured' });
    assert.deepEqual(readOidcConfig({ JARVIS_OIDC_ISSUER: 'https://sso.example.com/realms/asaa' }, 3000), { enabled: false, reason: 'incomplete' });
    assert.deepEqual(readOidcConfig({ JARVIS_OIDC_ISSUER: 'http://sso.example.com/realms/asaa', JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000), { enabled: false, reason: 'insecure-issuer' });
    assert.equal(readOidcConfig({ JARVIS_OIDC_ISSUER: 'https://sso.example.com/realms/asaa', JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000).enabled, true);
    assert.equal(readOidcConfig({ JARVIS_OIDC_ISSUER: 'http://localhost:8280/realms/asaa', JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000).enabled, true);
    assert.equal(readOidcConfig({ JARVIS_OIDC_ISSUER: 'https://u:p@sso.example.com/r', JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000).enabled, false);
    assert.equal(readOidcConfig({ JARVIS_OIDC_ISSUER: 'not a url', JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000).enabled, false);
    const defaults = readOidcConfig({ JARVIS_OIDC_ISSUER: 'http://127.0.0.1:8280/realms/asaa/', JARVIS_OIDC_CLIENT_ID: CLIENT_ID }, 3000) as { config: OidcConfig };
    assert.equal(defaults.config.issuer, 'http://127.0.0.1:8280/realms/asaa');
    assert.equal(defaults.config.requiredRole, 'jarvis-owner');
    assert.deepEqual(defaults.config.requiredAmr, ['otp', 'mfa']);
    assert.equal(defaults.config.redirectUri, 'http://127.0.0.1:3000/auth/callback');
    const custom = readOidcConfig({ JARVIS_OIDC_ISSUER: 'http://127.0.0.1:8280/realms/asaa', JARVIS_OIDC_CLIENT_ID: CLIENT_ID, JARVIS_OIDC_REQUIRED_ROLE: 'staff', JARVIS_OIDC_REQUIRED_AMR: 'mfa', JARVIS_OIDC_ROLES_CLAIM: 'groups' }, 3000) as { config: OidcConfig };
    assert.deepEqual([custom.config.requiredRole, custom.config.requiredAmr, custom.config.rolesClaim], ['staff', ['mfa'], 'groups']);
    assert.equal(readOidcConfig({ JARVIS_OIDC_ISSUER: 'http://127.0.0.1:8280/realms/asaa', JARVIS_OIDC_CLIENT_ID: CLIENT_ID, JARVIS_OIDC_SCOPES: 'profile' }, 3000).enabled, false, 'openid scope is mandatory');
  });

  test('authorization URL uses code flow with PKCE S256, state and nonce', async () => {
    const { started, params } = await login();
    const url = new URL(started.url);
    assert.equal(url.origin + url.pathname, `${idp.issuer}/protocol/openid-connect/auth`);
    assert.equal(params.get('response_type'), 'code');
    assert.equal(params.get('client_id'), CLIENT_ID);
    assert.equal(params.get('redirect_uri'), 'http://127.0.0.1:3000/auth/callback');
    assert.equal(params.get('code_challenge_method'), 'S256');
    assert.match(params.get('code_challenge') ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.ok((params.get('state') ?? '').length >= 20 && (params.get('nonce') ?? '').length >= 20);
    assert.equal(params.get('state'), started.state);
  });

  test('a verified sign-in with MFA evidence and the required role yields the subject and username', async () => {
    const { run, started } = await login();
    const identity = await run();
    assert.deepEqual(identity, { sub: 'f3a1c2d4-0000-4000-8000-00000000abcd', username: 'alice' });
    const exchange = idp.tokenRequests.at(-1)!;
    assert.equal(exchange.get('grant_type'), 'authorization_code');
    assert.equal(exchange.get('client_id'), CLIENT_ID);
    assert.equal(exchange.get('client_secret'), null, 'public client: no secret is sent');
    assert.equal(createHash('sha256').update(exchange.get('code_verifier')!).digest('base64url'), new URL(started.url).searchParams.get('code_challenge'), 'PKCE verifier matches the S256 challenge');
  });

  test('roles may come from the verified access token when the ID token lacks them; mfa is accepted as amr', async () => {
    const claims = idp.baseClaims({ amr: ['mfa'] });
    delete claims.realm_access;
    const ok = await login({ accessClaims: idp.baseClaims({ aud: 'account' }) }, claims);
    assert.equal((await ok.run()).sub, claims.sub);
    const wrongSub = await login({ accessClaims: idp.baseClaims({ aud: 'account', sub: 'someone-else' }) }, claims);
    await rejects(wrongSub.run(), 'invalid_token');
    const noRoleAnywhere = await login({}, claims);
    await rejects(noRoleAnywhere.run(), 'role_required');
  });

  test('missing or insufficient MFA evidence is refused', async () => {
    await rejects((await login({}, idp.baseClaims({ amr: ['pwd'] }))).run(), 'mfa_required');
    const noAmr = idp.baseClaims();
    delete noAmr.amr;
    await rejects((await login({}, noAmr)).run(), 'mfa_required');
    await rejects((await login({}, idp.baseClaims({ amr: 'otp' }))).run(), 'mfa_required');
  });

  test('the required role is enforced and configurable', async () => {
    await rejects((await login({}, idp.baseClaims({ realm_access: { roles: ['offline_access'] } }))).run(), 'role_required');
    await rejects((await login({}, idp.baseClaims({ realm_access: { roles: 'jarvis-owner' } }))).run(), 'role_required');
    const staff = new OidcSso({ ...config, requiredRole: 'staff', requiredAmr: ['mfa'] });
    const started = await staff.beginLogin();
    const params = new URL(started.url).searchParams;
    idp.codes.set('staff-code', { nonce: params.get('nonce')!, challenge: params.get('code_challenge')!, claims: idp.baseClaims({ amr: ['mfa'], realm_access: { roles: ['staff'] } }) });
    assert.equal((await staff.completeLogin('staff-code', started.state)).sub, 'f3a1c2d4-0000-4000-8000-00000000abcd');
  });

  test('ID token verification: issuer, audience, authorized party, expiry, not-before, nonce and subject', async () => {
    await rejects((await login({}, idp.baseClaims({ iss: 'http://evil.example/realms/asaa' }))).run(), 'invalid_token');
    await rejects((await login({}, idp.baseClaims({ aud: 'another-client', azp: 'another-client' }))).run(), 'invalid_token');
    await rejects((await login({}, idp.baseClaims({ aud: [CLIENT_ID, 'other'], azp: 'other' }))).run(), 'invalid_token');
    const past = Math.floor(Date.now() / 1000) - 3600;
    await rejects((await login({}, idp.baseClaims({ iat: past - 60, exp: past }))).run(), 'invalid_token');
    await rejects((await login({}, idp.baseClaims({ nbf: Math.floor(Date.now() / 1000) + 3600 }))).run(), 'invalid_token');
    await rejects((await login({}, idp.baseClaims({ nonce: 'a-different-nonce' }))).run(), 'invalid_token');
    await rejects((await login({}, idp.baseClaims({ sub: '' }))).run(), 'invalid_token');
    const noSub = idp.baseClaims();
    delete noSub.sub;
    await rejects((await login({}, noSub)).run(), 'invalid_token');
  });

  test('signature verification: tampered payload, wrong key, unknown kid, alg none and HS256 are all rejected', async () => {
    const tampered = await login({
      mutate: (jwt) => { const [h, p, s] = jwt.split('.'); return `${h}.${b64({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), preferred_username: 'mallory', realm_access: { roles: ['jarvis-owner'] } })}.${s}`; },
    });
    await rejects(tampered.run(), 'invalid_token');
    await rejects((await login({ signWith: idp.otherKey.privateKey })).run(), 'invalid_token');
    await rejects((await login({ header: { kid: 'not-in-jwks' } })).run(), 'invalid_token');
    await rejects((await login({ mutate: (jwt) => { const [, p] = jwt.split('.'); return `${b64({ alg: 'none', typ: 'JWT' })}.${p}.`; } })).run(), 'invalid_token');
    await rejects((await login({ mutate: (jwt) => {
      const [, p] = jwt.split('.');
      const head = b64({ alg: 'HS256', typ: 'JWT', kid: idp.kid });
      return `${head}.${p}.${createHmac('sha256', 'guess').update(`${head}.${p}`).digest('base64url')}`;
    } })).run(), 'invalid_token');
    await rejects((await login({ mutate: () => 'not.a.jwt!' })).run(), 'invalid_token');
  });

  test('state is single-use and unknown states are refused; a bad code is an unavailable exchange', async () => {
    const first = await login();
    await first.run();
    await rejects(sso.completeLogin(first.code, first.started.state), 'invalid_state');
    await rejects(sso.completeLogin('whatever', 'unknown-state-value'), 'invalid_state');
    const badCode = await login();
    await rejects(sso.completeLogin('wrong-code', badCode.started.state), 'unavailable');
    await rejects(badCode.run(), 'invalid_state', 'a failed attempt still consumes the state');
  });

  test('a hostile discovery document (other origin or issuer) is refused', async () => {
    idp.discoveryOverride = (issuer) => ({ issuer, authorization_endpoint: `${issuer}/a`, token_endpoint: 'http://127.0.0.1:1/steal', jwks_uri: `${issuer}/certs` });
    await assert.rejects(new OidcSso(config).beginLogin(), (error: unknown) => error instanceof SsoError && error.code === 'unavailable');
    idp.discoveryOverride = () => ({ issuer: 'http://other.example/realms/asaa', authorization_endpoint: `${idp.issuer}/a`, token_endpoint: `${idp.issuer}/t`, jwks_uri: `${idp.issuer}/c` });
    await assert.rejects(new OidcSso(config).beginLogin(), (error: unknown) => error instanceof SsoError && error.code === 'unavailable');
  });

  test('server flow: login redirect, cookie-bound callback, attributed enrollment, owner token still works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-sso-'));
    const saved = { issuer: process.env.JARVIS_OIDC_ISSUER, client: process.env.JARVIS_OIDC_CLIENT_ID, owner: process.env.JARVIS_OWNER_CONTROL_TOKEN };
    process.env.JARVIS_OIDC_ISSUER = idp.issuer;
    process.env.JARVIS_OIDC_CLIENT_ID = CLIENT_ID;
    process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
    const port = await freePort();
    const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
    await server.start();
    const base = `http://127.0.0.1:${port}`;
    try {
      assert.deepEqual(await (await fetch(`${base}/api/sso/status`)).json(), { enabled: true });
      const begin = await fetch(`${base}/auth/sso/login`, { redirect: 'manual' });
      assert.equal(begin.status, 302);
      const location = new URL(begin.headers.get('location')!);
      assert.equal(location.origin + location.pathname, `${idp.issuer}/protocol/openid-connect/auth`);
      assert.equal(location.searchParams.get('redirect_uri'), `${base}/auth/callback`);
      const cookie = (begin.headers.get('set-cookie') ?? '').split(';')[0];
      assert.match(begin.headers.get('set-cookie') ?? '', /HttpOnly/);
      assert.match(begin.headers.get('set-cookie') ?? '', /SameSite=Lax/);
      const state = location.searchParams.get('state')!;
      assert.equal(cookie, `jarvis_sso=${state}`);
      const issueCode = (code: string, claims: Record<string, unknown> = idp.baseClaims()) =>
        idp.codes.set(code, { nonce: location.searchParams.get('nonce')!, challenge: location.searchParams.get('code_challenge')!, claims });

      // Without the cookie that started the login, the callback is refused (login CSRF defence) and consumes nothing useful.
      issueCode('code-1');
      const noCookie = await fetch(`${base}/auth/callback?code=code-1&state=${state}`, { redirect: 'manual' });
      assert.equal(noCookie.status, 302);
      assert.match(noCookie.headers.get('location')!, /sso_error=invalid_state/);

      // Valid sign-in: the challenge is handed over in the URL fragment and attributes the enrollment.
      const second = await fetch(`${base}/auth/sso/login`, { redirect: 'manual' });
      const loc2 = new URL(second.headers.get('location')!);
      const state2 = loc2.searchParams.get('state')!;
      idp.codes.set('code-2', { nonce: loc2.searchParams.get('nonce')!, challenge: loc2.searchParams.get('code_challenge')!, claims: idp.baseClaims() });
      const callback = await fetch(`${base}/auth/callback?code=code-2&state=${state2}`, { redirect: 'manual', headers: { cookie: `jarvis_sso=${state2}` } });
      assert.equal(callback.status, 302);
      const fragment = new URLSearchParams(new URL(callback.headers.get('location')!, base).hash.replace(/^#/, ''));
      const challengeToken = fragment.get('sso_challenge')!;
      assert.ok(challengeToken.length >= 16);
      assert.ok(Number(fragment.get('sso_expires')) > Date.now());
      assert.match(callback.headers.get('set-cookie') ?? '', /Max-Age=0/);

      const keys = CryptoUtil.generateEd25519KeyPair();
      const name = 'Alice laptop browser';
      const proof = CryptoUtil.signData(`ENROLLMENT_PROOF:${challengeToken}:${name}:${CryptoUtil.sha256(keys.publicKey)}`, keys.privateKey);
      const redeem = await (await fetch(`${base}/api/enrollment/redeem`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ challengeToken, deviceName: name, publicKey: keys.publicKey, proofSignature: proof }),
      })).json() as { success: boolean; deviceId: string };
      assert.equal(redeem.success, true);
      const device = server.getService().identity.getDevice(redeem.deviceId)!;
      assert.equal(device.ssoSub, 'f3a1c2d4-0000-4000-8000-00000000abcd');
      assert.equal(device.ssoUsername, 'alice');
      assert.ok(device.permissions.includes('device:manage:execute' as never));

      // The attribution is in the hash-chained audit log, and the chain is intact.
      const audit = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { eventType: string; details: Record<string, unknown> });
      const types = audit.map((entry) => entry.eventType);
      for (const type of ['SSO_LOGIN_FAILED', 'SSO_LOGIN_SUCCEEDED', 'ENROLLMENT_CHALLENGE_CREATED', 'DEVICE_ENROLLED']) assert.ok(types.includes(type), type);
      const enrolled = audit.find((entry) => entry.eventType === 'DEVICE_ENROLLED')!;
      assert.equal(enrolled.details.ssoSub, 'f3a1c2d4-0000-4000-8000-00000000abcd');
      assert.equal(enrolled.details.ssoUsername, 'alice');
      assert.equal(server.getService().audit.verifyIntegrity().valid, true);
      assert.equal(JSON.stringify(audit).includes('id_token'), false, 'no tokens in the audit log');

      // The challenge is single-use.
      const replayProof = CryptoUtil.signData(`ENROLLMENT_PROOF:${challengeToken}:${name}:${CryptoUtil.sha256(keys.publicKey)}`, keys.privateKey);
      const replay = await fetch(`${base}/api/enrollment/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken, deviceName: name, publicKey: keys.publicKey, proofSignature: replayProof }) });
      assert.equal(replay.status, 400);

      // IdP-side denial, and missing role, produce coarse error codes and no challenge.
      const third = await fetch(`${base}/auth/sso/login`, { redirect: 'manual' });
      const loc3 = new URL(third.headers.get('location')!);
      const state3 = loc3.searchParams.get('state')!;
      idp.codes.set('code-3', { nonce: loc3.searchParams.get('nonce')!, challenge: loc3.searchParams.get('code_challenge')!, claims: idp.baseClaims({ amr: ['pwd'] }) });
      const noMfa = await fetch(`${base}/auth/callback?code=code-3&state=${state3}`, { redirect: 'manual', headers: { cookie: `jarvis_sso=${state3}` } });
      assert.match(noMfa.headers.get('location')!, /sso_error=mfa_required/);
      assert.equal(noMfa.headers.get('location')!.includes('sso_challenge'), false);
      const fourth = await fetch(`${base}/auth/sso/login`, { redirect: 'manual' });
      const state4 = new URL(fourth.headers.get('location')!).searchParams.get('state')!;
      const denied = await fetch(`${base}/auth/callback?error=access_denied&state=${state4}`, { redirect: 'manual', headers: { cookie: `jarvis_sso=${state4}` } });
      assert.match(denied.headers.get('location')!, /sso_error=denied/);
    } finally {
      await server.stop();
      for (const [key, value] of [['JARVIS_OIDC_ISSUER', saved.issuer], ['JARVIS_OIDC_CLIENT_ID', saved.client], ['JARVIS_OWNER_CONTROL_TOKEN', saved.owner]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the owner-token enrollment path is unchanged when SSO is configured, and SSO is off when unconfigured', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jarvis-sso-off-'));
    const saved = { issuer: process.env.JARVIS_OIDC_ISSUER, client: process.env.JARVIS_OIDC_CLIENT_ID, owner: process.env.JARVIS_OWNER_CONTROL_TOKEN };
    process.env.JARVIS_OWNER_CONTROL_TOKEN = OWNER_TOKEN;
    process.env.JARVIS_OIDC_ISSUER = idp.issuer;
    process.env.JARVIS_OIDC_CLIENT_ID = CLIENT_ID;
    const port = await freePort();
    const server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'state.json'));
    await server.start();
    try {
      const challenge = await fetch(`http://127.0.0.1:${port}/api/enrollment/challenge`, { method: 'POST', headers: { 'x-owner-control-token': OWNER_TOKEN } });
      assert.equal(challenge.status, 201);
      const { challengeToken } = await challenge.json() as { challengeToken: string };
      const keys = CryptoUtil.generateEd25519KeyPair();
      const proof = CryptoUtil.signData(`ENROLLMENT_PROOF:${challengeToken}:Owner device:${CryptoUtil.sha256(keys.publicKey)}`, keys.privateKey);
      const redeem = await (await fetch(`http://127.0.0.1:${port}/api/enrollment/redeem`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken, deviceName: 'Owner device', publicKey: keys.publicKey, proofSignature: proof }) })).json() as { deviceId: string };
      const device = server.getService().identity.getDevice(redeem.deviceId)!;
      assert.equal(device.ssoSub, undefined, 'owner-token enrollment carries no SSO attribution');
    } finally {
      await server.stop();
    }
    delete process.env.JARVIS_OIDC_ISSUER;
    delete process.env.JARVIS_OIDC_CLIENT_ID;
    const offPort = await freePort();
    const off = new JarvisServer(offPort, join(dir, 'audit-off.log'), join(dir, 'state-off.json'));
    await off.start();
    try {
      assert.deepEqual(await (await fetch(`http://127.0.0.1:${offPort}/api/sso/status`)).json(), { enabled: false });
      assert.equal((await fetch(`http://127.0.0.1:${offPort}/auth/sso/login`, { redirect: 'manual' })).status, 404);
      assert.equal((await fetch(`http://127.0.0.1:${offPort}/auth/callback?code=x&state=y`, { redirect: 'manual' })).status, 404);
    } finally {
      await off.stop();
      for (const [key, value] of [['JARVIS_OIDC_ISSUER', saved.issuer], ['JARVIS_OIDC_CLIENT_ID', saved.client], ['JARVIS_OWNER_CONTROL_TOKEN', saved.owner]] as const) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
