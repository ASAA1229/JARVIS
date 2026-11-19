import { mkdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const LOCK = join(tmpdir(), 'jarvis-test-desktop.lock');
const STALE_MS = 5 * 60_000;

/**
 * Cross-process mutex for tests that drive the real Windows desktop (launching Notepad and
 * checking foreground focus). Two concurrent test runs would otherwise fight over one
 * desktop. Stale locks (crashed holders) are broken after five minutes.
 */
export async function acquireDesktopLock(timeoutMs = 240_000): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(LOCK);
      return () => { try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* already released */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try { if (Date.now() - statSync(LOCK).mtimeMs > STALE_MS) rmSync(LOCK, { recursive: true, force: true }); } catch { /* raced with release */ }
      if (Date.now() > deadline) throw new Error('Timed out waiting for the shared desktop test lock.');
      await delay(500);
    }
  }
}
