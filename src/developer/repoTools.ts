/**
 * Repository tools for the developer assistant (JARVIS-US-063).
 *
 * Every git call uses `git -C <repo> <fixed argument array>` through execFile —
 * no shell, no string interpolation of owner text into a command line. Outputs
 * are bounded and secret-redacted before they leave this module.
 */
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeniedRepoPath, resolveInsideRepo, type RepoConnection } from './repoRegistry.js';
import { redactSecrets } from './secrets.js';

const MAX_TREE_ENTRIES = 400;
const MAX_READ_BYTES = 64 * 1024;
const MAX_GREP_RESULTS = 100;
const MAX_GREP_FILE_BYTES = 512 * 1024;
const MAX_GIT_OUTPUT = 200 * 1024;
const GIT_TIMEOUT_MS = 30_000;

/** Branches the assistant must never commit to or push directly (AGENTS.md branch rules). */
export const PROTECTED_BRANCHES = new Set(['main', 'master', 'dev', 'production', 'release']);
const BRANCH_NAME = /^(?!.*\.\.)(?!.*\/\/)(?!.*@\{)(?![./-])[A-Za-z0-9._/-]{1,100}(?<![./])$/;

export function isValidBranchName(name: string): boolean {
  return BRANCH_NAME.test(name) && !name.endsWith('.lock');
}

export function runGit(repo: RepoConnection, args: string[], options: { input?: string; signal?: AbortSignal } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    if (options.input === undefined) {
      execFile('git', ['-C', repo.path, ...args], {
        timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_GIT_OUTPUT * 4, windowsHide: true, encoding: 'utf8',
        ...(options.signal ? { signal: options.signal } : {}),
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout, stderr) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
          reject(new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'git is not installed or not on PATH.' : 'git could not be started.'));
          return;
        }
        const exitCode = error ? Number((error as { code?: number }).code ?? 1) : 0;
        resolvePromise({ code: exitCode, stdout: String(stdout).slice(0, MAX_GIT_OUTPUT), stderr: String(stderr).slice(0, 4000) });
      });
      return;
    }
    const child = spawn('git', ['-C', repo.path, ...args], {
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => { if (stdout.length < MAX_GIT_OUTPUT) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < 4000) stderr += chunk; });
    child.on('error', () => { clearTimeout(timer); reject(new Error('git could not be started.')); });
    child.on('close', (code) => { clearTimeout(timer); resolvePromise({ code: code ?? 1, stdout, stderr }); });
    child.stdin.end(options.input);
  });
}

async function gitOrThrow(repo: RepoConnection, args: string[], what: string, options: { input?: string; signal?: AbortSignal } = {}): Promise<string> {
  const result = await runGit(repo, args, options);
  if (result.code !== 0) throw new Error(`${what} failed: ${redactSecrets(result.stderr.trim()).slice(0, 400) || 'git exited with code ' + result.code}`);
  return result.stdout;
}

// ---------------- read-only intelligence ----------------

export async function listTree(repo: RepoConnection, subPath = '.'): Promise<{ entries: string[]; truncated: boolean }> {
  const start = resolveInsideRepo(repo, subPath);
  const entries: string[] = [];
  let truncated = false;
  const walk = async (absolute: string, rel: string, depth: number): Promise<void> => {
    if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
    const items = await readdir(absolute, { withFileTypes: true });
    items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const item of items) {
      const childRel = rel === '.' ? item.name : `${rel}/${item.name}`;
      if (isDeniedRepoPath(childRel) || item.isSymbolicLink()) continue;
      if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; return; }
      entries.push(item.isDirectory() ? childRel + '/' : childRel);
      if (item.isDirectory() && depth < 6) await walk(join(absolute, item.name), childRel, depth + 1);
    }
  };
  await walk(start.absolute, start.relative, 0);
  return { entries, truncated };
}

export async function readRepoFile(repo: RepoConnection, filePath: string): Promise<{ path: string; content: string; truncated: boolean; bytes: number }> {
  const target = resolveInsideRepo(repo, filePath);
  const info = await stat(target.absolute);
  if (!info.isFile()) throw new Error('That path is not a file.');
  const buffer = await readFile(target.absolute);
  if (buffer.subarray(0, 8000).includes(0)) throw new Error('That file looks binary; only text files can be read.');
  const truncated = buffer.length > MAX_READ_BYTES;
  return {
    path: target.relative,
    content: redactSecrets(buffer.subarray(0, MAX_READ_BYTES).toString('utf8')),
    truncated,
    bytes: buffer.length,
  };
}

/** Literal (not regex) case-insensitive search across non-denied text files. */
export async function grepRepo(repo: RepoConnection, query: string): Promise<{ matches: Array<{ path: string; line: number; text: string }>; truncated: boolean }> {
  const needle = String(query ?? '').trim().toLowerCase();
  if (needle.length < 2 || needle.length > 200) throw new Error('Search text must be 2-200 characters.');
  const { entries } = await listTree(repo, '.');
  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    const absolute = join(repo.path, entry);
    const info = await stat(absolute).catch(() => null);
    if (!info || !info.isFile() || info.size > MAX_GREP_FILE_BYTES) continue;
    const buffer = await readFile(absolute).catch(() => null);
    if (!buffer || buffer.subarray(0, 8000).includes(0)) continue;
    const lines = buffer.toString('utf8').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]!.toLowerCase().includes(needle)) {
        matches.push({ path: entry, line: index + 1, text: redactSecrets(lines[index]!.trim().slice(0, 240)) });
        if (matches.length >= MAX_GREP_RESULTS) return { matches, truncated: true };
      }
    }
  }
  return { matches, truncated: false };
}

export async function currentBranch(repo: RepoConnection): Promise<string> {
  return (await gitOrThrow(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], 'Reading the current branch')).trim();
}

export async function gitStatus(repo: RepoConnection): Promise<{ branch: string; status: string }> {
  const status = await gitOrThrow(repo, ['status', '--porcelain=v1', '--branch'], 'git status');
  return { branch: await currentBranch(repo), status: redactSecrets(status) };
}

export async function gitLog(repo: RepoConnection, count = 15): Promise<string> {
  const n = Math.max(1, Math.min(Math.trunc(count) || 15, 50));
  return redactSecrets(await gitOrThrow(repo, ['log', '--oneline', '--decorate', `-n${n}`], 'git log'));
}

export async function gitDiff(repo: RepoConnection, staged = false): Promise<{ stat: string; diff: string; truncated: boolean }> {
  const base = staged ? ['diff', '--cached'] : ['diff'];
  const stat = await gitOrThrow(repo, [...base, '--stat'], 'git diff --stat');
  const diff = await gitOrThrow(repo, [...base, '--no-color', '--', '.', ':(exclude)*.env*', ':(exclude)data/**'], 'git diff');
  return { stat: redactSecrets(stat), diff: redactSecrets(diff.slice(0, 60_000)), truncated: diff.length > 60_000 };
}

export async function gitBranches(repo: RepoConnection): Promise<string> {
  return gitOrThrow(repo, ['branch', '--list', '--no-color'], 'git branch');
}

// ---------------- authorized write operations (policy-gated, approval required) ----------------

function assertWritableBranch(branch: string): void {
  if (!branch || branch === 'HEAD') throw new Error('The repository is in a detached HEAD state; switch to a feature branch first.');
  if (PROTECTED_BRANCHES.has(branch.toLowerCase())) {
    throw new Error(`"${branch}" is a protected branch. Create a feature branch first; changes reach dev only through a pull request and main is updated only by the owner.`);
  }
}

/** Validate a unified diff: relative paths only, inside the repo, never protected files. */
export function assertSafeDiff(repo: RepoConnection, diff: string): string[] {
  if (!diff.trim()) throw new Error('The suggestion has no diff to apply.');
  const files = new Set<string>();
  for (const match of diff.matchAll(/^(?:\+\+\+|---) (?:[ab]\/)?(.+?)\s*$/gm)) {
    const file = match[1]!.trim();
    if (file === '/dev/null') continue;
    resolveInsideRepo(repo, file); // throws for escapes and protected paths
    files.add(file.replace(/\\/g, '/'));
  }
  if (!files.size) throw new Error('The diff does not name any files.');
  return [...files];
}

export async function applyDiff(repo: RepoConnection, diff: string): Promise<{ files: string[] }> {
  const files = assertSafeDiff(repo, diff);
  assertWritableBranch(await currentBranch(repo));
  await gitOrThrow(repo, ['apply', '--check', '--whitespace=nowarn', '-'], 'Checking the suggestion against the working tree', { input: diff });
  await gitOrThrow(repo, ['apply', '--whitespace=nowarn', '-'], 'Applying the suggestion', { input: diff });
  return { files };
}

export async function createBranch(repo: RepoConnection, name: string): Promise<{ branch: string; from: string }> {
  if (!isValidBranchName(name)) throw new Error('That is not a valid branch name.');
  if (PROTECTED_BRANCHES.has(name.toLowerCase())) throw new Error(`"${name}" is a protected branch name.`);
  const from = await currentBranch(repo);
  await gitOrThrow(repo, ['switch', '-c', name], 'Creating the branch');
  return { branch: await currentBranch(repo), from };
}

export async function commitChanges(repo: RepoConnection, message: string, files?: string[]): Promise<{ commit: string; branch: string; files: string[] }> {
  const text = String(message ?? '').trim();
  if (text.length < 3 || text.length > 500 || /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) {
    throw new Error('Commit message must be 3-500 printable characters.');
  }
  const branch = await currentBranch(repo);
  assertWritableBranch(branch);
  const staged: string[] = [];
  if (files && files.length) {
    for (const file of files) staged.push(resolveInsideRepo(repo, file).relative);
    await gitOrThrow(repo, ['add', '--', ...staged], 'Staging the suggested files');
  }
  const pending = (await gitOrThrow(repo, ['diff', '--cached', '--name-only'], 'Reading staged files')).split(/\r?\n/).filter(Boolean);
  if (!pending.length) throw new Error('Nothing is staged to commit.');
  const blocked = pending.filter((file) => isDeniedRepoPath(file));
  if (blocked.length) throw new Error(`Refusing to commit protected files: ${blocked.slice(0, 5).join(', ')}. Unstage them first.`);
  await gitOrThrow(repo, ['commit', '-m', text], 'git commit');
  const commit = (await gitOrThrow(repo, ['rev-parse', 'HEAD'], 'Reading the new commit')).trim();
  return { commit, branch, files: pending };
}

export async function pushBranch(repo: RepoConnection): Promise<{ branch: string; remoteCommit: string; localCommit: string }> {
  const branch = await currentBranch(repo);
  assertWritableBranch(branch);
  // Never --force. Sets upstream on first push; dev/main are refused above.
  await gitOrThrow(repo, ['push', '--set-upstream', 'origin', branch], 'git push');
  const localCommit = (await gitOrThrow(repo, ['rev-parse', 'HEAD'], 'Reading HEAD')).trim();
  const remoteCommit = (await gitOrThrow(repo, ['rev-parse', `origin/${branch}`], 'Reading the pushed commit')).trim();
  return { branch, remoteCommit, localCommit };
}

/** Pull-request draft text only — nothing is opened remotely. Always targets dev. */
export async function draftPullRequest(repo: RepoConnection, title?: string): Promise<{ base: string; head: string; title: string; body: string }> {
  const head = await currentBranch(repo);
  assertWritableBranch(head);
  const range = (await runGit(repo, ['rev-parse', '--verify', 'origin/dev'])).code === 0 ? 'origin/dev..HEAD' : 'dev..HEAD';
  const commits = (await runGit(repo, ['log', '--oneline', '--no-decorate', range])).stdout.trim();
  const stat = (await runGit(repo, ['diff', '--stat', range.replace('..HEAD', '...HEAD')])).stdout.trim();
  const prTitle = String(title ?? '').trim().slice(0, 120) || commits.split('\n')[0]?.replace(/^[a-f0-9]+\s+/, '') || `Changes from ${head}`;
  const body = redactSecrets([
    '## Summary', '', commits ? commits.split('\n').map((line) => `- ${line}`).join('\n') : '- (no commits ahead of dev)', '',
    '## Files changed', '', '```', stat || '(none)', '```', '',
    '## Checklist', '', '- [ ] Tests run and results recorded', '- [ ] No secrets or generated artifacts committed', '',
    `Base: dev · Head: ${head} (draft prepared by JARVIS; not opened remotely)`,
  ].join('\n'));
  return { base: 'dev', head, title: redactSecrets(prTitle), body };
}

/** Read-only CI status via the GitHub CLI when available. */
/** Reduces `gh run list --json` output to runs for exactly one commit; runs for other commits are never reported as this commit's CI. */
export function runsForCommit(stdout: string, sha: string): { runs: string; matched: number; otherCommitRuns: number } {
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('A full 40-character commit SHA is required.');
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return { runs: 'GitHub CLI returned unreadable run data.', matched: 0, otherCommitRuns: 0 }; }
  const list = Array.isArray(parsed) ? parsed.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object') : [];
  const exact = list.filter((run) => run.headSha === sha);
  const lines = exact.slice(0, 10).map((run) => `${String(run.status ?? 'unknown')}/${String(run.conclusion || 'pending')}  ${String(run.name ?? 'run').slice(0, 80)}  ${String(run.url ?? '').slice(0, 200)}`);
  return { runs: lines.join('\n'), matched: exact.length, otherCommitRuns: list.length - exact.length };
}

/** CI evidence is bound to the exact HEAD commit: runs for earlier commits are counted but never presented as current. */
export async function ciStatus(repo: RepoConnection): Promise<{ available: boolean; commit: string; runs: string; matchedCommit: boolean }> {
  const branch = await currentBranch(repo);
  const head = await runGit(repo, ['rev-parse', 'HEAD']);
  const sha = head.code === 0 ? head.stdout.trim() : '';
  return new Promise((resolvePromise) => {
    execFile('gh', ['run', 'list', '--branch', branch, '--limit', '30', '--json', 'headSha,status,conclusion,name,url'], { cwd: repo.path, timeout: GIT_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) return resolvePromise({ available: false, commit: sha, matchedCommit: false, runs: redactSecrets(String(stderr || 'GitHub CLI (gh) is unavailable or not authenticated.').trim().slice(0, 400)) });
      if (!/^[0-9a-f]{40}$/.test(sha)) return resolvePromise({ available: true, commit: sha, matchedCommit: false, runs: 'The current commit could not be determined.' });
      const result = runsForCommit(String(stdout), sha);
      const note = result.matched === 0 ? `No CI run exists for commit ${sha.slice(0, 12)}${result.otherCommitRuns ? ` (${result.otherCommitRuns} run(s) for other commits were ignored)` : ''}.` : result.runs;
      resolvePromise({ available: true, commit: sha, matchedCommit: result.matched > 0, runs: redactSecrets(note) });
    });
  });
}

// ---------------- approval-gated remote PR and project script runs ----------------

/**
 * Open a pull request on GitHub with the GitHub CLI. Always base `dev`; the head
 * must be a pushed feature branch (never main/master/dev). Fixed argument array,
 * no shell. The result is confirmed with `gh pr view` rather than trusted.
 */
export async function createPullRequest(repo: RepoConnection, title?: string): Promise<{ url: string; base: 'dev'; head: string; title: string }> {
  const draft = await draftPullRequest(repo, title);
  const head = draft.head;
  assertWritableBranch(head);
  const upstream = await runGit(repo, ['rev-parse', '--verify', `origin/${head}`]);
  if (upstream.code !== 0) throw new Error(`Push the branch "${head}" before opening a pull request.`);
  const gh = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolvePromise) => {
    execFile('gh', args, { cwd: repo.path, timeout: 60_000, windowsHide: true, encoding: 'utf8', env: { ...process.env, GH_PROMPT_DISABLED: '1' } },
      (error, stdout, stderr) => resolvePromise({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, stdout: String(stdout), stderr: String(stderr) }));
  });
  const created = await gh(['pr', 'create', '--base', 'dev', '--head', head, '--title', draft.title, '--body', draft.body]);
  if (created.code !== 0) {
    throw new Error(`gh pr create failed: ${redactSecrets(created.stderr.trim()).slice(0, 400) || 'GitHub CLI unavailable or not authenticated.'}`);
  }
  const view = await gh(['pr', 'view', head, '--json', 'url,baseRefName,headRefName']);
  let url = '';
  try {
    const parsed = JSON.parse(view.stdout) as { url?: string; baseRefName?: string; headRefName?: string };
    if (parsed.baseRefName !== 'dev' || parsed.headRefName !== head) throw new Error('mismatch');
    url = String(parsed.url ?? '');
  } catch {
    throw new Error('The pull request command finished, but JARVIS could not confirm a PR from this branch into dev.');
  }
  return { url, base: 'dev', head, title: draft.title };
}

/** Project scripts the assistant may run (by name, from the repo's own package.json). */
export const RUNNABLE_SCRIPTS = new Set(['build', 'lint', 'test', 'typecheck']);
const SCRIPT_TIMEOUT_MS = 5 * 60_000;
const SCRIPT_OUTPUT_TAIL = 12_000;

function npmCliPath(): string | null {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /\.c?js$/i.test(fromEnv)) return fromEnv;
  const bundled = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return existsSync(bundled) ? bundled : null;
}

/**
 * Run one of the repository's own npm scripts (build/lint/test/typecheck) for build
 * and diagnostic assistance. Owner text never reaches a command line: only a name
 * from the allowlist that also exists in package.json. Time-limited; output is
 * secret-redacted and truncated to its tail.
 */
export async function runProjectScript(repo: RepoConnection, script: string, signal?: AbortSignal): Promise<{ script: string; exitCode: number | null; timedOut: boolean; durationMs: number; output: string; truncated: boolean }> {
  const name = String(script ?? '').trim().toLowerCase();
  if (!RUNNABLE_SCRIPTS.has(name)) throw new Error(`Only these project scripts can be run: ${[...RUNNABLE_SCRIPTS].join(', ')}.`);
  let pkg: { scripts?: Record<string, unknown> };
  try {
    pkg = JSON.parse(await readFile(join(repo.path, 'package.json'), 'utf8')) as { scripts?: Record<string, unknown> };
  } catch {
    throw new Error('This repository has no readable package.json.');
  }
  if (typeof pkg.scripts?.[name] !== 'string') throw new Error(`package.json has no "${name}" script.`);
  const cli = npmCliPath();
  if (!cli) throw new Error('npm could not be located next to the running Node.js.');
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, 'run', name], {
      cwd: repo.path,
      windowsHide: true,
      env: { ...process.env, CI: '1', FORCE_COLOR: '0', npm_config_yes: 'false' },
      ...(signal ? { signal } : {}),
    });
    let output = '';
    let truncated = false;
    let timedOut = false;
    const append = (chunk: Buffer) => {
      output += chunk.toString('utf8');
      if (output.length > SCRIPT_OUTPUT_TAIL * 2) { output = output.slice(-SCRIPT_OUTPUT_TAIL); truncated = true; }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, SCRIPT_TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(new Error(`The script could not be started: ${error.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (output.length > SCRIPT_OUTPUT_TAIL) { output = output.slice(-SCRIPT_OUTPUT_TAIL); truncated = true; }
      resolvePromise({ script: name, exitCode: code, timedOut, durationMs: Date.now() - started, output: redactSecrets(output), truncated });
    });
  });
}
