import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'scripts', 'policy-signature.mjs');
const dirs: string[] = [];
after(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('Ed25519 policy signatures authenticate policy bytes and reject tampering', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'policy-signature-'));
    dirs.push(dir);
    const policy = path.join(dir, 'manifest-ignore.json');
    const signature = path.join(dir, 'manifest-ignore.sig');
    const privatePath = path.join(dir, 'private.pem');
    const publicPath = path.join(dir, 'public.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    writeFileSync(policy, JSON.stringify({ purpose: 'manifest-ignore', value: 1 }));
    writeFileSync(privatePath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    writeFileSync(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
    const run = (args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
    assert.equal(run(['sign', policy, signature, privatePath]).status, 0);
    assert.equal(run(['verify', policy, signature, publicPath]).status, 0);
    writeFileSync(policy, JSON.stringify({ purpose: 'manifest-ignore', value: 2 }));
    assert.notEqual(run(['verify', policy, signature, publicPath]).status, 0);
});
