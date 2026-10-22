import {
  DeviceRecord,
  DeviceStatus,
  DeviceId,
  Permission,
  SessionRecord,
  SessionId,
} from '../core/types.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { AuditLogger } from '../audit/audit.js';

export interface EnrollmentChallenge {
  challengeToken: string;
  expiresAt: number;
  redeemed: boolean;
  assignedPermissions: Permission[];
}

export class DeviceIdentityManager {
  private devices = new Map<DeviceId, DeviceRecord>();
  private sessions = new Map<SessionId, SessionRecord>();
  private challenges = new Map<string, EnrollmentChallenge>();
  private audit: AuditLogger;

  constructor(audit: AuditLogger) {
    this.audit = audit;
  }

  /**
   * Generates a short-lived single-use enrollment challenge (default TTL: 120s).
   */
  public createEnrollmentChallenge(
    permissions: Permission[] = [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH],
    ttlSeconds: number = 120
  ): { challengeToken: string; expiresAt: number } {
    const challengeToken = CryptoUtil.randomToken(16);
    const expiresAt = Date.now() + ttlSeconds * 1000;

    this.challenges.set(challengeToken, {
      challengeToken,
      expiresAt,
      redeemed: false,
      assignedPermissions: permissions,
    });

    this.audit.record('ENROLLMENT_CHALLENGE_CREATED', {
      expiresAt,
      permissions,
    });

    return { challengeToken, expiresAt };
  }

  /**
   * Redeems an enrollment challenge to register a new companion device.
   */
  public enrollDevice(
    challengeToken: string,
    deviceName: string,
    publicKeyPem: string
  ): { success: boolean; deviceId?: DeviceId; error?: string } {
    const challenge = this.challenges.get(challengeToken);

    if (!challenge) {
      this.audit.record('ENROLLMENT_FAILED', { reason: 'UNKNOWN_CHALLENGE' });
      return { success: false, error: 'Invalid or unknown challenge' };
    }

    if (challenge.redeemed) {
      this.audit.record('ENROLLMENT_FAILED', { reason: 'CHALLENGE_ALREADY_REDEEMED' });
      return { success: false, error: 'Challenge already redeemed' };
    }

    if (Date.now() > challenge.expiresAt) {
      this.audit.record('ENROLLMENT_FAILED', { reason: 'CHALLENGE_EXPIRED' });
      return { success: false, error: 'Challenge has expired' };
    }

    // Mark challenge as consumed immediately
    challenge.redeemed = true;

    const deviceId = `dev-${CryptoUtil.sha256(publicKeyPem).substring(0, 16)}`;
    const now = Date.now();

    const deviceRecord: DeviceRecord = {
      id: deviceId,
      name: deviceName,
      publicKey: publicKeyPem,
      status: DeviceStatus.ACTIVE,
      permissions: challenge.assignedPermissions,
      enrolledAt: now,
      lastSeenAt: now,
    };

    this.devices.set(deviceId, deviceRecord);

    this.audit.record(
      'DEVICE_ENROLLED',
      {
        deviceId,
        name: deviceName,
        permissions: deviceRecord.permissions,
      },
      deviceId
    );

    return { success: true, deviceId };
  }

  /**
   * Creates an active session for an enrolled, active device.
   */
  public createSession(
    deviceId: DeviceId,
    signature: string,
    timestamp: number,
    ttlSeconds: number = 3600
  ): { success: boolean; sessionId?: SessionId; expiresAt?: number; error?: string } {
    const device = this.devices.get(deviceId);
    if (!device) {
      this.audit.record('SESSION_CREATION_FAILED', { reason: 'DEVICE_NOT_FOUND', deviceId });
      return { success: false, error: 'Device not registered' };
    }

    if (device.status === DeviceStatus.REVOKED) {
      this.audit.record('SESSION_CREATION_FAILED', { reason: 'DEVICE_REVOKED', deviceId });
      return { success: false, error: 'Device is revoked' };
    }

    // Verify freshness (within 60 seconds)
    if (Math.abs(Date.now() - timestamp) > 60000) {
      this.audit.record('SESSION_CREATION_FAILED', { reason: 'TIMESTAMP_STALE', deviceId });
      return { success: false, error: 'Timestamp is stale or invalid' };
    }

    // Verify cryptographic signature
    const isValid = CryptoUtil.verifySignature(`SESSION_REQUEST:${timestamp}`, signature, device.publicKey);
    if (!isValid) {
      this.audit.record('SESSION_CREATION_FAILED', { reason: 'INVALID_SIGNATURE', deviceId });
      return { success: false, error: 'Signature verification failed' };
    }

    const sessionId = `sess-${CryptoUtil.randomToken(16)}`;
    const expiresAt = Date.now() + ttlSeconds * 1000;

    const session: SessionRecord = {
      id: sessionId,
      deviceId,
      createdAt: Date.now(),
      expiresAt,
      active: true,
    };

    this.sessions.set(sessionId, session);
    device.lastSeenAt = Date.now();

    this.audit.record('SESSION_CREATED', { sessionId, expiresAt }, deviceId);

    return { success: true, sessionId, expiresAt };
  }

  /**
   * Validates whether an incoming request from a device is authentic and not revoked.
   */
  public validateDeviceSession(sessionId: SessionId): { valid: boolean; device?: DeviceRecord; error?: string } {
    const session = this.sessions.get(sessionId);
    if (!session || !session.active) {
      return { valid: false, error: 'Session does not exist or is inactive' };
    }

    if (Date.now() > session.expiresAt) {
      session.active = false;
      return { valid: false, error: 'Session expired' };
    }

    const device = this.devices.get(session.deviceId);
    if (!device || device.status === DeviceStatus.REVOKED) {
      session.active = false;
      return { valid: false, error: 'Device revoked or missing' };
    }

    device.lastSeenAt = Date.now();
    return { valid: true, device };
  }

  /**
   * Immediately revokes a device and terminates its active sessions.
   */
  public revokeDevice(deviceId: DeviceId, reason: string = 'Owner initiated'): boolean {
    const device = this.devices.get(deviceId);
    if (!device) return false;

    device.status = DeviceStatus.REVOKED;
    device.revokedAt = Date.now();

    // Terminate all sessions for this device immediately
    for (const session of this.sessions.values()) {
      if (session.deviceId === deviceId) {
        session.active = false;
      }
    }

    this.audit.record('DEVICE_REVOKED', { reason }, deviceId);
    return true;
  }

  public getDevice(deviceId: DeviceId): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  public listDevices(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }
}
