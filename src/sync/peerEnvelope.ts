/**
 * Signed peer-to-peer envelopes (JARVIS-US-060, optional P2P mode).
 *
 * Devices that negotiated the `p2p-envelope` capability may exchange messages
 * directly (e.g. on the same LAN while the laptop hub is unreachable). Every
 * envelope is signed with the sender's enrolled Ed25519 device key and verified
 * against the hub's enrolled key list (cached on each device from
 * GET /api/sync/peers). The hub remains the source of truth: envelopes carry
 * sync changes that are pushed to the hub when it is reachable again.
 * LAN discovery/transport is future work (docs/DEVICE_SYNC.md).
 */
import { createHash } from 'node:crypto';
import { CryptoUtil } from '../crypto/crypto.js';

export const PEER_ENVELOPE_VERSION = 1;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;

export interface PeerEnvelope {
  v: 1;
  from: string;
  to: string;
  seq: number;
  issuedAt: number;
  expiresAt: number;
  type: 'sync.changes' | 'sync.ack' | 'presence';
  /** Base64 JSON payload. */
  payload: string;
  payloadSha256: string;
  signature: string;
}

export interface PeerKey {
  deviceId: string;
  publicKey: string;
  p2p: boolean;
}

function canonical(envelope: Omit<PeerEnvelope, 'signature'>): string {
  return ['JARVIS_PEER_V1', envelope.v, envelope.from, envelope.to, envelope.seq, envelope.issuedAt, envelope.expiresAt, envelope.type, envelope.payloadSha256].join('\n');
}

export function createPeerEnvelope(input: {
  from: string; to: string; seq: number; type: PeerEnvelope['type']; payload: unknown; privateKeyPem: string; now?: number; lifetimeMs?: number;
}): PeerEnvelope {
  const payload = Buffer.from(JSON.stringify(input.payload), 'utf8');
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error('Peer payload is too large.');
  const issuedAt = input.now ?? Date.now();
  const unsigned: Omit<PeerEnvelope, 'signature'> = {
    v: PEER_ENVELOPE_VERSION,
    from: input.from,
    to: input.to,
    seq: input.seq,
    issuedAt,
    expiresAt: issuedAt + Math.min(input.lifetimeMs ?? 15 * 60 * 1000, MAX_LIFETIME_MS),
    type: input.type,
    payload: payload.toString('base64'),
    payloadSha256: createHash('sha256').update(payload).digest('hex'),
  };
  return { ...unsigned, signature: CryptoUtil.signData(canonical(unsigned), input.privateKeyPem) };
}

/**
 * Verify an envelope against the hub-issued peer key list. Returns the decoded
 * payload or a reason. Replay protection: callers track the highest seq seen per sender.
 */
export function verifyPeerEnvelope(
  envelope: PeerEnvelope,
  options: { recipientId: string; peers: PeerKey[]; lastSeqFromSender?: number; now?: number },
): { ok: true; payload: unknown } | { ok: false; reason: string } {
  const now = options.now ?? Date.now();
  if (!envelope || envelope.v !== PEER_ENVELOPE_VERSION) return { ok: false, reason: 'unsupported_version' };
  if (envelope.to !== options.recipientId) return { ok: false, reason: 'wrong_recipient' };
  if (!Number.isSafeInteger(envelope.seq) || envelope.seq < 1) return { ok: false, reason: 'invalid_seq' };
  if (options.lastSeqFromSender !== undefined && envelope.seq <= options.lastSeqFromSender) return { ok: false, reason: 'replayed' };
  if (envelope.issuedAt > now + 5 * 60_000 || envelope.expiresAt <= now || envelope.expiresAt - envelope.issuedAt > MAX_LIFETIME_MS) {
    return { ok: false, reason: 'expired_or_skewed' };
  }
  const sender = options.peers.find((peer) => peer.deviceId === envelope.from);
  if (!sender) return { ok: false, reason: 'unknown_sender' };
  if (!sender.p2p) return { ok: false, reason: 'sender_not_p2p_capable' };
  const payload = Buffer.from(envelope.payload, 'base64');
  if (payload.length > MAX_PAYLOAD_BYTES) return { ok: false, reason: 'payload_too_large' };
  if (createHash('sha256').update(payload).digest('hex') !== envelope.payloadSha256) return { ok: false, reason: 'payload_tampered' };
  const { signature, ...unsigned } = envelope;
  if (!CryptoUtil.verifySignature(canonical(unsigned), signature, sender.publicKey)) return { ok: false, reason: 'bad_signature' };
  try {
    return { ok: true, payload: JSON.parse(payload.toString('utf8')) };
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
}
