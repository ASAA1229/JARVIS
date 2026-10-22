import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JarvisCoreService } from '../core/service.js';
import { LocalHeuristicPlanner } from '../planner/planner.js';
import { Permission } from '../core/types.js';
import { CryptoUtil } from '../crypto/crypto.js';

export class JarvisServer {
  private jarvis: JarvisCoreService;
  private server: ReturnType<typeof createServer>;
  private port: number;

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
    res.setHeader('Content-Security-Policy', "default-src 'self' 'unsafe-inline'; img-src 'self' data:;");

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
        const devices = this.jarvis.identity.listDevices();
        const tasks = this.jarvis.listTasks();
        const auditIntegrity = this.jarvis.audit.verifyIntegrity();
        return this.jsonResponse(res, 200, {
          status: 'ONLINE',
          devicesCount: devices.length,
          tasksCount: tasks.length,
          auditIntegrity,
          devices,
        });
      }

      // Create enrollment challenge
      if (req.method === 'POST' && url.pathname === '/api/enrollment/challenge') {
        const challenge = this.jarvis.identity.createEnrollmentChallenge([
          Permission.SYSTEM_INFO_READ,
          Permission.APP_LAUNCH,
        ]);
        return this.jsonResponse(res, 201, challenge);
      }

      // Loopback HUD Session Endpoint (Auto-provisions local enclave session for loopback HUD only)
      if (req.method === 'POST' && url.pathname === '/api/hud/session') {
        const remoteIp = req.socket.remoteAddress;
        if (remoteIp !== '127.0.0.1' && remoteIp !== '::1' && remoteIp !== '::ffff:127.0.0.1') {
          return this.jsonResponse(res, 403, { error: 'HUD session auto-provisioning is restricted to loopback' });
        }
        // Ensure local HUD device exists
        let localDevice = this.jarvis.identity.listDevices().find(d => d.name === 'Windows 11 HUD Enclave');
        if (!localDevice) {
          const challenge = this.jarvis.identity.createEnrollmentChallenge([
            Permission.SYSTEM_INFO_READ,
            Permission.APP_LAUNCH,
          ]);
          const kp = CryptoUtil.generateEd25519KeyPair();
          const enroll = this.jarvis.identity.enrollDevice(challenge.challengeToken, 'Windows 11 HUD Enclave', kp.publicKey);
          localDevice = this.jarvis.identity.getDevice(enroll.deviceId!);
        }

        // Create genuine active session
        const ts = Date.now();
        const dummySessionId = `sess-hud-${CryptoUtil.randomToken(16)}`;
        // Register session internally
        const sessionRecord = {
          id: dummySessionId,
          deviceId: localDevice!.id,
          createdAt: ts,
          expiresAt: ts + 3600 * 1000,
          active: true,
        };
        (this.jarvis.identity as any).sessions.set(dummySessionId, sessionRecord);

        return this.jsonResponse(res, 200, {
          sessionId: dummySessionId,
          device: localDevice,
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
        const result = this.jarvis.identity.enrollDevice(challengeToken, deviceName, publicKey);
        if (!result.success) {
          return this.jsonResponse(res, 400, { error: result.error });
        }
        return this.jsonResponse(res, 200, result);
      }

      // Establish session
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await this.readJsonBody(req);
        const { deviceId, signature, timestamp } = body as {
          deviceId: string;
          signature: string;
          timestamp: number;
        };
        const sessionRes = this.jarvis.identity.createSession(deviceId, signature, timestamp);
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
        const result = await this.jarvis.submitRequest(sessionId, text);
        return this.jsonResponse(res, 200, result);
      }

      // Approve task
      if (req.method === 'POST' && url.pathname === '/api/approval/approve') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const auth = this.jarvis.identity.validateDeviceSession(sessionId);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Unauthorized session' });
        }

        const body = await this.readJsonBody(req);
        const { approvalId } = body as { approvalId: string };
        const result = await this.jarvis.approveTask(approvalId, auth.device.id);
        return this.jsonResponse(res, 200, result);
      }

      // Reject task
      if (req.method === 'POST' && url.pathname === '/api/approval/reject') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const auth = this.jarvis.identity.validateDeviceSession(sessionId);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Unauthorized session' });
        }

        const body = await this.readJsonBody(req);
        const { approvalId } = body as { approvalId: string };
        const result = this.jarvis.rejectTask(approvalId, auth.device.id);
        return this.jsonResponse(res, 200, result);
      }

      // Revoke device
      if (req.method === 'POST' && url.pathname === '/api/device/revoke') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const auth = this.jarvis.identity.validateDeviceSession(sessionId);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Unauthorized session' });
        }

        const body = await this.readJsonBody(req);
        const { deviceId, reason } = body as { deviceId: string; reason?: string };
        const success = this.jarvis.identity.revokeDevice(deviceId, reason);
        return this.jsonResponse(res, 200, { success });
      }

      // Audit logs (for dashboard monitoring)
      if (req.method === 'GET' && url.pathname === '/api/audit') {
        const records = this.jarvis.audit.getRecords();
        return this.jsonResponse(res, 200, { records: records.slice(-50) });
      }

      return this.jsonResponse(res, 404, { error: 'Not found' });
    } catch (err: unknown) {
      return this.jsonResponse(res, 500, { error: String(err) });
    }
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
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 1024 * 64) {
          // Reject oversized payloads (>64KB)
          reject(new Error('Payload too large'));
        }
      });
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {});
        } catch {
          reject(new Error('Invalid JSON payload'));
        }
      });
      req.on('error', reject);
    });
  }
}
