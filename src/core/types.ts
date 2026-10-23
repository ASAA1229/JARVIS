/**
 * Core type definitions and security interfaces for JARVIS.
 */

export type DeviceId = string;
export type SessionId = string;
export type TaskId = string;
export type ApprovalId = string;

export enum RiskTier {
  LOW = 'LOW', // Read-only, allowlisted, no side-effects
  MEDIUM = 'MEDIUM', // Interactive, app launch, resource usage
  HIGH = 'HIGH', // State modification (deferred/future)
  CRITICAL = 'CRITICAL', // Sensitive configuration/credentials (requires step-up)
}

export enum Permission {
  SYSTEM_INFO_READ = 'system:info:read',
  APP_LAUNCH = 'app:launch:execute',
  DEVICE_MANAGE = 'device:manage:execute',
}

export enum DeviceStatus {
  ENROLLED = 'ENROLLED',
  ACTIVE = 'ACTIVE',
  REVOKED = 'REVOKED',
}

export interface DeviceRecord {
  id: DeviceId;
  name: string;
  publicKey: string; // Ed25519 public key hex or base64
  status: DeviceStatus;
  permissions: Permission[];
  enrolledAt: number;
  revokedAt?: number;
  lastSeenAt: number;
}

export interface SessionRecord {
  id: SessionId;
  deviceId: DeviceId;
  createdAt: number;
  expiresAt: number;
  active: boolean;
}

export enum TaskState {
  CREATED = 'CREATED',
  AWAITING_APPROVAL = 'AWAITING_APPROVAL',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
  EXECUTING = 'EXECUTING',
  COMPLETED = 'COMPLETED',
  PARTIAL = 'PARTIAL',
  FAILED = 'FAILED',
  INTERRUPTED = 'INTERRUPTED',
  AWAITING_RECOVERY = 'AWAITING_RECOVERY',
}

export enum VerificationOutcome {
  VERIFIED_SUCCESS = 'VERIFIED_SUCCESS',
  VERIFIED_FAILURE = 'VERIFIED_FAILURE',
  PARTIAL_SUCCESS = 'PARTIAL_SUCCESS',
  UNCERTAIN = 'UNCERTAIN',
}

export interface OperationRequest {
  operation: string; // e.g., "system:get_os_info", "app:launch"
  parameters: Record<string, unknown>;
  targetResource?: string;
}

export interface ApprovalRecord {
  id: ApprovalId;
  taskId: TaskId;
  deviceId: DeviceId;
  operation: string;
  parametersHash: string; // Hash of parameters to prevent scope expansion
  riskTier: RiskTier;
  createdAt: number;
  expiresAt: number;
  approved: boolean;
  rejected?: boolean;
  consumed?: boolean;
  consumedAt?: number;
}

export interface PolicyEvaluation {
  allowed: boolean;
  requiresApproval: boolean;
  riskTier: RiskTier;
  reason?: string;
  approvalId?: ApprovalId;
}

export interface AuditRecord {
  index: number;
  timestamp: number;
  eventType: string; // "AUTH_SUCCESS", "POLICY_DENIED", "EXEC_START", etc.
  deviceId?: DeviceId;
  taskId?: TaskId;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export interface ExecutionResult {
  success: boolean;
  outcome: VerificationOutcome;
  data?: unknown;
  error?: string;
  evidence: Record<string, unknown>;
  interrupted?: boolean;
}
