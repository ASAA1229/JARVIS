import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { TaskLifecycleRecord } from './service.js';
import { TaskState } from './types.js';

interface JournalPayload {
  version: 1;
  records: TaskLifecycleRecord[];
}
interface JournalEnvelope {
  version: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

const TERMINAL_STATES = new Set<TaskState>([
  TaskState.REJECTED,
  TaskState.EXPIRED,
  TaskState.CANCELLED,
  TaskState.COMPLETED,
  TaskState.PARTIAL,
  TaskState.FAILED,
  TaskState.INTERRUPTED,
]);
const MAX_RECORDS = 500;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Encrypted, atomic task checkpoint journal. On restart, any non-terminal task
 * is moved to AWAITING_RECOVERY and is never automatically resumed. Callers
 * must explicitly reconcile device/application state before deciding what to do.
 */
export class TaskJournal {
  private readonly keyMaterial: Buffer;
  private readonly records = new Map<string, TaskLifecycleRecord>();
  private healthy = true;

  constructor(private readonly filePath: string, ownerControlToken: string) {
    if (ownerControlToken.length < 32) {
      throw new Error('Task journal requires an owner control token of at least 32 characters.');
    }
    this.keyMaterial = scryptSync(ownerControlToken, 'JARVIS-TASK-JOURNAL-V1', 32);
    this.load();
  }

  save(record: TaskLifecycleRecord): void {
    if (!this.healthy) throw new Error('Task journal is unhealthy; persistence is fail-closed.');
    if (!this.isValidRecord(record)) throw new Error('Task checkpoint is invalid.');
    if (!this.records.has(record.id) && this.records.size >= MAX_RECORDS) {
      throw new Error('Task journal is full; prune terminal records before creating more tasks.');
    }
    const previous = this.records.get(record.id);
    this.records.set(record.id, this.clone(record));
    try {
      this.persist();
    } catch {
      // Keep the in-memory view aligned with the last durable checkpoint. Once
      // persistence fails, fail closed rather than accepting divergent writes.
      if (previous) this.records.set(record.id, previous);
      else this.records.delete(record.id);
      this.healthy = false;
      throw new Error('Task journal persistence failed; writes are disabled to avoid diverging from durable checkpoints.');
    }
  }

  get(taskId: string): TaskLifecycleRecord | undefined {
    const record = this.records.get(taskId);
    return record ? this.clone(record) : undefined;
  }

  list(): TaskLifecycleRecord[] {
    return [...this.records.values()].map((record) => this.clone(record));
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const raw = readFileSync(this.filePath);
      if (raw.byteLength > MAX_FILE_BYTES) throw new Error('Task journal exceeds size limit.');
      const envelope = JSON.parse(raw.toString('utf8')) as JournalEnvelope;
      if (envelope.version !== 1) throw new Error('Unsupported task journal format.');
      const salt = Buffer.from(envelope.salt, 'base64');
      const iv = Buffer.from(envelope.iv, 'base64');
      const tag = Buffer.from(envelope.tag, 'base64');
      const ciphertext = Buffer.from(envelope.ciphertext, 'base64');
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || ciphertext.length > MAX_FILE_BYTES) {
        throw new Error('Invalid task journal envelope.');
      }
      const key = scryptSync(this.keyMaterial, salt, 32);
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
      const payload = JSON.parse(plaintext) as JournalPayload;
      if (payload.version !== 1 || !Array.isArray(payload.records) || payload.records.length > MAX_RECORDS) {
        throw new Error('Invalid task journal payload.');
      }
      for (const record of payload.records) {
        if (!this.isValidRecord(record) || this.records.has(record.id)) throw new Error('Invalid or duplicate task checkpoint.');
        const restored = this.clone(record);
        if (!TERMINAL_STATES.has(restored.state)) {
          restored.state = TaskState.AWAITING_RECOVERY;
          restored.interrupted = true;
          restored.updatedAt = Date.now();
          restored.error = 'Process restarted before this workflow reached a terminal state. Reconcile external state before any retry; automatic resume is disabled.';
          restored.approvalId = undefined;
        }
        this.records.set(restored.id, restored);
      }
      if (payload.records.some((record) => !TERMINAL_STATES.has(record.state))) this.persist();
    } catch {
      this.healthy = false;
      this.records.clear();
      throw new Error('Task journal could not be decrypted or validated; writes are disabled to avoid overwriting checkpoints.');
    }
  }

  private isValidRecord(value: unknown): value is TaskLifecycleRecord {
    if (!value || typeof value !== 'object') return false;
    const r = value as Partial<TaskLifecycleRecord>;
    return typeof r.id === 'string' && r.id.length > 0 && r.id.length <= 160 &&
      typeof r.deviceId === 'string' && r.deviceId.length > 0 && r.deviceId.length <= 160 &&
      typeof r.requestText === 'string' && r.requestText.length <= 20_000 &&
      Object.values(TaskState).includes(r.state as TaskState) &&
      typeof r.createdAt === 'number' && Number.isFinite(r.createdAt) &&
      typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt) &&
      (r.steps === undefined || (Array.isArray(r.steps) && r.steps.length <= 500)) &&
      (r.operations === undefined || (Array.isArray(r.operations) && r.operations.length <= 100)) &&
      (r.reconciliation === undefined || (
        typeof r.reconciliation === 'object' && r.reconciliation !== null &&
        ['confirmed_no_effect', 'effect_observed', 'still_unknown'].includes(r.reconciliation.disposition) &&
        typeof r.reconciliation.note === 'string' && r.reconciliation.note.trim().length >= 8 &&
        r.reconciliation.note.length <= 500 &&
        typeof r.reconciliation.reviewedAt === 'number' && Number.isFinite(r.reconciliation.reviewedAt) &&
        typeof r.reconciliation.reviewedBy === 'string' && r.reconciliation.reviewedBy.length > 0 &&
        r.reconciliation.reviewedBy.length <= 160
      ));
  }

  private clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
  }

  private persist(): void {
    if (!this.healthy) throw new Error('Task journal is unhealthy; persistence is fail-closed.');
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(this.keyMaterial, salt, 32);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const payload: JournalPayload = { version: 1, records: [...this.records.values()] };
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
    const envelope: JournalEnvelope = {
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
    const encoded = JSON.stringify(envelope);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_FILE_BYTES) throw new Error('Task journal size limit exceeded.');
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = this.filePath + '.tmp-' + randomBytes(6).toString('hex');
    try {
      writeFileSync(temporary, encoded, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, this.filePath);
    } finally {
      try { unlinkSync(temporary); } catch { /* Atomic rename already consumed the temporary file. */ }
    }
  }
}
