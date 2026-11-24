/**
 * Workspace service: read-only browsing (tree, read, search) and the state-changing `workspace:*`
 * operations. State changes are only reachable through JarvisCoreService.submitOperations, so the
 * policy gateway (owner, approval), the task journal and the audit chain always apply.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ExecutionResult, VerificationOutcome } from '../core/types.js';
import {
  IGNORED_DIRS, MAX_READ_BYTES, MAX_WRITE_BYTES, WorkspacePathError, isDeniedWorkspacePath, languageFor, resolveInWorkspace, sniffBinary,
} from './workspacePaths.js';
import { WorkspaceRegistry, type WorkspaceRoot } from './workspaceRegistry.js';
import { applyFileDiff, createUnifiedDiff, parseUnifiedDiff, splitLines } from './unifiedDiff.js';

import { WORKSPACE_OPERATIONS, type WorkspaceOperation } from './operations.js';
export { WORKSPACE_OPERATIONS, type WorkspaceOperation };

const MAX_TREE_ENTRIES = 1000;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_FILES = 5000;
const MAX_SEARCH_FILE_BYTES = 512 * 1024;
const SEARCH_DEADLINE_MS = 5000;
const MAX_QUERY_CHARS = 200;
const MAX_DIFF_FILES = 10;
export const MAX_DIFF_CHARS = 2 * 1024 * 1024;

export interface TreeEntry { name: string; path: string; type: 'dir' | 'file'; size?: number }
export interface FileContent { path: string; content: string; size: number; hash: string; language: string; mtimeMs: number }
export interface SearchHit { path: string; kind: 'name' | 'text'; line?: number; text?: string }
export interface SearchResult { results: SearchHit[]; truncated: boolean; scannedFiles: number }
export interface DiffPreviewFile { path: string; isNew: boolean; baseHash: string | null; newContent: string; diff: string }
export interface DiffPreview { files: DiffPreviewFile[]; diff: string }

export const hashText = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

function ok(data: unknown, evidence: Record<string, unknown> = {}): ExecutionResult {
  return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data, evidence: { workspace: true, ...evidence } };
}
function fail(error: unknown, evidence: Record<string, unknown> = {}): ExecutionResult {
  return {
    success: false, outcome: VerificationOutcome.VERIFIED_FAILURE,
    error: error instanceof Error ? error.message : String(error), evidence: { workspace: true, ...evidence },
  };
}

function atomicWrite(absolute: string, content: string): void {
  mkdirSync(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${randomBytes(4).toString('hex')}.jarvis-tmp`;
  writeFileSync(temporary, content, 'utf8');
  renameSync(temporary, absolute);
}

export class WorkspaceService {
  readonly roots: WorkspaceRegistry;
  private readonly trashDir: string;

  constructor(stateBase: string) {
    this.roots = new WorkspaceRegistry(`${stateBase}/roots.json`);
    this.trashDir = `${stateBase}/trash`;
  }

  listRoots(): WorkspaceRoot[] {
    return this.roots.list();
  }

  // ---------------- read-only browsing ----------------

  tree(rootName: string, path = ''): { path: string; entries: TreeEntry[]; truncated: boolean } {
    const root = this.roots.require(rootName);
    const target = resolveInWorkspace(root.path, path, 'read');
    if (!existsSync(target.absolute) || !statSync(target.absolute).isDirectory()) throw new Error('That folder does not exist.');
    const entries: TreeEntry[] = [];
    let truncated = false;
    for (const entry of readdirSync(target.absolute, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relativePath = target.relative ? `${target.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name.toLowerCase())) continue;
        entries.push({ name: entry.name, path: relativePath, type: 'dir' });
      } else if (entry.isFile()) {
        if (isDeniedWorkspacePath(relativePath, 'read') || entry.name.endsWith('.jarvis-tmp')) continue;
        let size: number | undefined;
        try { size = statSync(join(target.absolute, entry.name)).size; } catch { /* vanished */ }
        entries.push({ name: entry.name, path: relativePath, type: 'file', ...(size !== undefined ? { size } : {}) });
      }
      if (entries.length >= MAX_TREE_ENTRIES) { truncated = true; break; }
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return { path: target.relative, entries, truncated };
  }

  readFile(rootName: string, path: string): FileContent {
    const root = this.roots.require(rootName);
    const target = resolveInWorkspace(root.path, path, 'read');
    if (!target.relative) throw new WorkspacePathError('Name a file to read.');
    if (!existsSync(target.absolute)) throw new Error('That file does not exist.');
    const stats = statSync(target.absolute);
    if (!stats.isFile()) throw new Error('That path is not a file.');
    if (stats.size > MAX_READ_BYTES) throw new Error(`That file is larger than the ${MAX_READ_BYTES / 1024} KiB editor limit.`);
    if (sniffBinary(target.absolute)) throw new Error('That looks like a binary file; it is not opened.');
    const content = readFileSync(target.absolute, 'utf8');
    return { path: target.relative, content, size: stats.size, hash: hashText(content), language: languageFor(target.relative), mtimeMs: stats.mtimeMs };
  }

  search(rootName: string, query: string, options: { mode?: 'name' | 'text' | 'both'; path?: string; maxResults?: number } = {}): SearchResult {
    const root = this.roots.require(rootName);
    const needle = String(query ?? '').trim();
    if (!needle || needle.length > MAX_QUERY_CHARS) throw new Error(`Search text must be 1-${MAX_QUERY_CHARS} characters.`);
    const mode = options.mode ?? 'both';
    const limit = Math.min(Math.max(options.maxResults ?? MAX_SEARCH_RESULTS, 1), MAX_SEARCH_RESULTS);
    const start = resolveInWorkspace(root.path, options.path ?? '', 'read');
    const lower = needle.toLowerCase();
    const results: SearchHit[] = [];
    const deadline = Date.now() + SEARCH_DEADLINE_MS;
    const stack: string[] = [start.relative];
    let scanned = 0;
    let truncated = false;
    walk: while (stack.length) {
      const directory = stack.pop()!;
      let entries;
      try { entries = readdirSync(directory ? join(root.path, directory) : root.path, { withFileTypes: true }); } catch { continue; }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (!IGNORED_DIRS.has(entry.name.toLowerCase())) stack.push(relativePath);
          continue;
        }
        if (!entry.isFile() || isDeniedWorkspacePath(relativePath, 'read')) continue;
        if (++scanned > MAX_SEARCH_FILES || Date.now() > deadline) { truncated = true; break walk; }
        if ((mode === 'name' || mode === 'both') && entry.name.toLowerCase().includes(lower)) {
          results.push({ path: relativePath, kind: 'name' });
          if (results.length >= limit) { truncated = true; break walk; }
        }
        if (mode === 'name') continue;
        const absolute = join(root.path, relativePath);
        let stats;
        try { stats = statSync(absolute); } catch { continue; }
        if (stats.size > MAX_SEARCH_FILE_BYTES || stats.size === 0) continue;
        let buffer: Buffer;
        try { buffer = readFileSync(absolute); } catch { continue; }
        if (buffer.subarray(0, 8000).includes(0)) continue;
        const lines = buffer.toString('utf8').split('\n');
        for (let index = 0; index < lines.length; index++) {
          if (lines[index]!.toLowerCase().includes(lower)) {
            results.push({ path: relativePath, kind: 'text', line: index + 1, text: lines[index]!.slice(0, 200).trimEnd() });
            if (results.length >= limit) { truncated = true; break walk; }
          }
        }
      }
    }
    return { results, truncated, scannedFiles: Math.min(scanned, MAX_SEARCH_FILES) };
  }

  // ---------------- previews (read-only; what the owner sees before approving) ----------------

  previewWrite(rootName: string, path: string, content: string): { path: string; isNew: boolean; baseHash: string | null; diff: string; changed: boolean } {
    const root = this.roots.require(rootName);
    const target = resolveInWorkspace(root.path, path, 'write');
    if (!target.relative) throw new WorkspacePathError('Name a file to write.');
    if (typeof content !== 'string') throw new Error('content must be a string.');
    if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error('The new content is larger than the 1 MiB limit.');
    if (content.includes('\0')) throw new Error('Content with NUL bytes (binary) cannot be written.');
    if (!existsSync(target.absolute)) {
      return { path: target.relative, isNew: true, baseHash: null, diff: createUnifiedDiff(target.relative, null, content), changed: true };
    }
    const current = this.readFile(rootName, target.relative);
    const next = this.matchEol(current.content, content);
    const diff = createUnifiedDiff(target.relative, current.content, next);
    return { path: target.relative, isNew: false, baseHash: current.hash, diff, changed: diff !== '' };
  }

  /** Validate and apply a model- or user-supplied unified diff in memory; nothing is written. */
  previewDiff(rootName: string, diff: string): DiffPreview {
    const root = this.roots.require(rootName);
    if (typeof diff !== 'string' || !diff.trim()) throw new Error('The diff is empty.');
    if (diff.length > MAX_DIFF_CHARS) throw new Error('The diff is too large.');
    const parsed = parseUnifiedDiff(diff);
    if (!parsed.length) throw new Error('No file changes were found in the diff.');
    if (parsed.length > MAX_DIFF_FILES) throw new Error(`A diff may touch at most ${MAX_DIFF_FILES} files.`);
    const seen = new Set<string>();
    const files: DiffPreviewFile[] = [];
    for (const file of parsed) {
      if (file.newPath === null) throw new Error('Deleting files through a diff is not supported; use delete.');
      if (file.oldPath !== null && file.oldPath !== file.newPath) throw new Error('Renaming files through a diff is not supported; use rename.');
      const target = resolveInWorkspace(root.path, file.newPath, 'write');
      if (!target.relative || seen.has(target.relative)) throw new Error('The diff names a file twice or an empty path.');
      seen.add(target.relative);
      const exists = existsSync(target.absolute);
      if (file.oldPath === null && exists) throw new Error(`"${target.relative}" already exists; the diff would create it.`);
      if (file.oldPath !== null && !exists) throw new Error(`"${target.relative}" does not exist.`);
      const current = exists ? this.readFile(rootName, target.relative) : null;
      const newContent = applyFileDiff(current ? current.content : null, file);
      if (Buffer.byteLength(newContent, 'utf8') > MAX_WRITE_BYTES) throw new Error(`"${target.relative}" would exceed the 1 MiB limit.`);
      if (newContent.includes('\0')) throw new Error('The diff would write binary content.');
      files.push({
        path: target.relative, isNew: !exists, baseHash: current?.hash ?? null, newContent,
        diff: createUnifiedDiff(target.relative, current ? current.content : null, newContent),
      });
    }
    return { files, diff: files.map((file) => file.diff).join('') };
  }

  private matchEol(current: string, next: string): string {
    const currentEol = splitLines(current).eol;
    const normalized = next.replace(/\r\n/g, '\n');
    return currentEol === '\r\n' ? normalized.replace(/\n/g, '\r\n') : normalized;
  }

  // ---------------- state-changing operations (called by the service after policy + approval) ----------------

  async execute(operation: string, parameters: Record<string, unknown>): Promise<ExecutionResult> {
    const text = (key: string): string => (typeof parameters[key] === 'string' ? (parameters[key] as string) : '');
    try {
      switch (operation as WorkspaceOperation) {
        case 'workspace:root_list': return ok(this.listRoots());
        case 'workspace:root_add': {
          const root = this.roots.add(text('name'), text('path'));
          return ok(root, { root: root.name });
        }
        case 'workspace:root_remove': {
          const removed = this.roots.remove(text('name'));
          return removed ? ok({ removed: text('name') }, { root: text('name') }) : fail('No such workspace root.');
        }
        case 'workspace:read': return ok(this.readFile(text('root'), text('path')));
        case 'workspace:search': return ok(this.search(text('root'), text('query')));
        case 'workspace:create': {
          const root = this.roots.require(text('root'));
          const target = resolveInWorkspace(root.path, text('path'), 'write');
          if (!target.relative) throw new WorkspacePathError('Name a file to create.');
          if (existsSync(target.absolute)) return fail(`"${target.relative}" already exists.`);
          const preview = this.previewWrite(text('root'), target.relative, text('content'));
          atomicWrite(target.absolute, text('content'));
          const verified = hashText(readFileSync(target.absolute, 'utf8')) === hashText(text('content'));
          return verified
            ? ok({ path: target.relative, hash: hashText(text('content')) }, { root: root.name, path: target.relative, diffChars: preview.diff.length, verifiedBy: 'content hash after write' })
            : fail('The file could not be verified after writing.');
        }
        case 'workspace:write': {
          const root = this.roots.require(text('root'));
          const target = resolveInWorkspace(root.path, text('path'), 'write');
          if (!target.relative) throw new WorkspacePathError('Name a file to write.');
          if (!existsSync(target.absolute)) return fail('That file does not exist; create it instead.');
          const baseHash = text('baseHash');
          if (!baseHash) return fail('baseHash is required so a changed file is never overwritten blindly.');
          const preview = this.previewWrite(text('root'), target.relative, text('content'));
          if (preview.baseHash !== baseHash) return fail('The file changed on disk since you opened it; reload it and review the diff again.', { stale: true });
          const content = this.matchEol(this.readFile(text('root'), target.relative).content, text('content'));
          atomicWrite(target.absolute, content);
          const written = readFileSync(target.absolute, 'utf8');
          return written === content
            ? ok({ path: target.relative, hash: hashText(written) }, { root: root.name, path: target.relative, diffChars: preview.diff.length, verifiedBy: 'content hash after write' })
            : fail('The file could not be verified after writing.');
        }
        case 'workspace:apply_diff': {
          const root = this.roots.require(text('root'));
          const preview = this.previewDiff(root.name, text('diff'));
          const written: string[] = [];
          for (const file of preview.files) {
            const target = resolveInWorkspace(root.path, file.path, 'write');
            atomicWrite(target.absolute, file.newContent);
            if (readFileSync(target.absolute, 'utf8') !== file.newContent) return fail(`"${file.path}" could not be verified after writing.`, { written });
            written.push(file.path);
          }
          return ok({ files: written }, { root: root.name, files: written, verifiedBy: 'content read-back after write' });
        }
        case 'workspace:rename': {
          const root = this.roots.require(text('root'));
          const from = resolveInWorkspace(root.path, text('path'), 'write');
          const to = resolveInWorkspace(root.path, text('to'), 'write');
          if (!from.relative || !to.relative) throw new WorkspacePathError('Name both the current and the new path.');
          if (!existsSync(from.absolute)) return fail('Nothing exists at the current path.');
          if (existsSync(to.absolute)) return fail('Something already exists at the new path.');
          mkdirSync(dirname(to.absolute), { recursive: true });
          renameSync(from.absolute, to.absolute);
          return existsSync(to.absolute) && !existsSync(from.absolute)
            ? ok({ from: from.relative, to: to.relative }, { root: root.name, from: from.relative, to: to.relative })
            : fail('The rename could not be verified.');
        }
        case 'workspace:delete': {
          const root = this.roots.require(text('root'));
          const target = resolveInWorkspace(root.path, text('path'), 'write');
          if (!target.relative) throw new WorkspacePathError('Refusing to delete the workspace root.');
          if (!existsSync(target.absolute)) return fail('Nothing exists at that path.');
          const stats = statSync(target.absolute);
          if (stats.isDirectory()) {
            if (readdirSync(target.absolute).length) return fail('Only empty folders can be deleted; delete the files first.');
            rmdirSync(target.absolute);
            return !existsSync(target.absolute) ? ok({ path: target.relative, kind: 'dir' }, { root: root.name }) : fail('The folder could not be removed.');
          }
          // Files are moved to a recoverable trash folder, not destroyed.
          const trashId = `${Date.now()}-${randomBytes(3).toString('hex')}`;
          const trashPath = join(this.trashDir, trashId, basename(target.absolute));
          mkdirSync(dirname(trashPath), { recursive: true });
          copyFileSync(target.absolute, trashPath);
          unlinkSync(target.absolute);
          return !existsSync(target.absolute)
            ? ok({ path: target.relative, trashId }, { root: root.name, trashId })
            : fail('The file could not be removed.');
        }
        default: return fail(`Unknown workspace operation ${operation}.`);
      }
    } catch (error) {
      return fail(error);
    }
  }
}
