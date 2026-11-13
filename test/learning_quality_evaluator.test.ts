import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.ts';
import { WorkingMemory } from '../src/memory/workingMemory.ts';
import { MemoryManager } from '../src/memory/memoryManager.ts';
import { SemanticMemoryIndex } from '../src/memory/semanticIndex.ts';
import { LearningQualityEvaluator } from '../src/memory/learningQualityEvaluator.ts';
import { LEARNING_RETRIEVAL_BENCHMARK, LEARNING_RETRIEVAL_BENCHMARK_VERSION } from './fixtures/learning-retrieval-benchmark.ts';

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

test('learning quality evaluates the live ranked memory retriever without persisting the query or memory IDs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-retrieval-'));
  const candidatesPath = join(dir, 'candidates.enc');
  try {
    const store = new PersonalMemoryStore(join(dir, 'memories.enc'), token);
    const memory = store.save('project', 'JARVIS local wake phrase is Hey Jarvis with explicit microphone consent.');
    const manager = new MemoryManager(store, new WorkingMemory(), candidatesPath, token, {
      index: new SemanticMemoryIndex(join(dir, 'index.enc'), token, null),
    });
    const result = await manager.evaluateRetrieval({
      query: 'JARVIS local wake phrase microphone consent',
      relevantIds: [memory.id],
      rating: 'helpful',
    });
    assert.equal(result.retrievedCount, 1);
    assert.equal(result.quality.sampleCount, 1);
    assert.equal(result.quality.precisionAtK, 1);
    assert.equal(result.quality.recallAtK, 1);
    assert.equal(result.quality.meanReciprocalRank, 1);
    const persistedQuality = readFileSync(candidatesPath + '.quality', 'utf8');
    assert.equal(persistedQuality.includes('JARVIS local wake phrase microphone consent'), false);
    assert.equal(persistedQuality.includes(memory.id), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('versioned synthetic retrieval benchmark scores the actual ranked retriever', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-benchmark-'));
  try {
    const store = new PersonalMemoryStore(join(dir, 'memories.enc'), token);
    const expected = new Map<string, string>();
    for (const item of LEARNING_RETRIEVAL_BENCHMARK) {
      const saved = store.save(item.category, item.content);
      expected.set(item.key, saved.id);
    }
    const manager = new MemoryManager(store, new WorkingMemory(), join(dir, 'candidates.enc'), token, {
      index: new SemanticMemoryIndex(join(dir, 'index.enc'), token, null),
    });
    for (const item of LEARNING_RETRIEVAL_BENCHMARK) {
      const relevantId = expected.get(item.key)!;
      const ranked = await manager.rankLongTerm(item.query, 5);
      assert.equal(ranked[0]?.memory.id, relevantId, 'benchmark ' + item.key + ' (' + LEARNING_RETRIEVAL_BENCHMARK_VERSION + ')');
      await manager.evaluateRetrieval({ query: item.query, relevantIds: [relevantId], rating: 'helpful', limit: 5 });
    }
    const quality = manager.status().quality;
    assert.equal(quality.sampleCount, LEARNING_RETRIEVAL_BENCHMARK.length);
    assert.equal(quality.precisionAtK, 1);
    assert.equal(quality.recallAtK, 1);
    assert.equal(quality.meanReciprocalRank, 1);
    assert.equal(quality.helpfulRate, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live retrieval evaluation rejects invalid query and limit before recording a sample', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-learning-retrieval-'));
  try {
    const store = new PersonalMemoryStore(join(dir, 'memories.enc'), token);
    const manager = new MemoryManager(store, new WorkingMemory(), join(dir, 'candidates.enc'), token, {
      index: new SemanticMemoryIndex(join(dir, 'index.enc'), token, null),
    });
    await assert.rejects(() => manager.evaluateRetrieval({
      query: ' ', relevantIds: ['known'], rating: 'helpful',
    }), /retrieval query/i);
    await assert.rejects(() => manager.evaluateRetrieval({
      query: 'valid query', relevantIds: ['known'], rating: 'helpful', limit: 21,
    }), /limit/i);
    assert.equal(manager.status().quality.sampleCount, 0);
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
