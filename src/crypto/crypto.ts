import { createHash, generateKeyPairSync, sign, verify, randomBytes } from 'node:crypto';

export class CryptoUtil {
  /**
   * Generates a standard Ed25519 keypair for device identity.
   */
  static generateEd25519KeyPair(): { publicKey: string; privateKey: string } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
  }

  /**
   * Signs data with Ed25519 private key.
   */
  static signData(data: string, privateKeyPem: string): string {
    const signature = sign(null, Buffer.from(data, 'utf-8'), privateKeyPem);
    return signature.toString('base64');
  }

  /**
   * Verifies signature with Ed25519 public key.
   */
  static verifySignature(data: string, signatureBase64: string, publicKeyPem: string): boolean {
    try {
      return verify(null, Buffer.from(data, 'utf-8'), publicKeyPem, Buffer.from(signatureBase64, 'base64'));
    } catch {
      return false;
    }
  }

  /**
   * Computes a SHA-256 hash in hex format.
   */
  static sha256(data: string): string {
    return createHash('sha256').update(data, 'utf-8').digest('hex');
  }

  /**
   * Computes a deterministic canonical hash of an object.
   */
  static canonicalHash(obj: unknown): string {
    const str = JSON.stringify(obj, Object.keys(obj as object).sort());
    return this.sha256(str);
  }

  /**
   * Generates a cryptographically secure random token string.
   */
  static randomToken(bytes: number = 32): string {
    return randomBytes(bytes).toString('hex');
  }
}
