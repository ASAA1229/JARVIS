/**
 * Artifact repository / CI provider contracts (JARVIS-GAP-023/024).
 *
 * No real Jenkins or Nexus integration exists here and none is enabled: the
 * "disabled" implementations refuse every call. A mock repository is provided so
 * the trust policy (immutable identity, checksum, provenance, explicit owner
 * authorization) can be tested without credentials or network access.
 */
import { createHash } from 'node:crypto';

export interface ArtifactIdentity {
  name: string;
  version: string;
  sha256: string;
  gitCommit: string;
  buildNumber: string;
}

export interface PublishAuthorization {
  /** Must be explicitly granted by the owner for this exact artifact digest. */
  ownerApprovedSha256: string;
}

export interface ArtifactRepository {
  readonly kind: string;
  publish(identity: ArtifactIdentity, bytes: Buffer, authorization: PublishAuthorization | undefined): Promise<{ location: string }>;
  retrieve(name: string, version: string, expectedSha256: string): Promise<Buffer>;
}

export class ExternalIntegrationDisabledError extends Error {
  constructor(kind: string) { super(`${kind} integration is not enabled: approved endpoint, credentials and trust policy are required.`); }
}

/** Real Nexus/Jenkins placeholders: fail closed until an owner-approved configuration exists. */
export class DisabledArtifactRepository implements ArtifactRepository {
  constructor(readonly kind: 'nexus' | 'jenkins') {}
  async publish(): Promise<{ location: string }> { throw new ExternalIntegrationDisabledError(this.kind); }
  async retrieve(): Promise<Buffer> { throw new ExternalIntegrationDisabledError(this.kind); }
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

export function validateIdentity(identity: ArtifactIdentity, bytes: Buffer): void {
  if (!NAME.test(identity.name) || !SEMVER.test(identity.version)) throw new Error('Artifact name or version is invalid.');
  if (!GIT_SHA.test(identity.gitCommit) || !/^[1-9]\d{0,9}$/.test(identity.buildNumber)) throw new Error('Artifact provenance (commit/build number) is invalid.');
  if (!/^[0-9a-f]{64}$/.test(identity.sha256) || identity.sha256 !== sha256(bytes)) throw new Error('Artifact checksum does not match its bytes.');
}

/** In-memory repository enforcing the trust policy; used for tests and dry runs only. */
export class MockArtifactRepository implements ArtifactRepository {
  readonly kind = 'mock';
  private readonly store = new Map<string, { identity: ArtifactIdentity; bytes: Buffer }>();

  async publish(identity: ArtifactIdentity, bytes: Buffer, authorization: PublishAuthorization | undefined): Promise<{ location: string }> {
    validateIdentity(identity, bytes);
    if (!authorization || authorization.ownerApprovedSha256 !== identity.sha256) throw new Error('Publication requires explicit owner authorization for this exact artifact digest.');
    const key = `${identity.name}@${identity.version}`;
    if (this.store.has(key)) throw new Error(`${key} is immutable and already published.`);
    this.store.set(key, { identity: { ...identity }, bytes: Buffer.from(bytes) });
    return { location: `mock://${key}` };
  }

  async retrieve(name: string, version: string, expectedSha256: string): Promise<Buffer> {
    const entry = this.store.get(`${name}@${version}`);
    if (!entry) throw new Error('Artifact not found.');
    // Trust is decided by the digest obtained through a separate authenticated channel, never by the repository.
    if (sha256(entry.bytes) !== expectedSha256) throw new Error('Retrieved artifact failed checksum verification; it was discarded.');
    return Buffer.from(entry.bytes);
  }

  /** Test hook simulating repository-side tampering. */
  tamper(name: string, version: string): void {
    const entry = this.store.get(`${name}@${version}`);
    if (entry) entry.bytes = Buffer.concat([entry.bytes, Buffer.from('x')]);
  }
}
