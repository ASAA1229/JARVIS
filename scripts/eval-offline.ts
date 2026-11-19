/**
 * Offline evaluation CLI (JARVIS-GAP-006/007).
 *
 *   npx tsx scripts/eval-offline.ts [--retrieval fixture.json] [--voice fixture.json] [--k 5]
 *        [--json report.json] [--min-mrr 0.8] [--max-false-accept 0.2]
 *
 * Defaults to the synthetic fixtures in test/fixtures/eval. Drop in real labelled
 * data with the same JSON shapes (see those files). Exit code 1 when a supplied
 * threshold is violated or a duplicate created a second task.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { evaluateRetrieval, evaluateVoice, type RetrievalFixture, type VoiceFixture } from '../src/evaluation/offlineEval.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const load = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const retrievalPath = flag('--retrieval', 'test/fixtures/eval/retrieval.synthetic.json')!;
const voicePath = flag('--voice', 'test/fixtures/eval/voice.synthetic.json')!;
const k = Number(flag('--k', '5'));
const retrieval = await evaluateRetrieval(load<RetrievalFixture>(retrievalPath), k);
const voice = evaluateVoice(load<VoiceFixture>(voicePath));

const { perQuery, ...retrievalSummary } = retrieval;
console.log('Retrieval:', JSON.stringify(retrievalSummary));
console.table(perQuery.map((q) => ({ query: q.query, retrieved: q.retrieved.join(','), relevant: q.relevant.join(','), P: +q.precision.toFixed(2), R: +q.recall.toFixed(2), RR: +q.reciprocalRank.toFixed(2) })));
console.log('Voice:', JSON.stringify(voice));
if (retrieval.synthetic || voice.synthetic) console.log('NOTE: at least one fixture is synthetic; these numbers measure the fixture, not real-world accuracy.');
const out = flag('--json');
if (out) writeFileSync(out, JSON.stringify({ retrieval, voice }, null, 2));

const minMrr = flag('--min-mrr');
const maxFalseAccept = flag('--max-false-accept');
const problems: string[] = [];
if (minMrr !== undefined && (retrieval.mrr ?? 0) < Number(minMrr)) problems.push(`MRR ${retrieval.mrr} is below ${minMrr}`);
if (maxFalseAccept !== undefined && (retrieval.falseAcceptRate ?? 0) > Number(maxFalseAccept)) problems.push(`retrieval false-accept ${retrieval.falseAcceptRate} exceeds ${maxFalseAccept}`);
if (voice.duplicateAccepted > 0) problems.push(`${voice.duplicateAccepted} duplicate utterance(s) created a second task`);
if (problems.length) { for (const problem of problems) console.error(`EVAL FAILED: ${problem}`); process.exitCode = 1; }
