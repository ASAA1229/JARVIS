import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const disposition = path.join(root, 'scripts', 'release-disposition.mjs');
const releaseIndex = path.join(root, 'scripts', 'release-index.mjs');
const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const run = (script: string, args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });

test('promotion gate requires staging-then-production approval and blocks quarantine', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'jarvis-disposition-'));
  try {
    const artifact = Buffer.from('jarvis-release');
    writeFileSync(path.join(dir, 'jarvis.tar.gz'), artifact);
    writeFileSync(path.join(dir, 'jarvis.tar.gz.sha256'), `${sha(artifact)}  jarvis.tar.gz\n`);
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
      project: 'jarvis', createdAt: new Date().toISOString(),
      source: { gitCommit: 'b'.repeat(40), buildNumber: '12' },
      ci: { provider: 'jenkins', repository: 'owner/jarvis', branch: 'new', workflow: 'Jenkinsfile', runId: '12', runUrl: 'https://ci.example.invalid/job/12' },
      artifact: { name: 'jarvis.tar.gz', size: artifact.length, sha256: sha(artifact) },
    }));
    writeFileSync(path.join(dir, 'sbom.json'), '{"bomFormat":"CycloneDX"}');
    const policy = '{"purpose":"manifest-ignore"}';
    writeFileSync(path.join(dir, 'manifest-ignore.json'), policy);
    writeFileSync(path.join(dir, 'manifest-ignore.json.sha256'), `${sha(policy)}  manifest-ignore.json\n`);
    const index = path.join(dir, 'index', 'release-index.json');
    spawnSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(path.dirname(index))})`]);
    const created = run(releaseIndex, [...['jarvis.tar.gz', 'manifest.json', 'jarvis.tar.gz.sha256', 'sbom.json', 'manifest-ignore.json', 'manifest-ignore.json.sha256'].map((name) => path.join(dir, name)), index]);
    assert.equal(created.status, 0, created.stderr);
    const records = path.join(dir, 'records');

    assert.notEqual(run(disposition, ['gate', index, dir, 'staging', records]).status, 0);
    assert.match(run(disposition, ['approve', index, dir, 'production', 'OWNER-1', 'ops', records]).stderr, /prior staging approval/);
    assert.equal(run(disposition, ['approve', index, dir, 'staging', 'OWNER-1', 'ops', records]).status, 0);
    assert.match(run(disposition, ['gate', index, dir, 'staging', records]).stdout, /Promotion gate PASSED for staging/);
    assert.equal(run(disposition, ['approve', index, dir, 'production', 'OWNER-1', 'ops', records]).status, 0);
    assert.equal(run(disposition, ['gate', index, dir, 'production', records]).status, 0);

    assert.equal(run(disposition, ['quarantine', index, dir, 'failed smoke', 'ops', records]).status, 0);
    assert.match(run(disposition, ['gate', index, dir, 'production', records]).stderr, /quarantined/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
