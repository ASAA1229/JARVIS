/**
 * Executes plugin:* and workflow:* operations (JARVIS-US-062).
 *
 * The engine only manages plugin and template *state*. Running a workflow
 * returns its validated steps; the core service splices them into the current
 * task so each step goes through policy, approval, checkpoints, cancellation and
 * recovery exactly like any planned multi-step workflow.
 */
import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import type { AgentModelAdapter } from '../conversation/agentOrchestrator.js';
import { runAgent } from '../conversation/agentOrchestrator.js';
import type { TaskPlanResponse } from '../conversation/agentResponseContracts.js';
import { PluginRegistry, type PluginEnvironment } from '../plugins/pluginRegistry.js';
import { chainSteps, validateWorkflowSteps, WORKFLOW_NAME, WorkflowStore, type WorkflowStep } from './workflowStore.js';

export { WORKFLOW_OPERATIONS } from './operations.js';

export interface WorkflowEngineOptions extends PluginEnvironment {
  pluginStatePath: string;
  workflowStatePath: string;
  /** Map one natural-language step to allowlisted operations via the planner. */
  planStep(text: string): Promise<Array<{ operation: string; parameters: Record<string, unknown> }>>;
  /** Local-first model adapter for AI-drafted workflows (null when no model is configured). */
  agentAdapter(): AgentModelAdapter | null;
}

const ok = (data: unknown, evidence: Record<string, unknown> = {}): ExecutionResult => ({ success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data, evidence: { workflows: true, ...evidence } });
const fail = (error: string, evidence: Record<string, unknown> = {}): ExecutionResult => ({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error, failureKind: 'unsupported', evidence: { workflows: true, ...evidence } });

function names(value: unknown): string[] {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,]+/);
  return list.map((item) => String(item).trim()).filter(Boolean).slice(0, 30);
}

export class WorkflowEngine {
  readonly plugins: PluginRegistry;
  readonly workflows: WorkflowStore;

  constructor(private readonly options: WorkflowEngineOptions) {
    const check = (operation: string, keys: string[]) => options.isOperationAllowed(operation, keys);
    this.plugins = new PluginRegistry(options.pluginStatePath, options);
    this.workflows = new WorkflowStore(options.workflowStatePath, check);
  }

  private check(operation: string, keys: string[]): boolean {
    return this.options.isOperationAllowed(operation, keys);
  }

  async execute(operation: string, parameters: Record<string, unknown>): Promise<ExecutionResult> {
    try {
      switch (operation) {
        // ---- plugins ----
        case 'plugin:install': {
          const manifest = this.plugins.readManifestFile(String(parameters.path ?? ''));
          const plugin = this.plugins.install(manifest);
          return ok({ id: plugin.manifest.id, version: plugin.manifest.version, enabled: false, requestedPermissions: plugin.manifest.permissions, grants: plugin.grants }, { note: 'Installed disabled. Grant permissions, then enable.' });
        }
        case 'plugin:list':
          return ok(this.plugins.list().map((plugin) => ({ id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version, publisher: plugin.manifest.publisher, enabled: plugin.enabled, requested: plugin.manifest.permissions, grants: plugin.grants, workflows: (plugin.manifest.workflows ?? []).map((workflow) => workflow.name) })));
        case 'plugin:grant': {
          const plugin = this.plugins.grant(String(parameters.id), names(parameters.permissions));
          return ok({ id: plugin.manifest.id, grants: plugin.grants });
        }
        case 'plugin:revoke': {
          const plugin = this.plugins.revoke(String(parameters.id), names(parameters.permissions));
          // Templates using a revoked permission fail closed at run time (see expand).
          return ok({ id: plugin.manifest.id, grants: plugin.grants });
        }
        case 'plugin:enable': {
          const plugin = this.plugins.setEnabled(String(parameters.id), true);
          const registered: string[] = [];
          for (const template of plugin.manifest.workflows ?? []) {
            const steps = template.steps.filter((step) => plugin.grants.includes(step.operation));
            if (steps.length !== template.steps.length) continue; // needs an ungranted permission; not offered
            this.workflows.saveActive(template.name, template.description, steps, 'plugin', { pluginId: plugin.manifest.id, note: `plugin ${plugin.manifest.id}@${plugin.manifest.version}` });
            registered.push(template.name);
          }
          return ok({ id: plugin.manifest.id, enabled: true, workflowsRegistered: registered });
        }
        case 'plugin:disable': {
          const plugin = this.plugins.setEnabled(String(parameters.id), false);
          const archived = this.workflows.archivePluginTemplates(plugin.manifest.id);
          return ok({ id: plugin.manifest.id, enabled: false, workflowsArchived: archived });
        }
        case 'plugin:uninstall': {
          const id = String(parameters.id);
          const archived = this.workflows.archivePluginTemplates(id);
          if (!this.plugins.uninstall(id)) return fail(`Plugin ${id} is not installed.`);
          return ok({ id, uninstalled: true, workflowsArchived: archived });
        }

        // ---- workflows ----
        case 'workflow:list':
          return ok(this.workflows.list());
        case 'workflow:show': {
          const latest = this.workflows.latest(String(parameters.name));
          return latest ? ok({ name: parameters.name, ...latest }) : fail(`Workflow ${String(parameters.name)} does not exist.`);
        }
        case 'workflow:history':
          return ok(this.workflows.history(String(parameters.name)).map((version) => ({ version: version.version, status: version.status, origin: version.origin, steps: version.steps.length, createdAt: version.createdAt, note: version.note })));
        case 'workflow:run':
          return this.expand(String(parameters.name));
        case 'workflow:create':
          return this.create(
            String(parameters.name),
            String(parameters.description ?? ''),
            Array.isArray(parameters.steps) ? parameters.steps.map((step) => String(step).trim()).filter(Boolean) : [],
          );
        case 'workflow:draft_ai':
          return this.draftWithAi(String(parameters.name), String(parameters.goal ?? ''));
        case 'workflow:approve_draft': {
          const version = this.workflows.approveDraft(String(parameters.name));
          return ok({ name: parameters.name, version: version.version, status: version.status });
        }
        case 'workflow:compose': {
          const name = String(parameters.name ?? '');
          if (!WORKFLOW_NAME.test(name)) return fail('Workflow names must be 2-41 lowercase letters, digits or hyphens.');
          const { order, problems } = this.validateSteps(parameters.steps);
          if (!order) return fail('Workflow is invalid: ' + problems.join(' '));
          const version = this.workflows.saveActive(name, String(parameters.description ?? '') || `Composed workflow ${name}`, order, 'user', { note: 'composed in HUD' });
          return ok({ name, version: version.version, steps: version.steps.map((step) => ({ id: step.id, operation: step.operation, dependsOn: step.dependsOn })) });
        }
        case 'workflow:archive': {
          const version = this.workflows.archive(String(parameters.name));
          return ok({ name: parameters.name, version: version.version, status: version.status });
        }
        default:
          return fail(`Unsupported workflow operation ${operation}.`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Workflow operation failed.');
    }
  }

  /** Read-only validation used by the visual composer before saving (no side effects). */
  validateSteps(steps: unknown): { order?: WorkflowStep[]; problems: string[] } {
    return validateWorkflowSteps(steps, (operation, keys) => this.check(operation, keys));
  }

  /**
   * Validate the active template and return its steps in dependency order.
   * Plugin templates also require the plugin to be enabled with every step's
   * permission still granted; otherwise the run fails closed.
   */
  private expand(name: string): ExecutionResult {
    const current = this.workflows.current(name);
    if (!current) return fail(`Workflow ${name} is not active (missing, draft or archived).`);
    if (current.origin === 'plugin') {
      const pluginId = current.pluginId ?? '';
      const denied = current.steps.filter((step) => !this.plugins.allows(pluginId, step.operation));
      if (denied.length) return fail(`Plugin ${pluginId} is disabled or no longer granted: ${denied.map((step) => step.operation).join(', ')}.`);
    }
    const { order, problems } = validateWorkflowSteps(current.steps, (operation, keys) => this.check(operation, keys));
    if (!order) return fail('Workflow no longer validates: ' + problems.slice(0, 3).join(' '));
    return ok({
      name,
      version: current.version,
      // Preserve the validated dependency graph for the core task lifecycle.
      // Flattening this to an ordered list silently discards independent branches.
      steps: order.map((step) => ({
        id: step.id,
        operation: step.operation,
        parameters: step.parameters,
        dependsOn: [...step.dependsOn],
      })),
    }, { workflowName: name, workflowVersion: current.version, expandedSteps: order.length, note: 'Each expanded step is policy-checked and approved separately.' });
  }

  /** Owner-authored workflow from plain-language steps, mapped by the planner. */
  private async create(name: string, description: string, stepTexts: string[]): Promise<ExecutionResult> {
    if (!WORKFLOW_NAME.test(name)) return fail('Workflow names must be 2-41 lowercase letters, digits or hyphens.');
    if (stepTexts.length === 0 || stepTexts.length > 20) return fail('Give 1-20 steps.');
    const operations: Array<{ operation: string; parameters: Record<string, unknown> }> = [];
    for (const text of stepTexts) {
      const mapped = await this.options.planStep(text);
      if (mapped.length === 0) return fail(`Step "${text.slice(0, 80)}" does not map to a supported action.`);
      operations.push(...mapped);
    }
    const version = this.workflows.saveActive(name, description || `Owner workflow ${name}`, chainSteps(operations), 'user');
    return ok({ name, version: version.version, steps: version.steps.map((step) => step.operation) });
  }

  /**
   * AI-drafted workflow: the local-first model proposes steps; each is mapped by the
   * planner. The result is stored as an advisory draft and cannot run until the
   * owner approves it (workflow:approve_draft, approval required).
   */
  private async draftWithAi(name: string, goal: string): Promise<ExecutionResult> {
    if (!WORKFLOW_NAME.test(name)) return fail('Workflow names must be 2-41 lowercase letters, digits or hyphens.');
    if (!goal.trim() || goal.length > 1000) return fail('Describe the workflow goal in 1-1000 characters.');
    const adapter = this.options.agentAdapter();
    if (!adapter) return fail('No AI model is configured, so an AI draft cannot be produced. Create the workflow from explicit steps instead.');
    const result = await runAgent({ request: goal, profile: 'task_planning' }, adapter);
    if (result.status !== 'completed') return fail('The AI could not produce a workflow plan: ' + result.reason);
    const plan = result.response as TaskPlanResponse;
    if (plan.status !== 'ready') return fail(plan.clarification ?? 'The AI could not plan this goal.');
    const operations: Array<{ operation: string; parameters: Record<string, unknown> }> = [];
    const problems: string[] = [];
    for (const step of plan.steps) {
      const mapped = await this.options.planStep(step.description || step.title);
      if (mapped.length === 0) problems.push(`Step "${step.title.slice(0, 60)}" does not map to a supported action.`);
      operations.push(...mapped);
    }
    const steps: WorkflowStep[] = chainSteps(operations);
    if (steps.length) {
      const validation = validateWorkflowSteps(steps, (operation, keys) => this.check(operation, keys));
      problems.push(...validation.problems);
    } else {
      problems.push('No step mapped to a supported action.');
    }
    const version = this.workflows.saveDraft(name, plan.goal, steps, 'ai', problems);
    return ok({ name, version: version.version, status: 'draft', steps: steps.map((step) => step.operation), problems }, { advisoryDraft: true });
  }
}
