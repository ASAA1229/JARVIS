import { CryptoUtil } from '../crypto/crypto.js';
import { AuditRecord, DeviceId, TaskId } from '../core/types.js';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class AuditLogger {
  private logFilePath: string;
  private lastHash: string = '0000000000000000000000000000000000000000000000000000000000000000';
  private records: AuditRecord[] = [];

  constructor(logFilePath: string = './data/audit.log') {
    this.logFilePath = logFilePath;
    this.init();
  }

  private init(): void {
    const dir = dirname(this.logFilePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    if (existsSync(this.logFilePath)) {
      const content = readFileSync(this.logFilePath, 'utf-8');
      const lines = content.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const rec: AuditRecord = JSON.parse(line);
          this.records.push(rec);
          this.lastHash = rec.hash;
        } catch {
          // If corrupted line, halt or flag
        }
      }
    }
  }

  public record(
    eventType: string,
    details: Record<string, unknown>,
    deviceId?: DeviceId,
    taskId?: TaskId
  ): AuditRecord {
    // Redact sensitive keys
    const sanitizedDetails = this.redactSecrets(details);

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

    this.records.push(record);
    this.lastHash = hash;

    // Persist to append-only log file
    try {
      appendFileSync(this.logFilePath, JSON.stringify(record) + '\n', 'utf-8');
    } catch {
      // In-memory fallback if file system write fails
    }

    return record;
  }

  public verifyIntegrity(): { valid: boolean; corruptedIndex?: number; reason?: string } {
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

  private redactSecrets(obj: Record<string, unknown>): Record<string, unknown> {
    const sensitiveKeys = ['secret', 'token', 'key', 'password', 'privateKey', 'auth', 'challenge'];
    const result: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(obj)) {
      if (sensitiveKeys.some((s) => k.toLowerCase().includes(s))) {
        result[k] = '[REDACTED]';
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        result[k] = this.redactSecrets(v as Record<string, unknown>);
      } else {
        result[k] = v;
      }
    }
    return result;
  }
}
