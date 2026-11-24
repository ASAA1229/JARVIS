/**
 * Redaction for learning episodes (E3:D4.17). The VS Code extension applies the same rules before an
 * episode leaves the editor; the server re-applies them as defence in depth.
 * Keep this file in step with vscode-extension/src/redact.ts.
 */

export interface RedactionOptions {
  emails: boolean;
  phones: boolean;
}

export const DEFAULT_REDACTION: RedactionOptions = { emails: true, phones: true };

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, '[REDACTED PRIVATE KEY]'],
  // Connection strings with embedded credentials: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s:/@]+:[^\s@/]+@/gi, '$1[REDACTED]@'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED API KEY]'],
  [/\bjrv_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED JARVIS KEY]'],
  [/\bjli_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED INGEST KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED SLACK TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, '[REDACTED JWT]'],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  // key=value / key: value assignments whose name looks secret.
  [/((?:^|[\s"'{,(])(?:[A-Za-z0-9_-]*?(?:password|passwd|pwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_-]*)\s*[:=]\s*)(["']?)([^\s"',}]{4,})\2/gi, '$1$2[REDACTED]$2'],
];
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const PHONE = /(?<![\w.-])(?:\+\d{1,3}[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}|\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4})(?![\w-])/g;

export function redactText(text: string, options: RedactionOptions = DEFAULT_REDACTION): string {
  let output = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  if (options.emails) output = output.replace(EMAIL, '[REDACTED EMAIL]');
  if (options.phones) output = output.replace(PHONE, '[REDACTED PHONE]');
  return output;
}

/** Recursively redact every string in a JSON-like value. */
export function redactDeep<T>(value: T, options: RedactionOptions = DEFAULT_REDACTION): T {
  if (typeof value === 'string') return redactText(value, options) as unknown as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, options)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) out[key] = redactDeep(item, options);
    return out as T;
  }
  return value;
}

const EXCLUDED_BASENAME = [
  /^\.env(\..*)?$/i, /\.env$/i, /\.pem$/i, /\.key$/i, /\.pfx$/i, /\.p12$/i, /^id_[A-Za-z0-9_]+(\.pub)?$/i,
  /^token\.txt$/i, /^credentials/i, /^\.npmrc$/i, /^secrets?\./i,
];

/** True when a path names a secret-bearing file whose content or existence must never be captured. */
export function isExcludedPath(path: string): boolean {
  const base = String(path ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  return EXCLUDED_BASENAME.some((pattern) => pattern.test(base));
}
