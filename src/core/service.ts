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
import { WindowsSystemAdapter } from '../adapters/windowsSystem.js';
import { WindowsAppLauncherAdapter } from '../adapters/windowsAppLauncher.js';
import { WindowsDesktopAgent, DesktopAction } from '../adapters/windowsDesktopAgent.js';
import { WorkspaceFileAdapter } from '../adapters/workspaceFiles.js';
import { TerminalRunner } from '../adapters/terminalRunner.js';
import { OutcomeVerifier } from '../verification/verifier.js';
import { DeveloperAssistant } from '../developer/developerAssistant.js';
import { createConfiguredAgentModelAdapter } from '../conversation/agentModelAdapter.js';
import { AuditLogger } from '../audit/audit.js';
import { IAIPlannerProvider, MinimizedContext, PlanProposal } from '../planner/planner.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { DeviceSecurityService } from './deviceSecurity.js';
import { NotificationCenter } from './notifications.js';
import { Scheduler, ScheduledJob, JobRunResult } from '../scheduler/scheduler.js';
import { PersonalMemoryStore, MemoryCategory } from '../memory/personalMemoryStore.js';
import { MemoryManager } from '../memory/memoryManager.js';
import { WorkingMemory } from '../memory/workingMemory.js';
import { CommunicationsAdapter } from '../adapters/communications.js';
import { TaskJournal } from './taskJournal.js';

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
]);

export class JarvisCoreService {
  public readonly audit: AuditLogger;
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
  public readonly notifications: NotificationCenter;
  public readonly scheduler: Scheduler;
  public planner: IAIPlannerProvider;
  public readonly personalMemory?: PersonalMemoryStore;
  /** Two-tier memory (working + long-term) and consent-based learning (US-057/058). */
  public readonly memoryManager?: MemoryManager;

  private tasks = new Map<TaskId, TaskLifecycleRecord>();
  private readonly taskJournal?: TaskJournal;
  private activeExecutionTokens = new Map<TaskId, AbortController>();
  private readonly startedAt = Date.now();
  private cpuSample?: { idle: number; total: number };

  constructor(
    planner: IAIPlannerProvider,
    logPath: string = './data/audit.log',
    statePath?: string,
    ownerControlToken?: string
  ) {
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
    this.developer = new DeveloperAssistant(statePath ? statePath + '.developer' : './data/developer', createConfiguredAgentModelAdapter);
    this.notifications = new NotificationCenter();
    this.scheduler = new Scheduler(
      this.audit,
      (job) => this.#runScheduledJob(job),
      ownerControlToken ? (statePath ? `${statePath}.schedules` : './data/schedules.json') : undefined,
      ownerControlToken,
    );
    this.planner = planner;
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
      this.taskJournal = new TaskJournal(statePath ? statePath + '.tasks' : './data/tasks.enc', ownerControlToken);
      for (const record of this.taskJournal.list()) this.tasks.set(record.id, record);
    }
  }

  /** Start the scheduler loop. Called by the server on start; never runs implicitly. */
  public startBackgroundServices(): void {
    this.scheduler.start();
  }

  public stopBackgroundServices(): void {
    this.scheduler.stop();
    for (const controller of this.activeExecutionTokens.values()) controller.abort();
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
   * Shared pipeline for interactive and scheduled requests. A scheduled request
   * gets no special authority: it is planned and policy-evaluated exactly like a
   * live one, using the owner device's permissions at the moment it runs.
   */
  async #processRequest(device: DeviceRecord, requestText: string, origin: 'interactive' | 'schedule'): Promise<TaskResult> {
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
    };
    let plan: PlanProposal;
    try {
      plan = await this.planner.generatePlan(requestText, context);
    } catch (error: unknown) {
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
    if (!device) throw new Error('Device not found');

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
    const timeoutHandle = setTimeout(() => abortController.abort(), EXECUTION_TIMEOUT_MS);

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
          const updated = this.personalMemory.update(parameters.id as string, parameters.content as string);
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
          // Derived copies held by the Memory Manager (working memory, learning candidates).
          if (deleted && existing) this.memoryManager?.scrubDeleted(id, existing.content);
          this.audit.record('PERSONAL_MEMORY_DELETE', { memoryId: id, deleted, diskVerified, secondaryTasksScrubbed: scrub.scrubbedTasks, secondaryPersisted: scrub.persisted }, taskRecord.deviceId, taskId);
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
        case 'app:launch':
          return this.appAdapter.launchApp(parameters.appId as string, signal);
        case 'app:inventory':
          return this.appAdapter.inventory(signal);
        case 'comms:handoff_email':
          return this.communications.handoffEmail(parameters, signal);
        case 'comms:unsupported':
          return this.communications.unsupported(parameters.channel, parameters.reason);
        case 'desktop:launch_and_type': {
          const launch = await this.appAdapter.launchApp(parameters.appId as string, signal);
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
          const typing = await this.desktopAgent.execute({
            operation: 'desktop:type_text',
            parameters: { text: parameters.text as string, expectProcess: launched.windowProcess },
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
        }
        case 'desktop:type_text':
        case 'desktop:paste_text':
        case 'desktop:hotkey':
        case 'desktop:zoom':
        case 'desktop:inspect_window':
        case 'desktop:read_control':
        case 'desktop:click_control':
        case 'desktop:set_value':
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
          return this.developer.execute(opRequest.operation, parameters, signal);
        default:
          throw new Error(`Execution adapter not found for ${opRequest.operation}`);
      }
    };

    try {
      if (signal.aborted) {
        throw new Error('Task was aborted before execution');
      }
      let attempts = 0;
      do {
        attempts++;
        rawResult = await dispatch();
        // One bounded retry, read-only operations only, and only after a timeout.
      } while (RETRYABLE_READ_ONLY.has(opRequest.operation) && rawResult.failureKind === 'timeout' && attempts < 2 && !signal.aborted);
    } catch (err: unknown) {
      // Adapter exceptions can contain local paths, command fragments, or other
      // implementation details. Keep the user-facing result generic and retain
      // only a non-sensitive error class for diagnostics.
      rawResult = {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: 'The operation failed inside its adapter; no verified success is reported.',
        evidence: { errorType: err instanceof Error ? err.name : 'UnknownError' },
      };
    } finally {
      clearTimeout(timeoutHandle);
      this.activeExecutionTokens.delete(taskId);
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

  #assertApproverPermission(
    approval: { operation: string; taskId: string },
    approver: DeviceRecord,
    failureEvent: string,
    approvalId: string,
  ): void {
    const isMemory = approval.operation.startsWith('memory:');
    const needsManage = isMemory || approval.operation.startsWith('schedule:');
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
    if (!pendingTask) throw new Error('Associated task not found');
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
  public rejectTask(approvalId: string, approverSessionId: SessionId): { success: boolean; message: string } {
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
      this.#persistTask(task);
      if (task.state !== TaskState.REJECTED) {
        return { success: false, message: task.error || 'Rejection checkpoint failed; task requires recovery.' };
      }
    }
    this.audit.record('TASK_REJECTED', { approvalId, approverDeviceId: approver.id }, approver.id, approval.taskId);
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
  public onDeviceRevoked(deviceId: DeviceId): void {
    const invalidated = this.policy.invalidateApprovals({ deviceId }, 'DEVICE_REVOKED');
    const schedules = this.scheduler.cancelForDevice(deviceId);
    // A revoked device's short-lived working context is discarded immediately.
    this.memoryManager?.working.clearDevice(deviceId);
    for (const task of this.tasks.values()) {
      if (task.deviceId !== deviceId) continue;
      if (task.state === TaskState.EXECUTING) this.interruptTask(task.id);
      else if (task.state === TaskState.AWAITING_APPROVAL || task.state === TaskState.CREATED) {
        task.state = TaskState.CANCELLED;
        task.updatedAt = Date.now();
        this.#persistTask(task);
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
        awaitingApproval: tasks.filter((task) => task.state === TaskState.AWAITING_APPROVAL).length,
        awaitingRecovery: tasks.filter((task) => task.state === TaskState.AWAITING_RECOVERY).length,
        failed: tasks.filter((task) => task.state === TaskState.FAILED).length,
      },
      schedules: { active: this.scheduler.activeCount },
      notifications: this.notifications.size,
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
