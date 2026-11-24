/**
 * Owner-approved workspace roots. Only a folder the owner added (through the approval flow)
 * is reachable by the Code view; the stored path is the real path at approval time.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { homedir } from 'node:os';

export interface WorkspaceRoot { name: string; path: string; addedAt: string }

export const ROOT_NAME = /^[a-z0-9][a-z0-9-]{1,40}$/;
const MAX_ROOTS = 20;

export class WorkspaceRegistry {
  private roots: WorkspaceRoot[] = [];

  constructor(private readonly filePath: string) {
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as { version?: number; roots?: WorkspaceRoot[] };
      if (parsed.version === 1 && Array.isArray(parsed.roots)) {
        this.roots = parsed.roots.filter((root) => root && ROOT_NAME.test(root.name) && typeof root.path === 'string' && isAbsolute(root.path));
      }
    } catch { /* a corrupt registry grants nothing */ }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, roots: this.roots }, null, 2) + '\n', { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }

  list(): WorkspaceRoot[] {
    return this.roots.map((root) => ({ ...root }));
  }

  get(name: string): WorkspaceRoot | undefined {
    const root = this.roots.find((item) => item.name === String(name ?? '').toLowerCase());
    return root ? { ...root } : undefined;
  }

  /** The root, still present on disk, or an error naming the problem. Unapproved names are refused. */
  require(name: string): WorkspaceRoot {
    const root = this.get(name);
    if (!root) throw new Error(`"${String(name ?? '').slice(0, 41)}" is not an approved workspace root. Add the folder and approve it first.`);
    if (!existsSync(root.path)) throw new Error(`The folder for workspace "${root.name}" no longer exists.`);
    return root;
  }

  /** Validate a proposed root without storing it (used before asking for approval). */
  check(name: string, path: string): { name: string; path: string } {
    const normalizedName = String(name ?? '').toLowerCase();
    if (!ROOT_NAME.test(normalizedName)) throw new Error('Workspace name must be 2-41 lowercase letters, digits or hyphens.');
    const cleaned = String(path ?? '').trim().replace(/^["']|["']$/g, '');
    if (!cleaned || cleaned.includes('\0') || !isAbsolute(cleaned)) throw new Error('Give the full (absolute) path of the folder.');
    const absolute = resolve(cleaned);
    if (!existsSync(absolute) || !statSync(absolute).isDirectory()) throw new Error('That folder does not exist.');
    const real = realpathSync.native(absolute);
    if (parse(real).root === real) throw new Error('A drive or filesystem root cannot be a workspace.');
    if (resolve(real).toLowerCase() === resolve(homedir()).toLowerCase()) throw new Error('Your whole home folder cannot be a workspace; choose a project folder.');
    if (!this.roots.some((root) => root.name === normalizedName) && this.roots.length >= MAX_ROOTS) throw new Error('Too many workspace roots.');
    return { name: normalizedName, path: real };
  }

  add(name: string, path: string): WorkspaceRoot {
    const checked = this.check(name, path);
    const existing = this.roots.findIndex((root) => root.name === checked.name);
    const root: WorkspaceRoot = { name: checked.name, path: checked.path, addedAt: new Date().toISOString() };
    if (existing >= 0) this.roots[existing] = root;
    else this.roots.push(root);
    this.persist();
    return { ...root };
  }

  remove(name: string): boolean {
    const before = this.roots.length;
    this.roots = this.roots.filter((root) => root.name !== String(name ?? '').toLowerCase());
    if (this.roots.length === before) return false;
    this.persist();
    return true;
  }
}
