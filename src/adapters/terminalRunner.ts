import { spawn } from 'node:child_process';
import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import { WorkspaceFileAdapter } from './workspaceFiles.js';

/**
 * Allowlisted, non-shell command execution.
 *
 * This is deliberately NOT a general shell. A request names one allowlisted
 * program plus validated arguments; the process is started without a shell, in a
 * working directory that must be inside an approved workspace, with a scrubbed
 * environment, a hard timeout, an output cap, and tree-kill on cancel/timeout.
 * Chaining, redirection, environment dumps, package scripts and anything that can
 * elevate privileges are simply not expressible. Only read-only programs are
 * allowlisted today; adding a program means adding an explicit spec below.
 */

interface CommandSpec {
  executable: string;
  /** Exact argument vectors that are allowed (for programs without subcommands). */
  exactArgs?: string[][];
  /** For subcommand-style programs: allowed first argument. */
  subcommands?: string[];
  /** Flags allowed after the subcommand. Anything starting with '-' must match. */
  flag?: RegExp;
  /** Arguments always inserted by JARVIS to neutralise repo/user configuration hooks. */
  prefixArgs?: string[];
  subcommandExtraArgs?: Record<string, string[]>;
}

const GIT_FLAGS = /^(--short|--branch|--porcelain|--oneline|--stat|--name-only|--name-status|--show-current|--abbrev-ref|--no-color|--graph|--decorate|-s|-b|-n|-\d{1,3}|--max-count=\d{1,3}|--)$/;

const COMMANDS: Record<string, CommandSpec> = {
  git: {
    executable: 'git',
    subcommands: ['status', 'log', 'diff', 'branch', 'rev-parse', 'show', 'ls-files'],
    flag: GIT_FLAGS,
    prefixArgs: ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'],
    subcommandExtraArgs: {
      diff: ['--no-ext-diff', '--no-textconv'],
      log: ['--no-ext-diff', '--no-textconv'],
      show: ['--no-ext-diff', '--no-textconv'],
    },
  },
  node: { executable: 'node', exactArgs: [['--version']] },
  python: { executable: 'python', exactArgs: [['--version']] },
  hostname: { executable: 'hostname', exactArgs: [[]] },
};

const MAX_ARGS = 8;
const MAX_ARG_LENGTH = 100;
const TIMEOUT_MS = 15_000;
const MAX_OUTPUT_BYTES = 64 * 1024;
const SAFE_POSITIONAL = /^[A-Za-z0-9._@~^/-]{1,100}$/;
const SECRET_LINE = /(token|secret|passw(or)?d|api[_-]?key|authorization|bearer)\s*[=:]\s*\S+/gi;

function reject(error: string, evidence: Record<string, unknown> = {}): ExecutionResult {
  return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error, failureKind: 'blocked', evidence: { adapter: 'terminal', ...evidence } };
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'TEMP', 'TMP', 'USERPROFILE', 'HOME', 'LOCALAPPDATA', 'APPDATA', 'PATHEXT', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_PAGER = 'cat';
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return env;
}

function scrub(text: string): string {
  return text.replace(SECRET_LINE, '[REDACTED]');
}

export class TerminalRunner {
  constructor(private readonly files: WorkspaceFileAdapter) {}

  public listCommands(): Array<{ command: string; allowed: string }> {
    return Object.entries(COMMANDS).map(([command, spec]) => ({
      command,
      allowed: spec.subcommands ? `subcommands: ${spec.subcommands.join(', ')}` : (spec.exactArgs || []).map((args) => args.join(' ') || '(no arguments)').join(' | '),
    }));
  }

  /** Validate and build the final argument vector, or return a rejection message. */
  private buildArguments(spec: CommandSpec, args: string[]): { ok: true; argv: string[] } | { ok: false; error: string } {
    if (spec.exactArgs) {
      const matches = spec.exactArgs.some((allowed) => allowed.length === args.length && allowed.every((value, index) => value === args[index]));
      return matches ? { ok: true, argv: [...args] } : { ok: false, error: 'Those arguments are not allowlisted for this command.' };
    }
    const [subcommand, ...rest] = args;
    if (!subcommand || !spec.subcommands?.includes(subcommand)) {
      return { ok: false, error: `Only these subcommands are allowed: ${(spec.subcommands || []).join(', ')}.` };
    }
    for (const value of rest) {
      if (value.startsWith('-')) {
        if (!spec.flag?.test(value)) return { ok: false, error: `Option '${value.slice(0, 30)}' is not allowlisted.` };
      } else if (!SAFE_POSITIONAL.test(value) || value.split('/').includes('..') || value.startsWith('/')) {
        return { ok: false, error: 'Paths and references must be simple repository-relative names.' };
      }
    }
    return { ok: true, argv: [...(spec.prefixArgs || []), subcommand, ...(spec.subcommandExtraArgs?.[subcommand] || []), ...rest] };
  }

  public async run(params: { command?: unknown; args?: unknown; cwd?: unknown }, signal?: AbortSignal): Promise<ExecutionResult> {
    const commandName = typeof params.command === 'string' ? params.command.trim().toLowerCase().replace(/\.exe$/, '') : '';
    const spec = Object.prototype.hasOwnProperty.call(COMMANDS, commandName) ? COMMANDS[commandName] : undefined;
    if (!spec) return reject('That command is not allowlisted. JARVIS does not run arbitrary shell commands.', { requested: commandName.slice(0, 40) });

    const rawArgs = params.args === undefined ? [] : params.args;
    if (!Array.isArray(rawArgs) || rawArgs.length > MAX_ARGS) return reject(`Arguments must be a list of at most ${MAX_ARGS} strings.`);
    const args: string[] = [];
    for (const value of rawArgs) {
      if (typeof value !== 'string' || value.length > MAX_ARG_LENGTH || /[\u0000-\u001f]/.test(value)) return reject('Arguments must be short printable strings.');
      args.push(value);
    }
    const built = this.buildArguments(spec, args);
    if (!built.ok) return reject(built.error, { command: commandName });

    let cwd: string;
    try {
      cwd = await this.files.resolveDirectory(params.cwd ?? '.');
    } catch (error) {
      const message = error instanceof Error && error.name === 'FileGuardError' ? error.message : 'The working directory is not available.';
      return reject(message, { command: commandName });
    }

    if (signal?.aborted) {
      return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: 'The command was cancelled before it started.', failureKind: 'cancelled', interrupted: true, evidence: { adapter: 'terminal', command: commandName, started: false } };
    }

    const startedAt = Date.now();
    return new Promise<ExecutionResult>((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let truncated = false;
      let finished = false;
      let timedOut = false;
      let cancelled = false;

      const child = spawn(spec.executable, built.argv, { cwd, shell: false, windowsHide: true, env: minimalEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] });

      const killTree = (): void => {
        if (child.pid === undefined) return;
        if (process.platform === 'win32') {
          const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
          killer.on('error', () => child.kill());
        } else {
          child.kill('SIGKILL');
        }
      };

      const finish = (result: ExecutionResult): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolvePromise(result);
      };

      const collect = (target: 'out' | 'err') => (chunk: Buffer): void => {
        if (truncated) return;
        outputBytes += chunk.length;
        if (outputBytes > MAX_OUTPUT_BYTES) {
          truncated = true;
          killTree();
          return;
        }
        if (target === 'out') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      };
      child.stdout?.on('data', collect('out'));
      child.stderr?.on('data', collect('err'));

      const timer = setTimeout(() => { timedOut = true; killTree(); }, TIMEOUT_MS);
      const onAbort = (): void => { cancelled = true; killTree(); };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.on('error', (error) => {
        finish({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'The program is not installed or not on PATH.' : 'The program could not be started.', failureKind: 'unavailable', evidence: { adapter: 'terminal', command: commandName, started: false } });
      });

      child.on('close', (exitCode) => {
        const durationMs = Date.now() - startedAt;
        const baseEvidence = { adapter: 'terminal', command: commandName, exitCode, durationMs, outputTruncated: truncated, shell: false, cwdInsideWorkspace: true };
        const data = { stdout: scrub(stdout), stderr: scrub(stderr), exitCode, truncated };
        if (cancelled) {
          finish({ success: false, outcome: VerificationOutcome.UNCERTAIN, error: 'The command was cancelled while running.', failureKind: 'cancelled', interrupted: true, data, evidence: baseEvidence });
        } else if (timedOut) {
          finish({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: `The command exceeded ${TIMEOUT_MS / 1000}s and was stopped.`, failureKind: 'timeout', data, evidence: baseEvidence });
        } else if (truncated) {
          finish({ success: false, outcome: VerificationOutcome.PARTIAL_SUCCESS, error: 'Output exceeded the size limit and the command was stopped.', data, evidence: baseEvidence });
        } else if (exitCode === 0) {
          finish({ success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data, evidence: baseEvidence });
        } else {
          finish({ success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error: `The command exited with code ${exitCode}.`, data, evidence: baseEvidence });
        }
      });
    });
  }
}
