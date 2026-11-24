import { routingMode } from '../ai/providerRouter.js';
import { lifecycleFromTaskState, needsOwnerReview, type CommandLifecycleState } from './commandLifecycle.js';
import { createCiProvider } from '../release/ciProvider.js';
import {
  TaskId,
  TaskState,
  OperationRequest,
  DeviceId,
  DeviceRecord,
  SessionId,
  ExecutionResult,
  VerificationOutcome,
  RiskTier,
  Permission,
} from '../core/types.js';
import { cpus, freemem, totalmem } from 'node:os';
import { DeviceIdentityManager } from '../core/identity.js';
import { PolicyGateway } from '../policy/gateway.js';
import { isRegisteredTool, validateToolParameters } from '../policy/toolRegistry.js';
import { WindowsSystemAdapter } from '../adapters/windowsSystem.js';
import { WindowsAppLauncherAdapter } from '../adapters/windowsAppLauncher.js';
import { assessBrowserNavigation } from '../adapters/browserSearch.js';
import { WindowsDesktopAgent, DesktopAction } from '../adapters/windowsDesktopAgent.js';
import { WorkspaceFileAdapter } from '../adapters/workspaceFiles.js';
import { TerminalRunner } from '../adapters/terminalRunner.js';
import { OutcomeVerifier } from '../verification/verifier.js';
import { DeveloperAssistant } from '../developer/developerAssistant.js';
import { WorkspaceService } from '../workspace/workspaceService.js';
import { WorkflowEngine } from '../workflows/workflowEngine.js';
import { WorkflowBranchExecutor, type WorkflowRunCheckpoint } from '../workflows/workflowExecution.js';
import type { WorkflowStep } from '../workflows/workflowStore.js';
import { GatewaySiteAdmin, isGatewaySiteOperation } from '../gateway/siteAdminOperations.js';
import { getCapability } from '../capabilities/registry.js';
import { createConfiguredAgentModelAdapter } from '../conversation/agentModelAdapter.js';
import { AuditLogger } from '../audit/audit.js';
import { IAIPlannerProvider, MinimizedContext, PlanProposal } from '../planner/planner.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { DeviceSecurityService } from './deviceSecurity.js';
import { NotificationCenter } from './notifications.js';
import { Scheduler, ScheduledJob, JobRunResult } from '../scheduler/scheduler.js';
import { PersonalMemoryStore, MemoryCategory, MemoryConflictError } from '../memory/personalMemoryStore.js';
import { MemoryManager } from '../memory/memoryManager.js';
import { WorkingMemory } from '../memory/workingMemory.js';
import { CommunicationsAdapter } from '../adapters/communications.js';
import { TaskJournal } from './taskJournal.js';
import { buildLocalModel } from '../studio/modelBuilder.js';
import { TaskCoordinator } from './taskCoordinator.js';
import { EventBus } from '../events/eventBus.js';
import type { DeviceRevokeReason, IntegrationEventSink } from '../integration/asaaEvents.js';

export type WorkflowStepStatus = 'completed' | 'failed' | 'uncertain' | 'blocked' | 'skipped' | 'awaiting_approval' | 'cancelled';

export interface WorkflowStepRecord {
  index: number;
  operation: string;
  status: WorkflowStepStatus;
  outcome?: VerificationOutcome;
  at: number;
  message?: string;
}

export interface TaskLifecycleRecord {
  id: TaskId;
  deviceId: DeviceId;
  requestText: string;
  state: TaskState;
  createdAt: number;
  updatedAt: number;
  operation?: string;
  parameters?: Record<string, unknown>;
  approvalId?: string;
  result?: ExecutionResult;
  error?: string;
  interrupted?: boolean;
  operations?: OperationRequest[];
  operationIndex?: number;
  /** 'schedule' tasks were started by the scheduler; they never inherit approvals. */
  origin?: 'interactive' | 'schedule';
  /** Per-step record: completed, failed, uncertain, blocked, skipped, cancelled. */
  steps?: WorkflowStepRecord[];
  /** Owner-reviewed recovery note. This never authorizes automatic replay. */
  reconciliation?: { disposition: 'confirmed_no_effect' | 'effect_observed' | 'still_unknown'; note: string; reviewedAt: number; reviewedBy: DeviceId };
  /** Encrypted DAG checkpoint and immutable definition used for explicit branch resume. */
  workflowRun?: WorkflowRunCheckpoint;
  workflowSteps?: WorkflowStep[];
  workflowParentTaskId?: TaskId;
  workflowStepId?: string;
  /** True when the task ended because a planning or execution deadline passed (lifecycle timed_out). */
  timedOut?: boolean;
}

export interface TaskResult {
  taskId: TaskId;
  state: TaskState;
  message: string;
  data?: unknown;
  approvalId?: string;
  outcome?: VerificationOutcome;
  verified?: boolean;
}

/** Hard ceiling for any single adapter call; adapters that honour AbortSignal stop at this point. */
const EXECUTION_TIMEOUT_MS = 60_000;
/** Extra time after the abort signal for an adapter to return before the task is force-settled. */
const EXECUTION_GRACE_MS = 10_000;
/** Hard ceiling for planner/provider work so a task can never stay in CREATED forever. */
const PLANNING_TIMEOUT_MS = 120_000;
/** Tasks left in a non-terminal in-flight state with no live controller are settled by the sweep. */
const STALE_TASK_MS = 5 * 60_000;

/**
 * Read-only operations that may be retried once after a TIMEOUT. State-changing
 * operations are never retried automatically: after a timeout their effect is
 * unknown and a repeat could duplicate it.
 */
const RETRYABLE_READ_ONLY = new Set([
  'system:get_os_info',
  'system:get_memory_info',
  'system:get_battery_status',
  'system:get_disk_space',
  'desktop:list_windows',
  'desktop:read_control',
  'file:list',
  'file:search',
  'file:read',
  'file:verify_saved',
  'app:inventory',
  'dev:repo_list',
  'dev:tree',
  'dev:read',
  'dev:grep',
  'dev:git_status',
  'dev:git_log',
  'dev:git_diff',
  'dev:suggestion_list',
  'dev:pr_draft',
  'dev:ci_status',
  'dev:history',
  'plugin:list',
  'workflow:list',
  'workflow:show',
  'workflow:history',
]);

export class JarvisCoreService {
  /** Optional ecosystem event sink (ASAA events); undefined means standalone and nothing is emitted. */
  public integrationSink?: IntegrationEventSink;
  public readonly audit: AuditLogger;
  /** Cross-module event/state synchronization (D2.20). Summaries only; never audio, transcripts or secrets. */
  public readonly events = new EventBus();
  readonly #lastPublishedState = new Map<string, string>();
  public readonly identity: DeviceIdentityManager;
  public readonly deviceSecurity?: DeviceSecurityService;
  public readonly policy: PolicyGateway;
  public readonly systemAdapter: WindowsSystemAdapter;
  public readonly appAdapter: WindowsAppLauncherAdapter;
  public readonly desktopAgent: WindowsDesktopAgent;
  public readonly fileAdapter: WorkspaceFileAdapter;
  public readonly terminal: TerminalRunner;
  public readonly communications: CommunicationsAdapter;
  public readonly verifier: OutcomeVerifier;
  /** Developer and coding assistant (JARVIS-US-063). */
  public readonly developer: DeveloperAssistant;
  /** JARVIS Studio Code view: owner-approved workspace roots and file operations. */
  public readonly workspace: WorkspaceService;
  /** Permissioned plugins and versioned workflows (JARVIS-US-062). */
  public readonly workflows: WorkflowEngine;
  /** Owner management of personal-AI-gateway site keys (J-E09); the JSON store is shared with the gateway. */
  public readonly gatewaySites = new GatewaySiteAdmin(process.env.JARVIS_SITE_CLIENTS_PATH || './data/site-clients.json');
  public readonly notifications: NotificationCenter;
  public readonly scheduler: Scheduler;
  public planner: IAIPlannerProvider;
  public readonly personalMemory?: PersonalMemoryStore;
  /** Two-tier memory (working + long-term) and consent-based learning (US-057/058). */
  public readonly memoryManager?: MemoryManager;

  private tasks = new Map<TaskId, TaskLifecycleRecord>();
  /** Short-lived per-device target, set only after JARVIS independently verifies an app window. */
  private recentAppTargets = new Map<string, { processName: string; appName: string; windowPid: number; verifiedAt: number }>();
  private readonly taskJournal?: TaskJournal;
  private activeExecutionTokens = new Map<TaskId, AbortController>();
  private activePlanningTokens = new Map<TaskId, AbortController>();
  /** Bounds concurrent adapter work and serializes conflicting host resources. */
  public readonly taskCoordinator = new TaskCoordinator(4, 2, 200, 30_000);
  /** Separately bounds concurrent planner/provider work before adapter admission. */
  private readonly planningCoordinator = new TaskCoordinator(2, 1, 100, 30_000);
  private readonly startedAt = Date.now();
  private cpuSample?: { idle: number; total: number };

  constructor(
    planner: IAIPlannerProvider,
    logPath: string = './data/audit.log',
    statePath?: string,
    ownerControlToken?: string
  ) {
    this.planner = planner;
    // Assigned first: the workflow store validates built-in steps against the planner.
    this.planner = planner;
    this.audit = new AuditLogger(logPath);
    this.identity = new DeviceIdentityManager(this.audit, statePath);
    this.policy = new PolicyGateway(this.audit, statePath ? `${statePath}.approvals` : './data/approval-grants.json', ownerControlToken);
    if (ownerControlToken) this.deviceSecurity = new DeviceSecurityService(this.identity, this.audit, this.policy, ownerControlToken, statePath ? `${statePath}.security` : './data/security.json');
    this.systemAdapter = new WindowsSystemAdapter();
    this.appAdapter = new WindowsAppLauncherAdapter();
    this.desktopAgent = new WindowsDesktopAgent();
    this.fileAdapter = new WorkspaceFileAdapter();
    this.terminal = new TerminalRunner(this.fileAdapter);
    this.communications = new CommunicationsAdapter();
    this.verifier = new OutcomeVerifier();
    this.workspace = new WorkspaceService(statePath ? statePath + '.workspace' : './data/workspace');
    this.developer = new DeveloperAssistant(statePath ? statePath + '.developer' : './data/developer', createConfiguredAgentModelAdapter);
    this.workflows = new WorkflowEngine({
      pluginStatePath: statePath ? statePath + '.plugins.json' : './data/plugins.json',
      workflowStatePath: statePath ? statePath + '.workflows.json' : './data/workflows.json',
      // A step is usable only if both the planner and the policy gateway allowlist it.
      isOperationAllowed: (operation, keys) =>
        this.planner.validatePlanSchema?.({ intent: 'check', operations: [{ operation, parameters: {}, justification: 'check' }], confidence: 1, explanation: 'check' }).valid !== false &&
        this.policy.describeOperation(operation, keys) !== undefined,
      isKnownCapability: (id) => {
        const capability = getCapability(id);
        return Boolean(capability && capability.status !== 'restricted' && capability.risk !== 'blocked');
      },
      planStep: async (text) => {
        const plan = await this.planner.generatePlan(text, { requesterName: 'workflow-builder', timestamp: Date.now() });
        return (plan.operations ?? []).map((operation) => ({ operation: operation.operation, parameters: operation.parameters }));
      },
      agentAdapter: createConfiguredAgentModelAdapter,
    });
    this.notifications = new NotificationCenter();
    this.scheduler = new Scheduler(
      this.audit,
      (job) => this.#runScheduledJob(job),
      ownerControlToken ? (statePath ? `${statePath}.schedules` : './data/schedules.json') : undefined,
      ownerControlToken,
    );
    if (ownerControlToken) {
      this.personalMemory = new PersonalMemoryStore(
        statePath ? statePath + '.memory' : './data/personal-memory.enc',
        ownerControlToken,
      );
      this.memoryManager = new MemoryManager(
        this.personalMemory,
        new WorkingMemory(),
        statePath ? statePath + '.memory-candidates' : './data/memory-candidates.enc',
        ownerControlToken,
      );
      // A task that was only waiting for a human decision keeps waiting when its persisted approval
      // was recovered (undecided, unexpired, device still active); it is never auto-approved.
      this.taskJournal = new TaskJournal(statePath ? statePath + '.tasks' : './data/tasks.enc', ownerControlToken, (approvalId, record) => {
        const approval = this.policy.getApproval(approvalId);
        const device = this.identity.getDevice(record.deviceId);
        return Boolean(approval && approval.taskId === record.id && approval.deviceId === record.deviceId &&
          !approval.approved && !approval.rejected && !approval.consumed && approval.expiresAt > Date.now() &&
          device && device.status === 'ACTIVE');
      });
      for (const record of this.taskJournal.list()) this.tasks.set(record.id, record);
      this.reconcileStaleTasks();
    }
  }

  /** Start the scheduler loop. Called by the server on start; never runs implicitly. */
  public startBackgroundServices(): void {
    this.scheduler.start();
    this.reconcileStaleTasks();
    if (!this.reconcileTimer) {
      this.reconcileTimer = setInterval(() => this.reconcileStaleTasks(), 30_000);
      this.reconcileTimer.unref?.();
    }
  }

  private reconcileTimer?: ReturnType<typeof setInterval>;

  /** The single client-facing lifecycle (queued/running/completed/failed/cancelled/timed_out) for a task. */
  public lifecycleOf(task: Pick<TaskLifecycleRecord, 'state' | 'timedOut'>): CommandLifecycleState {
    return task.timedOut ? 'timed_out' : lifecycleFromTaskState(task.state);
  }

  /**
   * Settles work that can no longer progress, so nothing stays queued or running forever:
   * approvals past their expiry (or whose persisted approval is gone) expire safely, and in-flight
   * tasks with no live controller are moved to recovery. Never approves or executes anything.
   */
  public reconcileStaleTasks(now: number = Date.now()): number {
    let settled = 0;
    // Undecided approvals (typically recovered after restart) whose task is gone, or is no longer
    // waiting for them, can never be honoured: invalidate them rather than leave them decidable.
    for (const approval of this.policy.listUndecidedApprovals()) {
      const owner = this.tasks.get(approval.taskId);
      if (!owner || (owner.state !== TaskState.AWAITING_APPROVAL && owner.state !== TaskState.CREATED) || owner.approvalId !== approval.id) {
        if (owner?.state === TaskState.CREATED && !owner.approvalId) continue; // approval being issued right now
        this.policy.invalidateApprovals({ taskId: approval.taskId }, 'ORPHANED_APPROVAL');
        settled++;
      }
    }
    for (const task of this.tasks.values()) {
      if (task.state === TaskState.AWAITING_APPROVAL) {
        const approval = task.approvalId ? this.policy.getApproval(task.approvalId) : undefined;
        const undecided = Boolean(approval && !approval.approved && !approval.rejected && !approval.consumed);
        const device = this.identity.getDevice(task.deviceId);
        const deviceActive = Boolean(device && device.status === 'ACTIVE');
        if (undecided && approval!.expiresAt > now && deviceActive) continue;
        if (approval && (approval.approved || approval.consumed)) continue; // a decision is in progress
        this.policy.invalidateApprovals({ taskId: task.id }, 'STALE_APPROVAL');
        task.state = deviceActive ? TaskState.EXPIRED : TaskState.CANCELLED;
        task.timedOut = deviceActive || undefined;
        task.error = deviceActive ? 'Approval expired before a decision; nothing was executed.' : 'Device is no longer active; nothing was executed.';
        this.#skipRemainingSteps(task);
        this.#persistTask(task);
        try { this.audit.record('APPROVAL_EXPIRED_SWEEP', { approvalId: task.approvalId ?? null }, task.deviceId, task.id); } catch { /* state already terminal */ }
        if (task.workflowParentTaskId) void this.#settleWorkflowBranchChild(task, 'verified_failure').catch(() => undefined);
        settled++;
      } else if (task.state === TaskState.EXECUTING && !this.activeExecutionTokens.has(task.id) &&
          now - task.updatedAt > EXECUTION_TIMEOUT_MS + EXECUTION_GRACE_MS) {
        task.state = TaskState.AWAITING_RECOVERY;
        task.interrupted = true;
        task.timedOut = true;
        task.error = 'Execution had no live controller past its deadline; reconcile external state before retrying.';
        this.#persistTask(task);
        settled++;
      } else if ((task.state === TaskState.CREATED || task.state === TaskState.APPROVED) &&
          !this.activePlanningTokens.has(task.id) && !this.activeExecutionTokens.has(task.id) && now - task.updatedAt > STALE_TASK_MS) {
        task.state = TaskState.FAILED;
        task.timedOut = true;
        task.error = 'Task did not progress before its deadline; nothing was executed.';
        this.#persistTask(task);
        settled++;
      }
    }
    return settled;
  }

  public stopBackgroundServices(): void {
    if (this.reconcileTimer) { clearInterval(this.reconcileTimer); this.reconcileTimer = undefined; }
    this.scheduler.stop();
    for (const controller of this.activeExecutionTokens.values()) controller.abort();
    for (const controller of this.activePlanningTokens.values()) controller.abort();
  }

  /**
   * Primary entry point: Authenticate -> Understand -> Plan -> Evaluate Policy -> Approve -> Execute -> Verify -> Audit
   */
  public async submitRequest(
    sessionId: string,
    requestText: string
  ): Promise<TaskResult> {
    // Step 1: Authenticate device & session
    const auth = this.identity.validateDeviceSession(sessionId);
    if (!auth.valid || !auth.device) {
      this.audit.record('REQUEST_AUTH_FAILED', { reason: auth.error });
      throw new Error(`Authentication failed: ${auth.error}`);
    }
    return this.#processRequest(auth.device, requestText, 'interactive');
  }

  /**
   * Run an owner-composed list of explicit operations (HUD panels, workflow composer)
   * through the same pipeline as text requests: plan schema validation, PolicyGateway,
   * approvals, task journal and audit. Only the planner step is skipped.
   */
  public async submitOperations(
    sessionId: string,
    label: string,
    operations: Array<{ operation: string; parameters: Record<string, unknown>; justification?: string }>,
  ): Promise<TaskResult> {
    const auth = this.identity.validateDeviceSession(sessionId);
    if (!auth.valid || !auth.device) {
      this.audit.record('REQUEST_AUTH_FAILED', { reason: auth.error });
      throw new Error(`Authentication failed: ${auth.error}`);
    }
    const plan: PlanProposal = {
      intent: String(label).slice(0, 120) || 'Owner-composed operation',
      operations: operations.map((op) => ({
        operation: op.operation,
        parameters: op.parameters,
        justification: (op.justification || 'Requested explicitly from the owner HUD').slice(0, 200),
      })) as PlanProposal['operations'],
      confidence: 1,
      explanation: 'Explicit owner request from a HUD control; every step is still checked by the policy gateway.',
    };
    return this.#processRequest(auth.device, String(label).slice(0, 4000), 'interactive', plan);
  }

  /**
   * Shared pipeline for interactive and scheduled requests. A scheduled request
   * gets no special authority: it is planned and policy-evaluated exactly like a
   * live one, using the owner device's permissions at the moment it runs.
   */
  async #processRequest(device: DeviceRecord, requestText: string, origin: 'interactive' | 'schedule', presetPlan?: PlanProposal): Promise<TaskResult> {
    const taskId = `task-${CryptoUtil.randomToken(12)}`;
    const auditIntegrity = this.audit.verifyIntegrity();
    if (!auditIntegrity.valid) {
      return {
        taskId,
        state: TaskState.FAILED,
        message: `Audit chain integrity violation: ${auditIntegrity.reason || 'unknown integrity failure'}`,
        verified: false,
      };
    }

    const taskRecord: TaskLifecycleRecord = {
      id: taskId,
      deviceId: device.id,
      requestText,
      state: TaskState.CREATED,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      origin,
      steps: [],
    };
    this.tasks.set(taskId, taskRecord);
    if (!this.#persistTask(taskRecord)) {
      return { taskId, state: taskRecord.state, message: taskRecord.error || 'Task checkpoint failed; no operation was executed', verified: false };
    }

    try {
      this.audit.record('REQUEST_RECEIVED', { requestLength: requestText.length, origin }, device.id, taskId);
    } catch {
      taskRecord.state = TaskState.AWAITING_RECOVERY;
      taskRecord.error = 'Request could not be durably audited; no operation was planned or executed';
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error, verified: false };
    }

    // Step 2: Understand request & build bounded plan via Planner (AI Advisory)
    const context: MinimizedContext = {
      requesterName: device.name,
      timestamp: Date.now(),
      memory: this.personalMemory?.relevant(requestText, 5).map((record) => record.content),
      ...(this.recentAppTargets.get(device.id) && Date.now() - (this.recentAppTargets.get(device.id)?.verifiedAt ?? 0) <= 15 * 60 * 1000
        ? {
          activeAppProcess: this.recentAppTargets.get(device.id)?.processName,
          activeAppName: this.recentAppTargets.get(device.id)?.appName,
        }
        : {}),
    };
    let plan: PlanProposal;
    const planningController = new AbortController();
    this.activePlanningTokens.set(taskId, planningController);
    let planningTimedOut = false;
    const planningTimer = setTimeout(() => { planningTimedOut = true; planningController.abort(); }, PLANNING_TIMEOUT_MS);
    try {
      const planning: Promise<PlanProposal> = presetPlan ? Promise.resolve(presetPlan) : this.planningCoordinator.run({
        taskId,
        deviceId: device.id,
        priority: origin === 'schedule' ? 10 : 100,
        queueTimeoutMs: 30_000,
        signal: planningController.signal,
      }, () => this.planner.generatePlan(requestText, context));
      planning.catch(() => undefined);
      const deadline = new Promise<never>((_, reject) => {
        planningController.signal.addEventListener('abort', () => { if (planningTimedOut) reject(new Error('Planning deadline exceeded')); }, { once: true });
      });
      plan = await Promise.race([planning, deadline]);
      clearTimeout(planningTimer);
    } catch (error: unknown) {
      clearTimeout(planningTimer);
      this.activePlanningTokens.delete(taskId);
      if (planningTimedOut) taskRecord.timedOut = true;
      if (!planningTimedOut && (planningController.signal.aborted || taskRecord.state === TaskState.CANCELLED)) {
        return { taskId, state: TaskState.CANCELLED, message: 'Task cancelled before execution; no operation was started.', verified: false };
      }
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'The planner failed before an operation could be evaluated; no host operation was executed';
      try {
        this.audit.record('PLANNING_FAILED', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
        }, device.id, taskId);
      } catch {
        taskRecord.state = TaskState.AWAITING_RECOVERY;
        taskRecord.error = 'Planning failed and the failure could not be durably audited; no host operation was executed';
      }
      this.#persistTask(taskRecord);
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: false,
      };
    }

    // Cancellation may arrive while an uninterruptible model/provider call is in
    // progress. Even if that call returns later, its plan must never reach policy or execution.
    this.activePlanningTokens.delete(taskId);
    if (planningController.signal.aborted || taskRecord.state === TaskState.CANCELLED) {
      return { taskId, state: TaskState.CANCELLED, message: 'Task cancelled before execution; no operation was started.', verified: false };
    }

    // Validate plan against strict schema. A model-written plan is a proposal only;
    // it is never authorization (every step still goes through the PolicyGateway).
    const validation = this.planner.validatePlanSchema(plan);
    if (!validation.valid) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = `Invalid AI plan proposal: ${(validation.errors || []).join('; ')}`;
      this.audit.record('PLANNING_SCHEMA_VIOLATION', { errorCount: validation.errors?.length || 0 }, device.id, taskId);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    // Whatever planner is plugged in, the core itself refuses operations that are not in the
    // shared tool registry or whose parameters do not match their declaration (E:D4.6).
    const unregistered = plan.operations.findIndex((operation) => !isRegisteredTool(operation.operation) || validateToolParameters(operation.operation, operation.parameters) !== undefined);
    if (unregistered >= 0) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Invalid plan proposal: an operation is not registered or its parameters do not match its declaration.';
      this.audit.record('PLANNING_SCHEMA_VIOLATION', { reason: 'UNREGISTERED_OR_INVALID_OPERATION', index: unregistered }, device.id, taskId);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    if (!plan.operations || plan.operations.length === 0) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = plan.explanation;
      this.audit.record('PLANNING_UNABLE_TO_MAP', {
        operationCount: plan.operations.length,
        confidence: plan.confidence,
      }, device.id, taskId);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: plan.explanation };
    }

    // Sequential, dependency-ordered workflow: step N+1 starts only after step N is
    // verified. The first step is evaluated now; later steps are evaluated when reached.
    const proposedOp = plan.operations[0];
    taskRecord.operations = plan.operations.map((operation) => ({
      operation: operation.operation,
      parameters: operation.parameters,
    }));
    taskRecord.operationIndex = 0;
    taskRecord.operation = proposedOp.operation;
    taskRecord.parameters = proposedOp.parameters;

    const opRequest: OperationRequest = {
      operation: proposedOp.operation,
      parameters: proposedOp.parameters,
    };

    // Step 3: Evaluate Policy
    return this.#evaluateAndProceed(taskId, opRequest, device.id);
  }

  /**
   * Remove a deleted personal memory's text from task history (in memory and in the
   * encrypted task journal): memory:save/update request text and parameters, and
   * memory:list result payloads. Task metadata and audit records are kept.
   */
  #scrubDeletedMemoryFromTasks(memoryId: string, content: string): { scrubbedTasks: number; persisted: boolean } {
    const REDACTED = '[deleted personal memory]';
    const normalized = content.trim().toLowerCase();
    const mentions = (value: unknown) => typeof value === 'string' && normalized.length > 0 && value.toLowerCase().includes(normalized);
    let scrubbedTasks = 0;
    let persisted = true;
    for (const task of this.tasks.values()) {
      let changed = false;
      const operations = [
        ...(task.operation ? [{ operation: task.operation, parameters: task.parameters }] : []),
        ...(task.operations ?? []),
      ];
      for (const op of operations) {
        if (!op.parameters || !['memory:save', 'memory:update'].includes(op.operation)) continue;
        const linked = op.parameters.id === memoryId || mentions(op.parameters.content) ||
          (task.result?.evidence as { memoryId?: unknown } | undefined)?.memoryId === memoryId;
        if (linked && op.parameters.content !== REDACTED) {
          op.parameters.content = REDACTED;
          changed = true;
        }
      }
      if (changed || mentions(task.requestText)) {
        if (task.requestText !== REDACTED) {
          task.requestText = REDACTED;
          changed = true;
        }
      }
      const data = task.result?.data;
      if (Array.isArray(data) && data.some((entry) => (entry as { id?: unknown })?.id === memoryId)) {
        task.result = { ...task.result!, data: data.filter((entry) => (entry as { id?: unknown })?.id !== memoryId) };
        changed = true;
      }
      if (changed) {
        scrubbedTasks += 1;
        if (!this.#persistTask(task)) persisted = false;
      }
    }
    return { scrubbedTasks, persisted };
  }

  #recordStep(task: TaskLifecycleRecord, status: WorkflowStepStatus, outcome?: VerificationOutcome, message?: string): boolean {
    if (!task.steps) task.steps = [];
    task.steps.push({
      index: task.operationIndex ?? 0,
      operation: task.operation ?? 'unknown',
      status,
      outcome,
      at: Date.now(),
      message: message ? message.slice(0, 160) : undefined,
    });
    return this.#persistTask(task);
  }

  /** Persist a checkpoint before further work; a failed write stops dependent steps. */
  #persistTask(task: TaskLifecycleRecord): boolean {
    task.updatedAt = Date.now();
    if (this.#lastPublishedState.get(task.id) !== task.state) {
      this.#lastPublishedState.set(task.id, task.state);
      this.events.publish('task.state', { taskId: task.id, state: task.state, lifecycle: this.lifecycleOf(task), needsOwnerReview: needsOwnerReview(task.state) }, task.deviceId);
    }
    if (!this.taskJournal) return true;
    try {
      this.taskJournal.save(task);
      return true;
    } catch {
      task.state = TaskState.AWAITING_RECOVERY;
      task.interrupted = true;
      task.error = 'Task checkpoint could not be durably saved. Execution is stopped; reconcile external state before retrying.';
      try {
        this.audit.record('TASK_CHECKPOINT_FAILED', { state: task.state }, task.deviceId, task.id);
      } catch { /* Fail closed even if the audit sink is also unavailable. */ }
      return false;
    }
  }

  #skipRemainingSteps(task: TaskLifecycleRecord): void {
    if (!task.operations) return;
    if (!task.steps) task.steps = [];
    for (let index = (task.operationIndex ?? 0) + 1; index < task.operations.length; index++) {
      task.steps.push({ index, operation: task.operations[index].operation, status: 'skipped', at: Date.now() });
    }
  }

  /**
   * Evaluates policy for a task and proceeds to execute or requests approval.
   */
  async #evaluateAndProceed(
    taskId: TaskId,
    opRequest: OperationRequest,
    deviceId: DeviceId,
    approvalId?: string
  ): Promise<TaskResult> {
    const taskRecord = this.tasks.get(taskId);
    if (!taskRecord) throw new Error('Task not found');

    // Planning and approval are asynchronous boundaries. A user may cancel a
    // CREATED task while the planner is running, or another lifecycle event may
    // move it to a terminal/recovery state before policy evaluation resumes.
    // Only a new workflow step or an explicitly approved step may proceed.
    if (taskRecord.state !== TaskState.CREATED && taskRecord.state !== TaskState.APPROVED) {
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error || ('Workflow cannot proceed from state ' + taskRecord.state + '; no operation was started.'),
        outcome: VerificationOutcome.UNCERTAIN,
        verified: false,
      };
    }

    const device = this.identity.getDevice(deviceId);
    if (!device) {
      // Never throw out of the pipeline and strand the task mid-state (E:D4.11).
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Device not found; nothing was executed.';
      this.policy.invalidateApprovals({ taskId }, 'DEVICE_NOT_FOUND');
      this.#recordStep(taskRecord, 'blocked', undefined, taskRecord.error);
      this.#skipRemainingSteps(taskRecord);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error, outcome: VerificationOutcome.VERIFIED_FAILURE, verified: true };
    }

    const policyResult = this.policy.evaluate(opRequest, device, taskId, approvalId);

    if (!policyResult.allowed) {
      if (policyResult.requiresApproval) {
        taskRecord.state = TaskState.AWAITING_APPROVAL;
        const approval = this.policy.createApprovalRequest(
          taskId,
          deviceId,
          opRequest.operation,
          opRequest.parameters,
          policyResult.riskTier
        );
        taskRecord.approvalId = approval.id;
        const checkpointed = this.#recordStep(taskRecord, 'awaiting_approval', undefined, policyResult.reason);
        if (!checkpointed) {
          try { this.policy.invalidateApprovals({ taskId }, 'TASK_CHECKPOINT_FAILED'); } catch { /* State guard still prevents execution. */ }
          return { taskId, state: taskRecord.state, message: taskRecord.error || 'Approval state could not be checkpointed; execution is blocked.', verified: false };
        }
        this.notifications.push('warning', 'approval_required', `Approval needed for ${opRequest.operation} (risk ${policyResult.riskTier}).`, { taskId, deviceId });
        return {
          taskId,
          state: taskRecord.state,
          approvalId: approval.id,
          message: `Operation '${opRequest.operation}' requires explicit approval (Risk: ${policyResult.riskTier})`,
        };
      } else {
        taskRecord.state = TaskState.FAILED;
        taskRecord.error = policyResult.reason;
        this.audit.record('TASK_DENIED', { reason: policyResult.reason }, deviceId, taskId);
        this.#recordStep(taskRecord, 'blocked', undefined, policyResult.reason);
        this.#skipRemainingSteps(taskRecord);
        this.#persistTask(taskRecord);
        this.notifications.push('error', 'task_blocked', `Blocked by policy: ${opRequest.operation}.`, { taskId, deviceId });
        return { taskId, state: taskRecord.state, message: policyResult.reason || 'Policy denied execution' };
      }
    }

    // Policy permitted: proceed to execute
    return this.#executeTask(taskId, opRequest);
  }

  /**
   * Executes permitted operation via allowlisted execution adapters with cancellation tracking.
   * This is the ONLY place adapters are invoked, and it is reachable only from
   * #evaluateAndProceed after the PolicyGateway has allowed the exact operation.
   */
  async #executeTask(
    taskId: TaskId,
    opRequest: OperationRequest
  ): Promise<TaskResult> {
    const taskRecord = this.tasks.get(taskId);
    if (!taskRecord) throw new Error('Task not found');

    // The executor validates parameters against the registered declaration immediately before an
    // adapter can run, independent of every earlier check (E:D4.6).
    const parameterProblem = validateToolParameters(opRequest.operation, opRequest.parameters);
    if (parameterProblem) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Execution blocked: ' + parameterProblem;
      this.audit.record('EXECUTION_BLOCKED_INVALID_PARAMETERS', { operation: opRequest.operation }, taskRecord.deviceId, taskId);
      this.#recordStep(taskRecord, 'failed', VerificationOutcome.VERIFIED_FAILURE, taskRecord.error);
      this.#skipRemainingSteps(taskRecord);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error, outcome: VerificationOutcome.VERIFIED_FAILURE, verified: true };
    }

    // Persisted identity state is security-critical. If its integrity or write
    // status is unknown, fail closed before any execution.
    if (!this.identity.isStateHealthy()) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Execution blocked: persisted device state is unhealthy';
      this.audit.record('EXECUTION_BLOCKED_DEVICE_STATE_UNHEALTHY', { reason: this.identity.getStateError() }, taskRecord.deviceId, taskId);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    // Precondition re-check: verify device is not revoked
    const device = this.identity.getDevice(taskRecord.deviceId);
    if (!device || device.status !== 'ACTIVE') {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Device revoked or inactive before execution';
      this.audit.record('EXECUTION_BLOCKED_DEVICE_REVOKED', {}, taskRecord.deviceId, taskId);
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    // Safety Invariant: Check audit chain integrity before any execution
    const auditIntegrity = this.audit.verifyIntegrity();
    if (!auditIntegrity.valid) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = `Execution blocked: Audit chain integrity violation (${auditIntegrity.reason})`;
      this.#persistTask(taskRecord);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    taskRecord.state = TaskState.EXECUTING;
    if (!this.#persistTask(taskRecord)) {
      return { taskId, state: taskRecord.state, message: taskRecord.error || 'Checkpoint failed before execution', verified: false };
    }
    const abortController = new AbortController();
    this.activeExecutionTokens.set(taskId, abortController);
    let dispatchStarted = false;
    let executionTimedOut = false;
    const timeoutHandle = setTimeout(() => { executionTimedOut = true; abortController.abort(); }, EXECUTION_TIMEOUT_MS);

    try {
      this.audit.record('EXECUTION_STARTED', { operation: opRequest.operation }, taskRecord.deviceId, taskId);
    } catch {
      clearTimeout(timeoutHandle);
      this.activeExecutionTokens.delete(taskId);
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Execution blocked because the audit record could not be persisted';
      this.#persistTask(taskRecord);
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: true,
      };
    }

    let rawResult: ExecutionResult;
    const parameters = opRequest.parameters;
    const signal = abortController.signal;

    const launchAndType = async (appId: string, text: string): Promise<ExecutionResult> => {
          const launch = await this.appAdapter.launchApp(appId, signal);
          if (!launch.success || launch.outcome !== VerificationOutcome.VERIFIED_SUCCESS) return launch;
          // Type only into the exact window the launch verified. Without a verified
          // window identity JARVIS refuses to type rather than guess the foreground app.
          const launched = launch.data as { windowPid?: number; windowProcess?: string } | undefined;
          if (!launched?.windowPid || !launched.windowProcess) {
            return {
              success: false,
              outcome: VerificationOutcome.PARTIAL_SUCCESS,
              error: 'The application launched, but its window could not be identified, so no text was typed.',
              failureKind: 'target_mismatch',
              data: { launch: launch.data },
              evidence: { launch: launch.evidence, typingSkipped: true },
            };
          }
          const focus = await this.desktopAgent.execute({ operation: 'desktop:focus_window', parameters: { pid: launched.windowPid } }, signal);
          if (!focus.success) {
            return {
              success: false,
              outcome: VerificationOutcome.PARTIAL_SUCCESS,
              error: 'The application launched, but it could not be brought to the foreground, so no text was typed.',
              failureKind: focus.failureKind ?? 'unavailable',
              data: { launch: launch.data },
              evidence: { launch: launch.evidence, focus: focus.evidence, typingSkipped: true },
            };
          }
          this.recentAppTargets.set(taskRecord.deviceId, {
            processName: launched.windowProcess.replace(/\.exe$/i, ''),
            appName: appId,
            windowPid: launched.windowPid,
            verifiedAt: Date.now(),
          });
          const typing = await this.desktopAgent.execute({
            operation: 'desktop:type_text',
            parameters: { text: text, expectProcess: launched.windowProcess },
          } as unknown as DesktopAction, signal);
          // The launch is a verified side effect, so a typing failure is never a clean
          // failure of the whole request. Typing is VERIFIED only when the adapter's UI
          // Automation readback matched; acknowledgement-only stays PARTIAL.
          const typingFailedCleanly = !typing.success && typing.outcome === VerificationOutcome.VERIFIED_FAILURE;
          return {
            ...typing,
            ...(typingFailedCleanly ? {
              outcome: VerificationOutcome.PARTIAL_SUCCESS,
              error: 'The application opened, but the text was not entered: ' + (typing.error || 'typing failed.'),
            } : {}),
            data: { launch: launch.data, typing: typing.data },
            evidence: { launch: launch.evidence, focus: focus.evidence, typing: typing.evidence, independentlyVerified: typing.outcome === VerificationOutcome.VERIFIED_SUCCESS },
          };
            };

    const dispatch = async (): Promise<ExecutionResult> => {
      // Dispatch ONLY to allowlisted adapters
      switch (opRequest.operation) {
        case 'memory:list': {
          if (!this.personalMemory) return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: this.personalMemory.list(), evidence: { memoryAvailable: true, encryptedAtRest: true } };
        }
        case 'memory:save': {
          if (!this.personalMemory) return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          const record = this.personalMemory.save(
            parameters.category as MemoryCategory,
            parameters.content as string,
            parameters.ttlDays as number | undefined,
          );
          this.audit.record('PERSONAL_MEMORY_SAVED', { category: record.category, memoryId: record.id }, taskRecord.deviceId, taskId);
          return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { id: record.id, category: record.category, createdAt: record.createdAt, expiresAt: record.expiresAt }, evidence: { encryptedAtRest: true, memoryId: record.id } };
        }
        case 'memory:update': {
          if (!this.personalMemory) return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          let updated;
          try {
            const expected = typeof parameters.expectedUpdatedAt === 'number' ? parameters.expectedUpdatedAt : undefined;
            updated = this.personalMemory.update(parameters.id as string, parameters.content as string, expected);
          } catch (error) {
            if (error instanceof MemoryConflictError) {
              // Never overwrite a newer version: report the conflict for owner review.
              return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: error.message, data: { conflict: true, currentUpdatedAt: error.current.updatedAt }, evidence: { memoryId: parameters.id, conflict: true } };
            }
            throw error;
          }
          if (!updated) return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Memory entry not found.', evidence: { memoryId: parameters.id } };
          this.audit.record('PERSONAL_MEMORY_UPDATED', { memoryId: updated.id, category: updated.category }, taskRecord.deviceId, taskId);
          return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { id: updated.id, category: updated.category, updatedAt: updated.updatedAt }, evidence: { encryptedAtRest: true, memoryId: updated.id } };
        }
        case 'memory:delete': {
          if (!this.personalMemory) return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          const id = parameters.id as string;
          const existing = this.personalMemory.list().find((record) => record.id === id);
          const deleted = this.personalMemory.delete(id);
          // Prove deletion by re-reading and decrypting the stored file, not by trusting memory.
          const diskVerified = deleted ? this.personalMemory.verifyAbsentOnDisk(id) : false;
          // Secondary copies: task history (and its encrypted journal) holds the text of the
          // memory:save/update requests and memory:list results. Deletion must cover them too.
          const scrub = deleted && existing ? this.#scrubDeletedMemoryFromTasks(id, existing.content) : { scrubbedTasks: 0, persisted: true };
          // Derived copies held by the Memory Manager: working memory, learning candidates,
          // the local embedding index and correction history (J-E06 deletion boundary).
          const derived = deleted && existing ? this.memoryManager?.scrubDeleted(id, existing.content) : undefined;
          const derivedVerified = derived ? derived.derivedVerified : true;
          this.audit.record('PERSONAL_MEMORY_DELETE', { memoryId: id, deleted, diskVerified, secondaryTasksScrubbed: scrub.scrubbedTasks, secondaryPersisted: scrub.persisted, derivedVerified }, taskRecord.deviceId, taskId);
          if (deleted && !derivedVerified) {
            return { success: false, outcome: VerificationOutcome.UNCERTAIN, error: 'The memory was deleted, but its search index or version history could not be verified as purged.', evidence: { memoryId: id, deleted, diskVerified, derivedVerified } };
          }
          if (deleted && (!diskVerified || !scrub.persisted)) {
            return { success: false, outcome: VerificationOutcome.UNCERTAIN, error: diskVerified ? 'The memory was deleted, but task-history copies could not be durably scrubbed.' : 'The memory was removed in memory but the stored file could not be re-verified.', evidence: { memoryId: id, deleted, diskVerified, secondaryTasksScrubbed: scrub.scrubbedTasks, secondaryPersisted: scrub.persisted } };
          }
          return { success: deleted, outcome: deleted ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.VERIFIED_FAILURE, error: deleted ? undefined : 'Memory entry not found.', data: { deleted }, evidence: { memoryId: id, deleted, diskVerified, secondaryTasksScrubbed: scrub.scrubbedTasks, secondaryPersisted: scrub.persisted } };
        }
        case 'system:get_os_info':
          return this.systemAdapter.getOsInfo();
        case 'system:get_memory_info':
          return this.systemAdapter.getMemoryInfo();
        case 'system:get_battery_status':
          return this.systemAdapter.getBatteryStatus(signal);
        case 'system:get_disk_space':
          return this.systemAdapter.getDiskSpace((parameters.drive as string) || 'C:', signal);
        case 'app:launch': {
          const launched = await this.appAdapter.launchApp(parameters.appId as string, signal);
          const target = launched.data as { windowPid?: number; windowProcess?: string; name?: string } | undefined;
          if (launched.success && launched.outcome === VerificationOutcome.VERIFIED_SUCCESS && target?.windowPid && target.windowProcess) {
            this.recentAppTargets.set(taskRecord.deviceId, { processName: target.windowProcess.replace(/\.exe$/i, ''), appName: target.name || String(parameters.appId), windowPid: target.windowPid, verifiedAt: Date.now() });
          }
          return launched;
        }
        case 'app:inventory':
          return this.appAdapter.inventory(signal);
        case 'comms:handoff_email':
          return this.communications.handoffEmail(parameters, signal);
        case 'comms:unsupported':
          return this.communications.unsupported(parameters.channel, parameters.reason);
        case 'desktop:save_and_verify': {
          const path = parameters.path;
          const expectProcess = parameters.expectProcess;
          const contains = parameters.contains;
          if (typeof path !== 'string' || !path.trim() || path.length > 1024 ||
              typeof expectProcess !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(expectProcess) ||
              (contains !== undefined && (typeof contains !== 'string' || !contains || contains.length > 500))) {
            return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Save verification requires a workspace path, an exact target process and optional expected text.', evidence: { operation: 'desktop:save_and_verify', inputValidated: false } };
          }
          const since = Date.now();
          const save = await this.desktopAgent.execute({
            operation: 'desktop:hotkey',
            parameters: { keys: ['CTRL', 'S'], expectProcess },
          }, signal);
          if (!save.success) {
            return { success: false, outcome: save.outcome, error: 'The save shortcut was not confirmed in the named application; file verification was not attempted.', evidence: { save: save.evidence, verificationSkipped: true } };
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          const verification = await this.fileAdapter.verifySaved(path, since, contains);
          if (verification.success && verification.outcome === VerificationOutcome.VERIFIED_SUCCESS) {
            return {
              success: true,
              outcome: VerificationOutcome.VERIFIED_SUCCESS,
              data: { path: (verification.data as { path?: string } | undefined)?.path, saved: true },
              evidence: { save: save.evidence, durableFileVerification: verification.evidence, expectedProcess: expectProcess, independentlyVerified: true },
            };
          }
          return {
            success: false,
            outcome: verification.outcome === VerificationOutcome.UNCERTAIN ? VerificationOutcome.UNCERTAIN : VerificationOutcome.PARTIAL_SUCCESS,
            error: 'The save shortcut was sent to the named application, but the requested workspace file was not independently verified as updated. Check the application save dialog and destination before retrying.',
            evidence: { save: save.evidence, durableFileVerification: verification.evidence, expectedProcess: expectProcess, independentlyVerified: false },
          };
        }
        case 'desktop:browser_search': {
          const appId = parameters.appId;
          const query = parameters.query;
          if (typeof appId !== 'string' || !appId.trim() || typeof query !== 'string' || !query.trim() || query.length > 500 || /[\u0000-\u001F\u007F]/.test(query)) {
            return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Browser search requires a supported browser and 1–500 printable search characters.', evidence: { operation: 'desktop:browser_search', inputValidated: false } };
          }
          const launch = await this.appAdapter.launchApp(appId, signal);
          if (!launch.success || launch.outcome !== VerificationOutcome.VERIFIED_SUCCESS) return launch;
          const launched = launch.data as { windowPid?: number; windowProcess?: string } | undefined;
          if (!launched?.windowPid || !launched.windowProcess) {
            return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'The browser opened, but its window identity could not be confirmed; search was not submitted.', data: { launch: launch.data }, evidence: { launch: launch.evidence, searchSkipped: true } };
          }
          const focus = await this.desktopAgent.execute({ operation: 'desktop:focus_window', parameters: { pid: launched.windowPid } }, signal);
          if (!focus.success) {
            return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'The browser opened, but JARVIS could not focus its verified window; search was not submitted.', data: { launch: launch.data }, evidence: { launch: launch.evidence, focus: focus.evidence, searchSkipped: true } };
          }
          const target = launched.windowProcess.replace(/\.exe$/i, '');
          const beforeInspection = await this.desktopAgent.execute({ operation: 'desktop:inspect_window', parameters: { expectProcess: target } }, signal);
          const beforeData = beforeInspection.success ? beforeInspection.data as { process?: string; windowTitle?: string } : undefined;
          const beforeObservation = beforeData && typeof beforeData.process === 'string' && typeof beforeData.windowTitle === 'string'
            ? { process: beforeData.process, windowTitle: beforeData.windowTitle }
            : undefined;
          const addressBar = await this.desktopAgent.execute({ operation: 'desktop:hotkey', parameters: { keys: ['CTRL', 'L'], expectProcess: target } }, signal);
          if (!addressBar.success) {
            return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'The browser opened, but its address bar could not be targeted; search was not submitted.', data: { launch: launch.data }, evidence: { launch: launch.evidence, focus: focus.evidence, addressBar: addressBar.evidence } };
          }
          // Prefix with '?' so a URL-like utterance remains a search query rather
          // than navigating directly to an arbitrary destination.
          const searchText = '?' + query;
          const entered = await this.desktopAgent.execute({ operation: 'desktop:type_text', parameters: { text: searchText, expectProcess: target } }, signal);
          if (!entered.success) {
            return { success: false, outcome: entered.outcome === VerificationOutcome.UNCERTAIN ? VerificationOutcome.UNCERTAIN : VerificationOutcome.PARTIAL_SUCCESS, error: 'The browser opened, but the search text could not be confirmed in its address bar.', data: { launch: launch.data }, evidence: { launch: launch.evidence, focus: focus.evidence, addressBar: addressBar.evidence, textEntry: entered.evidence } };
          }
          const submitted = await this.desktopAgent.execute({ operation: 'desktop:hotkey', parameters: { keys: ['ENTER'], expectProcess: target } }, signal);
          if (!submitted.success) {
            return { success: false, outcome: submitted.outcome === VerificationOutcome.UNCERTAIN ? VerificationOutcome.UNCERTAIN : VerificationOutcome.PARTIAL_SUCCESS, error: 'The search text was entered, but submission was not acknowledged. Check the browser before retrying.', data: { launch: launch.data }, evidence: { launch: launch.evidence, focus: focus.evidence, addressBar: addressBar.evidence, textEntry: entered.evidence, submit: submitted.evidence } };
          }
          // A short, target-bound post-submit inspection can observe a browser
          // title transition. This is useful progress evidence, but never proof
          // that the requested search results or exact query loaded.
          await new Promise<void>((resolve) => setTimeout(resolve, 1200));
          const afterInspection = await this.desktopAgent.execute({ operation: 'desktop:inspect_window', parameters: { expectProcess: target } }, signal);
          const afterData = afterInspection.success ? afterInspection.data as { process?: string; windowTitle?: string } : undefined;
          const afterObservation = afterData && typeof afterData.process === 'string' && typeof afterData.windowTitle === 'string'
            ? { process: afterData.process, windowTitle: afterData.windowTitle }
            : undefined;
          const navigation = assessBrowserNavigation(beforeObservation, afterObservation, target);
          return {
            success: true,
            outcome: VerificationOutcome.PARTIAL_SUCCESS,
            data: { browser: appId, query, submitted: true, navigationObserved: navigation.observed, windowTitle: afterObservation?.windowTitle },
            evidence: {
              launch: launch.evidence,
              focus: focus.evidence,
              addressBarTargeted: addressBar.evidence,
              queryEntry: entered.evidence,
              enterAcknowledged: submitted.evidence,
              beforeInspection: beforeInspection.evidence,
              afterInspection: afterInspection.evidence,
              navigation,
              pageLoadVerified: false,
              exactSearchResultsVerified: false,
            },
          };
        }
        case 'desktop:launch_and_type':
          return launchAndType(parameters.appId as string, parameters.text as string);
        case 'desktop:notepad_write_and_save': {
          // Notepad automation (D2.8): open, type, Save As into a NEW workspace file, then verify the file.
          const { path, text } = parameters;
          if (typeof path !== 'string' || typeof text !== 'string' || !text || text.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
            return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Notepad save requires a workspace file path and 1–500 printable characters of single-line text.', evidence: { operation: 'desktop:notepad_write_and_save', inputValidated: false } };
          }
          let absolute: string;
          try {
            absolute = await this.fileAdapter.resolveNewFileForSave(path);
          } catch (error) {
            return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: error instanceof Error ? error.message : 'The destination is not allowed.', failureKind: 'blocked', evidence: { operation: 'desktop:notepad_write_and_save', destinationChecked: true } };
          }
          // The Save As dialog receives the resolved absolute path only after the workspace check above.
          const typed = await launchAndType('notepad', text);
          if (!typed.success || typed.outcome !== VerificationOutcome.VERIFIED_SUCCESS) {
            return { ...typed, success: false, outcome: typed.outcome === VerificationOutcome.VERIFIED_FAILURE ? VerificationOutcome.PARTIAL_SUCCESS : typed.outcome, error: 'Notepad text entry was not verified, so nothing was saved: ' + (typed.error || 'unverified.'), evidence: { typing: typed.evidence, saveSkipped: true } };
          }
          const since = Date.now();
          const steps: Array<{ operation: 'desktop:hotkey' | 'desktop:type_text'; parameters: Record<string, unknown> }> = [
            { operation: 'desktop:hotkey', parameters: { keys: ['CTRL', 'SHIFT', 'S'], expectProcess: 'Notepad' } },
            { operation: 'desktop:type_text', parameters: { text: absolute, expectProcess: 'Notepad' } },
            { operation: 'desktop:hotkey', parameters: { keys: ['ENTER'], expectProcess: 'Notepad' } },
          ];
          for (const step of steps) {
            const result = await this.desktopAgent.execute(step as unknown as DesktopAction, signal);
            if (!result.success) {
              return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'Text was typed in Notepad, but the Save As sequence was not confirmed. Check the Notepad window; the file was not verified.', evidence: { typing: typed.evidence, failedStep: step.operation, step: result.evidence } };
            }
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 900));
          const verification = await this.fileAdapter.verifySaved(absolute, since, text);
          if (verification.success && verification.outcome === VerificationOutcome.VERIFIED_SUCCESS) {
            return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { path: (verification.data as { path?: string } | undefined)?.path, saved: true }, evidence: { typing: typed.evidence, durableFileVerification: verification.evidence, independentlyVerified: true } };
          }
          return { success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'Notepad received the save sequence, but the workspace file was not independently verified.', evidence: { typing: typed.evidence, durableFileVerification: verification.evidence, independentlyVerified: false } };
        }
        case 'desktop:type_text':
        case 'desktop:paste_text':
        case 'desktop:hotkey':
        case 'desktop:zoom':
        case 'desktop:inspect_window':
        case 'desktop:read_control':
        case 'desktop:click_control':
        case 'desktop:set_value':
        case 'desktop:set_toggle':
        case 'desktop:copy_selection':
        case 'desktop:paste_clipboard':
        case 'desktop:list_windows':
        case 'desktop:focus_window':
          return this.desktopAgent.execute({ operation: opRequest.operation, parameters } as unknown as DesktopAction, signal);
        case 'file:list':
          return this.fileAdapter.list(parameters.path);
        case 'file:search':
          return this.fileAdapter.search(parameters.query, parameters.path);
        case 'file:read':
          return this.fileAdapter.read(parameters.path);
        case 'file:verify_saved':
          return this.fileAdapter.verifySaved(parameters.path, parameters.since, parameters.contains);
        case 'file:write':
          return this.fileAdapter.write(parameters.path, parameters.content);
        case 'file:edit':
          return this.fileAdapter.edit(parameters.path, parameters.find, parameters.replace);
        case 'file:delete':
          return this.fileAdapter.delete(parameters.path);
        case 'file:restore':
          return this.fileAdapter.restore(parameters.quarantineId);
        case 'terminal:run':
          return this.terminal.run({ command: parameters.command, args: parameters.args, cwd: parameters.cwd }, signal);
        case 'schedule:create': {
          const created = this.scheduler.create(taskRecord.deviceId, parameters.requestText, parameters.runAt, parameters.everyMinutes);
          if (!created.ok) return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: created.error, failureKind: 'unsupported', evidence: { scheduler: true } };
          return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { id: created.job.id, runAt: created.job.runAt, everyMinutes: created.job.everyMinutes }, evidence: { scheduler: true, jobId: created.job.id, note: 'Each run is re-authorized and needs fresh approval for state-changing steps.' } };
        }
        case 'schedule:list':
          return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: this.scheduler.list(taskRecord.deviceId), evidence: { scheduler: true } };
        case 'schedule:cancel': {
          const cancelled = this.scheduler.cancel(String(parameters.id), taskRecord.deviceId);
          return { success: cancelled, outcome: cancelled ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.VERIFIED_FAILURE, error: cancelled ? undefined : 'No active schedule with that id belongs to this device.', evidence: { scheduler: true } };
        }
        // Developer assistant (JARVIS-US-063): scoped repo tools, draft suggestions,
        // and approval-gated git operations. Branch protections live in the adapter.
        case 'dev:repo_connect': case 'dev:repo_disconnect': case 'dev:repo_list': case 'dev:tree':
        case 'dev:read': case 'dev:grep': case 'dev:git_status': case 'dev:git_log': case 'dev:git_diff':
        case 'dev:explain': case 'dev:suggest_change': case 'dev:suggestion_list': case 'dev:apply_suggestion':
        case 'dev:branch_create': case 'dev:commit': case 'dev:push': case 'dev:pr_draft': case 'dev:ci_status':
          case 'dev:run_script':
          return this.developer.execute(opRequest.operation, parameters, signal);
          // JARVIS Studio Code view: workspace roots and file edits (policy-gated, approval for every change).
          case 'workspace:root_list': case 'workspace:root_add': case 'workspace:root_remove': case 'workspace:read':
          case 'workspace:search': case 'workspace:write': case 'workspace:create': case 'workspace:rename':
          case 'workspace:delete': case 'workspace:apply_diff':
          return this.workspace.execute(opRequest.operation, parameters);
        // Plugins and workflows (JARVIS-US-062). Only plugin/template state changes here;
        // workflow:run returns steps that are spliced into this task below.
        case 'plugin:install': case 'plugin:list': case 'plugin:enable': case 'plugin:disable':
        case 'plugin:uninstall': case 'plugin:grant': case 'plugin:revoke':
        case 'workflow:list': case 'workflow:show': case 'workflow:history': case 'workflow:run':
        case 'workflow:create': case 'workflow:draft_ai': case 'workflow:approve_draft': case 'workflow:archive':
        case 'workflow:compose':
          return this.workflows.execute(opRequest.operation, parameters);
        case 'gateway:site_list': case 'gateway:site_create': case 'gateway:site_update': case 'gateway:site_revoke':
          if (!isGatewaySiteOperation(opRequest.operation)) throw new Error('Unknown gateway operation');
          return this.gatewaySites.execute(opRequest.operation, parameters, taskRecord.deviceId);
        case 'ai:model_build':
          return buildLocalModel(parameters);
        default:
          throw new Error(`Execution adapter not found for ${opRequest.operation}`);
      }
    };

    let executionError: unknown;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (signal.aborted) {
        throw new Error('Task was aborted before execution');
      }
      let attempts = 0;
      const resources = this.#executionResources(taskRecord, opRequest);
      const run = this.taskCoordinator.run({
        taskId,
        deviceId: taskRecord.deviceId,
        priority: taskRecord.origin === 'schedule' ? 10 : 100,
        resources,
        signal,
        queueTimeoutMs: 30_000,
      }, async () => {
        dispatchStarted = true;
        do {
          attempts++;
          rawResult = await dispatch();
          // One bounded retry, read-only operations only, and only after a timeout.
        } while (RETRYABLE_READ_ONLY.has(opRequest.operation) && rawResult.failureKind === 'timeout' && attempts < 2 && !signal.aborted);
        return rawResult;
      });
      run.catch(() => undefined);
      // An adapter that ignores AbortSignal must not keep the task running forever.
      const hardDeadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(() => reject(Object.assign(new Error('Execution deadline exceeded'), { name: 'ExecutionDeadlineError' })), EXECUTION_TIMEOUT_MS + EXECUTION_GRACE_MS);
      });
      rawResult = await Promise.race([run, hardDeadline]);
    } catch (err: unknown) {
      executionError = err;
      // Adapter exceptions can contain local paths, command fragments, or other
      // implementation details. Keep the user-facing result generic and retain
      // only a non-sensitive error class for diagnostics.
      // E2:D4.8: once dispatch has started a non-read-only adapter may have partly acted, so the
      // outcome is uncertain (-> AWAITING_RECOVERY, owner review) rather than a clean failure.
      const uncertain = dispatchStarted && !RETRYABLE_READ_ONLY.has(opRequest.operation);
      rawResult = {
        success: false,
        outcome: uncertain ? VerificationOutcome.UNCERTAIN : VerificationOutcome.VERIFIED_FAILURE,
        error: uncertain
          ? 'The operation failed inside its adapter after it had started; its effect is uncertain and needs owner review before any retry.'
          : 'The operation failed inside its adapter; no verified success is reported.',
        evidence: { errorType: err instanceof Error ? err.name : 'UnknownError' },
      };
    } finally {
      clearTimeout(timeoutHandle);
      if (deadlineTimer) clearTimeout(deadlineTimer);
      this.activeExecutionTokens.delete(taskId);
    }
    if (executionTimedOut || (executionError instanceof Error && executionError.name === 'ExecutionDeadlineError')) taskRecord.timedOut = true;

    if ((signal.aborted || taskRecord.interrupted || executionError !== undefined) && !dispatchStarted) {
      // A task cancelled or timed out while queued has not invoked an adapter.
      // It is safe to mark terminal without an external-side-effect reconciliation.
      const queueAdmissionFailed = executionError instanceof Error && ['TaskQueueTimeoutError', 'TaskQueueFullError'].includes(executionError.name);
      const failedBeforeStart = executionTimedOut || queueAdmissionFailed || (!signal.aborted && !taskRecord.interrupted);
      taskRecord.state = failedBeforeStart ? TaskState.FAILED : TaskState.CANCELLED;
      taskRecord.interrupted = undefined;
      taskRecord.error = failedBeforeStart
        ? 'Execution capacity was unavailable before the task deadline; no adapter operation was started.'
        : 'Task was cancelled while waiting for execution capacity; no adapter operation was started.';
      taskRecord.updatedAt = Date.now();
      this.#recordStep(taskRecord, failedBeforeStart ? 'failed' : 'cancelled', VerificationOutcome.VERIFIED_FAILURE, taskRecord.error);
      this.#skipRemainingSteps(taskRecord);
      this.#persistTask(taskRecord);
      this.audit.record(failedBeforeStart ? 'TASK_QUEUE_ADMISSION_FAILED' : 'TASK_CANCELLED_WHILE_QUEUED', { taskId, operation: opRequest.operation }, taskRecord.deviceId, taskId);
      return { taskId, state: taskRecord.state, message: taskRecord.error, outcome: VerificationOutcome.VERIFIED_FAILURE, verified: true };
    }

    if (signal.aborted || taskRecord.interrupted) {
      rawResult = {
        ...rawResult,
        success: false,
        outcome: VerificationOutcome.UNCERTAIN,
        error: 'Task was interrupted; its final side-effect state requires reconciliation',
        interrupted: true,
      };
    }

    // Step 4: Verification of outcome
    const verification = this.verifier.verify(opRequest.operation, rawResult);
    taskRecord.result = rawResult;

    if (verification.honestOutcome === VerificationOutcome.VERIFIED_SUCCESS) {
      taskRecord.state = TaskState.COMPLETED;
    } else if (verification.honestOutcome === VerificationOutcome.PARTIAL_SUCCESS) {
      taskRecord.state = TaskState.PARTIAL;
    } else if (rawResult.interrupted) {
      taskRecord.state = TaskState.INTERRUPTED;
    } else if (verification.honestOutcome === VerificationOutcome.UNCERTAIN) {
      // The effect may or may not have happened: hold for reconciliation and never auto-retry.
      taskRecord.state = TaskState.AWAITING_RECOVERY;
    } else {
      taskRecord.state = TaskState.FAILED;
    }

    try {
      this.audit.record(
        'EXECUTION_COMPLETED',
        {
          operation: opRequest.operation,
          honestOutcome: verification.honestOutcome,
          verified: verification.verified,
          ...(rawResult.failureKind ? { failureKind: rawResult.failureKind } : {}),
          ...(typeof rawResult.evidence.errorType === 'string' ? { errorType: rawResult.evidence.errorType } : {}),
        },
        taskRecord.deviceId,
        taskId
      );
    } catch {
      taskRecord.state = TaskState.AWAITING_RECOVERY;
      taskRecord.error = 'Execution outcome could not be durably audited and must be reconciled';
      this.#persistTask(taskRecord);
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error,
        outcome: VerificationOutcome.UNCERTAIN,
        verified: false,
      };
    }

    const stepStatus: WorkflowStepStatus = verification.honestOutcome === VerificationOutcome.VERIFIED_SUCCESS
      ? 'completed'
      : verification.honestOutcome === VerificationOutcome.VERIFIED_FAILURE ? 'failed' : 'uncertain';
    this.#recordStep(taskRecord, stepStatus, verification.honestOutcome, verification.message);

    // Cancellation is a workflow boundary: even if an adapter ignores AbortSignal
    // and later returns, the current result is uncertain and no dependent step may run.
    if (rawResult.interrupted || taskRecord.interrupted) {
      taskRecord.state = TaskState.INTERRUPTED;
      taskRecord.interrupted = true;
      taskRecord.error = 'Execution was interrupted. The current side effect may have occurred; remaining workflow steps were skipped. Reconcile before submitting any new request.';
      this.#skipRemainingSteps(taskRecord);
      if (!this.#persistTask(taskRecord)) {
        return { taskId, state: taskRecord.state, message: taskRecord.error || 'Interruption checkpoint failed; reconcile before retrying', outcome: VerificationOutcome.UNCERTAIN, verified: false };
      }
      return { taskId, state: taskRecord.state, message: taskRecord.error, outcome: VerificationOutcome.UNCERTAIN, verified: false };
    }

    // A verified workflow:run expands into its template steps right after the current
    // step. They then run through the normal lifecycle: policy evaluation, per-step
    // approval, checkpoints, cancellation and recovery. Nested workflows are rejected
    // by template validation, so expansion cannot recurse.
    if (verification.honestOutcome === VerificationOutcome.VERIFIED_SUCCESS && taskRecord.operation === 'workflow:run' &&
        taskRecord.operations && taskRecord.operationIndex !== undefined) {
      const expanded = (rawResult.data as { steps?: unknown } | undefined)?.steps;
      if (Array.isArray(expanded) && expanded.length > 0 && expanded.length <= 20 &&
          expanded.every((step) => step && typeof (step as OperationRequest).operation === 'string' && !(step as OperationRequest).operation.startsWith('workflow:') && !(step as OperationRequest).operation.startsWith('plugin:'))) {
        taskRecord.operations.splice(taskRecord.operationIndex + 1, 0, ...(expanded as OperationRequest[]).map((step) => ({ operation: step.operation, parameters: step.parameters ?? {} })));
        this.audit.record('WORKFLOW_EXPANDED', { stepCount: expanded.length, operations: (expanded as OperationRequest[]).map((step) => step.operation) }, taskRecord.deviceId, taskId);
      }
    }

    // Every validated workflow step runs as an isolated child task through the
    // normal policy/approval/verification pipeline; independent nodes may run
    // concurrently while dependencies and resource locks remain enforced.
    if (verification.honestOutcome === VerificationOutcome.VERIFIED_SUCCESS &&
        taskRecord.operation === 'workflow:run') {
      const expandedDag = (rawResult.data as { steps?: unknown } | undefined)?.steps;
      if (Array.isArray(expandedDag) && expandedDag.length >= 1 && expandedDag.length <= 20 &&
          expandedDag.every((step) => {
            const item = step as Partial<WorkflowStep>;
            return typeof item.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,30}$/i.test(item.id) &&
              typeof item.operation === 'string' && !item.operation.startsWith('workflow:') &&
              !item.operation.startsWith('plugin:') &&
              item.parameters !== null && typeof item.parameters === 'object' && !Array.isArray(item.parameters) &&
              Array.isArray(item.dependsOn) && item.dependsOn.every((dependency) => typeof dependency === 'string');
          })) {
        return this.#runWorkflowDag(taskRecord, expandedDag as WorkflowStep[]);
      }
    }

    const hasNextStep = taskRecord.operations !== undefined && taskRecord.operationIndex !== undefined &&
      taskRecord.operationIndex + 1 < taskRecord.operations.length;

    if (verification.honestOutcome === VerificationOutcome.VERIFIED_SUCCESS && hasNextStep) {
      const nextIndex = (taskRecord.operationIndex as number) + 1;
      const nextOperation = (taskRecord.operations as OperationRequest[])[nextIndex];
      taskRecord.operationIndex = nextIndex;
      taskRecord.operation = nextOperation.operation;
      taskRecord.parameters = nextOperation.parameters;
      taskRecord.state = TaskState.CREATED;
      taskRecord.updatedAt = Date.now();
      if (!this.#persistTask(taskRecord)) {
        return { taskId, state: taskRecord.state, message: taskRecord.error || 'Checkpoint failed; next step was not started', outcome: VerificationOutcome.UNCERTAIN, verified: false };
      }
      this.audit.record('WORKFLOW_STEP_VERIFIED', {
        completedIndex: nextIndex - 1,
        nextIndex,
        nextOperation: nextOperation.operation,
        totalSteps: (taskRecord.operations as OperationRequest[]).length,
      }, taskRecord.deviceId, taskId);
      return this.#evaluateAndProceed(taskId, nextOperation, taskRecord.deviceId);
    }

    // The workflow stops here: either it finished, or a step was not verified. Never
    // continue past a failure or an ambiguous result.
    if (verification.honestOutcome !== VerificationOutcome.VERIFIED_SUCCESS) this.#skipRemainingSteps(taskRecord);
    taskRecord.updatedAt = Date.now();
    if (!this.#persistTask(taskRecord)) {
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error || 'Final task checkpoint failed; reconcile before retrying.',
        outcome: VerificationOutcome.UNCERTAIN,
        verified: false,
      };
    }
    if (taskRecord.state === TaskState.COMPLETED || taskRecord.state === TaskState.FAILED) {
      try {
        this.integrationSink?.taskFinished({ taskId, operation: opRequest.operation, outcome: String(verification.honestOutcome), failed: taskRecord.state === TaskState.FAILED, actor: this.identity.getDevice(taskRecord.deviceId)?.ssoSub });
      } catch { /* ecosystem events never affect task handling */ }
    }
    if (taskRecord.state === TaskState.COMPLETED) {
      this.notifications.push('info', 'task_completed', `Completed and verified: ${opRequest.operation}.`, { taskId, deviceId: taskRecord.deviceId });
    } else if (taskRecord.state === TaskState.FAILED) {
      this.notifications.push('error', 'task_failed', `Failed: ${opRequest.operation}.`, { taskId, deviceId: taskRecord.deviceId });
    } else {
      this.notifications.push('warning', 'task_uncertain', `Outcome not confirmed for ${opRequest.operation}; check the laptop before retrying.`, { taskId, deviceId: taskRecord.deviceId });
    }

    return {
      taskId,
      state: taskRecord.state,
      message: verification.message,
      data: rawResult.data,
      outcome: verification.honestOutcome,
      verified: verification.verified,
    };
  }

  /**
   * Executes a validated read-only workflow DAG as independent child tasks.
   * Every child still passes through the normal policy, adapter, verifier and
   * audit pipeline. Parent checkpoints are encrypted by TaskJournal.
   */
  async #runWorkflowDag(parent: TaskLifecycleRecord, steps: WorkflowStep[], reconciledNoEffectSteps?: string[]): Promise<TaskResult> {
    const executor = new WorkflowBranchExecutor();
    const runId = `${parent.id}:workflow`;
    parent.workflowSteps = structuredClone(steps);
    parent.state = TaskState.EXECUTING;
    if (!this.#persistTask(parent)) {
      return { taskId: parent.id, state: parent.state, message: parent.error || 'Workflow DAG checkpoint failed before dispatch.', verified: false };
    }
    this.audit.record('WORKFLOW_DAG_STARTED', { stepCount: steps.length, maxParallel: 4 }, parent.deviceId, parent.id);
    let checkpoint: WorkflowRunCheckpoint;
    try {
      checkpoint = await executor.run(steps, {
      runId,
      maxParallel: 4,
      ...(parent.workflowRun ? { resumeFrom: parent.workflowRun } : {}),
      ...(reconciledNoEffectSteps?.length ? { reconciledNoEffectSteps } : {}),
      resourcesForStep: (step) => this.#executionResources(parent, { operation: step.operation, parameters: step.parameters }),
      checkpoint: async (snapshot) => {
        parent.workflowRun = snapshot;
        if (!this.#persistTask(parent)) throw new Error(parent.error || 'Workflow DAG checkpoint persistence failed.');
        this.audit.record('WORKFLOW_DAG_CHECKPOINT', {
          status: snapshot.status,
          branches: snapshot.branches.map((branch) => ({ stepId: branch.stepId, operation: branch.operation, status: branch.status, outcome: branch.outcome })),
        }, parent.deviceId, parent.id);
      },
      executeStep: async (step, _context) => {
        const childId = `${parent.id}:${step.id}` as TaskId;
        let child = this.tasks.get(childId);
        if (!child) {
          child = {
            id: childId,
            deviceId: parent.deviceId,
            requestText: `Workflow branch ${step.id}: ${step.operation}`,
            state: TaskState.CREATED,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            operation: step.operation,
            parameters: structuredClone(step.parameters),
            operations: [{ operation: step.operation, parameters: structuredClone(step.parameters) }],
            operationIndex: 0,
            origin: parent.origin,
            steps: [],
            workflowParentTaskId: parent.id,
            workflowStepId: step.id,
          };
          this.tasks.set(childId, child);
          if (!this.#persistTask(child)) throw new Error(child.error || 'Child task could not be durably created.');
          this.audit.record('WORKFLOW_BRANCH_TASK_CREATED', { stepId: step.id, operation: step.operation }, parent.deviceId, childId);
        }
        if (child.state === TaskState.COMPLETED) return { status: 'completed', message: 'Previously verified child task.' };
        if (child.state === TaskState.FAILED || child.state === TaskState.REJECTED || child.state === TaskState.CANCELLED) {
          return { status: 'failed', message: child.error || 'Child task did not complete.' };
        }
        if (child.state === TaskState.AWAITING_APPROVAL && child.approvalId) {
          return { status: 'awaiting_approval', approvalRef: child.approvalId, message: 'This branch requires its own approval.' };
        }
        if (child.state !== TaskState.CREATED && child.state !== TaskState.APPROVED) {
          return { status: 'uncertain', message: child.error || 'Child task requires recovery before retry.' };
        }
        const result = await this.#evaluateAndProceed(childId, { operation: step.operation, parameters: step.parameters }, child.deviceId);
        if (result.state === TaskState.COMPLETED && result.verified) return { status: 'completed', message: result.message };
        if (result.state === TaskState.AWAITING_APPROVAL && result.approvalId) return { status: 'awaiting_approval', approvalRef: result.approvalId, message: result.message };
        if (result.state === TaskState.AWAITING_RECOVERY || result.state === TaskState.INTERRUPTED) return { status: 'uncertain', message: result.message };
        if (result.state === TaskState.PARTIAL) return { status: 'partial', message: result.message };
        if (result.state === TaskState.CANCELLED) return { status: 'cancelled', message: result.message };
        return { status: 'failed', message: result.message };
      },
      });
    } catch (error) {
      parent.state = TaskState.AWAITING_RECOVERY;
      parent.error = 'Workflow DAG execution or checkpoint persistence failed; inspect branch tasks and reconcile before retrying.';
      this.#persistTask(parent);
      try {
        this.audit.record('WORKFLOW_DAG_FAILED_CLOSED', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          automaticReplay: false,
        }, parent.deviceId, parent.id);
      } catch { /* The encrypted checkpoint remains the recovery source if audit is unavailable. */ }
      return { taskId: parent.id, state: parent.state, message: parent.error, outcome: VerificationOutcome.UNCERTAIN, verified: false };
    }
    parent.workflowRun = checkpoint;
    parent.state = checkpoint.status === 'completed' ? TaskState.COMPLETED
      : checkpoint.status === 'awaiting_approval' ? TaskState.AWAITING_APPROVAL
      : checkpoint.status === 'uncertain' ? TaskState.AWAITING_RECOVERY
      : checkpoint.status === 'cancelled' ? TaskState.CANCELLED
      : checkpoint.status === 'failed' ? TaskState.FAILED : TaskState.PARTIAL;
    parent.error = checkpoint.status === 'completed' ? undefined
      : `Workflow DAG ended with status ${checkpoint.status}; inspect branch tasks before retrying.`;
    if (!this.#persistTask(parent)) {
      return { taskId: parent.id, state: parent.state, message: parent.error || 'Workflow DAG final checkpoint failed.', outcome: VerificationOutcome.UNCERTAIN, verified: false };
    }
    this.audit.record('WORKFLOW_DAG_FINISHED', { status: checkpoint.status, branchCount: checkpoint.branches.length }, parent.deviceId, parent.id);
    return {
      taskId: parent.id,
      state: parent.state,
      message: parent.state === TaskState.COMPLETED ? 'All independent workflow branches completed and were verified.'
        : parent.error || 'Workflow DAG requires review.',
      outcome: parent.state === TaskState.COMPLETED ? VerificationOutcome.VERIFIED_SUCCESS
        : parent.state === TaskState.AWAITING_RECOVERY ? VerificationOutcome.UNCERTAIN
        : parent.state === TaskState.PARTIAL ? VerificationOutcome.PARTIAL_SUCCESS : VerificationOutcome.VERIFIED_FAILURE,
      verified: parent.state === TaskState.COMPLETED,
    };
  }

  async #settleWorkflowBranchChild(
    child: TaskLifecycleRecord,
    outcome: 'verified_success' | 'verified_failure' | 'partial' | 'uncertain',
  ): Promise<void> {
    if (!child.workflowParentTaskId || !child.workflowStepId) return;
    const parent = this.tasks.get(child.workflowParentTaskId);
    const checkpoint = parent?.workflowRun;
    if (!parent || !checkpoint || !parent.workflowSteps) return;
    const branch = checkpoint.branches.find((item) => item.stepId === child.workflowStepId);
    if (!branch || branch.status !== 'awaiting_approval') return;
    branch.status = outcome === 'verified_success' ? 'completed'
      : outcome === 'partial' ? 'partial'
      : outcome === 'uncertain' ? 'uncertain' : 'failed';
    branch.outcome = outcome;
    branch.approvalRef = undefined;
    branch.message = outcome === 'verified_success' ? 'Branch-specific approval was granted and the child task completed with verified success.'
      : outcome === 'verified_failure' ? 'Branch-specific approval was rejected or the approved operation failed; dependent branches will not run.'
      : outcome === 'partial' ? 'The approved branch produced a partial result; dependent branches will not run.'
      : 'The approved branch outcome is uncertain; reconcile before retrying or running dependent branches.';
    branch.updatedAt = Date.now();
    checkpoint.status = 'running';
    parent.state = TaskState.EXECUTING;
    parent.error = undefined;
    if (!this.#persistTask(parent)) return;
    this.audit.record('WORKFLOW_BRANCH_APPROVAL_RESOLVED', {
      stepId: child.workflowStepId,
      childTaskId: child.id,
      outcome: branch.outcome,
    }, child.deviceId, parent.id);
    await this.#runWorkflowDag(parent, parent.workflowSteps);
  }

  #assertApproverPermission(
    approval: { operation: string; taskId: string },
    approver: DeviceRecord,
    failureEvent: string,
    approvalId: string,
  ): void {
    const isMemory = approval.operation.startsWith('memory:');
    const needsManage = isMemory || approval.operation.startsWith('schedule:') ||
      approval.operation.startsWith('plugin:') || approval.operation.startsWith('workflow:') || approval.operation.startsWith('dev:') ||
      approval.operation.startsWith('gateway:') || approval.operation.startsWith('workspace:');
    const needsApp = approval.operation === 'app:launch' || approval.operation.startsWith('desktop:') ||
      approval.operation.startsWith('file:') || approval.operation.startsWith('terminal:') ||
      approval.operation.startsWith('comms:');
    if (needsManage && !approver.permissions.includes(Permission.DEVICE_MANAGE)) {
      this.audit.record(failureEvent, { approvalId, operation: approval.operation }, approver.id, approval.taskId);
      throw new Error(isMemory ? 'Approver lacks DEVICE_MANAGE permission for personal memory' : 'Approver lacks permission for this action');
    }
    if (needsApp && !approver.permissions.includes(Permission.APP_LAUNCH)) {
      this.audit.record(failureEvent, { approvalId, operation: approval.operation }, approver.id, approval.taskId);
      throw new Error('Approver lacks permission for this action');
    }
  }

  /**
   * Approves a pending task and triggers execution.
   */
  public async approveTask(
    approvalId: string,
    approverSessionId: SessionId
  ): Promise<TaskResult & { success: boolean }> {
    const approverAuth = this.identity.validateDeviceSession(approverSessionId);
    const approver = approverAuth.device;
    if (!approverAuth.valid || !approver) {
      this.audit.record('APPROVAL_FAILED_INVALID_APPROVER', { approvalId, reason: approverAuth.error });
      throw new Error('Approver session is not authenticated');
    }

    const approval = this.policy.getApproval(approvalId);
    if (!approval) throw new Error('Approval not found');

    this.#assertApproverPermission(approval, approver, 'APPROVAL_FAILED_INSUFFICIENT_PERMISSION', approvalId);

    const pendingTask = this.tasks.get(approval.taskId);
    if (!pendingTask) {
      // An orphaned approval (for example recovered after restart while its task is gone) must
      // never stay decidable: invalidate it so it cannot linger or be replayed (E:D4.2).
      this.policy.invalidateApprovals({ taskId: approval.taskId }, 'ORPHANED_APPROVAL');
      this.audit.record('APPROVAL_FAILED_TASK_NOT_FOUND', { approvalId }, approver.id, approval.taskId);
      throw new Error('Associated task not found');
    }
    // An approval record alone is not enough: checkpoint/audit failure or a
    // concurrent cancellation may have moved the task out of AWAITING_APPROVAL.
    // Reject before consuming the approval or reaching any adapter.
    if (pendingTask.state !== TaskState.AWAITING_APPROVAL) {
      this.audit.record('APPROVAL_FAILED_TASK_NOT_PENDING', {
        approvalId,
        taskState: pendingTask.state,
      }, approver.id, pendingTask.id);
      throw new Error('Task is no longer awaiting approval');
    }

    if (!approval.approved && !approval.rejected && !approval.consumed && Date.now() >= approval.expiresAt) {
      if (pendingTask.state === TaskState.AWAITING_APPROVAL) {
        pendingTask.state = TaskState.EXPIRED;
        pendingTask.updatedAt = Date.now();
        this.#skipRemainingSteps(pendingTask);
        const checkpointed = this.#persistTask(pendingTask);
        this.notifications.push('warning', 'task_expired', `Approval expired for ${approval.operation}; nothing was executed.`, { taskId: pendingTask.id, deviceId: pendingTask.deviceId });
        if (!checkpointed) {
          return {
            taskId: pendingTask.id,
            success: false,
            state: pendingTask.state,
            message: pendingTask.error || 'Expired approval could not be checkpointed; execution remains blocked.',
            outcome: VerificationOutcome.UNCERTAIN,
            verified: false,
          };
        }
        if (pendingTask.workflowParentTaskId) await this.#settleWorkflowBranchChild(pendingTask, 'verified_failure');
      }
      this.audit.record('APPROVAL_FAILED_EXPIRED', { approvalId }, approver.id, pendingTask.id);
      return {
        taskId: pendingTask.id,
        success: false,
        state: pendingTask.state,
        message: 'Approval has expired; no operation was started.',
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: true,
      };
    }

    // If the device that asked for this work was revoked or removed while the approval waited,
    // approving must not start anything: settle the task as cancelled instead (E:D4.2, E:D4.11).
    const requestingDevice = this.identity.getDevice(pendingTask.deviceId);
    if (!requestingDevice || requestingDevice.status !== 'ACTIVE') {
      this.policy.invalidateApprovals({ taskId: pendingTask.id }, 'REQUESTING_DEVICE_INACTIVE');
      pendingTask.state = TaskState.CANCELLED;
      pendingTask.updatedAt = Date.now();
      pendingTask.error = 'The requesting device is no longer active; nothing was executed.';
      this.#recordStep(pendingTask, 'cancelled', undefined, pendingTask.error);
      this.#skipRemainingSteps(pendingTask);
      this.#persistTask(pendingTask);
      this.audit.record('APPROVAL_FAILED_DEVICE_INACTIVE', { approvalId }, approver.id, pendingTask.id);
      if (pendingTask.workflowParentTaskId) await this.#settleWorkflowBranchChild(pendingTask, 'verified_failure');
      return {
        taskId: pendingTask.id,
        success: false,
        state: pendingTask.state,
        message: pendingTask.error,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: true,
      };
    }

    const resolveRes = this.policy.resolveApproval(approvalId, true, approver.id);
    if (!resolveRes.success) {
      throw new Error(resolveRes.error);
    }

    const task = pendingTask;

    // Persist the approval transition before policy evaluation can reach an
    // adapter. If this checkpoint fails, fail closed and never start execution.
    task.state = TaskState.APPROVED;
    task.updatedAt = Date.now();
    if (!this.#persistTask(task)) {
      this.policy.invalidateApprovals({ taskId: task.id }, 'APPROVAL_CHECKPOINT_FAILED');
      return {
        taskId: task.id,
        success: false,
        state: task.state,
        message: task.error || 'Approval could not be checkpointed; execution was blocked.',
        outcome: VerificationOutcome.UNCERTAIN,
        verified: false,
      };
    }

    const opRequest: OperationRequest = {
      operation: approval.operation,
      parameters: task.parameters || {},
    };

    const res = await this.#evaluateAndProceed(task.id, opRequest, task.deviceId, approvalId);
    if (task.workflowParentTaskId) {
      if (res.state === TaskState.COMPLETED && res.verified) {
        await this.#settleWorkflowBranchChild(task, 'verified_success');
      } else if ([TaskState.FAILED, TaskState.REJECTED, TaskState.CANCELLED].includes(res.state)) {
        await this.#settleWorkflowBranchChild(task, 'verified_failure');
      } else if (res.state === TaskState.PARTIAL) {
        await this.#settleWorkflowBranchChild(task, 'partial');
      } else if ([TaskState.AWAITING_RECOVERY, TaskState.INTERRUPTED].includes(res.state)) {
        await this.#settleWorkflowBranchChild(task, 'uncertain');
      }
    }
    return {
      taskId: res.taskId,
      success: res.state === TaskState.COMPLETED,
      state: res.state,
      message: res.message,
      data: res.data,
      outcome: res.outcome,
      verified: res.verified,
    };
  }

  /**
   * Rejects a pending task.
   */
  public async rejectTask(approvalId: string, approverSessionId: SessionId): Promise<{ success: boolean; message: string }> {
    const approverAuth = this.identity.validateDeviceSession(approverSessionId);
    const approver = approverAuth.device;
    if (!approverAuth.valid || !approver) {
      this.audit.record('REJECTION_FAILED_INVALID_APPROVER', { approvalId, reason: approverAuth.error });
      throw new Error('Approver session is not authenticated');
    }

    const approval = this.policy.getApproval(approvalId);
    if (!approval) throw new Error('Approval not found');

    this.#assertApproverPermission(approval, approver, 'REJECTION_FAILED_INSUFFICIENT_PERMISSION', approvalId);

    // A pending approval must not be able to mutate a task that was cancelled,
    // interrupted, expired, or moved into recovery after the approval was issued.
    // Check before consuming/rejecting the approval, matching approveTask's guard.
    const pendingTask = this.tasks.get(approval.taskId);
    if (!pendingTask) {
      this.audit.record('REJECTION_FAILED_TASK_NOT_FOUND', { approvalId }, approver.id, approval.taskId);
      this.policy.invalidateApprovals({ taskId: approval.taskId }, 'ORPHANED_APPROVAL');
      throw new Error('Associated task not found');
    }
    if (pendingTask.state !== TaskState.AWAITING_APPROVAL) {
      this.audit.record('REJECTION_FAILED_TASK_NOT_PENDING', {
        approvalId,
        taskState: pendingTask.state,
      }, approver.id, pendingTask.id);
      throw new Error('Task is no longer awaiting approval');
    }

    const resolveRes = this.policy.resolveApproval(approvalId, false, approver.id);
    if (!resolveRes.success) {
      throw new Error(resolveRes.error || 'Approval could not be rejected');
    }

    const task = this.tasks.get(approval.taskId);
    if (task) {
      task.state = TaskState.REJECTED;
      task.updatedAt = Date.now();
      this.#recordStep(task, 'cancelled', undefined, 'Rejected by approver');
      this.#skipRemainingSteps(task);
      if (!this.#persistTask(task) || task.state !== TaskState.REJECTED) {
        return { success: false, message: task.error || 'Rejection checkpoint failed; task requires recovery.' };
      }
    }
    this.audit.record('TASK_REJECTED', { approvalId, approverDeviceId: approver.id }, approver.id, approval.taskId);
    if (task?.workflowParentTaskId) await this.#settleWorkflowBranchChild(task, 'verified_failure');
    return { success: true, message: 'Task rejected' };
  }

  /**
   * Records an authenticated human reconciliation decision for an interrupted or
   * ambiguous task. This closes/annotates the record only; it never resumes or
   * replays an operation. "effect_observed" is intentionally PARTIAL, not COMPLETED,
   * because a user note is not independent application-level verification.
   */
  public reconcileTask(
    taskId: TaskId,
    sessionId: SessionId,
    disposition: 'confirmed_no_effect' | 'effect_observed' | 'still_unknown',
    note: string,
  ): { success: boolean; taskId: TaskId; state: TaskState; message: string } {
    const auth = this.identity.validateDeviceSession(sessionId);
    const reviewer = auth.device;
    if (!auth.valid || !reviewer) {
      this.audit.record('TASK_RECOVERY_RECONCILE_DENIED', { reason: 'INVALID_SESSION' });
      throw new Error('Session is not authenticated');
    }
    if (!['confirmed_no_effect', 'effect_observed', 'still_unknown'].includes(disposition)) {
      throw new Error('Recovery disposition is invalid');
    }
    if (typeof note !== 'string' || note.trim().length < 8 || note.length > 500) {
      throw new Error('Recovery note must be 8–500 characters');
    }

    const task = this.tasks.get(taskId);
    if (!task) throw new Error('Task not found');
    if (task.deviceId !== reviewer.id && !reviewer.permissions.includes(Permission.DEVICE_MANAGE)) {
      this.audit.record('TASK_RECOVERY_RECONCILE_DENIED', { reason: 'NOT_TASK_OWNER', taskId }, reviewer.id, taskId);
      throw new Error('Only the requesting device or an owner device can reconcile this task');
    }
    if (task.state !== TaskState.AWAITING_RECOVERY && task.state !== TaskState.INTERRUPTED) {
      throw new Error('Task is not awaiting recovery');
    }

    // Do not put the potentially sensitive user note into the audit log.
    this.audit.record('TASK_RECOVERY_RECONCILED', {
      disposition,
      noteLength: note.trim().length,
      previousState: task.state,
      automaticReplay: false,
    }, reviewer.id, taskId);

    task.reconciliation = {
      disposition,
      note: note.trim(),
      reviewedAt: Date.now(),
      reviewedBy: reviewer.id,
    };
    task.updatedAt = Date.now();
    if (disposition === 'confirmed_no_effect') {
      task.state = TaskState.FAILED;
      task.error = 'Manual review recorded that no side effect occurred. This task is closed; submit a new request if needed. It will not be replayed.';
    } else if (disposition === 'effect_observed') {
      task.state = TaskState.PARTIAL;
      task.error = 'A possible side effect was observed during manual reconciliation. The task remains unverified and was not replayed.';
    } else {
      task.state = TaskState.AWAITING_RECOVERY;
      task.error = 'The outcome remains unknown. No retry or dependent workflow step was started.';
    }

    if (!this.#persistTask(task)) {
      return {
        success: false,
        taskId,
        state: task.state,
        message: task.error || 'Recovery decision could not be durably checkpointed.',
      };
    }
    this.notifications.push(
      disposition === 'still_unknown' ? 'warning' : 'info',
      'task_recovery_reviewed',
      disposition === 'still_unknown'
        ? 'Task recovery reviewed, but the outcome remains unknown. No retry was started.'
        : 'Task recovery review recorded. JARVIS did not replay the task.',
      { taskId, deviceId: task.deviceId },
    );
    return { success: true, taskId, state: task.state, message: task.error || 'Recovery review recorded; no operation was replayed.' };
  }

  /**
   * Explicit, owner-reconciled resume of a recovered workflow DAG (JARVIS-GAP-003).
   * Nothing is replayed automatically: the reviewing device must name every
   * uncertain branch it confirms had no external effect, and each re-attempted
   * branch still passes through policy, approval, execution and verification as
   * a fresh child task. Branches left uncertain keep blocking their descendants.
   */
  public async resumeWorkflowRun(
    parentTaskId: TaskId,
    sessionId: SessionId,
    reconciledNoEffectSteps: string[],
    note: string,
  ): Promise<{ success: boolean; taskId: TaskId; state?: TaskState; message: string }> {
    const auth = this.identity.validateDeviceSession(sessionId);
    const reviewer = auth.device;
    if (!auth.valid || !reviewer) {
      this.audit.record('WORKFLOW_RESUME_DENIED', { reason: 'INVALID_SESSION' });
      throw new Error('Session is not authenticated');
    }
    if (typeof note !== 'string' || note.trim().length < 8 || note.length > 500) {
      throw new Error('Recovery note must be 8–500 characters');
    }
    if (!Array.isArray(reconciledNoEffectSteps) || reconciledNoEffectSteps.length > 20 ||
        reconciledNoEffectSteps.some((id) => typeof id !== 'string' || !id || id.length > 40) ||
        new Set(reconciledNoEffectSteps).size !== reconciledNoEffectSteps.length) {
      throw new Error('reconciledNoEffectSteps must be a list of unique step identifiers');
    }
    const parent = this.tasks.get(parentTaskId);
    if (!parent || !parent.workflowRun || !parent.workflowSteps || parent.workflowParentTaskId) throw new Error('Workflow run not found');
    if (parent.deviceId !== reviewer.id && !reviewer.permissions.includes(Permission.DEVICE_MANAGE)) {
      this.audit.record('WORKFLOW_RESUME_DENIED', { reason: 'NOT_TASK_OWNER' }, reviewer.id, parentTaskId);
      throw new Error('Only the requesting device or an owner device can resume this workflow');
    }
    if (parent.state !== TaskState.AWAITING_RECOVERY && parent.state !== TaskState.PARTIAL) {
      throw new Error('Workflow is not awaiting recovery');
    }
    const checkpoint = parent.workflowRun;
    for (const stepId of reconciledNoEffectSteps) {
      if (checkpoint.branches.find((branch) => branch.stepId === stepId)?.status !== 'uncertain') {
        throw new Error(`Branch ${stepId} is not awaiting uncertain-outcome reconciliation`);
      }
    }
    if (reconciledNoEffectSteps.length === 0) {
      return { success: false, taskId: parentTaskId, state: parent.state, message: 'No branches were confirmed as having no external effect; nothing was resumed.' };
    }
    // Reset each reconciled child to a fresh, un-dispatched task so it re-enters policy.
    for (const stepId of reconciledNoEffectSteps) {
      const child = this.tasks.get(`${parentTaskId}:${stepId}` as TaskId);
      if (!child) continue;
      child.reconciliation = { disposition: 'confirmed_no_effect', note: note.trim(), reviewedAt: Date.now(), reviewedBy: reviewer.id };
      child.state = TaskState.CREATED;
      child.error = undefined;
      child.interrupted = undefined;
      child.approvalId = undefined;
      child.steps = [];
      child.updatedAt = Date.now();
      if (!this.#persistTask(child)) {
        return { success: false, taskId: parentTaskId, state: parent.state, message: child.error || 'Recovery decision could not be durably checkpointed.' };
      }
    }
    this.audit.record('WORKFLOW_RESUME_AUTHORIZED', {
      reconciledSteps: reconciledNoEffectSteps,
      noteLength: note.trim().length,
      automaticReplay: false,
    }, reviewer.id, parentTaskId);
    parent.state = TaskState.EXECUTING;
    parent.error = undefined;
    const result = await this.#runWorkflowDag(parent, parent.workflowSteps, reconciledNoEffectSteps);
    return { success: true, taskId: parentTaskId, state: result.state, message: result.message };
  }

  /**
   * Cancel a task. A task still waiting for approval is cancelled and its approval
   * is invalidated immediately; a running task is interrupted and will be reported
   * as needing reconciliation (its side effects are not assumed undone).
   */
  public cancelTask(taskId: TaskId, sessionId: SessionId): { success: boolean; message: string; state?: TaskState } {
    const auth = this.identity.validateDeviceSession(sessionId);
    const requester = auth.device;
    if (!auth.valid || !requester) {
      this.audit.record('CANCEL_FAILED_INVALID_SESSION', { reason: auth.error });
      throw new Error('Session is not authenticated');
    }
    const task = this.tasks.get(taskId);
    if (!task) return { success: false, message: 'Task not found' };
    if (task.deviceId !== requester.id && !requester.permissions.includes(Permission.DEVICE_MANAGE)) {
      this.audit.record('CANCEL_DENIED_NOT_OWNER', { taskId }, requester.id, taskId);
      throw new Error('Only the requesting device or an owner device can cancel this task');
    }
    if (task.state === TaskState.EXECUTING) {
      const interrupted = this.interruptTask(taskId);
      return { success: interrupted, message: interrupted ? 'Interrupt requested. The outcome will be reported as needing reconciliation.' : 'The task was not interruptible.', state: task.state };
    }
    if (task.state === TaskState.AWAITING_APPROVAL || task.state === TaskState.CREATED || task.state === TaskState.APPROVED) {
      this.activePlanningTokens.get(taskId)?.abort();
      this.policy.invalidateApprovals({ taskId }, 'TASK_CANCELLED');
      task.state = TaskState.CANCELLED;
      task.updatedAt = Date.now();
      this.#recordStep(task, 'cancelled', undefined, 'Cancelled by user');
      this.#skipRemainingSteps(task);
      if (!this.#persistTask(task) || task.state !== TaskState.CANCELLED) {
        return { success: false, message: task.error || 'Cancellation checkpoint failed; task state requires recovery.', state: task.state };
      }
      this.audit.record('TASK_CANCELLED', { taskId }, requester.id, taskId);
      this.notifications.push('info', 'task_cancelled', 'A task was cancelled before it ran.', { taskId, deviceId: task.deviceId });
      return { success: true, message: 'Task cancelled; nothing was executed.', state: task.state };
    }
    return { success: false, message: `Task is already ${task.state}.`, state: task.state };
  }

  /**
   * Reliable stop (D2.19): cancels everything pending and interrupts everything running for the
   * requesting device, or for every device when an owner device asks for scope 'all'. Pending
   * approvals are invalidated so nothing can run after the stop. Interrupted work is reported
   * as needing reconciliation (side effects are not assumed undone). Schedules are not touched.
   */
  public stopAll(sessionId: SessionId, scope: 'device' | 'all' = 'device'): { cancelled: number; interrupted: number; scope: 'device' | 'all' } {
    const auth = this.identity.validateDeviceSession(sessionId);
    const requester = auth.device;
    if (!auth.valid || !requester) throw new Error('Session is not authenticated');
    if (scope === 'all' && !requester.permissions.includes(Permission.DEVICE_MANAGE)) {
      this.audit.record('STOP_ALL_DENIED_NOT_OWNER', {}, requester.id);
      throw new Error('Only an owner device can stop all devices');
    }
    let cancelled = 0;
    let interrupted = 0;
    for (const task of [...this.tasks.values()]) {
      if (scope === 'device' && task.deviceId !== requester.id) continue;
      if (task.state === TaskState.EXECUTING) {
        if (this.interruptTask(task.id)) interrupted += 1;
        else {
          // No live controller: the task must still reach a recovery state, never stay running.
          task.state = TaskState.AWAITING_RECOVERY;
          task.interrupted = true;
          task.error = 'Stopped by user; reconcile external state before retrying.';
          this.#persistTask(task);
          interrupted += 1;
        }
      } else if (task.state === TaskState.AWAITING_APPROVAL || task.state === TaskState.CREATED || task.state === TaskState.APPROVED) {
        this.activePlanningTokens.get(task.id)?.abort();
        this.policy.invalidateApprovals({ taskId: task.id }, 'STOP_ALL');
        task.state = TaskState.CANCELLED;
        this.#recordStep(task, 'cancelled', undefined, 'Stopped by user');
        this.#skipRemainingSteps(task);
        this.#persistTask(task);
        cancelled += 1;
      }
    }
    this.audit.record('STOP_ALL', { scope, cancelled, interrupted }, requester.id);
    this.events.publish('ops.alert', { kind: 'stop_all', scope, cancelled, interrupted }, scope === 'device' ? requester.id : undefined);
    return { cancelled, interrupted, scope };
  }

  /**
   * Derive conservative resource locks from operation semantics. Desktop input is
   * exclusive across the host; memory, registries and shared workspace operations
   * are serialized until finer-grained resource identity is proven.
   * The coordinator acquires the complete sorted set atomically.
   */
  #executionResources(task: TaskLifecycleRecord, request: OperationRequest): string[] {
    const operation = request.operation;
    const resources = new Set<string>();
    if (/^(app:|desktop:)/.test(operation)) resources.add('desktop:host');
    if (/^memory:/.test(operation)) resources.add('memory:personal-store');
    if (/^(plugin:|workflow:)/.test(operation)) resources.add('workflow:plugin-registry');
    if (/^(file:|dev:|workspace:)/.test(operation)) resources.add('workspace:shared');
    return [...resources];
  }

  /**
   * Safe interruption: stops in-flight task and reconciles state.
   */
  public interruptTask(taskId: TaskId): boolean {
    const controller = this.activeExecutionTokens.get(taskId);
    if (controller) {
      controller.abort();
      const task = this.tasks.get(taskId);
      if (task) {
        task.state = TaskState.AWAITING_RECOVERY;
        task.interrupted = true;
        task.error = 'Execution was interrupted; reconcile external state before retrying.';
        this.#persistTask(task);
      }
      this.audit.record('TASK_INTERRUPTED', { taskId }, task?.deviceId, taskId);
      return true;
    }
    return false;
  }

  /**
   * Must be called whenever a device is revoked. Pending approvals, remembered
   * grants, scheduled work and running tasks owned by that device stop immediately.
   */
  public onDeviceRevoked(deviceId: DeviceId, reason: DeviceRevokeReason = 'unspecified'): void {
    try { this.integrationSink?.deviceRevoked(reason); } catch { /* ecosystem events never affect revocation */ }
    const invalidated = this.policy.invalidateApprovals({ deviceId }, 'DEVICE_REVOKED');
    this.events.publish('device.revoked', { reason }, deviceId);
    this.deviceSecurity?.cancelPendingCreatedBy(deviceId);
    const schedules = this.scheduler.cancelForDevice(deviceId);
    // A revoked device's short-lived working context is discarded immediately.
    this.memoryManager?.working.clearDevice(deviceId);
    for (const task of this.tasks.values()) {
      if (task.deviceId !== deviceId) continue;
      if (task.state === TaskState.EXECUTING) this.interruptTask(task.id);
      else if (task.state === TaskState.AWAITING_APPROVAL || task.state === TaskState.CREATED || task.state === TaskState.APPROVED) {
        this.activePlanningTokens.get(task.id)?.abort();
        task.state = TaskState.CANCELLED;
        task.updatedAt = Date.now();
        task.error = 'The requesting device was revoked; nothing further was executed.';
        this.#recordStep(task, 'cancelled', undefined, task.error);
        this.#skipRemainingSteps(task);
        this.#persistTask(task);
        if (task.workflowParentTaskId) void this.#settleWorkflowBranchChild(task, 'verified_failure').catch(() => undefined);
      }
    }
    this.notifications.push('warning', 'device_revoked', `A device was revoked; ${invalidated} approval(s) and ${schedules} schedule(s) were cancelled.`, { deviceId });
  }

  /** Re-run a due scheduled request as its owner. No approval or permission is inherited. */
  async #runScheduledJob(job: ScheduledJob): Promise<JobRunResult> {
    const owner = this.identity.getDevice(job.ownerDeviceId);
    if (!owner || owner.status !== 'ACTIVE') {
      this.audit.record('SCHEDULE_BLOCKED_OWNER_UNAVAILABLE', { jobId: job.id }, job.ownerDeviceId);
      this.notifications.push('warning', 'schedule_blocked', 'A scheduled request was skipped because its owner device is no longer active.', { deviceId: job.ownerDeviceId });
      return { state: 'OWNER_UNAVAILABLE' };
    }
    const result = await this.#processRequest(owner, job.requestText, 'schedule');
    this.notifications.push(
      result.state === TaskState.AWAITING_APPROVAL ? 'warning' : 'info',
      'schedule_triggered',
      result.state === TaskState.AWAITING_APPROVAL
        ? 'A scheduled request is waiting for your approval before it can run.'
        : `A scheduled request ran: ${result.state}.`,
      { taskId: result.taskId, deviceId: owner.id },
    );
    return { taskId: result.taskId, state: result.state };
  }

  /** Measured host/service health. Values come from the OS and live service state, never constants. */
  public getHealthSnapshot(): Record<string, unknown> {
    const cpuList = cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpuList) {
      idle += cpu.times.idle;
      total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
    }
    let cpuPercent: number | undefined;
    if (this.cpuSample && total > this.cpuSample.total) {
      cpuPercent = Math.round((1 - (idle - this.cpuSample.idle) / (total - this.cpuSample.total)) * 100);
    }
    this.cpuSample = { idle, total };
    const tasks = Array.from(this.tasks.values());
    const total_ = totalmem();
    return {
      generatedAt: Date.now(),
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      core: {
        auditIntegrity: this.audit.verifyIntegrity().valid,
        identityState: this.identity.isStateHealthy(),
        schedulerPersistence: this.scheduler.healthy,
      },
      host: {
        platform: process.platform,
        logicalCores: cpuList.length,
        cpuUsagePercent: cpuPercent ?? null,
        memoryTotalBytes: total_,
        memoryUsedPercent: Math.round((1 - freemem() / total_) * 100),
        processRssBytes: process.memoryUsage().rss,
      },
      agent: {
        windowsDesktopAgentSupported: this.desktopAgent.isSupportedHost(),
        workspaceRoots: this.fileAdapter.getRoots().length,
        personalMemoryConfigured: this.personalMemory !== undefined,
      },
      tasks: {
        total: tasks.length,
        running: this.activeExecutionTokens.size,
        executionQueue: (() => { const snapshot = this.taskCoordinator.snapshot(); const planning = this.planningCoordinator.snapshot(); return { active: snapshot.active, queued: snapshot.queued, activeTasks: snapshot.activeTasks, queuedTasks: snapshot.queuedTasks, limits: snapshot.limits, lockedResourceCount: snapshot.lockedResourceCount, planning: { active: planning.active, queued: planning.queued, activeTasks: planning.activeTasks, queuedTasks: planning.queuedTasks, limits: planning.limits } }; })(),
        awaitingApproval: tasks.filter((task) => task.state === TaskState.AWAITING_APPROVAL).length,
        awaitingRecovery: tasks.filter((task) => task.state === TaskState.AWAITING_RECOVERY).length,
        failed: tasks.filter((task) => task.state === TaskState.FAILED).length,
        reliability: this.reliabilityMetrics(),
      },
      subsystems: {
        taskJournalPersistent: this.taskJournal !== undefined,
        eventsLatestSeq: this.events.latestSeq(),
        routingMode: routingMode(),
        ciProviderEnabled: createCiProvider().enabled,
      },
      schedules: { active: this.scheduler.activeCount },
      notifications: this.notifications.size,
    };
  }

  /**
   * Reliability aggregates derived from existing task/outcome records (JARVIS-US-025). Only counts
   * and rates are returned: no prompts, parameters, ids or message text. The window is the retained
   * task journal (bounded), not an unbounded history.
   *
   * Executed = reached an execution outcome (completed, partial, failed, interrupted, awaiting recovery).
   * Owner-driven endings (rejected, expired, cancelled) are excluded from both rates.
   * Crash-free completion rate = 1 - (interrupted or awaiting-recovery) / executed.
   * Verified-outcome rate = executed tasks whose result is a definitive VERIFIED_SUCCESS or VERIFIED_FAILURE.
   */
  public reliabilityMetrics(): {
    window: 'retained-task-records'; recordsConsidered: number; executedTasks: number; completed: number; interruptedOrRecovery: number;
    crashFreeCompletionRate: number | null; verifiedDefinitive: number; verifiedSuccess: number; verifiedOutcomeRate: number | null; verifiedSuccessRate: number | null;
  } {
    const executedStates = new Set<TaskState>([TaskState.COMPLETED, TaskState.PARTIAL, TaskState.FAILED, TaskState.INTERRUPTED, TaskState.AWAITING_RECOVERY]);
    let executed = 0, completed = 0, interrupted = 0, definitive = 0, success = 0, considered = 0;
    for (const task of this.tasks.values()) {
      considered += 1;
      if (!executedStates.has(task.state)) continue;
      executed += 1;
      if (task.state === TaskState.COMPLETED) completed += 1;
      if (task.state === TaskState.INTERRUPTED || task.state === TaskState.AWAITING_RECOVERY) interrupted += 1;
      const outcome = task.result?.outcome;
      if (outcome === VerificationOutcome.VERIFIED_SUCCESS) { definitive += 1; success += 1; }
      else if (outcome === VerificationOutcome.VERIFIED_FAILURE) definitive += 1;
    }
    const rate = (n: number) => (executed > 0 ? Math.round((n / executed) * 10000) / 10000 : null);
    return {
      window: 'retained-task-records', recordsConsidered: considered, executedTasks: executed, completed, interruptedOrRecovery: interrupted,
      crashFreeCompletionRate: rate(executed - interrupted), verifiedDefinitive: definitive, verifiedSuccess: success,
      verifiedOutcomeRate: rate(definitive), verifiedSuccessRate: rate(success),
    };
  }

  public hasDurableTaskJournal(): boolean {
    return this.taskJournal !== undefined;
  }

  public getTask(taskId: TaskId): TaskLifecycleRecord | undefined {
    return this.tasks.get(taskId);
  }

  public listTasks(): TaskLifecycleRecord[] {
    return Array.from(this.tasks.values());
  }
}
