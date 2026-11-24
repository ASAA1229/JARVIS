import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', 'dist', 'build', 'out']);

function hasGitDirectory(folder: string): boolean {
  try { return statSync(join(folder, '.git')).isDirectory(); } catch { return false; }
}

/**
 * Repositories to watch for one workspace folder: the folder itself when it is a repository, and repositories one
 * level inside it (a folder that holds several projects). Only real .git directories count; worktrees and submodules
 * (where .git is a file) are not watched.
 */
export function repositoryRoots(workspaceFolder: string): string[] {
  const roots: string[] = [];
  if (hasGitDirectory(workspaceFolder)) roots.push(workspaceFolder);
  if (!existsSync(workspaceFolder)) return roots;
  let entries: string[] = [];
  try { entries = readdirSync(workspaceFolder); } catch { return roots; }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith('.')) continue;
    const child = join(workspaceFolder, name);
    try { if (statSync(child).isDirectory() && hasGitDirectory(child)) roots.push(child); } catch { /* unreadable */ }
  }
  return roots;
}

/** Maps <repo>/.git/logs/HEAD to <repo>; anything else to null. */
export function repoRootFromHeadLog(headLogPath: string): string | null {
  const normalized = headLogPath.replace(/\\/g, '/');
  if (!/\/\.git\/logs\/HEAD$/.test(normalized)) return null;
  return dirname(dirname(dirname(headLogPath)));
}
