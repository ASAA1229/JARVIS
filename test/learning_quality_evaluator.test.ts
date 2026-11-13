import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LearningQualityEvaluator } from '../src/memory/learningQualityEvaluator.ts';

const token = 'learning-quality-test-owner-token-0123456789';

test('learning quality records precision, recall, reciprocal rank and owner feedback without storing identifiers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-quality-'));
  const path = join(dir, 'quality.enc');
  try {
    const evaluator = new LearningQualityEvaluator(path, token);
    const result = evaluator.record({
      retrievedIds: ['m1', 'm2', 'm3'],
      relevantIds: ['m2', 'm3'],
      rating: 'helpful',
    });
    assert.equal(result.sampleCount, 1);
    assert.equal(result.precisionAtK, 2 / 3);
    assert.equal(result.recallAtK, 1);
    assert.equal(result.meanReciprocalRank, 0.5);
    assert.equal(result.helpfulRate, 1);
    assert.equal(result.correctionRate, 0);
    assert.equal(result.trend, 'insufficient_data');
    const encrypted = readFileSync(path, 'utf8');
    assert.equal(encrypted.includes('m1'), false);
    assert.equal(encrypted.includes('m2'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('learning quality persists encrypted aggregates and calculates a trend only after enough samples', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-quality-'));
  const path = join(dir, 'quality.enc');
  try {
    let evaluator = new LearningQualityEvaluator(path, token);
    for (let i = 0; i < 20; i++) evaluator.record({ retrievedIds: ['good'], relevantIds: ['good'], rating: 'not_helpful' });
    for (let i = 0; i < 20; i++) evaluator.record({ retrievedIds: ['good'], relevantIds: ['good'], rating: 'helpful' });
    evaluator = new LearningQualityEvaluator(path, token);
    const result = evaluator.summary();
    assert.equal(result.sampleCount, 40);
    assert.equal(result.previousHelpfulRate, 0);
    assert.equal(result.recentHelpfulRate, 1);
    assert.equal(result.trend, 'improving');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('learning quality tracks owner acceptance of proposed learning candidates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-quality-'));
  const path = join(dir, 'quality.enc');
  try {
    const evaluator = new LearningQualityEvaluator(path, token);
    evaluator.recordCandidateDecision('approved');
    evaluator.recordCandidateDecision('approved');
    evaluator.recordCandidateDecision('rejected');
    const reloaded = new LearningQualityEvaluator(path, token).summary();
    assert.equal(reloaded.candidateApprovals, 2);
    assert.equal(reloaded.candidateRejections, 1);
    assert.equal(reloaded.candidateAcceptanceRate, 2 / 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('learning quality rejects invalid ratings, empty ground truth and oversized judgements', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-quality-'));
  try {
    const evaluator = new LearningQualityEvaluator(join(dir, 'quality.enc'), token);
    assert.throws(() => evaluator.record({ retrievedIds: [], relevantIds: [], rating: 'helpful' }), /relevant memory ID/i);
    assert.throws(() => evaluator.record({ retrievedIds: Array(101).fill('x'), relevantIds: ['x'], rating: 'helpful' }), /valid retrieval judgement/i);
    assert.throws(() => evaluator.record({ retrievedIds: ['x'], relevantIds: ['x'], rating: 'bad' as never }), /valid retrieval judgement/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
