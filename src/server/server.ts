import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JarvisCoreService } from '../core/service.js';
import { LocalHeuristicPlanner } from '../planner/planner.js';
import { Permission } from '../core/types.js';

export class JarvisServer {
  private jarvis: JarvisCoreService;
  private server: ReturnType<typeof createServer>;
  private port: number;
  private readonly ownerControlToken = process.env.JARVIS_OWNER_CONTROL_TOKEN;

  constructor(
    port: number = 3000,
    logPath: string = './data/audit.log',
    statePath?: string
  ) {
    this.port = port;
    this.jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), logPath, statePath);
    this.server = createServer(this.handleRequest.bind(this));
  }

  public start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.port, '127.0.0.1', () => {
        resolve(this.port);
      });
    });
  }

  public stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  public getService(): JarvisCoreService {
    return this.jarvis;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set secure security headers
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    try {
      // 1. Static UI routes (Companion & HUD)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return this.serveStatic('index.html', 'text/html', res);
      }
      if (req.method === 'GET' && url.pathname === '/style.css') {
        return this.serveStatic('style.css', 'text/css', res);
      }
      if (req.method === 'GET' && url.pathname === '/app.js') {
        return this.serveStatic('app.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/deviceCrypto.js') {
        return this.serveStatic('deviceCrypto.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && (url.pathname === '/hud' || url.pathname === '/hud/index.html')) {
        return this.serveStatic('hud.html', 'text/html', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/hud.css') {
        return this.serveStatic('hud.css', 'text/css', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/hud.js') {
        return this.serveStatic('hud.js', 'application/javascript', res);
      }

      // 2. API Routes
      if (req.method === 'GET' && url.pathname === '/api/status') {
        // Public health response only; never disclose device records, public-key
        // material, task content, or audit internals without an authorized session.
        return this.jsonResponse(res, 200, { status: 'ONLINE' });
      }

      // Create enrollment challenge
      if (req.method === 'POST' && url.pathname === '/api/enrollment/challenge') {
        if (!this.ownerControlToken) {
          return this.jsonResponse(res, 503, { error: 'Owner enrollment control is not configured', code: 'OWNER_CONTROL_NOT_CONFIGURED' });
        }
        if (!this.isOwnerControlAuthorized(req)) {
          return this.jsonResponse(res, 401, { error: 'Owner control authorization required' });
        }
        const challenge = this.jarvis.identity.createEnrollmentChallenge([
          Permission.SYSTEM_INFO_READ,
          Permission.APP_LAUNCH,
        ]);
        return this.jsonResponse(res, 201, challenge);
      }

      // HUD sessions must use the same device-bound cryptographic enrollment and
      // signed session flow as every other client. Never mint sessions from loopback
      // status alone or mutate DeviceIdentityManager internals.
      if (req.method === 'POST' && url.pathname === '/api/hud/session') {
        return this.jsonResponse(res, 503, {
          error: 'HUD session bootstrap is disabled until device-bound key enrollment is configured.',
          code: 'SECURE_HUD_ENROLLMENT_REQUIRED',
        });
      }

      // Redeem enrollment challenge
      if (req.method === 'POST' && url.pathname === '/api/enrollment/redeem') {
        const body = await this.readJsonBody(req);
        const { challengeToken, deviceName, publicKey } = body as {
          challengeToken: string;
          deviceName: string;
          publicKey: string;
        };
        if (typeof challengeToken !== 'string' || typeof deviceName !== 'string' || typeof publicKey !== 'string') {
          return this.jsonResponse(res, 400, { error: 'challengeToken, deviceName, and publicKey are required strings' });
        }
        const result = this.jarvis.identity.enrollDevice(challengeToken, deviceName, publicKey);
        if (!result.success) {
          return this.jsonResponse(res, 400, { error: result.error });
        }
        return this.jsonResponse(res, 200, result);
      }

      // Establish session
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await this.readJsonBody(req);
        const { deviceId, signature, timestamp, nonce } = body as {
          deviceId: string;
          signature: string;
          timestamp: number;
          nonce: string;
        };
        if (typeof deviceId !== 'string' || typeof signature !== 'string' || !Number.isFinite(timestamp) ||
            typeof nonce !== 'string' || !/^[a-f0-9]{32,128}$/i.test(nonce)) {
          return this.jsonResponse(res, 400, { error: 'deviceId, signature, numeric timestamp, and a 16-byte-or-stronger hexadecimal nonce are required' });
        }
        const sessionRes = this.jarvis.identity.createSession(deviceId, signature, timestamp, nonce);
        if (!sessionRes.success) {
          return this.jsonResponse(res, 401, { error: sessionRes.error });
        }
        return this.jsonResponse(res, 200, sessionRes);
      }

      // Submit user request
      if (req.method === 'POST' && url.pathname === '/api/request') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const body = await this.readJsonBody(req);
        const { text } = body as { text: string };
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
          return this.jsonResponse(res, 400, { error: 'text must be a non-empty string up to 4000 characters' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        const result = await this.jarvis.submitRequest(sessionId, text.trim());
        return this.jsonResponse(res, 200, result);
      }

      // Approve task
      if (req.method === 'POST' && url.pathname === '/api/approval/approve') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const body = await this.readJsonBody(req);
        const { approvalId } = body as { approvalId: string };
        if (typeof approvalId !== 'string' || !approvalId) {
          return this.jsonResponse(res, 400, { error: 'approvalId is required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        const result = await this.jarvis.approveTask(approvalId, auth.device.id);
        return this.jsonResponse(res, 200, result);
      }

      // Reject task
      if (req.method === 'POST' && url.pathname === '/api/approval/reject') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const body = await this.readJsonBody(req);
        const { approvalId } = body as { approvalId: string };
        if (typeof approvalId !== 'string' || !approvalId) {
          return this.jsonResponse(res, 400, { error: 'approvalId is required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        const result = this.jarvis.rejectTask(approvalId, auth.device.id);
        return this.jsonResponse(res, 200, result);
      }

      // Revoke device
      if (req.method === 'POST' && url.pathname === '/api/device/revoke') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const body = await this.readJsonBody(req);
        const { deviceId, reason } = body as { deviceId: string; reason?: string };
        if (typeof deviceId !== 'string' || !deviceId) {
          return this.jsonResponse(res, 400, { error: 'deviceId is required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        if (deviceId !== auth.device.id && !auth.device.permissions.includes(Permission.DEVICE_MANAGE)) {
          return this.jsonResponse(res, 403, { error: 'Insufficient permission to revoke another device' });
        }
        const success = this.jarvis.identity.revokeDevice(deviceId, reason);
        if (!success) {
          return this.jsonResponse(res, 409, { success: false, error: 'Device not found or revocation could not be persisted' });
        }
        return this.jsonResponse(res, 200, { success: true });
      }

      // Audit logs (for dashboard monitoring)
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) {
          return this.jsonResponse(res, 403, { error: 'Insufficient permission to view audit records' });
        }
        const records = this.jarvis.audit.getRecords();
        return this.jsonResponse(res, 200, { records: records.slice(-50) });
      }

      return this.jsonResponse(res, 404, { error: 'Not found' });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Request failed';
      if (message === 'Invalid JSON payload') {
        return this.jsonResponse(res, 400, { error: 'Invalid JSON payload' });
      }
      if (message === 'Payload too large') {
        return this.jsonResponse(res, 413, { error: 'Payload too large' });
      }
      if (message === 'Content-Type must be application/json') {
        return this.jsonResponse(res, 415, { error: message });
      }
      if (message === 'Approval not found' || message === 'Associated task not found') {
        return this.jsonResponse(res, 404, { error: message });
      }
      if (/expired|no longer pending|already been consumed|scope was modified|could not be rejected/i.test(message)) {
        return this.jsonResponse(res, 409, { error: message });
      }
      if (/not registered or revoked|lacks permission/i.test(message)) {
        return this.jsonResponse(res, 403, { error: message });
      }
      if (message.startsWith('Authentication failed')) {
        return this.jsonResponse(res, 401, { error: 'Unauthorized session' });
      }
      // Keep internal exception details in server-side diagnostics only.
      return this.jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }

  private authorizeSignedRequest(req: IncomingMessage, sessionId: string, path: string, body: unknown) {
    const timestampHeader = req.headers['x-request-timestamp'];
    const nonce = req.headers['x-request-nonce'];
    const signature = req.headers['x-request-signature'];
    if (typeof timestampHeader !== 'string' || typeof nonce !== 'string' || typeof signature !== 'string') {
      return { valid: false as const, error: 'Missing signed request headers' };
    }
    return this.jarvis.identity.validateSignedRequest(
      sessionId,
      req.method || 'GET',
      path,
      Number(timestampHeader),
      nonce,
      body,
      signature,
    );
  }

  private isOwnerControlAuthorized(req: IncomingMessage): boolean {
    const supplied = req.headers['x-owner-control-token'];
    if (!this.ownerControlToken || typeof supplied !== 'string') return false;
    const expectedBytes = Buffer.from(this.ownerControlToken, 'utf8');
    const suppliedBytes = Buffer.from(supplied, 'utf8');
    return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
  }

  private serveStatic(filename: string, contentType: string, res: ServerResponse): void {
    const filePath = join(process.cwd(), 'src', 'companion', filename);
    if (!existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
      return;
    }
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  }

  private jsonResponse(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private readJsonBody(req: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const contentType = req.headers['content-type'] || '';
      if (!contentType.toLowerCase().includes('application/json')) {
        reject(new Error('Content-Type must be application/json'));
        return;
      }
      let body = '';
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      req.on('data', (chunk: Buffer | string) => {
        if (settled) return;
        body += chunk.toString();
        if (Buffer.byteLength(body, 'utf8') > 1024 * 64) {
          fail(new Error('Payload too large'));
          // Drain the rest without buffering it so the connection can finish cleanly.
          req.resume();
        }
      });
      req.on('end', () => {
        if (settled) return;
        try {
          const parsed: unknown = body ? JSON.parse(body) : {};
          settled = true;
          resolve(parsed);
        } catch {
          fail(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', (error) => fail(error instanceof Error ? error : new Error('Request stream failed')));
    });
  }
}
