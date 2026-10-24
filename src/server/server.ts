import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { JarvisCoreService } from '../core/service.js';
import { LocalHeuristicPlanner } from '../planner/planner.js';
import { Permission } from '../core/types.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { readOwnerTokenConfig } from '../config/runtimeConfig.js';

export class JarvisServer {
  private jarvis: JarvisCoreService;
  private server: ReturnType<typeof createServer>;
  private port: number;
  private readonly ownerControlToken: string | undefined;

  constructor(
    port: number = 3000,
    logPath: string = './data/audit.log',
    statePath?: string
  ) {
    this.port = port;
    this.ownerControlToken = readOwnerTokenConfig().ownerControlToken;
    this.jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), logPath, statePath, this.ownerControlToken);
    this.server = createServer(this.handleRequest.bind(this));
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onListening = () => {
        this.server.off('error', onError);
        resolve(this.port);
      };
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };

      this.server.once('error', onError);
      this.server.once('listening', onListening);
      try {
        this.server.listen(this.port, '127.0.0.1');
      } catch (error) {
        this.server.off('error', onError);
        this.server.off('listening', onListening);
        reject(error);
      }
    });
  }

  public stop(): Promise<void> {
    if (!this.server.listening) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
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
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    try {
      // 1. Static UI routes (Companion & HUD)
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/hud')) {
        return this.serveStatic('hud.html', 'text/html', res);
      }
      if (req.method === 'GET' && (url.pathname === '/companion' || url.pathname === '/companion/index.html')) {
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
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (req.method === 'GET' && url.pathname === '/hud/index.html') {
        return this.serveStatic('hud.html', 'text/html', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/hud.css') {
        return this.serveStatic('hud.css', 'text/css', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/hud.js') {
        return this.serveStatic('hud.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/gesture.js') {
        return this.serveStatic('gesture.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/gesture-worker.js') {
        return this.serveStatic('gesture-worker.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/gesture-intent.js') {
        return this.serveStatic('gesture-intent.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/gesture/gesture-recognition.js') {
        return this.serveStatic('gesture-recognition.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/gesture/gesture-recognition-core.js') {
        return this.serveStatic('gesture-recognition-core.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/gesture/vision_bundle.js') {
        return this.serveFile(join(process.cwd(), 'node_modules', '@mediapipe', 'tasks-vision', 'vision_bundle.js'), 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname.startsWith('/gesture/wasm/')) {
        const filename = url.pathname.slice('/gesture/wasm/'.length);
        const wasmFiles: Record<string, { path: string; contentType: string }> = {
          'vision_wasm_internal.js': { path: 'wasm/vision_wasm_internal.js', contentType: 'application/javascript' },
          'vision_wasm_internal.wasm': { path: 'wasm/vision_wasm_internal.wasm', contentType: 'application/wasm' },
          'vision_wasm_module_internal.js': { path: 'wasm/vision_wasm_module_internal.js', contentType: 'application/javascript' },
          'vision_wasm_module_internal.wasm': { path: 'wasm/vision_wasm_module_internal.wasm', contentType: 'application/wasm' },
          'vision_wasm_nosimd_internal.js': { path: 'wasm/vision_wasm_nosimd_internal.js', contentType: 'application/javascript' },
          'vision_wasm_nosimd_internal.wasm': { path: 'wasm/vision_wasm_nosimd_internal.wasm', contentType: 'application/wasm' },
        };
        const asset = wasmFiles[filename];
        if (!asset) return this.jsonResponse(res, 404, { error: 'Gesture runtime asset not found' });
        return this.serveFile(join(process.cwd(), 'node_modules', '@mediapipe', 'tasks-vision', asset.path), asset.contentType, res);
      }
      if (req.method === 'GET' && url.pathname === '/gesture/hand_landmarker.task') {
        return this.serveFile(join(process.cwd(), 'src', 'companion', 'models', 'hand_landmarker.task'), 'application/octet-stream', res);
      }

      // 2. API Routes
      if (req.method === 'GET' && url.pathname === '/api/status') {
        // Public health response only; never disclose device records, public-key
        // material, task content, or audit internals without an authorized session.
        const integrityHealthy = this.jarvis.audit.verifyIntegrity().valid;
        const stateHealthy = this.jarvis.identity.isStateHealthy();
        return this.jsonResponse(res, 200, {
          status: integrityHealthy && stateHealthy ? 'ONLINE' : 'DEGRADED',
        });
      }

      // Create enrollment challenge
      if (req.method === 'POST' && url.pathname === '/api/enrollment/challenge') {
        if (!this.ownerControlToken) {
          return this.jsonResponse(res, 503, { error: 'Owner enrollment control is not configured', code: 'OWNER_CONTROL_NOT_CONFIGURED' });
        }
        if (!this.isOwnerControlAuthorized(req)) {
          return this.jsonResponse(res, 401, { error: 'Owner control authorization required' });
        }
        if (this.jarvis.identity.listDevices().some((device) => device.status === 'ACTIVE')) {
          return this.jsonResponse(res, 403, { error: 'Bootstrap enrollment is closed; an authorized device must create and approve enrollment requests' });
        }
        const challenge = this.jarvis.identity.createEnrollmentChallenge([
          Permission.SYSTEM_INFO_READ,
          Permission.APP_LAUNCH,
          Permission.DEVICE_MANAGE,
        ]);
        const qrSvg = await QRCode.toString(challenge.uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 220 });
        return this.jsonResponse(res, 201, { ...challenge, qrSvg });
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
        if (!this.isJsonObject(body)) {
          return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        }
        const { challengeToken, deviceName, publicKey, proofSignature } = body as {
          challengeToken: string;
          deviceName: string;
          publicKey: string;
          proofSignature: string;
        };
        if (typeof challengeToken !== 'string' || typeof deviceName !== 'string' ||
            typeof publicKey !== 'string' || typeof proofSignature !== 'string') {
          return this.jsonResponse(res, 400, { error: 'challengeToken, deviceName, publicKey, and proofSignature are required strings' });
        }
        const proofPayload = `ENROLLMENT_PROOF:${challengeToken}:${deviceName}:${CryptoUtil.sha256(publicKey)}`;
        if (!CryptoUtil.isValidEd25519PublicKey(publicKey) ||
            !CryptoUtil.verifySignature(proofPayload, proofSignature, publicKey)) {
          return this.jsonResponse(res, 401, { error: 'Enrollment proof-of-possession verification failed' });
        }
        const result = this.jarvis.identity.enrollDevice(challengeToken, deviceName, publicKey);
        if (!result.success) {
          return this.jsonResponse(res, 400, { error: result.error });
        }
        return this.jsonResponse(res, 200, result);
      }

      if (req.method === 'POST' && url.pathname === '/api/enrollment/exchange') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const fields = body as Record<string, unknown>;
        if (['transactionId', 'code', 'name', 'platform', 'publicKey', 'proofSignature'].some((key) => typeof fields[key] !== 'string')) return this.jsonResponse(res, 400, { error: 'Enrollment request fields are invalid' });
        if (!this.jarvis.deviceSecurity) return this.jsonResponse(res, 503, { error: 'Owner security is not configured' });
        const state = this.jarvis.deviceSecurity.exchangeEnrollment(fields as { transactionId: string; code: string; name: string; platform: string; publicKey: string; proofSignature: string });
        return this.jsonResponse(res, 202, state);
      }

      if (req.method === 'POST' && url.pathname === '/api/enrollment/status') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.transactionId !== 'string' || typeof body.code !== 'string') return this.jsonResponse(res, 400, { error: 'Enrollment reference is invalid' });
        const state = this.jarvis.deviceSecurity?.statusForEnrollment(body.transactionId, body.code);
        return state ? this.jsonResponse(res, 200, state) : this.jsonResponse(res, 404, { error: 'Enrollment request not found' });
      }

      if (req.method === 'POST' && url.pathname === '/api/enrollment/details') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.transactionId !== 'string' || typeof body.code !== 'string') return this.jsonResponse(res, 400, { error: 'Enrollment reference is invalid' });
        const details = this.jarvis.deviceSecurity?.getEnrollmentDetails(body.transactionId, body.code);
        return details ? this.jsonResponse(res, 200, details) : this.jsonResponse(res, 404, { error: 'Enrollment reference is invalid or expired' });
      }

      if (req.method === 'POST' && url.pathname === '/api/enrollment/transactions') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.totpCode !== 'string') return this.jsonResponse(res, 400, { error: 'Authenticator code is required' });
        const auth = this.authorizeControl(req, url.pathname, body, 'device:enrollment:create');
        if (!auth.device) return this.jsonResponse(res, auth.status, { error: auth.error });
        if (!this.jarvis.deviceSecurity) return this.jsonResponse(res, 503, { error: 'Owner security is not configured' });
        const result = await this.jarvis.deviceSecurity.createEnrollment(auth.device, body.totpCode, Array.isArray(body.permissions) ? body.permissions as Permission[] : undefined);
        return this.jsonResponse(res, 201, result);
      }

      if (req.method === 'GET' && url.pathname === '/api/enrollment/pending') {
        const auth = this.authorizeControl(req, url.pathname, undefined, 'device:enrollment:list');
        if (!auth.device) return this.jsonResponse(res, auth.status, { error: auth.error });
        return this.jsonResponse(res, 200, { requests: this.jarvis.deviceSecurity?.listPending(auth.device) || [] });
      }

      if (req.method === 'POST' && ['/api/enrollment/approve', '/api/enrollment/reject', '/api/enrollment/cancel'].includes(url.pathname)) {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.transactionId !== 'string') return this.jsonResponse(res, 400, { error: 'transactionId is required' });
        const op = url.pathname.endsWith('approve') ? 'device:enrollment:approve' : url.pathname.endsWith('reject') ? 'device:enrollment:reject' : 'device:enrollment:cancel';
        const auth = this.authorizeControl(req, url.pathname, body, op);
        if (!auth.device) return this.jsonResponse(res, auth.status, { error: auth.error });
        const security = this.jarvis.deviceSecurity;
        if (!security) return this.jsonResponse(res, 503, { error: 'Owner security is not configured' });
        if (op.endsWith('approve')) {
          if (typeof body.totpCode !== 'string' || typeof body.requestHash !== 'string') return this.jsonResponse(res, 400, { error: 'Fresh authenticator code and request binding are required' });
          const result = await security.approve(auth.device, body.transactionId, body.requestHash, body.totpCode);
          return this.jsonResponse(res, 200, { success: true, deviceId: result.deviceId });
        }
        const success = op.endsWith('reject') ? security.reject(auth.device, body.transactionId) : security.cancel(auth.device, body.transactionId);
        return this.jsonResponse(res, success ? 200 : 409, { success });
      }

      if (req.method === 'GET' && url.pathname === '/api/devices') {
        const auth = this.authorizeControl(req, url.pathname, undefined, 'device:list');
        if (!auth.device) return this.jsonResponse(res, auth.status, { error: auth.error });
        const now = Date.now();
        const devices = this.jarvis.identity.listDevices().map((device) => ({ id: device.id, name: device.name, platform: 'Browser', status: device.status, permissions: device.permissions, enrolledAt: device.enrolledAt, lastActivityAt: device.lastSeenAt, sessionActive: this.jarvis.identity.hasActiveSession?.(device.id, now) ?? device.status === 'ACTIVE' }));
        return this.jsonResponse(res, 200, { devices });
      }

      if (req.method === 'GET' && url.pathname === '/api/security/totp/status') {
        const auth = this.authorizeControl(req, url.pathname, undefined, 'security:totp:verify');
        if (!auth.device) return this.jsonResponse(res, auth.status, { error: auth.error });
        return this.jsonResponse(res, 200, { status: this.jarvis.deviceSecurity?.getTotpStatus() || 'DISABLED' });
      }

      if (req.method === 'POST' && ['/api/security/totp/setup', '/api/security/totp/verify-setup', '/api/security/totp/disable'].includes(url.pathname)) {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const operation = url.pathname.endsWith('setup') && !url.pathname.endsWith('verify-setup') ? 'security:totp:setup' : url.pathname.endsWith('disable') ? 'security:totp:disable' : 'security:totp:verify';
        const auth = this.authorizeControl(req, url.pathname, body, operation);
        if (!auth.device) return this.jsonResponse(res, auth.status, { error: auth.error });
        const security = this.jarvis.deviceSecurity;
        if (!security) return this.jsonResponse(res, 503, { error: 'Owner security is not configured' });
        if (operation === 'security:totp:setup') return this.jsonResponse(res, 201, await security.startTotpSetup(auth.device));
        if (typeof body.code !== 'string') return this.jsonResponse(res, 400, { error: 'Authenticator code is required' });
        const success = operation === 'security:totp:disable' ? security.disableTotp(auth.device, body.code) : security.verifyTotpSetup(auth.device, body.code);
        return this.jsonResponse(res, success ? 200 : 401, { success, status: security.getTotpStatus() });
      }

      // Establish session
      if (req.method === 'POST' && url.pathname === '/api/session') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) {
          return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        }
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
        const device = this.jarvis.identity.getDevice(deviceId);
        if (!device) {
          return this.jsonResponse(res, 401, { error: 'Device is no longer available' });
        }
        return this.jsonResponse(res, 200, {
          ...sessionRes,
          permissions: [...device.permissions],
        });
      }

      // Submit user request
      if (req.method === 'POST' && url.pathname === '/api/request') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) {
          return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        }
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
        if (!this.isJsonObject(body)) {
          return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        }
        const { approvalId } = body as { approvalId: string };
        if (typeof approvalId !== 'string' || !approvalId) {
          return this.jsonResponse(res, 400, { error: 'approvalId is required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        const result = await this.jarvis.approveTask(approvalId, sessionId);
        return this.jsonResponse(res, 200, result);
      }

      // Reject task
      if (req.method === 'POST' && url.pathname === '/api/approval/reject') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) {
          return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        }
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) {
          return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        }
        const { approvalId } = body as { approvalId: string };
        if (typeof approvalId !== 'string' || !approvalId) {
          return this.jsonResponse(res, 400, { error: 'approvalId is required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        const result = this.jarvis.rejectTask(approvalId, sessionId);
        return this.jsonResponse(res, 200, result);
      }

      // Revoke device
      if (req.method === 'POST' && url.pathname === '/api/device/revoke') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) {
          return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        }
        const { deviceId, reason } = body as { deviceId: string; reason?: string };
        if (typeof deviceId !== 'string' || !deviceId) {
          return this.jsonResponse(res, 400, { error: 'deviceId is required' });
        }
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const ownDevice = deviceId === auth.device.id;
        const decision = this.jarvis.policy.evaluate({ operation: ownDevice ? 'device:self-revoke' : 'device:revoke', parameters: {} }, auth.device, `security-${CryptoUtil.randomToken(8)}`);
        if (!decision.allowed) return this.jsonResponse(res, 403, { error: 'Device is not authorized to revoke this device' });
        if (auth.device.permissions.includes(Permission.DEVICE_MANAGE) && this.jarvis.deviceSecurity?.getTotpStatus() === 'ENABLED' && (typeof body.totpCode !== 'string' || !this.jarvis.deviceSecurity.verifyStepUp(auth.device, body.totpCode))) return this.jsonResponse(res, 401, { error: 'Fresh authenticator verification required' });
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
        if (!this.jarvis.audit.verifyIntegrity().valid) {
          return this.jsonResponse(res, 503, { error: 'Audit records are unavailable because integrity could not be verified' });
        }
        const records = this.jarvis.audit.getPublicRecords();
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
      if (/proof verification failed/i.test(message)) return this.jsonResponse(res, 401, { error: 'Enrollment proof verification failed' });
      if (/invalid enrollment details/i.test(message)) return this.jsonResponse(res, 400, { error: 'Enrollment details are invalid' });
      if (/denied by security policy/i.test(message)) return this.jsonResponse(res, 403, { error: 'Enrollment request denied by security policy' });
      if (/Enrollment code is invalid|Enrollment request expired or changed/i.test(message)) return this.jsonResponse(res, 409, { error: 'Enrollment transaction is invalid, expired, or no longer available' });
      if (/not registered or revoked|lacks permission/i.test(message)) {
        return this.jsonResponse(res, 403, { error: message });
      }
      if (message.startsWith('Authentication failed')) {
        return this.jsonResponse(res, 401, { error: 'Unauthorized session' });
      }
      if (/authenticator verification required|invalid or unknown|invalid, expired|expired or changed|lacks active device-management|invalid enrollment details|permission allowlist/i.test(message)) {
        return this.jsonResponse(res, 403, { error: message });
      }
      // Keep internal exception details in server-side diagnostics only.
      return this.jsonResponse(res, 500, { error: 'Internal server error' });
    }
  }

  private isJsonObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
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

  private authorizeControl(req: IncomingMessage, path: string, body: unknown, operation: string): { device?: import('../core/types.js').DeviceRecord; status: number; error?: string } {
    const sessionId = req.headers['x-session-id'];
    if (typeof sessionId !== 'string') return { status: 401, error: 'Missing authenticated device session' };
    const auth = this.authorizeSignedRequest(req, sessionId, path, body);
    if (!auth.valid || !auth.device) return { status: 401, error: auth.error || 'Signed request authentication failed' };
    const decision = this.jarvis.policy.evaluate({ operation, parameters: {} }, auth.device, `security-${CryptoUtil.randomToken(8)}`);
    if (!decision.allowed) return { status: 403, error: 'Device is not authorized for this security operation' };
    return { status: 200, device: auth.device };
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
    this.serveFile(filePath, contentType, res);
  }

  private serveFile(filePath: string, contentType: string, res: ServerResponse): void {
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
      const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
      if (mediaType !== 'application/json') {
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
