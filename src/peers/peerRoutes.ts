/**
 * HTTP routes for LAN peers (J-E11). Signed device sessions, same scheme as /api/request.
 *
 *   GET  /api/peers                         DEVICE_MANAGE: discovery state, hub key, peers, pending pairing
 *                                           other devices: their own peer status + hub public key
 *   POST /api/peers/pair/start   { deviceId }   DEVICE_MANAGE (owner) - returns a 2-minute 6-digit code
 *   POST /api/peers/pair/confirm { code }       the device being paired, with its own signed session
 *   POST /api/peers/revoke       { deviceId }   DEVICE_MANAGE
 *
 * Audited without codes or keys.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Permission, type DeviceRecord } from '../core/types.js';
import type { AuditLogger } from '../audit/audit.js';
import { PeerError, type PeerRegistry } from './peerRegistry.js';
import type { PeerDiscoveryService } from './peerDiscovery.js';

export interface PeerRouteContext {
  registry: PeerRegistry | undefined;
  discovery: PeerDiscoveryService | undefined;
  audit: AuditLogger;
  readJsonBody(req: IncomingMessage): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
}

export async function handlePeerRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: PeerRouteContext): Promise<void> {
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') return ctx.json(res, 401, { error: 'Missing authenticated device session' });
  if (!ctx.registry || !ctx.discovery) {
    return ctx.json(res, 503, { error: 'LAN peers are unavailable: JARVIS needs a configured owner control token.', state: 'unavailable' });
  }
  const body = req.method === 'GET' ? undefined : await ctx.readJsonBody(req);
  if (req.method !== 'GET' && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    return ctx.json(res, 400, { error: 'JSON body must be an object' });
  }
  const auth = ctx.authorize(req, sessionId, url.pathname, body);
  if (!auth.valid || !auth.device) return ctx.json(res, 401, { error: auth.error || 'Signed request authentication failed' });
  const device = auth.device;
  const isOwner = device.permissions.includes(Permission.DEVICE_MANAGE);
  const payload = (body ?? {}) as Record<string, unknown>;
  const registry = ctx.registry;
  const discovery = ctx.discovery;

  try {
    if (req.method === 'GET' && url.pathname === '/api/peers') {
      const discoveryStatus = discovery.status();
      if (!isOwner) {
        return ctx.json(res, 200, {
          discovery: { state: discoveryStatus.state },
          hubPublicKey: registry.hubPublicKey,
          paired: registry.isPeer(device.id),
        });
      }
      const peers = registry.list().map((entry) => {
        const presence = discovery.presenceOf(entry.deviceId);
        return {
          deviceId: entry.deviceId,
          name: entry.name,
          pairedAt: entry.pairedAt,
          online: presence?.online ?? false,
          lastSeenAt: presence?.lastSeenAt ?? null,
          pendingSyncNotices: presence?.pendingSyncNotices ?? 0,
          // Explicit state instead of a silent blank when discovery is off.
          state: discoveryStatus.state !== 'running' ? 'discovery_' + discoveryStatus.state : presence?.online ? 'online' : 'offline',
        };
      });
      return ctx.json(res, 200, { discovery: discoveryStatus, hubPublicKey: registry.hubPublicKey, peers, pendingPairing: registry.pendingPairing() });
    }
    if (req.method === 'POST' && url.pathname === '/api/peers/pair/start') {
      if (!isOwner) return ctx.json(res, 403, { error: 'Starting pairing requires device-management permission' });
      const target = payload['deviceId'];
      if (typeof target !== 'string' || !target) return ctx.json(res, 400, { error: 'deviceId is required' });
      const pairing = registry.startPairing(target, device.id);
      ctx.audit.record('LAN_PEER_PAIRING_STARTED', { targetDeviceId: target, expiresAt: pairing.expiresAt }, device.id);
      return ctx.json(res, 200, pairing);
    }
    if (req.method === 'POST' && url.pathname === '/api/peers/pair/confirm') {
      try {
        const entry = registry.confirmPairing(device, payload['code']);
        ctx.audit.record('LAN_PEER_PAIRED', { peerDeviceId: entry.deviceId, pairedBy: entry.pairedBy }, device.id);
        return ctx.json(res, 200, { paired: true, deviceId: entry.deviceId, hubPublicKey: registry.hubPublicKey });
      } catch (error) {
        ctx.audit.record('LAN_PEER_PAIRING_FAILED', { reason: error instanceof PeerError ? error.status : 500 }, device.id);
        throw error;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/peers/revoke') {
      if (!isOwner) return ctx.json(res, 403, { error: 'Revoking a peer requires device-management permission' });
      const target = payload['deviceId'];
      if (typeof target !== 'string' || !target) return ctx.json(res, 400, { error: 'deviceId is required' });
      const removed = registry.revoke(target);
      discovery.forget(target);
      ctx.audit.record('LAN_PEER_REVOKED', { peerDeviceId: target, removed }, device.id);
      return ctx.json(res, removed ? 200 : 404, { revoked: removed });
    }
    return ctx.json(res, 404, { error: 'Unknown peer route' });
  } catch (error) {
    if (error instanceof PeerError) return ctx.json(res, error.status, { error: error.message });
    return ctx.json(res, 500, { error: 'Peer request failed' });
  }
}
