import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const utility = path.join(root, 'scripts', 'artifact-integrity.mjs');

function run(args: string[], expectSuccess = true) {
  const result = spawnSync(process.execPath, [utility, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PROJECT_NAME: 'integrity-test', GIT_COMMIT: 'test-commit', BUILD_NUMBER: 'test-build' },
  });
  if (expectSuccess) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
  } else {
    assert.notEqual(result.status, 0, 'Expected the integrity command to reject invalid content.');
  }
  return result;
}

describe('artifact integrity utility', () => {
  let temp: string;
  let artifactDir: string;
  let manifest: string;
  let archive: string;
  let checksum: string;

  beforeEach(() => {
    temp = mkdtempSync(path.join(os.tmpdir(), 'jarvis-integrity-'));
    artifactDir = path.join(temp, 'dist');
    mkdirSync(path.join(artifactDir, 'nested'), { recursive: true });
    writeFileSync(path.join(artifactDir, 'index.js'), 'console.log("safe");\n');
    writeFileSync(path.join(artifactDir, 'nested', 'module.js'), 'export const value = 1;\n');
    manifest = path.join(temp, 'manifest.json');
    archive = path.join(temp, 'artifact.tar.gz');
    checksum = path.join(temp, 'artifact.tar.gz.sha256');
    writeFileSync(archive, 'archive bytes');
  });

  afterEach(() => rmSync(temp, { recursive: true, force: true }));

  it('creates and verifies a sorted file inventory and packaged-artifact hash', () => {
    run(['create', artifactDir, manifest, archive]);
    const parsed = JSON.parse(readFileSync(manifest, 'utf8'));
    assert.equal(parsed.algorithm, 'SHA256');
    assert.equal(parsed.fileCount, 2);
    assert.deepEqual(parsed.files.map((file: { path: string }) => file.path), ['index.js', 'nested/module.js']);
    run(['verify', artifactDir, manifest, archive]);
    run(['hash', archive, checksum]);
    run(['verify-hash', archive, checksum]);
  });

  it('rejects modified, missing, and unexpected files', () => {
    run(['create', artifactDir, manifest]);
    writeFileSync(path.join(artifactDir, 'index.js'), 'tampered\n');
    run(['verify', artifactDir, manifest], false);
    writeFileSync(path.join(artifactDir, 'index.js'), 'console.log("safe");\n');
    rmSync(path.join(artifactDir, 'nested', 'module.js'));
    run(['verify', artifactDir, manifest], false);
    writeFileSync(path.join(artifactDir, 'nested', 'module.js'), 'export const value = 1;\n');
    writeFileSync(path.join(artifactDir, 'extra.js'), 'unexpected\n');
    run(['verify', artifactDir, manifest], false);
  });

  it('rejects a modified packaged artifact and checksum mismatch', () => {
    run(['create', artifactDir, manifest, archive]);
    writeFileSync(archive, 'changed archive bytes');
    run(['verify', artifactDir, manifest, archive], false);
    run(['hash', archive, checksum]);
    writeFileSync(archive, 'different archive bytes');
    run(['verify-hash', archive, checksum], false);
  });
});
