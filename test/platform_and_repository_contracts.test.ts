import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { VerificationOutcome } from '../src/core/types.js';
import { selectPlatformAdapter, platformFromNode, UnsupportedPlatformAdapter, type PlatformOperation } from '../src/platform/platformAdapters.js';
import { DisabledArtifactRepository, MockArtifactRepository, ExternalIntegrationDisabledError, type ArtifactIdentity } from '../src/release/artifactRepository.js';

/** JARVIS-GAP-019/020 (fail-closed contracts only) and GAP-023/024 (disabled providers + local trust policy). */
const OPERATIONS: PlatformOperation[] = ['app:launch', 'desktop:list_windows', 'desktop:focus_window', 'system:get_info'];

test('macOS and Linux adapters fail closed for every operation and list what native work remains', async () => {
  for (const nodePlatform of ['darwin', 'linux']) {
    let executorCalled = false;
    const adapter = selectPlatformAdapter(nodePlatform, async () => { executorCalled = true; return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS }; });
    const info = adapter.describe();
    assert.equal(info.implemented, false);
    assert.deepEqual(info.supportedOperations, []);
    assert.ok(info.blockers.length >= 2);
    for (const operation of OPERATIONS) {
      const result = await adapter.execute(operation, {});
      assert.equal(result.success, false);
      assert.equal(result.outcome, VerificationOutcome.VERIFIED_FAILURE);
      assert.equal((result.evidence as { attempted: boolean }).attempted, false);
    }
    assert.equal(executorCalled, false, 'the Windows executor is never reached on another OS');
  }
  assert.match(new UnsupportedPlatformAdapter('macos').describe().blockers.join(' '), /Accessibility/);
  assert.match(new UnsupportedPlatformAdapter('linux').describe().blockers.join(' '), /portal/);
});

test('Windows delegates to its executor only for declared operations; unknown hosts are rejected', async () => {
  const calls: string[] = [];
  const adapter = selectPlatformAdapter('win32', async (operation) => { calls.push(operation); return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS }; });
  assert.equal(adapter.describe().implemented, true);
  assert.equal((await adapter.execute('app:launch', { appId: 'notepad' })).success, true);
  assert.equal((await adapter.execute('terminal:run' as PlatformOperation, {})).success, false);
  assert.deepEqual(calls, ['app:launch']);
  assert.throws(() => selectPlatformAdapter('freebsd', async () => ({ success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS })), /Unsupported host platform/);
  assert.equal(platformFromNode('aix'), undefined);
});

const bytes = Buffer.from('release-bundle-bytes');
const identity = (overrides: Partial<ArtifactIdentity> = {}): ArtifactIdentity => ({
  name: 'jarvis-build', version: '0.1.0', sha256: createHash('sha256').update(bytes).digest('hex'), gitCommit: 'a'.repeat(40), buildNumber: '42', ...overrides,
});

test('Jenkins and Nexus providers are disabled: they refuse every call until an approved configuration exists', async () => {
  for (const kind of ['nexus', 'jenkins'] as const) {
    const repo = new DisabledArtifactRepository(kind);
    await assert.rejects(repo.publish(), ExternalIntegrationDisabledError);
    await assert.rejects(repo.retrieve(), /not enabled.*credentials/);
  }
});

test('trust policy: publication needs owner authorization for the exact digest, valid provenance, and is immutable', async () => {
  const repo = new MockArtifactRepository();
  await assert.rejects(repo.publish(identity(), bytes, undefined), /explicit owner authorization/);
  await assert.rejects(repo.publish(identity(), bytes, { ownerApprovedSha256: 'f'.repeat(64) }), /explicit owner authorization/);
  for (const bad of [{ gitCommit: 'abc' }, { buildNumber: '0' }, { buildNumber: 'x1' }, { version: '1.0' }, { name: '../evil' }, { sha256: 'b'.repeat(64) }]) {
    await assert.rejects(repo.publish(identity(bad), bytes, { ownerApprovedSha256: identity(bad).sha256 }), /invalid|checksum/, JSON.stringify(bad));
  }
  const ok = await repo.publish(identity(), bytes, { ownerApprovedSha256: identity().sha256 });
  assert.equal(ok.location, 'mock://jarvis-build@0.1.0');
  await assert.rejects(repo.publish(identity(), bytes, { ownerApprovedSha256: identity().sha256 }), /immutable/);
});

test('retrieval is verified against an out-of-band digest and tampered artifacts are discarded', async () => {
  const repo = new MockArtifactRepository();
  await repo.publish(identity(), bytes, { ownerApprovedSha256: identity().sha256 });
  assert.deepEqual(await repo.retrieve('jarvis-build', '0.1.0', identity().sha256), bytes);
  await assert.rejects(repo.retrieve('jarvis-build', '0.1.0', 'c'.repeat(64)), /checksum verification/);
  await assert.rejects(repo.retrieve('missing', '0.1.0', identity().sha256), /not found/);
  repo.tamper('jarvis-build', '0.1.0');
  await assert.rejects(repo.retrieve('jarvis-build', '0.1.0', identity().sha256), /checksum verification/);
});
