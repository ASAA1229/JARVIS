#!/usr/bin/env node
/**
 * Signed release bundle: artifact + SBOM + checksums + Ed25519 signature (JARVIS-GAP-018).
 *
 *   JARVIS_RELEASE_SIGNING_KEY="<PEM>" node scripts/release-bundle.mjs create <artifact> <sbom.json> <out.jvbundle> [--commit SHA --build N --project NAME]
 *   JARVIS_RELEASE_PUBLIC_KEY="<PEM>"  node scripts/release-bundle.mjs verify <bundle.jvbundle> [package-lock.json]
 *   node scripts/release-bundle.mjs keygen <private.pem> <public.pem>      (local/test convenience)
 *
 * The production private key is supplied only through the environment and is never
 * written to disk or committed. Verification trusts ONLY the public key supplied by the
 * verifier (env or file), never the key embedded in the bundle. Verification is clean-room:
 * everything is extracted into a fresh temp directory and re-hashed from the extracted bytes.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifySbom } from './sbom-verify.mjs';

const MAX_BYTES = 256 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const fail = (message) => { throw new Error(message); };

/** Canonical signed statement: stable key order, no embedded payloads. */
export function signedStatement(bundle) {
  const { meta, artifact, sbom } = bundle;
  return Buffer.from(JSON.stringify({
    version: 1,
    meta: { project: meta.project, gitCommit: meta.gitCommit, buildNumber: meta.buildNumber, createdAt: meta.createdAt },
    artifact: { name: artifact.name, size: artifact.size, sha256: artifact.sha256 },
    sbom: { name: sbom.name, size: sbom.size, sha256: sbom.sha256 },
  }));
}

export function generateKeyPem() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}

export function createBundle({ artifactName, artifactBytes, sbomBytes, privateKeyPem, project = 'JARVIS', gitCommit, buildNumber, now = Date.now() }) {
  if (!privateKeyPem) fail('A release signing key is required (set JARVIS_RELEASE_SIGNING_KEY).');
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ed25519') fail('Release signing key must be Ed25519.');
  if (!NAME.test(artifactName)) fail('Artifact name is invalid.');
  if (!/^[0-9a-f]{40}$/.test(gitCommit ?? '')) fail('A full 40-character git commit is required.');
  if (!/^[1-9]\d{0,9}$/.test(String(buildNumber ?? ''))) fail('A positive build number is required.');
  if (artifactBytes.length === 0 || artifactBytes.length > MAX_BYTES) fail('Artifact size is out of bounds.');
  let sbomJson;
  try { sbomJson = JSON.parse(sbomBytes.toString('utf8')); } catch { fail('SBOM is not valid JSON.'); }
  const problems = verifySbom(sbomJson);
  if (problems.length) fail(`SBOM is invalid: ${problems[0]}`);
  const bundle = {
    version: 1,
    meta: { project, gitCommit, buildNumber: String(buildNumber), createdAt: now },
    artifact: { name: artifactName, size: artifactBytes.length, sha256: sha256(artifactBytes), dataBase64: artifactBytes.toString('base64') },
    sbom: { name: 'sbom.cdx.json', size: sbomBytes.length, sha256: sha256(sbomBytes), dataBase64: sbomBytes.toString('base64') },
  };
  bundle.checksums = `${bundle.artifact.sha256}  ${bundle.artifact.name}\n${bundle.sbom.sha256}  ${bundle.sbom.name}\n`;
  const publicKey = createPublicKey(key);
  bundle.publicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  bundle.keyId = sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16);
  bundle.signature = sign(null, signedStatement(bundle), key).toString('base64');
  return bundle;
}

function tarEntriesAreSafe(archivePath) {
  // Relative name + cwd: GNU tar treats a drive letter (C:) as a remote host.
  const listing = spawnSync('tar', ['-tzf', basename(archivePath)], { cwd: dirname(archivePath), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (listing.status !== 0) fail('Artifact is not a readable tar.gz archive.');
  for (const raw of listing.stdout.split(/\r?\n/).filter(Boolean)) {
    const entry = raw.replace(/\\/g, '/');
    if (entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || entry.split('/').includes('..')) fail(`Artifact contains an unsafe entry path: ${raw.slice(0, 80)}.`);
  }
}

/** Clean-room verification: returns { ok:true, ... } or throws. */
export function verifyBundle(bundle, trustedPublicKeyPem, { lockfile } = {}) {
  if (!trustedPublicKeyPem) fail('A trusted public key is required (set JARVIS_RELEASE_PUBLIC_KEY); the embedded key is never trusted.');
  if (!bundle || bundle.version !== 1 || !bundle.meta || !bundle.artifact || !bundle.sbom || typeof bundle.signature !== 'string') fail('Bundle structure is invalid.');
  for (const part of [bundle.artifact, bundle.sbom]) {
    if (typeof part.name !== 'string' || !NAME.test(part.name) || basename(part.name) !== part.name) fail('Bundle contains an unsafe file name.');
    if (typeof part.dataBase64 !== 'string' || !Number.isInteger(part.size) || part.size < 1 || part.size > MAX_BYTES) fail('Bundle file entry is invalid.');
  }
  const trusted = createPublicKey(trustedPublicKeyPem);
  if (trusted.asymmetricKeyType !== 'ed25519') fail('Trusted verification key must be Ed25519.');
  const signature = Buffer.from(bundle.signature, 'base64');
  if (signature.length !== 64 || !verify(null, signedStatement(bundle), trusted, signature)) fail('Signature verification failed: wrong key or the bundle was modified.');
  const workdir = mkdtempSync(join(tmpdir(), 'jarvis-cleanroom-'));
  try {
    const extracted = {};
    for (const part of [bundle.artifact, bundle.sbom]) {
      const bytes = Buffer.from(part.dataBase64, 'base64');
      const path = join(workdir, part.name);
      writeFileSync(path, bytes);
      const onDisk = readFileSync(path);
      if (onDisk.length !== part.size || sha256(onDisk) !== part.sha256) fail(`${part.name} failed size/SHA-256 verification after extraction.`);
      extracted[part.name] = path;
    }
    const expectedChecksums = `${bundle.artifact.sha256}  ${bundle.artifact.name}\n${bundle.sbom.sha256}  ${bundle.sbom.name}\n`;
    if (bundle.checksums !== expectedChecksums) fail('Checksum file does not match the signed digests.');
    let sbomJson;
    try { sbomJson = JSON.parse(readFileSync(extracted[bundle.sbom.name], 'utf8')); } catch { fail('Extracted SBOM is not valid JSON.'); }
    const problems = verifySbom(sbomJson, lockfile);
    if (problems.length) fail(`SBOM verification failed: ${problems[0]}`);
    if (/\.(tar\.gz|tgz)$/i.test(bundle.artifact.name)) tarEntriesAreSafe(extracted[bundle.artifact.name]);
    return { ok: true, project: bundle.meta.project, gitCommit: bundle.meta.gitCommit, buildNumber: bundle.meta.buildNumber, artifact: bundle.artifact.name, sha256: bundle.artifact.sha256 };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

function flag(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }

function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'keygen' && args.length === 2) {
    const { publicPem, privatePem } = generateKeyPem();
    writeFileSync(args[0], privatePem, { flag: 'wx', mode: 0o600 });
    writeFileSync(args[1], publicPem, { flag: 'wx' });
    console.log('Ed25519 key pair written. Do not commit the private key.');
  } else if (command === 'create' && args.length >= 3) {
    const [artifact, sbom, out] = args;
    if (!statSync(artifact).isFile()) fail('Artifact must be a regular file.');
    const bundle = createBundle({
      artifactName: basename(artifact), artifactBytes: readFileSync(artifact), sbomBytes: readFileSync(sbom),
      privateKeyPem: process.env.JARVIS_RELEASE_SIGNING_KEY?.replace(/\\n/g, '\n'),
      project: flag(args, '--project') ?? process.env.PROJECT_NAME ?? 'JARVIS',
      gitCommit: flag(args, '--commit') ?? process.env.GIT_COMMIT, buildNumber: flag(args, '--build') ?? process.env.BUILD_NUMBER,
    });
    mkdirSync(join(out, '..'), { recursive: true });
    writeFileSync(out, JSON.stringify(bundle), { mode: 0o644 });
    console.log(`Signed release bundle written (key ${bundle.keyId}, artifact sha256 ${bundle.artifact.sha256}).`);
  } else if (command === 'verify' && args.length >= 1) {
    const lock = args[1] ? JSON.parse(readFileSync(args[1], 'utf8')) : undefined;
    const result = verifyBundle(JSON.parse(readFileSync(args[0], 'utf8')), process.env.JARVIS_RELEASE_PUBLIC_KEY?.replace(/\\n/g, '\n'), { lockfile: lock });
    console.log(`Clean-room release verification PASSED: project=${result.project}; build=${result.buildNumber}; commit=${result.gitCommit}; artifact=${result.artifact}; sha256=${result.sha256}.`);
  } else {
    console.error('Usage: release-bundle.mjs keygen|create|verify ...');
    process.exitCode = 2;
  }
}

if (process.argv[1]?.endsWith('release-bundle.mjs')) {
  try { main(); } catch (error) { console.error(`Release bundle error: ${error.message}`); process.exitCode = 1; }
}
void readdirSync;
