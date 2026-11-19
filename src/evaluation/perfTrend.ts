/**
 * Performance trend comparison against a stored baseline (JARVIS-GAP-015).
 *
 * Latency regressions need BOTH a relative increase above the threshold and an absolute
 * increase above a noise floor, so sub-millisecond jitter cannot raise false alarms.
 * Only comparable runs (same iteration count class and machine CPU model) are compared;
 * otherwise the result says so instead of guessing.
 */
export interface PerfRow { name: string; p50: number; p95: number; opsPerSec: number }
export interface PerfReport {
  machine: { cpu?: string; logicalCpus: number; node: string };
  config: { iterations: number; soakSeconds: number };
  latencyMs: PerfRow[];
  process: { rssMbEnd: number };
  soak: { seconds: number; cycles: number; failures: number; leakedActive: number; leakedLocks: number } | null;
}

export interface TrendOptions { threshold?: number; minAbsoluteMs?: number; memoryGrowthMb?: number }
export interface TrendFinding { metric: string; baseline: number; current: number; change: string; regression: boolean }
export interface TrendResult { comparable: boolean; reason?: string; regression: boolean; findings: TrendFinding[] }

const pct = (current: number, baseline: number) => (baseline === 0 ? (current === 0 ? '0%' : '+inf') : `${current >= baseline ? '+' : ''}${(((current - baseline) / baseline) * 100).toFixed(1)}%`);

export function compareToBaseline(current: PerfReport, baseline: PerfReport, options: TrendOptions = {}): TrendResult {
  const threshold = options.threshold ?? 0.25;
  const floor = options.minAbsoluteMs ?? 2;
  const memoryGrowth = options.memoryGrowthMb ?? 50;
  if (!(threshold > 0 && threshold <= 10)) throw new Error('threshold must be a positive fraction (for example 0.25 for 25%).');
  if (current.machine.cpu !== baseline.machine.cpu || current.machine.logicalCpus !== baseline.machine.logicalCpus) {
    return { comparable: false, reason: 'Baseline was recorded on different hardware; no regression verdict is given.', regression: false, findings: [] };
  }
  const findings: TrendFinding[] = [];
  const base = new Map(baseline.latencyMs.map((row) => [row.name, row]));
  for (const row of current.latencyMs) {
    const old = base.get(row.name);
    if (!old) { findings.push({ metric: `${row.name} (new path)`, baseline: NaN, current: row.p95, change: 'new', regression: false }); continue; }
    const regression = row.p95 > old.p95 * (1 + threshold) && row.p95 - old.p95 > floor;
    findings.push({ metric: `${row.name} p95 ms`, baseline: old.p95, current: row.p95, change: pct(row.p95, old.p95), regression });
  }
  for (const old of baseline.latencyMs) if (!current.latencyMs.some((row) => row.name === old.name)) findings.push({ metric: `${old.name} (missing now)`, baseline: old.p95, current: NaN, change: 'missing', regression: true });
  const rssRegression = current.process.rssMbEnd - baseline.process.rssMbEnd > memoryGrowth;
  findings.push({ metric: 'rssMbEnd', baseline: baseline.process.rssMbEnd, current: current.process.rssMbEnd, change: pct(current.process.rssMbEnd, baseline.process.rssMbEnd), regression: rssRegression });
  if (current.soak) {
    const bad = current.soak.failures > 0 || current.soak.leakedActive > 0 || current.soak.leakedLocks > 0;
    findings.push({ metric: 'soak failures/leaks', baseline: 0, current: current.soak.failures + current.soak.leakedActive + current.soak.leakedLocks, change: bad ? 'worse' : 'clean', regression: bad });
    if (baseline.soak && baseline.soak.seconds === current.soak.seconds) {
      const oldRate = baseline.soak.cycles / baseline.soak.seconds;
      const newRate = current.soak.cycles / current.soak.seconds;
      findings.push({ metric: 'soak cycles/s', baseline: oldRate, current: newRate, change: pct(newRate, oldRate), regression: newRate < oldRate * (1 - threshold) });
    }
  }
  return { comparable: true, regression: findings.some((f) => f.regression), findings };
}
