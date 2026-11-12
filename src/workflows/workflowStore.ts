/**
 * Versioned workflow templates (JARVIS-US-062).
 *
 * A template is an ordered set of steps (operation + parameters + dependsOn).
 * Templates never execute anything themselves: running one expands its steps
 * into the normal task lifecycle, where each step is planned-allowlisted,
 * policy-checked and (when state-changing) approved, checkpointed, cancellable
 * and recoverable like any other multi-step workflow.
 *
 * Every change appends a new version; history is never rewritten.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type WorkflowOrigin = 'builtin' | 'user' | 'ai' | 'plugin';
export type WorkflowStatus = 'active' | 'draft' | 'archived';

export interface WorkflowStep {
  id: string;
  operation: string;
  parameters: Record<string, unknown>;
  dependsOn: string[];
}

export interface WorkflowVersion {
  version: number;
  status: WorkflowStatus;
  origin: WorkflowOrigin;
  description: string;
  steps: WorkflowStep[];
  createdAt: number;
  /** Plugin that contributed this template (origin "plugin"). */
  pluginId?: string;
  /** Validation problems recorded for drafts (AI drafts with unmapped steps). */
  problems?: string[];
  note?: string;
}

export interface WorkflowRecord {
  name: string;
  versions: WorkflowVersion[];
}

export const WORKFLOW_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MAX_STEPS = 20;
const MAX_VERSIONS = 50;
/** Templates may not nest workflows or change plugins (no recursion, no self-escalation). */
const NON_TEMPLATABLE = /^(?:workflow:|plugin:)/;

export type OperationCheck = (operation: string, parameterKeys: string[]) => boolean;

/** Validate steps and return a dependency-respecting execution order, or problems. */
export function validateWorkflowSteps(steps: unknown, isOperationAllowed: OperationCheck): { order?: WorkflowStep[]; problems: string[] } {
  const problems: string[] = [];
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) return { problems: [`A workflow needs 1-${MAX_STEPS} steps.`] };
  const byId = new Map<string, WorkflowStep>();
  for (const raw of steps) {
    const step = raw as WorkflowStep;
    if (!step || typeof step.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,30}$/i.test(step.id) || byId.has(step.id)) {
      problems.push(`Invalid or duplicate step id: ${String(step?.id)}.`);
      continue;
    }
    if (typeof step.operation !== 'string' || NON_TEMPLATABLE.test(step.operation)) {
      problems.push(`Step ${step.id}: ${String(step.operation)} cannot be used inside a workflow.`);
      continue;
    }
    if (!step.parameters || typeof step.parameters !== 'object' || Array.isArray(step.parameters)) {
      problems.push(`Step ${step.id}: parameters must be an object.`);
      continue;
    }
    if (!isOperationAllowed(step.operation, Object.keys(step.parameters))) {
      problems.push(`Step ${step.id}: ${step.operation} is not an allowlisted operation with these parameters.`);
      continue;
    }
    if (!Array.isArray(step.dependsOn) || step.dependsOn.some((dep) => typeof dep !== 'string' || dep === step.id)) {
      problems.push(`Step ${step.id}: dependsOn must list other step ids.`);
      continue;
    }
    byId.set(step.id, { id: step.id, operation: step.operation, parameters: structuredClone(step.parameters), dependsOn: [...new Set(step.dependsOn)] });
  }
  for (const step of byId.values()) {
    for (const dep of step.dependsOn) if (!byId.has(dep)) problems.push(`Step ${step.id} depends on unknown step ${dep}.`);
  }
  if (problems.length) return { problems };

  // Kahn's algorithm with original order as the tie-breaker: deterministic and cycle-detecting.
  const original = [...byId.keys()];
  const remaining = new Map([...byId.values()].map((step) => [step.id, new Set(step.dependsOn)]));
  const order: WorkflowStep[] = [];
  while (remaining.size) {
    const ready = original.find((id) => remaining.has(id) && remaining.get(id)!.size === 0);
    if (!ready) return { problems: ['Workflow steps contain a dependency cycle.'] };
    remaining.delete(ready);
    for (const deps of remaining.values()) deps.delete(ready);
    order.push(byId.get(ready)!);
  }
  return { order, problems };
}

/**
 * Build deterministic, bounded execution waves for a validated dependency graph.
 * Each wave contains only steps whose prerequisites were completed in earlier
 * waves. Steps in one wave are independent by dependency metadata, but callers
 * must still apply policy, approval and resource-conflict checks per step.
 */
export function workflowExecutionBatches(steps: WorkflowStep[], maxParallel = 4): WorkflowStep[][] {
  if (!Number.isInteger(maxParallel) || maxParallel < 1 || maxParallel > MAX_STEPS) {
    throw new Error(`maxParallel must be an integer from 1 to ${MAX_STEPS}.`);
  }
  if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
    throw new Error(`A workflow needs 1-${MAX_STEPS} steps.`);
  }
  const byId = new Map<string, WorkflowStep>();
  for (const step of steps) {
    if (!step || typeof step.id !== 'string' || byId.has(step.id) || !Array.isArray(step.dependsOn)) {
      throw new Error('Workflow graph contains an invalid or duplicate step.');
    }
    byId.set(step.id, step);
  }
  for (const step of steps) {
    if (step.dependsOn.some((dependency) => !byId.has(dependency) || dependency === step.id)) {
      throw new Error(`Step ${step.id} has an unknown or self dependency.`);
    }
  }

  const completed = new Set<string>();
  const batches: WorkflowStep[][] = [];
  while (completed.size < steps.length) {
    const ready = steps.filter((step) =>
      !completed.has(step.id) && step.dependsOn.every((dependency) => completed.has(dependency)),
    );
    if (ready.length === 0) throw new Error('Workflow steps contain a dependency cycle.');
    for (let offset = 0; offset < ready.length; offset += maxParallel) {
      const batch = ready.slice(offset, offset + maxParallel);
      batches.push(batch.map((step) => structuredClone(step)));
      for (const step of batch) completed.add(step.id);
    }
  }
  return batches;
}

/** Sequential steps: each depends on the previous one. */
export function chainSteps(operations: Array<{ operation: string; parameters: Record<string, unknown> }>): WorkflowStep[] {
  return operations.map((operation, index) => ({
    id: `s${index + 1}`,
    operation: operation.operation,
    parameters: operation.parameters,
    dependsOn: index === 0 ? [] : [`s${index}`],
  }));
}

export const BUILTIN_WORKFLOWS: Array<{ name: string; description: string; steps: WorkflowStep[] }> = [
  {
    name: 'morning-brief',
    description: 'Battery, memory and disk status plus today\'s scheduled requests. Read-only.',
    steps: [
      { id: 'battery', operation: 'system:get_battery_status', parameters: {}, dependsOn: [] },
      { id: 'memory', operation: 'system:get_memory_info', parameters: {}, dependsOn: [] },
      { id: 'disk', operation: 'system:get_disk_space', parameters: { drive: 'C:' }, dependsOn: [] },
      { id: 'schedules', operation: 'schedule:list', parameters: {}, dependsOn: [] },
    ],
  },
  {
    name: 'open-dev-workspace',
    description: 'Open File Explorer and Visual Studio Code, then list connected repositories. Each launch asks for approval.',
    steps: [
      { id: 'explorer', operation: 'app:launch', parameters: { appId: 'explorer' }, dependsOn: [] },
      { id: 'editor', operation: 'app:launch', parameters: { appId: 'Visual Studio Code' }, dependsOn: ['explorer'] },
      { id: 'repos', operation: 'dev:repo_list', parameters: {}, dependsOn: ['editor'] },
    ],
  },
];

interface WorkflowStateFile {
  version: 1;
  workflows: WorkflowRecord[];
}

export class WorkflowStore {
  private workflows = new Map<string, WorkflowRecord>();

  constructor(private readonly statePath: string, private readonly isOperationAllowed: OperationCheck) {
    this.load();
    this.seedBuiltins();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as WorkflowStateFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.workflows)) throw new Error('Workflow state file is invalid; refusing to load workflows.');
    for (const record of parsed.workflows) {
      if (typeof record?.name === 'string' && WORKFLOW_NAME.test(record.name) && Array.isArray(record.versions)) this.workflows.set(record.name, record);
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, workflows: [...this.workflows.values()] } satisfies WorkflowStateFile, null, 2), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  private seedBuiltins(): void {
    let changed = false;
    for (const builtin of BUILTIN_WORKFLOWS) {
      if (this.workflows.has(builtin.name)) continue;
      const { order } = validateWorkflowSteps(builtin.steps, this.isOperationAllowed);
      if (!order) continue; // a built-in that no longer validates is simply not offered
      this.workflows.set(builtin.name, { name: builtin.name, versions: [{ version: 1, status: 'active', origin: 'builtin', description: builtin.description, steps: builtin.steps, createdAt: Date.now() }] });
      changed = true;
    }
    if (changed) this.persist();
  }

  private appendVersion(name: string, version: Omit<WorkflowVersion, 'version' | 'createdAt'>): WorkflowVersion {
    if (!WORKFLOW_NAME.test(name)) throw new Error('Workflow names must be 2-41 lowercase letters, digits or hyphens.');
    const record = this.workflows.get(name) ?? { name, versions: [] };
    const latest = record.versions.at(-1);
    const entry: WorkflowVersion = { ...version, version: (latest?.version ?? 0) + 1, createdAt: Date.now() };
    record.versions.push(entry);
    // Bound history by dropping the oldest *non-current* versions only.
    while (record.versions.length > MAX_VERSIONS) record.versions.shift();
    this.workflows.set(name, record);
    this.persist();
    return structuredClone(entry);
  }

  /** Create or update a template; returns the new version. Validation failures throw. */
  saveActive(name: string, description: string, steps: WorkflowStep[], origin: WorkflowOrigin, extra: { pluginId?: string; note?: string } = {}): WorkflowVersion {
    const { order, problems } = validateWorkflowSteps(steps, this.isOperationAllowed);
    if (!order) throw new Error('Workflow rejected: ' + problems.slice(0, 5).join(' '));
    // Editing a built-in is allowed; it is versioned like any other template.
    return this.appendVersion(name, { status: 'active', origin, description: description.slice(0, 300), steps, ...extra });
  }

  /** Store an advisory draft (e.g. AI-generated) that cannot run until approved. */
  saveDraft(name: string, description: string, steps: WorkflowStep[], origin: WorkflowOrigin, problems: string[]): WorkflowVersion {
    return this.appendVersion(name, { status: 'draft', origin, description: description.slice(0, 300), steps, problems });
  }

  /** Promote the latest draft to active after re-validating it. */
  approveDraft(name: string): WorkflowVersion {
    const record = this.workflows.get(name);
    const draft = record?.versions.at(-1);
    if (!draft || draft.status !== 'draft') throw new Error(`Workflow ${name} has no pending draft.`);
    if (draft.problems?.length) throw new Error(`Draft ${name} v${draft.version} has unresolved problems: ${draft.problems.slice(0, 3).join(' ')}`);
    return this.saveActive(name, draft.description, draft.steps, draft.origin, { note: `approved draft v${draft.version}` });
  }

  archive(name: string): WorkflowVersion {
    const current = this.current(name);
    if (!current) throw new Error(`Workflow ${name} does not exist.`);
    return this.appendVersion(name, { status: 'archived', origin: current.origin, description: current.description, steps: current.steps, note: 'archived' });
  }

  /** Latest version (any status). */
  latest(name: string): WorkflowVersion | undefined {
    const version = this.workflows.get(name)?.versions.at(-1);
    return version ? structuredClone(version) : undefined;
  }

  /** Latest active version, if the latest version is active. */
  current(name: string): WorkflowVersion | undefined {
    const latest = this.latest(name);
    return latest?.status === 'active' ? latest : undefined;
  }

  history(name: string): WorkflowVersion[] {
    return structuredClone(this.workflows.get(name)?.versions ?? []);
  }

  list(): Array<{ name: string; version: number; status: WorkflowStatus; origin: WorkflowOrigin; description: string; steps: number; pluginId?: string }> {
    return [...this.workflows.values()].map((record) => {
      const latest = record.versions.at(-1)!;
      return { name: record.name, version: latest.version, status: latest.status, origin: latest.origin, description: latest.description, steps: latest.steps.length, ...(latest.pluginId ? { pluginId: latest.pluginId } : {}) };
    });
  }

  /** Remove (archive) templates contributed by a plugin that was disabled or uninstalled. */
  archivePluginTemplates(pluginId: string): number {
    let archived = 0;
    for (const record of this.workflows.values()) {
      const latest = record.versions.at(-1);
      if (latest?.origin === 'plugin' && latest.pluginId === pluginId && latest.status === 'active') {
        this.archive(record.name);
        archived += 1;
      }
    }
    return archived;
  }
}
