/**
 * JARVIS Studio "Models" view API (/api/llm/*): providers and status, model catalog, routing config,
 * metrics, health checks and a test prompt.
 *
 * Owner-session only: every route needs a signed session from a DEVICE_MANAGE device. Responses never
 * contain API keys or base URLs. Config changes that could increase spend (enabling cloud, raising the
 * budget, authorizing more tasks, adding paid models or lowering prices) need a fresh authenticator
 * code when TOTP is enabled, using the same verifyStepUp pattern as the other owner routes.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getLlmOrchestrator, LlmRoutingError, type LlmOrchestrator } from '../ai/llmOrchestrator.js';
import { isEscalation, validateConfig } from '../ai/llmConfig.js';
import { LLM_PROVIDER_IDS, type LlmProviderId } from '../ai/llmTypes.js';
import { PRICING_NOTE } from '../ai/llmPricing.js';
import { AgentRequestLimiter } from '../conversation/agentRequestLimiter.js';
import type { JarvisCoreService } from '../core/service.js';
import { Permission, type DeviceRecord } from '../core/types.js';

export interface ModelRouteContext {
  jarvis: JarvisCoreService;
  readJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
  /** Test seam; defaults to the process-wide orchestrator. */
  orchestrator?: LlmOrchestrator;
}

export const MODEL_API_PATHS = [
  '/api/llm/status', '/api/llm/catalog', '/api/llm/config', '/api/llm/metrics', '/api/llm/health', '/api/llm/test',
];

export function isModelRoute(pathname: string): boolean {
  return MODEL_API_PATHS.includes(pathname);
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_TEST_PROMPT_CHARS = 500;
const testLimiter = new AgentRequestLimiter(15);

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function handleModelRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: ModelRouteContext): Promise<void> {
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') return ctx.json(res, 401, { error: 'Missing authenticated device session' });
  const method = req.method ?? 'GET';
  const hasBody = method === 'POST';
  let body: unknown;
  try {
    body = hasBody ? await ctx.readJsonBody(req, MAX_BODY_BYTES) : undefined;
  } catch (error) {
    return ctx.json(res, /too large/i.test(String((error as Error).message)) ? 413 : 400, { error: (error as Error).message });
  }
  if (hasBody && !isObject(body)) return ctx.json(res, 400, { error: 'JSON body must be an object' });
  const auth = ctx.authorize(req, sessionId, url.pathname, body);
  if (!auth.valid || !auth.device) return ctx.json(res, 401, { error: auth.error || 'Signed request authentication failed' });
  const device = auth.device;
  if (!device.permissions.includes(Permission.DEVICE_MANAGE)) return ctx.json(res, 403, { error: 'The Models view requires device-management permission' });

  const llm = ctx.orchestrator ?? getLlmOrchestrator();
  const path = url.pathname;
  const input = (body ?? {}) as Record<string, unknown>;

  if (method === 'GET' && path === '/api/llm/status') return ctx.json(res, 200, llm.status());

  if (method === 'GET' && path === '/api/llm/catalog') {
    const refresh = url.searchParams.get('refresh') === '1';
    return ctx.json(res, 200, { local: await llm.localModels(refresh), cloud: llm.cloudModels(), pricingNote: PRICING_NOTE });
  }

  if (method === 'GET' && path === '/api/llm/config') return ctx.json(res, 200, { config: llm.config.get(), pricingNote: PRICING_NOTE });

  if (method === 'POST' && path === '/api/llm/config') {
    const current = llm.config.get();
    const checked = validateConfig(input['config'], current);
    if (!checked.ok) return ctx.json(res, 400, { error: 'Invalid routing config', details: checked.errors.slice(0, 20) });
    const escalation = isEscalation(current, checked.config);
    if (escalation && ctx.jarvis.deviceSecurity?.getTotpStatus() === 'ENABLED'
      && (typeof input['totpCode'] !== 'string' || !ctx.jarvis.deviceSecurity.verifyStepUp(device, input['totpCode']))) {
      return ctx.json(res, 401, { error: 'Fresh authenticator verification required' });
    }
    llm.config.set(checked.config);
    ctx.jarvis.audit.record('LLM_ROUTING_CONFIG_UPDATED', { escalation, globalAuthorized: checked.config.cloud.globalAuthorized, monthlyBudgetUsd: checked.config.cloud.monthlyBudgetUsd }, device.id);
    return ctx.json(res, 200, { config: checked.config, escalation });
  }

  if (method === 'GET' && path === '/api/llm/metrics') {
    return ctx.json(res, 200, { summaries: llm.metrics.summaries(), fallbacks: llm.metrics.fallbackCounts(), spend: llm.metrics.ledger(), recent: llm.metrics.recent(60) });
  }

  if (method === 'POST' && path === '/api/llm/health') {
    const provider = input['provider'];
    if (provider !== undefined && !(LLM_PROVIDER_IDS as readonly string[]).includes(String(provider))) return ctx.json(res, 400, { error: 'Unknown provider' });
    return ctx.json(res, 200, { results: await llm.checkHealth(provider as LlmProviderId | undefined), status: llm.status() });
  }

  if (method === 'POST' && path === '/api/llm/test') {
    const provider = input['provider'];
    const model = input['model'];
    const prompt = input['prompt'];
    if (typeof provider !== 'string' || !(LLM_PROVIDER_IDS as readonly string[]).includes(provider)) return ctx.json(res, 400, { error: 'Unknown provider' });
    if (model !== undefined && (typeof model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(model))) return ctx.json(res, 400, { error: 'Invalid model name' });
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_TEST_PROMPT_CHARS) return ctx.json(res, 400, { error: `prompt must be 1 to ${MAX_TEST_PROMPT_CHARS} characters` });
    const limit = testLimiter.consume(device.id);
    if (!limit.allowed) return ctx.json(res, 429, { error: 'Too many test prompts; try again later', retryAfterSeconds: limit.retryAfterSeconds });
    try {
      // The prompt is typed by the owner for this test and is not stored; metrics keep numbers only.
      const result = await llm.test(provider as LlmProviderId, model, prompt);
      return ctx.json(res, 200, { ok: true, provider: result.provider, model: result.model, text: result.text, latencyMs: result.latencyMs, usage: result.usage, costUsd: result.costUsd });
    } catch (error) {
      if (error instanceof LlmRoutingError) {
        return ctx.json(res, 200, { ok: false, code: error.code, skipped: error.plan.skipped, attempts: error.attempts });
      }
      return ctx.json(res, 200, { ok: false, code: 'error' });
    }
  }

  return ctx.json(res, method === 'GET' || method === 'POST' ? 404 : 405, { error: 'Unsupported route' });
}
