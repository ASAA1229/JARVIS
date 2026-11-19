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
  /** Fraction of negative queries that returned at least one result. */
  falseAcceptRate: number | null;
  perQuery: Array<{ query: string; retrieved: string[]; relevant: string[]; precision: number; recall: number; reciprocalRank: number }>;
}

const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const round = (value: number | null) => (value === null ? null : Math.round(value * 10000) / 10000);

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
