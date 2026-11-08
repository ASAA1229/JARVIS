/**
 * HTTP routes for device sync. Mounted by the server for /api/sync/*.
 * Every route requires the device's signed session (same scheme as /api/request).
 *
 *   POST /api/sync/capabilities   { capabilities: [...] }          any active device
 *   POST /api/sync/push           { changes: [...] }               any active device
 *   GET  /api/sync/pull?since=ms                                    any active device
 *   GET  /api/sync/peers                                            devices that negotiated p2p-envelope
 *   GET  /api/sync/overview                                         DEVICE_MANAGE (HUD)
 *   POST /api/sync/conflicts/resolve { id, resolution, mergedContent? }   DEVICE_MANAGE
 *   POST /api/sync/commands/decide   { id, decision: run|discard }        DEVICE_MANAGE
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DeviceStatus, Permission, type DeviceRecord } from '../core/types.js';
import { SyncError, type SyncService } from './syncService.js';
import type { SyncStateStore } from './syncStateStore.js';

export interface SyncRouteContext {
  sync: SyncService | undefined;
  store: SyncStateStore | undefined;
  listDevices(): DeviceRecord[];
  readJsonBody(req: IncomingMessage): Promise<unknown>;
  authorize(req: IncomingMessage, sessionId: string, path: string, body: unknown): { valid: boolean; device?: DeviceRecord; error?: string };
  json(res: ServerResponse, status: number, data: unknown): void;
}

export async function handleSyncRoute(req: IncomingMessage, res: ServerResponse, url: URL, ctx: SyncRouteContext): Promise<void> {
  const sessionId = req.headers['x-session-id'];
  if (typeof sessionId !== 'string') return ctx.json(res, 401, { error: 'Missing authenticated device session' });
  if (!ctx.sync || !ctx.store) return ctx.json(res, 503, { error: 'Device sync requires a configured owner control token' });
  const body = req.method === 'GET' ? undefined : await ctx.readJsonBody(req);
  if (req.method !== 'GET' && (body === null || typeof body !== 'object' || Array.isArray(body))) {
    return ctx.json(res, 400, { error: 'JSON body must be an object' });
  }
  const auth = ctx.authorize(req, sessionId, url.pathname, body);
  if (!auth.valid || !auth.device) return ctx.json(res, 401, { error: auth.error || 'Signed request authentication failed' });
  const device = auth.device;
  const payload = (body ?? {}) as Record<string, unknown>;

  try {
    if (req.method === 'POST' && url.pathname === '/api/sync/capabilities') {
      return ctx.json(res, 200, ctx.sync.negotiate(device, payload['capabilities']));
    }
    if (req.method === 'POST' && url.pathname === '/api/sync/push') {
      return ctx.json(res, 200, await ctx.sync.push(device, sessionId, payload));
    }
    if (req.method === 'GET' && url.pathname === '/api/sync/pull') {
      return ctx.json(res, 200, ctx.sync.pull(device, url.searchParams.get('since')));
    }
    if (req.method === 'GET' && url.pathname === '/api/sync/peers') {
      const overview = ctx.sync.overview();
      const p2p = new Set(overview.devices.filter((item) => item.capabilities.includes('p2p-envelope')).map((item) => item.deviceId));
      if (!p2p.has(device.id)) return ctx.json(res, 403, { error: 'Negotiate the p2p-envelope capability first' });
      // Public keys only; revoked devices are never listed, so their envelopes fail verification.
      const peers = ctx.listDevices()
        .filter((item) => item.status !== DeviceStatus.REVOKED && p2p.has(item.id))
        .map((item) => ({ deviceId: item.id, name: item.name, publicKey: item.publicKey, p2p: true }));
      return ctx.json(res, 200, { peers });
    }
    if (req.method === 'GET' && url.pathname === '/api/sync/overview') {
      if (!device.permissions.includes(Permission.DEVICE_MANAGE)) return ctx.json(res, 403, { error: 'Sync overview requires device-management permission' });
      return ctx.json(res, 200, ctx.sync.overview());
    }
    if (req.method === 'POST' && url.pathname === '/api/sync/conflicts/resolve') {
      return ctx.json(res, 200, await ctx.sync.resolveConflict(device, sessionId, payload['id'], payload['resolution'], payload['mergedContent']));
    }
    if (req.method === 'POST' && url.pathname === '/api/sync/commands/decide') {
      return ctx.json(res, 200, await ctx.sync.decideCommand(device, sessionId, payload['id'], payload['decision']));
    }
    return ctx.json(res, 404, { error: 'Unknown sync route' });
  } catch (error) {
    if (error instanceof SyncError) return ctx.json(res, error.status, { error: error.message });
    // Keep internal details server-side.
    return ctx.json(res, 500, { error: error instanceof Error && /sync state could not be decrypted/i.test(error.message) ? error.message : 'Sync request failed' });
  }
}
