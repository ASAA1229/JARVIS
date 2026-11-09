/**
 * LAN-only peer discovery (J-E11). OFF by default; enabled with JARVIS_PEER_DISCOVERY=true.
 *
 * - UDP multicast on 239.255.77.77:41777 with TTL 1 (never routed beyond the local link).
 * - Datagrams from non-private source addresses are dropped (no internet exposure).
 * - The hub announces itself with an envelope signed by its own Ed25519 key.
 * - Inbound envelopes are accepted only from paired peers (allowlist pins the enrolled
 *   key), with expiry/skew checks and a per-sender monotonic sequence (replay protection).
 * - Accepted message types are presence and sync notifications ONLY. A sync
 *   notification is recorded so the HUD can show it; the actual changes must still be
 *   pushed through the signed hub sync API. Peers can never run commands here.
 */
import { createSocket, type RemoteInfo, type Socket } from 'node:dgram';
import { createPeerEnvelope, verifyPeerEnvelope, type PeerEnvelope } from '../sync/peerEnvelope.js';
import { HUB_PEER_ID, type PeerRegistry } from './peerRegistry.js';

export const PEER_MULTICAST_GROUP = '239.255.77.77';
export const PEER_MULTICAST_PORT = 41777;
const ANNOUNCE_INTERVAL_MS = 30_000;
const ONLINE_WINDOW_MS = 90_000;
const MAX_DATAGRAM_BYTES = 64 * 1024;
const BROADCAST_RECIPIENT = 'lan';

export interface PeerPresence {
  deviceId: string;
  lastSeenAt: number;
  address: string;
  lastMessage: 'presence' | 'sync.changes' | 'sync.ack';
  pendingSyncNotices: number;
}

/** RFC 1918, link-local and loopback only. */
export function isPrivateLanAddress(address: string): boolean {
  const v4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  const parts = v4.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = parts as [number, number, number, number];
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  const lower = address.toLowerCase();
  return lower === '::1' || lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd');
}

export type DiscoveryEvent =
  | { type: 'accepted'; deviceId: string; message: PeerPresence['lastMessage'] }
  | { type: 'rejected'; reason: string };

export class PeerDiscoveryService {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly presence = new Map<string, PeerPresence>();
  private state: 'disabled' | 'stopped' | 'running' | 'error' = 'stopped';
  private lastError: string | null = null;

  constructor(
    private readonly registry: PeerRegistry,
    private readonly onEvent: (event: DiscoveryEvent) => void = () => undefined,
    private readonly enabled: boolean = process.env.JARVIS_PEER_DISCOVERY === 'true',
  ) {
    if (!enabled) this.state = 'disabled';
  }

  start(): void {
    if (!this.enabled || this.socket) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    this.socket = socket;
    socket.on('error', (error) => {
      this.state = 'error';
      this.lastError = error.message;
      this.stop();
    });
    socket.on('message', (message, remote) => this.handle(message, remote));
    socket.bind(PEER_MULTICAST_PORT, () => {
      try {
        socket.addMembership(PEER_MULTICAST_GROUP);
        socket.setMulticastTTL(1);
        socket.setMulticastLoopback(false);
        this.state = 'running';
        this.announce();
        this.timer = setInterval(() => this.announce(), ANNOUNCE_INTERVAL_MS);
        this.timer.unref();
      } catch (error) {
        this.state = 'error';
        this.lastError = error instanceof Error ? error.message : 'Multicast setup failed';
        this.stop();
      }
    });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      try { socket.close(); } catch { /* already closed */ }
    }
    if (this.state === 'running') this.state = 'stopped';
  }

  /** Signed hub presence, so paired phones can verify they reached the real hub. */
  private announce(): void {
    if (!this.socket) return;
    const { privateKey, seq } = this.registry.nextHubSigning();
    const envelope = createPeerEnvelope({
      from: HUB_PEER_ID,
      to: BROADCAST_RECIPIENT,
      seq,
      type: 'presence',
      payload: { role: 'hub', hubPublicKey: this.registry.hubPublicKey, at: Date.now() },
      privateKeyPem: privateKey,
      lifetimeMs: 2 * ANNOUNCE_INTERVAL_MS,
    });
    const datagram = Buffer.from(JSON.stringify(envelope), 'utf8');
    this.socket.send(datagram, PEER_MULTICAST_PORT, PEER_MULTICAST_GROUP);
  }

  /** Exposed for tests: validate and record one inbound datagram. */
  handle(message: Buffer, remote: Pick<RemoteInfo, 'address'>): DiscoveryEvent {
    const reject = (reason: string): DiscoveryEvent => {
      const event: DiscoveryEvent = { type: 'rejected', reason };
      this.onEvent(event);
      return event;
    };
    if (!isPrivateLanAddress(remote.address)) return reject('non_lan_source');
    if (message.length > MAX_DATAGRAM_BYTES) return reject('too_large');
    let envelope: PeerEnvelope;
    try {
      envelope = JSON.parse(message.toString('utf8')) as PeerEnvelope;
    } catch {
      return reject('invalid_json');
    }
    if (!envelope || envelope.from === HUB_PEER_ID) return reject('own_or_empty');
    const recipient = envelope.to === BROADCAST_RECIPIENT ? BROADCAST_RECIPIENT : HUB_PEER_ID;
    const peers = this.registry.list().map((entry) => ({ deviceId: entry.deviceId, publicKey: entry.publicKey, p2p: true }));
    const lastSeq = this.registry.lastSeqFrom(envelope.from);
    const result = verifyPeerEnvelope(envelope, { recipientId: recipient, peers, ...(lastSeq !== undefined ? { lastSeqFromSender: lastSeq } : {}) });
    if (!result.ok) return reject(result.reason);
    this.registry.acceptSeq(envelope.from, envelope.seq);
    const previous = this.presence.get(envelope.from);
    this.presence.set(envelope.from, {
      deviceId: envelope.from,
      lastSeenAt: Date.now(),
      address: remote.address,
      lastMessage: envelope.type,
      // Sync notices are only counted; changes must arrive via the signed hub sync API.
      pendingSyncNotices: (previous?.pendingSyncNotices ?? 0) + (envelope.type === 'sync.changes' ? 1 : 0),
    });
    const event: DiscoveryEvent = { type: 'accepted', deviceId: envelope.from, message: envelope.type };
    this.onEvent(event);
    return event;
  }

  forget(deviceId: string): void {
    this.presence.delete(deviceId);
  }

  clearSyncNotices(deviceId: string): void {
    const entry = this.presence.get(deviceId);
    if (entry) entry.pendingSyncNotices = 0;
  }

  status(): { state: 'disabled' | 'stopped' | 'running' | 'error'; lastError: string | null; group: string; port: number } {
    return { state: this.state, lastError: this.lastError, group: PEER_MULTICAST_GROUP, port: PEER_MULTICAST_PORT };
  }

  presenceOf(deviceId: string): (PeerPresence & { online: boolean }) | null {
    const entry = this.presence.get(deviceId);
    return entry ? { ...entry, online: Date.now() - entry.lastSeenAt <= ONLINE_WINDOW_MS } : null;
  }
}
