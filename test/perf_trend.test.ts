import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { compareToBaseline, type PerfReport } from '../src/evaluation/perfTrend.js';

/** JARVIS-GAP-015: trend comparison against a stored baseline with a regression threshold. */
const root = resolve(import.meta.dirname, '..');
const report = (overrides: Partial<PerfReport> = {}): PerfReport => ({
  machine: { cpu: 'Test CPU', logicalCpus: 8, node: 'v24' },
  config: { iterations: 200, soakSeconds: 20 },
  latencyMs: [{ name: 'planner', p50: 0.1, p95: 0.3, opsPerSec: 5000 }, { name: 'audit', p50: 7, p95: 30, opsPerSec: 80 }],
  process: { rssMbEnd: 100 },
  soak: { seconds: 20, cycles: 600, failures: 0, leakedActive: 0, leakedLocks: 0 },
  ...overrides,
});

test('identical runs show no regression', () => {
  const result = compareToBaseline(report(), report());
  assert.equal(result.comparable, true);
  assert.equal(result.regression, false);
});

test('a latency increase must exceed BOTH the relative threshold and the absolute noise floor', () => {
  // +200% but only +0.6 ms: sub-floor jitter is not a regression.
  const jitter = compareToBaseline(report({ latencyMs: [{ name: 'planner', p50: 0.1, p95: 0.9, opsPerSec: 1 }, { name: 'audit', p50: 7, p95: 30, opsPerSec: 80 }] }), report());
  assert.equal(jitter.regression, false);
  // +50% and +15 ms: a real regression.
  const slow = compareToBaseline(report({ latencyMs: [{ name: 'planner', p50: 0.1, p95: 0.3, opsPerSec: 5000 }, { name: 'audit', p50: 7, p95: 45, opsPerSec: 50 }] }), report());
  assert.equal(slow.regression, true);
  const finding = slow.findings.find((f) => f.metric === 'audit p95 ms')!;
  assert.equal(finding.regression, true);
  assert.equal(finding.change, '+50.0%');
  // The same increase is tolerated under a looser threshold.
  assert.equal(compareToBaseline(report({ latencyMs: [{ name: 'planner', p50: 0.1, p95: 0.3, opsPerSec: 5000 }, { name: 'audit', p50: 7, p95: 45, opsPerSec: 50 }] }), report(), { threshold: 0.6 }).regression, false);
});

test('faster runs, new paths and missing paths are classified correctly', () => {
  assert.equal(compareToBaseline(report({ latencyMs: [{ name: 'planner', p50: 0.05, p95: 0.1, opsPerSec: 9000 }, { name: 'audit', p50: 3, p95: 10, opsPerSec: 200 }] }), report()).regression, false);
  const added = compareToBaseline(report({ latencyMs: [...report().latencyMs, { name: 'extra', p50: 1, p95: 2, opsPerSec: 1 }] }), report());
  assert.equal(added.regression, false);
  assert.ok(added.findings.some((f) => f.metric.includes('new path')));
  const missing = compareToBaseline(report({ latencyMs: [report().latencyMs[0]] }), report());
  assert.equal(missing.regression, true, 'a benchmark that disappeared hides regressions and is flagged');
});

test('memory growth, soak failures, leaks and throughput collapse are flagged', () => {
  assert.equal(compareToBaseline(report({ process: { rssMbEnd: 200 } }), report()).regression, true);
  assert.equal(compareToBaseline(report({ process: { rssMbEnd: 120 } }), report()).regression, false);
  assert.equal(compareToBaseline(report({ soak: { seconds: 20, cycles: 600, failures: 1, leakedActive: 0, leakedLocks: 0 } }), report()).regression, true);
  assert.equal(compareToBaseline(report({ soak: { seconds: 20, cycles: 600, failures: 0, leakedActive: 0, leakedLocks: 2 } }), report()).regression, true);
  const slowSoak = compareToBaseline(report({ soak: { seconds: 20, cycles: 300, failures: 0, leakedActive: 0, leakedLocks: 0 } }), report());
  assert.equal(slowSoak.regression, true);
  assert.equal(slowSoak.findings.find((f) => f.metric === 'soak cycles/s')?.change, '-50.0%');
});

test('runs from different hardware are not compared and invalid thresholds are rejected', () => {
  const other = compareToBaseline(report({ machine: { cpu: 'Other CPU', logicalCpus: 8, node: 'v24' } }), report());
  assert.equal(other.comparable, false);
  assert.equal(other.regression, false);
  assert.match(other.reason ?? '', /different hardware/);
  assert.throws(() => compareToBaseline(report(), report(), { threshold: 0 }), /threshold/);
  assert.throws(() => compareToBaseline(report(), report(), { threshold: 99 }), /threshold/);
});

test('CLI saves a baseline and compares a fresh run against it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-perf-trend-'));
  try {
    const base = join(dir, 'baseline.json');
    const run = (...extra: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'scripts/perf-soak.ts', '--iterations', '10', ...extra], { cwd: root, encoding: 'utf8' });
    const saved = run('--save-baseline', base);
    assert.match(saved.stdout, /Baseline saved/);
    assert.ok(existsSync(base));
    const compared = run('--baseline', base, '--regression-threshold', '10');
    assert.match(compared.stdout, /Trend:|TREND REGRESSION/);
    assert.doesNotMatch(compared.stdout, /not comparable/);
    const missing = run('--baseline', join(dir, 'nope.json'));
    assert.match(missing.stderr, /Baseline file not found/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
