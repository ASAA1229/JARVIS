import * as vscode from 'vscode';
import type { OfflineQueue } from './queue';
import type { Pipeline } from './pipeline';

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Shows exactly what is queued (will be sent) and what was recently sent: the redacted JSON, nothing else. */
export function showPreview(queue: OfflineQueue, pipeline: Pipeline): void {
  const panel = vscode.window.createWebviewPanel('jarvisLearnPreview', 'JARVIS pending episodes', vscode.ViewColumn.Beside, { enableScripts: false });
  const render = () => {
    const pending = queue.list().map((item) => `<details><summary>${escapeHtml(item.queuedAt)} - pending (${item.bytes} bytes)</summary><pre>${escapeHtml(JSON.stringify(item.episode, null, 2))}</pre></details>`).join('');
    const sent = [...pipeline.sent].reverse().map((s) => `<details><summary>${escapeHtml(s.at)} - ${s.status}${s.detail ? ' (' + escapeHtml(s.detail) + ')' : ''}</summary><pre>${escapeHtml(JSON.stringify(s.episode, null, 2))}</pre></details>`).join('');
    panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>body{font-family:var(--vscode-font-family);padding:1em}pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:.6em}summary{cursor:pointer;margin:.4em 0}</style></head><body>
<h2>Status: ${escapeHtml(pipeline.status)}</h2>
<p>These are the already-redacted episodes exactly as sent to your local JARVIS (loopback only). They stay pending in JARVIS until you approve them there. Dropped for size: ${queue.droppedTotal}.</p>
<h3>Waiting to send (${queue.length})</h3>${pending || '<p>Nothing queued.</p>'}
<h3>Recently sent (${pipeline.sent.length})</h3>${sent || '<p>Nothing sent this session.</p>'}</body></html>`;
  };
  render();
  const previous = pipeline.onChange;
  pipeline.onChange = () => { previous(); try { render(); } catch { /* panel disposed */ } };
  panel.onDidDispose(() => { pipeline.onChange = previous; });
}
