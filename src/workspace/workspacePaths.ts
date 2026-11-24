/**
 * Path safety for owner-approved workspace roots (JARVIS Studio, Code view).
 *
 * Every request names a root the owner approved plus a root-relative path. The path is
 * rejected when it is absolute, contains `..`, NUL or Windows stream syntax, resolves (after
 * following symbolic links / junctions) outside the root, or names a secret file or .git internals.
 */
import { closeSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const MAX_READ_BYTES = 1024 * 1024;
export const MAX_WRITE_BYTES = 1024 * 1024;

/** Directories hidden from trees and searches (never offered; node_modules/.git are also write-denied). */
export const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist']);

const SECRET_FILE = /(^\.env(\..*)?$)|(\.(pem|key|p12|pfx|jks|keystore|kdbx)$)|(^id_[a-z0-9_]+(\.pub)?$)|(^token\.txt$)|(^credentials(\..*)?$)|(^\.npmrc$)|(^\.dev\.vars$)/i;

/** Windows silently drops trailing dots and spaces from names, so `Token.txt.` is `Token.txt`. */
function canonicalSegment(segment: string): string {
  return segment.replace(/[. ]+$/, '').toLowerCase();
}

export type AccessKind = 'read' | 'write';

/** True when the relative path must never be read or written. */
export function isDeniedWorkspacePath(relativePath: string, kind: AccessKind = 'read'): boolean {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter((part) => part && part !== '.');
  for (const raw of parts) {
    const part = canonicalSegment(raw);
    if (part === '.git' || part.startsWith('.git~')) return true;
    if (kind === 'write' && part === 'node_modules') return true;
  }
  const file = canonicalSegment(parts[parts.length - 1] ?? '');
  return SECRET_FILE.test(file);
}

export class WorkspacePathError extends Error {
  constructor(message: string, readonly code: 'denied' | 'outside' | 'invalid' = 'invalid') {
    super(message);
    this.name = 'WorkspacePathError';
  }
}

function realOrNearest(path: string): string {
  let current = path;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync.native(current);
      return tail.length ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(current.slice(parent.length).replace(/^[\\/]+/, ''));
      current = parent;
    }
  }
}

function inside(rootReal: string, candidate: string): string | null {
  const rel = relative(rootReal, candidate);
  if (rel === '') return '';
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

export interface ResolvedPath { absolute: string; relative: string }

/**
 * Resolve a root-relative path safely. `rootPath` must already be the real path of an approved root.
 */
export function resolveInWorkspace(rootPath: string, requested: string, kind: AccessKind = 'read'): ResolvedPath {
  const text = String(requested ?? '').trim();
  if (text.includes('\0')) throw new WorkspacePathError('Invalid path.');
  const cleaned = text.replace(/\\/g, '/');
  if (isAbsolute(text) || /^[A-Za-z]:/.test(cleaned) || cleaned.startsWith('/') || cleaned.startsWith('//')) {
    throw new WorkspacePathError('Use a path relative to the workspace root.', 'outside');
  }
  const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.some((part) => part === '..')) throw new WorkspacePathError('Path traversal (..) is not allowed.', 'outside');
  if (parts.some((part) => /[<>"|?*:]/.test(part))) throw new WorkspacePathError('Path contains characters that are not allowed.');
  const normalized = parts.join('/');
  if (normalized && isDeniedWorkspacePath(normalized, kind)) {
    throw new WorkspacePathError('That path is protected (secrets or git internals) and cannot be accessed.', 'denied');
  }
  const rootReal = realOrNearest(rootPath);
  const absolute = resolve(rootReal, ...parts);
  const direct = inside(rootReal, absolute);
  if (direct === null) throw new WorkspacePathError('That path is outside the workspace root.', 'outside');
  // Follow links on the deepest existing part; a link must not smuggle in an outside or protected target.
  const real = realOrNearest(absolute);
  const realRel = inside(rootReal, real);
  if (realRel === null) throw new WorkspacePathError('That path resolves outside the workspace root through a symbolic link.', 'outside');
  if (realRel && isDeniedWorkspacePath(realRel, kind)) {
    throw new WorkspacePathError('That path is protected (secrets or git internals) and cannot be accessed.', 'denied');
  }
  return { absolute, relative: normalized };
}

/** Heuristic binary check on the first bytes of a file: NUL bytes or mostly non-text control bytes. */
export function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 8000);
  if (sample.includes(0)) return true;
  let control = 0;
  for (const byte of sample) if (byte < 7 || (byte > 14 && byte < 32 && byte !== 27)) control++;
  return sample.length > 0 && control / sample.length > 0.1;
}

export function sniffBinary(absolutePath: string): boolean {
  const fd = openSync(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(8000);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return looksBinary(buffer.subarray(0, read));
  } finally {
    closeSync(fd);
  }
}

const LANGUAGES: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', json: 'json', jsonc: 'json',
  py: 'py', md: 'md', markdown: 'md', css: 'css', html: 'html', htm: 'html',
};
export function languageFor(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return (match && LANGUAGES[match[1]!.toLowerCase()]) || 'text';
}
