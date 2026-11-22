/**
 * CI provider boundary (Jenkins build-to-manifest handoff, JARVIS-GAP-023).
 *
 * No live Jenkins integration exists. The provider factory ALWAYS returns the disabled,
 * fail-closed provider: environment variables that look like Jenkins configuration
 * (JENKINS_URL, tokens) never enable it. Build identity is accepted only when it is complete
 * and explicit; release coordinates (customer/product/version/release) are never inferred
 * from branch names or artifact paths, as the operations guide requires.
 */
export interface CiBuildIdentity {
  gitCommit: string;
  buildNumber: string;
  runUrl: string;
  repository: string;
}

export interface CiProvider {
  /** 'jenkins' is always the disabled boundary; 'mock' is a local in-memory implementation. */
  readonly kind: 'jenkins' | 'mock';
  readonly enabled: boolean;
  /** Read the immutable identity of a finished build. Disabled: always refuses. */
  getBuildIdentity(buildNumber: string): Promise<CiBuildIdentity>;
  /** Trigger a build. Disabled: always refuses. */
  triggerBuild(parameters: Record<string, string>): Promise<{ buildNumber: string }>;
}

export class CiIntegrationDisabledError extends Error {
  constructor(action: string) {
    super(`Jenkins integration is not enabled (${action}): an approved controller, pipeline definition, credentials and trust policy are required. Nothing was contacted.`);
  }
}

export class DisabledCiProvider implements CiProvider {
  readonly kind = 'jenkins' as const;
  readonly enabled = false as const;
  async getBuildIdentity(): Promise<CiBuildIdentity> { throw new CiIntegrationDisabledError('getBuildIdentity'); }
  async triggerBuild(): Promise<{ buildNumber: string }> { throw new CiIntegrationDisabledError('triggerBuild'); }
}

/**
 * Local, deterministic CI provider for development and dry runs (D2.16). It performs no network
 * or process access: "triggering" a build records an immutable identity from explicitly supplied
 * commit/repository parameters. It exists so the build-to-manifest handoff can be exercised
 * without a Jenkins controller; it is never a substitute for a real approved controller.
 */
export class MockCiProvider implements CiProvider {
  readonly kind = 'mock' as const;
  readonly enabled = true;
  private readonly builds = new Map<string, CiBuildIdentity>();
  private next = 1;

  async getBuildIdentity(buildNumber: string): Promise<CiBuildIdentity> {
    const identity = this.builds.get(buildNumber);
    if (!identity) throw new Error(`Mock CI has no build ${buildNumber}.`);
    return { ...identity };
  }

  async triggerBuild(parameters: Record<string, string>): Promise<{ buildNumber: string }> {
    const buildNumber = String(this.next);
    const identity = validateBuildIdentity({
      gitCommit: parameters['GIT_COMMIT'],
      repository: parameters['REPOSITORY'],
      buildNumber,
      runUrl: `http://localhost/mock-ci/job/${buildNumber}/`,
    });
    this.next += 1;
    this.builds.set(buildNumber, identity);
    return { buildNumber };
  }
}

/**
 * The real Jenkins provider can never be enabled from environment variables: Jenkins-looking
 * configuration is ignored. Only the explicit, local-only JARVIS_CI_PROVIDER=mock selects the mock.
 */
export function createCiProvider(env: Record<string, string | undefined> = process.env): CiProvider {
  if (env['JARVIS_CI_PROVIDER'] === 'mock') return new MockCiProvider();
  return new DisabledCiProvider();
}

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** Strict validation of a build identity supplied by a CI system. Throws on anything incomplete or ambiguous. */
export function validateBuildIdentity(identity: Partial<CiBuildIdentity>): CiBuildIdentity {
  if (!/^[0-9a-f]{40}$/.test(identity.gitCommit ?? '')) throw new Error('Build identity requires the full 40-character Git commit.');
  if (!/^[1-9]\d{0,9}$/.test(identity.buildNumber ?? '')) throw new Error('Build identity requires a positive numeric build number.');
  let url: URL;
  try { url = new URL(identity.runUrl ?? ''); } catch { throw new Error('Build identity requires a valid run URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Run URL must be http(s) without credentials, query or fragment.');
  if (!REPOSITORY.test(identity.repository ?? '')) throw new Error('Build identity requires an explicit owner/repository.');
  return { gitCommit: identity.gitCommit!, buildNumber: identity.buildNumber!, runUrl: url.toString(), repository: identity.repository! };
}

export interface ReleaseCoordinates { customer: string; product: string; version: string; release: string }

/**
 * Manifest inputs come only from explicitly supplied coordinates. A branch name or artifact
 * path is never a source: passing coordinates that merely echo the branch is rejected.
 */
export function manifestInputs(identity: CiBuildIdentity, coordinates: Partial<ReleaseCoordinates> | undefined, branch?: string): CiBuildIdentity & ReleaseCoordinates {
  const verified = validateBuildIdentity(identity);
  if (!coordinates) throw new Error('Authoritative release coordinates (customer, product, version, release) must be supplied; they are never inferred.');
  for (const key of ['customer', 'product', 'version', 'release'] as const) {
    const value = coordinates[key];
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`Release coordinate "${key}" is missing or invalid.`);
    if (branch && value.toLowerCase() === branch.toLowerCase().replace(/^origin\//, '')) throw new Error(`Release coordinate "${key}" must not be derived from the branch name.`);
  }
  return { ...verified, ...(coordinates as ReleaseCoordinates) };
}
