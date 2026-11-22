/**
 * Build-to-artifact handoff (D2.16 / D2.17).
 *
 * Joins the CI provider boundary and the artifact repository boundary without trusting either
 * for identity: provenance (commit, build number) is read from the CI provider and strictly
 * validated, the checksum is computed from the bytes being published, and publication needs
 * the owner's explicit approval of that exact digest. Retrieval verifies the digest obtained
 * through a separate channel. With the disabled providers every call fails closed.
 */
import { createHash } from 'node:crypto';
import type { CiProvider } from './ciProvider.js';
import { validateBuildIdentity } from './ciProvider.js';
import type { ArtifactIdentity, ArtifactRepository } from './artifactRepository.js';

export interface PublishRequest {
  buildNumber: string;
  name: string;
  version: string;
  bytes: Buffer;
  /** Owner-approved SHA-256 of these exact bytes. Absent means the publication is refused. */
  ownerApprovedSha256?: string;
}

export interface PublishedArtifact {
  identity: ArtifactIdentity;
  location: string;
}

export async function publishBuildArtifact(ci: CiProvider, repository: ArtifactRepository, request: PublishRequest): Promise<PublishedArtifact> {
  const build = validateBuildIdentity(await ci.getBuildIdentity(request.buildNumber));
  const identity: ArtifactIdentity = {
    name: request.name,
    version: request.version,
    sha256: createHash('sha256').update(request.bytes).digest('hex'),
    gitCommit: build.gitCommit,
    buildNumber: build.buildNumber,
  };
  const authorization = request.ownerApprovedSha256 ? { ownerApprovedSha256: request.ownerApprovedSha256 } : undefined;
  const { location } = await repository.publish(identity, request.bytes, authorization);
  return { identity, location };
}

/** Retrieve an artifact and verify it against the digest the caller trusts. */
export async function retrieveVerifiedArtifact(repository: ArtifactRepository, name: string, version: string, trustedSha256: string): Promise<Buffer> {
  if (!/^[0-9a-f]{64}$/.test(trustedSha256)) throw new Error('A trusted SHA-256 digest is required for retrieval.');
  return repository.retrieve(name, version, trustedSha256);
}
