import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeniedWorkspacePath, looksBinary, resolveInWorkspace } from '../src/workspace/workspacePaths.js';
import { WorkspaceService } from '../src/workspace/workspaceService.js';
import { applyFileDiff, createUnifiedDiff, parseUnifiedDiff } from '../src/workspace/unifiedDiff.js';

function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'jarvis-ws-'));
  const root = join(base, 'proj');
  const outside = join(base, 'outside');
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\nexport const b = 2;\n');
  writeFileSync(join(root, '.env'), 'SECRET=abc\n');
  writeFileSync(join(root, 'Token.txt'), 'nope');
  writeFileSync(join(root, 'server.pem'), 'nope');
  writeFileSync(join(root, '.git', 'config'), '[core]');
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x');
  writeFileSync(join(outside, 'secret.txt'), 'outside data');
  writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3, 0, 0]));
  const service = new WorkspaceService(join(base, 'state'));
  const approved = service.roots.add('proj', root);
  return { base, root: approved.path, outside, service, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('traversal, absolute paths and Windows tricks are rejected', () => {
  const f = fixture();
  try {
    const bad = ['../outside/secret.txt', 'src/../../outside/secret.txt', '..\\outside', 'C:/Windows/win.ini', '/etc/passwd', '\\\\host\\share', 'src/a.ts:stream', 'a\0b'];
    for (const path of bad) {
      assert.throws(() => resolveInWorkspace(f.root, path), /outside|relative|traversal|Invalid|not allowed/i, path);
    }
    assert.equal(resolveInWorkspace(f.root, 'src/a.ts').relative, 'src/a.ts');
    assert.throws(() => f.service.readFile('proj', '../outside/secret.txt'));
  } finally { f.cleanup(); }
});

test('secret files and .git internals are denied for read and write, including trailing-dot tricks', () => {
  const f = fixture();
  try {
    const names = ['.env', '.env.local', 'config/.env.production', 'Token.txt', 'token.txt.', 'server.pem', 'a/id_rsa', 'id_ed25519', 'credentials.json', 'my.key', '.git/config', '.GIT/HEAD'];
    for (const name of names) assert.equal(isDeniedWorkspacePath(name, 'read'), true, name);
    assert.equal(isDeniedWorkspacePath('node_modules/x.js', 'write'), true);
    assert.equal(isDeniedWorkspacePath('src/app.ts', 'write'), false);
    for (const secret of ['.env', 'Token.txt', 'server.pem', '.git/config']) {
      assert.throws(() => f.service.readFile('proj', secret), /protected/, secret);
      assert.throws(() => f.service.previewWrite('proj', secret, 'x'), /protected/, secret);
    }
    const listed = f.service.tree('proj').entries.map((entry) => entry.name);
    assert.deepEqual(listed, ['src', 'bin.dat']);
  } finally { f.cleanup(); }
});

test('symlink or junction escape out of the root is refused', (t) => {
  const f = fixture();
  try {
    try { symlinkSync(f.outside, join(f.root, 'link'), 'junction'); } catch { t.skip('cannot create link here'); return; }
    assert.throws(() => f.service.readFile('proj', 'link/secret.txt'), /outside the workspace root/);
    assert.throws(() => f.service.previewWrite('proj', 'link/new.txt', 'x'), /outside the workspace root/);
    // Links are not followed by the tree or by search either.
    assert.ok(!f.service.tree('proj').entries.some((entry) => entry.name === 'link'));
    assert.equal(f.service.search('proj', 'outside data').results.length, 0);
  } finally { f.cleanup(); }
});

test('unapproved roots are refused; binary and oversized files are not opened', () => {
  const f = fixture();
  try {
    assert.throws(() => f.service.tree('other'), /not an approved workspace root/);
    assert.throws(() => f.service.readFile('other', 'src/a.ts'), /not an approved workspace root/);
    assert.throws(() => f.service.search('other', 'a'), /not an approved workspace root/);
    assert.throws(() => f.service.readFile('proj', 'bin.dat'), /binary/);
    writeFileSync(join(f.root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
    assert.throws(() => f.service.readFile('proj', 'big.txt'), /larger than/);
    assert.equal(looksBinary(Buffer.from('plain text\n')), false);
    assert.throws(() => f.service.roots.add('bad', 'relative/path'), /absolute/);
    assert.throws(() => f.service.roots.add('bad', join(f.base, 'missing')), /does not exist/);
  } finally { f.cleanup(); }
});

test('search is bounded and ignores secrets, node_modules and binaries', () => {
  const f = fixture();
  try {
    for (let i = 0; i < 150; i++) writeFileSync(join(f.root, 'src', `f${i}.ts`), 'needle here\nneedle again\n');
    const hits = f.service.search('proj', 'needle');
    assert.equal(hits.results.length, 100);
    assert.equal(hits.truncated, true);
    assert.equal(f.service.search('proj', 'SECRET').results.length, 0);
    assert.equal(f.service.search('proj', 'index.js').results.length, 0);
    assert.deepEqual(f.service.search('proj', 'a.ts', { mode: 'name' }).results.map((r) => r.path), ['src/a.ts']);
    assert.throws(() => f.service.search('proj', ''), /1-200/);
    assert.throws(() => f.service.search('proj', 'x'.repeat(201)), /1-200/);
  } finally { f.cleanup(); }
});

test('unified diff round-trips and rejects non-matching hunks', () => {
  const before = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n';
  const after = 'one\ntwo\nTHREE\nfour\nfive\nsix\nseven\neight\nnine\nten\neleven\n';
  const diff = createUnifiedDiff('x.txt', before, after);
  assert.match(diff, /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@/);
  const [file] = parseUnifiedDiff(diff);
  assert.equal(applyFileDiff(before, file!), after);
  assert.throws(() => applyFileDiff(before.replace('three', 'drei'), file!), /does not match/);
  assert.equal(createUnifiedDiff('x.txt', before, before), '');
  const created = createUnifiedDiff('n.txt', null, 'hi\n');
  assert.equal(applyFileDiff(null, parseUnifiedDiff(created)[0]!), 'hi\n');
  const crlf = 'a\r\nb\r\n';
  const crlfDiff = createUnifiedDiff('c.txt', crlf, 'a\nB\n');
  assert.equal(applyFileDiff(crlf, parseUnifiedDiff(crlfDiff)[0]!), 'a\r\nB\r\n');
});

test('previewDiff validates paths and never writes', () => {
  const f = fixture();
  try {
    const good = createUnifiedDiff('src/a.ts', 'export const a = 1;\nexport const b = 2;\n', 'export const a = 10;\nexport const b = 2;\n');
    const preview = f.service.previewDiff('proj', good);
    assert.deepEqual(preview.files.map((file) => file.path), ['src/a.ts']);
    assert.equal(f.service.readFile('proj', 'src/a.ts').content.startsWith('export const a = 1;'), true);
    for (const target of ['.env', '../x.ts', 'src/../../x.ts', '.git/config']) {
      const bad = `--- /dev/null\n+++ b/${target}\n@@ -0,0 +1 @@\n+x\n`;
      assert.throws(() => f.service.previewDiff('proj', bad), /protected|outside|traversal/i, target);
    }
    assert.throws(() => f.service.previewDiff('proj', '--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n'), /Deleting/);
  } finally { f.cleanup(); }
});
