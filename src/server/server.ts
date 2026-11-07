import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { JarvisCoreService } from '../core/service.js';
import { LocalHeuristicPlanner } from '../planner/planner.js';
import { Permission, TaskState } from '../core/types.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { readOwnerTokenConfig } from '../config/runtimeConfig.js';
import { createConfiguredPiperProvider } from '../voice/piperTts.js';
import { JarvisPlatform, getCapability, listCapabilities, listCapabilitiesForPlatform } from '../capabilities/registry.js';
import { PersonalMemoryStore } from '../memory/personalMemoryStore.js';
import { createOfficialStoreSearch, StorePlatform } from '../stores/officialStore.js';
import { VoiceProviderRegistry } from '../voice/providers.js';
import { answerConversationalMessageResult, isActionRequest } from '../conversation/conversationalAssistant.js';
import { createConfiguredAgentModelAdapter, getAgentModelConfigStatus } from '../conversation/agentModelAdapter.js';
import { routeAgentRequest, runAgent } from '../conversation/agentOrchestrator.js';
import { ConversationSessionStore } from '../conversation/conversationSessionStore.js';
import { AgentRequestLimiter } from '../conversation/agentRequestLimiter.js';
import { AndroidCommandQueue } from '../android/commandQueue.js';

export class JarvisServer {
  private jarvis: JarvisCoreService;
  private server: ReturnType<typeof createServer>;
  private port: number;
  private readonly ownerControlToken: string | undefined;
  private readonly personalMemory?: PersonalMemoryStore;
  private readonly voiceProviders = new VoiceProviderRegistry();
  private readonly androidCommands = new AndroidCommandQueue();
  private readonly conversationSessions = new ConversationSessionStore();
  private readonly agentRequestLimiter = new AgentRequestLimiter();

  constructor(
    port: number = 3000,
    logPath: string = './data/audit.log',
    statePath?: string
  ) {
    this.port = port;
    const agentConfig = getAgentModelConfigStatus();
    console.info('[JARVIS] Advisory AI configuration:', agentConfig);
    this.ownerControlToken = readOwnerTokenConfig().ownerControlToken;
    this.jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), logPath, statePath, this.ownerControlToken);
    this.personalMemory = this.jarvis.personalMemory;
    this.server = createServer(this.handleRequest.bind(this));
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onListening = () => {
        this.server.off('error', onError);
        this.jarvis.startBackgroundServices();
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
    this.jarvis.stopBackgroundServices();
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
      // Capability metadata is descriptive only; it does not grant action permissions.
      if (req.method === 'GET' && url.pathname === '/api/capabilities') {
        const requestedPlatform = url.searchParams.get('platform');
        const supportedPlatforms: readonly string[] = ['windows', 'android', 'ios', 'web'];
        if (requestedPlatform && !supportedPlatforms.includes(requestedPlatform)) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'Unsupported platform filter' }));
          return;
        }
        const capabilities = requestedPlatform
          ? listCapabilitiesForPlatform(requestedPlatform as Exclude<JarvisPlatform, 'all'>)
          : listCapabilities();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ capabilities }));
        return;
      }

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
      // Optional, one-time-installed local wake-word assets. Only explicit filenames are served.
      if (req.method === 'GET' && url.pathname.startsWith('/hud/local-wakeword/')) {
        const filename = url.pathname.slice('/hud/local-wakeword/'.length);
        const allowed = /^(?:ort\.min\.js|jszip\.min\.js|wakeword\.js|melspectrogram\.onnx|multi_jarvis_v9\.3\.zip|ort-wasm[\w.-]+\.(?:wasm|mjs|js))$/;
        if (!allowed.test(filename)) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('Local wake-word asset not found');
          return;
        }
        const contentType = filename.endsWith('.wasm') ? 'application/wasm'
          : filename.endsWith('.onnx') || filename.endsWith('.zip') ? 'application/octet-stream'
          : filename.endsWith('.js') || filename.endsWith('.mjs') ? 'application/javascript; charset=utf-8'
          : 'application/octet-stream';
        return this.serveStatic(join('local-wakeword', filename), contentType, res);
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
        // Only coarse, measured, non-identifying runtime facts are exposed here.
        return this.jsonResponse(res, 200, {
          status: integrityHealthy && stateHealthy ? 'ONLINE' : 'DEGRADED',
          platform: process.platform,
          uptimeSeconds: Math.round(process.uptime()),
          checks: { auditIntegrity: integrityHealthy, identityState: stateHealthy },
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
        const { challengeToken, deviceName, publicKey, proofSignature, platform } = body as {
          challengeToken: string;
          deviceName: string;
          publicKey: string;
          proofSignature: string;
          platform?: string;
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
        const normalizedPlatform = typeof platform === 'string' ? platform : 'Browser';
        if (!['Android', 'Browser', 'Windows', 'iOS'].includes(normalizedPlatform)) {
          return this.jsonResponse(res, 400, { error: 'platform must be Android, Browser, Windows, or iOS' });
        }
        const result = this.jarvis.identity.enrollDevice(challengeToken, deviceName, publicKey, normalizedPlatform);
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
        const devices = this.jarvis.identity.listDevices().map((device) => ({ id: device.id, name: device.name, platform: device.platform || 'Browser', status: device.status, permissions: device.permissions, enrolledAt: device.enrolledAt, lastActivityAt: device.lastSeenAt, sessionActive: this.jarvis.identity.hasActiveSession?.(device.id, now) ?? device.status === 'ACTIVE' }));
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

      // Official-store discovery returns official search destinations only; it never installs software.
      if (req.method === 'POST' && url.pathname === '/api/store-search') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const input = body as { platform?: unknown; query?: unknown };
        if (!['windows', 'android', 'ios'].includes(String(input.platform)) || typeof input.query !== 'string') {
          return this.jsonResponse(res, 400, { error: 'platform must be windows, android, or ios; query must be a string' });
        }
        try {
          const result = createOfficialStoreSearch(input.platform as StorePlatform, input.query);
          this.jarvis.audit.record('OFFICIAL_STORE_SEARCH_CREATED', { platform: result.platform, queryLength: result.query.length }, auth.device.id);
          return this.jsonResponse(res, 200, result);
        } catch (error) {
          return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Store search rejected' });
        }
      }

      // Personal memory is encrypted at rest and restricted to authenticated management devices.
      if (url.pathname.startsWith('/api/memory')) {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        if (!this.personalMemory) return this.jsonResponse(res, 503, { error: 'Personal memory requires a configured owner control token' });
        const body = req.method === 'GET' ? undefined : await this.readJsonBody(req);
        if (req.method !== 'GET' && !this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Memory access requires device-management permission' });
        const memoryPolicy = this.jarvis.policy.evaluate(
          { operation: 'memory:list', parameters: {} },
          auth.device,
          `memory-${CryptoUtil.randomToken(8)}`,
        );
        if (!memoryPolicy.allowed) return this.jsonResponse(res, 403, { error: memoryPolicy.reason || 'Memory listing is not authorized' });

        if (req.method === 'GET' && url.pathname === '/api/memory') {
          return this.jsonResponse(res, 200, { status: this.personalMemory.status(), records: this.personalMemory.list() });
        }
        return this.jsonResponse(res, 405, { error: 'Unsupported memory method or route' });
      }

      // Local TTS is an authenticated, bounded operation; it has no execution authority.
      if (req.method === 'POST' && url.pathname === '/api/voice/synthesize') {
        const sessionId = req.headers['x-session-id'] as string;
        if (!sessionId) return this.jsonResponse(res, 401, { error: 'Missing x-session-id header' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const { text } = body as { text: string };
        if (typeof text !== 'string' || !text.trim() || text.length > 1200) {
          return this.jsonResponse(res, 400, { error: 'text must be a non-empty string up to 1200 characters' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        let provider;
        try {
          provider = createConfiguredPiperProvider();
        } catch {
          // Configuration diagnostics can contain local paths. Keep them server-side.
          return this.jsonResponse(res, 503, { error: 'Local speech configuration is invalid' });
        }
        if (!provider) {
          return this.jsonResponse(res, 503, { error: 'Local Piper TTS is not configured', code: 'LOCAL_TTS_NOT_CONFIGURED' });
        }
        const synthesisAbort = new AbortController();
        const abortIfDisconnected = (): void => {
          if (!res.writableEnded) synthesisAbort.abort();
        };
        res.once('close', abortIfDisconnected);
        req.once('aborted', abortIfDisconnected);
        try {
          const audio = await provider.synthesize(text, synthesisAbort.signal);
          if (synthesisAbort.signal.aborted || res.destroyed) return;
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
          res.end(audio);
          return;
        } catch {
          // Piper stderr and spawn errors may disclose executable/model paths.
          if (!synthesisAbort.signal.aborted && !res.destroyed) {
            return this.jsonResponse(res, 502, { error: 'Local speech generation failed' });
          }
          return;
        } finally {
          res.off('close', abortIfDisconnected);
          req.off('aborted', abortIfDisconnected);
        }
      }

      // Voice provider status: which speech engines are really available, and their privacy properties.
      if (req.method === 'GET' && url.pathname === '/api/voice/capabilities') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        return this.jsonResponse(res, 200, await this.voiceProviders.describe());
      }

      // Local speech-to-text. The result is only text: it must still be submitted as a normal
      // request and pass the planner and PolicyGateway. Audio is processed locally and not stored.
      if (req.method === 'POST' && url.pathname === '/api/voice/transcribe') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req, 4 * 1024 * 1024);
        if (!this.isJsonObject(body) || typeof body.audioBase64 !== 'string' || !body.audioBase64) return this.jsonResponse(res, 400, { error: 'audioBase64 (16 kHz mono 16-bit WAV) is required' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const provider = await this.voiceProviders.pickLocalStt();
        if (!provider) return this.jsonResponse(res, 503, { error: 'No local speech recognition engine is installed', code: 'LOCAL_STT_NOT_CONFIGURED' });
        try {
          const result = await provider.transcribe(Buffer.from(body.audioBase64, 'base64'));
          this.jarvis.audit.record('VOICE_TRANSCRIBED_LOCALLY', { provider: result.provider, textLength: result.text.length }, auth.device.id);
          return this.jsonResponse(res, 200, { text: result.text, provider: result.provider, local: result.local });
        } catch {
          // Keep provider diagnostics (including temporary/model paths) out of API responses.
          return this.jsonResponse(res, 422, { error: 'Local speech recognition failed' });
        }
      }

      // Clear one conversation only after signed authentication; device ownership is enforced by the store.
      if (req.method === 'POST' && url.pathname === '/api/conversation/clear') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || !this.conversationSessions.isValidId(body.conversationId)) {
          return this.jsonResponse(res, 400, { error: 'A valid conversationId is required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const deviceId = auth.device.id;
        // Serialize clearing with message handling to prevent an in-flight response
        // from persisting history after the clear operation completes.
        const cleared = await this.conversationSessions.runExclusive(
          body.conversationId,
          () => Promise.resolve(this.conversationSessions.clear(body.conversationId, deviceId)),
        );
        return this.jsonResponse(res, cleared ? 200 : 404, { success: cleared });
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
        const { text, conversationId } = body as { text: string; conversationId?: string };
        if (conversationId !== undefined && !this.conversationSessions.isValidId(conversationId)) {
          return this.jsonResponse(res, 400, { error: 'conversationId must be a valid conversation UUID' });
        }
        if (typeof text !== 'string' || !text.trim() || text.length > 4000) {
          return this.jsonResponse(res, 400, { error: 'text must be a non-empty string up to 4000 characters' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) {
          return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        }
        // Conversation requests are handled only after signed-session authentication.
        // Action-like directives continue through the existing planner and PolicyGateway.
        // Supply only request-relevant memories to the conversational prompt.
        // The memory store is encrypted and the model treats these records as untrusted data.
        const conversationMemory = auth.device.permissions.includes(Permission.DEVICE_MANAGE) && this.personalMemory
          ? this.personalMemory.relevant(text.trim(), 5).map((record) => ({ content: record.content, category: record.category }))
          : [];

        // Do not allocate conversation state for commands routed to the execution planner.
        if (isActionRequest(text.trim())) {
          const result = await this.jarvis.submitRequest(sessionId, text.trim());
          return this.jsonResponse(res, 200, result);
        }
        const lockId = conversationId || 'unthreaded:' + auth.device.id + ':' + text.trim();
        return await this.conversationSessions.runExclusive(lockId, async () => {
          const conversation = this.conversationSessions.getOrCreate(auth.device.id, conversationId);
          if (!conversation) return this.jsonResponse(res, 403, { error: 'Conversation does not belong to this authenticated device' });

          // Advisory agents share the same device-bound conversation thread and lock.
          // Only a small recent slice is supplied as untrusted context; it never grants tool authority.
          const agentRoute = routeAgentRequest(text.trim());
          if (agentRoute.destination === 'agent' && agentRoute.profile !== 'developer_assistant') {
            const adapter = createConfiguredAgentModelAdapter();
            if (adapter) {
              const limit = this.agentRequestLimiter.consume(auth.device.id);
              if (!limit.allowed) {
                this.jarvis.audit.record('ADVISORY_AGENT_RATE_LIMITED', {
                  profile: agentRoute.profile,
                  retryAfterSeconds: limit.retryAfterSeconds,
                }, auth.device.id);
                res.setHeader('Retry-After', String(limit.retryAfterSeconds));
                return this.jsonResponse(res, 429, {
                  error: 'The advisory AI request limit has been reached for this device.',
                  code: 'ADVISORY_AI_RATE_LIMITED',
                  retryAfterSeconds: limit.retryAfterSeconds,
                });
              }
              const recentHistory = conversation.history.slice(-3).map((message) => ({
                label: 'conversation_' + message.role,
                content: message.content,
              }));
              const agentResult = await runAgent({
                request: text.trim(),
                profile: agentRoute.profile,
                context: [
                  ...conversationMemory.map((item) => ({ label: item.category, content: item.content })),
                  ...recentHistory,
                ],
              }, adapter);
              if (agentResult.status === 'completed') {
                const response = agentResult.response;
                // Model output supplies candidate IDs and reasoning only. All capability
                // status, platform, risk and approval metadata comes from the trusted catalogue.
                const capabilityDetails: Array<{
                  toolId: string;
                  name: string;
                  description: string;
                  platforms: readonly string[];
                  status: string;
                  risk: string;
                  requiresApproval: boolean;
                  requiresDeviceAgent: boolean;
                }> = [];
                if ('candidates' in response) {
                  for (const candidate of response.candidates) {
                    const capability = getCapability(candidate.toolId);
                    if (!capability || capability.status === 'restricted') continue;
                    capabilityDetails.push({
                      toolId: capability.id,
                      name: capability.name,
                      description: capability.description,
                      platforms: capability.platforms,
                      status: capability.status,
                      risk: capability.risk,
                      requiresApproval: capability.requiresApproval,
                      requiresDeviceAgent: capability.requiresDeviceAgent,
                    });
                  }
                }
                const message = 'summary' in response
                  ? response.summary
                  : 'goal' in response
                    ? response.goal + (response.steps.length ? '\\n' + response.steps.map((step, index) => (index + 1) + '. ' + step.title + ': ' + step.description).join('\\n') : '')
                    : 'candidates' in response
                      ? response.candidates.map((candidate) => {
                        const capability = capabilityDetails.find((item) => item.toolId === candidate.toolId);
                        if (!capability) return candidate.toolId + ': capability metadata unavailable; do not use.';
                        const approval = capability.requiresApproval ? 'owner approval required' : 'no separate approval flag';
                        return capability.name + ' (' + capability.status + ', ' + capability.risk + ' risk, ' + approval + ', platforms: ' + capability.platforms.join(', ') + '): ' + candidate.rationale;
                      }).join('\\n') || 'No supported tool was identified.'
                      : 'The agent completed the request.';
                this.conversationSessions.appendTurn(conversation.id, auth.device.id, text.trim(), message);
                this.jarvis.audit.record('ADVISORY_AGENT_COMPLETED', { profile: agentResult.profile, requestLength: text.trim().length }, auth.device.id);
                return this.jsonResponse(res, 200, {
                  state: 'ANSWERED',
                  message,
                  data: {
                    kind: 'agent',
                    profile: agentResult.profile,
                    conversationId: conversation.id,
                    response,
                    ...(capabilityDetails.length ? { capabilityDetails } : {}),
                  },
                });
              }
              this.jarvis.audit.record('ADVISORY_AGENT_FALLBACK', {
                profile: agentRoute.profile,
                status: agentResult.status,
                failureCode: agentResult.status === 'invalid_response' || agentResult.status === 'unavailable'
                  ? agentResult.failureCode
                  : 'unexpected_agent_route',
                requestLength: text.trim().length,
                contextItemCount: Math.min(8, conversationMemory.length + recentHistory.length),
              }, auth.device.id);
            }
          }

          const conversationalResult = await answerConversationalMessageResult(text.trim(), conversationMemory, conversation.history);
          if (conversationalResult) {
            if (conversationalResult.persistInHistory) {
              this.conversationSessions.appendTurn(conversation.id, auth.device.id, text.trim(), conversationalResult.answer);
            }
            this.jarvis.audit.record('CONVERSATIONAL_ANSWER', {
              requestLength: text.trim().length,
              responseLength: conversationalResult.answer.length,
              persisted: conversationalResult.persistInHistory,
            }, auth.device.id);
            return this.jsonResponse(res, 200, {
              state: 'ANSWERED',
              message: conversationalResult.answer,
              data: { kind: 'conversation', conversationId: conversation.id },
            });
          }
          return this.jsonResponse(res, 200, await this.jarvis.submitRequest(sessionId, text.trim()));
        });
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

      // Owner-to-Android command channel. Only a read-only app inventory request is
      // supported here; arbitrary shell/code and remote app launches are deliberately excluded.
      if (req.method === 'POST' && url.pathname === '/api/android/commands/create') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || body.operation !== 'android.app.list' || typeof body.targetDeviceId !== 'string') {
          return this.jsonResponse(res, 400, { error: 'Only android.app.list with a targetDeviceId is supported' });
        }
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Device-management permission is required' });
        const target = this.jarvis.identity.getDevice(body.targetDeviceId);
        if (!target || target.status !== 'ACTIVE' || target.platform !== 'Android') return this.jsonResponse(res, 404, { error: 'Active Android target not found' });
        if (!target.permissions.includes(Permission.SYSTEM_INFO_READ)) return this.jsonResponse(res, 403, { error: 'Target phone lacks read-only inventory permission' });
        const command = this.androidCommands.create(target.id, auth.device.id, 60_000);
        this.jarvis.audit.record('ANDROID_COMMAND_QUEUED', { commandId: command.id, operation: command.operation, targetDeviceId: target.id }, auth.device.id);
        return this.jsonResponse(res, 201, { command });
      }

      if (req.method === 'GET' && url.pathname === '/api/android/commands/next') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (auth.device.platform !== 'Android' || !auth.device.permissions.includes(Permission.SYSTEM_INFO_READ)) return this.jsonResponse(res, 403, { error: 'Android read-only agent permission is required' });
        const command = this.androidCommands.claimNext(auth.device.id);
        return this.jsonResponse(res, 200, { command });
      }

      if (req.method === 'POST' && url.pathname === '/api/android/commands/result') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.commandId !== 'string' || !Array.isArray(body.apps)) {
          return this.jsonResponse(res, 400, { error: 'commandId and apps array are required' });
        }
        if (body.apps.length > 300 || body.apps.some((app) => !this.isJsonObject(app) ||
            typeof app.label !== 'string' || app.label.length > 120 ||
            typeof app.packageName !== 'string' || app.packageName.length > 240)) {
          return this.jsonResponse(res, 400, { error: 'App inventory entries are invalid or exceed limits' });
        }
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (auth.device.platform !== 'Android') return this.jsonResponse(res, 403, { error: 'Only an Android device can return app inventory' });
        const completed = this.androidCommands.complete(auth.device.id, body.commandId, body.apps as Array<{label:string; packageName:string}>);
        if (!completed) return this.jsonResponse(res, 409, { error: 'Command is expired, unknown, already completed, or belongs to another device' });
        this.jarvis.audit.record('ANDROID_COMMAND_COMPLETED', { commandId: body.commandId, appCount: body.apps.length }, auth.device.id);
        return this.jsonResponse(res, 200, { success: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/android/commands/results') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Device-management permission is required' });
        return this.jsonResponse(res, 200, { results: this.androidCommands.resultsForRequester(auth.device.id) });
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
        // Immediately invalidate that device's approvals, schedules and running tasks.
        this.jarvis.onDeviceRevoked(deviceId);
        const cancelledAndroidCommands = this.androidCommands.cancelForDevice(deviceId);
        if (cancelledAndroidCommands > 0) {
          this.jarvis.audit.record('ANDROID_COMMANDS_CANCELLED_DEVICE_REVOKED', {
            revokedDeviceId: deviceId,
            cancelledCount: cancelledAndroidCommands,
          }, auth.device.id);
        }
        return this.jsonResponse(res, 200, { success: true });
      }

      // Notifications for approvals, blocked actions, failures, uncertain outcomes and completions.
      if (req.method === 'GET' && url.pathname === '/api/notifications') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const manager = auth.device.permissions.includes(Permission.DEVICE_MANAGE);
        const all = this.jarvis.notifications.list(manager ? {} : { deviceId: auth.device.id });
        return this.jsonResponse(res, 200, { notifications: all.slice(-50) });
      }

      // Measured service and host health for owner devices.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Insufficient permission to view health details' });
        return this.jsonResponse(res, 200, this.jarvis.getHealthSnapshot());
      }

      // Task list with per-step status. Parameters and results are not exposed here.
      if (req.method === 'GET' && url.pathname === '/api/tasks') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const manager = auth.device.permissions.includes(Permission.DEVICE_MANAGE);
        const tasks = this.jarvis.listTasks()
          .filter((task) => manager || task.deviceId === auth.device!.id)
          .slice(-30)
          .map((task) => ({
            id: task.id,
            state: task.state,
            operation: task.operation,
            origin: task.origin,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            steps: task.steps || [],
            // Only expose the exact directive and single-use approval token while consent is pending.
            ...(task.state === TaskState.AWAITING_APPROVAL && task.approvalId
              ? { approvalId: task.approvalId, requestText: task.requestText }
              : {}),
          }));
        return this.jsonResponse(res, 200, { tasks });
      }

      // Manual recovery review is an annotation/closure action only. It never retries or resumes a task.
      if (req.method === 'POST' && url.pathname === '/api/task/reconcile') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) ||
            typeof body.taskId !== 'string' || !body.taskId ||
            typeof body.note !== 'string' ||
            !['confirmed_no_effect', 'effect_observed', 'still_unknown'].includes(String(body.disposition))) {
          return this.jsonResponse(res, 400, { error: 'taskId, a valid disposition, and a recovery note are required' });
        }
        if (body.note.trim().length < 8 || body.note.length > 500) {
          return this.jsonResponse(res, 400, { error: 'Recovery note must be 8–500 characters' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.jarvis.hasDurableTaskJournal()) return this.jsonResponse(res, 503, { error: 'Durable task recovery is not configured', code: 'TASK_JOURNAL_NOT_CONFIGURED' });
        const result = this.jarvis.reconcileTask(
          body.taskId,
          sessionId,
          body.disposition as 'confirmed_no_effect' | 'effect_observed' | 'still_unknown',
          body.note,
        );
        return this.jsonResponse(res, result.success ? 200 : 503, result);
      }

      // Cancel a waiting task (invalidating its approval) or interrupt a running one.
      if (req.method === 'POST' && url.pathname === '/api/task/cancel') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.taskId !== 'string' || !body.taskId) return this.jsonResponse(res, 400, { error: 'taskId is required' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const result = this.jarvis.cancelTask(body.taskId, sessionId);
        return this.jsonResponse(res, result.success ? 200 : 409, result);
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
      if (/recovery disposition|recovery note/i.test(message)) return this.jsonResponse(res, 400, { error: message });
      if (/not awaiting recovery/i.test(message)) return this.jsonResponse(res, 409, { error: message });
      if (/expired|no longer pending|no longer awaiting approval|already been consumed|scope was modified|could not be rejected/i.test(message)) {
        return this.jsonResponse(res, 409, { error: message });
      }
      if (/proof verification failed/i.test(message)) return this.jsonResponse(res, 401, { error: 'Enrollment proof verification failed' });
      if (/invalid enrollment details/i.test(message)) return this.jsonResponse(res, 400, { error: 'Enrollment details are invalid' });
      if (/denied by security policy/i.test(message)) return this.jsonResponse(res, 403, { error: 'Enrollment request denied by security policy' });
      if (/Enrollment code is invalid|Enrollment request expired or changed/i.test(message)) return this.jsonResponse(res, 409, { error: 'Enrollment transaction is invalid, expired, or no longer available' });
      if (/not registered or revoked|lacks permission|only the requesting device/i.test(message)) {
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

  private readJsonBody(req: IncomingMessage, maxBytes: number = 1024 * 64): Promise<unknown> {
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
        if (Buffer.byteLength(body, 'utf8') > maxBytes) {
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
