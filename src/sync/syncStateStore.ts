/**
 * Encrypted persistence for sync state. Conflicts and queued commands contain
 * owner text, so the file uses AES-256-GCM with a key derived from the owner
 * control token (same scheme as personal memory). Writes are atomic.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SyncStateFile } from './syncTypes.js';

const EMPTY: SyncStateFile = { version: 1, cursors: [], conflicts: [], commands: [] };

export class SyncStateStore {
  private readonly key: Buffer;

  constructor(private readonly filePath: string, ownerControlToken: string) {
    if (ownerControlToken.length < 32) throw new Error('Device sync requires a configured owner control token.');
    this.key = scryptSync(ownerControlToken, 'JARVIS-DEVICE-SYNC-V1', 32);
  }

  load(): SyncStateFile {
    if (!existsSync(this.filePath)) return structuredClone(EMPTY);
    try {
      const envelope = JSON.parse(readFileSync(this.filePath, 'utf8')) as { salt: string; iv: string; tag: string; ciphertext: string };
      const key = scryptSync(this.key, Buffer.from(envelope.salt, 'base64'), 32);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
      const parsed = JSON.parse(plain) as SyncStateFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.cursors) || !Array.isArray(parsed.conflicts) || !Array.isArray(parsed.commands)) {
        throw new Error('invalid');
      }
      return parsed;
    } catch {
      // Fail closed: never silently replace an unreadable sync state.
      throw new Error('Device sync state could not be decrypted or validated; sync is disabled to avoid data loss.');
    }
  }

  save(state: SyncStateFile): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(this.key, salt, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(state), 'utf8'), cipher.final()]);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(temporary, JSON.stringify({
      version: 1, salt: salt.toString('base64'), iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64'),
    }), { mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
