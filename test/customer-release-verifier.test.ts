import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrity = path.join(root, 'scripts', 'artifact-integrity.mjs');
const verifier = path.join(root, 'scripts', 'customer-release-verifier.mjs');
const run = (script: string, args: string[], ok = true) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PROJECT_NAME: 'customer-test', REQUIRE_BUILD_PROVENANCE: 'false' } });
  assert.equal(r.status === 0, ok, r.stderr || r.stdout);
  return r;
};

describe('customer release verification order', () => {
  it('verifies trusted manifest-ignore, manifest, package, then inventory', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'customer-release-'));
    try {
      const dist = path.join(temp, 'dist'); mkdirSync(dist);
      writeFileSync(path.join(dist, 'app.js'), 'release-content');
      const artifact = path.join(temp, 'customer-package.tar.gz');
      writeFileSync(artifact, 'archive-content');
      const manifest = path.join(temp, 'manifest.json');
      const policy = path.join(temp, 'manifest-ignore.json');
      const policySum = path.join(temp, 'manifest-ignore.json.sha256');
      run(integrity, ['create', dist, manifest, artifact]);
      run(verifier, ['create', manifest, artifact, policy]);
      run(integrity, ['hash', policy, policySum]);
      const trusted = createHash('sha256').update(readFileSync(policy)).digest('hex');
      const good = run(verifier, ['verify', policy, policySum, manifest, artifact, dist, trusted]);
      assert.match(good.stdout, /Stage 1 PASSED:[\s\S]*Stage 2 PASSED:[\s\S]*Stage 3 PASSED/);

      writeFileSync(path.join(dist, 'app.js'), 'tampered-content');
      const badInventory = run(verifier, ['verify', policy, policySum, manifest, artifact, dist, trusted], false);
      assert.match(badInventory.stderr, /Package inventory failed/);

      writeFileSync(path.join(dist, 'app.js'), 'release-content');
      run(verifier, ['verify', policy, policySum, manifest, artifact, dist, '0'.repeat(64)], false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
