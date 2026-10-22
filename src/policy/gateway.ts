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
import { CryptoUtil } from '../crypto/crypto.js';
import { AuditLogger } from '../audit/audit.js';

interface PolicyRule {
  operation: string;
  requiredPermission: Permission;
  riskTier: RiskTier;
  requiresApproval: boolean;
  allowedParameters?: string[];
}

export class PolicyGateway {
  private audit: AuditLogger;
  private pendingApprovals = new Map<string, ApprovalRecord>();

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
  ]);

  constructor(audit: AuditLogger) {
    this.audit = audit;
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

    // Rule 5: Check if valid approval exists
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
