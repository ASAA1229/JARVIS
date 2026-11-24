import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Episode } from '../episodes';
import { tailTranscript, type FileCursor } from './tail';

/** Claude Code names a project folder after its path with every non-alphanumeric character replaced by "-". */
export const encodeProjectDir = (folder: string): string => folder.replace(/[^A-Za-z0-9]/g, '-');

/** Picks which project folders under ~/.claude/projects may be read. Empty selection = current workspace folders only. */
export function selectProjectDirs(available: readonly string[], workspaceFolders: readonly string[], configured: readonly string[]): string[] {
  const wanted = new Set<string>();
  const sources = configured.length ? configured : workspaceFolders;
  for (const entry of sources) { wanted.add(entry.toLowerCase()); wanted.add(encodeProjectDir(entry).toLowerCase()); }
  return available.filter((dir) => wanted.has(dir.toLowerCase()));
}

export interface WatcherDeps {
  projectsRoot: string;
  workspaceFolders(): string[];
  configuredProjects(): string[];
  backfill(): boolean;
  firstRun: number;
  cursors: Record<string, FileCursor>;
  saveCursors(cursors: Record<string, FileCursor>): void;
  submit(episode: Episode): void;
  log(message: string): void;
  idleMs?: number;
  now?: () => number;
}

export class TranscriptWatcher {
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly deps: WatcherDeps) {}

  start(intervalMs = 5000): void {
    this.stop();
    this.timer = setInterval(() => this.poll(), intervalMs);
    this.poll();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  poll(): void {
    const { projectsRoot } = this.deps;
    if (!existsSync(projectsRoot)) return;
    const now = (this.deps.now ?? Date.now)();
    let changed = false;
    try {
      const available = readdirSync(projectsRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
      for (const dir of selectProjectDirs(available, this.deps.workspaceFolders(), this.deps.configuredProjects())) {
        const folder = join(projectsRoot, dir);
        for (const name of readdirSync(folder)) {
          if (!name.endsWith('.jsonl')) continue;
          const file = join(folder, name);
          try {
            const stat = statSync(file);
            let cursor = this.deps.cursors[file];
            if (!cursor) {
              const preexisting = stat.birthtimeMs < this.deps.firstRun;
              cursor = { offset: preexisting && !this.deps.backfill() ? stat.size : 0 };
            }
            const idle = now - stat.mtimeMs > (this.deps.idleMs ?? 90_000);
            const result = tailTranscript(file, cursor, { idle });
            if (result.cursor.unknown && !cursor.unknown) this.deps.log(`Skipped unrecognised transcript format: ${name}`);
            if (JSON.stringify(result.cursor) !== JSON.stringify(this.deps.cursors[file])) { this.deps.cursors[file] = result.cursor; changed = true; }
            for (const episode of result.episodes) this.deps.submit(episode);
          } catch (error) {
            this.deps.log(`Transcript read failed for ${name}: ${error instanceof Error ? error.message : 'error'}`);
          }
        }
      }
    } catch (error) {
      this.deps.log(`Transcript scan failed: ${error instanceof Error ? error.message : 'error'}`);
    }
    if (changed) this.deps.saveCursors(this.deps.cursors);
  }
}
