import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep, basename, dirname } from 'node:path';
import { ExecutionResult, FailureKind, VerificationOutcome } from '../core/types.js';

/**
 * Constrained file operations inside explicitly configured workspace roots.
 *
 * Guarantees enforced here (the PolicyGateway still decides whether an operation
 * may run at all, and the core service only calls this adapter after that):
 *  - every path is resolved and must stay inside a configured root;
 *  - symbolic links, junctions and Windows device names are refused;
 *  - credential-like file names are never listed, read, written or searched;
 *  - writes never overwrite; edits keep a backup; deletes move files to a managed
 *    quarantine that `file:restore` can undo; directories are never deleted;
 *  - every mutation is verified by reading the result back.
 *
 * Roots come from JARVIS_WORKSPACE_ROOTS (path-delimiter separated) and default to
 * ~/Documents/JARVIS Workspace. Nothing outside those roots is reachable.
 */

const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_VISITS = 5_000;
const MAX_SEARCH_DEPTH = 6;
const QUARANTINE_DIR = '.jarvis-quarantine';

const SENSITIVE_SEGMENT = /^(\.env(\..*)?|id_rsa.*|id_ed25519.*|id_ecdsa.*|.*\.(pem|key|pfx|p12|kdbx|ppk)|credentials?(\..*)?|secrets?(\..*)?|.*password.*|\.ssh|\.aws|\.npmrc|\.netrc)$/i;
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\u0000-\u001f]/;

class FileGuardError extends Error {
  constructor(public readonly kind: FailureKind, message: string) {
    super(message);
    this.name = 'FileGuardError';
  }
}

interface ResolvedPath {
  root: string;
  absolute: string;
  relative: string;
}

interface QuarantineEntry {
  id: string;
  kind: 'delete' | 'backup';
  originalRelative: string;
  storedRelative: string;
  quarantinedAt: number;
  bytes: number;
  sha256: string;
  restored?: boolean;
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

function fail(kind: FailureKind, error: string, evidence: Record<string, unknown> = {}): ExecutionResult {
  return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error, failureKind: kind, evidence: { adapter: 'workspace-files', ...evidence } };
}

export class WorkspaceFileAdapter {
  private readonly roots: string[];

  constructor(roots?: string[]) {
    const configured = roots ?? (process.env.JARVIS_WORKSPACE_ROOTS || '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
    this.roots = (configured.length ? configured : [join(homedir(), 'Documents', 'JARVIS Workspace')]).map((root) => resolve(root));
  }

  public getRoots(): string[] {
    return [...this.roots];
  }

  /** Resolve an existing folder inside an approved root (used as a terminal working directory). */
  public async resolveDirectory(input: unknown): Promise<string> {
    const target = await this.resolveSafe(input ?? '.', { mustExist: true });
    if (!(await fs.stat(target.absolute)).isDirectory()) throw new FileGuardError('unsupported', 'The working directory must be a folder.');
    return target.absolute;
  }

  // ───── path safety ─────

  private isInside(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  }

  private async resolveSafe(input: unknown, options: { mustExist: boolean; allowQuarantine?: boolean }): Promise<ResolvedPath> {
    if (typeof input !== 'string' || input.length === 0 || input.length > 260 || input.includes('\u0000')) {
      throw new FileGuardError('unsupported', 'Path must be a string of 1-260 characters.');
    }
    // Relative paths are interpreted against the first root; absolute paths must fall inside some root.
    const absolute = isAbsolute(input) ? resolve(input) : resolve(this.roots[0], input);
    const root = this.roots.find((candidate) => this.isInside(candidate, absolute));
    if (!root) throw new FileGuardError('blocked', 'Path is outside the approved workspace folders.');
    const rel = relative(root, absolute);
    const segments = rel === '' ? [] : rel.split(sep);
    for (const segment of segments) {
      if (ILLEGAL_SEGMENT_CHARS.test(segment) || RESERVED_DEVICE_NAME.test(segment) || /[. ]$/.test(segment)) {
        throw new FileGuardError('blocked', 'Path contains an unsupported or reserved name.');
      }
      if (SENSITIVE_SEGMENT.test(segment)) throw new FileGuardError('blocked', 'JARVIS policy blocks access to credential-like files.');
      if (!options.allowQuarantine && segment.toLowerCase() === QUARANTINE_DIR) {
        throw new FileGuardError('blocked', 'The quarantine folder is managed by JARVIS; use file:restore.');
      }
    }
    // Refuse symlinks/junctions in every existing component and re-check the real path.
    let cursor = root;
    for (const segment of segments) {
      cursor = join(cursor, segment);
      try {
        const stat = await fs.lstat(cursor);
        if (stat.isSymbolicLink()) throw new FileGuardError('blocked', 'Symbolic links and junctions are not followed.');
      } catch (error) {
        if (error instanceof FileGuardError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
    }
    let exists = true;
    try {
      const realRoot = await fs.realpath(root);
      const real = await fs.realpath(absolute);
      if (!this.isInside(realRoot, real)) throw new FileGuardError('blocked', 'Resolved path escapes the approved workspace folders.');
    } catch (error) {
      if (error instanceof FileGuardError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') exists = false;
      else throw error;
    }
    if (options.mustExist && !exists) throw new FileGuardError('unavailable', 'The file or folder does not exist.');
    return { root, absolute, relative: rel === '' ? '.' : rel };
  }

  private async readTextFile(absolute: string): Promise<{ text: string; buffer: Buffer }> {
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new FileGuardError('unsupported', 'Only regular files are supported.');
    if (stat.size > MAX_TEXT_BYTES) throw new FileGuardError('unsupported', `File is larger than ${MAX_TEXT_BYTES / 1024} KB.`);
    const buffer = await fs.readFile(absolute);
    if (buffer.subarray(0, 8192).includes(0)) throw new FileGuardError('unsupported', 'Binary files are not supported.');
    return { text: buffer.toString('utf8'), buffer };
  }

  private toFailure(error: unknown, operation: string): ExecutionResult {
    if (error instanceof FileGuardError) return fail(error.kind, error.message, { operation });
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') return fail('unavailable', 'The file or folder does not exist.', { operation });
    if (code === 'EACCES' || code === 'EPERM') return fail('blocked', 'The operating system denied access.', { operation });
    if (code === 'EEXIST') return fail('blocked', 'The target already exists; JARVIS will not overwrite it.', { operation });
    return fail('unavailable', 'The file operation failed.', { operation, errorType: error instanceof Error ? error.name : 'UnknownError' });
  }

  // ───── read-only operations ─────

  public async list(inputPath: unknown): Promise<ExecutionResult> {
    try {
      const target = await this.resolveSafe(inputPath ?? '.', { mustExist: false });
      let dirents: Dirent[];
      try {
        dirents = await fs.readdir(target.absolute, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { path: target.relative, entries: [], note: 'Folder does not exist yet.' }, evidence: { adapter: 'workspace-files', operation: 'file:list', rootCount: this.roots.length } };
        }
        throw error;
      }
      const entries = dirents
        .filter((entry) => !SENSITIVE_SEGMENT.test(entry.name) && entry.name.toLowerCase() !== QUARANTINE_DIR && !entry.isSymbolicLink())
        .slice(0, MAX_LIST_ENTRIES)
        .map((entry) => ({ name: entry.name, type: entry.isDirectory() ? 'folder' : 'file' }));
      return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { path: target.relative, entries, truncated: dirents.length > MAX_LIST_ENTRIES }, evidence: { adapter: 'workspace-files', operation: 'file:list', entryCount: entries.length } };
    } catch (error) {
      return this.toFailure(error, 'file:list');
    }
  }

  /** Filename search only; file contents are not scanned. */
  public async search(query: unknown, inputPath: unknown): Promise<ExecutionResult> {
    try {
      if (typeof query !== 'string' || query.trim().length < 1 || query.length > 80) throw new FileGuardError('unsupported', 'Search text must contain 1-80 characters.');
      const needle = query.trim().toLowerCase();
      const start = await this.resolveSafe(inputPath ?? '.', { mustExist: true });
      const results: string[] = [];
      let visited = 0;
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS || visited >= MAX_SEARCH_VISITS) return;
        let dirents: Dirent[];
        try { dirents = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
        for (const entry of dirents) {
          if (results.length >= MAX_SEARCH_RESULTS || visited >= MAX_SEARCH_VISITS) return;
          visited++;
          if (entry.isSymbolicLink() || SENSITIVE_SEGMENT.test(entry.name) || entry.name.toLowerCase() === QUARANTINE_DIR) continue;
          const full = join(directory, entry.name);
          if (entry.name.toLowerCase().includes(needle)) results.push(relative(start.root, full));
          if (entry.isDirectory()) await walk(full, depth + 1);
        }
      };
      await walk(start.absolute, 0);
      return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { query: query.trim(), matches: results, truncated: results.length >= MAX_SEARCH_RESULTS || visited >= MAX_SEARCH_VISITS }, evidence: { adapter: 'workspace-files', operation: 'file:search', visited, scope: 'file names only' } };
    } catch (error) {
      return this.toFailure(error, 'file:search');
    }
  }

  public async read(inputPath: unknown): Promise<ExecutionResult> {
    try {
      const target = await this.resolveSafe(inputPath, { mustExist: true });
      const { text, buffer } = await this.readTextFile(target.absolute);
      return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data: { path: target.relative, content: text, bytes: buffer.length }, evidence: { adapter: 'workspace-files', operation: 'file:read', bytes: buffer.length, sha256: sha256(buffer) } };
    } catch (error) {
      return this.toFailure(error, 'file:read');
    }
  }

  // ───── mutating operations (each verified by read-back) ─────

  public async write(inputPath: unknown, content: unknown): Promise<ExecutionResult> {
    try {
      if (typeof content !== 'string' || Buffer.byteLength(content, 'utf8') > MAX_TEXT_BYTES || content.includes('\u0000')) {
        throw new FileGuardError('unsupported', `Content must be text of at most ${MAX_TEXT_BYTES / 1024} KB.`);
      }
      const target = await this.resolveSafe(inputPath, { mustExist: false });
      if (target.relative === '.') throw new FileGuardError('unsupported', 'A file name is required.');
      await fs.mkdir(dirname(target.absolute), { recursive: true });
      // Re-validate after creating parents so a racing symlink cannot redirect the write.
      await this.resolveSafe(inputPath, { mustExist: false });
      await fs.writeFile(target.absolute, content, { encoding: 'utf8', flag: 'wx' });
      const expected = sha256(Buffer.from(content, 'utf8'));
      const actual = sha256(await fs.readFile(target.absolute));
      const verified = expected === actual;
      return {
        success: verified,
        outcome: verified ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.UNCERTAIN,
        data: { path: target.relative, bytes: Buffer.byteLength(content, 'utf8') },
        error: verified ? undefined : 'The file was written but its content did not verify.',
        evidence: { adapter: 'workspace-files', operation: 'file:write', sha256: actual, readBackVerified: verified },
      };
    } catch (error) {
      return this.toFailure(error, 'file:write');
    }
  }

  public async edit(inputPath: unknown, find: unknown, replacement: unknown): Promise<ExecutionResult> {
    try {
      if (typeof find !== 'string' || find.length < 1 || find.length > 10_000 || typeof replacement !== 'string' || replacement.length > 100_000) {
        throw new FileGuardError('unsupported', 'Find text must be 1-10000 characters and replacement at most 100000.');
      }
      const target = await this.resolveSafe(inputPath, { mustExist: true });
      const { text, buffer } = await this.readTextFile(target.absolute);
      const first = text.indexOf(find);
      if (first === -1) throw new FileGuardError('unavailable', 'The text to replace was not found; nothing was changed.');
      if (text.indexOf(find, first + find.length) !== -1) throw new FileGuardError('unsupported', 'The text to replace occurs more than once; be more specific. Nothing was changed.');
      const updated = text.slice(0, first) + replacement + text.slice(first + find.length);
      if (Buffer.byteLength(updated, 'utf8') > MAX_TEXT_BYTES) throw new FileGuardError('unsupported', 'The edited file would exceed the size limit.');
      const backup = await this.storeInQuarantine(target, 'backup', buffer);
      const temporary = `${target.absolute}.jarvis-${randomBytes(4).toString('hex')}.tmp`;
      await fs.writeFile(temporary, updated, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, target.absolute);
      const actual = sha256(await fs.readFile(target.absolute));
      const verified = actual === sha256(Buffer.from(updated, 'utf8'));
      return {
        success: verified,
        outcome: verified ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.UNCERTAIN,
        data: { path: target.relative, backupId: backup.id },
        error: verified ? undefined : 'The edit was applied but its content did not verify. The original is saved as a backup.',
        evidence: { adapter: 'workspace-files', operation: 'file:edit', sha256: actual, readBackVerified: verified, backupId: backup.id },
      };
    } catch (error) {
      return this.toFailure(error, 'file:edit');
    }
  }

  /** Delete = move one regular file into the managed quarantine (recoverable). */
  public async delete(inputPath: unknown): Promise<ExecutionResult> {
    try {
      const target = await this.resolveSafe(inputPath, { mustExist: true });
      const stat = await fs.stat(target.absolute);
      if (!stat.isFile()) throw new FileGuardError('unsupported', 'Only single files can be deleted; folders and bulk deletes are not supported.');
      const buffer = await fs.readFile(target.absolute);
      const entry = await this.storeInQuarantine(target, 'delete', buffer, true);
      let originalGone = false;
      try { await fs.lstat(target.absolute); } catch (error) { originalGone = (error as NodeJS.ErrnoException).code === 'ENOENT'; }
      const quarantinedOk = sha256(await fs.readFile(join(target.root, QUARANTINE_DIR, entry.storedRelative))) === entry.sha256;
      const verified = originalGone && quarantinedOk;
      return {
        success: verified,
        outcome: verified ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.UNCERTAIN,
        data: { path: target.relative, quarantineId: entry.id, recoverable: true },
        error: verified ? undefined : 'The file could not be confirmed as moved to quarantine.',
        evidence: { adapter: 'workspace-files', operation: 'file:delete', quarantineId: entry.id, originalRemoved: originalGone, quarantineVerified: quarantinedOk },
      };
    } catch (error) {
      return this.toFailure(error, 'file:delete');
    }
  }

  public async restore(quarantineId: unknown): Promise<ExecutionResult> {
    try {
      if (typeof quarantineId !== 'string' || !/^q-[a-f0-9]{16}$/.test(quarantineId)) throw new FileGuardError('unsupported', 'Invalid quarantine id.');
      for (const root of this.roots) {
        const manifest = await this.readManifest(root);
        const entry = manifest.find((candidate) => candidate.id === quarantineId && candidate.kind === 'delete' && !candidate.restored);
        if (!entry) continue;
        const destination = await this.resolveSafe(join(root, entry.originalRelative), { mustExist: false });
        try { await fs.lstat(destination.absolute); throw new FileGuardError('blocked', 'A file already exists at the original location; JARVIS will not overwrite it.'); }
        catch (error) { if (error instanceof FileGuardError) throw error; }
        const stored = join(root, QUARANTINE_DIR, entry.storedRelative);
        const buffer = await fs.readFile(stored);
        if (sha256(buffer) !== entry.sha256) throw new FileGuardError('blocked', 'The quarantined file no longer matches its recorded checksum; it was not restored.');
        await fs.mkdir(dirname(destination.absolute), { recursive: true });
        await fs.rename(stored, destination.absolute);
        entry.restored = true;
        await this.writeManifest(root, manifest);
        const verified = sha256(await fs.readFile(destination.absolute)) === entry.sha256;
        return {
          success: verified,
          outcome: verified ? VerificationOutcome.VERIFIED_SUCCESS : VerificationOutcome.UNCERTAIN,
          data: { path: destination.relative, quarantineId },
          error: verified ? undefined : 'The file was moved back but its content did not verify.',
          evidence: { adapter: 'workspace-files', operation: 'file:restore', quarantineId, checksumVerified: verified },
        };
      }
      throw new FileGuardError('unavailable', 'No restorable quarantined file has that id.');
    } catch (error) {
      return this.toFailure(error, 'file:restore');
    }
  }

  // ───── quarantine bookkeeping ─────

  private async readManifest(root: string): Promise<QuarantineEntry[]> {
    try {
      const parsed = JSON.parse(await fs.readFile(join(root, QUARANTINE_DIR, 'manifest.json'), 'utf8')) as unknown;
      return Array.isArray(parsed) ? (parsed as QuarantineEntry[]) : [];
    } catch {
      return [];
    }
  }

  private async writeManifest(root: string, entries: QuarantineEntry[]): Promise<void> {
    const directory = join(root, QUARANTINE_DIR);
    await fs.mkdir(directory, { recursive: true });
    const temporary = join(directory, `manifest.${randomBytes(4).toString('hex')}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2), 'utf8');
    await fs.rename(temporary, join(directory, 'manifest.json'));
  }

  private async storeInQuarantine(target: ResolvedPath, kind: 'delete' | 'backup', buffer: Buffer, move = false): Promise<QuarantineEntry> {
    const id = `q-${randomBytes(8).toString('hex')}`;
    const storedRelative = join(id, basename(target.absolute));
    const directory = join(target.root, QUARANTINE_DIR, id);
    await fs.mkdir(directory, { recursive: true });
    const destination = join(target.root, QUARANTINE_DIR, storedRelative);
    if (move) await fs.rename(target.absolute, destination);
    else await fs.writeFile(destination, buffer, { flag: 'wx' });
    const entry: QuarantineEntry = { id, kind, originalRelative: target.relative, storedRelative, quarantinedAt: Date.now(), bytes: buffer.length, sha256: sha256(buffer) };
    const manifest = await this.readManifest(target.root);
    manifest.push(entry);
    await this.writeManifest(target.root, manifest);
    return entry;
  }
}
