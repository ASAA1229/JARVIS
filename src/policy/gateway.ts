import { findPaymentTarget } from './exclusions.js';
import { TOOL_REGISTRY, validateToolParameters, type PolicyRule } from './toolRegistry.js';
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
  /** Pending (undecided) approvals survive restart in an HMAC-protected sibling file (D2.18). */
  private readonly pendingPath: string;
  private readonly pendingKey?: Buffer;
  private pendingStateHealthy = true;
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

  private readonly rules: ReadonlyMap<string, PolicyRule> = TOOL_REGISTRY;

  constructor(audit: AuditLogger, grantPath = './data/approval-grants.json', ownerControlToken?: string) {
    this.audit = audit;
    this.grantPath = grantPath;
    if (ownerControlToken && ownerControlToken.length >= 32) {
      this.grantKey = createHmac('sha256', ownerControlToken).update('JARVIS-APPROVAL-GRANTS-V1').digest();
      this.pendingKey = createHmac('sha256', ownerControlToken).update('JARVIS-PENDING-APPROVALS-V1').digest();
    }
    this.pendingPath = `${grantPath}.pending`;
    this.loadRememberedGrants();
    this.loadPendingApprovals();
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
   * Recover approvals that were still waiting for a human decision when the process stopped.
   * Recovery is strictly conservative: only undecided, unexpired approvals come back, and they
   * come back undecided. Anything already approved, rejected, consumed or expired is dropped, so
   * a restart can never turn into an approval and a stale request can never be approved late.
   */
  private loadPendingApprovals(): void {
    if (!this.pendingKey || !existsSync(this.pendingPath)) return;
    try {
      const envelope = JSON.parse(readFileSync(this.pendingPath, 'utf8')) as { payload: string; mac: string };
      if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') throw new Error('Invalid pending approval envelope');
      const expected = createHmac('sha256', this.pendingKey).update(envelope.payload).digest();
      const supplied = Buffer.from(envelope.mac, 'hex');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Pending approval integrity check failed');
      const parsed = JSON.parse(envelope.payload) as { approvals?: ApprovalRecord[] };
      if (!Array.isArray(parsed.approvals) || parsed.approvals.length > 500) throw new Error('Invalid pending approval state');
      const now = Date.now();
      let recovered = 0;
      let dropped = 0;
      for (const item of parsed.approvals) {
        const valid = item && typeof item.id === 'string' && typeof item.taskId === 'string' && typeof item.deviceId === 'string' &&
          typeof item.operation === 'string' && typeof item.parametersHash === 'string' && typeof item.expiresAt === 'number' &&
          typeof item.createdAt === 'number' && Object.values(RiskTier).includes(item.riskTier);
        if (!valid || item.approved || item.rejected || item.consumed || item.expiresAt <= now) { dropped++; continue; }
        this.pendingApprovals.set(item.id, { ...item, approved: false });
        recovered++;
      }
      try { this.audit.record('PENDING_APPROVALS_RECOVERED', { recovered, dropped }); } catch { /* recovery stays conservative without audit */ }
      if (dropped > 0) this.persistPendingApprovals();
    } catch {
      this.pendingStateHealthy = false;
      try { this.audit.record('PENDING_APPROVAL_STATE_INVALID', { reason: 'INTEGRITY_OR_FORMAT_FAILURE' }); } catch { /* fail closed */ }
    }
  }

  /** Best-effort durable copy of undecided approvals. A failure never grants anything. */
  private persistPendingApprovals(): boolean {
    if (!this.pendingKey) return true;
    const now = Date.now();
    const approvals = Array.from(this.pendingApprovals.values())
      .filter((item) => !item.approved && !item.rejected && !item.consumed && item.expiresAt > now);
    const payload = JSON.stringify({ version: 1, approvals, persistedAt: now });
    const mac = createHmac('sha256', this.pendingKey).update(payload).digest('hex');
    const temporaryPath = `${this.pendingPath}.tmp-${CryptoUtil.randomToken(4)}`;
    try {
      mkdirSync(dirname(this.pendingPath), { recursive: true });
      writeFileSync(temporaryPath, JSON.stringify({ payload, mac }), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporaryPath, this.pendingPath);
      this.pendingStateHealthy = true;
      return true;
    } catch {
      this.pendingStateHealthy = false;
      try { this.audit.record('PENDING_APPROVAL_PERSIST_FAILED', { reason: 'WRITE_FAILED' }); } catch { /* ignore */ }
      return false;
    }
  }

  /** Approvals that are still waiting for a human decision (used by startup reconciliation). */
  public listUndecidedApprovals(): ApprovalRecord[] {
    return Array.from(this.pendingApprovals.values()).filter((item) => !item.approved && !item.rejected && !item.consumed);
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

    // Rule 4a: declared parameter types (E:D4.6).
    const typeProblem = validateToolParameters(req.operation, req.parameters);
    if (typeProblem) {
      this.audit.record('POLICY_DENIED_INVALID_PARAMETER_TYPE', { operation: req.operation, reason: typeProblem.slice(0, 120) }, device.id, taskId);
      return { allowed: false, requiresApproval: false, riskTier: rule.riskTier, reason: typeProblem };
    }

    // Rule 4b: Payment and financial applications are always excluded. No approval can override this.
    const paymentParameter = findPaymentTarget(req.parameters as Record<string, unknown>, req.operation);
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
        this.persistPendingApprovals();
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
    this.persistPendingApprovals();

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
    this.persistPendingApprovals();

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
    if (removed > 0) this.persistPendingApprovals();
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
    if (invalidated > 0) this.persistPendingApprovals();
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
