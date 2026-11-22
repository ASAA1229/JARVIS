import { findPaymentTarget } from './exclusions.js';
import {
  OperationRequest,
  DeviceRecord,
  ApprovalRecord,
  PolicyEvaluation,
  RiskTier,
  Permission,
  DeviceId,
  TaskId,
} from '../core/types.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { CryptoUtil } from '../crypto/crypto.js';
import { AuditLogger } from '../audit/audit.js';

interface PolicyRule {
  operation: string;
  requiredPermission: Permission;
  riskTier: RiskTier;
  requiresApproval: boolean;
  allowedParameters?: string[];
}

interface RememberedGrant {
  deviceId: DeviceId;
  operation: string;
  parametersHash: string;
  createdAt: number;
  expiresAt: number;
}

export class PolicyGateway {
  private audit: AuditLogger;
  private pendingApprovals = new Map<string, ApprovalRecord>();
  private rememberedGrants = new Map<string, RememberedGrant>();
  private readonly grantPath: string;
  private readonly grantKey?: Buffer;
  private grantStateHealthy = true;
  // Remembered approvals are enabled for app launches only, for 30 minutes by
  // default. Set JARVIS_REMEMBER_LAUNCH_MINUTES=0 to disable or 1-240 to choose
  // a duration. Grants are bound to the exact device, operation and app parameters.
  // All other state-changing operations continue to require fresh task-scoped approval.
  private readonly rememberedGrantTtlMs = PolicyGateway.readRememberTtlMs();

  private static readRememberTtlMs(): number {
    const raw = Number(process.env.JARVIS_REMEMBER_LAUNCH_MINUTES ?? '30');
    if (!Number.isFinite(raw) || raw < 1) return 0;
    return Math.min(Math.floor(raw), 240) * 60 * 1000;
  }

  // Explicit default-deny allowlist of supported operations
  private readonly rules: Map<string, PolicyRule> = new Map([
    // Read-only system info queries (LOW risk, no interactive approval needed)
    [
      'system:get_os_info',
      {
        operation: 'system:get_os_info',
        requiredPermission: Permission.SYSTEM_INFO_READ,
        riskTier: RiskTier.LOW,
        requiresApproval: false,
      },
    ],
    [
      'system:get_memory_info',
      {
        operation: 'system:get_memory_info',
        requiredPermission: Permission.SYSTEM_INFO_READ,
        riskTier: RiskTier.LOW,
        requiresApproval: false,
      },
    ],
    [
      'system:get_battery_status',
      {
        operation: 'system:get_battery_status',
        requiredPermission: Permission.SYSTEM_INFO_READ,
        riskTier: RiskTier.LOW,
        requiresApproval: false,
      },
    ],
    [
      'system:get_disk_space',
      {
        operation: 'system:get_disk_space',
        requiredPermission: Permission.SYSTEM_INFO_READ,
        riskTier: RiskTier.LOW,
        requiresApproval: false,
        allowedParameters: ['drive'],
      },
    ],
    // Selected Application Launch (MEDIUM risk, requires explicit task-scoped approval)
    [
      'app:launch',
      {
        operation: 'app:launch',
        requiredPermission: Permission.APP_LAUNCH,
        riskTier: RiskTier.MEDIUM,
        requiresApproval: true,
        allowedParameters: ['appId'],
      },
    ],
    ...[
      ['memory:save', ['category', 'content', 'ttlDays']],
      ['memory:update', ['id', 'content', 'expectedUpdatedAt']],
      ['memory:list', []],
      ['memory:delete', ['id']],
      ['desktop:launch_and_type', ['appId', 'text']],
      ['desktop:browser_search', ['appId', 'query']],
      ['desktop:save_and_verify', ['path', 'contains', 'expectProcess']],
      ['desktop:notepad_write_and_save', ['path', 'text']],
      ['desktop:type_text', ['text', 'expectProcess']],
      ['desktop:paste_text', ['text', 'expectProcess']],
      ['desktop:hotkey', ['keys', 'expectProcess']],
      ['desktop:zoom', ['direction', 'expectProcess']],
      ['desktop:copy_selection', ['expectProcess']],
      ['desktop:paste_clipboard', ['expectProcess']],
      ['desktop:inspect_window', ['expectProcess']],
      ['desktop:read_control', ['name', 'automationId', 'expectProcess']],
      ['desktop:click_control', ['name', 'automationId', 'expectProcess']],
      ['desktop:set_value', ['name', 'automationId', 'text', 'expectProcess']],
      ['desktop:set_toggle', ['name', 'automationId', 'state', 'expectProcess']],
    ].map(([operation, allowedParameters]) => [operation as string, {
      operation: operation as string,
      requiredPermission: (operation as string).startsWith('memory:') ? Permission.DEVICE_MANAGE : Permission.APP_LAUNCH,
      riskTier: operation === 'desktop:inspect_window' || operation === 'memory:list' ? RiskTier.LOW : RiskTier.HIGH,
      requiresApproval: !['desktop:inspect_window', 'memory:list'].includes(operation as string),
      allowedParameters: allowedParameters as string[],
    }] as [string, PolicyRule]),
    // Window discovery/focus, workspace files, terminal, and scheduling. Read-only
    // name listings need no approval; everything that reads content, changes state,
    // runs a process, or schedules future work requires a fresh single-use approval.
    ...([
      ['desktop:list_windows', Permission.APP_LAUNCH, RiskTier.LOW, false, []],
      ['desktop:focus_window', Permission.APP_LAUNCH, RiskTier.MEDIUM, true, ['processName', 'titleContains']],
      ['file:list', Permission.APP_LAUNCH, RiskTier.LOW, false, ['path']],
      ['file:search', Permission.APP_LAUNCH, RiskTier.LOW, false, ['query', 'path']],
      ['file:read', Permission.APP_LAUNCH, RiskTier.MEDIUM, true, ['path']],
      ['file:verify_saved', Permission.APP_LAUNCH, RiskTier.LOW, false, ['path', 'since', 'contains']],
      ['file:write', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['path', 'content']],
      ['file:edit', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['path', 'find', 'replace']],
      ['file:delete', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['path']],
      ['file:restore', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['quarantineId']],
      ['terminal:run', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['command', 'args', 'cwd']],
      ['schedule:create', Permission.DEVICE_MANAGE, RiskTier.HIGH, true, ['requestText', 'runAt', 'everyMinutes']],
      ['schedule:list', Permission.DEVICE_MANAGE, RiskTier.LOW, false, []],
      ['schedule:cancel', Permission.DEVICE_MANAGE, RiskTier.MEDIUM, true, ['id']],
      ['app:inventory', Permission.APP_LAUNCH, RiskTier.LOW, false, []],
      ['comms:handoff_email', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['to', 'cc', 'subject', 'body']],
      ['comms:unsupported', Permission.SYSTEM_INFO_READ, RiskTier.LOW, false, ['channel', 'reason']],
    ] as Array<[string, Permission, RiskTier, boolean, string[]]>).map(([operation, requiredPermission, riskTier, requiresApproval, allowedParameters]) => [operation, {
      operation,
      requiredPermission,
      riskTier,
      requiresApproval,
      allowedParameters,
    }] as [string, PolicyRule]),
    // Plugins and workflows (JARVIS-US-062). Owner-only. Installing, granting, enabling,
    // creating and approving need fresh approval; reducing access (disable/revoke) and
    // read-only listing do not. Running a workflow only expands its steps: every
    // expanded step is evaluated by this gateway and approved separately when required.
    ...([
      ['plugin:install', RiskTier.HIGH, true, ['path']],
      ['plugin:list', RiskTier.LOW, false, []],
      ['plugin:grant', RiskTier.HIGH, true, ['id', 'permissions']],
      ['plugin:revoke', RiskTier.LOW, false, ['id', 'permissions']],
      ['plugin:enable', RiskTier.MEDIUM, true, ['id']],
      ['plugin:disable', RiskTier.LOW, false, ['id']],
      ['plugin:uninstall', RiskTier.MEDIUM, true, ['id']],
      ['workflow:list', RiskTier.LOW, false, []],
      ['workflow:show', RiskTier.LOW, false, ['name']],
      ['workflow:history', RiskTier.LOW, false, ['name']],
      ['workflow:run', RiskTier.MEDIUM, false, ['name']],
      ['workflow:create', RiskTier.HIGH, true, ['name', 'description', 'steps']],
      ['workflow:draft_ai', RiskTier.LOW, false, ['name', 'goal']],
      ['workflow:approve_draft', RiskTier.HIGH, true, ['name']],
      ['workflow:archive', RiskTier.MEDIUM, true, ['name']],
      // Visual composer: explicit steps with dependencies, saved as a new active version.
      ['workflow:compose', RiskTier.HIGH, true, ['name', 'description', 'steps']],
      // Personal AI gateway site clients (J-E09). Issuing a key or widening a site's
      // limits/profile scope needs approval; listing and revoking (reducing access) do not.
      ['gateway:site_list', RiskTier.LOW, false, []],
      ['gateway:site_create', RiskTier.HIGH, true, ['name', 'limits', 'allowedProfiles']],
      ['gateway:site_update', RiskTier.MEDIUM, true, ['id', 'limits', 'allowedProfiles']],
      ['gateway:site_revoke', RiskTier.LOW, false, ['id']],
    ] as Array<[string, RiskTier, boolean, string[]]>).map(([operation, riskTier, requiresApproval, allowedParameters]) => [operation, {
      operation,
      requiredPermission: Permission.DEVICE_MANAGE,
      riskTier,
      requiresApproval,
      allowedParameters,
    }] as [string, PolicyRule]),
    // Developer assistant (JARVIS-US-063). Owner-only. Read-only intelligence and draft
    // suggestions run on repositories the owner explicitly connected with that scope;
    // connecting, applying, branching, committing and pushing need fresh approval.
    ...([
      ['dev:repo_connect', RiskTier.HIGH, true, ['name', 'path', 'scopes']],
      ['dev:repo_disconnect', RiskTier.MEDIUM, true, ['name']],
      ['dev:repo_list', RiskTier.LOW, false, []],
      ['dev:tree', RiskTier.LOW, false, ['repo', 'path']],
      ['dev:read', RiskTier.LOW, false, ['repo', 'path']],
      ['dev:grep', RiskTier.LOW, false, ['repo', 'query']],
      ['dev:git_status', RiskTier.LOW, false, ['repo']],
      ['dev:git_log', RiskTier.LOW, false, ['repo', 'count']],
      ['dev:git_diff', RiskTier.LOW, false, ['repo', 'staged']],
      ['dev:explain', RiskTier.LOW, false, ['repo', 'path', 'request']],
      ['dev:suggest_change', RiskTier.MEDIUM, false, ['repo', 'path', 'request']],
      ['dev:suggestion_list', RiskTier.LOW, false, ['repo']],
      ['dev:apply_suggestion', RiskTier.HIGH, true, ['repo', 'suggestionId']],
      ['dev:branch_create', RiskTier.HIGH, true, ['repo', 'branch']],
      ['dev:commit', RiskTier.HIGH, true, ['repo', 'message', 'suggestionId']],
      ['dev:push', RiskTier.HIGH, true, ['repo']],
      ['dev:pr_draft', RiskTier.LOW, false, ['repo', 'title']],
      ['dev:ci_status', RiskTier.LOW, false, ['repo']],
      // Opens a PR on GitHub (remote side effect): base dev only, fresh approval.
      ['dev:pr_create', RiskTier.HIGH, true, ['repo', 'title']],
      // Executes the repository's own build/lint/test/typecheck script: approval each time.
      ['dev:run_script', RiskTier.HIGH, true, ['repo', 'script']],
      ['dev:history', RiskTier.LOW, false, ['repo', 'count']],
      // Documentation drafts are stored as suggestions only, never written to files.
      ['dev:doc_suggest', RiskTier.LOW, false, ['repo', 'path', 'request']],
    ] as Array<[string, RiskTier, boolean, string[]]>).map(([operation, riskTier, requiresApproval, allowedParameters]) => [operation, {
      operation,
      requiredPermission: Permission.DEVICE_MANAGE,
      riskTier,
      requiresApproval,
      allowedParameters,
    }] as [string, PolicyRule]),
    ...['device:enrollment:create', 'device:enrollment:list', 'device:enrollment:approve', 'device:enrollment:reject', 'device:enrollment:cancel', 'device:list', 'security:totp:setup', 'security:totp:verify', 'security:totp:disable', 'device:revoke'].map((operation) => [operation, {
      operation,
      requiredPermission: Permission.DEVICE_MANAGE,
      riskTier: RiskTier.HIGH,
      requiresApproval: false,
    }] as [string, PolicyRule]),
    ['device:enrollment:exchange', { operation: 'device:enrollment:exchange', requiredPermission: Permission.SYSTEM_INFO_READ, riskTier: RiskTier.MEDIUM, requiresApproval: false }],
    ['device:self-revoke', { operation: 'device:self-revoke', requiredPermission: Permission.SYSTEM_INFO_READ, riskTier: RiskTier.HIGH, requiresApproval: false }],
  ]);

  constructor(audit: AuditLogger, grantPath = './data/approval-grants.json', ownerControlToken?: string) {
    this.audit = audit;
    this.grantPath = grantPath;
    if (ownerControlToken && ownerControlToken.length >= 32) {
      this.grantKey = createHmac('sha256', ownerControlToken).update('JARVIS-APPROVAL-GRANTS-V1').digest();
    }
    this.loadRememberedGrants();
  }

  private grantIdentity(grant: Pick<RememberedGrant, 'deviceId' | 'operation' | 'parametersHash'>): string {
    // Hash only the authorization scope; timestamps are metadata, not identity.
    return CryptoUtil.canonicalHash({
      deviceId: grant.deviceId,
      operation: grant.operation,
      parametersHash: grant.parametersHash,
    });
  }

  private loadRememberedGrants(): void {
    if (!this.grantKey || !existsSync(this.grantPath)) return;
    try {
      const envelope = JSON.parse(readFileSync(this.grantPath, 'utf8')) as { payload: string; mac: string };
      if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') throw new Error('Invalid approval grant envelope');
      const expected = createHmac('sha256', this.grantKey).update(envelope.payload).digest();
      const supplied = Buffer.from(envelope.mac, 'hex');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Approval grant integrity check failed');
      const parsed = JSON.parse(envelope.payload) as { grants?: RememberedGrant[] };
      if (!Array.isArray(parsed.grants)) throw new Error('Invalid approval grant state');
      for (const grant of parsed.grants) {
        if (!grant || typeof grant.deviceId !== 'string' || grant.operation !== 'app:launch' ||
            typeof grant.parametersHash !== 'string' || typeof grant.expiresAt !== 'number' ||
            grant.expiresAt <= Date.now()) continue;
        this.rememberedGrants.set(this.grantIdentity(grant), grant);
      }
    } catch {
      this.grantStateHealthy = false;
      this.audit.record('REMEMBERED_APPROVAL_STATE_INVALID', { reason: 'INTEGRITY_OR_FORMAT_FAILURE' });
    }
  }

  private persistRememberedGrants(): boolean {
    // Without the owner control secret, grants are intentionally session-local.
    if (!this.grantKey) return true;
    if (!this.grantStateHealthy) return false;
    const grants = Array.from(this.rememberedGrants.values()).filter((grant) => grant.expiresAt > Date.now());
    const payload = JSON.stringify({ version: 1, grants, persistedAt: Date.now() });
    const mac = createHmac('sha256', this.grantKey).update(payload).digest('hex');
    const temporaryPath = `${this.grantPath}.tmp-${CryptoUtil.randomToken(4)}`;
    try {
      mkdirSync(dirname(this.grantPath), { recursive: true });
      writeFileSync(temporaryPath, JSON.stringify({ payload, mac }), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, this.grantPath);
      return true;
    } catch {
      this.grantStateHealthy = false;
      this.audit.record('REMEMBERED_APPROVAL_PERSIST_FAILED', { reason: 'WRITE_FAILED' });
      return false;
    }
  }

  /**
   * Evaluates if a device request is allowed under current policy.
   */
  public evaluate(
    req: OperationRequest,
    device: DeviceRecord,
    taskId: TaskId,
    existingApprovalId?: string
  ): PolicyEvaluation {
    const rule = this.rules.get(req.operation);

    // Rule 1: Unknown operations are denied (Default-Deny)
    if (!rule) {
      this.audit.record(
        'POLICY_DENIED_UNKNOWN_OPERATION',
        { operation: req.operation },
        device.id,
        taskId
      );
      return {
        allowed: false,
        requiresApproval: false,
        riskTier: RiskTier.HIGH,
        reason: `Operation '${req.operation}' is not allowlisted`,
      };
    }

    // Rule 2: Device must possess required permission
    if (!device.permissions.includes(rule.requiredPermission)) {
      this.audit.record(
        'POLICY_DENIED_MISSING_PERMISSION',
        { operation: req.operation, required: rule.requiredPermission },
        device.id,
        taskId
      );
      return {
        allowed: false,
        requiresApproval: false,
        riskTier: rule.riskTier,
        reason: `Device missing permission '${rule.requiredPermission}'`,
      };
    }

    // Rule 3: Runtime inputs are untrusted even when TypeScript types say otherwise.
    // Reject malformed parameter containers before enumerating keys or hashing them.
    if (!req.parameters || typeof req.parameters !== 'object' || Array.isArray(req.parameters)) {
      this.audit.record('POLICY_DENIED_INVALID_PARAMETERS', { operation: req.operation, reason: 'PARAMETERS_NOT_OBJECT' }, device.id, taskId);
      return {
        allowed: false,
        requiresApproval: false,
        riskTier: rule.riskTier,
        reason: 'Operation parameters must be a plain object',
      };
    }

    // Rule 4: Validate parameters against allowed list
    if (rule.allowedParameters) {
      for (const param of Object.keys(req.parameters)) {
        if (!rule.allowedParameters.includes(param)) {
          this.audit.record(
            'POLICY_DENIED_INVALID_PARAMETER',
            { operation: req.operation, parameter: param },
            device.id,
            taskId
          );
          return {
            allowed: false,
            requiresApproval: false,
            riskTier: rule.riskTier,
            reason: `Disallowed parameter '${param}' for operation '${req.operation}'`,
          };
        }
      }
    }

    // Rule 4b: Payment and financial applications are always excluded. No approval can override this.
    const paymentParameter = findPaymentTarget(req.parameters as Record<string, unknown>);
    if (paymentParameter) {
      this.audit.record('POLICY_DENIED_PAYMENT_TARGET', { operation: req.operation, parameter: paymentParameter }, device.id, taskId);
      return {
        allowed: false,
        requiresApproval: false,
        riskTier: RiskTier.HIGH,
        reason: 'Payment and financial applications are excluded from automation by owner policy',
      };
    }

    // Rule 4: If approval is not required, evaluate as allowed
    if (!rule.requiresApproval) {
      return {
        allowed: true,
        requiresApproval: false,
        riskTier: rule.riskTier,
      };
    }

    // A prior owner approval may be remembered for this exact app/device/parameter
    // tuple. It never authorizes a different app or a different device.
    if (req.operation === 'app:launch' && !existingApprovalId && this.rememberedGrantTtlMs > 0) {
      if (!this.grantStateHealthy) {
        return { allowed: false, requiresApproval: true, riskTier: rule.riskTier, reason: 'Remembered approval state is unhealthy; fresh approval required' };
      }
      const parametersHash = CryptoUtil.canonicalHash(req.parameters);
      const grantKey = this.grantIdentity({ deviceId: device.id, operation: req.operation, parametersHash });
      const grant = this.rememberedGrants.get(grantKey);
      if (grant && grant.expiresAt > Date.now()) {
        this.audit.record('REMEMBERED_APPROVAL_REUSED', { operation: req.operation, expiresAt: grant.expiresAt }, device.id, taskId);
        return { allowed: true, requiresApproval: false, riskTier: rule.riskTier };
      }
      if (grant) this.rememberedGrants.delete(grantKey);
    }

    // Rule 5: Check if valid task-scoped approval exists
    if (existingApprovalId) {
      const approval = this.pendingApprovals.get(existingApprovalId);
      if (!approval) {
        // Unknown approval identifiers are untrusted input: record a bounded, non-secret trace.
        this.audit.record('POLICY_DENIED_APPROVAL_NOT_FOUND', { operation: req.operation, approvalIdPrefix: String(existingApprovalId).slice(0, 12) }, device.id, taskId);
      }
      if (!approval) {
        return {
          allowed: false,
          requiresApproval: true,
          riskTier: rule.riskTier,
          reason: 'Approval record not found',
        };
      }

      // Bind every approval to the exact task, requesting device, and operation.
      // A matching parameter hash alone is not sufficient: identical parameters
      // must never let an approval be replayed against another task or operation.
      if (approval.taskId !== taskId || approval.deviceId !== device.id || approval.operation !== req.operation) {
        this.audit.record('POLICY_DENIED_APPROVAL_BINDING_MISMATCH', {
          approvalId: approval.id,
          expectedTaskId: approval.taskId,
          requestedTaskId: taskId,
          expectedDeviceId: approval.deviceId,
          requestedDeviceId: device.id,
          expectedOperation: approval.operation,
          requestedOperation: req.operation,
        }, device.id, taskId);
        return {
          allowed: false,
          requiresApproval: false,
          riskTier: rule.riskTier,
          reason: 'Approval token is not bound to this task, device, and operation',
        };
      }

      if (approval.consumed || approval.rejected || Date.now() >= approval.expiresAt) {
        // Replay, rejected-approval reuse, and expired-approval reuse attempts must be auditable.
        const denialReason = approval.consumed ? 'ALREADY_CONSUMED' : approval.rejected ? 'REJECTED' : 'EXPIRED';
        this.audit.record('POLICY_DENIED_APPROVAL_UNUSABLE', { approvalId: approval.id, operation: req.operation, denialReason }, device.id, taskId);
      }

      if (approval.consumed) {
        return {
          allowed: false,
          requiresApproval: true,
          riskTier: rule.riskTier,
          reason: 'Approval token has already been consumed (single-use)',
        };
      }

      if (approval.rejected) {
        return {
          allowed: false,
          requiresApproval: true,
          riskTier: rule.riskTier,
          reason: 'Approval was explicitly rejected',
        };
      }

      if (Date.now() >= approval.expiresAt) {
        return {
          allowed: false,
          requiresApproval: true,
          riskTier: rule.riskTier,
          reason: 'Approval has expired',
        };
      }

      // Invariant: Scope check - parameter hash must match approved parameters
      const currentHash = CryptoUtil.canonicalHash(req.parameters);
      if (approval.parametersHash !== currentHash) {
        this.audit.record(
          'POLICY_DENIED_SCOPE_EXPANSION',
          { expectedHash: approval.parametersHash, actualHash: currentHash },
          device.id,
          taskId
        );
        return {
          allowed: false,
          requiresApproval: true,
          riskTier: rule.riskTier,
          reason: 'Task scope was modified after approval was granted',
        };
      }

      if (approval.approved) {
        // Mark approval as consumed for single-use execution
        approval.consumed = true;
        approval.consumedAt = Date.now();
        return {
          allowed: true,
          requiresApproval: false,
          riskTier: rule.riskTier,
          approvalId: approval.id,
        };
      }
    }

    // Requires new approval
    return {
      allowed: false,
      requiresApproval: true,
      riskTier: rule.riskTier,
      reason: 'Explicit owner/companion approval required for this operation',
    };
  }

  /**
   * Creates a pending approval request bound to task, device, operation, and parameters.
   */
  public createApprovalRequest(
    taskId: TaskId,
    deviceId: DeviceId,
    operation: string,
    parameters: Record<string, unknown>,
    riskTier: RiskTier,
    ttlSeconds: number = 300
  ): ApprovalRecord {
    const approvalId = `appr-${CryptoUtil.randomToken(16)}`;
    const parametersHash = CryptoUtil.canonicalHash(parameters);

    const record: ApprovalRecord = {
      id: approvalId,
      taskId,
      deviceId,
      operation,
      parametersHash,
      riskTier,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttlSeconds * 1000,
      approved: false,
    };

    this.pruneApprovals();
    this.pendingApprovals.set(approvalId, record);

    this.audit.record('APPROVAL_REQUESTED', {
      approvalId,
      taskId,
      operation,
      riskTier,
      expiresAt: record.expiresAt,
    }, deviceId, taskId);

    return record;
  }

  /**
   * Resolves an approval request with approval or rejection.
   */
  public resolveApproval(
    approvalId: string,
    approved: boolean,
    approverDeviceId: DeviceId
  ): { success: boolean; error?: string } {
    const approval = this.pendingApprovals.get(approvalId);
    if (!approval) {
      return { success: false, error: 'Approval request not found' };
    }

    if (Date.now() >= approval.expiresAt) {
      return { success: false, error: 'Approval request has expired' };
    }

    // Approval transitions are one-way: only a pending, unresolved request may
    // be approved or rejected. This prevents duplicate/concurrent resolution.
    if (approval.approved || approval.rejected || approval.consumed) {
      return { success: false, error: 'Approval request is no longer pending' };
    }

    // Remembered app-launch approvals default to 30 minutes (0 disables; 1-240
    // configures the duration), bound to this exact device and parameter hash.
    // Persist the grant before reporting approval success.
    if (approved && approval.operation === 'app:launch' && this.rememberedGrantTtlMs > 0) {
      const grant: RememberedGrant = {
        deviceId: approval.deviceId,
        operation: approval.operation,
        parametersHash: approval.parametersHash,
        createdAt: Date.now(),
        expiresAt: Date.now() + this.rememberedGrantTtlMs,
      };
      const key = this.grantIdentity(grant);
      const previous = this.rememberedGrants.get(key);
      this.rememberedGrants.set(key, grant);
      if (!this.persistRememberedGrants()) {
        if (previous) this.rememberedGrants.set(key, previous);
        else this.rememberedGrants.delete(key);
        return { success: false, error: 'Could not safely persist remembered approval; task remains unapproved' };
      }
    }

    approval.approved = approved;
    approval.rejected = !approved;

    this.audit.record(
      approved ? 'APPROVAL_GRANTED' : 'APPROVAL_REJECTED',
      { approvalId, approverDeviceId, taskId: approval.taskId },
      approverDeviceId,
      approval.taskId
    );

    return { success: true };
  }

  /**
   * Drops approval records that expired more than one hour ago so the in-memory
   * table stays bounded. Recently expired, consumed, or rejected records are kept
   * so replay attempts still receive an accurate denial reason and audit event.
   * A pruned approval is never usable: evaluate() reports it as not found.
   */
  public pruneApprovals(now: number = Date.now()): number {
    const retentionMs = 60 * 60 * 1000;
    let removed = 0;
    for (const [id, approval] of this.pendingApprovals) {
      if (approval.expiresAt + retentionMs < now) {
        this.pendingApprovals.delete(id);
        removed++;
      }
    }
    return removed;
  }

  /**
   * Immediately invalidate every unconsumed approval for a task (cancellation) or a
   * device (revocation). Invalidated approvals are marked rejected so they can never
   * authorize anything later, and each invalidation is audited.
   */
  public invalidateApprovals(filter: { taskId?: TaskId; deviceId?: DeviceId }, reason: string): number {
    let invalidated = 0;
    for (const approval of this.pendingApprovals.values()) {
      if (approval.consumed || approval.rejected) continue;
      if (filter.taskId !== undefined && approval.taskId !== filter.taskId) continue;
      if (filter.deviceId !== undefined && approval.deviceId !== filter.deviceId) continue;
      approval.rejected = true;
      approval.approved = false;
      invalidated++;
      this.audit.record('APPROVAL_INVALIDATED', { approvalId: approval.id, operation: approval.operation, reason }, approval.deviceId, approval.taskId);
    }
    if (filter.deviceId !== undefined) {
      for (const [key, grant] of this.rememberedGrants) {
        if (grant.deviceId === filter.deviceId) this.rememberedGrants.delete(key);
      }
      this.persistRememberedGrants();
    }
    return invalidated;
  }

  public getApproval(approvalId: string): ApprovalRecord | undefined {
    return this.pendingApprovals.get(approvalId);
  }

  /**
   * Read-only view of an allowlisted rule (used to validate plugin manifests and
   * workflow templates). Returns undefined for unknown operations or when any
   * parameter key falls outside the rule's allowlist.
   */
  /** Read-only list of allowlisted operations for owner UIs (workflow composer). */
  public listRules(): Array<{ operation: string; riskTier: RiskTier; requiresApproval: boolean; allowedParameters: string[] }> {
    return [...this.rules.values()].map((rule) => ({
      operation: rule.operation,
      riskTier: rule.riskTier,
      requiresApproval: rule.requiresApproval,
      allowedParameters: [...(rule.allowedParameters ?? [])],
    }));
  }

  public describeOperation(operation: string, parameterKeys: string[] = []): { riskTier: RiskTier; requiresApproval: boolean; allowedParameters: string[] } | undefined {
    const rule = this.rules.get(operation);
    if (!rule) return undefined;
    const allowed = rule.allowedParameters ?? [];
    if (parameterKeys.some((key) => !allowed.includes(key))) return undefined;
    return { riskTier: rule.riskTier, requiresApproval: rule.requiresApproval, allowedParameters: [...allowed] };
  }
}
