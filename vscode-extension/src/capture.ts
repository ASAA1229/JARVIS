import { execFile } from 'node:child_process';
import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { classifyCommand, isTrivialCommand } from './classify';
import { commandTouchesExcluded, head, lineDiffStat, matchesExclude, stableId, stripAnsi, tail, type Episode, type EpisodeStep } from './episodes';
import { filterDiff, isAssistantCommit, parseGitShow } from './gitParse';
import type { Pipeline } from './pipeline';
import { isExcludedPath } from './redact';

export interface CaptureDeps {
  pipeline: Pipeline;
  enabled(source: 'git' | 'terminal' | 'diagnostics' | 'saves'): boolean;
  excludePaths(): string[];
  maxDiffBytes(): number;
  log(message: string): void;
}

const folders = () => vscode.workspace.workspaceFolders ?? [];
const inWorkspace = (fsPath: string) => folders().some((f) => fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase() + sep) || fsPath.toLowerCase() === f.uri.fsPath.toLowerCase());
const relPath = (fsPath: string) => {
  const folder = folders().find((f) => fsPath.toLowerCase().startsWith(f.uri.fsPath.toLowerCase()));
  return (folder ? relative(folder.uri.fsPath, fsPath) : fsPath).replace(/\\/g, '/');
};
const skipPath = (deps: CaptureDeps, path: string) => isExcludedPath(path) || matchesExclude(path, deps.excludePaths());
const run = (cwd: string, args: string[]) => new Promise<string>((resolve, reject) =>
  execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, timeout: 10_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout))));

/** Git: a file watcher on .git/logs/HEAD notices commits; the commit is then read with local `git show`. */
export function startGitCapture(deps: CaptureDeps, subscriptions: vscode.Disposable[]): void {
  const known = new Map<string, string>();
  const handle = async (root: string) => {
    if (!deps.enabled('git')) return;
    try {
      const head1 = (await run(root, ['rev-parse', 'HEAD'])).trim();
      const previous = known.get(root);
      known.set(root, head1);
      if (!previous || previous === head1) return; // first sight, or no new commit
      const parsed = parseGitShow(await run(root, ['show', '--numstat', '--format=%H%x1e%B%x1e', head1]));
      if (!parsed) return;
      const patch = await run(root, ['show', '--format=', '--patch', '-U2', '--no-color', head1]).catch(() => '');
      const files = parsed.files.filter((f) => !skipPath(deps, f.path));
      const assistant = isAssistantCommit(parsed.message);
      const now = new Date().toISOString();
      const steps: EpisodeStep[] = [
        { kind: 'commit', assistantGenerated: assistant, summary: head(parsed.message, 2000),
          diffStat: { files: files.length, insertions: files.reduce((s, f) => s + f.insertions, 0), deletions: files.reduce((s, f) => s + f.deletions, 0) },
          diff: filterDiff(patch, deps.excludePaths(), deps.maxDiffBytes()) },
        ...files.slice(0, 40).map((f): EpisodeStep => ({ kind: 'edit', assistantGenerated: assistant, path: f.path, diffStat: { insertions: f.insertions, deletions: f.deletions } })),
      ];
      const linked = deps.pipeline.recentEpisodeIds(30 * 60_000);
      const episode: Episode = {
        schemaVersion: 1, id: stableId('git', root, parsed.hash), source: 'git', startedAt: now, endedAt: now,
        workspace: root.replace(/\\/g, '/').split('/').pop() ?? '', assistantGenerated: assistant, steps,
        outcome: { status: 'success' }, ...(linked.length ? { linkedEpisodeIds: linked.slice(-20) } : {}),
      };
      await deps.pipeline.submit(episode);
    } catch (error) { deps.log(`git capture: ${error instanceof Error ? error.message : 'failed'}`); }
  };
  for (const folder of folders()) {
    const root = folder.uri.fsPath;
    void run(root, ['rev-parse', 'HEAD']).then((h) => known.set(root, h.trim())).catch(() => undefined);
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '.git/logs/HEAD'));
    let timer: NodeJS.Timeout | undefined;
    const debounced = () => { if (timer) clearTimeout(timer); timer = setTimeout(() => void handle(root), 1200); };
    subscriptions.push(watcher, watcher.onDidChange(debounced), watcher.onDidCreate(debounced));
  }
}

/** Terminal: needs shell integration. Output is tailed from the execution stream and truncated. */
export function startTerminalCapture(deps: CaptureDeps, subscriptions: vscode.Disposable[]): void {
  const buffers = new Map<vscode.TerminalShellExecution, { text: string; started: string }>();
  subscriptions.push(
    vscode.window.onDidStartTerminalShellExecution((event) => {
      if (!deps.enabled('terminal')) return;
      const entry = { text: '', started: new Date().toISOString() };
      buffers.set(event.execution, entry);
      void (async () => {
        try { for await (const chunk of event.execution.read()) entry.text = tail(entry.text + chunk, 12_000); } catch { /* stream ended */ }
      })();
    }),
    vscode.window.onDidEndTerminalShellExecution((event) => {
      const entry = buffers.get(event.execution);
      buffers.delete(event.execution);
      if (!entry || !deps.enabled('terminal')) return;
      const command = event.execution.commandLine.value.trim();
      const cwd = event.execution.cwd?.fsPath;
      if (!command || isTrivialCommand(command) || commandTouchesExcluded(command) || (cwd && !inWorkspace(cwd))) return;
      const exitCode = event.exitCode;
      const output = tail(stripAnsi(entry.text).replace(/\r/g, '').trim(), 800);
      const episode: Episode = {
        schemaVersion: 1, id: stableId('term', entry.started, command, cwd ?? ''), source: 'terminal', startedAt: entry.started, endedAt: new Date().toISOString(),
        ...(cwd ? { workspace: cwd.replace(/\\/g, '/').split('/').pop() ?? '' } : {}), assistantGenerated: false,
        steps: [{ kind: 'command', assistantGenerated: false, command: head(command, 2000), commandClass: classifyCommand(command),
          ...(exitCode !== undefined ? { exitCode } : {}), outputTail: output }],
        outcome: { status: exitCode === undefined ? 'unknown' : exitCode === 0 ? 'success' : 'failure' },
      };
      void deps.pipeline.submit(episode);
    }),
  );
}

/** Diagnostics: remember a file's errors; when they later drop, emit the error -> fix pair (counts plus messages). */
export function startDiagnosticsCapture(deps: CaptureDeps, subscriptions: vscode.Disposable[], lastSaveStat: (path: string) => EpisodeStep['diffStat'] | undefined): void {
  const open = new Map<string, { count: number; messages: string[]; at: string }>();
  let timer: NodeJS.Timeout | undefined;
  const pending = new Set<string>();
  const errorsOf = (uri: vscode.Uri) => vscode.languages.getDiagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
  const evaluate = () => {
    for (const key of pending) {
      const uri = vscode.Uri.parse(key);
      const path = relPath(uri.fsPath);
      if (!deps.enabled('diagnostics') || uri.scheme !== 'file' || !inWorkspace(uri.fsPath) || skipPath(deps, path)) continue;
      const errors = errorsOf(uri);
      const before = open.get(key);
      if (errors.length > 0) {
        open.set(key, { count: before ? Math.max(before.count, errors.length) : errors.length, at: before?.at ?? new Date().toISOString(),
          messages: (before?.messages.length ? before.messages : errors.slice(0, 5).map((d) => head(`${d.source ?? ''}${d.code !== undefined ? ' ' + String(typeof d.code === 'object' ? d.code.value : d.code) : ''}: ${d.message}`.trim(), 300))) });
      } else if (before) {
        open.delete(key);
        const stat = lastSaveStat(path);
        void deps.pipeline.submit({
          schemaVersion: 1, id: stableId('diag', key, before.at), source: 'diagnostics', startedAt: before.at, endedAt: new Date().toISOString(), assistantGenerated: false,
          steps: [{ kind: 'diagnostics', assistantGenerated: false, path, diagnostics: { before: before.count, after: 0, messages: before.messages }, ...(stat ? { diffStat: stat } : {}) }],
          outcome: { status: 'success', summary: `${before.count} error(s) cleared` },
        });
      }
    }
    pending.clear();
  };
  subscriptions.push(vscode.languages.onDidChangeDiagnostics((event) => {
    for (const uri of event.uris) pending.add(uri.toString());
    if (timer) clearTimeout(timer);
    timer = setTimeout(evaluate, 2000);
  }));
}

/** Saves: path and line-diff statistics only, batched per minute. Content is never sent. */
export function startSaveCapture(deps: CaptureDeps, subscriptions: vscode.Disposable[]): (path: string) => EpisodeStep['diffStat'] | undefined {
  const snapshots = new Map<string, string>();
  const stats = new Map<string, NonNullable<EpisodeStep['diffStat']>>();
  const batch = new Map<string, { insertions: number; deletions: number; saves: number }>();
  let batchStart = '';
  let timer: NodeJS.Timeout | undefined;
  const snapshot = (doc: vscode.TextDocument) => { if (doc.uri.scheme === 'file' && doc.getText().length < 1_000_000) snapshots.set(doc.uri.toString(), doc.getText()); };
  vscode.workspace.textDocuments.forEach(snapshot);
  const flush = () => {
    timer = undefined;
    if (!batch.size) return;
    const steps: EpisodeStep[] = [...batch.entries()].slice(0, 100).map(([path, s]) => ({
      kind: 'save', assistantGenerated: false, path, summary: `${s.saves} save(s)`, diffStat: { insertions: s.insertions, deletions: s.deletions } }));
    const startedAt = batchStart;
    batch.clear();
    void deps.pipeline.submit({ schemaVersion: 1, id: stableId('save', startedAt, steps.map((s) => s.path ?? '').join('|')), source: 'save', startedAt, endedAt: new Date().toISOString(), assistantGenerated: false, steps });
  };
  subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(snapshot),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!deps.enabled('saves') || doc.uri.scheme !== 'file' || !inWorkspace(doc.uri.fsPath)) return;
      const path = relPath(doc.uri.fsPath);
      const old = snapshots.get(doc.uri.toString());
      snapshot(doc);
      if (skipPath(deps, path) || old === undefined) return;
      const stat = lineDiffStat(old, doc.getText());
      if (!stat.insertions && !stat.deletions) return;
      stats.set(path, stat);
      const entry = batch.get(path) ?? { insertions: 0, deletions: 0, saves: 0 };
      entry.insertions += stat.insertions; entry.deletions += stat.deletions; entry.saves += 1;
      batch.set(path, entry);
      if (!batchStart) batchStart = new Date().toISOString();
      if (!timer) timer = setTimeout(() => { flush(); batchStart = ''; }, 60_000);
    }),
    { dispose: () => { if (timer) clearTimeout(timer); } },
  );
  return (path) => stats.get(path);
}
