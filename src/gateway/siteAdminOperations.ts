/**
 * Owner management of personal-AI-gateway site clients (J-E09 / J-E10 HUD panel).
 *
 * These operations run through the normal task pipeline, so the PolicyGateway and
 * approvals apply. A newly created site key is never put in a task result (task
 * results are journaled): the approved execution parks it in a short-lived,
 * in-memory, show-once store and the owner HUD fetches it exactly once.
 */
import { randomBytes } from 'node:crypto';
import type { ExecutionResult } from '../core/types.js';
import { VerificationOutcome } from '../core/types.js';
import { SiteClientStore, type SiteClientLimits } from './siteClientStore.js';

export const GATEWAY_SITE_OPERATIONS = [
  'gateway:site_list', 'gateway:site_create', 'gateway:site_update', 'gateway:site_revoke',
] as const;

export type GatewaySiteOperation = (typeof GATEWAY_SITE_OPERATIONS)[number];

export function isGatewaySiteOperation(operation: string): operation is GatewaySiteOperation {
  return (GATEWAY_SITE_OPERATIONS as readonly string[]).includes(operation);
}

const REVEAL_TTL_MS = 10 * 60 * 1000;

interface PendingReveal { apiKey: string; deviceId: string; clientId: string; expiresAt: number }

/** One-time key reveal: in memory only, bound to the creating device, expires in 10 minutes. */
export class KeyRevealStore {
  private readonly pending = new Map<string, PendingReveal>();

  park(deviceId: string, clientId: string, apiKey: string): string {
    this.prune();
    const token = randomBytes(18).toString('base64url');
    this.pending.set(token, { apiKey, deviceId, clientId, expiresAt: Date.now() + REVEAL_TTL_MS });
    return token;
  }

  /** Returns the key once; a second call, another device or an expired token gets nothing. */
  take(token: string, deviceId: string): { apiKey: string; clientId: string } | null {
    this.prune();
    const entry = this.pending.get(token);
    if (!entry || entry.deviceId !== deviceId) return null;
    this.pending.delete(token);
    return { apiKey: entry.apiKey, clientId: entry.clientId };
  }

  private prune(): void {
    const now = Date.now();
    for (const [token, entry] of this.pending) if (entry.expiresAt <= now) this.pending.delete(token);
  }
}

function ok(data: unknown): ExecutionResult {
  return { success: true, outcome: VerificationOutcome.VERIFIED_SUCCESS, data, evidence: { readBack: true } };
}

function fail(error: string): ExecutionResult {
  return { success: false, outcome: VerificationOutcome.VERIFIED_FAILURE, error, evidence: { gatewaySiteOperation: true } };
}

function limitsFrom(value: unknown): Partial<SiteClientLimits> {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const limits: Partial<SiteClientLimits> = {};
  if (input['requestsPerMinute'] !== undefined) limits.requestsPerMinute = Number(input['requestsPerMinute']);
  if (input['maxOutputTokens'] !== undefined) limits.maxOutputTokens = Number(input['maxOutputTokens']);
  return limits;
}

function profilesFrom(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error('allowedProfiles must be an array of profile ids.');
  return value.map((item) => String(item));
}

export class GatewaySiteAdmin {
  readonly reveals = new KeyRevealStore();

  constructor(private readonly storePath: string) {}

  /** A fresh store per call: the JSON file is the source of truth shared with the gateway and CLI. */
  store(): SiteClientStore {
    return new SiteClientStore(this.storePath);
  }

  execute(operation: GatewaySiteOperation, parameters: Record<string, unknown>, deviceId: string): ExecutionResult {
    try {
      const store = this.store();
      switch (operation) {
        case 'gateway:site_list':
          return ok(store.list());
        case 'gateway:site_create': {
          const { client, apiKey } = store.create(String(parameters['name'] ?? ''), limitsFrom(parameters['limits']), profilesFrom(parameters['allowedProfiles']));
          // Verify by reading the persisted file back.
          const persisted = this.store().list().find((item) => item.id === client.id);
          if (!persisted) return fail('The site key could not be verified after creation.');
          const revealToken = this.reveals.park(deviceId, client.id, apiKey);
          return ok({ client: persisted, revealToken, note: 'Fetch the key once from the HUD within 10 minutes; it is not stored anywhere else.' });
        }
        case 'gateway:site_update': {
          const changes: { limits?: Partial<SiteClientLimits>; allowedProfiles?: string[] } = {};
          if (parameters['limits'] !== undefined) changes.limits = limitsFrom(parameters['limits']);
          const profiles = profilesFrom(parameters['allowedProfiles']);
          if (profiles !== undefined) changes.allowedProfiles = profiles;
          return ok(store.updateSettings(String(parameters['id'] ?? ''), changes));
        }
        case 'gateway:site_revoke':
          return ok(store.revoke(String(parameters['id'] ?? '')));
        default:
          return fail(`Unsupported gateway operation ${String(operation)}.`);
      }
    } catch (error) {
      return fail(error instanceof Error ? error.message : 'Gateway site operation failed.');
    }
  }
}
