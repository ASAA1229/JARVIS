/**
 * JARVIS Studio, Code view: owner routes for approved workspace roots, file browsing, edits and the
 * coding helper (SSE).
 *
 * Every API route needs a signed session from a DEVICE_MANAGE device. Reads check the PolicyGateway
 * rule first. Every state change (add/remove root, write, create, rename, delete, apply diff, run a
 * script) is submitted through JarvisCoreService.submitOperations, so policy, approval, the task
 * journal and the audit chain apply. The routes pre-validate and return a diff so the owner sees what
 * will change before an approval is even requested.
 */
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JarvisCoreService } from '../core/service.js';
import { Permission, type DeviceRecord } from '../core/types.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { providerRouter } from '../ai/providerRouter.js';
import { RUNNABLE_SCRIPTS } from '../developer/repoTools.js';
import { CodingHelper, HELPER_ACTIONS, type HelperAction, type HelperModel, type HelperRequest } from '../workspace/codingHelper.js';
import { WorkspacePathError } from '../workspace/workspacePaths.js';

export interface WorkspaceRouteContext {
  jarvis: JarvisCoreService;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
  /** Test seam: replaces the local model used by the coding helper. */
  helperModel?: HelperModel;
}

const STATIC_FILES: Record<string, { file: string; type: string }> = {
  '/studio/code/code.js': { file: 'code.js', type: 'application/javascript; charset=utf-8' },
  '/studio/code/code.css': { file: 'code.css', type: 'text/css; charset=utf-8' },
  '/studio/code/dev.html': { file: 'dev.html', type: 'text/html; charset=utf-8' },
};

export const WORKSPACE_API_PATHS = [
  '/api/workspace/roots', '/api/workspace/roots/add', '/api/workspace/roots/remove',
  '/api/workspace/tree', '/api/workspace/file', '/api/workspace/search',
  '/api/workspace/diff', '/api/workspace/write', '/api/workspace/create', '/api/workspace/rename', '/api/workspace/delete',
  '/api/workspace/apply/preview', '/api/workspace/apply', '/api/workspace/helper', '/api/workspace/run',
];

export function isWorkspaceRoute(pathname: string): boolean {
  return WORKSPACE_API_PATHS.includes(pathname) || Object.prototype.hasOwnProperty.call(STATIC_FILES, pathname);
}

const MAX_BODY_BYTES = 3 * 1024 * 1024;
const MAX_HELPER_STREAMS = 2;
let activeHelperStreams = 0;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown, max = 4096): string {
  return typeof value === 'string' && value.length <= max ? value : '';
}

export async function handleWorkspaceRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: WorkspaceRouteContext): Promise<void> {
  // Static view assets: public like the HUD files; they carry no data and every API call is authenticated.
  const asset = STATIC_FILES[url.pathname];
  if (asset) {
    if (req.method !== 'GET') return ctx.json(res, 405, { error: 'Method not allowed' });
    const path = join(process.cwd(), 'src', 'studio', 'code', asset.file);
    if (!existsSync(path)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('File not found'); return; }
    res.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(readFileSync(path));
    return;
  }

  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') return ctx.json(res, 401, { error: 'Missing authenticated device session' });
  const isGet = req.method === 'GET';
  let body: unknown;
  try {
    body = isGet ? undefined : await ctx.readJsonBody(req, MAX_BODY_BYTES);
  } catch (error) {
    return ctx.json(res, /too large/i.test(String((error as Error).message)) ? 413 : 400, { error: (error as Error).message });
  }
  if (!isGet && !isObject(body)) return ctx.json(res, 400, { error: 'JSON body must be an object' });
  const auth = ctx.authorize(req, sessionId, url.pathname, body);
  if (!auth.valid || !auth.device) return ctx.json(res, 401, { error: auth.error || 'Signed request authentication failed' });
  const device = auth.device;
  if (!device.permissions.includes(Permission.DEVICE_MANAGE)) {
    return ctx.json(res, 403, { error: 'The Code view requires device-management permission' });
  }
  const { jarvis } = ctx;
  const workspace = jarvis.workspace;
  const input = (body ?? {}) as Record<string, unknown>;
  const query = (name: string) => url.searchParams.get(name) ?? '';

  const policyAllows = (operation: string): string | null => {
    const evaluation = jarvis.policy.evaluate({ operation, parameters: {} }, device, `ws-${CryptoUtil.randomToken(8)}`);
    return evaluation.allowed ? null : (evaluation.reason || `${operation} is not authorized`);
  };
  const submit = async (label: string, operations: Array<{ operation: string; parameters: Record<string, unknown> }>, extra: Record<string, unknown> = {}) => {
    const result = await jarvis.submitOperations(sessionId, label, operations);
    return ctx.json(res, 200, { ...result, ...extra });
  };
  const fileError = (error: unknown) => {
    const message = error instanceof Error ? error.message : 'Request failed';
    const status = error instanceof WorkspacePathError ? (error.code === 'invalid' ? 400 : 403) : /not an approved workspace root/.test(message) ? 403 : 400;
    return ctx.json(res, status, { error: message });
  };

  try {
    // ---- roots ----
    if (isGet && url.pathname === '/api/workspace/roots') {
      const denied = policyAllows('workspace:root_list');
      if (denied) return ctx.json(res, 403, { error: denied });
      const status = providerRouter.status();
      const local = status.providers.find((provider) => provider.id === 'local');
      let repos: Array<{ name: string; path: string; scopes: string[] }> = [];
      const listed = await jarvis.developer.execute('dev:repo_list', {});
      if (listed.success && Array.isArray(listed.data)) repos = listed.data as typeof repos;
      const real = (path: string) => { try { return realpathSync.native(path).toLowerCase(); } catch { return path.toLowerCase(); } };
      const roots = workspace.listRoots().map((root) => ({
        ...root,
        scriptsAvailable: repos.some((repo) => repo.scopes.includes('ci') && real(repo.path) === root.path.toLowerCase()),
      }));
      return ctx.json(res, 200, {
        roots, scripts: [...RUNNABLE_SCRIPTS],
        model: { configured: Boolean(local?.configured), available: Boolean(local?.available), name: local?.model ?? null, local: true },
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/roots/add') {
      const checked = workspace.roots.check(str(input['name'], 64), str(input['path'], 1024));
      return submit(`Add workspace root ${checked.name}`, [{ operation: 'workspace:root_add', parameters: { name: checked.name, path: checked.path } }]);
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/roots/remove') {
      const name = str(input['name'], 64);
      if (!workspace.roots.get(name)) return ctx.json(res, 404, { error: 'No such workspace root.' });
      return submit(`Remove workspace root ${name}`, [{ operation: 'workspace:root_remove', parameters: { name } }]);
    }

    // ---- read-only browsing ----
    if (isGet && url.pathname === '/api/workspace/tree') {
      const denied = policyAllows('workspace:read');
      if (denied) return ctx.json(res, 403, { error: denied });
      return ctx.json(res, 200, workspace.tree(query('root'), query('path')));
    }
    if (isGet && url.pathname === '/api/workspace/file') {
      const denied = policyAllows('workspace:read');
      if (denied) return ctx.json(res, 403, { error: denied });
      return ctx.json(res, 200, workspace.readFile(query('root'), query('path')));
    }
    if (isGet && url.pathname === '/api/workspace/search') {
      const denied = policyAllows('workspace:search');
      if (denied) return ctx.json(res, 403, { error: denied });
      const mode = query('mode');
      return ctx.json(res, 200, workspace.search(query('root'), query('q'), {
        mode: mode === 'name' || mode === 'text' ? mode : 'both', path: query('path'),
      }));
    }

    // ---- previews (no state change) ----
    if (req.method === 'POST' && url.pathname === '/api/workspace/diff') {
      const denied = policyAllows('workspace:read');
      if (denied) return ctx.json(res, 403, { error: denied });
      return ctx.json(res, 200, workspace.previewWrite(str(input['root'], 64), str(input['path']), typeof input['content'] === 'string' ? input['content'] : ''));
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/apply/preview') {
      const denied = policyAllows('workspace:read');
      if (denied) return ctx.json(res, 403, { error: denied });
      const preview = workspace.previewDiff(str(input['root'], 64), str(input['diff'], 2_000_000));
      return ctx.json(res, 200, { diff: preview.diff, files: preview.files.map((file) => ({ path: file.path, isNew: file.isNew })) });
    }

    // ---- state changes: all via submitOperations (approval + audit) ----
    if (req.method === 'POST' && url.pathname === '/api/workspace/write') {
      const root = str(input['root'], 64);
      const path = str(input['path']);
      const content = typeof input['content'] === 'string' ? input['content'] : '';
      const baseHash = str(input['baseHash'], 80);
      if (!baseHash) return ctx.json(res, 400, { error: 'baseHash is required' });
      const preview = workspace.previewWrite(root, path, content);
      if (preview.isNew) return ctx.json(res, 400, { error: 'That file does not exist; create it instead.' });
      if (preview.baseHash !== baseHash) return ctx.json(res, 409, { error: 'The file changed on disk since you opened it; reload it and review the diff again.' });
      if (!preview.changed) return ctx.json(res, 200, { unchanged: true, message: 'No changes to save.' });
      return submit(`Save ${preview.path} in ${root}`, [{ operation: 'workspace:write', parameters: { root, path: preview.path, content, baseHash } }], { diff: preview.diff });
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/create') {
      const root = str(input['root'], 64);
      const content = typeof input['content'] === 'string' ? input['content'] : '';
      const preview = workspace.previewWrite(root, str(input['path']), content);
      if (!preview.isNew) return ctx.json(res, 409, { error: 'That file already exists.' });
      return submit(`Create ${preview.path} in ${root}`, [{ operation: 'workspace:create', parameters: { root, path: preview.path, content } }], { diff: preview.diff });
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/rename') {
      const root = str(input['root'], 64);
      return submit(`Rename ${str(input['path'], 300)} in ${root}`, [{ operation: 'workspace:rename', parameters: { root, path: str(input['path']), to: str(input['to']) } }]);
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/delete') {
      const root = str(input['root'], 64);
      return submit(`Delete ${str(input['path'], 300)} in ${root}`, [{ operation: 'workspace:delete', parameters: { root, path: str(input['path']) } }]);
    }
    if (req.method === 'POST' && url.pathname === '/api/workspace/apply') {
      const root = str(input['root'], 64);
      const preview = workspace.previewDiff(root, str(input['diff'], 2_000_000));
      // The canonical diff (regenerated against the real files) is what gets approved and applied.
      return submit(`Apply proposed change to ${preview.files.map((file) => file.path).join(', ').slice(0, 100)}`,
        [{ operation: 'workspace:apply_diff', parameters: { root, diff: preview.diff } }], { diff: preview.diff });
    }

    // ---- run an allowlisted project script (build/lint/test/typecheck) via the developer operations ----
    if (req.method === 'POST' && url.pathname === '/api/workspace/run') {
      const script = str(input['script'], 20);
      if (!RUNNABLE_SCRIPTS.has(script)) return ctx.json(res, 400, { error: `Only these scripts can be run: ${[...RUNNABLE_SCRIPTS].join(', ')}.` });
      const root = workspace.roots.require(str(input['root'], 64));
      const listed = await jarvis.developer.execute('dev:repo_list', {});
      const repos = listed.success && Array.isArray(listed.data) ? listed.data as Array<{ name: string; path: string; scopes: string[] }> : [];
      const real = (path: string) => { try { return realpathSync.native(path).toLowerCase(); } catch { return path.toLowerCase(); } };
      const repo = repos.find((item) => item.scopes.includes('ci') && real(item.path) === root.path.toLowerCase());
      if (!repo) {
        return ctx.json(res, 409, { error: 'Running scripts needs this folder connected as a developer repository with the ci scope (a git repository). Connect it from the developer panel first.' });
      }
      return submit(`Run npm script ${script} in ${repo.name}`, [{ operation: 'dev:run_script', parameters: { repo: repo.name, script } }]);
    }

    // ---- coding helper (SSE) ----
    if (req.method === 'POST' && url.pathname === '/api/workspace/helper') {
      const denied = policyAllows('workspace:read');
      if (denied) return ctx.json(res, 403, { error: denied });
      const action = str(input['action'], 20) as HelperAction;
      if (!HELPER_ACTIONS.includes(action)) return ctx.json(res, 400, { error: 'Unknown helper action' });
      const selection = isObject(input['selection']) && typeof input['selection']['text'] === 'string'
        ? { text: input['selection']['text'].slice(0, 8000), startLine: Number(input['selection']['startLine']) || 1, endLine: Number(input['selection']['endLine']) || 1 }
        : undefined;
      const history = Array.isArray(input['history'])
        ? (input['history'] as unknown[]).filter(isObject)
          .filter((turn) => (turn['role'] === 'user' || turn['role'] === 'assistant') && typeof turn['content'] === 'string')
          .map((turn) => ({ role: turn['role'] as 'user' | 'assistant', content: String(turn['content']) }))
        : [];
      const request: HelperRequest = {
        root: str(input['root'], 64), action, message: str(input['message'], 4000),
        ...(str(input['path']) ? { path: str(input['path']) } : {}),
        ...(typeof input['content'] === 'string' && input['content'].length <= 400_000 ? { content: input['content'] } : {}),
        ...(selection ? { selection } : {}), history,
      };
      if (activeHelperStreams >= MAX_HELPER_STREAMS) return ctx.json(res, 429, { error: 'The coding helper is busy; try again in a moment.' });
      activeHelperStreams++;
      const controller = new AbortController();
      res.on('close', () => controller.abort());
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      jarvis.audit.record('WORKSPACE_HELPER_REQUEST', { action, root: request.root, hasSelection: Boolean(selection), path: request.path ?? null }, device.id);
      try {
        const helper = new CodingHelper(workspace, ctx.helperModel);
        for await (const event of helper.run(request, controller.signal)) {
          if (res.writableEnded || res.destroyed) break;
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } finally {
        activeHelperStreams--;
        if (!res.writableEnded) res.end();
      }
      return;
    }
  } catch (error) {
    return fileError(error);
  }

  return ctx.json(res, 405, { error: 'Unsupported workspace method or route' });
}
