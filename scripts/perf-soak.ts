/**
 * JARVIS-GAP-015: repeatable local performance / soak harness.
 *
 * Usage:  npx tsx scripts/perf-soak.ts [--iterations N] [--soak-seconds S] [--json out.json]
 *            [--save-baseline file.json] [--baseline file.json --regression-threshold 0.25]
 *
 * Measures latency percentiles, CPU time and memory growth of core in-process paths
 * on THIS machine. It prints measured numbers only; budgets are evaluated against
 * the constants below, which are provisional until baselined on the target MSI box.
 * No network, no external services, no real device or application actions.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { LocalHeuristicPlanner } from '../src/planner/planner.js';
import { AuditLogger } from '../src/audit/audit.js';
import { PersonalMemoryStore } from '../src/memory/personalMemoryStore.js';
import { DocumentRagStore } from '../src/memory/documentRagStore.js';
import { TaskCoordinator } from '../src/core/taskCoordinator.js';
import { WorkflowBranchExecutor } from '../src/workflows/workflowExecution.js';
import { VoiceUtteranceGuard } from '../src/voice/utteranceGuard.js';
import { compareToBaseline, type PerfReport } from '../src/evaluation/perfTrend.js';
import type { WorkflowStep } from '../src/workflows/workflowStore.js';

const args = process.argv.slice(2);
const flag = (name: string, fallback: string) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : fallback; };
const ITERATIONS = Math.max(10, Number(flag('--iterations', '200')));
const SOAK_SECONDS = Math.max(0, Number(flag('--soak-seconds', '0')));
const JSON_OUT = flag('--json', '');
const BASELINE = flag('--baseline', '');
const SAVE_BASELINE = flag('--save-baseline', '');
const REGRESSION_THRESHOLD = Number(flag('--regression-threshold', '0.25'));
const TOKEN = 'performance-harness-owner-token-0123456789abcdef';

/** Provisional budgets (p95 ms). Replace after baselining on the target hardware. */
const BUDGET_P95_MS: Record<string, number> = {
  'planner.generatePlan': 50, 'audit.record': 60, 'memory.save+search': 200, 'rag.search(50 docs)': 150,
  'coordinator.run(noop)': 10, 'dag.4-parallel(noop)': 40, 'voice.utteranceGuard.claim': 1,
};

interface Row { name: string; n: number; p50: number; p95: number; p99: number; max: number; opsPerSec: number; budgetP95: number | null; withinBudget: boolean | null }
const rows: Row[] = [];
const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

async function bench(name: string, n: number, fn: (i: number) => Promise<unknown> | unknown): Promise<void> {
  for (let i = 0; i < Math.min(5, n); i++) await fn(-1 - i); // warm-up, not counted
  const samples: number[] = [];
  const started = performance.now();
  for (let i = 0; i < n; i++) { const t = performance.now(); await fn(i); samples.push(performance.now() - t); }
  const total = performance.now() - started;
  samples.sort((a, b) => a - b);
  const budget = BUDGET_P95_MS[name] ?? null;
  const p95 = pct(samples, 95);
  rows.push({ name, n, p50: pct(samples, 50), p95, p99: pct(samples, 99), max: samples[samples.length - 1], opsPerSec: (n / total) * 1000, budgetP95: budget, withinBudget: budget === null ? null : p95 <= budget });
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;
const dir = mkdtempSync(join(tmpdir(), 'jarvis-perf-'));
const heapStart = process.memoryUsage();
const cpuStart = process.cpuUsage();
const wallStart = performance.now();

try {
  const planner = new LocalHeuristicPlanner();
  const requests = ['What is the OS version?', 'launch notepad', 'how much memory is free', 'remember preference: likes dark mode', 'list my repositories'];
  await bench('planner.generatePlan', ITERATIONS, (i) => planner.generatePlan(requests[Math.abs(i) % requests.length], { requesterName: 'perf', timestamp: Date.now() }));

  const audit = new AuditLogger(join(dir, 'audit.log'));
  await bench('audit.record', ITERATIONS, (i) => audit.record('PERF_EVENT', { i }, 'perf-device'));

  const memory = new PersonalMemoryStore(join(dir, 'memory.enc'), TOKEN);
  await bench('memory.save+search', Math.min(ITERATIONS, 100), (i) => { memory.save('general', `Performance memory ${i} about topic ${i % 13} and token ${Math.random()}`); return memory.relevant('topic performance', 5); });

  const rag = new DocumentRagStore(join(dir, 'docs.enc'), TOKEN);
  for (let d = 0; d < 50; d++) rag.ingest({ ownerDeviceId: 'perf', sourceName: `doc${d}.txt`, content: `Document ${d} discusses subject ${d % 7}. `.repeat(60) + ` unique marker ${d}` });
  await bench('rag.search(50 docs)', Math.min(ITERATIONS, 100), () => rag.search('perf', 'subject marker discusses', 5));

  const coordinator = new TaskCoordinator(4, 2, 1000, 30_000);
  let seq = 0;
  await bench('coordinator.run(noop)', ITERATIONS, () => coordinator.run({ taskId: `t${seq++}`, deviceId: 'perf' }, async () => undefined));

  const steps: WorkflowStep[] = ['a', 'b', 'c', 'd'].map((id) => ({ id, operation: 'system:get_memory_info', parameters: {}, dependsOn: [] }));
  let run = 0;
  await bench('dag.4-parallel(noop)', Math.min(ITERATIONS, 100), () => new WorkflowBranchExecutor().run(steps, {
    runId: `perf-${run++}`, maxParallel: 4, checkpoint: async () => undefined, executeStep: async () => ({ status: 'completed' }),
  }));

  const guard = new VoiceUtteranceGuard();
  await bench('voice.utteranceGuard.claim', ITERATIONS * 5, (i) => guard.claim('perf', `utt-${String(i + 10).padStart(10, '0')}-${Math.random().toString(36).slice(2, 8)}`, `command ${i}`));

  // Soak: sustained mixed workload; reports heap/RSS drift and queue health.
  let soak: Record<string, unknown> | null = null;
  if (SOAK_SECONDS > 0) {
    const end = Date.now() + SOAK_SECONDS * 1000;
    const samples: Array<{ t: number; rssMb: number; heapMb: number }> = [];
    let ops = 0, failures = 0, nextSample = Date.now();
    if (global.gc) global.gc();
    while (Date.now() < end) {
      try {
        await planner.generatePlan(requests[ops % requests.length], { requesterName: 'soak', timestamp: Date.now() });
        await coordinator.run({ taskId: `soak${seq++}`, deviceId: 'soak', resources: [`r${ops % 3}`] }, async () => undefined);
        await rag.search('perf', 'subject marker', 3);
        audit.record('SOAK_EVENT', { ops }, 'soak');
        ops += 1;
      } catch { failures += 1; }
      if (Date.now() >= nextSample) { const m = process.memoryUsage(); samples.push({ t: Math.round((Date.now() - (end - SOAK_SECONDS * 1000)) / 1000), rssMb: mb(m.rss), heapMb: mb(m.heapUsed) }); nextSample += Math.max(1000, (SOAK_SECONDS * 1000) / 10); }
    }
    const snap = coordinator.snapshot();
    soak = { seconds: SOAK_SECONDS, cycles: ops, failures, leakedActive: snap.active, leakedLocks: snap.lockedResourceCount, memory: samples };
  }

  const cpu = process.cpuUsage(cpuStart);
  const wallMs = performance.now() - wallStart;
  const mem = process.memoryUsage();
  const report = {
    generatedAt: new Date().toISOString(),
    machine: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10, node: process.version },
    config: { iterations: ITERATIONS, soakSeconds: SOAK_SECONDS },
    latencyMs: rows.map((r) => ({ ...r, p50: +r.p50.toFixed(3), p95: +r.p95.toFixed(3), p99: +r.p99.toFixed(3), max: +r.max.toFixed(3), opsPerSec: Math.round(r.opsPerSec) })),
    process: { wallSeconds: +(wallMs / 1000).toFixed(2), cpuUserSeconds: +(cpu.user / 1e6).toFixed(2), cpuSystemSeconds: +(cpu.system / 1e6).toFixed(2), cpuUtilizationPct: +(((cpu.user + cpu.system) / 1000 / wallMs) * 100).toFixed(1), rssMbStart: mb(heapStart.rss), rssMbEnd: mb(mem.rss), heapUsedMbStart: mb(heapStart.heapUsed), heapUsedMbEnd: mb(mem.heapUsed) },
    soak,
    budgetsProvisional: true,
  };
  console.log(`JARVIS perf harness on ${report.machine.cpu} (${report.machine.logicalCpus} logical CPUs, ${report.machine.totalMemGb} GB), Node ${report.machine.node}`);
  console.table(report.latencyMs.map((r) => ({ path: r.name, n: r.n, 'p50 ms': r.p50, 'p95 ms': r.p95, 'p99 ms': r.p99, 'max ms': r.max, 'ops/s': r.opsPerSec, 'budget p95': r.budgetP95 ?? '-', ok: r.withinBudget ?? '-' })));
  console.log('process:', JSON.stringify(report.process));
  if (soak) console.log('soak:', JSON.stringify(soak));
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(report, null, 2));
  if (SAVE_BASELINE) { writeFileSync(SAVE_BASELINE, JSON.stringify(report, null, 2)); console.log(`Baseline saved to ${SAVE_BASELINE}`); }
  if (BASELINE) {
    if (!existsSync(BASELINE)) { console.error(`Baseline file not found: ${BASELINE}`); process.exitCode = 2; }
    else {
      const trend = compareToBaseline(report as unknown as PerfReport, JSON.parse(readFileSync(BASELINE, 'utf8')) as PerfReport, { threshold: REGRESSION_THRESHOLD });
      if (!trend.comparable) console.log(`Trend: not comparable - ${trend.reason}`);
      else {
        console.table(trend.findings.map((f) => ({ metric: f.metric, baseline: Number.isFinite(f.baseline) ? +f.baseline.toFixed(3) : '-', current: Number.isFinite(f.current) ? +f.current.toFixed(3) : '-', change: f.change, regression: f.regression })));
        console.log(trend.regression ? `TREND REGRESSION: at least one metric exceeds the ${REGRESSION_THRESHOLD * 100}% threshold.` : 'Trend: no regression against baseline.');
        if (trend.regression) process.exitCode = 1;
      }
    }
  }
  if (rows.some((r) => r.withinBudget === false) || (soak && (soak.failures as number) > 0)) process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
