import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const integrity = path.join(root, 'scripts', 'artifact-integrity.mjs');
const verifier = path.join(root, 'scripts', 'customer-release-verifier.mjs');
const signer = path.join(root, 'scripts', 'policy-signature.mjs');
const tempDirs: string[] = [];

const run = (script: string, args: string[], ok = true, cwd = root) => {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8',
    env: {
      ...process.env,
      PROJECT_NAME: 'customer-test',
      REQUIRE_BUILD_PROVENANCE: 'false',
      // Keep failure reports out of the repository working tree.
      CUSTOMER_RELEASE_REPORT_PATH: path.join(cwd, 'customer-release-report.json'),
    },
  });
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

/** Package a directory like CI: a gzip tarball of the directory contents. */
function packDirectory(source: string, archive: string) {
  // Relative paths keep GNU tar on Windows from parsing "C:" as a remote host.
  const r = spawnSync('tar', ['-czf', path.basename(archive), '-C', path.relative(path.dirname(archive), source), '.'], {
    cwd: path.dirname(archive), encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
}

/** Manifest inventory describes `manifestContent`; the delivered archive holds `archiveContent`. */
function createRelease(manifestContent: string, archiveContent = manifestContent) {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'customer-release-'));
  tempDirs.push(temp);
  const dist = path.join(temp, 'dist');
  mkdirSync(dist);
  const artifact = path.join(temp, 'customer-package.tar.gz');
  writeFileSync(path.join(dist, 'app.js'), archiveContent);
  packDirectory(dist, artifact);
  writeFileSync(path.join(dist, 'app.js'), manifestContent);
  const manifest = path.join(temp, 'manifest.json');
  const policy = path.join(temp, 'manifest-ignore.json');
  const policySum = path.join(temp, 'manifest-ignore.json.sha256');
  run(integrity, ['create', dist, manifest, artifact]);
  run(verifier, ['create', manifest, artifact, policy]);
  run(integrity, ['hash', policy, policySum]);
  const trusted = createHash('sha256').update(readFileSync(policy)).digest('hex');
  return { temp, artifact, manifest, policy, policySum, trusted };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('customer release verification order', () => {
  it('verifies trusted manifest-ignore, manifest, package, then archive inventory', () => {
    const { temp, artifact, manifest, policy, policySum, trusted } = createRelease('release-content');
    const verify = (extra: string[], ok = true) =>
      run(verifier, ['verify', policy, policySum, manifest, artifact, ...extra], ok, temp);

    assert.match(verify([trusted]).stdout, /Stage 1 PASSED:[\s\S]*Stage 2 PASSED:[\s\S]*Stage 3 PASSED/);

    const original = readFileSync(artifact);
    writeFileSync(artifact, Buffer.concat([original, Buffer.from('tampered')]));
    assert.match(verify([trusted], false).stderr, /Package SHA-256 does not match policy and manifest/);
    writeFileSync(artifact, original);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const privatePath = path.join(temp, 'policy-private.pem'), publicPath = path.join(temp, 'policy-public.pem');
    const signaturePath = path.join(temp, 'manifest-ignore.sig');
    writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
    run(signer, ['sign', policy, signaturePath, privatePath]);
    assert.match(verify(['-', signaturePath, publicPath]).stdout, /Stage 1 PASSED:[\s\S]*Stage 2 PASSED:[\s\S]*Stage 3 PASSED/);

    const originalPolicy = readFileSync(policy);
    writeFileSync(policy, Buffer.concat([originalPolicy, Buffer.from(' ')]));
    rmSync(policySum, { force: true });
    run(integrity, ['hash', policy, policySum]);
    assert.match(verify(['-', signaturePath, publicPath], false).stderr, /Ed25519 signature verification failed/);
    writeFileSync(policy, originalPolicy);
    rmSync(policySum, { force: true });
    run(integrity, ['hash', policy, policySum]);
    assert.match(verify(['0'.repeat(64)], false).stderr, /trusted-digest verification failed/);
  });

  it('rejects an archive whose contents differ from the authenticated manifest inventory', () => {
    const { temp, artifact, manifest, policy, policySum, trusted } = createRelease('release-content', 'tampered-content');
    const result = run(verifier, ['verify', policy, policySum, manifest, artifact, trusted], false, temp);
    assert.match(result.stderr, /Package archive inventory failed/);
    assert.match(result.stderr, /MISMATCH: app\.js/);
    const report = JSON.parse(readFileSync(path.join(temp, 'customer-release-report.json'), 'utf8'));
    assert.equal(report.status, 'FAILED');
    assert.equal(report.stage, 'PACKAGE_ARCHIVE_VERIFICATION');
    assert.equal(report.code, 'ARCHIVE_INVENTORY_MISMATCH');
  });
});
