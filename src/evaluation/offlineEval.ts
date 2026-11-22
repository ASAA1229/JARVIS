/**
 * Reproducible offline evaluation (JARVIS-GAP-006/007).
 *
 * Runs labelled fixtures through the REAL components (document retrieval, the
 * duplicate-utterance guard, the wake counters) with a fake clock, so results are
 * deterministic and need no microphone, network or model. Fixtures shipped with the
 * repo are synthetic; the owner can drop in real labelled data using the same JSON
 * shapes. Reports are measurements of the supplied fixture only, never claims about
 * real-world accuracy.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentRagStore } from '../memory/documentRagStore.js';
import { VoiceUtteranceGuard, WakeMetrics, type WakeEvent } from '../voice/utteranceGuard.js';

export interface RetrievalFixture {
  name: string;
  version: string;
  synthetic: boolean;
  corpus: Array<{ id: string; text: string }>;
  /** `relevant: []` marks a negative query: nothing should be retrieved. */
  queries: Array<{ query: string; relevant: string[] }>;
}

export interface RetrievalReport {
  fixture: string; version: string; synthetic: boolean; k: number;
  queries: number; positiveQueries: number; negativeQueries: number;
  precisionAtK: number | null; recallAtK: number | null; mrr: number | null; hitRateAtK: number | null;
  /** Binary-relevance normalized discounted cumulative gain at k. */
  ndcgAtK: number | null;
  /** Fraction of negative queries that returned at least one result. */
  falseAcceptRate: number | null;
  perQuery: Array<{ query: string; retrieved: string[]; relevant: string[]; precision: number; recall: number; reciprocalRank: number; ndcg: number }>;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (value: number | null) => (value === null ? null : Math.round(value * 10000) / 10000);

function ndcg(retrieved: string[], relevant: Set<string>): number {
  if (!relevant.size) return 0;
  const dcg = retrieved.reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
  let ideal = 0;
  for (let index = 0; index < Math.min(relevant.size, retrieved.length || relevant.size); index += 1) ideal += 1 / Math.log2(index + 2);
  return ideal > 0 ? dcg / ideal : 0;
}

export async function evaluateRetrieval(fixture: RetrievalFixture, k = 5): Promise<RetrievalReport> {
  if (!Number.isInteger(k) || k < 1 || k > 8) throw new Error('k must be an integer from 1 to 8.');
  if (!Array.isArray(fixture.corpus) || !fixture.corpus.length || !Array.isArray(fixture.queries) || !fixture.queries.length) throw new Error('Fixture needs a corpus and queries.');
  const ids = new Set(fixture.corpus.map((doc) => doc.id));
  if (ids.size !== fixture.corpus.length) throw new Error('Corpus ids must be unique.');
  for (const q of fixture.queries) for (const id of q.relevant) if (!ids.has(id)) throw new Error(`Query references unknown document id: ${id}.`);
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-eval-'));
  try {
    const store = new DocumentRagStore(join(dir, 'docs.enc'), 'offline-evaluation-token-0123456789abcdef');
    for (const doc of fixture.corpus) store.ingest({ ownerDeviceId: 'eval', sourceName: `${doc.id}.txt`, content: doc.text });
    const perQuery: RetrievalReport['perQuery'] = [];
    for (const q of fixture.queries) {
      const hits = await store.search('eval', q.query, k);
      const retrieved = hits.map((hit) => hit.source.sourceName.replace(/\.txt$/, ''));
      const relevant = new Set(q.relevant);
      const good = retrieved.filter((id) => relevant.has(id)).length;
      const first = retrieved.findIndex((id) => relevant.has(id));
      perQuery.push({
        query: q.query, retrieved, relevant: q.relevant,
        precision: retrieved.length ? good / retrieved.length : 0,
        recall: relevant.size ? good / relevant.size : 0,
        reciprocalRank: first < 0 ? 0 : 1 / (first + 1),
        ndcg: ndcg(retrieved, relevant),
      });
    }
    const positives = perQuery.filter((q) => q.relevant.length > 0);
    const negatives = perQuery.filter((q) => q.relevant.length === 0);
    return {
      fixture: fixture.name, version: fixture.version, synthetic: fixture.synthetic !== false, k,
      queries: perQuery.length, positiveQueries: positives.length, negativeQueries: negatives.length,
      precisionAtK: round(mean(positives.map((q) => q.precision))),
      recallAtK: round(mean(positives.map((q) => q.recall))),
      mrr: round(mean(positives.map((q) => q.reciprocalRank))),
      hitRateAtK: round(mean(positives.map((q) => (q.reciprocalRank > 0 ? 1 : 0)))),
      ndcgAtK: round(mean(positives.map((q) => q.ndcg))),
      falseAcceptRate: round(negatives.length ? negatives.filter((q) => q.retrieved.length > 0).length / negatives.length : null),
      perQuery,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export interface VoiceFixture {
  name: string;
  version: string;
  synthetic: boolean;
  /** Transcript submissions in time order. `expect` is the label for the correct behavior. */
  utterances: Array<{ atMs: number; deviceId: string; utteranceId: string; transcript: string; expect: 'accept' | 'suppress' }>;
  /** Wake attempts: was the wake word intended, and did the detector fire? */
  wakeAttempts: Array<{ intended: boolean; fired: boolean }>;
}

export interface VoiceReport {
  fixture: string; version: string; synthetic: boolean;
  utterances: number; accepted: number; suppressed: number;
  /** A duplicate that created a second task (must be 0). */
  duplicateAccepted: number;
  /** A genuine new command that was wrongly suppressed. */
  falseSuppressed: number;
  suppressionAccuracy: number | null;
  tasksPerAcceptedUtterance: number | null;
  wake: { attempts: number; falseAccepts: number; falseRejects: number; falseAcceptRate: number | null; falseRejectRate: number | null };
}

export function evaluateVoice(fixture: VoiceFixture, windowMs = 5000): VoiceReport {
  if (!Array.isArray(fixture.utterances) || !Array.isArray(fixture.wakeAttempts)) throw new Error('Fixture needs utterances and wakeAttempts arrays.');
  let now = 0;
  const guard = new VoiceUtteranceGuard(windowMs, 10 * 60_000, 500, () => now);
  const tasks = new Map<string, number>();
  let accepted = 0, suppressed = 0, duplicateAccepted = 0, falseSuppressed = 0, correct = 0;
  const ordered = [...fixture.utterances].sort((a, b) => a.atMs - b.atMs);
  for (const u of ordered) {
    now = u.atMs;
    const claim = guard.claim(u.deviceId, u.utteranceId, u.transcript);
    if (claim.accepted) {
      accepted += 1;
      tasks.set(`${u.deviceId}:${u.utteranceId}`, 1);
      if (u.expect === 'suppress') duplicateAccepted += 1; else correct += 1;
    } else {
      suppressed += 1;
      if (u.expect === 'accept') falseSuppressed += 1; else correct += 1;
    }
  }
  // Wake metrics reuse the production counter so the rate formulas are the real ones.
  const metrics = new WakeMetrics(() => 0);
  const record = (event: WakeEvent) => metrics.record(event);
  for (const attempt of fixture.wakeAttempts) {
    if (attempt.fired) { record('wake_detected'); if (!attempt.intended) record('false_accept'); }
    else if (attempt.intended) record('false_reject');
  }
  const snap = metrics.snapshot();
  return {
    fixture: fixture.name, version: fixture.version, synthetic: fixture.synthetic !== false,
    utterances: ordered.length, accepted, suppressed, duplicateAccepted, falseSuppressed,
    suppressionAccuracy: round(ordered.length ? correct / ordered.length : null),
    tasksPerAcceptedUtterance: round(accepted ? tasks.size / accepted : null),
    wake: { attempts: fixture.wakeAttempts.length, falseAccepts: snap.counts.false_accept, falseRejects: snap.counts.false_reject, falseAcceptRate: round(snap.falseAcceptRate), falseRejectRate: round(snap.falseRejectRate) },
  };
}

/**
 * Configurable evaluation suite (D2.15). Which k values to measure and which minimum
 * thresholds gate the run are owner configuration, never hardcoded: JARVIS_EVAL_K (comma list,
 * 1-8, default "3,5") and JARVIS_EVAL_MIN_<METRIC> (recall, precision, mrr, ndcg, hit) as
 * fractions in [0,1]; JARVIS_EVAL_MAX_FALSE_ACCEPT bounds the negative-query false-accept rate.
 * Unset thresholds do not gate. The suite reports measurements of the supplied fixtures only.
 */
export interface RetrievalEvalConfig {
  kValues: number[];
  minimums: Partial<Record<'recall' | 'precision' | 'mrr' | 'ndcg' | 'hit', number>>;
  maxFalseAccept?: number;
}

export function readRetrievalEvalConfig(env: Record<string, string | undefined> = process.env): RetrievalEvalConfig {
  const kValues = (env['JARVIS_EVAL_K'] ?? '3,5').split(',').map((item) => Number(item.trim()));
  if (!kValues.length || kValues.some((k) => !Number.isInteger(k) || k < 1 || k > 8)) throw new Error('JARVIS_EVAL_K must be a comma list of integers from 1 to 8.');
  const fraction = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be a number from 0 to 1.`);
    return value;
  };
  const minimums: RetrievalEvalConfig['minimums'] = {};
  for (const [key, name] of [['recall', 'RECALL'], ['precision', 'PRECISION'], ['mrr', 'MRR'], ['ndcg', 'NDCG'], ['hit', 'HIT']] as const) {
    const value = fraction(`JARVIS_EVAL_MIN_${name}`);
    if (value !== undefined) minimums[key] = value;
  }
  return { kValues: [...new Set(kValues)].sort((a, b) => a - b), minimums, maxFalseAccept: fraction('JARVIS_EVAL_MAX_FALSE_ACCEPT') };
}

export interface RetrievalSuiteResult {
  reports: RetrievalReport[];
  failures: string[];
  passed: boolean;
}

export async function evaluateRetrievalSuite(fixtures: RetrievalFixture[], config: RetrievalEvalConfig = readRetrievalEvalConfig()): Promise<RetrievalSuiteResult> {
  const reports: RetrievalReport[] = [];
  const failures: string[] = [];
  for (const fixture of fixtures) {
    for (const k of config.kValues) {
      const report = await evaluateRetrieval(fixture, k);
      reports.push(report);
      const measured: Record<keyof RetrievalEvalConfig['minimums'], number | null> = { recall: report.recallAtK, precision: report.precisionAtK, mrr: report.mrr, ndcg: report.ndcgAtK, hit: report.hitRateAtK };
      for (const [metric, minimum] of Object.entries(config.minimums) as Array<[keyof typeof measured, number]>) {
        const value = measured[metric];
        if (value !== null && value < minimum) failures.push(`${fixture.name}@${k}: ${metric} ${value} is below the minimum ${minimum}`);
      }
      if (config.maxFalseAccept !== undefined && report.falseAcceptRate !== null && report.falseAcceptRate > config.maxFalseAccept) {
        failures.push(`${fixture.name}@${k}: false-accept rate ${report.falseAcceptRate} exceeds ${config.maxFalseAccept}`);
      }
    }
  }
  return { reports, failures, passed: failures.length === 0 };
}
