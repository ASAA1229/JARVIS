import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBackup, restoreBackup, verifyBackup } from '../src/ops/stateBackup.js';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.js';
import { WorkingMemory } from '../src/memory/workingMemory.js';
import { MemoryManager } from '../src/memory/memoryManager.js';
import { SemanticMemoryIndex } from '../src/memory/semanticIndex.js';
import { DocumentRagStore } from '../src/memory/documentRagStore.js';
import { ConversationSessionStore } from '../src/conversation/conversationSessionStore.js';

/** JARVIS-GAP-017: backup/restore drills and derived-state deletion verification. */
const TOKEN = 'backup-restore-owner-token-0123456789abcdef';

function open(dir: string) {
  const store = new PersonalMemoryStore(join(dir, 'state.memories'), TOKEN);
  const manager = new MemoryManager(store, new WorkingMemory(), join(dir, 'state.candidates'), TOKEN, { index: new SemanticMemoryIndex(join(dir, 'state.index'), TOKEN, null) });
  const docs = new DocumentRagStore(join(dir, 'state.documents'), TOKEN);
  const conversations = new ConversationSessionStore(join(dir, 'state.conversations'), TOKEN);
  return { store, manager, docs, conversations };
}
function scratch() { return mkdtempSync(join(tmpdir(), 'jarvis-backup-')); }

test('drill: back up, wipe, restore to a new location, and every store reads its data again', () => {
  const root = scratch();
  try {
    const live = join(root, 'live'); mkdirSync(live);
    const a = open(live);
    const memory = a.store.save('preference', 'Prefers the saffron colour theme.');
    a.manager.propose('dev', 'project', 'Candidate about marigold deployments.', { kind: 'feedback' });
    a.docs.ingest({ ownerDeviceId: 'dev', sourceName: 'runbook.txt', content: 'Runbook: rotate the cobalt keys every quarter.' });
    const conv = a.conversations.getOrCreate('dev')!;
    a.conversations.appendTurn(conv.id, 'dev', 'question about turmeric', 'answer');

    const archive = join(root, 'backup.jarvisbak');
    const made = createBackup(live, 'state.', archive, TOKEN);
    assert.ok(made.files.length >= 4);
    assert.equal(verifyBackup(archive, TOKEN).files.length, made.files.length);
    const raw = readFileSync(archive);
    for (const secret of ['saffron', 'marigold', 'cobalt', 'turmeric']) assert.equal(raw.includes(Buffer.from(secret)), false, `${secret} must not appear in the archive`);

    rmSync(live, { recursive: true, force: true });
    const restoredDir = join(root, 'restored');
    restoreBackup(archive, restoredDir, TOKEN);
    const b = open(restoredDir);
    assert.equal(b.store.get(memory.id)?.content, 'Prefers the saffron colour theme.');
    assert.equal(b.manager.listCandidates('pending').length, 1);
    assert.equal(b.docs.list('dev').length, 1);
    assert.equal(b.conversations.getOrCreate('dev', conv.id)?.history.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restore refuses wrong tokens, tampering, injected files, unsafe names and silent overwrite', () => {
  const root = scratch();
  try {
    const live = join(root, 'live'); mkdirSync(live);
    open(live).store.save('general', 'Some memory worth backing up.');
    const archive = join(root, 'b.bak');
    createBackup(live, 'state.', archive, TOKEN);
    assert.throws(() => verifyBackup(archive, 'a-completely-different-owner-token-0123456789'), /authentication failed/);
    assert.throws(() => verifyBackup(archive, 'short'), /owner control token/);

    const base = JSON.parse(readFileSync(archive, 'utf8'));
    const write = (mutate: (a: any) => void) => { const copy = structuredClone(base); mutate(copy); const p = join(root, 'mut.bak'); writeFileSync(p, JSON.stringify(copy)); return p; };
    assert.throws(() => verifyBackup(write((a) => { a.files[0].dataBase64 = Buffer.from('forged').toString('base64'); }), TOKEN), /integrity|authentication/);
    assert.throws(() => verifyBackup(write((a) => { a.files.push({ ...a.files[0], name: 'extra.bin' }); }), TOKEN), /authentication/);
    assert.throws(() => verifyBackup(write((a) => { a.files.pop(); a.files.push({ name: '..', size: 0, sha256: '', dataBase64: '' }); }), TOKEN), /unsafe/);
    for (const name of ['../escape', '..\\escape', 'a/b', 'C:evil', 'con:x', '.hidden-dir/../x', '']) {
      assert.throws(() => verifyBackup(write((a) => { a.files[0].name = name; }), TOKEN), /unsafe|invalid/, name);
    }
    assert.throws(() => verifyBackup(write((a) => { a.files.push({ ...a.files[0], name: a.files[0].name.toUpperCase() }); }), TOKEN), /unsafe|duplicate/);
    writeFileSync(join(root, 'junk.bak'), 'not json');
    assert.throws(() => verifyBackup(join(root, 'junk.bak'), TOKEN), /not valid JSON/);
    writeFileSync(join(root, 'empty.bak'), '{"version":1,"files":[],"mac":"","createdAt":1}');
    assert.throws(() => verifyBackup(join(root, 'empty.bak'), TOKEN), /structure/);

    // Nothing is written when verification fails.
    const target = join(root, 'target');
    assert.throws(() => restoreBackup(write((a) => { a.files[0].name = '../x'; }), target, TOKEN));
    assert.equal(existsSync(target), false);

    // Existing state is never silently replaced.
    assert.throws(() => restoreBackup(archive, live, TOKEN), /overwrite existing state/);
    assert.equal(restoreBackup(archive, live, TOKEN, { force: true }).restored.length > 0, true);
    assert.deepEqual(readdirSync(live).filter((n) => n.includes('.restore-')), [], 'no staging files left behind');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('derived-state deletion: a backup taken after deletion holds no trace; older backups are the documented external limit', () => {
  const root = scratch();
  try {
    const live = join(root, 'live'); mkdirSync(live);
    const a = open(live);
    const secret = 'The quartz vault alias is heron-seven for the owner.';
    const memory = a.store.save('project', secret);
    const candidate = a.manager.propose('dev', 'project', secret, { kind: 'feedback' });
    a.manager.approve(candidate.id);
    const wm = a.manager.working;
    void wm;
    const before = join(root, 'before.bak');
    createBackup(live, 'state.', before, TOKEN);

    const existing = a.store.get(memory.id)!;
    assert.equal(a.store.delete(memory.id), true);
    const scrub = a.manager.scrubDeleted(memory.id, existing.content);
    assert.equal(scrub.derivedVerified, true);
    const after = join(root, 'after.bak');
    createBackup(live, 'state.', after, TOKEN);

    const restoredAfter = join(root, 'restored-after');
    restoreBackup(after, restoredAfter, TOKEN);
    const check = open(restoredAfter);
    assert.equal(check.store.get(memory.id), undefined, 'primary store has no residual record');
    assert.equal(check.store.list().some((record) => record.content.includes('heron-seven')), false);
    assert.equal(check.manager.listCandidates().some((c) => c.content.includes('heron-seven')), false, 'learning candidates scrubbed');
    assert.equal(check.manager.index.verifyRemoved(memory.id), true, 'embedding index scrubbed');
    assert.equal(check.manager.versions.verifyPurged(memory.id), true, 'version history purged');

    // Documented limit: the earlier backup still holds the record; restoring it resurrects it.
    const resurrected = join(root, 'resurrected');
    restoreBackup(before, resurrected, TOKEN);
    assert.equal(open(resurrected).store.get(memory.id)?.content, secret);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('derived indexes rebuild after a restore that omits them', () => {
  const root = scratch();
  try {
    const live = join(root, 'live'); mkdirSync(live);
    const a = open(live);
    a.docs.ingest({ ownerDeviceId: 'dev', sourceName: 'a.txt', content: 'Indigo retrieval corpus entry used for rebuild verification.' });
    const archive = join(root, 'b.bak');
    createBackup(live, 'state.', archive, TOKEN);
    const target = join(root, 'target');
    restoreBackup(archive, target, TOKEN);
    for (const derived of ['state.documents.vectors', 'state.index']) rmSync(join(target, derived), { force: true });
    const b = open(target);
    assert.equal(b.docs.list('dev').length, 1, 'authoritative documents survive; derived vectors are recreated lazily');
    assert.ok(createBackup(target, 'state.', join(root, 'again.bak'), TOKEN).files.includes('state.documents'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});
