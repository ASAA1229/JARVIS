import { renameSync } from 'node:fs';

/** Transient Windows sharing violations (indexer, antivirus, OneDrive sync holding the target). */
const TRANSIENT_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const sleeper = new Int32Array(new SharedArrayBuffer(4));

/**
 * Atomically replace `target` with `temporary`, retrying briefly on transient
 * sharing violations. Non-transient errors and exhausted retries are rethrown so
 * callers keep their fail-closed behaviour.
 */
export function renameWithRetry(temporary: string, target: string, attempts = 6): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      renameSync(temporary, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== 'win32' || !code || !TRANSIENT_CODES.has(code) || attempt >= attempts) throw error;
      Atomics.wait(sleeper, 0, 0, 15 * attempt);
    }
  }
}
