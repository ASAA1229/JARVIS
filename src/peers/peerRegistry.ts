/**
 * LAN peer allowlist and explicit pairing (J-E11).
 *
 * A device can become a LAN peer only through explicit, owner-initiated pairing:
 *   1. An owner device (DEVICE_MANAGE) starts pairing for an already-enrolled device;
 *      the hub issues a short-lived 6-digit code bound to that device id.
 *   2. The target device confirms the code with its own signed session, proving it
 *      holds its enrolled Ed25519 key.
 * The allowlist entry pins the device's enrolled public key. Revocation (explicit or of
 * the device itself) removes the peer immediately. Peers can exchange status and sync
 * notifications only; they never gain authority to run commands on the laptop.
 *
 * The hub has its own Ed25519 key for signing LAN announcements; it is kept in an
 * encrypted state file and never leaves the laptop (only the public key is shared).
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { CryptoUtil } from '../crypto/crypto.js';
import { EncryptedJsonFile } from '../memory/encryptedJsonFile.js';
import { DeviceStatus, type DeviceRecord } from '../core/types.js';

export const PAIRING_CODE_TTL_MS = 2 * 60 * 1000;
export const HUB_PEER_ID = 'jarvis-hub';
const MAX_PEERS = 20;
const MAX_PAIRING_ATTEMPTS = 5;

export interface PeerEntry {
  deviceId: string;
  name: string;
  publicKey: string;
  pairedAt: number;
  pairedBy: string;
}

interface PeerStateFile {
  version: 1;
  hub: { publicKey: string; privateKey: string };
  hubSeq: number;
  peers: PeerEntry[];
  /** Highest envelope sequence accepted per sender (replay protection). */
  lastSeq: Record<string, number>;
}

interface PendingPairing {
  deviceId: string;
  code: string;
  expiresAt: number;
  startedBy: string;
  attempts: number;
}

export class PeerError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class PeerRegistry {
  private readonly file: EncryptedJsonFile<PeerStateFile>;
  private data: PeerStateFile;
  private pending: PendingPairing | null = null;

  constructor(filePath: string, ownerControlToken: string, private readonly getDevice: (id: string) => DeviceRecord | undefined) {
    this.file = new EncryptedJsonFile<PeerStateFile>(filePath, ownerControlToken, 'JARVIS-LAN-PEERS-V1');
    const loaded = this.file.read();
    if (loaded) {
      if (loaded.version !== 1 || !loaded.hub?.publicKey || !Array.isArray(loaded.peers)) {
        throw new Error('Peer state is invalid; refusing to overwrite it.');
      }
      this.data = loaded;
    } else {
      const keys = CryptoUtil.generateEd25519KeyPair();
      this.data = { version: 1, hub: { publicKey: keys.publicKey, privateKey: keys.privateKey }, hubSeq: 0, peers: [], lastSeq: {} };
      this.file.write(this.data);
    }
  }

  get hubPublicKey(): string {
    return this.data.hub.publicKey;
  }

  /** Signing material for LAN announcements; used only inside the discovery service. */
  nextHubSigning(): { privateKey: string; seq: number } {
    this.data.hubSeq += 1;
    this.file.write(this.data);
    return { privateKey: this.data.hub.privateKey, seq: this.data.hubSeq };
  }

  /** A peer counts only while its device is still active and its key is unchanged. */
  private isActive(entry: PeerEntry): boolean {
    const device = this.getDevice(entry.deviceId);
    return Boolean(device && device.status === DeviceStatus.ACTIVE && device.publicKey === entry.publicKey);
  }

  /** Remove peers whose device was revoked or re-keyed since pairing. */
  prune(): string[] {
    const removed = this.data.peers.filter((entry) => !this.isActive(entry)).map((entry) => entry.deviceId);
    if (removed.length) {
      this.data.peers = this.data.peers.filter((entry) => !removed.includes(entry.deviceId));
      for (const id of removed) delete this.data.lastSeq[id];
      this.file.write(this.data);
    }
    return removed;
  }

  list(): PeerEntry[] {
    this.prune();
    return this.data.peers.map((entry) => ({ ...entry }));
  }

  isPeer(deviceId: string): boolean {
    return this.list().some((entry) => entry.deviceId === deviceId);
  }

  startPairing(deviceId: string, startedBy: string): { code: string; expiresAt: number; deviceId: string } {
    const device = this.getDevice(deviceId);
    if (!device || device.status !== DeviceStatus.ACTIVE) throw new PeerError(404, 'Only an active enrolled device can be paired as a LAN peer.');
    if (this.isPeer(deviceId)) throw new PeerError(409, 'This device is already a paired LAN peer.');
    if (this.data.peers.length >= MAX_PEERS) throw new PeerError(409, 'The LAN peer limit has been reached; revoke a peer first.');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    this.pending = { deviceId, code, expiresAt: Date.now() + PAIRING_CODE_TTL_MS, startedBy, attempts: 0 };
    return { code, expiresAt: this.pending.expiresAt, deviceId };
  }

  pendingPairing(): { deviceId: string; expiresAt: number } | null {
    if (!this.pending || this.pending.expiresAt <= Date.now()) {
      this.pending = null;
      return null;
    }
    return { deviceId: this.pending.deviceId, expiresAt: this.pending.expiresAt };
  }

  /** Confirm pairing from the target device's own signed session. */
  confirmPairing(confirmingDevice: DeviceRecord, code: unknown): PeerEntry {
    const pending = this.pending;
    if (!pending || pending.expiresAt <= Date.now()) {
      this.pending = null;
      throw new PeerError(410, 'No pairing is in progress or the code expired. Start pairing again from the owner HUD.');
    }
    if (pending.deviceId !== confirmingDevice.id) throw new PeerError(403, 'This pairing code was issued for a different device.');
    const presented = Buffer.from(String(code ?? '').padEnd(6, ' ').slice(0, 6));
    const expected = Buffer.from(pending.code);
    if (!timingSafeEqual(presented, expected)) {
      pending.attempts += 1;
      if (pending.attempts >= MAX_PAIRING_ATTEMPTS) this.pending = null;
      throw new PeerError(401, 'Incorrect pairing code.');
    }
    if (confirmingDevice.status !== DeviceStatus.ACTIVE) throw new PeerError(403, 'Device is not active.');
    const entry: PeerEntry = {
      deviceId: confirmingDevice.id,
      name: confirmingDevice.name,
      publicKey: confirmingDevice.publicKey,
      pairedAt: Date.now(),
      pairedBy: pending.startedBy,
    };
    this.data.peers = this.data.peers.filter((item) => item.deviceId !== entry.deviceId);
    this.data.peers.push(entry);
    delete this.data.lastSeq[entry.deviceId];
    this.file.write(this.data);
    this.pending = null;
    return { ...entry };
  }

  revoke(deviceId: string): boolean {
    const before = this.data.peers.length;
    this.data.peers = this.data.peers.filter((entry) => entry.deviceId !== deviceId);
    delete this.data.lastSeq[deviceId];
    if (this.pending?.deviceId === deviceId) this.pending = null;
    if (this.data.peers.length === before) return false;
    this.file.write(this.data);
    return true;
  }

  lastSeqFrom(deviceId: string): number | undefined {
    return this.data.lastSeq[deviceId];
  }

  acceptSeq(deviceId: string, seq: number): void {
    this.data.lastSeq[deviceId] = seq;
    this.file.write(this.data);
  }
}
