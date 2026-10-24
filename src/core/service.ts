import {
  TaskId,
  TaskState,
  OperationRequest,
  DeviceId,
  SessionId,
  ExecutionResult,
  VerificationOutcome,
  RiskTier,
  Permission,
} from '../core/types.js';
import { DeviceIdentityManager } from '../core/identity.js';
import { PolicyGateway } from '../policy/gateway.js';
import { WindowsSystemAdapter } from '../adapters/windowsSystem.js';
import { WindowsAppLauncherAdapter } from '../adapters/windowsAppLauncher.js';
import { WindowsDesktopAgent, DesktopAction } from '../adapters/windowsDesktopAgent.js';
import { OutcomeVerifier } from '../verification/verifier.js';
import { AuditLogger } from '../audit/audit.js';
import { IAIPlannerProvider, MinimizedContext, PlanProposal } from '../planner/planner.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { DeviceSecurityService } from './deviceSecurity.js';
import { PersonalMemoryStore, MemoryCategory } from '../memory/personalMemoryStore.js';

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

export class JarvisCoreService {
  public readonly audit: AuditLogger;
  public readonly identity: DeviceIdentityManager;
  public readonly deviceSecurity?: DeviceSecurityService;
  public readonly policy: PolicyGateway;
  public readonly systemAdapter: WindowsSystemAdapter;
  public readonly appAdapter: WindowsAppLauncherAdapter;
  public readonly desktopAgent: WindowsDesktopAgent;
  public readonly verifier: OutcomeVerifier;
  public planner: IAIPlannerProvider;
  public readonly personalMemory?: PersonalMemoryStore;

  private tasks = new Map<TaskId, TaskLifecycleRecord>();
  private activeExecutionTokens = new Map<TaskId, AbortController>();

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
    this.verifier = new OutcomeVerifier();
    this.planner = planner;
    if (ownerControlToken) {
      this.personalMemory = new PersonalMemoryStore(
        statePath ? statePath + '.memory' : './data/personal-memory.enc',
        ownerControlToken,
      );
    }
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

    const device = auth.device;
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
    };
    this.tasks.set(taskId, taskRecord);

    try {
      this.audit.record('REQUEST_RECEIVED', { requestLength: requestText.length }, device.id, taskId);
    } catch {
      taskRecord.state = TaskState.AWAITING_RECOVERY;
      taskRecord.error = 'Request could not be durably audited; no operation was planned or executed';
      return { taskId, state: taskRecord.state, message: taskRecord.error, verified: false };
    }

    // Step 2: Understand request & build bounded plan via Planner (AI Advisory)
    const context: MinimizedContext = {
      requesterName: device.name,
      timestamp: Date.now(),
      memory: this.personalMemory?.list().slice(0, 20).map((record) => record.content),
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
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: false,
      };
    }

    // Validate plan against strict schema
    const validation = this.planner.validatePlanSchema(plan);
    if (!validation.valid) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = `Invalid AI plan proposal: ${(validation.errors || []).join('; ')}`;
      this.audit.record('PLANNING_SCHEMA_VIOLATION', { errorCount: validation.errors?.length || 0 }, device.id, taskId);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    if (!plan.operations || plan.operations.length === 0) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = plan.explanation;
      this.audit.record('PLANNING_UNABLE_TO_MAP', {
        operationCount: plan.operations.length,
        confidence: plan.confidence,
      }, device.id, taskId);
      return { taskId, state: taskRecord.state, message: plan.explanation };
    }

    // Single bounded operation per task in POC slice
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
        return { taskId, state: taskRecord.state, message: policyResult.reason || 'Policy denied execution' };
      }
    }

    // Policy permitted: proceed to execute
    return this.#executeTask(taskId, opRequest);
  }

  /**
   * Executes permitted operation via allowlisted execution adapters with cancellation tracking.
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
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    // Precondition re-check: verify device is not revoked
    const device = this.identity.getDevice(taskRecord.deviceId);
    if (!device || device.status !== 'ACTIVE') {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Device revoked or inactive before execution';
      this.audit.record('EXECUTION_BLOCKED_DEVICE_REVOKED', {}, taskRecord.deviceId, taskId);
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    // Safety Invariant: Check audit chain integrity before any execution
    const auditIntegrity = this.audit.verifyIntegrity();
    if (!auditIntegrity.valid) {
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = `Execution blocked: Audit chain integrity violation (${auditIntegrity.reason})`;
      return { taskId, state: taskRecord.state, message: taskRecord.error };
    }

    taskRecord.state = TaskState.EXECUTING;
    const abortController = new AbortController();
    this.activeExecutionTokens.set(taskId, abortController);

    try {
      this.audit.record('EXECUTION_STARTED', { operation: opRequest.operation }, taskRecord.deviceId, taskId);
    } catch {
      this.activeExecutionTokens.delete(taskId);
      taskRecord.state = TaskState.FAILED;
      taskRecord.error = 'Execution blocked because the audit record could not be persisted';
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        verified: true,
      };
    }

    let rawResult: ExecutionResult;

    try {
      if (abortController.signal.aborted) {
        throw new Error('Task was aborted before execution');
      }

      // Dispatch ONLY to allowlisted adapters
      switch (opRequest.operation) {
        case 'memory:list': {
          if (!this.personalMemory) {
            rawResult = { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          } else {
            rawResult = { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: this.personalMemory.list(), evidence: { memoryAvailable: true, encryptedAtRest: true } };
          }
          break;
        }
        case 'memory:save': {
          if (!this.personalMemory) {
            rawResult = { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          } else {
            const record = this.personalMemory.save(
              opRequest.parameters.category as MemoryCategory,
              opRequest.parameters.content as string,
              opRequest.parameters.ttlDays as number | undefined,
            );
            this.audit.record('PERSONAL_MEMORY_SAVED', { category: record.category, memoryId: record.id }, taskRecord.deviceId, taskId);
            rawResult = { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { id: record.id, category: record.category, createdAt: record.createdAt, expiresAt: record.expiresAt }, evidence: { encryptedAtRest: true, memoryId: record.id } };
          }
          break;
        }
        case 'memory:delete': {
          if (!this.personalMemory) {
            rawResult = { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'Personal memory is not configured.', evidence: { memoryAvailable: false } };
          } else {
            const id = opRequest.parameters.id as string;
            const deleted = this.personalMemory.delete(id);
            this.audit.record('PERSONAL_MEMORY_DELETE', { memoryId: id, deleted }, taskRecord.deviceId, taskId);
            rawResult = { success: deleted, outcome: deleted ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.VERIFIED_FAILURE, error: deleted ? undefined : 'Memory entry not found.', data: { deleted }, evidence: { memoryId: id, deleted } };
          }
          break;
        }
        case 'system:get_os_info':
          rawResult = await this.systemAdapter.getOsInfo();
          break;
        case 'system:get_memory_info':
          rawResult = await this.systemAdapter.getMemoryInfo();
          break;
        case 'system:get_battery_status':
          rawResult = await this.systemAdapter.getBatteryStatus(abortController.signal);
          break;
        case 'system:get_disk_space':
          rawResult = await this.systemAdapter.getDiskSpace(
            (opRequest.parameters.drive as string) || 'C:',
            abortController.signal
          );
          break;
        case 'app:launch':
          rawResult = await this.appAdapter.launchApp(opRequest.parameters.appId as string, abortController.signal);
          break;
        case 'desktop:launch_and_type': {
          const launch = await this.appAdapter.launchApp(opRequest.parameters.appId as string, abortController.signal);
          if (!launch.success || launch.outcome !== VerificationOutcome.VERIFIED_SUCCESS) {
            rawResult = launch;
          } else {
            const typing = await this.desktopAgent.execute({
              operation: 'desktop:type_text',
              parameters: { text: opRequest.parameters.text as string },
            }, abortController.signal);
            rawResult = {
              ...typing,
              data: { launch: launch.data, typing: typing.data },
              evidence: { launch: launch.evidence, typing: typing.evidence },
            };
          }
          break;
        }
        case 'desktop:type_text':
        case 'desktop:paste_text':
        case 'desktop:hotkey':
        case 'desktop:zoom':
        case 'desktop:inspect_window':
        case 'desktop:click_control':
        case 'desktop:set_value':
        case 'desktop:copy_selection':
        case 'desktop:paste_clipboard':
          rawResult = await this.desktopAgent.execute({
            operation: opRequest.operation,
            parameters: opRequest.parameters,
          } as DesktopAction, abortController.signal);
          break;
        default:
          throw new Error(`Execution adapter not found for ${opRequest.operation}`);
      }
    } catch (err: unknown) {
      rawResult = {
        success: false,
        outcome: VerificationOutcome.VERIFIED_FAILURE,
        error: String(err),
        evidence: { error: String(err) },
      };
    } finally {
      this.activeExecutionTokens.delete(taskId);
    }

    if (abortController.signal.aborted || taskRecord.interrupted) {
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
        },
        taskRecord.deviceId,
        taskId
      );
    } catch {
      taskRecord.state = TaskState.AWAITING_RECOVERY;
      taskRecord.error = 'Execution outcome could not be durably audited and must be reconciled';
      return {
        taskId,
        state: taskRecord.state,
        message: taskRecord.error,
        outcome: VerificationOutcome.UNCERTAIN,
        verified: false,
      };
    }

    if (verification.honestOutcome === VerificationOutcome.VERIFIED_SUCCESS &&
        taskRecord.operations && taskRecord.operationIndex !== undefined &&
        taskRecord.operationIndex + 1 < taskRecord.operations.length) {
      const nextIndex = taskRecord.operationIndex + 1;
      const nextOperation = taskRecord.operations[nextIndex];
      taskRecord.operationIndex = nextIndex;
      taskRecord.operation = nextOperation.operation;
      taskRecord.parameters = nextOperation.parameters;
      taskRecord.state = TaskState.CREATED;
      taskRecord.updatedAt = Date.now();
      this.audit.record('WORKFLOW_STEP_VERIFIED', {
        completedIndex: nextIndex - 1,
        nextIndex,
        nextOperation: nextOperation.operation,
        totalSteps: taskRecord.operations.length,
      }, taskRecord.deviceId, taskId);
      return this.#evaluateAndProceed(taskId, nextOperation, taskRecord.deviceId);
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

    if (approval.operation.startsWith('memory:') && !approver.permissions.includes(Permission.DEVICE_MANAGE)) {
      this.audit.record('APPROVAL_FAILED_INSUFFICIENT_PERMISSION', { approvalId, operation: approval.operation }, approver.id, approval.taskId);
      throw new Error('Approver lacks DEVICE_MANAGE permission for personal memory');
    }
    if ((approval.operation === 'app:launch' || approval.operation.startsWith('desktop:')) && !approver.permissions.includes(Permission.APP_LAUNCH)) {
      this.audit.record('APPROVAL_FAILED_INSUFFICIENT_PERMISSION', { approvalId, operation: approval.operation }, approver.id, approval.taskId);
      throw new Error('Approver lacks permission for this action');
    }

    const resolveRes = this.policy.resolveApproval(approvalId, true, approver.id);
    if (!resolveRes.success) {
      throw new Error(resolveRes.error);
    }

    const task = this.tasks.get(approval.taskId);
    if (!task) throw new Error('Associated task not found');

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

    if (approval.operation === 'app:launch' && !approver.permissions.includes(Permission.APP_LAUNCH)) {
      this.audit.record('REJECTION_FAILED_INSUFFICIENT_PERMISSION', { approvalId, operation: approval.operation }, approver.id, approval.taskId);
      throw new Error('Approver lacks permission for this action');
    }

    const resolveRes = this.policy.resolveApproval(approvalId, false, approver.id);
    if (!resolveRes.success) {
      throw new Error(resolveRes.error || 'Approval could not be rejected');
    }

    const task = this.tasks.get(approval.taskId);
    if (task) {
      task.state = TaskState.REJECTED;
      task.updatedAt = Date.now();
    }
    this.audit.record('TASK_REJECTED', { approvalId, approverDeviceId: approver.id }, approver.id, approval.taskId);
    return { success: true, message: 'Task rejected' };
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
        task.state = TaskState.INTERRUPTED;
        task.interrupted = true;
      }
      this.audit.record('TASK_INTERRUPTED', { taskId }, task?.deviceId, taskId);
      return true;
    }
    return false;
  }

  public getTask(taskId: TaskId): TaskLifecycleRecord | undefined {
    return this.tasks.get(taskId);
  }

  public listTasks(): TaskLifecycleRecord[] {
    return Array.from(this.tasks.values());
  }
}
