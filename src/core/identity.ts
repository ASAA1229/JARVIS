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

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

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
  private stateFilePath?: string;
  private stateHealthy = true;
  private stateError?: string;

  constructor(audit: AuditLogger, stateFilePath?: string) {
    this.audit = audit;
    this.stateFilePath = stateFilePath;
    this.loadState();
  }

  private loadState(): void {
    if (!this.stateFilePath || !existsSync(this.stateFilePath)) return;
    try {
      const data: unknown = JSON.parse(readFileSync(this.stateFilePath, 'utf-8'));
      if (!data || typeof data !== 'object' || !Array.isArray((data as { devices?: unknown }).devices)) {
        throw new Error('Invalid persisted device state shape');
      }
      for (const raw of (data as { devices: unknown[] }).devices) {
        if (!raw || typeof raw !== 'object') throw new Error('Invalid persisted device record');
        const dev = raw as DeviceRecord;
        if (typeof dev.id !== 'string' || typeof dev.publicKey !== 'string' ||
            !Array.isArray(dev.permissions) || !Object.values(DeviceStatus).includes(dev.status)) {
          throw new Error('Invalid persisted device record');
        }
        this.devices.set(dev.id, dev);
      }
    } catch {
      this.stateHealthy = false;
      this.stateError = 'PERSISTED_DEVICE_STATE_INVALID';
      this.audit.record('DEVICE_STATE_LOAD_FAILED', { reason: this.stateError });
    }
  }

  private persistState(): boolean {
    if (!this.stateFilePath) return true;
    const temporaryPath = `${this.stateFilePath}.tmp-${CryptoUtil.randomToken(4)}`;
    try {
      const dir = dirname(this.stateFilePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = {
        devices: Array.from(this.devices.values()),
        persistedAt: Date.now(),
      };
      writeFileSync(temporaryPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
      renameSync(temporaryPath, this.stateFilePath);
      this.stateHealthy = true;
      this.stateError = undefined;
      return true;
    } catch {
      this.stateHealthy = false;
      this.stateError = 'PERSISTED_DEVICE_STATE_WRITE_FAILED';
      this.audit.record('DEVICE_STATE_PERSIST_FAILED', { reason: this.stateError });
      return false;
    }
  }

  public isStateHealthy(): boolean {
    return this.stateHealthy;
  }

  public getStateError(): string | undefined {
    return this.stateError;
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
    if (!this.stateHealthy) return { success: false, error: 'Device state is unhealthy; enrollment is blocked' };
    if (typeof deviceName !== 'string' || !deviceName.trim() || deviceName.length > 80) {
      return { success: false, error: 'Device name must be 1-80 characters' };
    }
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

    if (!CryptoUtil.isValidEd25519PublicKey(publicKeyPem)) {
      this.audit.record('ENROLLMENT_FAILED', { reason: 'INVALID_PUBLIC_KEY_FORMAT' });
      return { success: false, error: 'Invalid or malformed public key' };
    }

    // Mark challenge as consumed immediately
    challenge.redeemed = true;

    const deviceId = `dev-${CryptoUtil.sha256(publicKeyPem).substring(0, 16)}`;
    const existingDevice = this.devices.get(deviceId);
    if (existingDevice) {
      this.audit.record('ENROLLMENT_FAILED', { reason: 'DUPLICATE_PUBLIC_KEY', deviceId });
      return { success: false, error: 'This public key is already enrolled' };
    }
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
    if (!this.persistState()) {
      this.devices.delete(deviceId);
      return { success: false, error: 'Could not persist device enrollment; enrollment was not completed' };
    }

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
    if (!this.stateHealthy) return { success: false, error: 'Device state is unhealthy; session creation is blocked' };
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

    const persisted = this.persistState();
    this.audit.record('DEVICE_REVOKED', { reason, persisted }, deviceId);
    return persisted;
  }

  public getDevice(deviceId: DeviceId): DeviceRecord | undefined {
    return this.devices.get(deviceId);
  }

  public listDevices(): DeviceRecord[] {
    return Array.from(this.devices.values());
  }
}
