/**
 * Secret redaction for the developer assistant (JARVIS-US-063).
 * Applied to every file excerpt sent to a model and to every model output,
 * diff, git output and PR draft returned to the owner.
 */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]'],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED API KEY]'],
  [/\bjrv_[a-f0-9]{12}_[A-Za-z0-9_-]{43}\b/g, '[REDACTED JARVIS KEY]'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/g, '[REDACTED GITHUB TOKEN]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED SLACK TOKEN]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED AWS KEY]'],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED GOOGLE KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED JWT]'],
  // key=value / key: value assignments whose name looks secret.
  [/((?:^|[\s"'{,])(?:[A-Za-z0-9_]*?(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|client[_-]?secret)[A-Za-z0-9_]*)\s*[:=]\s*)(["']?)([^\s"',}]{6,})\2/gi, '$1$2[REDACTED]$2'],
];

export function redactSecrets(text: string): string {
  let output = String(text ?? '');
  for (const [pattern, replacement] of SECRET_PATTERNS) output = output.replace(pattern, replacement);
  return output;
}

export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== String(text ?? '');
}
