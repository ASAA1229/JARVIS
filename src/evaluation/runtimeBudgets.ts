/**
 * Provisional runtime budgets (JARVIS-US-025 / JARVIS-GAP-015).
 *
 * These are NOT owner-agreed targets: they are conservative placeholders so the owner metrics
 * endpoint can say "within / outside budget" from measured values. Latency percentiles are
 * measured offline by `npm run perf` (see perf/baseline.*.json); this module covers what the
 * running service can observe cheaply: CPU, memory, queue pressure and reliability rates.
 *
 * Pure functions over the health snapshot: no I/O, no prompts, no ids.
 */
export interface RuntimeBudgets {
  provisional: true;
  cpuUsagePercentMax: number;
  memoryUsedPercentMax: number;
  processRssBytesMax: number;
  queueWaitMsMax: number;
  /** queued / queue limit, 0..1 */
  queueFillRatioMax: number;
  crashFreeCompletionRateMin: number;
  verifiedOutcomeRateMin: number;
}

export const PROVISIONAL_RUNTIME_BUDGETS: RuntimeBudgets = {
  provisional: true,
  cpuUsagePercentMax: 85,
  memoryUsedPercentMax: 90,
  processRssBytesMax: 1024 * 1024 * 1024,
  queueWaitMsMax: 30_000,
  queueFillRatioMax: 0.8,
  crashFreeCompletionRateMin: 0.95,
  verifiedOutcomeRateMin: 0.9,
};

export type BudgetStatus = 'ok' | 'exceeded' | 'unknown';

export interface BudgetCheck {
  name: string;
  /** 'max' means observed must be at or below the budget; 'min' at or above. */
  kind: 'max' | 'min';
  budget: number;
  observed: number | null;
  status: BudgetStatus;
}

export interface BudgetEvaluation {
  provisional: true;
  overall: BudgetStatus;
  checks: BudgetCheck[];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

/** Maximum queued-task wait in ms from a coordinator snapshot shape (ids are never read out). */
export function maxQueueWaitMs(queue: Record<string, unknown>): number | null {
  const queued = queue.queuedTasks;
  if (!Array.isArray(queued)) return null;
  if (queued.length === 0) return 0;
  return queued.reduce<number>((max, item) => Math.max(max, num(record(item).waitedMs) ?? 0), 0);
}

export function evaluateRuntimeBudgets(snapshot: Record<string, unknown>, budgets: RuntimeBudgets = PROVISIONAL_RUNTIME_BUDGETS): BudgetEvaluation {
  const host = record(snapshot.host);
  const tasks = record(snapshot.tasks);
  const queue = record(tasks.executionQueue);
  const reliability = record(tasks.reliability);
  const limits = record(queue.limits);
  const queuedCount = num(queue.queued);
  const queueLimit = num(limits.queued);

  const raw: Array<Omit<BudgetCheck, 'status'>> = [
    { name: 'cpuUsagePercent', kind: 'max', budget: budgets.cpuUsagePercentMax, observed: num(host.cpuUsagePercent) },
    { name: 'memoryUsedPercent', kind: 'max', budget: budgets.memoryUsedPercentMax, observed: num(host.memoryUsedPercent) },
    { name: 'processRssBytes', kind: 'max', budget: budgets.processRssBytesMax, observed: num(host.processRssBytes) },
    { name: 'queueWaitMs', kind: 'max', budget: budgets.queueWaitMsMax, observed: maxQueueWaitMs(queue) },
    { name: 'queueFillRatio', kind: 'max', budget: budgets.queueFillRatioMax, observed: queuedCount !== null && queueLimit && queueLimit > 0 ? Math.round((queuedCount / queueLimit) * 10000) / 10000 : null },
    { name: 'crashFreeCompletionRate', kind: 'min', budget: budgets.crashFreeCompletionRateMin, observed: num(reliability.crashFreeCompletionRate) },
    { name: 'verifiedOutcomeRate', kind: 'min', budget: budgets.verifiedOutcomeRateMin, observed: num(reliability.verifiedOutcomeRate) },
  ];
  const checks: BudgetCheck[] = raw.map((check) => ({
    ...check,
    status: check.observed === null ? 'unknown' : (check.kind === 'max' ? check.observed <= check.budget : check.observed >= check.budget) ? 'ok' : 'exceeded',
  }));
  const overall: BudgetStatus = checks.some((check) => check.status === 'exceeded') ? 'exceeded' : checks.some((check) => check.status === 'unknown') ? 'unknown' : 'ok';
  return { provisional: true, overall, checks };
}

/** Secret-free measurement summary for the metrics endpoint: aggregates only, no task ids. */
export function summarizeMeasurements(snapshot: Record<string, unknown>): Record<string, unknown> {
  const host = record(snapshot.host);
  const tasks = record(snapshot.tasks);
  const queue = record(tasks.executionQueue);
  const planning = record(queue.planning);
  const limits = record(queue.limits);
  return {
    uptimeSeconds: num(snapshot.uptimeSeconds),
    core: record(snapshot.core),
    host: {
      platform: typeof host.platform === 'string' ? host.platform : null,
      logicalCores: num(host.logicalCores),
      cpuUsagePercent: num(host.cpuUsagePercent),
      memoryUsedPercent: num(host.memoryUsedPercent),
      processRssBytes: num(host.processRssBytes),
    },
    tasks: {
      total: num(tasks.total),
      running: num(tasks.running),
      awaitingApproval: num(tasks.awaitingApproval),
      awaitingRecovery: num(tasks.awaitingRecovery),
      failed: num(tasks.failed),
      reliability: record(tasks.reliability),
    },
    executionQueue: {
      active: num(queue.active),
      queued: num(queue.queued),
      maxWaitMs: maxQueueWaitMs(queue),
      limits: { global: num(limits.global), perDevice: num(limits.perDevice), queued: num(limits.queued) },
      planningQueued: num(planning.queued),
    },
    schedulesActive: num(record(snapshot.schedules).active),
  };
}
