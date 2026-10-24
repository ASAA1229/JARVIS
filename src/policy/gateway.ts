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
  private readonly rememberedGrantTtlMs = 30 * 24 * 60 * 60 * 1000;

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
    ...['device:enrollment:create', 'device:enrollment:list', 'device:enrollment:approve', 'device:enrollment:reject', 'device:enrollment:cancel', 'device:list', 'security:totp:setup', 'security:totp:verify', 'security:totp:disable', 'device:revoke'].map((operation) => [operation, {
      operation,
      requiredPermission: Permission.DEVICE_MANAGE,
      riskTier: RiskTier.HIGH,
      requiresApproval: false,
    }] as [string, PolicyRule]),
    ['device:enrollment:exchange', { operation: 'device:enrollment:exchange', requiredPermission: Permission.SYSTEM_INFO_READ, riskTier: RiskTier.MEDIUM, requiresApproval: false }],
    ['device:self-revoke', { operation: 'device:self-revoke', requiredPermission: Permission.SYSTEM_INFO_READ, riskTier: RiskTier.HIGH, requiresApproval: false }],
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
    return CryptoUtil.canonicalHash(grant);
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

    // Rule 3: Validate parameters against allowed list
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
    if (req.operation === 'app:launch') {
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
        return {
          allowed: false,
          requiresApproval: true,
          riskTier: rule.riskTier,
          reason: 'Approval record not found',
        };
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

      if (Date.now() > approval.expiresAt) {
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

    if (Date.now() > approval.expiresAt) {
      return { success: false, error: 'Approval request has expired' };
    }

    // Approval transitions are one-way: only a pending, unresolved request may
    // be approved or rejected. This prevents duplicate/concurrent resolution.
    if (approval.approved || approval.rejected || approval.consumed) {
      return { success: false, error: 'Approval request is no longer pending' };
    }

    // App launch approval is remembered for this exact requesting device and
    // exact parameter hash for 30 days. Persist it before reporting success.
    if (approved && approval.operation === 'app:launch') {
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

  public getApproval(approvalId: string): ApprovalRecord | undefined {
    return this.pendingApprovals.get(approvalId);
  }
}
