/**
 * JARVIS personal AI gateway for websites.
 *
 * A separate, minimal HTTP listener (default 127.0.0.1) that exposes an
 * OpenAI-compatible subset so any site — or any OpenAI SDK configured with a
 * custom baseURL — can use JARVIS as its AI provider:
 *
 *   GET  /v1/health             (no auth)
 *   GET  /v1/models             (Bearer site key)
 *   POST /v1/chat/completions   (Bearer site key; stream true/false)
 *
 * Boundaries: text generation only. Site keys cannot reach the device API,
 * planner, policy gateway, personal memory, tools or desktop adapters, and the
 * gateway never injects owner memory into prompts. It runs on its own port so a
 * public tunnel can expose /v1 without exposing the owner/device API.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AuditLogger } from '../audit/audit.js';
import type { PublicSiteClient, SiteClientStore } from './siteClientStore.js';

export interface ModelEndpoint {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface SiteAiGatewayOptions {
  store: SiteClientStore;
  audit: AuditLogger;
  /** Resolved per request so configuration changes and outages are reported honestly. */
  modelEndpoint: () => ModelEndpoint | null;
  fetchImpl?: typeof fetch;
  host?: string;
  upstreamTimeoutMs?: number;
  maxConcurrentPerClient?: number;
  maxConcurrentTotal?: number;
}

type ChatRole = 'system' | 'user' | 'assistant';
interface ChatMessage { role: ChatRole; content: string }
interface ChatRequest { messages: ChatMessage[]; stream: boolean; maxTokens: number; temperature?: number }

const MAX_BODY_BYTES = 64 * 1024;
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 16_000;
const MAX_TOTAL_CHARS = 48_000;
const MAX_OUTPUT_CHARS = 64_000;
const PUBLIC_MODEL_ID = 'jarvis';

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly type = 'invalid_request_error', readonly headers: Record<string, string> = {}) {
    super(message);
  }
}

/** Sliding one-minute window per site client. */
class MinuteLimiter {
  private readonly windows = new Map<string, number[]>();
  consume(clientId: string, limit: number, now = Date.now()): number {
    const recent = (this.windows.get(clientId) ?? []).filter((timestamp) => timestamp > now - 60_000);
    if (recent.length >= limit) {
      this.windows.set(clientId, recent);
      return Math.max(1, Math.ceil((recent[0]! + 60_000 - now) / 1000));
    }
    recent.push(now);
    this.windows.set(clientId, recent);
    return 0;
  }
}

export function parseChatRequest(body: unknown, client: Pick<PublicSiteClient, 'limits'>): ChatRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'Request body must be a JSON object.');
  const input = body as Record<string, unknown>;
  const allowed = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'user']);
  const unsupported = Object.keys(input).filter((key) => !allowed.has(key));
  if (unsupported.length) {
    // Tools, functions and response formats are deliberately unavailable to sites.
    throw new HttpError(400, `Unsupported parameter(s): ${unsupported.slice(0, 5).join(', ')}.`);
  }
  if (!Array.isArray(input['messages']) || input['messages'].length === 0 || input['messages'].length > MAX_MESSAGES) {
    throw new HttpError(400, `messages must be an array of 1-${MAX_MESSAGES} items.`);
  }
  let total = 0;
  const messages: ChatMessage[] = input['messages'].map((raw, index) => {
    const message = raw as Record<string, unknown>;
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant'].includes(message['role'] as string)) {
      throw new HttpError(400, `messages[${index}].role must be system, user or assistant.`);
    }
    const content = message['content'];
    if (typeof content !== 'string' || content.length > MAX_MESSAGE_CHARS) {
      throw new HttpError(400, `messages[${index}].content must be a string of at most ${MAX_MESSAGE_CHARS} characters.`);
    }
    total += content.length;
    return { role: message['role'] as ChatRole, content };
  });
  if (total > MAX_TOTAL_CHARS) throw new HttpError(413, `Combined message content exceeds ${MAX_TOTAL_CHARS} characters.`);
  if (!messages.some((message) => message.role === 'user' && message.content.trim())) {
    throw new HttpError(400, 'At least one non-empty user message is required.');
  }
  if (input['stream'] !== undefined && typeof input['stream'] !== 'boolean') throw new HttpError(400, 'stream must be a boolean.');
  const requestedTokens = input['max_completion_tokens'] ?? input['max_tokens'];
  if (requestedTokens !== undefined && (!Number.isSafeInteger(requestedTokens) || (requestedTokens as number) < 1)) {
    throw new HttpError(400, 'max_tokens must be a positive integer.');
  }
  const temperature = input['temperature'];
  if (temperature !== undefined && (typeof temperature !== 'number' || !Number.isFinite(temperature) || temperature < 0 || temperature > 2)) {
    throw new HttpError(400, 'temperature must be a number between 0 and 2.');
  }
  return {
    messages,
    stream: input['stream'] === true,
    maxTokens: Math.min((requestedTokens as number | undefined) ?? client.limits.maxOutputTokens, client.limits.maxOutputTokens),
    ...(temperature !== undefined ? { temperature: temperature as number } : {}),
  };
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1]! : null;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const type = req.headers['content-type'] ?? '';
  if (!/^application\/json\b/i.test(type)) throw new HttpError(415, 'Content-Type must be application/json.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, 'Request body is too large.');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, error: HttpError): void {
  sendJson(res, error.status, { error: { message: error.message, type: error.type } }, error.headers);
}

export class SiteAiGateway {
  private server: Server | null = null;
  private readonly limiter = new MinuteLimiter();
  private readonly inFlight = new Map<string, number>();
  private inFlightTotal = 0;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: SiteAiGatewayOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  start(port: number): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        sendError(res, error instanceof HttpError ? error : new HttpError(500, 'Internal gateway error.', 'server_error'));
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, this.options.host ?? '127.0.0.1', () => {
        const address = this.server!.address();
        resolve(typeof address === 'object' && address ? address.port : port);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }

  private audit(event: string, details: Record<string, unknown>): void {
    // Audit is mandatory: if it cannot be written, refuse service (fail closed).
    try {
      this.options.audit.record(event, details);
    } catch {
      throw new HttpError(503, 'Gateway audit log is unavailable; request refused.', 'server_error');
    }
  }

  private authenticate(req: IncomingMessage): PublicSiteClient {
    const token = bearerToken(req);
    // Pick up keys created/revoked by the CLI without restarting the gateway.
    this.options.store.load();
    const client = token ? this.options.store.authenticate(token) : null;
    if (!client) {
      this.audit('SITE_AI_AUTH_FAILED', { reason: token ? 'invalid_or_revoked_key' : 'missing_bearer_token' });
      throw new HttpError(401, 'Invalid or missing JARVIS site API key.', 'authentication_error', { 'WWW-Authenticate': 'Bearer' });
    }
    return client;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://gateway.local').pathname;
    if (req.method === 'GET' && path === '/v1/health') {
      return sendJson(res, 200, { status: 'ok', modelConfigured: this.options.modelEndpoint() !== null });
    }
    if (req.method === 'GET' && path === '/v1/models') {
      this.authenticate(req);
      return sendJson(res, 200, { object: 'list', data: [{ id: PUBLIC_MODEL_ID, object: 'model', created: 0, owned_by: 'jarvis' }] });
    }
    if (path === '/v1/chat/completions') {
      if (req.method !== 'POST') throw new HttpError(405, 'Use POST.', 'invalid_request_error', { Allow: 'POST' });
      return this.chat(req, res);
    }
    throw new HttpError(404, 'Not found.', 'not_found_error');
  }

  private async chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = this.authenticate(req);
    const retryAfter = this.limiter.consume(client.id, client.limits.requestsPerMinute);
    if (retryAfter) {
      this.audit('SITE_AI_RATE_LIMITED', { clientId: client.id, site: client.name, retryAfterSeconds: retryAfter });
      throw new HttpError(429, 'Rate limit reached for this site key.', 'rate_limit_error', { 'Retry-After': String(retryAfter) });
    }
    const request = parseChatRequest(await readJson(req), client);
    const endpoint = this.options.modelEndpoint();
    if (!endpoint) throw new HttpError(503, 'JARVIS has no AI model configured.', 'server_error');

    const perClient = this.inFlight.get(client.id) ?? 0;
    if (perClient >= (this.options.maxConcurrentPerClient ?? 2) || this.inFlightTotal >= (this.options.maxConcurrentTotal ?? 4)) {
      throw new HttpError(429, 'JARVIS is busy with other requests; retry shortly.', 'rate_limit_error', { 'Retry-After': '2' });
    }
    this.inFlight.set(client.id, perClient + 1);
    this.inFlightTotal += 1;
    const started = Date.now();
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    const timeout = setTimeout(() => controller.abort(), this.options.upstreamTimeoutMs ?? 60_000);
    let status = 200;
    let outputChars = 0;
    try {
      let upstream: Response;
      try {
        upstream = await this.fetchImpl(endpoint.baseUrl + '/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(endpoint.apiKey ? { Authorization: 'Bearer ' + endpoint.apiKey } : {}) },
          body: JSON.stringify({
            model: endpoint.model,
            messages: request.messages,
            stream: request.stream,
            max_tokens: request.maxTokens,
            ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
          }),
          signal: controller.signal,
        });
      } catch {
        throw controller.signal.aborted && !res.destroyed
          ? new HttpError(504, 'The JARVIS model did not respond in time.', 'server_error')
          : new HttpError(503, 'The JARVIS model is not reachable. Is the local model running?', 'server_error');
      }
      if (!upstream.ok || !upstream.body) {
        await upstream.body?.cancel().catch(() => undefined);
        throw upstream.status === 404
          ? new HttpError(503, 'The configured JARVIS model is not installed.', 'server_error')
          : new HttpError(502, 'The JARVIS model could not complete the request.', 'server_error');
      }
      const id = 'chatcmpl-' + randomUUID();
      const created = Math.floor(Date.now() / 1000);
      if (request.stream) {
        outputChars = await this.relayStream(upstream, res, id, created);
      } else {
        const payload = await upstream.json().catch(() => null) as { choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>; usage?: unknown } | null;
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new HttpError(502, 'The JARVIS model returned an invalid response.', 'server_error');
        const text = content.slice(0, MAX_OUTPUT_CHARS);
        outputChars = text.length;
        const finish = payload?.choices?.[0]?.finish_reason;
        sendJson(res, 200, {
          id, object: 'chat.completion', created, model: PUBLIC_MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: typeof finish === 'string' ? finish : 'stop' }],
        });
      }
    } catch (error) {
      status = error instanceof HttpError ? error.status : 500;
      throw error;
    } finally {
      clearTimeout(timeout);
      res.off('close', onClose);
      this.inFlight.set(client.id, Math.max(0, (this.inFlight.get(client.id) ?? 1) - 1));
      this.inFlightTotal = Math.max(0, this.inFlightTotal - 1);
      // Metadata only: message content and generated text are never written to the audit log.
      try {
        this.options.audit.record('SITE_AI_REQUEST', {
          clientId: client.id, site: client.name, status, stream: request.stream,
          messageCount: request.messages.length,
          inputChars: request.messages.reduce((sum, message) => sum + message.content.length, 0),
          outputChars, durationMs: Date.now() - started, clientDisconnected: controller.signal.aborted && res.destroyed,
        });
      } catch { /* the request already completed; the next request will fail closed */ }
    }
  }

  /** Re-emit only assistant text deltas in OpenAI chunk format; provider metadata is dropped. */
  private async relayStream(upstream: Response, res: ServerResponse, id: string, created: number): Promise<number> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      Connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, string>, finish: string | null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: PUBLIC_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.write(chunk({ role: 'assistant' }, null));
    const decoder = new TextDecoder();
    let buffer = '';
    let output = 0;
    let finishReason = 'stop';
    const handleLine = (line: string) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try {
        const event = JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }> };
        const choice = event.choices?.[0];
        const text = choice?.delta?.content;
        if (typeof text === 'string' && text && output < MAX_OUTPUT_CHARS) {
          const bounded = text.slice(0, MAX_OUTPUT_CHARS - output);
          output += bounded.length;
          res.write(chunk({ content: bounded }, null));
        }
        if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
      } catch { /* ignore malformed provider events */ }
    };
    const reader = upstream.body!.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        lines.forEach(handleLine);
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
      res.write(chunk({}, finishReason));
      res.end('data: [DONE]\n\n');
    } catch {
      // Headers are already sent; end the stream so the site does not hang.
      if (!res.destroyed) res.end();
    }
    return output;
  }
}
