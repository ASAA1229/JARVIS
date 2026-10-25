import { createHmac, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { AuditLogger } from '../audit/audit.js';
import { CryptoUtil } from '../crypto/crypto.js';

/**
 * Scheduled and recurring requests.
 *
 * A job stores only WHAT the owner asked for (plain request text) and WHO owns
 * it. It stores no approval, no session and no permission. When a job fires, the
 * runner re-submits the text through the normal core pipeline as the owning
 * device, so planning, the PolicyGateway, current device permissions, and a brand
 * new single-use approval for anything state-changing all apply at run time.
 *
 * Delivery is at-most-once: the next run time is persisted before the runner is
 * called, and runs missed while the service was down are marked MISSED instead of
 * being replayed. Jobs are persisted with an HMAC only when an owner control
 * token is configured; otherwise they are session-local and disappear on restart.
 */

export interface ScheduledJob {
  id: string;
  ownerDeviceId: string;
  requestText: string;
  runAt: number;
  everyMinutes?: number;
  createdAt: number;
  active: boolean;
  runCount: number;
  lastRunAt?: number;
  lastTaskId?: string;
  lastState?: string;
}

export interface JobRunResult {
  taskId?: string;
  state: string;
}

export type JobRunner = (job: ScheduledJob) => Promise<JobRunResult>;

const MAX_ACTIVE_JOBS_PER_DEVICE = 20;
const MAX_LEAD_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_LEAD_MS = 30 * 1000;
const MISSED_GRACE_MS = 60 * 60 * 1000;

export class Scheduler {
  private readonly jobs = new Map<string, ScheduledJob>();
  private readonly inFlight = new Set<string>();
  private readonly key?: Buffer;
  private timer?: NodeJS.Timeout;
  private persistHealthy = true;

  constructor(
    private readonly audit: AuditLogger,
    private readonly runner: JobRunner,
    private readonly persistPath?: string,
    ownerControlToken?: string,
  ) {
    if (ownerControlToken && ownerControlToken.length >= 32) {
      this.key = createHmac('sha256', ownerControlToken).update('JARVIS-SCHEDULE-V1').digest();
    }
    this.load();
  }

  public get healthy(): boolean {
    return this.persistHealthy;
  }

  public get activeCount(): number {
    return Array.from(this.jobs.values()).filter((job) => job.active).length;
  }

  public create(ownerDeviceId: string, requestText: unknown, runAt: unknown, everyMinutes?: unknown): { ok: true; job: ScheduledJob } | { ok: false; error: string } {
    if (typeof requestText !== 'string' || requestText.trim().length < 1 || requestText.length > 500) return { ok: false, error: 'Request text must contain 1-500 characters.' };
    const when = typeof runAt === 'number' ? runAt : Number(runAt);
    const now = Date.now();
    if (!Number.isFinite(when) || when < now + MIN_LEAD_MS || when > now + MAX_LEAD_MS) return { ok: false, error: 'Run time must be between 30 seconds and 30 days from now.' };
    let every: number | undefined;
    if (everyMinutes !== undefined && everyMinutes !== null && everyMinutes !== '') {
      every = Number(everyMinutes);
      if (!Number.isInteger(every) || every < 5 || every > 10_080) return { ok: false, error: 'Repeat interval must be a whole number of minutes from 5 to 10080.' };
    }
    const owned = Array.from(this.jobs.values()).filter((job) => job.active && job.ownerDeviceId === ownerDeviceId).length;
    if (owned >= MAX_ACTIVE_JOBS_PER_DEVICE) return { ok: false, error: `This device already has ${MAX_ACTIVE_JOBS_PER_DEVICE} active schedules.` };
    const job: ScheduledJob = {
      id: `job-${CryptoUtil.randomToken(8)}`,
      ownerDeviceId,
      requestText: requestText.trim(),
      runAt: Math.floor(when),
      everyMinutes: every,
      createdAt: now,
      active: true,
      runCount: 0,
    };
    this.jobs.set(job.id, job);
    if (!this.persist()) {
      this.jobs.delete(job.id);
      return { ok: false, error: 'The schedule could not be stored safely, so it was not created.' };
    }
    this.audit.record('SCHEDULE_CREATED', { jobId: job.id, runAt: job.runAt, everyMinutes: job.everyMinutes, requestLength: job.requestText.length }, ownerDeviceId);
    return { ok: true, job };
  }

  public list(ownerDeviceId?: string): ScheduledJob[] {
    return Array.from(this.jobs.values())
      .filter((job) => ownerDeviceId === undefined || job.ownerDeviceId === ownerDeviceId)
      .map((job) => ({ ...job }));
  }

  public cancel(id: string, requesterDeviceId: string, allowAnyOwner = false): boolean {
    const job = this.jobs.get(id);
    if (!job || !job.active) return false;
    if (!allowAnyOwner && job.ownerDeviceId !== requesterDeviceId) return false;
    job.active = false;
    job.lastState = 'CANCELLED';
    this.persist();
    this.audit.record('SCHEDULE_CANCELLED', { jobId: id }, requesterDeviceId);
    return true;
  }

  /** Called when a device is revoked: its schedules must stop immediately. */
  public cancelForDevice(deviceId: string): number {
    let cancelled = 0;
    for (const job of this.jobs.values()) {
      if (job.active && job.ownerDeviceId === deviceId) {
        job.active = false;
        job.lastState = 'OWNER_REVOKED';
        cancelled++;
      }
    }
    if (cancelled > 0) {
      this.persist();
      this.audit.record('SCHEDULES_CANCELLED_DEVICE_REVOKED', { deviceId, cancelled });
    }
    return cancelled;
  }

  public start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Run every due job once. Exposed so the owner service (and callers) can drive it deterministically. */
  public async tick(now: number = Date.now()): Promise<void> {
    for (const job of Array.from(this.jobs.values())) {
      if (!job.active || job.runAt > now || this.inFlight.has(job.id)) continue;
      this.inFlight.add(job.id);
      try {
        if (!job.everyMinutes && now - job.runAt > MISSED_GRACE_MS) {
          // Missed while the service was down: never replay old one-shot work.
          job.active = false;
          job.lastState = 'MISSED';
          this.persist();
          this.audit.record('SCHEDULE_MISSED', { jobId: job.id }, job.ownerDeviceId);
          continue;
        }
        // Advance state and persist BEFORE running so a crash cannot cause a second run.
        job.lastRunAt = now;
        job.runCount += 1;
        if (job.everyMinutes) job.runAt = now + job.everyMinutes * 60_000; else job.active = false;
        this.persist();
        let result: JobRunResult;
        try {
          result = await this.runner({ ...job });
        } catch {
          result = { state: 'RUNNER_ERROR' };
        }
        job.lastTaskId = result.taskId;
        job.lastState = result.state;
        this.persist();
        this.audit.record('SCHEDULE_RUN', { jobId: job.id, taskId: result.taskId, state: result.state }, job.ownerDeviceId, result.taskId);
      } finally {
        this.inFlight.delete(job.id);
      }
    }
  }

  private load(): void {
    if (!this.persistPath || !this.key || !existsSync(this.persistPath)) return;
    try {
      const envelope = JSON.parse(readFileSync(this.persistPath, 'utf8')) as { payload?: unknown; mac?: unknown };
      if (typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string') throw new Error('Invalid schedule envelope');
      const expected = createHmac('sha256', this.key).update(envelope.payload).digest();
      const supplied = Buffer.from(envelope.mac, 'hex');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error('Schedule integrity check failed');
      const parsed = JSON.parse(envelope.payload) as { jobs?: ScheduledJob[] };
      if (!Array.isArray(parsed.jobs)) throw new Error('Invalid schedule state');
      for (const job of parsed.jobs) {
        if (job && typeof job.id === 'string' && typeof job.ownerDeviceId === 'string' && typeof job.requestText === 'string' && typeof job.runAt === 'number') {
          this.jobs.set(job.id, job);
        }
      }
    } catch {
      // Tampered or unreadable schedule state is never trusted and never executed.
      this.persistHealthy = false;
      this.audit.record('SCHEDULE_STATE_INVALID', { reason: 'INTEGRITY_OR_FORMAT_FAILURE' });
    }
  }

  private persist(): boolean {
    if (!this.persistPath || !this.key) return true; // session-local by design
    if (!this.persistHealthy) return false;
    const payload = JSON.stringify({ version: 1, jobs: Array.from(this.jobs.values()), persistedAt: Date.now() });
    const mac = createHmac('sha256', this.key).update(payload).digest('hex');
    const temporary = `${this.persistPath}.tmp-${CryptoUtil.randomToken(4)}`;
    try {
      mkdirSync(dirname(this.persistPath), { recursive: true });
      writeFileSync(temporary, JSON.stringify({ payload, mac }), { encoding: 'utf8', mode: 0o600 });
      renameSync(temporary, this.persistPath);
      return true;
    } catch {
      this.persistHealthy = false;
      this.audit.record('SCHEDULE_PERSIST_FAILED', { reason: 'WRITE_FAILED' });
      return false;
    }
  }
}
