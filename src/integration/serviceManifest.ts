/**
 * ASAA ecosystem service manifest v1 (contracts/asaa-ecosystem/v1/service-manifest.schema.json).
 *
 * Served unauthenticated at GET /.well-known/asaa-service, so it exposes only coarse, secret-free
 * facts: a service id, version, optional build commit, and named check values. Never device
 * ids, counts, paths, ports, keys or connection strings.
 */
import { readFileSync } from 'node:fs';

export type CheckValue = 'ok' | 'degraded' | 'down' | 'disabled';
export type ManifestEnvironment = 'development' | 'test' | 'staging' | 'production' | 'local-prod';

export interface ServiceManifest {
  schema: 'asaa.service-manifest.v1';
  service: 'jarvis';
  project: 'JARVIS';
  version: string;
  commit: string | null;
  environment: ManifestEnvironment;
  status: 'ok' | 'degraded' | 'down';
  checkedAt: string;
  checks: Record<string, CheckValue>;
  capabilities: string[];
  contracts: Record<string, string>;
}

export const MANIFEST_CAPABILITIES = ['assistant', 'ai.chat-completions', 'developer-assistant', 'events.produce'] as const;

const ENVIRONMENTS: readonly ManifestEnvironment[] = ['development', 'test', 'staging', 'production', 'local-prod'];

let cachedVersion: string | undefined;
/** Version from package.json (two levels above src/integration and dist/integration). */
export function packageVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion;
  try {
    const parsed = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    cachedVersion = typeof parsed.version === 'string' && parsed.version.length <= 64 ? parsed.version : '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}

export function manifestEnvironment(env: NodeJS.ProcessEnv = process.env): ManifestEnvironment {
  const configured = env.JARVIS_ENVIRONMENT?.trim();
  if (configured && (ENVIRONMENTS as readonly string[]).includes(configured)) return configured as ManifestEnvironment;
  return env.NODE_ENV === 'test' ? 'test' : 'development';
}

export function manifestCommit(env: NodeJS.ProcessEnv = process.env): string | null {
  const commit = env.JARVIS_BUILD_COMMIT?.trim().toLowerCase();
  return commit && /^[0-9a-f]{7,40}$/.test(commit) ? commit : null;
}

export interface ManifestInputs {
  auditIntegrity: boolean;
  identityState: boolean;
  /** Cached provider status of the local Ollama provider; undefined or not configured means disabled. */
  ollama: { configured: boolean; available: boolean } | undefined;
  aiGatewayRunning: boolean;
  asaaEvents: CheckValue;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export function buildServiceManifest(input: ManifestInputs): ServiceManifest {
  const env = input.env ?? process.env;
  const checks: Record<string, CheckValue> = {
    auditIntegrity: input.auditIntegrity ? 'ok' : 'down',
    identityState: input.identityState ? 'ok' : 'down',
    ollama: !input.ollama || !input.ollama.configured ? 'disabled' : input.ollama.available ? 'ok' : 'down',
    aiGateway: input.aiGatewayRunning ? 'ok' : 'disabled',
    asaaEvents: input.asaaEvents,
  };
  // Same rule as /api/status: a failed audit/identity check degrades (never hides) the service.
  const degraded = Object.values(checks).some((value) => value === 'down' || value === 'degraded');
  return {
    schema: 'asaa.service-manifest.v1',
    service: 'jarvis',
    project: 'JARVIS',
    version: packageVersion(),
    commit: manifestCommit(env),
    environment: manifestEnvironment(env),
    status: degraded ? 'degraded' : 'ok',
    checkedAt: (input.now ?? new Date()).toISOString(),
    checks,
    capabilities: [...MANIFEST_CAPABILITIES],
    contracts: { serviceManifest: 'v1', eventEnvelope: 'v1' },
  };
}
