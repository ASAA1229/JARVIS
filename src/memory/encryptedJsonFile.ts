/**
 * Small AES-256-GCM JSON file helper (same scheme as the personal memory store):
 * key = scrypt(owner token, purpose label), per-write random salt and IV,
 * atomic temp-file + rename writes, fail-closed reads.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { renameWithRetry } from '../core/atomicRename.js';

export class EncryptedJsonFile<T> {
  private readonly key: Buffer;

  constructor(private readonly filePath: string, ownerControlToken: string, purpose: string) {
    if (ownerControlToken.length < 32) throw new Error('Encrypted state requires a configured owner control token.');
    this.key = scryptSync(ownerControlToken, purpose, 32);
  }

  get path(): string {
    return this.filePath;
  }

  read(): T | undefined {
    if (!existsSync(this.filePath)) return undefined;
    const envelope = JSON.parse(readFileSync(this.filePath, 'utf8')) as { salt: string; iv: string; tag: string; ciphertext: string };
    const key = scryptSync(this.key, Buffer.from(envelope.salt, 'base64'), 32);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    return JSON.parse(plain) as T;
  }

  write(value: T): void {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(this.key, salt, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp-${randomBytes(6).toString('hex')}`;
    writeFileSync(temporary, JSON.stringify({
      version: 1,
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    }), { mode: 0o600 });
    renameWithRetry(temporary, this.filePath);
  }

  remove(): void {
    rmSync(this.filePath, { force: true });
  }
}
