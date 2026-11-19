import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { evaluateRetrieval, evaluateVoice, type RetrievalFixture, type VoiceFixture } from '../src/evaluation/offlineEval.js';

/** JARVIS-GAP-006/007: deterministic offline evaluation harness over labelled fixtures (synthetic data). */
const root = resolve(import.meta.dirname, '..');
const retrievalFixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/eval/retrieval.synthetic.json'), 'utf8')) as RetrievalFixture;
const voiceFixture = JSON.parse(readFileSync(resolve(root, 'test/fixtures/eval/voice.synthetic.json'), 'utf8')) as VoiceFixture;

test('retrieval report computes P@K, R@K, MRR, hit rate and false-accept exactly on the fixture and is deterministic', async () => {
  const a = await evaluateRetrieval(retrievalFixture, 5);
  const b = await evaluateRetrieval(retrievalFixture, 5);
  assert.deepEqual(a, b);
  assert.equal(a.synthetic, true);
  assert.equal(a.positiveQueries, 6);
  assert.equal(a.negativeQueries, 1);
  assert.equal(a.mrr, 1);
  assert.equal(a.recallAtK, 1);
  assert.equal(a.hitRateAtK, 1);
  assert.equal(a.precisionAtK, 0.8333);
  assert.equal(a.falseAcceptRate, 0, 'the off-topic negative query retrieved nothing');
  const atOne = await evaluateRetrieval(retrievalFixture, 1);
  assert.equal(atOne.precisionAtK, 1, 'P@1 is perfect on this fixture');
});

test('a wrongly labelled fixture is scored as bad retrieval, so the harness can actually fail', async () => {
  const wrong: RetrievalFixture = { ...retrievalFixture, queries: [{ query: 'microphone consent wake phrase', relevant: ['backup-restore'] }, { query: 'backup restore HMAC', relevant: [] }] };
  const report = await evaluateRetrieval(wrong, 5);
  assert.equal(report.mrr, 0);
  assert.equal(report.recallAtK, 0);
  assert.equal(report.falseAcceptRate, 1, 'a negative query that returns documents is a false accept');
});

test('retrieval fixtures are validated: unknown ids, duplicates, empty input and bad K are rejected', async () => {
  await assert.rejects(evaluateRetrieval({ ...retrievalFixture, queries: [{ query: 'x', relevant: ['nope'] }] }), /unknown document id/);
  await assert.rejects(evaluateRetrieval({ ...retrievalFixture, corpus: [retrievalFixture.corpus[0], retrievalFixture.corpus[0]] }), /unique/);
  await assert.rejects(evaluateRetrieval({ ...retrievalFixture, corpus: [] }), /corpus and queries/);
  await assert.rejects(evaluateRetrieval(retrievalFixture, 0), /k must be/);
  await assert.rejects(evaluateRetrieval(retrievalFixture, 99), /k must be/);
});

test('voice report: duplicates never create a second task, new commands are not over-suppressed, wake rates use production formulas', () => {
  const report = evaluateVoice(voiceFixture);
  assert.equal(report.utterances, 8);
  assert.equal(report.accepted, 5);
  assert.equal(report.suppressed, 3);
  assert.equal(report.duplicateAccepted, 0);
  assert.equal(report.falseSuppressed, 0);
  assert.equal(report.suppressionAccuracy, 1);
  assert.equal(report.tasksPerAcceptedUtterance, 1);
  assert.deepEqual(report.wake, { attempts: 6, falseAccepts: 1, falseRejects: 1, falseAcceptRate: 0.25, falseRejectRate: 0.25 });
  assert.deepEqual(evaluateVoice(voiceFixture), report);
});

test('with duplicate protection effectively disabled the harness reports duplicate tasks (it can detect a regression)', () => {
  const noProtection = evaluateVoice({ ...voiceFixture, utterances: voiceFixture.utterances.filter((u) => u.utteranceId !== 'utt-aaaaaaaa').map((u) => u) }, 0);
  assert.ok(noProtection.duplicateAccepted >= 1, 'a 0 ms window lets the re-emitted transcript through');
  const overSuppress = evaluateVoice({ ...voiceFixture, utterances: [
    { atMs: 0, deviceId: 'd', utteranceId: 'utt-11111111', transcript: 'open notepad', expect: 'accept' },
    { atMs: 100, deviceId: 'd', utteranceId: 'utt-22222222', transcript: 'open notepad', expect: 'accept' },
  ] });
  assert.equal(overSuppress.falseSuppressed, 1);
  assert.equal(overSuppress.suppressionAccuracy, 0.5);
  assert.throws(() => evaluateVoice({ name: 'x', version: '1', synthetic: true } as unknown as VoiceFixture), /utterances and wakeAttempts/);
});

test('CLI prints reports, flags synthetic data and enforces thresholds', () => {
  const run = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/eval-offline.ts', ...extra], { cwd: root, encoding: 'utf8' });
  const ok = run('--min-mrr', '0.9', '--max-false-accept', '0.5');
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /synthetic/);
  assert.match(ok.stdout, /"mrr":1/);
  const strict = run('--min-mrr', '1.1');
  assert.equal(strict.status, 1);
  assert.match(strict.stderr, /EVAL FAILED: MRR/);
});
