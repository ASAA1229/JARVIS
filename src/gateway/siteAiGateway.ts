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
  /** Provider id from the router (for availability reporting); never a secret. */
  id?: string;
  /** Wire format of the provider; Anthropic Messages streams are converted to OpenAI chunks. */
  format?: 'openai' | 'anthropic';
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
  /** Max wait for the model's first output (prompt processing on CPU can be slow). Default 120 s. */
  firstTokenTimeoutMs?: number;
  /** Max silence between streamed chunks once output has started. Default 45 s. */
  idleTimeoutMs?: number;
  /** Hard ceiling for one request. Default 300 s. */
  maxDurationMs?: number;
  /** Interval of SSE keep-alive comments while waiting for the first token. Default 15 s. */
  keepAliveMs?: number;
  maxConcurrentPerClient?: number;
  maxConcurrentTotal?: number;
  /** Resource-profile concurrency (US-061); read per request, overrides the static limits. */
  concurrency?: () => { perClient: number; total: number };
  /** Register a running model call so the owner can see/stop expensive work (US-061). */
  registerHeavyWork?: (label: string, cancel: () => void) => { done: () => void };
  /** Report provider success/failure to the router for honest fallback (US-059). */
  reportOutcome?: (endpoint: ModelEndpoint, ok: boolean) => void;
}

type ChatRole = 'system' | 'user' | 'assistant';
interface ChatMessage { role: ChatRole; content: string }
interface ChatRequest { messages: ChatMessage[]; stream: boolean; maxTokens: number; temperature?: number; profile?: string }

/** Profile ids a site may scope a request to (e.g. portfolio profiles). */
export const PROFILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Header a site may use instead of the `jarvis_profile` body field. */
export const PROFILE_HEADER = 'x-jarvis-profile';

/** Anthropic needs system text separately and strictly alternating user/assistant turns. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: Array<{ role: 'user' | 'assistant'; content: string }> } {
  const system = messages.filter((message) => message.role === 'system').map((message) => message.content).join('\n\n');
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    const last = turns[turns.length - 1];
    if (last && last.role === message.role) last.content += '\n\n' + message.content;
    else turns.push({ role: message.role, content: message.content });
  }
  if (turns[0]?.role === 'assistant') turns.unshift({ role: 'user', content: '(conversation continues)' });
  return { system, messages: turns };
}

function anthropicFinish(reason: unknown): string | undefined {
  if (typeof reason !== 'string') return undefined;
  return reason === 'max_tokens' ? 'length' : 'stop';
}

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
  const allowed = new Set(['model', 'messages', 'stream', 'max_tokens', 'max_completion_tokens', 'temperature', 'user', 'jarvis_profile']);
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
  const profile = input['jarvis_profile'];
  if (profile !== undefined && (typeof profile !== 'string' || !PROFILE_PATTERN.test(profile))) {
    throw new HttpError(400, 'jarvis_profile must be a lowercase profile id.');
  }
  return {
    ...(typeof profile === 'string' ? { profile } : {}),
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
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
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

  private firstTokenTimeoutMs(): number {
    return this.options.firstTokenTimeoutMs ?? 120_000;
  }

  private async chat(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const client = this.authenticate(req);
    const retryAfter = this.limiter.consume(client.id, client.limits.requestsPerMinute);
    if (retryAfter) {
      this.audit('SITE_AI_RATE_LIMITED', { clientId: client.id, site: client.name, retryAfterSeconds: retryAfter });
      throw new HttpError(429, 'Rate limit reached for this site key.', 'rate_limit_error', { 'Retry-After': String(retryAfter) });
    }
    const request = parseChatRequest(await readJson(req), client);
    // Site identity and profile scope (J-E09): a header may carry the profile instead of the body.
    const headerProfile = req.headers[PROFILE_HEADER];
    if (typeof headerProfile === 'string' && headerProfile) {
      if (!PROFILE_PATTERN.test(headerProfile)) throw new HttpError(400, 'X-Jarvis-Profile must be a lowercase profile id.');
      if (request.profile && request.profile !== headerProfile) throw new HttpError(400, 'X-Jarvis-Profile and jarvis_profile disagree.');
      request.profile = headerProfile;
    }
    const allowedProfiles = client.allowedProfiles ?? [];
    if (allowedProfiles.length && (!request.profile || !allowedProfiles.includes(request.profile))) {
      this.audit('SITE_AI_PROFILE_REJECTED', { clientId: client.id, site: client.name, profile: request.profile ?? null });
      try { this.options.store.recordUsage(client.id, { inputChars: 0, outputChars: 0, error: true }); } catch { /* best-effort */ }
      throw new HttpError(403, 'This site key is not allowed to use that profile.', 'permission_error');
    }
    const endpoint = this.options.modelEndpoint();
    if (!endpoint) throw new HttpError(503, 'JARVIS has no AI model configured.', 'server_error');

    const perClient = this.inFlight.get(client.id) ?? 0;
    const limits = this.options.concurrency?.() ?? {
      perClient: this.options.maxConcurrentPerClient ?? 2,
      total: this.options.maxConcurrentTotal ?? 4,
    };
    if (perClient >= limits.perClient || this.inFlightTotal >= limits.total) {
      throw new HttpError(429, 'JARVIS is busy with other requests; retry shortly.', 'rate_limit_error', { 'Retry-After': '2' });
    }
    this.inFlight.set(client.id, perClient + 1);
    this.inFlightTotal += 1;
    const started = Date.now();
    const controller = new AbortController();
    let clientGone = false;
    const onClose = () => {
      if (!res.writableEnded) {
        clientGone = true;
        controller.abort();
      }
    };
    res.on('close', onClose);
    // Hard ceiling for the whole request; first-token and idle limits are enforced separately.
    const maxTimer = setTimeout(() => controller.abort(), this.options.maxDurationMs ?? 300_000);
    const heavy = this.options.registerHeavyWork?.(`site AI request (${client.name})`, () => controller.abort());
    let status = 200;
    let outputChars = 0;
    const id = 'chatcmpl-' + randomUUID();
    const created = Math.floor(Date.now() / 1000);
    try {
      if (request.stream) {
        const result = await this.streamCompletion(endpoint, request, res, controller, id, created);
        status = result.status;
        outputChars = result.outputChars;
      } else {
        const text = await this.completeOnce(endpoint, request, controller);
        outputChars = text.content.length;
        sendJson(res, 200, {
          id, object: 'chat.completion', created, model: PUBLIC_MODEL_ID,
          choices: [{ index: 0, message: { role: 'assistant', content: text.content }, finish_reason: text.finishReason }],
        });
      }
    } catch (error) {
      status = error instanceof HttpError ? error.status : 500;
      if (!clientGone) throw error;
    } finally {
      clearTimeout(maxTimer);
      heavy?.done();
      res.off('close', onClose);
      this.inFlight.set(client.id, Math.max(0, (this.inFlight.get(client.id) ?? 1) - 1));
      this.inFlightTotal = Math.max(0, this.inFlightTotal - 1);
      // Metadata only: message content and generated text are never written to the audit log.
      // 499 marks a site that disconnected before the answer finished.
      try {
        this.options.audit.record('SITE_AI_REQUEST', {
          clientId: client.id, site: client.name, profile: request.profile ?? null, status: clientGone ? 499 : status, stream: request.stream,
          turnCount: request.messages.length,
          inputChars: request.messages.reduce((sum, message) => sum + message.content.length, 0),
          outputChars, durationMs: Date.now() - started, clientDisconnected: clientGone,
        });
      } catch { /* the request already completed; the next request will fail closed */ }
      try {
        this.options.store.recordUsage(client.id, {
          inputChars: request.messages.reduce((sum, message) => sum + message.content.length, 0),
          outputChars,
          error: status >= 400 && !clientGone,
        });
      } catch { /* usage accounting is best-effort; it never blocks an answer */ }
    }
  }

  /** Call the model; transport and HTTP failures are mapped to honest gateway errors. */
  private async callUpstream(endpoint: ModelEndpoint, request: ChatRequest, controller: AbortController): Promise<Response> {
    const timer = setTimeout(() => controller.abort(), this.firstTokenTimeoutMs());
    let upstream: Response;
    try {
      if (endpoint.format === 'anthropic') {
        const converted = toAnthropicMessages(request.messages);
        upstream = await this.fetchImpl(endpoint.baseUrl + '/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'anthropic-version': '2023-06-01',
            ...(endpoint.apiKey ? { 'x-api-key': endpoint.apiKey } : {}),
          },
          body: JSON.stringify({
            model: endpoint.model,
            ...(converted.system ? { system: converted.system } : {}),
            messages: converted.messages,
            stream: request.stream,
            max_tokens: request.maxTokens,
            ...(request.temperature !== undefined ? { temperature: Math.min(request.temperature, 1) } : {}),
          }),
          signal: controller.signal,
        });
      } else {
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
      }
    } catch {
      this.options.reportOutcome?.(endpoint, false);
      throw controller.signal.aborted
        ? new HttpError(504, 'The JARVIS model did not respond in time.', 'server_error')
        : new HttpError(503, 'The JARVIS model is not reachable. Is the local model running?', 'server_error');
    } finally {
      clearTimeout(timer);
    }
    this.options.reportOutcome?.(endpoint, upstream.ok || upstream.status < 500);
    if (!upstream.ok || !upstream.body) {
      await upstream.body?.cancel().catch(() => undefined);
      throw upstream.status === 404
        ? new HttpError(503, 'The configured JARVIS model is not installed.', 'server_error')
        : new HttpError(502, 'The JARVIS model could not complete the request.', 'server_error');
    }
    return upstream;
  }

  private async completeOnce(endpoint: ModelEndpoint, request: ChatRequest, controller: AbortController): Promise<{ content: string; finishReason: string }> {
    const upstream = await this.callUpstream(endpoint, request, controller);
    const timer = setTimeout(() => controller.abort(), this.firstTokenTimeoutMs());
    try {
      const payload = await upstream.json().catch(() => null) as {
        choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
        content?: Array<{ type?: unknown; text?: unknown }>;
        stop_reason?: unknown;
      } | null;
      if (endpoint.format === 'anthropic') {
        const blocks = Array.isArray(payload?.content) ? payload!.content : null;
        const text = blocks?.filter((block) => block.type === 'text' && typeof block.text === 'string').map((block) => block.text as string).join('');
        if (typeof text !== 'string') {
          throw controller.signal.aborted
            ? new HttpError(504, 'The JARVIS model did not respond in time.', 'server_error')
            : new HttpError(502, 'The JARVIS model returned an invalid response.', 'server_error');
        }
        return { content: text.slice(0, MAX_OUTPUT_CHARS), finishReason: anthropicFinish(payload?.stop_reason) ?? 'stop' };
      }
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw controller.signal.aborted
          ? new HttpError(504, 'The JARVIS model did not respond in time.', 'server_error')
          : new HttpError(502, 'The JARVIS model returned an invalid response.', 'server_error');
      }
      const finish = payload?.choices?.[0]?.finish_reason;
      return { content: content.slice(0, MAX_OUTPUT_CHARS), finishReason: typeof finish === 'string' ? finish : 'stop' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Stream in OpenAI chunk format. Headers and the assistant role chunk are sent
   * immediately and keep-alive comments follow while the model reads the prompt,
   * so slow local hardware does not trip proxy/tunnel first-byte timeouts.
   * Only assistant text deltas are relayed; provider metadata is dropped. Errors
   * after headers are sent are reported as an OpenAI-style `error` event.
   */
  private async streamCompletion(
    endpoint: ModelEndpoint, request: ChatRequest, res: ServerResponse, controller: AbortController, id: string, created: number,
  ): Promise<{ status: number; outputChars: number }> {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
      Connection: 'keep-alive',
    });
    const chunk = (delta: Record<string, string>, finish: string | null) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: PUBLIC_MODEL_ID, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let output = 0;
    const finishWithError = (error: HttpError) => {
      if (!res.destroyed) {
        res.end(`data: ${JSON.stringify({ error: { message: error.message, type: error.type, code: error.status } })}\n\ndata: [DONE]\n\n`);
      }
      return { status: res.destroyed ? 499 : error.status, outputChars: output };
    };
    res.write(chunk({ role: 'assistant' }, null));
    const keepAlive = setInterval(() => {
      if (!res.destroyed) res.write(': keep-alive\n\n');
    }, this.options.keepAliveMs ?? 15_000);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const armIdle = (ms: number) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        controller.abort();
        // Do not rely on the provider honouring the abort signal: cancel the read.
        void reader?.cancel().catch(() => undefined);
      }, ms);
    };
    try {
      let upstream: Response;
      try {
        upstream = await this.callUpstream(endpoint, request, controller);
      } catch (error) {
        return finishWithError(error instanceof HttpError ? error : new HttpError(502, 'The JARVIS model could not complete the request.', 'server_error'));
      }
      const decoder = new TextDecoder();
      let buffer = '';
      let finishReason = 'stop';
      let sawText = false;
      const handleLine = (line: string) => {
        if (!line.startsWith('data:')) return;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') return;
        try {
          const event = JSON.parse(data) as {
            type?: unknown;
            choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>;
            delta?: { type?: unknown; text?: unknown; stop_reason?: unknown };
          };
          if (endpoint.format === 'anthropic') {
            // Anthropic Messages SSE: text arrives in content_block_delta events.
            const finish = event.type === 'message_delta' ? anthropicFinish(event.delta?.stop_reason) : undefined;
            if (finish) finishReason = finish;
            if (event.type !== 'content_block_delta' || event.delta?.type !== 'text_delta') return;
            event.choices = [{ delta: { content: event.delta.text } }];
          }
          const choice = event.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === 'string' && text && output < MAX_OUTPUT_CHARS) {
            const bounded = text.slice(0, MAX_OUTPUT_CHARS - output);
            output += bounded.length;
            if (!sawText) {
              sawText = true;
              clearInterval(keepAlive);
            }
            res.write(chunk({ content: bounded }, null));
          }
          if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
        } catch { /* ignore malformed provider events */ }
      };
      reader = upstream.body!.getReader();
      armIdle(this.firstTokenTimeoutMs());
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // A cancelled read also reports done; treat a timeout abort as a failure.
            if (controller.signal.aborted) throw new Error('aborted');
            break;
          }
          armIdle(sawText ? this.options.idleTimeoutMs ?? 45_000 : this.firstTokenTimeoutMs());
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';
          lines.forEach(handleLine);
        }
      } catch {
        return finishWithError(new HttpError(504, sawText
          ? 'The JARVIS model stopped responding mid-answer.'
          : 'The JARVIS model did not respond in time.', 'server_error'));
      }
      buffer += decoder.decode();
      if (buffer.trim()) handleLine(buffer);
      if (res.destroyed) return { status: 499, outputChars: output };
      res.write(chunk({}, finishReason));
      res.end('data: [DONE]\n\n');
      return { status: 200, outputChars: output };
    } finally {
      clearInterval(keepAlive);
      if (idleTimer) clearTimeout(idleTimer);
    }
  }
}
