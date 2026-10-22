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
   * Validates whether a given PEM string is a valid Ed25519 public key.
   */
  static isValidEd25519PublicKey(publicKeyPem: string): boolean {
    if (!publicKeyPem || typeof publicKeyPem !== 'string') return false;
    if (!publicKeyPem.includes('BEGIN PUBLIC KEY') || !publicKeyPem.includes('END PUBLIC KEY')) return false;
    try {
      // Attempt a dry verification to confirm Node crypto can load the key object
      verify(null, Buffer.from('test', 'utf-8'), publicKeyPem, Buffer.alloc(64));
      return true;
    } catch (err: unknown) {
      // If error is about invalid key format/curve, it is not a valid key
      const msg = String(err);
      if (msg.includes('bad end line') || msg.includes('unsupported') || msg.includes('no start line') || msg.includes('error:')) {
        return false;
      }
      // If error is just signature verification failure, the key itself was loaded and parsed successfully!
      return true;
    }
  }

  /**
   * Builds canonical payload string for request signing.
   * Format: METHOD:PATH:SESSION_ID:TIMESTAMP:NONCE:BODY_SHA256
   */
  static buildCanonicalRequestString(
    method: string,
    path: string,
    sessionId: string,
    timestamp: number,
    nonce: string,
    body: unknown
  ): string {
    const bodyHash = body ? this.canonicalHash(body) : this.sha256('');
    return `${method.toUpperCase()}:${path}:${sessionId}:${timestamp}:${nonce}:${bodyHash}`;
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
