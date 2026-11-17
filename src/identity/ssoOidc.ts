/**
 * Optional ASAA single sign-on for enrollment authorization (OIDC Authorization Code + PKCE S256).
 *
 * JARVIS is the confidential-free (public client) relying party and the redirect target. After a
 * verified sign-in it issues the SAME single-use enrollment challenge the owner token would; the
 * device/session model (Ed25519 keys, signed sessions) is unchanged and the owner-token path keeps
 * working. Enabled only when JARVIS_OIDC_ISSUER and JARVIS_OIDC_CLIENT_ID are both set.
 *
 * The ID token must verify (RS256 signature against the issuer JWKS; iss, aud, azp, exp, iat, nbf,
 * nonce), carry MFA evidence in `amr`, and the user must hold the required role. Nothing here
 * persists tokens: only the verified subject and username are used, then discarded.
 */
import { createHash, createPublicKey, randomBytes, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';

export type SsoFailureCode =
  | 'denied'
  | 'invalid_state'
  | 'invalid_token'
  | 'mfa_required'
  | 'role_required'
  | 'unavailable';

/** Failure with a coarse, user-safe code. The message is for audit only and never contains tokens. */
export class SsoError extends Error {
  constructor(readonly code: SsoFailureCode, message: string) {
    super(message);
    this.name = 'SsoError';
  }
}

export interface OidcConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  requiredRole: string;
  /** Any one of these `amr` values counts as MFA evidence. */
  requiredAmr: string[];
  /** Dotted path to the roles array in the token claims (Keycloak realm roles by default). */
  rolesClaim: string;
  scopes: string;
}

export type OidcConfigResult =
  | { enabled: true; config: OidcConfig }
  | { enabled: false; reason: 'not-configured' | 'incomplete' | 'invalid-issuer' | 'insecure-issuer' | 'invalid-client' | 'invalid-settings' };

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const SSO_CALLBACK_PATH = '/auth/callback';
export const SSO_LOGIN_PATH = '/auth/sso/login';

function isSecureOrLoopback(url: URL): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname));
}

export function readOidcConfig(env: NodeJS.ProcessEnv, port: number): OidcConfigResult {
  const issuerRaw = env.JARVIS_OIDC_ISSUER?.trim() ?? '';
  const clientId = env.JARVIS_OIDC_CLIENT_ID?.trim() ?? '';
  if (!issuerRaw && !clientId) return { enabled: false, reason: 'not-configured' };
  if (!issuerRaw || !clientId) return { enabled: false, reason: 'incomplete' };
  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuerRaw);
  } catch {
    return { enabled: false, reason: 'invalid-issuer' };
  }
  if (issuerUrl.username || issuerUrl.password || issuerUrl.search || issuerUrl.hash) return { enabled: false, reason: 'invalid-issuer' };
  // https is required unless the identity provider runs on this machine.
  if (!isSecureOrLoopback(issuerUrl)) return { enabled: false, reason: 'insecure-issuer' };
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(clientId)) return { enabled: false, reason: 'invalid-client' };
  const requiredRole = (env.JARVIS_OIDC_REQUIRED_ROLE?.trim() || 'jarvis-owner');
  const requiredAmr = (env.JARVIS_OIDC_REQUIRED_AMR?.trim() || 'otp,mfa').split(',').map((item) => item.trim()).filter(Boolean);
  const rolesClaim = env.JARVIS_OIDC_ROLES_CLAIM?.trim() || 'realm_access.roles';
  const scopes = env.JARVIS_OIDC_SCOPES?.trim() || 'openid profile';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(requiredRole) || requiredAmr.length === 0 || requiredAmr.some((item) => !/^[A-Za-z0-9._-]{1,32}$/.test(item)) ||
      !/^[A-Za-z0-9_.-]+(\.[A-Za-z0-9_-]+)*$/.test(rolesClaim) || !/^[A-Za-z0-9:_. -]{1,200}$/.test(scopes) || !scopes.split(' ').includes('openid')) {
    return { enabled: false, reason: 'invalid-settings' };
  }
  return {
    enabled: true,
    config: {
      issuer: issuerUrl.toString().replace(/\/+$/, ''),
      clientId,
      redirectUri: `http://127.0.0.1:${port}${SSO_CALLBACK_PATH}`,
      requiredRole,
      requiredAmr,
      rolesClaim,
      scopes,
    },
  };
}

export interface SsoIdentity {
  /** Stable subject identifier from the identity provider. */
  sub: string;
  username?: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface PendingLogin { nonce: string; verifier: string; createdAt: number }
interface Jwk extends JsonWebKey { kid?: string; use?: string; alg?: string }

const PENDING_TTL_MS = 10 * 60_000;
const MAX_PENDING = 50;
const MAX_TOKEN_BYTES = 16 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const CLOCK_SKEW_SECONDS = 60;
const DISCOVERY_TTL_MS = 10 * 60_000;
const JWKS_MIN_REFETCH_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function pathValue(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export interface OidcSsoOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class OidcSso {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly pending = new Map<string, PendingLogin>();
  private discovery: { value: Discovery; fetchedAt: number } | undefined;
  private jwks: { keys: Jwk[]; fetchedAt: number } | undefined;

  constructor(readonly config: OidcConfig, options: OidcSsoOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  // ------------------------------------------------------------ HTTP helpers

  private async getJson(url: string): Promise<Record<string, unknown>> {
    return this.readJsonResponse(await this.fetchImpl(url, { redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }));
  }

  private async readJsonResponse(response: Response): Promise<Record<string, unknown>> {
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new SsoError('unavailable', 'Identity provider response is too large.');
    if (!response.ok) throw new SsoError('unavailable', `Identity provider returned HTTP ${response.status}.`);
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new SsoError('unavailable', 'Identity provider returned invalid JSON.'); }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SsoError('unavailable', 'Identity provider returned an unexpected body.');
    return parsed as Record<string, unknown>;
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) return this.discovery.value;
    let doc: Record<string, unknown>;
    try {
      doc = await this.getJson(`${this.config.issuer}/.well-known/openid-configuration`);
    } catch (error) {
      if (error instanceof SsoError) throw error;
      throw new SsoError('unavailable', 'Identity provider is unreachable.');
    }
    if (doc.issuer !== this.config.issuer) throw new SsoError('unavailable', 'Discovery issuer does not match the configured issuer.');
    const origin = new URL(this.config.issuer).origin;
    const endpoints: Record<string, string> = {};
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
      const value = doc[key];
      let parsed: URL | undefined;
      try { parsed = typeof value === 'string' ? new URL(value) : undefined; } catch { parsed = undefined; }
      // Endpoints must be secure (or loopback) and on the issuer's origin: a hostile discovery
      // document cannot redirect codes or key fetches elsewhere.
      if (!parsed || !isSecureOrLoopback(parsed) || parsed.origin !== origin) throw new SsoError('unavailable', `Discovery ${key} is not acceptable.`);
      endpoints[key] = parsed.toString();
    }
    const value: Discovery = { issuer: this.config.issuer, authorization_endpoint: endpoints.authorization_endpoint, token_endpoint: endpoints.token_endpoint, jwks_uri: endpoints.jwks_uri };
    this.discovery = { value, fetchedAt: this.now() };
    return value;
  }

  private async loadJwks(force: boolean): Promise<Jwk[]> {
    if (this.jwks && !force && this.now() - this.jwks.fetchedAt < DISCOVERY_TTL_MS) return this.jwks.keys;
    if (force && this.jwks && this.now() - this.jwks.fetchedAt < JWKS_MIN_REFETCH_MS) return this.jwks.keys;
    const { jwks_uri } = await this.discover();
    let doc: Record<string, unknown>;
    try { doc = await this.getJson(jwks_uri); } catch (error) {
      if (error instanceof SsoError) throw error;
      throw new SsoError('unavailable', 'Identity provider keys are unreachable.');
    }
    const keys = Array.isArray(doc.keys) ? (doc.keys.filter((key) => key && typeof key === 'object') as Jwk[]) : [];
    this.jwks = { keys, fetchedAt: this.now() };
    return keys;
  }

  // ------------------------------------------------------------ login flow

  private prune(): void {
    const cutoff = this.now() - PENDING_TTL_MS;
    for (const [state, entry] of this.pending) if (entry.createdAt < cutoff) this.pending.delete(state);
    while (this.pending.size >= MAX_PENDING) {
      const oldest = this.pending.keys().next().value;
      if (oldest === undefined) break;
      this.pending.delete(oldest);
    }
  }

  /** Starts a login: returns the IdP authorization URL (PKCE S256) and the state used to bind the browser. */
  async beginLogin(): Promise<{ url: string; state: string }> {
    const discovery = await this.discover();
    this.prune();
    const state = base64url(randomBytes(24));
    const nonce = base64url(randomBytes(24));
    const verifier = base64url(randomBytes(48));
    this.pending.set(state, { nonce, verifier, createdAt: this.now() });
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.config.redirectUri);
    url.searchParams.set('scope', this.config.scopes);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', base64url(createHash('sha256').update(verifier).digest()));
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state };
  }

  /** Whether a pending login exists for this state (does not consume it). */
  hasPending(state: string): boolean {
    const entry = this.pending.get(state);
    return Boolean(entry && this.now() - entry.createdAt < PENDING_TTL_MS);
  }

  /** Completes a login. The state is single-use: it is consumed whether or not verification succeeds. */
  async completeLogin(code: string, state: string): Promise<SsoIdentity> {
    const entry = this.pending.get(state);
    this.pending.delete(state);
    if (!entry || this.now() - entry.createdAt >= PENDING_TTL_MS) throw new SsoError('invalid_state', 'Unknown or expired login state.');
    if (typeof code !== 'string' || code.length === 0 || code.length > 2048) throw new SsoError('invalid_state', 'Invalid authorization code.');
    const discovery = await this.discover();
    let tokens: Record<string, unknown>;
    try {
      const response = await this.fetchImpl(discovery.token_endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: this.config.redirectUri,
          client_id: this.config.clientId,
          code_verifier: entry.verifier,
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      tokens = await this.readJsonResponse(response);
    } catch (error) {
      if (error instanceof SsoError) throw new SsoError('unavailable', error.message);
      throw new SsoError('unavailable', 'Token exchange failed.');
    }
    const idToken = tokens.id_token;
    if (typeof idToken !== 'string') throw new SsoError('invalid_token', 'The token response has no ID token.');
    const claims = await this.verifyJwt(idToken);
    this.checkClaims(claims, entry.nonce);

    // MFA evidence: the amr claim must contain one of the accepted methods.
    const amr = Array.isArray(claims.amr) ? claims.amr.filter((item): item is string => typeof item === 'string') : [];
    if (!this.config.requiredAmr.some((accepted) => amr.includes(accepted))) throw new SsoError('mfa_required', 'No MFA evidence in the ID token.');

    // Roles: from the ID token, else from the (verified) access token.
    let roles = pathValue(claims, this.config.rolesClaim);
    if (!Array.isArray(roles) && typeof tokens.access_token === 'string') {
      const accessClaims = await this.verifyJwt(tokens.access_token);
      if (accessClaims.sub !== claims.sub || (accessClaims.azp !== undefined && accessClaims.azp !== this.config.clientId)) {
        throw new SsoError('invalid_token', 'The access token does not belong to this sign-in.');
      }
      this.checkTimes(accessClaims);
      roles = pathValue(accessClaims, this.config.rolesClaim);
    }
    if (!Array.isArray(roles) || !roles.includes(this.config.requiredRole)) throw new SsoError('role_required', 'The required role is missing.');

    const username = typeof claims.preferred_username === 'string' ? claims.preferred_username.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 100) : undefined;
    return { sub: claims.sub as string, ...(username ? { username } : {}) };
  }

  // ------------------------------------------------------------ token verification

  private checkTimes(claims: Record<string, unknown>): void {
    const nowSeconds = Math.floor(this.now() / 1000);
    if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) throw new SsoError('invalid_token', 'The token has expired.');
    if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) throw new SsoError('invalid_token', 'The token is not yet valid.');
    if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds)) throw new SsoError('invalid_token', 'The token was issued in the future.');
  }

  private checkClaims(claims: Record<string, unknown>, expectedNonce: string): void {
    if (claims.iss !== this.config.issuer) throw new SsoError('invalid_token', 'Issuer mismatch.');
    const audience = claims.aud;
    const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
    if (!audiences.includes(this.config.clientId)) throw new SsoError('invalid_token', 'Audience mismatch.');
    if (audiences.length > 1 && claims.azp !== this.config.clientId) throw new SsoError('invalid_token', 'Authorized party mismatch.');
    this.checkTimes(claims);
    if (typeof claims.nonce !== 'string' || claims.nonce !== expectedNonce) throw new SsoError('invalid_token', 'Nonce mismatch.');
    if (typeof claims.sub !== 'string' || claims.sub.length === 0 || claims.sub.length > 255 || /[\u0000-\u001f\u007f]/.test(claims.sub)) throw new SsoError('invalid_token', 'Invalid subject.');
  }

  /** Verifies an RS256 JWT signature against the issuer JWKS and returns its claims (claims are checked separately). */
  private async verifyJwt(token: string): Promise<Record<string, unknown>> {
    if (token.length > MAX_TOKEN_BYTES) throw new SsoError('invalid_token', 'The token is too large.');
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]*$/.test(part))) throw new SsoError('invalid_token', 'Malformed token.');
    let header: Record<string, unknown>;
    let claims: unknown;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as Record<string, unknown>;
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      throw new SsoError('invalid_token', 'Malformed token.');
    }
    // Only RS256 is accepted: "none" and symmetric algorithms are rejected outright.
    if (header.alg !== 'RS256' || claims === null || typeof claims !== 'object' || Array.isArray(claims)) throw new SsoError('invalid_token', 'Unsupported token algorithm.');
    const kid = typeof header.kid === 'string' ? header.kid : undefined;
    const findKey = (keys: Jwk[]): Jwk | undefined => keys.find((key) => key.kty === 'RSA' && (key.use === undefined || key.use === 'sig') &&
      (key.alg === undefined || key.alg === 'RS256') && (kid === undefined ? keys.length === 1 : key.kid === kid));
    let jwk = findKey(await this.loadJwks(false));
    if (!jwk) jwk = findKey(await this.loadJwks(true));
    if (!jwk) throw new SsoError('invalid_token', 'No matching signing key.');
    let valid = false;
    try {
      const publicKey = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' });
      valid = cryptoVerify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'));
    } catch {
      valid = false;
    }
    if (!valid) throw new SsoError('invalid_token', 'Invalid token signature.');
    return claims as Record<string, unknown>;
  }
}
