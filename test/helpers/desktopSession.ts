import { spawnSync } from 'node:child_process';

export interface DesktopSessionInfo {
  interactive: boolean;
  reason: string;
}

let cached: DesktopSessionInfo | undefined;

/**
 * Detects whether this process can inspect and drive a real Windows desktop.
 * Non-Windows hosts are treated as interactive (their adapters are exercised separately).
 * A Windows service / Jenkins agent runs in session 0 or on a non-interactive window station.
 * Never fakes a pass: callers must turn a non-interactive result into an explicit, counted SKIP.
 */
export function detectDesktopSession(): DesktopSessionInfo {
  if (cached) return cached;
  if (process.platform !== 'win32') {
    return (cached = { interactive: true, reason: 'non-Windows host' });
  }
  const script = '$p=(Get-Process -Id $PID).SessionId; Write-Output ("{0}|{1}" -f $p,[Environment]::UserInteractive)';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const out = (r.stdout || '').trim().split(/\r?\n/).pop() || '';
  const [session, ui] = out.split('|');
  if (r.status !== 0 || !session) {
    return (cached = { interactive: false, reason: 'could not determine the Windows session (powershell probe failed)' });
  }
  if (session === '0') return (cached = { interactive: false, reason: 'Windows session 0 (service session, no interactive desktop)' });
  if (!/^true$/i.test(ui || '')) return (cached = { interactive: false, reason: 'non-interactive window station (UserInteractive=false)' });
  return (cached = { interactive: true, reason: `interactive session ${session}` });
}

/**
 * Returns a skip reason for tests that need a real desktop, or false to run them.
 * JARVIS_REQUIRE_DESKTOP=1 (the "desktop acceptance" suite) never skips, so a missing desktop fails loudly.
 */
export function desktopSkip(): string | false {
  if (process.env.JARVIS_REQUIRE_DESKTOP === '1') return false;
  const info = detectDesktopSession();
  if (info.interactive) return false;
  const reason = `SKIPPED (desktop acceptance): ${info.reason}; run 'npm run test:desktop' in an interactive session`;
  console.warn(`[desktop-skip] ${reason}`);
  return reason;
}
