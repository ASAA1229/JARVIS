import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error plain ESM script without type declarations
import { verifySbom } from '../scripts/sbom-verify.mjs';

/** JARVIS-GAP-018 (local part): SBOM structure/lockfile cross-check and tamper detection. */
const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

function generate(): any | null {
  const result = spawnSync('npm', ['sbom', '--sbom-format=cyclonedx'], { cwd: root, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) return null;
  try { return JSON.parse(result.stdout); } catch { return null; }
}

const valid = () => ({
  bomFormat: 'CycloneDX', specVersion: '1.5', version: 1, serialNumber: 'urn:uuid:f26861f9-c136-4c6a-9c9e-78fe8c74e76f',
  components: [
    { 'bom-ref': 'a@1.0.0', name: 'a', version: '1.0.0', purl: 'pkg:npm/a@1.0.0' },
    { 'bom-ref': 'b@2.0.0', name: 'b', version: '2.0.0', purl: 'pkg:npm/b@2.0.0' },
  ],
});
const smallLock = { packages: { '': {}, 'node_modules/a': { version: '1.0.0' }, 'node_modules/b': { version: '2.0.0' }, 'node_modules/@x/opt': { version: '3.0.0', optional: true } } };

test('a well-formed SBOM that matches the lockfile verifies (optional platform packages may be absent)', () => {
  assert.deepEqual(verifySbom(valid(), smallLock), []);
  assert.deepEqual(verifySbom(valid()), []);
});

test('structural defects, duplicates and non-objects are reported', () => {
  for (const bad of [null, [], 'x', 5]) assert.ok(verifySbom(bad).length > 0);
  const mutations: Array<[string, (s: any) => void, RegExp]> = [
    ['format', (s) => { s.bomFormat = 'SPDX'; }, /bomFormat/],
    ['spec', (s) => { delete s.specVersion; }, /specVersion/],
    ['version', (s) => { s.version = 0; }, /version/],
    ['serial', (s) => { s.serialNumber = 'not-a-uuid'; }, /serialNumber/],
    ['no components', (s) => { s.components = []; }, /no components/],
    ['missing version', (s) => { delete s.components[0].version; }, /missing name or version/],
    ['dup ref', (s) => { s.components[1]['bom-ref'] = 'a@1.0.0'; }, /Duplicate bom-ref/],
    ['dup purl', (s) => { s.components[1].purl = s.components[0].purl; }, /Duplicate purl/],
    ['no purl', (s) => { delete s.components[0].purl; }, /no purl/],
  ];
  for (const [label, mutate, expected] of mutations) {
    const sbom = valid(); mutate(sbom);
    assert.match(verifySbom(sbom).join(' | '), expected, label);
  }
});

test('lockfile cross-check detects removed, injected and version-swapped components', () => {
  const removed = valid(); removed.components.pop();
  assert.match(verifySbom(removed, smallLock).join(' '), /missing from SBOM: b/);
  const injected = valid(); injected.components.push({ 'bom-ref': 'evil@1.0.0', name: 'evil', version: '1.0.0', purl: 'pkg:npm/evil@1.0.0' });
  assert.match(verifySbom(injected, smallLock).join(' '), /not in lockfile: evil/);
  const swapped = valid(); swapped.components[0].version = '9.9.9'; swapped.components[0].purl = 'pkg:npm/a@9.9.9';
  assert.match(verifySbom(swapped, smallLock).join(' '), /a@9\.9\.9|lacks a@1\.0\.0/);
  assert.match(verifySbom(valid(), {}).join(' '), /no packages section/);
});

test('the real npm-generated CycloneDX SBOM for this repository verifies against package-lock.json, and tampering is caught', (t) => {
  const sbom = generate();
  if (!sbom) { t.skip('npm sbom is unavailable in this environment'); return; }
  assert.deepEqual(verifySbom(sbom, lock), []);
  const tampered = structuredClone(sbom);
  tampered.components = tampered.components.filter((component: { name: string }) => component.name !== 'tsx');
  assert.match(verifySbom(tampered, lock).join(' '), /missing from SBOM: tsx/);
  const swapped = structuredClone(sbom);
  swapped.components[0].version = '0.0.0-tampered';
  assert.ok(verifySbom(swapped, lock).length > 0);
});

test('CLI exits non-zero for tampered SBOM files and zero for valid ones', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-sbom-'));
  try {
    const run = (sbomPath: string) => spawnSync(process.execPath, [join(root, 'scripts', 'sbom-verify.mjs'), sbomPath, join(root, 'package-lock.json')], { encoding: 'utf8' });
    writeFileSync(join(dir, 'junk.json'), 'not json');
    assert.notEqual(run(join(dir, 'junk.json')).status, 0);
    assert.notEqual(run(join(dir, 'missing.json')).status, 0);
    writeFileSync(join(dir, 'small.json'), JSON.stringify(valid()));
    assert.notEqual(run(join(dir, 'small.json')).status, 0, 'a small SBOM does not match the real lockfile');
    const sbom = generate();
    if (sbom) {
      writeFileSync(join(dir, 'real.json'), JSON.stringify(sbom));
      const ok = run(join(dir, 'real.json'));
      assert.equal(ok.status, 0, ok.stderr);
      assert.match(ok.stdout, /PASSED/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
