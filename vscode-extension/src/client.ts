import { request } from 'node:http';
import { requireLoopbackBase } from './loopback';

export type PostResult =
  | { kind: 'ok'; status: number }
  /** Permanently refused (schema/size): drop it, retrying cannot help. */
  | { kind: 'rejected'; status: number; error: string }
  | { kind: 'auth'; status: number }
  /** JARVIS unreachable or busy: keep it queued. */
  | { kind: 'retry'; status: number; error: string };

/** POST one redacted episode to the loopback JARVIS. Throws if the URL is not loopback http. */
export function postEpisode(baseUrl: string, ingestKey: string, episode: unknown, timeoutMs = 5000): Promise<PostResult> {
  const base = new URL(requireLoopbackBase(baseUrl));
  const payload = Buffer.from(JSON.stringify(episode), 'utf8');
  return new Promise((resolve) => {
    const req = request({
      host: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || 80, path: '/api/learning/episodes', method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': payload.length, 'x-jarvis-ingest-key': ingestKey },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { if (body.length < 2000) body += chunk; });
      res.on('end', () => {
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) return resolve({ kind: 'ok', status });
        if (status === 401 || status === 403) return resolve({ kind: 'auth', status });
        if (status === 429 || status >= 500 || status === 503) return resolve({ kind: 'retry', status, error: `HTTP ${status}` });
        resolve({ kind: 'rejected', status, error: body.slice(0, 200) });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ kind: 'retry', status: 0, error: 'timeout' }); });
    req.on('error', (error) => resolve({ kind: 'retry', status: 0, error: error.message }));
    req.end(payload);
  });
}
