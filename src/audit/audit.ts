import { CryptoUtil } from '../crypto/crypto.js';
import { AuditRecord, DeviceId, TaskId } from '../core/types.js';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type PublicAuditRecord = Omit<AuditRecord, 'prevHash' | 'hash'>;

export class AuditLogger {
  private logFilePath: string;
  private lastHash: string = '0000000000000000000000000000000000000000000000000000000000000000';
  private records: AuditRecord[] = [];
  private failureReason?: string;

  constructor(logFilePath: string = './data/audit.log') {
    this.logFilePath = logFilePath;
    this.init();
  }

  private init(): void {
    const dir = dirname(this.logFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (!existsSync(this.logFilePath)) return;

    let content: string;
    try {
      content = readFileSync(this.logFilePath, 'utf-8');
    } catch {
      this.failClosed('AUDIT_LOG_READ_FAILED');
      return;
    }
    if (!content) return;
    if (!content.endsWith('\n')) {
      this.failClosed('AUDIT_LOG_TRUNCATED');
      return;
    }

    const lines = content.slice(0, -1).split('\n');
    for (let index = 0; index < lines.length; index++) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(lines[index]);
      } catch {
        this.failClosed(`AUDIT_LOG_INVALID_JSON_AT_LINE_${index + 1}`);
        return;
      }
      if (!this.isAuditRecord(parsed)) {
        this.failClosed(`AUDIT_LOG_INVALID_RECORD_AT_LINE_${index + 1}`);
        return;
      }
      this.records.push(parsed);
    }

    const integrity = this.verifyRecordsIntegrity();
    if (!integrity.valid) {
      this.failClosed(integrity.reason || 'AUDIT_LOG_INTEGRITY_FAILURE');
      return;
    }
    if (this.records.length > 0) this.lastHash = this.records[this.records.length - 1].hash;
  }

  public record(
    eventType: string,
    details: Record<string, unknown>,
    deviceId?: DeviceId,
    taskId?: TaskId
  ): AuditRecord {
    if (this.failureReason) {
      throw new Error(`Audit log is unhealthy: ${this.failureReason}`);
    }
    const currentIntegrity = this.verifyIntegrity();
    if (!currentIntegrity.valid) {
      throw new Error(`Audit log is unhealthy: ${currentIntegrity.reason}`);
    }

    const sanitizedDetails = this.redactSecrets(details) as Record<string, unknown>;

    const index = this.records.length;
    const timestamp = Date.now();
    const prevHash = this.lastHash;

    const payloadToHash = `${index}:${timestamp}:${eventType}:${deviceId ?? ''}:${taskId ?? ''}:${JSON.stringify(
      sanitizedDetails
    )}:${prevHash}`;
    const hash = CryptoUtil.sha256(payloadToHash);

    const record: AuditRecord = {
      index,
      timestamp,
      eventType,
      deviceId,
      taskId,
      details: sanitizedDetails,
      prevHash,
      hash,
    };

    try {
      appendFileSync(this.logFilePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch (error) {
      this.failClosed('AUDIT_LOG_WRITE_FAILED');
      throw new Error('Audit log persistence failed; further operations are blocked', { cause: error });
    }

    this.records.push(record);
    this.lastHash = hash;
    return record;
  }

  public verifyIntegrity(): { valid: boolean; corruptedIndex?: number; reason?: string } {
    if (this.failureReason) return { valid: false, reason: this.failureReason };
    const recordsIntegrity = this.verifyRecordsIntegrity();
    if (!recordsIntegrity.valid) {
      this.failClosed(recordsIntegrity.reason || 'AUDIT_LOG_INTEGRITY_FAILURE');
      return { ...recordsIntegrity, reason: this.failureReason };
    }

    let persisted = '';
    try {
      if (existsSync(this.logFilePath)) persisted = readFileSync(this.logFilePath, 'utf-8');
    } catch {
      this.failClosed('AUDIT_LOG_READ_FAILED');
      return { valid: false, reason: this.failureReason };
    }
    const expected = this.records.map((record) => JSON.stringify(record)).join('\n');
    const expectedContent = expected ? `${expected}\n` : '';
    if (persisted !== expectedContent) {
      this.failClosed('AUDIT_LOG_CONTENT_MISMATCH');
      return { valid: false, reason: this.failureReason };
    }
    return { valid: true };
  }

  private verifyRecordsIntegrity(): { valid: boolean; corruptedIndex?: number; reason?: string } {
    let expectedPrevHash = '0000000000000000000000000000000000000000000000000000000000000000';
    for (let i = 0; i < this.records.length; i++) {
      const rec = this.records[i];
      if (rec.index !== i) {
        return { valid: false, corruptedIndex: i, reason: `Index mismatch: expected ${i}, found ${rec.index}` };
      }
      if (rec.prevHash !== expectedPrevHash) {
        return { valid: false, corruptedIndex: i, reason: `PrevHash mismatch at index ${i}` };
      }
      const payloadToHash = `${rec.index}:${rec.timestamp}:${rec.eventType}:${rec.deviceId ?? ''}:${rec.taskId ?? ''}:${JSON.stringify(
        rec.details
      )}:${rec.prevHash}`;
      const computedHash = CryptoUtil.sha256(payloadToHash);
      if (computedHash !== rec.hash) {
        return { valid: false, corruptedIndex: i, reason: `Hash corruption at index ${i}` };
      }
      expectedPrevHash = rec.hash;
    }
    return { valid: true };
  }

  public getRecords(): readonly AuditRecord[] {
    return this.records;
  }

  public getPublicRecords(): readonly PublicAuditRecord[] {
    return this.records.map(({ hash, prevHash, ...record }) => ({
      ...record,
      details: this.redactSecrets(record.details) as Record<string, unknown>,
    }));
  }

  private isAuditRecord(value: unknown): value is AuditRecord {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Partial<AuditRecord>;
    return Number.isInteger(record.index) &&
      typeof record.timestamp === 'number' &&
      typeof record.eventType === 'string' &&
      !!record.details && typeof record.details === 'object' && !Array.isArray(record.details) &&
      typeof record.prevHash === 'string' &&
      typeof record.hash === 'string';
  }

  /** Optional listener, called once when the log first fails closed (reason is an internal code). */
  public onFailClosed?: (reason: string) => void;

  /** Internal failure code when the audit log has failed closed, else undefined. */
  public getFailureReason(): string | undefined {
    return this.failureReason;
  }

  private failClosed(reason: string): void {
    const first = this.failureReason === undefined;
    this.failureReason ??= reason;
    if (first && this.onFailClosed) {
      try { this.onFailClosed(reason); } catch { /* a listener must never affect audit behaviour */ }
    }
  }

  private redactSecrets(value: unknown, fieldName = ''): unknown {
    const normalizedFieldName = fieldName.toLowerCase().replace(/[^a-z]/g, '');
    const sensitiveFields = [
      'secret',
      'token',
      'privatekey',
      'password',
      'passphrase',
      'auth',
      'challenge',
      'signature',
      'session',
      'requesttext',
      'prompt',
      'transcript',
      'message',
      'content',
    ];
    if (sensitiveFields.some((field) => normalizedFieldName.includes(field))) {
      return '[REDACTED]';
    }

    if (Array.isArray(value)) return value.map((item) => this.redactSecrets(item));
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [key, this.redactSecrets(nested, key)])
      );
    }
    if (typeof value === 'string') {
      return value
        .replace(/-----BEGIN (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:ENCRYPTED |RSA |EC |OPENSSH )?PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]');
    }
    return value;
  }
}
