import { REQUEST_ID_HEADER, resolveRequestId } from '../gateway/siteAiGateway.js';
import { runWithRequestId } from '../core/requestContext.js';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { JarvisCoreService } from '../core/service.js';
import { LocalHeuristicPlanner } from '../planner/planner.js';
import { Permission, TaskState } from '../core/types.js';
import { needsOwnerReview } from '../core/commandLifecycle.js';
import { CryptoUtil } from '../crypto/crypto.js';
import { readOwnerTokenConfig } from '../config/runtimeConfig.js';
import { createConfiguredPiperProvider } from '../voice/piperTts.js';
import { JarvisPlatform, getCapability, listCapabilities, listCapabilitiesForPlatform } from '../capabilities/registry.js';
import { PersonalMemoryStore, type MemoryCategory } from '../memory/personalMemoryStore.js';
import { createOfficialStoreSearch, StorePlatform } from '../stores/officialStore.js';
import { VoiceProviderRegistry, readVoicePrivacySettings } from '../voice/providers.js';
import { WakeSessionMachine } from '../voice/wakeSession.js';
import { AudioIngressGuard, mayReceiveAudio } from '../voice/audioPrivacy.js';
import { cloudRoutingAllowed } from '../ai/providerRouter.js';
import { VoiceUtteranceGuard, WakeMetrics, isValidUtteranceId } from '../voice/utteranceGuard.js';
import { answerConversationalMessageResult, isActionRequest } from '../conversation/conversationalAssistant.js';
import { createConfiguredAgentModelAdapter, getAgentModelConfigStatus } from '../conversation/agentModelAdapter.js';
import { routeAgentRequest, runAgent } from '../conversation/agentOrchestrator.js';
import { ConversationSessionStore } from '../conversation/conversationSessionStore.js';
import { DocumentRagStore } from '../memory/documentRagStore.js';
import { KnowledgeSourceRegistry } from '../memory/knowledgeSources.js';
import { DocumentParser } from '../memory/documentParser.js';
import { OllamaEmbedder, resolveLocalEmbeddingEndpoint } from '../memory/semanticIndex.js';
import { SyncStateStore } from '../sync/syncStateStore.js';
import { SyncService } from '../sync/syncService.js';
import { handleSyncRoute } from '../sync/syncRoutes.js';
import { PeerRegistry } from '../peers/peerRegistry.js';
import { PeerDiscoveryService } from '../peers/peerDiscovery.js';
import { handlePeerRoute } from '../peers/peerRoutes.js';
import { handleOwnerPanelRoute, OWNER_PANEL_PATHS } from './ownerPanelRoutes.js';
import { handleLearningRoute, LEARNING_PREFIX, LEARNING_COLLECTION } from './learningIngestRoutes.js';
import { EpisodeStore } from '../learning/episodeStore.js';
import { IngestKeyStore } from '../learning/ingestKeys.js';
import { BrowserKeyStore } from '../browser/browserKeys.js';
import { BrowserStore, BROWSING_COLLECTION } from '../browser/browserStore.js';
import { BrowserRoutes, BROWSER_PREFIX } from './browserRoutes.js';
import { handleWorkspaceRoute, isWorkspaceRoute } from './workspaceRoutes.js';
import { isStudioApiPath, isStudioStaticPath, serveStudioStatic, StudioRoutes, type StudioDeps } from './studioRoutes.js';
import { StudioStore } from '../studio/studioStore.js';
import { DuplicateMemoryError } from '../memory/memoryManager.js';
import { AgentRequestLimiter } from '../conversation/agentRequestLimiter.js';
import { resourceManager, type ProfileMode } from '../resources/resourceManager.js';
import { providerRouter } from '../ai/providerRouter.js';
import { OllamaProvider } from '../ai/ollamaProvider.js';
import { buildServiceManifest } from '../integration/serviceManifest.js';
import { evaluateRuntimeBudgets, summarizeMeasurements } from '../evaluation/runtimeBudgets.js';
import { AsaaEventProducer, categorizeAuditFailure } from '../integration/asaaEvents.js';
import { OidcSso, SsoError, SSO_CALLBACK_PATH, SSO_LOGIN_PATH, readOidcConfig } from '../identity/ssoOidc.js';
import { AndroidCommandQueue } from '../android/commandQueue.js';

export class JarvisServer {
  private jarvis: JarvisCoreService;
  private server: ReturnType<typeof createServer>;
  private port: number;
  private readonly ownerControlToken: string | undefined;
  private readonly syncStore: SyncStateStore | undefined;
  private readonly syncService: SyncService | undefined;
  /** LAN peers (J-E11): explicit pairing allowlist + optional LAN-only discovery. */
  private readonly peerRegistry: PeerRegistry | undefined;
  private readonly peerDiscovery: PeerDiscoveryService | undefined;
  private readonly personalMemory?: PersonalMemoryStore;
  private readonly voiceProviders = new VoiceProviderRegistry();
  private readonly utteranceGuard = new VoiceUtteranceGuard();
  private readonly wakeMetrics = new WakeMetrics();
  private readonly wakeSessions = new WakeSessionMachine({ metrics: this.wakeMetrics });
  private readonly audioIngress = new AudioIngressGuard();
  /** Every queue transition (queued, running, completed, timed_out, cancelled) is mirrored onto the event bus. */
  private readonly androidCommands = new AndroidCommandQueue((command, lifecycle) => {
    this.jarvis.events.publish('android.command', {
      commandId: command.id, status: lifecycle, lifecycle, targetDeviceId: command.targetDeviceId,
      ...(command.cancelReason ? { reason: command.cancelReason } : {}),
    }, command.requesterDeviceId);
  });
  /** Failed owner-recovery attempts (timestamps) for rate limiting. */
  private recoveryFailures: number[] = [];
  /** Failed owner-token attempts against bootstrap enrollment (separate from the recovery lockout). */
  private enrollmentTokenFailures: number[] = [];
  private readonly conversationSessions: ConversationSessionStore;
  private readonly documentRag?: DocumentRagStore;
  private readonly episodeStore?: EpisodeStore;
  private readonly ingestKeys: IngestKeyStore;
  /** JARVIS browser extension API (/api/browser/*): browser keys, pending pages, sessions. */
  private readonly browser: BrowserRoutes;
  /** Present only when JARVIS_KNOWLEDGE_SOURCES_ENFORCED=1: retrieval is limited to owner-approved collections. */
  private readonly knowledgeSources?: KnowledgeSourceRegistry;
  private readonly documentParser = new DocumentParser();
  /** JARVIS Studio (/studio): owner-only chat, API keys and learning. */
  private studio?: StudioRoutes;
  // Advisory-agent budget follows the active resource profile (US-061).
  private readonly agentRequestLimiter = new AgentRequestLimiter(() => resourceManager.limits().agentRequestsPer5Min);

  constructor(
    port: number = 3000,
    logPath: string = './data/audit.log',
    statePath?: string
  ) {
    this.port = port;
    const agentConfig = getAgentModelConfigStatus();
    console.info('[JARVIS] Advisory AI configuration:', agentConfig);
    this.ownerControlToken = readOwnerTokenConfig().ownerControlToken;
    this.conversationSessions = this.ownerControlToken
      ? new ConversationSessionStore(ConversationSessionStore.resolvePath(statePath), this.ownerControlToken)
      : new ConversationSessionStore();
    if (this.ownerControlToken) {
      const embeddingEndpoint = resolveLocalEmbeddingEndpoint();
      if (process.env.JARVIS_KNOWLEDGE_SOURCES_ENFORCED === '1') {
        this.knowledgeSources = new KnowledgeSourceRegistry(statePath ? statePath + '.knowledge-sources' : './data/knowledge-sources.enc', this.ownerControlToken);
      }
      this.documentRag = new DocumentRagStore(
        statePath ? statePath + '.documents' : './data/documents.enc',
        this.ownerControlToken,
        embeddingEndpoint ? new OllamaEmbedder(embeddingEndpoint) : null,
        this.knowledgeSources,
      );
    }
    this.ingestKeys = new IngestKeyStore(process.env.JARVIS_INGEST_KEYS_PATH || (statePath ? statePath + '.ingest-keys.json' : './data/ingest-keys.json'));
    if (this.ownerControlToken) this.episodeStore = new EpisodeStore(process.env.JARVIS_EPISODES_PATH || (statePath ? statePath + '.episodes' : './data/learning-episodes.enc'), this.ownerControlToken);
    this.browser = new BrowserRoutes({
      store: this.ownerControlToken ? new BrowserStore(process.env.JARVIS_BROWSER_STORE_PATH || (statePath ? statePath + '.browser' : './data/browser.enc'), this.ownerControlToken) : undefined,
      keys: new BrowserKeyStore(process.env.JARVIS_BROWSER_KEYS_PATH || (statePath ? statePath + '.browser-keys.json' : './data/browser-keys.json')),
      audit: { record: (...args) => this.jarvis.audit.record(...args) },
      readJsonBody: (request, maxBytes) => this.readJsonBody(request, maxBytes),
      authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
      json: (response, status, data) => this.jsonResponse(response, status, data),
      indexPage: (deviceId, stored, text) => this.documentRag?.ingest({
        ownerDeviceId: deviceId, sourceName: `page-${stored.id}.txt`, title: (stored.title || stored.url).slice(0, 80),
        collection: BROWSING_COLLECTION, replace: true, content: text,
      }).documentId,
      removeDocuments: (deviceId, ids) => { for (const id of ids) this.documentRag?.delete(deviceId, id); },
      searchKnowledge: async (deviceId, query, limit) => (this.documentRag ? await this.documentRag.search(deviceId, query, limit, undefined, BROWSING_COLLECTION) : []),
    });
    this.jarvis = new JarvisCoreService(new LocalHeuristicPlanner(), logPath, statePath, this.ownerControlToken);
    // Revocation isolates per-device voice state immediately (wake window, audio budget).
    this.jarvis.events.subscribe((event) => {
      if (event.type === 'device.revoked' && event.deviceId) {
        this.wakeSessions.forget(event.deviceId);
        this.audioIngress.forget(event.deviceId);
      }
    });
    this.personalMemory = this.jarvis.personalMemory;
    this.studio = new StudioRoutes({
      jarvis: this.jarvis,
      ...(this.ownerControlToken ? { store: new StudioStore(statePath ? statePath + '.studio' : './data/studio.enc', this.ownerControlToken) } : {}),
      readJsonBody: (request, maxBytes) => this.readJsonBody(request, maxBytes),
      authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
      json: (response, status, data) => this.jsonResponse(response, status, data),
      searchDocuments: async (deviceId, query, limit) => (this.documentRag ? await this.documentRag.search(deviceId, query, limit) : []),
    });
    // Laptop-hub device sync (US-060/027); needs the owner token for encrypted sync state.
    if (this.ownerControlToken && this.personalMemory) {
      this.syncStore = new SyncStateStore(statePath ? statePath + '.sync' : './data/device-sync.enc', this.ownerControlToken);
      this.syncService = new SyncService({
        store: this.syncStore,
        memory: this.personalMemory,
        audit: this.jarvis.audit,
        getDevice: (id) => this.jarvis.identity.getDevice(id),
        submitRequest: async (sessionId, text) => {
          const result = await this.jarvis.submitRequest(sessionId, text);
          return { taskId: result.taskId, state: String(result.state), ...(result.approvalId ? { approvalId: result.approvalId } : {}), message: result.message };
        },
      });
    }
    if (this.ownerControlToken) {
      this.peerRegistry = new PeerRegistry(statePath ? statePath + '.peers' : './data/lan-peers.enc', this.ownerControlToken, (id) => this.jarvis.identity.getDevice(id));
      this.peerDiscovery = new PeerDiscoveryService(this.peerRegistry, (event) => {
        // Rejections are frequent on a busy LAN; only accepted peer messages are audited.
        if (event.type === 'accepted') this.jarvis.audit.record('LAN_PEER_MESSAGE', { peerDeviceId: event.deviceId, type: event.message });
      });
    }
    const oidc = readOidcConfig(process.env, port);
    if (oidc.enabled) this.sso = new OidcSso(oidc.config);
    else if (oidc.reason !== 'not-configured') console.warn(`[JARVIS] ASAA single sign-on disabled: ${oidc.reason}.`);
    // ASAA ecosystem events: a disabled no-op unless ASAA_EVENTS_URL, ASAA_EVENTS_TOKEN and ASAA_ORG_ID are all set.
    this.asaaEvents = AsaaEventProducer.fromEnvironment(process.env, { statePath, ownerToken: this.ownerControlToken });
    if (this.asaaEvents.enabled) {
      this.jarvis.integrationSink = this.asaaEvents;
      this.jarvis.audit.onFailClosed = (reason) => this.asaaEvents.auditIntegrityFailed(categorizeAuditFailure(reason));
    }
    this.server = createServer(this.handleRequest.bind(this));
  }

  public start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onListening = () => {
        this.server.off('error', onError);
        this.jarvis.startBackgroundServices();
        // Expire phone commands that nobody touches, so none stays queued or running past its deadline.
        if (!this.androidSweepTimer) {
          this.androidSweepTimer = setInterval(() => this.androidCommands.sweep(), 15_000);
          this.androidSweepTimer.unref?.();
        }
        this.asaaEvents.start();
        // An audit failure that happened before the listener existed (startup verification) is still reported.
        const startupAuditFailure = this.jarvis.audit.getFailureReason();
        if (startupAuditFailure) this.asaaEvents.auditIntegrityFailed(categorizeAuditFailure(startupAuditFailure));
        // LAN discovery stays off unless JARVIS_PEER_DISCOVERY=true.
        this.peerDiscovery?.start();
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

  private androidSweepTimer?: ReturnType<typeof setInterval>;

  public stop(): Promise<void> {
    if (this.androidSweepTimer) { clearInterval(this.androidSweepTimer); this.androidSweepTimer = undefined; }
    this.jarvis.stopBackgroundServices();
    this.asaaEvents.stop();
    this.peerDiscovery?.stop();
    if (!this.server.listening) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private readonly asaaEvents: AsaaEventProducer;
  /** Optional ASAA single sign-on for enrollment authorization (disabled unless JARVIS_OIDC_* is configured). */
  private readonly sso?: OidcSso;
  private ssoRedirect(res: ServerResponse, fragment: string, extraHeaders: Record<string, string> = {}): void {
    res.writeHead(302, { Location: `/companion#${fragment}`, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...extraHeaders });
    res.end();
  }

  private static readonly SSO_COOKIE = 'jarvis_sso';
  private static readonly LOOPBACK_HOST = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d{1,5})?$/i;

  /** Starts the OIDC login. The state is also bound to this browser by a short-lived HttpOnly cookie (login CSRF defence). */
  private async handleSsoLogin(res: ServerResponse): Promise<void> {
    if (!this.sso) return this.jsonResponse(res, 404, { error: 'Single sign-on is not configured' });
    try {
      const login = await this.sso.beginLogin();
      res.writeHead(302, {
        Location: login.url,
        'Cache-Control': 'no-store',
        'Set-Cookie': `${JarvisServer.SSO_COOKIE}=${login.state}; HttpOnly; SameSite=Lax; Path=${SSO_CALLBACK_PATH}; Max-Age=600`,
      });
      res.end();
    } catch {
      this.jarvis.audit.record('SSO_LOGIN_FAILED', { reason: 'unavailable', stage: 'begin' });
      return this.jsonResponse(res, 503, { error: 'Single sign-on is currently unavailable' });
    }
  }

  /**
   * OIDC redirect target. On a fully verified sign-in (signature, claims, MFA evidence, required role)
   * it issues the same single-use enrollment challenge the owner token would, attributed to the SSO
   * identity, and hands it to the companion page in the URL fragment (never sent to a server).
   */
  private async handleSsoCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const clearCookie = { 'Set-Cookie': `${JarvisServer.SSO_COOKIE}=; HttpOnly; SameSite=Lax; Path=${SSO_CALLBACK_PATH}; Max-Age=0` };
    if (!this.sso) return this.jsonResponse(res, 404, { error: 'Single sign-on is not configured' });
    const fail = (code: string, reason: string): void => {
      try { this.jarvis.audit.record('SSO_LOGIN_FAILED', { reason, code }); } catch { /* audit failure already blocks other operations */ }
      this.ssoRedirect(res, `sso_error=${code}`, clearCookie);
    };
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code') ?? '';
    const cookie = /(?:^|;\s*)jarvis_sso=([A-Za-z0-9_-]{1,128})/.exec(String(req.headers.cookie ?? ''))?.[1];
    if (!state || cookie !== state) return fail('invalid_state', 'state_cookie_mismatch');
    if (url.searchParams.get('error')) {
      this.sso.completeLogin('', state).catch(() => undefined); // consume the pending state
      return fail('denied', 'idp_denied');
    }
    try {
      const identity = await this.sso.completeLogin(code, state);
      const challenge = this.jarvis.identity.createEnrollmentChallenge(
        [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE], 120, identity,
      );
      this.jarvis.audit.record('SSO_LOGIN_SUCCEEDED', { ssoSub: identity.sub, ssoUsername: identity.username ?? null });
      this.ssoRedirect(res, `sso_challenge=${encodeURIComponent(challenge.challengeToken)}&sso_expires=${challenge.expiresAt}`, clearCookie);
    } catch (error) {
      if (error instanceof SsoError) return fail(error.code, error.message.slice(0, 120));
      return fail('unavailable', 'unexpected');
    }
  }

  private aiGatewayRunning = false;

  /** Called by the process entry point once the optional site AI gateway listener is up. */
  public setAiGatewayRunning(running: boolean): void {
    this.aiGatewayRunning = running;
  }

  /** Manifest check value for the ASAA event producer; wired when the producer exists. */
  private asaaEventsCheck(): 'ok' | 'degraded' | 'down' | 'disabled' {
    return this.asaaEvents.manifestCheck();
  }

  /** Test seam: replace the Studio chat provider (the default is the router's local Ollama). */
  public setStudioProviderFactory(factory: StudioDeps['providerFactory']): void {
    this.studio?.setProviderFactory(factory);
    this.browser.setProviderFactory(factory ? () => factory() : undefined);
  }

  public getService(): JarvisCoreService {
    return this.jarvis;
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Set secure security headers
    const requestId = resolveRequestId(req.headers[REQUEST_ID_HEADER]);
    res.setHeader('X-Request-ID', requestId);
    return runWithRequestId(requestId, () => this.handleRequestInContext(req, res, requestId));
  }

  private async handleRequestInContext(req: IncomingMessage, res: ServerResponse, requestId: string): Promise<void> {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    // DNS-rebinding defence: the listener is loopback-only, so only loopback host names are valid.
    if (req.headers.host !== undefined && !JarvisServer.LOOPBACK_HOST.test(req.headers.host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Host not allowed' }));
      return;
    }
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    try {
      // Learning episodes from the VS Code extension: ingest-key POST plus owner-session management.
      if (url.pathname.startsWith(LEARNING_PREFIX)) {
        return handleLearningRoute(req, res, url, {
          store: this.episodeStore,
          keys: this.ingestKeys,
          audit: this.jarvis.audit,
          readJsonBody: (request, maxBytes) => this.readJsonBody(request, maxBytes),
          authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
          json: (response, status, data) => this.jsonResponse(response, status, data),
          indexEpisode: (deviceId, stored, text) => this.documentRag?.ingest({
            ownerDeviceId: deviceId, sourceName: `episode-${stored.id}`, title: (stored.episode.prompt ?? 'Episode').slice(0, 80),
            collection: LEARNING_COLLECTION, replace: true, content: text,
          }).documentId,
          removeDocuments: (deviceId, ids) => { for (const id of ids) this.documentRag?.delete(deviceId, id); },
        });
      }
      // Browser extension API: browser key (/ext) or owner session (/admin); loopback only.
      if (url.pathname.startsWith(BROWSER_PREFIX)) return this.browser.handle(req, res, url);
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

      // JARVIS Studio shell and API (owner-only; the API needs a signed DEVICE_MANAGE session).
      if (req.method === 'GET' && isStudioStaticPath(url.pathname)) return serveStudioStatic(url, res);
      if (isStudioApiPath(url.pathname) && this.studio) return await this.studio.handle(req, res, url);

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
      if (req.method === 'GET' && url.pathname === '/hud/hud-panels.js') {
        return this.serveStatic('hud-panels.js', 'application/javascript', res);
      }
      if (req.method === 'GET' && url.pathname === '/hud/hud-panels.css') {
        return this.serveStatic('hud-panels.css', 'text/css', res);
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
      // Lets the HUD check for the optional assets without provoking 404s in the browser console.
      if (req.method === 'GET' && url.pathname === '/hud/local-wakeword/status') {
        const required = ['ort.min.js', 'jszip.min.js', 'wakeword.js', 'melspectrogram.onnx', 'multi_jarvis_v9.3.zip'];
        const installed = required.every((name) => existsSync(join(process.cwd(), 'src', 'companion', 'local-wakeword', name)));
        return this.jsonResponse(res, 200, {
          installed,
          ...(installed ? {} : { setup: 'Run powershell -ExecutionPolicy Bypass -File scripts/setup-local-wake-word.ps1 once, then reload the HUD.' }),
        });
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
      // ASAA ecosystem service manifest v1: public, secret-free, derived from cached state only
      // (no network call per probe).
      if (req.method === 'GET' && url.pathname === '/.well-known/asaa-service') {
        const local = providerRouter.status().providers.find((item) => item.id === 'local');
        const manifest = buildServiceManifest({
          auditIntegrity: this.jarvis.audit.verifyIntegrity().valid,
          identityState: this.jarvis.identity.isStateHealthy(),
          ollama: local ? { configured: local.configured, available: local.available } : undefined,
          aiGatewayRunning: this.aiGatewayRunning,
          asaaEvents: this.asaaEventsCheck(),
        });
        res.setHeader('Cache-Control', 'no-store');
        return this.jsonResponse(res, 200, manifest);
      }

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

      // Owner recovery (JARVIS-US-005): authenticator loss or loss of every
      // device-management device. Authorized only by the owner control token from
      // this machine, never by a device session; rate limited; audited without secrets.
      if (req.method === 'POST' && url.pathname === '/api/owner/recovery') {
        if (!this.ownerControlToken || !this.jarvis.deviceSecurity) {
          return this.jsonResponse(res, 503, { error: 'Owner recovery requires a configured owner control token', code: 'OWNER_CONTROL_NOT_CONFIGURED' });
        }
        const remote = req.socket.remoteAddress || '';
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
          this.jarvis.audit.record('OWNER_RECOVERY_REJECTED', { reason: 'non_loopback' });
          return this.jsonResponse(res, 403, { error: 'Owner recovery is only available on the JARVIS host' });
        }
        const now = Date.now();
        this.recoveryFailures = this.recoveryFailures.filter((at) => now - at < 15 * 60_000);
        if (this.recoveryFailures.length >= 5) {
          return this.jsonResponse(res, 429, { error: 'Too many failed recovery attempts; wait 15 minutes' });
        }
        if (!this.isOwnerControlAuthorized(req)) {
          this.recoveryFailures.push(now);
          this.jarvis.audit.record('OWNER_RECOVERY_REJECTED', { reason: 'invalid_owner_token' });
          return this.jsonResponse(res, 401, { error: 'Owner control authorization required' });
        }
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || body.confirm !== 'RECOVER' ||
            !['reset_authenticator', 'revoke_device', 'revoke_all_devices'].includes(String(body.action))) {
          return this.jsonResponse(res, 400, { error: 'Body must be { action: reset_authenticator | revoke_device | revoke_all_devices, confirm: "RECOVER" }' });
        }
        const revoke = (deviceId: string): boolean => {
          if (!this.jarvis.identity.revokeDevice(deviceId, 'Owner recovery')) return false;
          // Same effects as a normal revocation: approvals, schedules, tasks, phone commands.
          this.jarvis.onDeviceRevoked(deviceId, 'owner-recovery');
          this.androidCommands.cancelForDevice(deviceId);
          return true;
        };
        if (body.action === 'reset_authenticator') {
          const result = this.jarvis.deviceSecurity.ownerResetAuthenticator();
          return this.jsonResponse(res, 200, { success: true, ...result, next: 'Set up a new authenticator from a device-management device.' });
        }
        if (body.action === 'revoke_device') {
          if (typeof body.deviceId !== 'string' || !body.deviceId) return this.jsonResponse(res, 400, { error: 'deviceId is required' });
          const target = this.jarvis.identity.getDevice(body.deviceId);
          if (!target || target.status !== 'ACTIVE') return this.jsonResponse(res, 404, { error: 'Active device not found' });
          if (!revoke(target.id)) return this.jsonResponse(res, 409, { success: false, error: 'Revocation could not be persisted' });
          this.jarvis.audit.record('OWNER_RECOVERY_DEVICE_REVOKED', { revokedDeviceId: target.id });
          return this.jsonResponse(res, 200, { success: true, revokedDeviceIds: [target.id] });
        }
        // revoke_all_devices: every active device is revoked and the authenticator reset,
        // which reopens owner-token bootstrap enrollment. Old keys cannot be re-enrolled.
        const active = this.jarvis.identity.listDevices().filter((device) => device.status === 'ACTIVE');
        const revokedDeviceIds = active.filter((device) => revoke(device.id)).map((device) => device.id);
        const failed = active.length - revokedDeviceIds.length;
        if (failed > 0) {
          // Do not clear the authenticator or reopen bootstrap enrollment unless every
          // active device revocation is durably persisted. Otherwise an old management
          // device could survive a restart while its second factor has been reset.
          this.jarvis.audit.record('OWNER_RECOVERY_ALL_DEVICES_PARTIAL_FAILURE', {
            revokedCount: revokedDeviceIds.length,
            failedCount: failed,
          });
          return this.jsonResponse(res, 409, {
            success: false,
            revokedDeviceIds,
            error: `${failed} device(s) could not be revoked durably; authenticator reset was not performed`,
            next: 'Restore durable device-state storage and retry recovery before resetting the authenticator.',
          });
        }
        // Anything that could still enroll a device (raw challenges, QR transactions) dies with the devices.
        this.jarvis.identity.invalidatePendingChallenges('owner-recovery');
        this.jarvis.deviceSecurity.cancelAllPending('owner-recovery');
        const authenticator = this.jarvis.deviceSecurity.ownerResetAuthenticator();
        this.jarvis.audit.record('OWNER_RECOVERY_ALL_DEVICES_REVOKED', { revokedCount: revokedDeviceIds.length, failedCount: 0 });
        return this.jsonResponse(res, 200, {
          success: true, revokedDeviceIds, ...authenticator,
          next: 'Enroll a new device with a NEW key via owner-token bootstrap enrollment (POST /api/enrollment/challenge).',
        });
      }

      // ASAA single sign-on (optional). Whether it is available is public; nothing else is.
      if (req.method === 'GET' && url.pathname === '/api/sso/status') {
        return this.jsonResponse(res, 200, { enabled: Boolean(this.sso) });
      }
      if (req.method === 'GET' && url.pathname === SSO_LOGIN_PATH) return this.handleSsoLogin(res);
      if (req.method === 'GET' && url.pathname === SSO_CALLBACK_PATH) return this.handleSsoCallback(req, res, url);

      // Create enrollment challenge
      if (req.method === 'POST' && url.pathname === '/api/enrollment/challenge') {
        if (!this.ownerControlToken) {
          return this.jsonResponse(res, 503, { error: 'Owner enrollment control is not configured', code: 'OWNER_CONTROL_NOT_CONFIGURED' });
        }
        const attemptAt = Date.now();
        this.enrollmentTokenFailures = this.enrollmentTokenFailures.filter((at) => attemptAt - at < 15 * 60_000);
        if (this.enrollmentTokenFailures.length >= 5) {
          return this.jsonResponse(res, 429, { error: 'Too many failed owner authorization attempts; wait 15 minutes' });
        }
        if (!this.isOwnerControlAuthorized(req)) {
          this.enrollmentTokenFailures.push(attemptAt);
          this.jarvis.audit.record('OWNER_ENROLLMENT_AUTH_REJECTED', { reason: 'invalid_owner_token' });
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

      // Owner HUD panels (J-E10) and gateway site management (J-E09). Mounted before the
      // /api/memory block so /api/memory/import is handled here.
      if (OWNER_PANEL_PATHS.includes(url.pathname)) {
        return handleOwnerPanelRoute(req, res, url, {
          jarvis: this.jarvis,
          readJsonBody: (request) => this.readJsonBody(request),
          authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
          json: (response, status, data) => this.jsonResponse(response, status, data),
        });
      }

      // JARVIS Studio Code view: workspace roots, files, coding helper (owner session + approvals).
      if (isWorkspaceRoute(url.pathname)) {
        return handleWorkspaceRoute(req, res, url, {
          jarvis: this.jarvis,
          readJsonBody: (request, maxBytes) => this.readJsonBody(request, maxBytes),
          authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
          json: (response, status, data) => this.jsonResponse(response, status, data),
        });
      }

      // Resource profiles (US-061) and AI provider routing status (US-059). Owner device only.
      if (url.pathname === '/api/resources' || url.pathname.startsWith('/api/resources/') || url.pathname === '/api/ai/providers' || url.pathname === '/api/ai/health') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = req.method === 'GET' ? undefined : await this.readJsonBody(req);
        if (req.method !== 'GET' && !this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) {
          return this.jsonResponse(res, 403, { error: 'Resource and provider controls require device-management permission' });
        }
        if (req.method === 'GET' && url.pathname === '/api/resources') {
          await resourceManager.sample();
          return this.jsonResponse(res, 200, { ...resourceManager.snapshot(), ai: providerRouter.status() });
        }
        if (req.method === 'GET' && url.pathname === '/api/ai/providers') {
          return this.jsonResponse(res, 200, providerRouter.status());
        }
        if (req.method === 'GET' && url.pathname === '/api/ai/health') {
          const ollama = providerRouter.localProvider();
          if (!ollama) return this.jsonResponse(res, 503, { available: false, modelAvailable: false, error: 'Ollama is not configured' });
          const embeddingEndpoint = resolveLocalEmbeddingEndpoint();
          const health = await new OllamaProvider({
            baseUrl: ollama.baseUrl,
            model: ollama.model,
            timeoutMs: ollama.timeoutMs,
            ...(embeddingEndpoint ? { embeddingModel: embeddingEndpoint.model } : {}),
          }).healthCheck();
          return this.jsonResponse(res, health.available && health.modelAvailable ? 200 : 503, health);
        }
        if (req.method === 'POST' && url.pathname === '/api/resources/profile') {
          const mode = (body as { mode?: unknown }).mode;
          if (!['auto', 'idle', 'normal', 'intensive'].includes(String(mode))) {
            return this.jsonResponse(res, 400, { error: 'mode must be auto, idle, normal or intensive' });
          }
          resourceManager.setMode(mode as ProfileMode);
          this.jarvis.audit.record('RESOURCE_PROFILE_SET', { mode }, auth.device.id);
          return this.jsonResponse(res, 200, resourceManager.snapshot());
        }
        if (req.method === 'POST' && url.pathname === '/api/resources/stop') {
          const id = (body as { id?: unknown }).id;
          if (id !== undefined && (typeof id !== 'string' || !/^hw-[a-z0-9]{1,12}$/.test(id))) {
            return this.jsonResponse(res, 400, { error: 'id must be a heavy-work id, or omitted to stop all' });
          }
          const stopped = resourceManager.stopHeavyWork(id as string | undefined);
          this.jarvis.audit.record('RESOURCE_HEAVY_WORK_STOPPED', { stopped, all: id === undefined }, auth.device.id);
          return this.jsonResponse(res, 200, { stopped, heavyWork: resourceManager.listHeavyWork() });
        }
        return this.jsonResponse(res, 405, { error: 'Unsupported resource method or route' });
      }

      // Personal memory is encrypted at rest and restricted to authenticated management devices.
      // Device sync and offline queues (US-060/027); signed session required on every route.
      if (url.pathname.startsWith('/api/sync/')) {
        return handleSyncRoute(req, res, url, {
          sync: this.syncService,
          store: this.syncStore,
          listDevices: () => this.jarvis.identity.listDevices(),
          readJsonBody: (request) => this.readJsonBody(request),
          authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
          json: (response, status, data) => this.jsonResponse(response, status, data),
        });
      }

      // LAN peers (J-E11): explicit pairing, allowlist, revocation; never command execution.
      if (url.pathname === '/api/peers' || url.pathname.startsWith('/api/peers/')) {
        return handlePeerRoute(req, res, url, {
          registry: this.peerRegistry,
          discovery: this.peerDiscovery,
          audit: this.jarvis.audit,
          readJsonBody: (request) => this.readJsonBody(request),
          authorize: (request, sessionId, path, body) => this.authorizeSignedRequest(request, sessionId, path, body),
          json: (response, status, data) => this.jsonResponse(response, status, data),
        });
      }

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
        // Two-tier memory and consent-based learning (US-057/058). Owner device only.
        const manager = this.jarvis.memoryManager;
        if (manager && req.method === 'GET' && url.pathname === '/api/memory/manager') {
          return this.jsonResponse(res, 200, { status: manager.status(), candidates: manager.listCandidates('pending') });
        }
        if (manager && req.method === 'GET' && url.pathname === '/api/memory/evaluation') {
          return this.jsonResponse(res, 200, { quality: manager.status().quality });
        }
        if (manager && req.method === 'POST' && url.pathname === '/api/memory/evaluation') {
          const { query, relevantIds, rating } = body as {
            query?: unknown; relevantIds?: unknown; rating?: unknown;
          };
          if (typeof query !== 'string' || !Array.isArray(relevantIds) ||
              !relevantIds.every((id) => typeof id === 'string') ||
              !['helpful', 'not_helpful'].includes(String(rating))) {
            return this.jsonResponse(res, 400, { error: 'query, relevantIds and rating (helpful|not_helpful) are required' });
          }
          try {
            const evaluation = await manager.evaluateRetrieval({
              query,
              relevantIds: relevantIds as string[],
              rating: rating as 'helpful' | 'not_helpful',
            });
            const quality = evaluation.quality;
            this.jarvis.audit.record('MEMORY_RETRIEVAL_EVALUATED', {
              sampleCount: quality.sampleCount,
              retrievedCount: evaluation.retrievedCount,
              precisionAtK: quality.precisionAtK,
              recallAtK: quality.recallAtK,
              helpfulRate: quality.helpfulRate,
              trend: quality.trend,
            }, auth.device.id);
            return this.jsonResponse(res, 200, { quality, retrievedCount: evaluation.retrievedCount });
          } catch (error) {
            return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Evaluation could not be recorded' });
          }
        }
        if (manager && req.method === 'POST' && url.pathname === '/api/memory/learning') {
          const enabled = (body as { enabled?: unknown }).enabled;
          if (typeof enabled !== 'boolean') return this.jsonResponse(res, 400, { error: 'enabled must be a boolean' });
          manager.setLearningEnabled(enabled);
          this.jarvis.audit.record('MEMORY_LEARNING_TOGGLED', { enabled }, auth.device.id);
          return this.jsonResponse(res, 200, { learningEnabled: manager.isLearningEnabled() });
        }
        if (manager && req.method === 'POST' && url.pathname === '/api/memory/feedback') {
          const { category, content, ref } = body as { category?: unknown; content?: unknown; ref?: unknown };
          if (!['preference', 'project', 'routine', 'general'].includes(String(category)) || typeof content !== 'string') {
            return this.jsonResponse(res, 400, { error: 'category and content are required' });
          }
          try {
            // Exact and local-semantic duplicate detection against long-term memory.
            const candidate = await manager.proposeChecked(auth.device.id, category as MemoryCategory, content, {
              kind: 'feedback',
              ...(typeof ref === 'string' && ref ? { ref } : {}),
            });
            this.jarvis.audit.record('MEMORY_CANDIDATE_PROPOSED', { candidateId: candidate.id, category: candidate.category, source: 'feedback' }, auth.device.id);
            return this.jsonResponse(res, 201, { candidate });
          } catch (error) {
            if (error instanceof DuplicateMemoryError) {
              return this.jsonResponse(res, 409, { error: error.message, duplicateOf: error.existingId, match: error.match, ...(error.similarity !== undefined ? { similarity: error.similarity } : {}) });
            }
            return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Feedback could not be recorded' });
          }
        }
        // Read-only correction history for one memory (J-E06). Corrections themselves go
        // through the planner and approval path ("update memory <id> to ...").
        if (manager && req.method === 'GET' && url.pathname === '/api/memory/versions') {
          const id = url.searchParams.get('id');
          if (!id || !/^[a-f0-9]{32}$/.test(id)) return this.jsonResponse(res, 400, { error: 'id query parameter is required' });
          const current = manager.longTerm.get(id);
          if (!current) return this.jsonResponse(res, 404, { error: 'Memory not found' });
          return this.jsonResponse(res, 200, { current, versions: manager.versionsOf(id) });
        }
        if (manager && req.method === 'POST' && url.pathname === '/api/memory/candidates/decide') {
          const { id, decision, ttlDays } = body as { id?: unknown; decision?: unknown; ttlDays?: unknown };
          if (typeof id !== 'string' || !['approve', 'reject'].includes(String(decision))) {
            return this.jsonResponse(res, 400, { error: 'id and decision (approve|reject) are required' });
          }
          try {
            if (decision === 'approve') {
              const { candidate, memory } = manager.approve(id, typeof ttlDays === 'number' ? ttlDays : undefined);
              this.jarvis.audit.record('MEMORY_CANDIDATE_APPROVED', { candidateId: id, memoryId: memory.id, category: memory.category }, auth.device.id);
              return this.jsonResponse(res, 200, { candidate, memoryId: memory.id });
            }
            const candidate = manager.reject(id);
            this.jarvis.audit.record('MEMORY_CANDIDATE_REJECTED', { candidateId: id }, auth.device.id);
            return this.jsonResponse(res, 200, { candidate });
          } catch (error) {
            return this.jsonResponse(res, 409, { error: error instanceof Error ? error.message : 'Candidate could not be decided' });
          }
        }
        // Owner data portability: a plaintext JSON copy for the authenticated owner device.
        // The audit records only that an export happened and how many records it held.
        if (req.method === 'GET' && url.pathname === '/api/memory/export') {
          const records = this.personalMemory.list();
          this.jarvis.audit.record('PERSONAL_MEMORY_EXPORTED', { recordCount: records.length }, auth.device.id);
          const exportedAt = new Date().toISOString();
          res.setHeader('Content-Disposition', `attachment; filename="jarvis-memory-${exportedAt.slice(0, 10)}.json"`);
          return this.jsonResponse(res, 200, {
            format: 'jarvis-personal-memory-export',
            version: 1,
            exportedAt,
            notice: 'Plaintext copy of your JARVIS memories. Deleting a memory in JARVIS does not affect this file.',
            records: records.map(({ id, category, content, createdAt, updatedAt, expiresAt }) => ({
              id, category, content,
              createdAt: new Date(createdAt).toISOString(),
              updatedAt: new Date(updatedAt).toISOString(),
              ...(expiresAt !== undefined ? { expiresAt: new Date(expiresAt).toISOString() } : {}),
            })),
          });
        }
        return this.jsonResponse(res, 405, { error: 'Unsupported memory method or route' });
      }

      // Local TTS is an authenticated, bounded operation; it has no execution authority.
      // Lets the HUD skip local TTS when Piper is not configured (no 503s in the console).
      // Reports a boolean only — never executable or model paths.
      if (req.method === 'GET' && url.pathname === '/api/voice/status') {
        let localTts = false;
        try { localTts = Boolean(createConfiguredPiperProvider()); } catch { localTts = false; }
        // Local speech-to-text (whisper.cpp) availability: boolean only, never paths.
        let localStt = false;
        try { localStt = Boolean(await this.voiceProviders.pickLocalStt()); } catch { localStt = false; }
        // Browser speech recognition may stream audio to a vendor cloud: it is only offered when the routing mode permits cloud (local-first).
        return this.jsonResponse(res, 200, { localTts, localStt, browserSpeechAllowed: cloudRoutingAllowed() });
      }
      // Wake metrics: privacy-preserving counters only (no audio, no transcript text).
      if (req.method === 'POST' && url.pathname === '/api/voice/wake-event') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || !WakeMetrics.isWakeEvent(body.event)) return this.jsonResponse(res, 400, { error: 'A valid wake event is required' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        this.wakeMetrics.record(body.event);
        return this.jsonResponse(res, 202, { recorded: true });
      }
      // Per-device wake/command state machine (D2.3). The wake never authorizes execution: a returned
      // command is still only text that must be submitted as a normal request through the planner and gateway.
      if (req.method === 'POST' && url.pathname === '/api/voice/wake-session') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        const actions = ['wake', 'transcript', 'complete', 'cancel', 'mute', 'unmute', 'state'];
        if (!this.isJsonObject(body) || typeof body.action !== 'string' || !actions.includes(body.action)) return this.jsonResponse(res, 400, { error: 'A valid wake-session action is required' });
        if (body.action === 'transcript' && (typeof body.text !== 'string' || body.text.length > 1200)) return this.jsonResponse(res, 400, { error: 'text must be a string up to 1200 characters' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const deviceId = auth.device.id;
        let result: Record<string, unknown>;
        switch (body.action) {
          case 'wake': result = { ...this.wakeSessions.wake(deviceId) }; break;
          case 'transcript': result = { ...this.wakeSessions.transcript(deviceId, body.text as string) }; break;
          case 'complete': result = { state: this.wakeSessions.complete(deviceId) }; break;
          case 'cancel': result = { state: this.wakeSessions.cancel(deviceId) }; break;
          case 'mute': result = { state: this.wakeSessions.setMuted(deviceId, true) }; break;
          case 'unmute': result = { state: this.wakeSessions.setMuted(deviceId, false) }; break;
          default: result = { state: this.wakeSessions.state(deviceId) };
        }
        this.jarvis.events.publish('voice.state', { state: String(result.state) }, deviceId);
        return this.jsonResponse(res, 200, result);
      }
      // Cross-module event stream (D2.20): incremental, device-isolated; owners (device-manage) see all devices.
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const since = Number(url.searchParams.get('since') ?? '0');
        const limit = Number(url.searchParams.get('limit') ?? '200');
        return this.jsonResponse(res, 200, this.jarvis.events.since(since, { deviceId: auth.device.id, owner: auth.device.permissions.includes(Permission.DEVICE_MANAGE) }, Number.isFinite(limit) ? limit : 200));
      }
      if (req.method === 'GET' && url.pathname === '/api/voice/metrics') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Insufficient permission to view voice metrics' });
        return this.jsonResponse(res, 200, this.wakeMetrics.snapshot());
      }
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
        // Audio privacy (D2.6): only bounded, explicit clips; never a continuous stream; never to a non-local provider unless allowed.
        if (!mayReceiveAudio(provider, { allowCloudSpeech: readVoicePrivacySettings().allowCloudSpeech, cloudRoutingAllowed: cloudRoutingAllowed() })) {
          return this.jsonResponse(res, 403, { error: 'Audio may not be sent to a non-local speech provider under the current privacy settings' });
        }
        const admission = this.audioIngress.admit(auth.device.id, Buffer.from(body.audioBase64, 'base64'));
        if (!admission.allowed) {
          this.jarvis.audit.record('VOICE_AUDIO_REFUSED', { reason: admission.reason }, auth.device.id);
          return this.jsonResponse(res, admission.reason === 'rate_limited' ? 429 : 400, { error: admission.reason === 'rate_limited' ? 'Audio capture budget exceeded; continuous audio upload is not allowed' : 'Audio must be a valid WAV clip within the clip length limit', code: admission.reason });
        }
        const transcriptionAbort = new AbortController();
        const abortTranscription = (): void => {
          if (!res.writableEnded && !transcriptionAbort.signal.aborted) transcriptionAbort.abort();
        };
        const onResponseClose = (): void => {
          if (!res.writableEnded) abortTranscription();
        };
        req.once('aborted', abortTranscription);
        res.once('close', onResponseClose);
        try {
          if (req.aborted || res.destroyed) abortTranscription();
          const result = await provider.transcribe(Buffer.from(body.audioBase64, 'base64'), transcriptionAbort.signal);
          if (transcriptionAbort.signal.aborted || res.destroyed || res.writableEnded) return;
          this.jarvis.audit.record('VOICE_TRANSCRIBED_LOCALLY', { provider: result.provider, textLength: result.text.length }, auth.device.id);
          return this.jsonResponse(res, 200, { text: result.text, provider: result.provider, local: result.local });
        } catch {
          // A disconnected client has no response channel; stop work without writing to it.
          if (transcriptionAbort.signal.aborted || res.destroyed || res.writableEnded) return;
          // Keep provider diagnostics (including temporary/model paths) out of API responses.
          return this.jsonResponse(res, 422, { error: 'Local speech recognition failed' });
        } finally {
          req.off('aborted', abortTranscription);
          res.off('close', onResponseClose);
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
        const clearConversationId: string = body.conversationId;
        // Serialize clearing with message handling to prevent an in-flight response
        // from persisting history after the clear operation completes.
        const cleared = await this.conversationSessions.runExclusive(
          clearConversationId,
          () => Promise.resolve(this.conversationSessions.clear(clearConversationId, deviceId)),
        );
        return this.jsonResponse(res, cleared ? 200 : 404, { success: cleared });
      }

      // Local document RAG: every operation is signed and scoped to the authenticated device.
      if (req.method === 'POST' && url.pathname === '/api/documents/ingest') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req, 2 * 1024 * 1024 + 64 * 1024);
        if (!this.isJsonObject(body) || typeof body.sourceName !== 'string' || typeof body.content !== 'string' ||
            (body.title !== undefined && typeof body.title !== 'string') ||
            (body.collection !== undefined && typeof body.collection !== 'string') ||
            (body.replace !== undefined && typeof body.replace !== 'boolean')) {
          return this.jsonResponse(res, 400, { error: 'sourceName and UTF-8 text content are required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.documentRag) return this.jsonResponse(res, 503, { error: 'Encrypted document storage is unavailable; configure owner control first' });
        try {
          const result = this.documentRag.ingest({
            ownerDeviceId: auth.device.id,
            sourceName: body.sourceName,
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            ...(typeof body.collection === 'string' ? { collection: body.collection } : {}),
            ...(body.replace === true ? { replace: true } : {}),
            content: body.content,
          });
          this.jarvis.audit.record('DOCUMENT_INGESTED', { documentId: result.documentId, chunkCount: result.chunkCount, duplicate: result.duplicate }, auth.device.id);
          return this.jsonResponse(res, result.duplicate ? 200 : 201, { state: 'STORED', ...result });
        } catch (error) {
          return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Document ingestion failed' });
        }
      }

      // Binary ingestion is local-only: PDF text extraction and optional scanned-page OCR never upload document bytes.
      if (req.method === 'POST' && url.pathname === '/api/documents/ingest-file') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req, 21 * 1024 * 1024);
        if (!this.isJsonObject(body) || typeof body.sourceName !== 'string' ||
            typeof body.documentBase64 !== 'string' ||
            (body.title !== undefined && typeof body.title !== 'string') ||
            (body.ocr !== undefined && typeof body.ocr !== 'boolean')) {
          return this.jsonResponse(res, 400, { error: 'sourceName, base64 document content and optional OCR flag are required' });
        }
        if (body.documentBase64.length > 20 * 1024 * 1024 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.documentBase64)) {
          return this.jsonResponse(res, 400, { error: 'Document encoding is invalid or exceeds the 15 MB file limit' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.documentRag) return this.jsonResponse(res, 503, { error: 'Encrypted document storage is unavailable; configure owner control first' });
        try {
          const bytes = Buffer.from(body.documentBase64, 'base64');
          if (bytes.toString('base64') !== body.documentBase64) return this.jsonResponse(res, 400, { error: 'Document encoding is not canonical base64' });
          const parsed = await this.documentParser.parse(body.sourceName, bytes, { ocr: body.ocr === true });
          const result = this.documentRag.ingest({
            ownerDeviceId: auth.device.id,
            sourceName: body.sourceName,
            ...(typeof body.title === 'string' ? { title: body.title } : {}),
            content: parsed.text,
          });
          this.jarvis.audit.record('DOCUMENT_INGESTED', {
            documentId: result.documentId, chunkCount: result.chunkCount, duplicate: result.duplicate,
            format: parsed.format, extraction: parsed.extraction, pages: parsed.pages,
          }, auth.device.id);
          return this.jsonResponse(res, result.duplicate ? 200 : 201, {
            state: 'STORED', ...result, format: parsed.format, extraction: parsed.extraction, pages: parsed.pages,
          });
        } catch (error) {
          return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Document parsing failed' });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/documents/search') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.query !== 'string' ||
            (body.limit !== undefined && (typeof body.limit !== 'number' || !Number.isInteger(body.limit))) ||
            (body.collection !== undefined && typeof body.collection !== 'string')) {
          return this.jsonResponse(res, 400, { error: 'A query and optional integer limit are required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.documentRag) return this.jsonResponse(res, 503, { error: 'Encrypted document storage is unavailable; configure owner control first' });
        try {
          const results = await this.documentRag.search(auth.device.id, body.query, body.limit ?? 5, undefined, typeof body.collection === 'string' ? body.collection : undefined);
          return this.jsonResponse(res, 200, {
            method: results[0]?.method ?? (resolveLocalEmbeddingEndpoint() ? 'semantic_or_lexical_fallback' : 'lexical'),
            results: results.map((item) => ({ content: item.content, score: item.score, source: item.source })),
          });
        } catch (error) {
          return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Document search failed' });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/documents/list') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON object body is required' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.documentRag) return this.jsonResponse(res, 503, { error: 'Encrypted document storage is unavailable; configure owner control first' });
        return this.jsonResponse(res, 200, { documents: this.documentRag.list(auth.device.id, typeof body.collection === 'string' ? body.collection : undefined) });
      }

      // Owner-managed registry of approved knowledge collections (E:D4.8).
      if (req.method === 'POST' && ['/api/knowledge/sources/list', '/api/knowledge/sources/approve', '/api/knowledge/sources/revoke'].includes(url.pathname)) {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON object body is required' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Knowledge sources require device-management permission' });
        if (!this.knowledgeSources) return this.jsonResponse(res, 503, { error: 'Knowledge source enforcement is not enabled' });
        if (url.pathname.endsWith('/list')) return this.jsonResponse(res, 200, { sources: this.knowledgeSources.list() });
        if (typeof body.collection !== 'string') return this.jsonResponse(res, 400, { error: 'collection is required' });
        try {
          if (url.pathname.endsWith('/approve')) {
            const source = this.knowledgeSources.approve(body.collection, auth.device.id);
            this.jarvis.audit.record('KNOWLEDGE_SOURCE_APPROVED', { collection: source.collection }, auth.device.id);
            return this.jsonResponse(res, 200, { source });
          }
          const revoked = this.knowledgeSources.revoke(body.collection);
          if (revoked) this.jarvis.audit.record('KNOWLEDGE_SOURCE_REVOKED', { collection: body.collection.slice(0, 40) }, auth.device.id);
          return this.jsonResponse(res, revoked ? 200 : 404, { success: revoked });
        } catch (error) {
          return this.jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Knowledge source update failed' });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/documents/delete') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.documentId !== 'string') return this.jsonResponse(res, 400, { error: 'documentId is required' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.documentRag) return this.jsonResponse(res, 503, { error: 'Encrypted document storage is unavailable; configure owner control first' });
        const deleted = this.documentRag.delete(auth.device.id, body.documentId);
        if (deleted) this.jarvis.audit.record('DOCUMENT_DELETED', { documentId: body.documentId }, auth.device.id);
        return this.jsonResponse(res, deleted ? 200 : 404, { success: deleted });
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
        // One spoken utterance may create at most one task: browser recognizers can re-emit the
        // same final transcript, so voice-origin requests carry an utterance id (GAP-006).
        const voiceMeta = (body as { voice?: unknown }).voice;
        let utteranceId: string | undefined;
        if (voiceMeta !== undefined) {
          const candidate = this.isJsonObject(voiceMeta) ? voiceMeta.utteranceId : undefined;
          if (!isValidUtteranceId(candidate)) return this.jsonResponse(res, 400, { error: 'voice.utteranceId must be 8-64 URL-safe characters' });
          utteranceId = candidate;
          const claim = this.utteranceGuard.claim(auth.device.id, utteranceId, text);
          if (!claim.accepted) {
            this.wakeMetrics.record('duplicate_suppressed');
            this.jarvis.audit.record('VOICE_DUPLICATE_SUPPRESSED', { reason: claim.reason }, auth.device.id);
            return this.jsonResponse(res, 409, { duplicate: true, reason: claim.reason, ...(claim.taskId ? { taskId: claim.taskId } : {}), error: 'This utterance was already submitted; no new task was created.' });
          }
          this.wakeMetrics.record('command_dispatched');
        }
        // Conversation requests are handled only after signed-session authentication.
        // Action-like directives continue through the existing planner and PolicyGateway.
        // Supply only request-relevant memories to the conversational prompt.
        // The memory store is encrypted and the model treats these records as untrusted data.
        // Two-tier retrieval: this conversation's working memory plus relevant long-term
        // memory (long-term only for device-management devices), bounded in size.
        const canReadLongTerm = auth.device.permissions.includes(Permission.DEVICE_MANAGE);
        // Ranked (local semantic + lexical + recency) retrieval is skipped for action
        // requests, which go to the planner and never use conversational memory context.
        const conversationMemory = isActionRequest(text.trim())
          ? []
          : this.jarvis.memoryManager
          ? (await this.jarvis.memoryManager.retrieveContextRanked({
            deviceId: auth.device.id,
            query: text.trim(),
            ...(conversationId ? { scope: { kind: 'conversation' as const, id: conversationId } } : {}),
            includeLongTerm: canReadLongTerm,
            maxItems: 6,
            maxChars: 3000,
          })).map((item) => ({ content: item.content, category: item.tier === 'working' ? 'working_' + item.label : item.label }))
          : canReadLongTerm && this.personalMemory
            ? this.personalMemory.relevant(text.trim(), 5).map((record) => ({ content: record.content, category: record.category }))
            : [];
        const documentMatches = !isActionRequest(text.trim()) && this.documentRag
          ? await this.documentRag.search(auth.device.id, text.trim(), 4).catch(() => [])
          : [];
        // The prompt contract accepts at most five context records. Reserve up to
        // three slots for document evidence so it is not silently truncated behind memory.
        const authorizedConversationMemory = [
          ...documentMatches.slice(0, 3).map((item) => ({
            content: item.content,
            category: 'document:' + item.source.sourceName + '#chunk-' + item.source.chunk,
          })),
          ...conversationMemory.slice(0, 2),
        ];

        // Do not allocate conversation state for commands routed to the execution planner.
        if (isActionRequest(text.trim())) {
          const result = await this.jarvis.submitRequest(sessionId, text.trim());
          if (utteranceId && result?.taskId) this.utteranceGuard.bindTask(auth.device.id, utteranceId, result.taskId);
          return this.jsonResponse(res, 200, result);
        }
        const authDevice = auth.device;
        const lockId = conversationId || 'unthreaded:' + authDevice.id + ':' + text.trim();
        return await this.conversationSessions.runExclusive(lockId, async () => {
          const conversation = this.conversationSessions.getOrCreate(authDevice.id, conversationId);
          if (!conversation) return this.jsonResponse(res, 403, { error: 'Conversation does not belong to this authenticated device' });
          // Working memory: short-lived, RAM-only context for this conversation.
          this.jarvis.memoryManager?.working.put(authDevice.id, 'conversation', conversation.id, 'user_turn', text.trim());

          // Advisory agents share the same device-bound conversation thread and lock.
          // Only a small recent slice is supplied as untrusted context; it never grants tool authority.
          const agentRoute = routeAgentRequest(text.trim());
          if (agentRoute.destination === 'agent' && agentRoute.profile !== 'developer_assistant') {
            const adapter = createConfiguredAgentModelAdapter();
            if (adapter) {
              const limit = this.agentRequestLimiter.consume(authDevice.id);
              if (!limit.allowed) {
                this.jarvis.audit.record('ADVISORY_AGENT_RATE_LIMITED', {
                  profile: agentRoute.profile,
                  retryAfterSeconds: limit.retryAfterSeconds,
                }, authDevice.id);
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
                this.conversationSessions.appendTurn(conversation.id, authDevice.id, text.trim(), message);
                this.jarvis.audit.record('ADVISORY_AGENT_COMPLETED', { profile: agentResult.profile, requestLength: text.trim().length }, authDevice.id);
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
              }, authDevice.id);
            }
          }

          const conversationalResult = await answerConversationalMessageResult(text.trim(), authorizedConversationMemory, conversation.history);
          if (conversationalResult) {
            if (conversationalResult.persistInHistory) {
              this.conversationSessions.appendTurn(conversation.id, authDevice.id, text.trim(), conversationalResult.answer);
            }
            this.jarvis.audit.record('CONVERSATIONAL_ANSWER', {
              requestLength: text.trim().length,
              responseLength: conversationalResult.answer.length,
              persisted: conversationalResult.persistInHistory,
            }, authDevice.id);
            return this.jsonResponse(res, 200, {
              state: 'ANSWERED',
              message: conversationalResult.answer,
              data: { kind: 'conversation', conversationId: conversation.id, ...(documentMatches.length ? { sources: documentMatches.map((item) => item.source) } : {}) },
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
        // An expired approval is a conflict, not a successful approval. The full
        // task result (state EXPIRED) is included so clients can retire the card.
        if (result.state === TaskState.EXPIRED) {
          return this.jsonResponse(res, 409, { ...result, error: result.message });
        }
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
        const result = await this.jarvis.rejectTask(approvalId, sessionId);
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
        // Revalidate queued work at claim time: a phone reconnecting later never
        // receives commands whose requester was revoked or lost permission.
        const command = this.androidCommands.claimNext(auth.device.id, (queued) => this.isAndroidCommandStillAuthorized(queued));
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
        const outcome = this.androidCommands.completeDetailed(
          auth.device.id, body.commandId, body.apps as Array<{label:string; packageName:string}>,
          (queued) => this.isAndroidCommandStillAuthorized(queued),
        );
        // A retried upload of an already-accepted result is acknowledged without
        // overwriting it, so network retries are idempotent.
        if (outcome === 'duplicate') return this.jsonResponse(res, 200, { success: true, duplicate: true });
        if (outcome !== 'completed') {
          this.jarvis.audit.record('ANDROID_COMMAND_RESULT_REJECTED', { commandId: body.commandId, outcome }, auth.device.id);
          return this.jsonResponse(res, 409, { error: 'Command result was not accepted', outcome });
        }
        this.jarvis.audit.record('ANDROID_COMMAND_COMPLETED', { commandId: body.commandId, appCount: body.apps.length }, auth.device.id);
        return this.jsonResponse(res, 200, { success: true });
      }

      // Requester cancellation of queued phone work; repeating a cancel is a no-op success.
      if (req.method === 'POST' && url.pathname === '/api/android/commands/cancel') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.commandId !== 'string') return this.jsonResponse(res, 400, { error: 'commandId is required' });
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Device-management permission is required' });
        const outcome = this.androidCommands.cancel(auth.device.id, body.commandId);
        if (outcome === 'not_found') return this.jsonResponse(res, 404, { error: 'Command not found' });
        if (outcome === 'not_cancellable') return this.jsonResponse(res, 409, { error: 'Command already finished', outcome });
        if (outcome === 'cancelled') {
          this.jarvis.audit.record('ANDROID_COMMAND_CANCELLED', { commandId: body.commandId }, auth.device.id);
        }
        return this.jsonResponse(res, 200, { success: true, outcome });
      }

      if (req.method === 'GET' && url.pathname === '/api/android/commands/results') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Device-management permission is required' });
        return this.jsonResponse(res, 200, { results: this.androidCommands.resultsForRequester(auth.device.id) });
      }

      // Owner-only emergency revoke-all (US-003). Revokes every active device and all live sessions;
      // the caller survives only when keepCurrentSession is explicitly true.
      if (req.method === 'POST' && url.pathname === '/api/device/revoke-all') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body)) return this.jsonResponse(res, 400, { error: 'JSON body must be an object' });
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (body.confirm !== 'REVOKE_ALL_DEVICES') return this.jsonResponse(res, 400, { error: 'confirm must equal REVOKE_ALL_DEVICES' });
        const decision = this.jarvis.policy.evaluate({ operation: 'device:revoke', parameters: {} }, auth.device, `security-${CryptoUtil.randomToken(8)}`);
        if (!decision.allowed) return this.jsonResponse(res, 403, { error: 'Device is not authorized to revoke devices' });
        if (this.jarvis.deviceSecurity?.getTotpStatus() === 'ENABLED' && (typeof body.totpCode !== 'string' || !this.jarvis.deviceSecurity.verifyStepUp(auth.device, body.totpCode))) return this.jsonResponse(res, 401, { error: 'Fresh authenticator verification required' });
        const result = this.jarvis.identity.revokeAllDevices(auth.device.id, {
          ...(body.keepCurrentSession === true ? { keepSessionId: sessionId } : {}),
          ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        });
        if (!result.success) return this.jsonResponse(res, result.revokedDeviceIds.length ? 409 : 403, { success: false, error: result.error ?? 'Revoke-all failed' });
        for (const deviceId of result.revokedDeviceIds) {
          this.jarvis.onDeviceRevoked(deviceId, 'revoke-all');
          this.androidCommands.cancelForDevice(deviceId);
        }
        // Pending enrollment (QR transactions); raw challenges were already invalidated by revokeAllDevices.
        this.jarvis.deviceSecurity?.cancelAllPending('revoke-all');
        return this.jsonResponse(res, 200, { success: true, revokedCount: result.revokedDeviceIds.length, sessionsInvalidated: result.sessionsInvalidated, callerKept: body.keepCurrentSession === true });
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
        this.jarvis.onDeviceRevoked(deviceId, 'device-request');
        const cancelledAndroidCommands = this.androidCommands.cancelForDevice(deviceId);
        if (cancelledAndroidCommands > 0) {
          this.jarvis.audit.record('ANDROID_COMMANDS_CANCELLED_DEVICE_REVOKED', {
            revokedDeviceId: deviceId,
            cancelledCount: cancelledAndroidCommands,
          }, auth.device.id);
        }
        return this.jsonResponse(res, 200, { success: true });
      }

      // Session recovery: end all live sessions of one device without revoking its pairing.
      if (req.method === 'POST' && url.pathname === '/api/device/sessions/end') {
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.deviceId !== 'string' || !body.deviceId) return this.jsonResponse(res, 400, { error: 'deviceId is required' });
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const targetId: string = body.deviceId;
        const owner = auth.device.permissions.includes(Permission.DEVICE_MANAGE);
        if (targetId !== auth.device.id && !owner) return this.jsonResponse(res, 403, { error: 'Only an owner device can end the sessions of another device' });
        if (owner && this.jarvis.deviceSecurity?.getTotpStatus() === 'ENABLED' && (typeof body.totpCode !== 'string' || !this.jarvis.deviceSecurity.verifyStepUp(auth.device, body.totpCode))) return this.jsonResponse(res, 401, { error: 'Fresh authenticator verification required' });
        const result = this.jarvis.identity.endDeviceSessions(targetId);
        if (!result.success) return this.jsonResponse(res, 409, { success: false, error: result.error });
        this.jarvis.policy.invalidateApprovals({ deviceId: targetId }, 'SESSIONS_ENDED');
        this.wakeSessions.forget(targetId);
        this.audioIngress.forget(targetId);
        this.jarvis.events.publish('session.ended', { ended: result.ended }, targetId);
        return this.jsonResponse(res, 200, { success: true, ended: result.ended });
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

      // Owner metrics (US-025): measured aggregates plus a provisional budget evaluation. Aggregates
      // only; no task ids, prompts, paths or device identifiers. Local JSON; nothing is exported.
      if (req.method === 'GET' && url.pathname === '/api/metrics') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, undefined);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Insufficient permission to view metrics' });
        const snapshot = this.jarvis.getHealthSnapshot();
        return this.jsonResponse(res, 200, {
          generatedAt: snapshot.generatedAt,
          measurements: summarizeMeasurements(snapshot),
          budgets: evaluateRuntimeBudgets(snapshot),
          note: 'owner-approved baseline 2026-11-18; revisit after field data',
        });
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
            lifecycle: this.jarvis.lifecycleOf(task),
            needsOwnerReview: needsOwnerReview(task.state),
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

      // Explicit owner-reconciled DAG resume. Only named uncertain branches are re-attempted, as
      // fresh child tasks that pass through policy/approval again; nothing is replayed automatically.
      if (req.method === 'POST' && url.pathname === '/api/workflow/resume') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || typeof body.taskId !== 'string' || !body.taskId || typeof body.note !== 'string' ||
            !Array.isArray(body.reconciledNoEffectSteps) || body.reconciledNoEffectSteps.some((id) => typeof id !== 'string')) {
          return this.jsonResponse(res, 400, { error: 'taskId, reconciledNoEffectSteps and a recovery note are required' });
        }
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        if (!this.jarvis.hasDurableTaskJournal()) return this.jsonResponse(res, 503, { error: 'Durable task recovery is not configured', code: 'TASK_JOURNAL_NOT_CONFIGURED' });
        try {
          const result = await this.jarvis.resumeWorkflowRun(body.taskId, sessionId, body.reconciledNoEffectSteps as string[], body.note);
          return this.jsonResponse(res, result.success ? 200 : 409, result);
        } catch (error) {
          return this.jsonResponse(res, 409, { error: error instanceof Error ? error.message : 'Workflow cannot be resumed' });
        }
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

      // Reliable stop: cancels pending and interrupts running work for this device (or all devices for an owner).
      if (req.method === 'POST' && url.pathname === '/api/stop') {
        const sessionId = req.headers['x-session-id'];
        if (typeof sessionId !== 'string') return this.jsonResponse(res, 401, { error: 'Missing authenticated device session' });
        const body = await this.readJsonBody(req);
        if (!this.isJsonObject(body) || (body.scope !== undefined && body.scope !== 'device' && body.scope !== 'all')) return this.jsonResponse(res, 400, { error: 'scope must be device or all' });
        const auth = this.authorizeSignedRequest(req, sessionId, url.pathname, body);
        if (!auth.valid || !auth.device) return this.jsonResponse(res, 401, { error: auth.error || 'Signed request authentication failed' });
        const scope = body.scope === 'all' ? 'all' : 'device';
        if (scope === 'all' && !auth.device.permissions.includes(Permission.DEVICE_MANAGE)) return this.jsonResponse(res, 403, { error: 'Only an owner device can stop all devices' });
        this.wakeSessions.cancel(auth.device.id);
        const stopped = this.jarvis.stopAll(sessionId, scope);
        // Queued and in-flight phone commands are in-flight commands too: stop moves them to cancelled.
        const androidCancelled = this.androidCommands.cancelForStop(scope === 'all' ? undefined : auth.device.id);
        return this.jsonResponse(res, 200, { ...stopped, androidCancelled });
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
      console.error(`[JARVIS] Request failed requestId=${requestId} ${req.method ?? ''} ${url.pathname}`);
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

  /** Both ends of a queued phone command must still be active and permitted. */
  private isAndroidCommandStillAuthorized(command: Readonly<{ requesterDeviceId: string; targetDeviceId: string }>): boolean {
    const requester = this.jarvis.identity.getDevice(command.requesterDeviceId);
    const target = this.jarvis.identity.getDevice(command.targetDeviceId);
    return Boolean(
      requester && requester.status === 'ACTIVE' && requester.permissions.includes(Permission.DEVICE_MANAGE) &&
      target && target.status === 'ACTIVE' && target.platform === 'Android' && target.permissions.includes(Permission.SYSTEM_INFO_READ),
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
