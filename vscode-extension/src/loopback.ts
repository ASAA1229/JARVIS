/** Loopback-only URL check: the extension talks HTTP to the local JARVIS and nothing else. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function isLoopbackUrl(value: string): boolean {
  let url: URL;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'http:') return false;
  if (url.username || url.password) return false;
  return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
}

/** Returns a normalised base URL (no trailing slash, no path) or throws when not loopback. */
export function requireLoopbackBase(value: string): string {
  if (!isLoopbackUrl(value)) throw new Error('JARVIS URL must be http on 127.0.0.1, localhost or [::1].');
  const url = new URL(value);
  return `${url.protocol}//${url.host}`;
}
