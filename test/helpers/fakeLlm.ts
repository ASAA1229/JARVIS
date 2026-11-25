import { createServer, type IncomingMessage, type Server } from 'node:http';
import { LlmError, type LlmBackend, type LlmChunk, type LlmErrorKind, type LlmMessage, type LlmOptions, type LlmProviderId, type LlmResult } from '../../src/ai/llmTypes.js';

/** Scriptable in-memory backend for routing tests. */
export class FakeBackend implements LlmBackend {
  readonly label: string;
  readonly supportsEmbeddings = true;
  calls: string[] = [];
  failWith: LlmErrorKind | null = null;
  reply = 'ok';
  streamParts: string[] = ['he', 'llo'];
  /** Throw this error after emitting the first stream part. */
  failAfterFirstPart: LlmErrorKind | null = null;
  usage = { inputTokens: 100, outputTokens: 50 };

  constructor(readonly id: LlmProviderId, readonly local: boolean, readonly paid: boolean, readonly defaultModel: string) {
    this.label = id;
  }

  async chat(model: string, _messages: LlmMessage[], _options: LlmOptions, _signal: AbortSignal): Promise<LlmResult> {
    this.calls.push(model);
    if (this.failWith) throw new LlmError(this.failWith, this.failWith === 'http_error' ? 500 : undefined);
    return { text: this.reply, usage: this.usage };
  }

  async *stream(model: string): AsyncGenerator<LlmChunk> {
    this.calls.push(model);
    if (this.failWith) throw new LlmError(this.failWith);
    for (const [index, part] of this.streamParts.entries()) {
      yield { text: part };
      if (index === 0 && this.failAfterFirstPart) throw new LlmError(this.failAfterFirstPart);
    }
    yield { usage: this.usage };
  }

  async embed(model: string, input: string[]): Promise<{ vectors: number[][] }> {
    this.calls.push(model);
    if (this.failWith) throw new LlmError(this.failWith);
    return { vectors: input.map(() => [0.1, 0.2]) };
  }

  async health() {
    return { ok: !this.failWith, latencyMs: 1 };
  }
}

export interface CapturedRequest {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface FakeServer {
  baseUrl: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

/** Real HTTP server on loopback; `handler` writes the response for each request. */
export async function startFakeServer(handler: (request: CapturedRequest, res: import('node:http').ServerResponse) => void): Promise<FakeServer> {
  const requests: CapturedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const captured = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      requests.push(captured);
      handler(captured, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

export function sendJson(res: import('node:http').ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function sendSse(res: import('node:http').ServerResponse, events: unknown[], done = false): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  if (done) res.write('data: [DONE]\n\n');
  res.end();
}
