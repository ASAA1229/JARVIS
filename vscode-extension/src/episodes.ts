import { createHash } from 'node:crypto';
import { DEFAULT_REDACTION, isExcludedPath, redactDeep, type RedactionOptions } from './redact';
import type { CommandClass } from './classify';

export interface EpisodeStep {
  kind: 'edit' | 'write' | 'command' | 'diagnostics' | 'commit' | 'save';
  assistantGenerated: boolean;
  path?: string;
  command?: string;
  commandClass?: CommandClass;
  exitCode?: number;
  summary?: string;
  outputTail?: string;
  diffStat?: { files?: number; insertions?: number; deletions?: number };
  diff?: string;
  diagnostics?: { before?: number; after?: number; messages?: string[] };
}

export interface Episode {
  schemaVersion: 1;
  id: string;
  source: string;
  startedAt: string;
  endedAt?: string;
  workspace?: string;
  prompt?: string;
  assistantSummary?: string;
  assistantGenerated: boolean;
  steps: EpisodeStep[];
  outcome?: { status: 'success' | 'failure' | 'unknown'; summary?: string };
  linkedEpisodeIds?: string[];
}

export const stableId = (prefix: string, ...parts: string[]): string =>
  `${prefix}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;

export const tail = (text: string, max: number): string => (text.length > max ? text.slice(text.length - max) : text);
export const head = (text: string, max: number): string => (text.length > max ? text.slice(0, max) + '…[truncated]' : text);
// eslint-disable-next-line no-control-regex
export const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g, '');

/** Glob-ish matcher for the user's extra exclude list (path segments or simple globs). */
export function matchesExclude(path: string, patterns: readonly string[]): boolean {
  const normalised = path.replace(/\\/g, '/');
  const segments = normalised.split('/');
  return patterns.some((raw) => {
    const pattern = raw.trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!pattern) return false;
    const regex = new RegExp('^' + pattern.replace(/[.+^${}()|[\]]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$');
    return segments.some((segment) => regex.test(segment)) || regex.test(normalised);
  });
}

/** A command that names a secret-bearing file (cat .env, type Token.txt) is dropped, not just redacted. */
export function commandTouchesExcluded(command: string): boolean {
  return command.split(/[\s"'=<>|;&]+/).some((token) => token.length > 1 && isExcludedPath(token));
}

export interface FinalizeOptions { redaction: RedactionOptions; excludePaths: readonly string[] }

/**
 * Final gate before an episode is queued or sent: drops steps naming excluded paths, then redacts every string.
 * Returns undefined when nothing meaningful is left.
 */
export function finalizeEpisode(episode: Episode, options: FinalizeOptions = { redaction: DEFAULT_REDACTION, excludePaths: [] }): Episode | undefined {
  const excluded = (path: string | undefined) => path !== undefined && (isExcludedPath(path) || matchesExclude(path, options.excludePaths));
  const steps = episode.steps.filter((step) => !excluded(step.path) && !(step.command && commandTouchesExcluded(step.command))).slice(0, 200);
  if (!episode.prompt && !steps.length) return undefined;
  return redactDeep({ ...episode, steps }, options.redaction);
}

/** Cheap line-multiset diff: counts lines added and removed without storing any content. */
export function lineDiffStat(before: string, after: string): { insertions: number; deletions: number } {
  const counts = new Map<string, number>();
  for (const line of before.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
  let insertions = 0;
  for (const line of after.split('\n')) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1); else insertions += 1;
  }
  let deletions = 0;
  for (const n of counts.values()) deletions += n;
  return { insertions, deletions };
}
