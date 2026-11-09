import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrity = path.join(root, 'scripts', 'artifact-integrity.mjs');
const verifier = path.join(root, 'scripts', 'customer-release-verifier.mjs');
const signer = path.join(root, 'scripts', 'policy-signature.mjs');
const run = (script: string, args: string[], ok = true) => {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8',
    env: { ...process.env, PROJECT_NAME: 'customer-test', REQUIRE_BUILD_PROVENANCE: 'false' } });
  assert.equal(r.status === 0, ok, r.stderr || r.stdout);
  return r;
};

const packDirectory = (source: string, archive: string) => {
  const r = spawnSync('tar', ['-czf', path.basename(archive), '-C', path.relative(path.dirname(archive), source), '.'], {
    cwd: path.dirname(archive),
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
};

describe('customer release verification order', () => {
  it('verifies trusted manifest-ignore, manifest, package, then inventory', () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'customer-release-'));
    try {
      const dist = path.join(temp, 'dist'); mkdirSync(dist);
      writeFileSync(path.join(dist, 'app.js'), 'release-content');
      const artifact = path.join(temp, 'customer-package.tar.gz');
      packDirectory(dist, artifact);
      const manifest = path.join(temp, 'manifest.json');
      const policy = path.join(temp, 'manifest-ignore.json');
      const policySum = path.join(temp, 'manifest-ignore.json.sha256');
      run(integrity, ['create', dist, manifest, artifact]);
      run(verifier, ['create', manifest, artifact, policy]);
      run(integrity, ['hash', policy, policySum]);
      const trusted = createHash('sha256').update(readFileSync(policy)).digest('hex');
      const good = run(verifier, ['verify', policy, policySum, manifest, artifact, trusted]);
      assert.match(good.stdout, /Stage 1 PASSED:[\s\S]*Stage 2 PASSED:[\s\S]*Stage 3 PASSED/);

      const originalArtifact = readFileSync(artifact);
      writeFileSync(artifact, Buffer.concat([originalArtifact, Buffer.from('tampered')]));
      const badPkg = run(verifier, ['verify', policy, policySum, manifest, artifact, trusted], false);
      assert.match(badPkg.stderr, /Package SHA-256 does not match/);
      writeFileSync(artifact, originalArtifact);

      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const privatePath = path.join(temp, 'policy-private.pem'), publicPath = path.join(temp, 'policy-public.pem');
      const signaturePath = path.join(temp, 'manifest-ignore.sig');
      writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
      writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
      run(signer, ['sign', policy, signaturePath, privatePath]);
      const signedGood = run(verifier, ['verify', policy, policySum, manifest, artifact, '-', signaturePath, publicPath]);
      assert.match(signedGood.stdout, /Stage 1 PASSED:[\s\S]*Stage 2 PASSED:[\s\S]*Stage 3 PASSED/);
      const originalPolicy = readFileSync(policy);
      writeFileSync(policy, Buffer.concat([originalPolicy, Buffer.from(' ')]));
      rmSync(policySum, { force: true });
      run(integrity, ['hash', policy, policySum]);
      const signedTamper = run(verifier, ['verify', policy, policySum, manifest, artifact, '-', signaturePath, publicPath], false);
      assert.match(signedTamper.stderr, /Ed25519 signature verification failed/);
      writeFileSync(policy, originalPolicy);
      rmSync(policySum, { force: true });
      run(integrity, ['hash', policy, policySum]);
      run(verifier, ['verify', policy, policySum, manifest, artifact, '0'.repeat(64)], false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
