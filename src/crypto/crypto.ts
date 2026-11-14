import { createHash, createPublicKey, generateKeyPairSync, sign, verify, randomBytes } from 'node:crypto';

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
    if (typeof publicKeyPem !== 'string' || publicKeyPem.length > 4096) return false;
    try {
      const key = createPublicKey(publicKeyPem);
      return key.type === 'public' && key.asymmetricKeyType === 'ed25519';
    } catch {
      return false;
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
    const stableStringify = (value: unknown): string => {
      if (value === null) return 'null';
      if (Array.isArray(value)) {
        return '[' + value.map((item) => stableStringify(item)).join(',') + ']';
      }
      if (typeof value === 'object') {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        return '{' + keys.map((key) => JSON.stringify(key) + ':' + stableStringify(record[key])).join(',') + '}';
      }
      const encoded = JSON.stringify(value);
      return encoded === undefined ? 'null' : encoded;
    };
    return this.sha256(stableStringify(obj));
  }

  /**
   * Generates a cryptographically secure random token string.
   */
  static randomToken(bytes: number = 32): string {
    return randomBytes(bytes).toString('hex');
  }
}
