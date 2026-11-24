import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { startDiagnosticsCapture, startGitCapture, startSaveCapture, startTerminalCapture, type CaptureDeps } from './capture';
import { isLoopbackUrl, requireLoopbackBase } from './loopback';
import { Pipeline, type Status } from './pipeline';
import { showPreview } from './preview';
import { OfflineQueue } from './queue';
import type { FileCursor } from './transcripts/tail';
import { TranscriptWatcher } from './transcripts/watcher';

const KEY_SECRET = 'jarvisLearn.ingestKey';
const KEY_FORMAT = /^jli_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/;

export function activate(context: vscode.ExtensionContext): void {
  const config = () => vscode.workspace.getConfiguration('jarvisLearn');
  const output = vscode.window.createOutputChannel('JARVIS Learn');
  const log = (message: string) => output.appendLine(`${new Date().toISOString()} ${message}`);
  const paused = () => context.globalState.get<boolean>('paused', false);

  const queue = new OfflineQueue(join(context.globalStorageUri.fsPath, 'offline-queue.json'), config().get<number>('queue.maxMegabytes', 5) * 1024 * 1024);
  const baseUrl = () => requireLoopbackBase(config().get<string>('jarvisUrl', 'http://127.0.0.1:3000'));
  const pipeline = new Pipeline(queue, {
    baseUrl,
    ingestKey: async () => context.secrets.get(KEY_SECRET),
    paused,
    finalize: () => ({
      redaction: { emails: config().get<boolean>('redaction.emails', true), phones: config().get<boolean>('redaction.phones', true) },
      excludePaths: config().get<string[]>('excludePaths', []),
    }),
  });

  // ---- status bar ----
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  bar.command = 'jarvisLearn.showPending';
  const labels: Record<Status, string> = {
    capturing: '$(eye) JARVIS: capturing', paused: '$(debug-pause) JARVIS: paused', offline: '$(cloud-offline) JARVIS: offline',
    'no-key': '$(key) JARVIS: needs ingest key', 'auth-failed': '$(warning) JARVIS: key rejected',
  };
  const refreshBar = () => {
    if (!isLoopbackUrl(config().get<string>('jarvisUrl', ''))) { bar.text = '$(error) JARVIS: URL must be loopback'; }
    else bar.text = `${labels[paused() ? 'paused' : pipeline.status]}${queue.length ? ` (${queue.length} queued)` : ''}`;
    bar.tooltip = 'JARVIS Learn: click to preview pending episodes';
    bar.show();
  };
  pipeline.onChange = refreshBar;
  void context.secrets.get(KEY_SECRET).then((key) => { if (!key) pipeline.status = 'no-key'; refreshBar(); });

  // ---- capture sources ----
  const deps: CaptureDeps = {
    pipeline, log,
    enabled: (source) => config().get<boolean>(`capture.${source}`, true),
    excludePaths: () => config().get<string[]>('excludePaths', []),
    maxDiffBytes: () => config().get<number>('git.maxDiffBytes', 20000),
  };
  startGitCapture(deps, context.subscriptions);
  startTerminalCapture(deps, context.subscriptions);
  const lastSave = startSaveCapture(deps, context.subscriptions);
  startDiagnosticsCapture(deps, context.subscriptions, lastSave);

  const firstRun = context.globalState.get<number>('firstRun') ?? Date.now();
  void context.globalState.update('firstRun', firstRun);
  const cursors = context.globalState.get<Record<string, FileCursor>>('transcriptCursors', {});
  const watcher = new TranscriptWatcher({
    projectsRoot: join(homedir(), '.claude', 'projects'),
    workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    configuredProjects: () => config().get<string[]>('transcripts.projects', []),
    backfill: () => config().get<boolean>('transcripts.backfill', false),
    firstRun, cursors, log,
    saveCursors: (value) => void context.globalState.update('transcriptCursors', value),
    submit: (episode) => { if (config().get<boolean>('capture.transcripts', true)) void pipeline.submit(episode); },
  });
  // The watcher only runs while not paused, so nothing is even parsed during a pause.
  const tick = setInterval(() => { if (!paused() && config().get<boolean>('capture.transcripts', true)) watcher.poll(); }, 5000);
  const retry = setInterval(() => { if (queue.length && !paused()) void pipeline.flush(); }, 30_000);

  // ---- commands ----
  context.subscriptions.push(
    bar, output,
    { dispose: () => { clearInterval(tick); clearInterval(retry); } },
    vscode.commands.registerCommand('jarvisLearn.togglePause', async () => {
      await context.globalState.update('paused', !paused());
      pipeline.status = paused() ? 'paused' : 'capturing';
      refreshBar();
      void vscode.window.showInformationMessage(`JARVIS Learn capture ${paused() ? 'paused' : 'resumed'}.`);
      if (!paused()) void pipeline.flush();
    }),
    vscode.commands.registerCommand('jarvisLearn.setIngestKey', async () => {
      const value = await vscode.window.showInputBox({
        title: 'JARVIS ingest key', prompt: 'Create one with: npm run ingest-key -- create <name>. Stored in VS Code SecretStorage, never in settings.',
        password: true, ignoreFocusOut: true, validateInput: (v) => (KEY_FORMAT.test(v.trim()) ? undefined : 'Expected a key starting with jli_'),
      });
      if (!value) return;
      await context.secrets.store(KEY_SECRET, value.trim());
      pipeline.status = 'capturing';
      refreshBar();
      void pipeline.flush();
    }),
    vscode.commands.registerCommand('jarvisLearn.showPending', () => showPreview(queue, pipeline)),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('jarvisLearn.queue.maxMegabytes')) queue.setMaxBytes(config().get<number>('queue.maxMegabytes', 5) * 1024 * 1024);
      refreshBar();
    }),
  );
  refreshBar();
  if (queue.length && !paused()) void pipeline.flush();
}

export function deactivate(): void { /* disposables are registered on the context */ }
