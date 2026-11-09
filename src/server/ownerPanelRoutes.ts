/**
 * Owner HUD panel routes (J-E10): plugins, workflows + visual composer, developer
 * assistant, memory import and gateway sites (J-E09).
 *
 * Every route needs a signed session from a DEVICE_MANAGE device. Read-only lists
 * check the PolicyGateway rule first; every state-changing action is submitted as a
 * task through JarvisCoreService.submitOperations, so policy, approvals, the task
 * journal and the audit chain apply exactly as for spoken/typed requests.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { JarvisCoreService } from '../core/service.js';
import { Permission, type DeviceRecord } from '../core/types.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { listCapabilities } from '../capabilities/registry.js';
import { WORKFLOW_NAME } from '../workflows/workflowStore.js';

export interface OwnerPanelContext {
  jarvis: JarvisCoreService;
  readJsonBody(req: IncomingMessage): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
}

export const OWNER_PANEL_PATHS = [
  '/api/panels/catalog', '/api/panels/run',
  '/api/plugins', '/api/workflows', '/api/workflows/validate', '/api/workflows/compose',
  '/api/developer/repos', '/api/memory/import',
  '/api/gateway/sites', '/api/gateway/sites/reveal',
];

/** Operations the generic panel runner may submit (all still policy-checked). */
const PANEL_OPERATION = /^(plugin|workflow|dev|gateway):[a-z_]+$|^memory:(update|delete)$/;
const MAX_IMPORT_RECORDS = 50;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function handleOwnerPanelRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: OwnerPanelContext): Promise<void> {
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') return ctx.json(res, 401, { error: 'Missing authenticated device session' });
  const body = req.method === 'GET' ? undefined : await ctx.readJsonBody(req);
  if (req.method !== 'GET' && !isObject(body)) return ctx.json(res, 400, { error: 'JSON body must be an object' });
  const auth = ctx.authorize(req, sessionId, url.pathname, body);
  if (!auth.valid || !auth.device) return ctx.json(res, 401, { error: auth.error || 'Signed request authentication failed' });
  const device = auth.device;
  if (!device.permissions.includes(Permission.DEVICE_MANAGE)) {
    return ctx.json(res, 403, { error: 'Owner panels require device-management permission' });
  }
  const { jarvis } = ctx;
  const input = (body ?? {}) as Record<string, unknown>;

  /** Read-only access still goes through the policy rule for that operation. */
  const policyAllows = (operation: string, parameters: Record<string, unknown> = {}): string | null => {
    const evaluation = jarvis.policy.evaluate({ operation, parameters }, device, `panel-${CryptoUtil.randomToken(8)}`);
    return evaluation.allowed ? null : (evaluation.reason || `${operation} is not authorized`);
  };
  const submit = async (label: string, operations: Array<{ operation: string; parameters: Record<string, unknown> }>) => {
    const result = await jarvis.submitOperations(sessionId, label, operations);
    return ctx.json(res, 200, result);
  };

  // ---- catalog for the composer: allowlisted operations + approval boundary ----
  if (req.method === 'GET' && url.pathname === '/api/panels/catalog') {
    const capabilities = new Map(listCapabilities().map((capability) => [capability.id, capability]));
    const operations = jarvis.policy.listRules()
      .filter((rule) => !/^(plugin|workflow|gateway):/.test(rule.operation))
      .map((rule) => ({
        ...rule,
        name: capabilities.get(rule.operation)?.name ?? rule.operation,
        description: capabilities.get(rule.operation)?.description ?? '',
      }))
      .sort((a, b) => a.operation.localeCompare(b.operation));
    return ctx.json(res, 200, { operations });
  }

  // ---- generic runner for panel actions (always a policy-checked task) ----
  if (req.method === 'POST' && url.pathname === '/api/panels/run') {
    const operation = input['operation'];
    const parameters = input['parameters'] ?? {};
    if (typeof operation !== 'string' || !PANEL_OPERATION.test(operation) || !isObject(parameters)) {
      return ctx.json(res, 400, { error: 'operation must be a plugin/workflow/dev/gateway/memory panel operation with object parameters' });
    }
    return submit(`HUD panel: ${operation}`, [{ operation, parameters }]);
  }

  // ---- plugins ----
  if (req.method === 'GET' && url.pathname === '/api/plugins') {
    const denied = policyAllows('plugin:list');
    if (denied) return ctx.json(res, 403, { error: denied });
    return ctx.json(res, 200, {
      plugins: jarvis.workflows.plugins.list().map((plugin) => ({
        id: plugin.manifest.id, name: plugin.manifest.name, version: plugin.manifest.version,
        publisher: plugin.manifest.publisher, description: plugin.manifest.description,
        enabled: plugin.enabled, requested: plugin.manifest.permissions, grants: plugin.grants,
      })),
    });
  }

  // ---- workflows ----
  if (req.method === 'GET' && url.pathname === '/api/workflows') {
    const denied = policyAllows('workflow:list');
    if (denied) return ctx.json(res, 403, { error: denied });
    const name = url.searchParams.get('name');
    if (name) {
      if (!WORKFLOW_NAME.test(name)) return ctx.json(res, 400, { error: 'Invalid workflow name' });
      return ctx.json(res, 200, { name, latest: jarvis.workflows.workflows.latest(name) ?? null, history: jarvis.workflows.workflows.history(name) });
    }
    return ctx.json(res, 200, { workflows: jarvis.workflows.workflows.list() });
  }
  if (req.method === 'POST' && url.pathname === '/api/workflows/validate') {
    const { order, problems } = jarvis.workflows.validateSteps(input['steps']);
    const steps = Array.isArray(input['steps']) ? input['steps'] as Array<Record<string, unknown>> : [];
    // Approval boundary per step, straight from the policy table (dry run, no side effects).
    const boundaries = steps.map((step) => {
      const parameters = isObject(step['parameters']) ? step['parameters'] : {};
      const rule = jarvis.policy.describeOperation(String(step['operation'] ?? ''), Object.keys(parameters));
      return {
        id: String(step['id'] ?? ''),
        allowed: Boolean(rule),
        requiresApproval: rule?.requiresApproval ?? true,
        riskTier: rule?.riskTier ?? null,
      };
    });
    return ctx.json(res, 200, {
      valid: Boolean(order),
      problems,
      order: order?.map((step) => step.id) ?? [],
      boundaries,
    });
  }
  if (req.method === 'POST' && url.pathname === '/api/workflows/compose') {
    const name = String(input['name'] ?? '');
    if (!WORKFLOW_NAME.test(name)) return ctx.json(res, 400, { error: 'Workflow names must be 2-41 lowercase letters, digits or hyphens.' });
    const { order, problems } = jarvis.workflows.validateSteps(input['steps']);
    if (!order) return ctx.json(res, 400, { error: 'Workflow is invalid', problems });
    return submit(`Compose workflow ${name}`, [{
      operation: 'workflow:compose',
      parameters: { name, description: String(input['description'] ?? '').slice(0, 300), steps: order },
    }]);
  }

  // ---- developer assistant read model ----
  if (req.method === 'GET' && url.pathname === '/api/developer/repos') {
    const denied = policyAllows('dev:repo_list');
    if (denied) return ctx.json(res, 403, { error: denied });
    const repos = await jarvis.developer.execute('dev:repo_list', {});
    const repo = url.searchParams.get('repo');
    const suggestions = await jarvis.developer.execute('dev:suggestion_list', repo ? { repo } : {});
    return ctx.json(res, 200, {
      repos: repos.success ? repos.data : [],
      suggestions: suggestions.success ? suggestions.data : [],
      ...(repos.success ? {} : { error: repos.error }),
    });
  }

  // ---- memory import (restore of an export file; each record becomes an approval-gated save) ----
  if (req.method === 'POST' && url.pathname === '/api/memory/import') {
    const memory = jarvis.personalMemory;
    if (!memory) return ctx.json(res, 503, { error: 'Personal memory requires a configured owner control token' });
    const file = input['export'];
    if (!isObject(file) || file['format'] !== 'jarvis-personal-memory-export' || file['version'] !== 1 || !Array.isArray(file['records'])) {
      return ctx.json(res, 400, { error: 'Not a JARVIS memory export (format jarvis-personal-memory-export, version 1)' });
    }
    const existing = new Set(memory.list().map((record) => record.content.trim().toLowerCase()));
    const seen = new Set<string>();
    const operations: Array<{ operation: string; parameters: Record<string, unknown> }> = [];
    const skipped: Array<{ index: number; reason: string }> = [];
    (file['records'] as unknown[]).forEach((raw, index) => {
      const record = isObject(raw) ? raw : {};
      const category = String(record['category'] ?? '');
      const content = typeof record['content'] === 'string' ? record['content'].trim() : '';
      const key = content.toLowerCase();
      if (existing.has(key) || seen.has(key)) return void skipped.push({ index, reason: 'duplicate' });
      try {
        memory.assertStorable(category as Parameters<typeof memory.assertStorable>[0], content);
      } catch (error) {
        return void skipped.push({ index, reason: error instanceof Error ? error.message : 'invalid' });
      }
      let ttlDays: number | undefined;
      if (typeof record['expiresAt'] === 'string') {
        const remaining = Date.parse(record['expiresAt']) - Date.now();
        if (!Number.isFinite(remaining) || remaining <= 0) return void skipped.push({ index, reason: 'expired' });
        ttlDays = Math.min(3650, Math.max(1, Math.ceil(remaining / 86_400_000)));
      }
      seen.add(key);
      operations.push({ operation: 'memory:save', parameters: { category, content, ...(ttlDays ? { ttlDays } : {}) } });
    });
    if (operations.length > MAX_IMPORT_RECORDS) {
      return ctx.json(res, 413, { error: `Import at most ${MAX_IMPORT_RECORDS} new records at a time`, newRecords: operations.length });
    }
    jarvis.audit.record('MEMORY_IMPORT_REQUESTED', { newRecords: operations.length, skipped: skipped.length }, device.id);
    if (!operations.length) return ctx.json(res, 200, { imported: 0, skipped });
    const result = await jarvis.submitOperations(sessionId, `Import ${operations.length} memories from an export file`, operations);
    return ctx.json(res, 200, { ...result, newRecords: operations.length, skipped });
  }

  // ---- gateway sites ----
  if (req.method === 'GET' && url.pathname === '/api/gateway/sites') {
    const denied = policyAllows('gateway:site_list');
    if (denied) return ctx.json(res, 403, { error: denied });
    return ctx.json(res, 200, { sites: jarvis.gatewaySites.store().list(), pendingReveals: jarvis.gatewaySites.reveals.listFor(device.id) });
  }
  if (req.method === 'POST' && url.pathname === '/api/gateway/sites/reveal') {
    const token = input['revealToken'];
    if (typeof token !== 'string' || token.length > 64) return ctx.json(res, 400, { error: 'revealToken is required' });
    const revealed = jarvis.gatewaySites.reveals.take(token, device.id);
    jarvis.audit.record('GATEWAY_SITE_KEY_REVEAL', { revealed: Boolean(revealed), clientId: revealed?.clientId ?? null }, device.id);
    if (!revealed) return ctx.json(res, 404, { error: 'The key was already shown, expired, or belongs to another device.' });
    return ctx.json(res, 200, revealed);
  }

  return ctx.json(res, 405, { error: 'Unsupported owner panel method or route' });
}
