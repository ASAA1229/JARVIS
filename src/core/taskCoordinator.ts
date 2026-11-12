import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Bounded, cancellation-aware task execution coordinator.
 *
 * All requested resource locks are acquired atomically in sorted order. A task
 * never holds one lock while waiting for another, which prevents circular-wait
 * deadlocks. The coordinator bounds global and per-device concurrency and uses
 * priority aging to reduce starvation.
 */
export interface TaskExecutionRequest {
  taskId: string;
  deviceId: string;
  priority?: number;
  resources?: string[];
  signal?: AbortSignal;
  queueTimeoutMs?: number;
}

export interface TaskCoordinatorSnapshot {
  active: number;
  queued: number;
  activeTasks: string[];
  queuedTasks: Array<{ taskId: string; priority: number; waitedMs: number; blockedByResource: boolean; blockedByDeviceLimit: boolean }>;
  activeByDevice: Record<string, number>;
  lockedResourceCount: number;
  limits: { global: number; perDevice: number; queued: number };
}

interface QueueEntry<T> {
  request: Required<Pick<TaskExecutionRequest, 'taskId' | 'deviceId'>> & TaskExecutionRequest;
  work: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  enqueuedAt: number;
  sequence: number;
  timer?: ReturnType<typeof setTimeout>;
  abort?: () => void;
  settled: boolean;
}

export class TaskQueueFullError extends Error {
  constructor() { super('JARVIS task queue is full; no work was started.'); this.name = 'TaskQueueFullError'; }
}
export class TaskQueueTimeoutError extends Error {
  constructor() { super('Task waited too long for execution capacity; no operation was started.'); this.name = 'TaskQueueTimeoutError'; }
}
export class TaskAlreadyRunningError extends Error {
  constructor() { super('This task already has an active or queued execution.'); this.name = 'TaskAlreadyRunningError'; }
}
export class NestedTaskExecutionError extends Error {
  constructor() { super('Nested task admission from a coordinated worker is blocked to prevent lock-order deadlocks.'); this.name = 'NestedTaskExecutionError'; }
}

export class TaskCoordinator {
  private readonly queue: QueueEntry<unknown>[] = [];
  private readonly activeTasks = new Set<string>();
  private readonly activeTaskIds = new Set<string>();
  private readonly activeByDevice = new Map<string, number>();
  private readonly heldResources = new Set<string>();
  private readonly executionContext = new AsyncLocalStorage<string>();
  private sequence = 0;

  constructor(
    private readonly maxConcurrent = 4,
    private readonly maxConcurrentPerDevice = 2,
    private readonly maxQueue = 200,
    private readonly maxQueueWaitMs = 30_000,
    private readonly agingPerSecond = 1,
  ) {
    for (const [name, value] of Object.entries({ maxConcurrent, maxConcurrentPerDevice, maxQueue, maxQueueWaitMs })) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    }
    if (!Number.isFinite(agingPerSecond) || agingPerSecond < 0) throw new Error('agingPerSecond must be non-negative.');
  }

  run<T>(request: TaskExecutionRequest, work: () => Promise<T>): Promise<T> {
    if (this.executionContext.getStore()) return Promise.reject(new NestedTaskExecutionError());
    if (!request.taskId || !request.deviceId) return Promise.reject(new Error('Task and device identifiers are required.'));
    if (request.signal?.aborted) return Promise.reject(this.abortError());
    if (this.activeTasks.has(request.taskId)) return Promise.reject(new TaskAlreadyRunningError());
    if (this.queue.length >= this.maxQueue) return Promise.reject(new TaskQueueFullError());

    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry<T> = {
        request: { ...request, priority: request.priority ?? 0, resources: this.normalizeResources(request.resources) },
        work, resolve, reject, enqueuedAt: Date.now(), sequence: this.sequence++, settled: false,
      };
      this.activeTasks.add(request.taskId);
      const timeoutMs = request.queueTimeoutMs ?? this.maxQueueWaitMs;
      if (timeoutMs > 0) {
        entry.timer = setTimeout(() => this.rejectQueued(entry, new TaskQueueTimeoutError()), timeoutMs);
        entry.timer.unref?.();
      }
      if (request.signal) {
        entry.abort = () => this.rejectQueued(entry, this.abortError());
        request.signal.addEventListener('abort', entry.abort, { once: true });
      }
      this.queue.push(entry as QueueEntry<unknown>);
      this.pump();
    });
  }

  snapshot(): TaskCoordinatorSnapshot {
    return {
      active: this.activeByDeviceValuesTotal(),
      queued: this.queue.length,
      activeTasks: [...this.activeTaskIds].sort(),
      queuedTasks: this.queue.filter((entry) => !entry.settled).map((entry) => ({
        taskId: entry.request.taskId,
        priority: this.effectivePriority(entry, Date.now()),
        waitedMs: Math.max(0, Date.now() - entry.enqueuedAt),
        blockedByResource: (entry.request.resources ?? []).some((resource) => this.heldResources.has(resource)),
        blockedByDeviceLimit: (this.activeByDevice.get(entry.request.deviceId) ?? 0) >= this.maxConcurrentPerDevice,
      })).sort((a, b) => b.priority - a.priority),
      activeByDevice: Object.fromEntries(this.activeByDevice),
      lockedResourceCount: this.heldResources.size,
      limits: { global: this.maxConcurrent, perDevice: this.maxConcurrentPerDevice, queued: this.maxQueue },
    };
  }

  private pump(): void {
    while (this.activeByDeviceValuesTotal() < this.maxConcurrent) {
      const now = Date.now();
      const candidates = this.queue
        .filter((entry) => !entry.settled && this.canStart(entry))
        .sort((a, b) => this.effectivePriority(b, now) - this.effectivePriority(a, now) || a.sequence - b.sequence);
      const next = candidates[0];
      if (!next) return;
      this.queue.splice(this.queue.indexOf(next), 1);
      this.start(next);
    }
  }

  private canStart(entry: QueueEntry<unknown>): boolean {
    const deviceActive = this.activeByDevice.get(entry.request.deviceId) ?? 0;
    if (deviceActive >= this.maxConcurrentPerDevice) return false;
    return (entry.request.resources ?? []).every((resource) => !this.heldResources.has(resource));
  }

  private effectivePriority(entry: QueueEntry<unknown>, now: number): number {
    return (entry.request.priority ?? 0) + ((now - entry.enqueuedAt) / 1000) * this.agingPerSecond;
  }

  private start(entry: QueueEntry<unknown>): void {
    if (entry.settled) return;
    entry.settled = true;
    this.cleanupEntry(entry);
    for (const resource of entry.request.resources ?? []) this.heldResources.add(resource);
    this.activeTaskIds.add(entry.request.taskId);
    this.activeByDevice.set(entry.request.deviceId, (this.activeByDevice.get(entry.request.deviceId) ?? 0) + 1);

    Promise.resolve().then(() => {
      if (entry.request.signal?.aborted) throw this.abortError();
      return this.executionContext.run(entry.request.taskId, entry.work);
    }).then(
      (value) => entry.resolve(value),
      (error) => entry.reject(error),
    ).finally(() => {
      this.activeTasks.delete(entry.request.taskId);
      this.activeTaskIds.delete(entry.request.taskId);
      const count = (this.activeByDevice.get(entry.request.deviceId) ?? 1) - 1;
      if (count <= 0) this.activeByDevice.delete(entry.request.deviceId);
      else this.activeByDevice.set(entry.request.deviceId, count);
      for (const resource of entry.request.resources ?? []) this.heldResources.delete(resource);
      this.pump();
    });
  }

  private rejectQueued(entry: QueueEntry<unknown>, error: Error): void {
    if (entry.settled) return;
    entry.settled = true;
    const index = this.queue.indexOf(entry);
    if (index >= 0) this.queue.splice(index, 1);
    this.cleanupEntry(entry);
    this.activeTasks.delete(entry.request.taskId);
    entry.reject(error);
    this.pump();
  }

  private cleanupEntry(entry: QueueEntry<unknown>): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.abort && entry.request.signal) entry.request.signal.removeEventListener('abort', entry.abort);
  }

  private normalizeResources(resources: string[] = []): string[] {
    const normalized = [...new Set(resources.map((resource) => resource.trim()).filter(Boolean))].sort();
    if (normalized.some((resource) => resource.length > 160)) throw new Error('Resource lock names must be at most 160 characters.');
    return normalized;
  }

  private activeByDeviceValuesTotal(): number {
    let total = 0;
    for (const count of this.activeByDevice.values()) total += count;
    return total;
  }

  private abortError(): Error {
    const error = new Error('Task was cancelled before execution capacity became available.');
    error.name = 'AbortError';
    return error;
  }
}
