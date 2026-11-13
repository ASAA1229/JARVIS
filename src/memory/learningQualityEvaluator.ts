/**
 * Owner-judged learning/retrieval quality measurement.
 *
 * Only aggregate metrics and timestamps are persisted; raw queries, memory text,
 * and memory identifiers are deliberately discarded after each evaluation.
 */
import { EncryptedJsonFile } from './encryptedJsonFile.js';

export type LearningQualityRating = 'helpful' | 'not_helpful';

export interface LearningQualityInput {
  retrievedIds: string[];
  relevantIds: string[];
  rating: LearningQualityRating;
}

interface LearningQualitySample {
  at: number;
  precisionAtK: number;
  recallAtK: number;
  reciprocalRank: number;
  helpful: boolean;
  k: number;
}

interface LearningQualityFile {
  version: 1;
  samples: LearningQualitySample[];
  candidateDecisions?: { approved: number; rejected: number };
}

export interface LearningQualitySummary {
  sampleCount: number;
  precisionAtK: number | null;
  recallAtK: number | null;
  meanReciprocalRank: number | null;
  helpfulRate: number | null;
  correctionRate: number | null;
  recentHelpfulRate: number | null;
  previousHelpfulRate: number | null;
  trend: 'improving' | 'declining' | 'stable' | 'insufficient_data';
  minimumSamplesForTrend: number;
  lastEvaluatedAt: number | null;
  candidateApprovals: number;
  candidateRejections: number;
  candidateAcceptanceRate: number | null;
}

const MAX_SAMPLES = 500;
const MIN_TREND_SAMPLES = 20;

function average(values: number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

export class LearningQualityEvaluator {
  private readonly file: EncryptedJsonFile<LearningQualityFile>;
  private data: LearningQualityFile = { version: 1, samples: [] };

  constructor(filePath: string, ownerControlToken: string) {
    this.file = new EncryptedJsonFile<LearningQualityFile>(filePath, ownerControlToken, 'JARVIS-LEARNING-QUALITY-V1');
    const loaded = this.file.read();
    if (loaded) {
      if (loaded.version !== 1 || !Array.isArray(loaded.samples) ||
          loaded.samples.some((sample) => !sample || !Number.isFinite(sample.at) ||
            !Number.isFinite(sample.precisionAtK) || !Number.isFinite(sample.recallAtK) ||
            !Number.isFinite(sample.reciprocalRank) || typeof sample.helpful !== 'boolean' ||
            !Number.isInteger(sample.k) || sample.k < 0)) {
        throw new Error('Learning quality history is invalid; refusing to overwrite it.');
      }
      this.data = { ...loaded, candidateDecisions: loaded.candidateDecisions ?? { approved: 0, rejected: 0 } };
    }
  }

  recordCandidateDecision(decision: 'approved' | 'rejected'): LearningQualitySummary {
    this.data.candidateDecisions ??= { approved: 0, rejected: 0 };
    this.data.candidateDecisions[decision] += 1;
    this.file.write(this.data);
    return this.summary();
  }

  record(input: LearningQualityInput): LearningQualitySummary {
    if (!input || !Array.isArray(input.retrievedIds) || !Array.isArray(input.relevantIds) ||
        input.retrievedIds.length > 100 || input.relevantIds.length > 100 ||
        input.retrievedIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128) ||
        input.relevantIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 128) ||
        !['helpful', 'not_helpful'].includes(input.rating)) {
      throw new Error('A valid retrieval judgement is required (up to 100 retrieved and relevant IDs, plus a rating).');
    }
    const retrieved = [...new Set(input.retrievedIds)];
    const relevant = new Set(input.relevantIds);
    if (relevant.size === 0) throw new Error('At least one owner-identified relevant memory ID is required.');
    const hits = retrieved.filter((id) => relevant.has(id)).length;
    const firstRelevant = retrieved.findIndex((id) => relevant.has(id));
    this.data.samples.push({
      at: Date.now(),
      precisionAtK: retrieved.length ? hits / retrieved.length : 0,
      recallAtK: hits / relevant.size,
      reciprocalRank: firstRelevant < 0 ? 0 : 1 / (firstRelevant + 1),
      helpful: input.rating === 'helpful',
      k: retrieved.length,
    });
    if (this.data.samples.length > MAX_SAMPLES) this.data.samples.splice(0, this.data.samples.length - MAX_SAMPLES);
    this.file.write(this.data);
    return this.summary();
  }

  summary(): LearningQualitySummary {
    const samples = this.data.samples;
    const helpful = samples.map((sample) => sample.helpful ? 1 : 0);
    const recent = helpful.slice(-MIN_TREND_SAMPLES);
    const previous = helpful.slice(-MIN_TREND_SAMPLES * 2, -MIN_TREND_SAMPLES);
    const recentRate = average(recent);
    const previousRate = previous.length === MIN_TREND_SAMPLES ? average(previous) : null;
    let trend: LearningQualitySummary['trend'] = 'insufficient_data';
    if (samples.length >= MIN_TREND_SAMPLES * 2 && recentRate !== null && previousRate !== null) {
      trend = recentRate - previousRate > 0.05 ? 'improving'
        : previousRate - recentRate > 0.05 ? 'declining' : 'stable';
    }
    return {
      sampleCount: samples.length,
      precisionAtK: average(samples.map((sample) => sample.precisionAtK)),
      recallAtK: average(samples.map((sample) => sample.recallAtK)),
      meanReciprocalRank: average(samples.map((sample) => sample.reciprocalRank)),
      helpfulRate: average(helpful),
      correctionRate: average(helpful.map((value) => 1 - value)),
      recentHelpfulRate: recentRate,
      previousHelpfulRate: previousRate,
      trend,
      minimumSamplesForTrend: MIN_TREND_SAMPLES * 2,
      lastEvaluatedAt: samples.at(-1)?.at ?? null,
      candidateApprovals: this.data.candidateDecisions?.approved ?? 0,
      candidateRejections: this.data.candidateDecisions?.rejected ?? 0,
      candidateAcceptanceRate: ((this.data.candidateDecisions?.approved ?? 0) + (this.data.candidateDecisions?.rejected ?? 0))
        ? (this.data.candidateDecisions?.approved ?? 0) / ((this.data.candidateDecisions?.approved ?? 0) + (this.data.candidateDecisions?.rejected ?? 0))
        : null,
    };
  }
}
