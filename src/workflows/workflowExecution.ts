import { createHash } from 'node:crypto';
import type { WorkflowStep } from './workflowStore.js';

export type WorkflowBranchStatus =
  | 'pending' | 'running' | 'awaiting_approval' | 'completed'
  | 'failed' | 'partial' | 'uncertain' | 'blocked' | 'skipped' | 'cancelled';

export interface WorkflowBranchCheckpoint {
  runId: string;
  stepId: string;
  operation: string;
  dependsOn: string[];
  status: WorkflowBranchStatus;
  attempts: number;
  startedAt?: number;
  updatedAt: number;
  approvalRef?: string;
  outcome?: 'verified_success' | 'verified_failure' | 'partial' | 'uncertain';
  message?: string;
}

export interface WorkflowRunCheckpoint {
  version: 2;
  runId: string;
  definitionHash: string;
  status: 'running' | 'awaiting_approval' | 'completed' | 'partial' | 'failed' | 'cancelled' | 'uncertain';
  maxParallel: number;
  branches: WorkflowBranchCheckpoint[];
  updatedAt: number;
}

export type WorkflowBranchExecutionResult =
  | { status: 'completed'; message?: string }
  | { status: 'awaiting_approval'; approvalRef: string; message?: string }
  | { status: 'failed'; message: string }
  | { status: 'partial'; message: string }
  | { status: 'uncertain'; message: string }
  | { status: 'cancelled'; message?: string };

export interface WorkflowBranchExecutionContext {
  runId: string;
  stepId: string;
  /** Supplied only by the caller after it has independently confirmed approval. */
  approvedApprovalRef?: string;
  signal?: AbortSignal;
}

export interface WorkflowRunOptions {
  runId: string;
  maxParallel?: number;
  signal?: AbortSignal;
  /** Explicitly confirmed, step-scoped approvals. Stored pending refs are never treated as approval. */
  approvedApprovals?: Record<string, string>;
  /** Prior durable snapshot for explicit owner-approved resume/reconciliation. */
  resumeFrom?: WorkflowRunCheckpoint;
  /** Owner-reviewed proof that these uncertain branches had no external effect. */
  reconciledNoEffectSteps?: string[];
  /** Resource keys must be stable, non-sensitive identifiers. */
  resourcesForStep?: (step: WorkflowStep) => string[];
  executeStep: (step: WorkflowStep, context: WorkflowBranchExecutionContext) => Promise<WorkflowBranchExecutionResult>;
  /** Must durably persist the complete run before execution and every state transition. */
  checkpoint: (snapshot: WorkflowRunCheckpoint) => Promise<void>;
}

const TERMINAL_FAILURES = new Set<WorkflowBranchStatus>(['failed', 'partial', 'uncertain', 'blocked', 'skipped', 'cancelled']);
const MAX_STEPS = 20;
const MAX_PARALLEL = 8;
const BRANCH_STATUSES = new Set<WorkflowBranchStatus>([
  'pending', 'running', 'awaiting_approval', 'completed', 'failed',
  'partial', 'uncertain', 'blocked', 'skipped', 'cancelled',
]);
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => [key, canonicalize(entry)]));
  }
  return value;
}
function workflowDefinitionHash(steps: WorkflowStep[]): string {
  const definition = steps.map((step) => ({
    id: step.id,
    operation: step.operation,
    parameters: canonicalize(step.parameters),
    dependsOn: [...step.dependsOn].sort(),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(definition)).digest('hex');
}

/**
 * Runs independent workflow DAG nodes concurrently with per-node approval and
 * checkpoint state. The injected executor MUST route every operation through
 * JARVIS policy, exact task/device/parameter approval, audit and verification.
 * This coordinator is deliberately not an adapter or policy bypass.
 */
export class WorkflowBranchExecutor {
  async run(steps: WorkflowStep[], options: WorkflowRunOptions): Promise<WorkflowRunCheckpoint> {
    const maxParallel = options.maxParallel ?? 4;
    if (!options.runId || options.runId.length > 160) throw new Error('A valid workflow run id is required.');
    if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_PARALLEL) {
      throw new Error(`maxParallel must be an integer from 1 to ${MAX_PARALLEL}.`);
    }
    this.validateGraph(steps);

    const now = Date.now();
    const definitionHash = workflowDefinitionHash(steps);
    let snapshot: WorkflowRunCheckpoint;
    if (options.resumeFrom) {
      const prior = structuredClone(options.resumeFrom);
      const branchIds = Array.isArray(prior.branches) ? prior.branches.map((branch) => branch?.stepId) : [];
      const uniqueBranchIds = new Set(branchIds);
      if (prior.version !== 2 || prior.runId !== options.runId || prior.definitionHash !== definitionHash ||
          !Array.isArray(prior.branches) || prior.branches.length !== steps.length ||
          uniqueBranchIds.size !== steps.length || steps.some((step) => !uniqueBranchIds.has(step.id)) ||
          prior.branches.some((branch) => {
            const step = steps.find((candidate) => candidate.id === branch.stepId);
            return !step || branch.runId !== options.runId || step.operation !== branch.operation ||
              !Array.isArray(branch.dependsOn) ||
              JSON.stringify([...step.dependsOn].sort()) !== JSON.stringify([...branch.dependsOn].sort()) ||
              !BRANCH_STATUSES.has(branch.status) || !Number.isInteger(branch.attempts) || branch.attempts < 0 ||
              !Number.isFinite(branch.updatedAt);
          })) {
        throw new Error('The saved workflow checkpoint does not match this run and exact workflow definition.');
      }
      snapshot = prior;
      snapshot.maxParallel = maxParallel;
      const branchById = new Map(snapshot.branches.map((branch) => [branch.stepId, branch]));
      const reconciled = new Set(options.reconciledNoEffectSteps ?? []);
      for (const stepId of reconciled) {
        if (branchById.get(stepId)?.status !== 'uncertain') {
          throw new Error(`Branch ${stepId} is not awaiting uncertain-outcome reconciliation.`);
        }
      }
      for (const [stepId, approvalRef] of Object.entries(options.approvedApprovals ?? {})) {
        const branch = branchById.get(stepId);
        if (!branch || branch.status !== 'awaiting_approval' || !approvalRef || approvalRef !== branch.approvalRef) {
          throw new Error(`Approval reference does not match pending branch ${stepId}.`);
        }
      }
      for (const branch of snapshot.branches) {
        if (reconciled.has(branch.stepId)) {
          if (branch.status !== 'uncertain') throw new Error(`Branch ${branch.stepId} is not awaiting uncertain-outcome reconciliation.`);
          branch.status = 'pending';
          branch.outcome = undefined;
          branch.message = 'Owner confirmed no external effect; a new attempt is explicitly authorized.';
          branch.updatedAt = now;
        }
        // A process restart while a branch was running leaves the side effect unknown.
        if (branch.status === 'running') {
          branch.status = 'uncertain';
          branch.outcome = 'uncertain';
          branch.message = 'Process restarted during branch execution. Reconcile before any new attempt.';
          branch.updatedAt = now;
        } else if (branch.status === 'awaiting_approval') {
          const approved = options.approvedApprovals?.[branch.stepId];
          if (approved && approved !== branch.approvalRef) {
            throw new Error(`Approval reference does not match pending branch ${branch.stepId}.`);
          }
          if (approved && approved === branch.approvalRef) {
            branch.status = 'pending';
            branch.updatedAt = now;
          }
        }
      }
      // A dependency blocked only because a now-reconciled branch was uncertain
      // may be reconsidered. It remains pending until every prerequisite succeeds.
      for (const branch of snapshot.branches) {
        if (branch.status === 'blocked' && branch.dependsOn.every((id) => {
          const dependency = snapshot.branches.find((item) => item.stepId === id)!;
          return !TERMINAL_FAILURES.has(dependency.status);
        })) {
          branch.status = 'pending';
          branch.message = 'Dependency graph reopened after explicit recovery review.';
          branch.updatedAt = now;
        }
      }
    } else {
      snapshot = {
        version: 2,
        runId: options.runId,
        definitionHash,
        status: 'running',
        maxParallel,
        branches: steps.map((step) => ({
          runId: options.runId,
          stepId: step.id,
          operation: step.operation,
          dependsOn: [...step.dependsOn],
          status: 'pending',
          attempts: 0,
          updatedAt: now,
        })),
        updatedAt: now,
      };
    }
    await options.checkpoint(structuredClone(snapshot));
    const byId = new Map(steps.map((step) => [step.id, step]));
    const states = new Map(snapshot.branches.map((branch) => [branch.stepId, branch]));
    const activeResources = new Set<string>();
    const running = new Set<string>();
    const workByStep = new Map<string, Promise<void>>();
    let checkpointTail: Promise<void> = Promise.resolve();

    const persist = async () => {
      snapshot.updatedAt = Date.now();
      const copy = structuredClone(snapshot);
      const write = checkpointTail.then(() => options.checkpoint(copy));
      checkpointTail = write.catch(() => {});
      await write;
    };
    const mark = async (branch: WorkflowBranchCheckpoint, status: WorkflowBranchStatus, message?: string) => {
      branch.status = status;
      branch.message = message?.slice(0, 240);
      branch.updatedAt = Date.now();
      await persist();
    };
    const resourcesFor = (step: WorkflowStep) => [...new Set((options.resourcesForStep?.(step) ?? []).map((v) => v.trim()).filter(Boolean))].sort();
    const canAcquire = (step: WorkflowStep) => resourcesFor(step).every((key) => !activeResources.has(key));

    while (true) {
      if (options.signal?.aborted) {
        for (const branch of snapshot.branches) {
          if (branch.status === 'pending') await mark(branch, 'cancelled', 'Cancelled before branch execution.');
        }
      }

      let changed = false;
      for (const branch of snapshot.branches) {
        if (branch.status !== 'pending') continue;
        const dependencies = branch.dependsOn.map((id) => states.get(id)!);
        if (dependencies.some((dependency) => TERMINAL_FAILURES.has(dependency.status))) {
          await mark(branch, 'blocked', 'A required dependency did not complete successfully.');
          changed = true;
        }
      }

      const ready = snapshot.branches.filter((branch) =>
        branch.status === 'pending' &&
        branch.dependsOn.every((id) => states.get(id)?.status === 'completed') &&
        !running.has(branch.stepId) &&
        canAcquire(byId.get(branch.stepId)!),
      );

      while (running.size < maxParallel && ready.length > 0 && !options.signal?.aborted) {
        const eligibleIndex = ready.findIndex((candidate) => canAcquire(byId.get(candidate.stepId)!));
        if (eligibleIndex < 0) break;
        const branch = ready.splice(eligibleIndex, 1)[0];
        const step = byId.get(branch.stepId)!;
        const resourceKeys = resourcesFor(step);
        for (const key of resourceKeys) activeResources.add(key);
        running.add(branch.stepId);
        branch.status = 'running';
        branch.attempts += 1;
        branch.startedAt ??= Date.now();
        branch.updatedAt = Date.now();
        const approvedApprovalRef = options.approvedApprovals?.[branch.stepId];
        const work = (async () => {
          let dispatchStarted = false;
          try {
            // Persist the running checkpoint before the executor can cause a side effect.
            await persist();
            if (options.signal?.aborted) {
              await mark(branch, 'cancelled', 'Cancelled after checkpoint but before dispatch; no operation was started.');
              return;
            }
            dispatchStarted = true;
            const result = await options.executeStep(step, {
              runId: options.runId,
              stepId: branch.stepId,
              ...(approvedApprovalRef ? { approvedApprovalRef } : {}),
              signal: options.signal,
            });
            if (options.signal?.aborted && result.status !== 'awaiting_approval' && result.status !== 'cancelled') {
              branch.outcome = 'uncertain';
              await mark(branch, 'uncertain', 'Cancellation arrived after dispatch; reconcile the external effect before retrying.');
              return;
            }
            if (result.status === 'awaiting_approval') {
              if (!result.approvalRef?.trim()) throw new Error('Approval-required result did not include a scoped approval reference.');
              branch.approvalRef = result.approvalRef;
              branch.outcome = undefined;
              await mark(branch, 'awaiting_approval', result.message ?? 'Waiting for owner approval.');
            } else if (result.status === 'completed') {
              branch.outcome = 'verified_success';
              await mark(branch, 'completed', result.message);
            } else if (result.status === 'failed') {
              branch.outcome = 'verified_failure';
              await mark(branch, 'failed', result.message);
            } else if (result.status === 'partial') {
              branch.outcome = 'partial';
              await mark(branch, 'partial', result.message);
            } else if (result.status === 'uncertain') {
              branch.outcome = 'uncertain';
              await mark(branch, 'uncertain', result.message);
            } else {
              await mark(branch, 'cancelled', result.message ?? 'Branch cancelled.');
            }
          } catch (error) {
            // A failed pre-dispatch checkpoint proves the executor was never called.
            const status: WorkflowBranchStatus = dispatchStarted ? 'uncertain' : 'failed';
            if (dispatchStarted) branch.outcome = 'uncertain';
            try { await mark(branch, status, error instanceof Error ? error.message : 'Branch execution/checkpoint failed.'); }
            catch { branch.status = status; branch.updatedAt = Date.now(); }
          } finally {
            running.delete(branch.stepId);
            for (const key of resourceKeys) activeResources.delete(key);
          }
        })();
        // Keep promises outside the checkpoint object; promises are not serializable.
        workByStep.set(branch.stepId, work);
      }

      if (running.size > 0) {
        const active = snapshot.branches
          .filter((branch) => running.has(branch.stepId))
          .map((branch) => workByStep.get(branch.stepId))
          .filter((work): work is Promise<void> => Boolean(work));
        await Promise.race(active);
        for (const branch of snapshot.branches) if (!running.has(branch.stepId)) workByStep.delete(branch.stepId);
        continue;
      }

      const pending = snapshot.branches.some((branch) => branch.status === 'pending');
      const awaiting = snapshot.branches.some((branch) => branch.status === 'awaiting_approval');
      if (pending && !changed) {
        if (awaiting) {
          // Keep descendants pending while their prerequisite branch awaits approval.
          snapshot.status = 'awaiting_approval';
          await persist();
          return structuredClone(snapshot);
        }
        // With a validated DAG and no active workers, this is an inconsistent state.
        for (const branch of snapshot.branches) if (branch.status === 'pending') await mark(branch, 'blocked', 'No dependency-safe execution path remains.');
        continue;
      }
      if (pending || changed) continue;
      snapshot.status = awaiting
        ? 'awaiting_approval'
        : snapshot.branches.some((branch) => branch.status === 'uncertain') ? 'uncertain'
        : snapshot.branches.some((branch) => branch.status === 'failed' || branch.status === 'partial' || branch.status === 'blocked' || branch.status === 'cancelled') ? 'partial'
        : 'completed';
      await persist();
      return structuredClone(snapshot);
    }
  }

  private validateGraph(steps: WorkflowStep[]): void {
    if (!Array.isArray(steps) || steps.length < 1 || steps.length > MAX_STEPS) throw new Error(`A workflow needs 1-${MAX_STEPS} steps.`);
    const ids = new Set<string>();
    for (const step of steps) {
      if (!step || typeof step.id !== 'string' || !step.id || ids.has(step.id) || !Array.isArray(step.dependsOn)) {
        throw new Error('Workflow graph contains an invalid or duplicate step.');
      }
      ids.add(step.id);
    }
    for (const step of steps) {
      if (step.dependsOn.some((id) => !ids.has(id) || id === step.id)) throw new Error(`Step ${step.id} has an unknown or self dependency.`);
    }
    const complete = new Set<string>();
    while (complete.size < steps.length) {
      const ready = steps.filter((step) => !complete.has(step.id) && step.dependsOn.every((id) => complete.has(id)));
      if (!ready.length) throw new Error('Workflow steps contain a dependency cycle.');
      for (const step of ready) complete.add(step.id);
    }
  }
}
