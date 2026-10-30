import { CryptoUtil } from '../crypto/crypto.js';

/**
 * Wire contract for a future native Android companion.
 *
 * This module does not talk to Android Keystore or a physical device. It defines
 * the exact payloads the laptop already authenticates so a native client can be
 * implemented against a stable, testable specification instead of a browser page.
 */
export const ANDROID_COMPANION_PROTOCOL_VERSION = 1;

export interface AndroidEnrollmentProof {
  challengeToken: string;
  deviceName: string;
  publicKeyPem: string;
  proofSignature: string;
}

export interface AndroidSessionRequest {
  deviceId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export interface AndroidSignedRequest {
  method: string;
  path: string;
  sessionId: string;
  timestamp: number;
  nonce: string;
  body: unknown;
  signature: string;
}

export function enrollmentProofPayload(challengeToken: string, deviceName: string, publicKeyPem: string): string {
  return `ENROLLMENT_PROOF:${challengeToken}:${deviceName}:${CryptoUtil.sha256(publicKeyPem)}`;
}

export function sessionRequestPayload(timestamp: number, nonce: string): string {
  return `SESSION_REQUEST:${timestamp}:${nonce}`;
}

export function signEnrollmentProof(
  challengeToken: string,
  deviceName: string,
  publicKeyPem: string,
  privateKeyPem: string,
): AndroidEnrollmentProof {
  const proofSignature = CryptoUtil.signData(enrollmentProofPayload(challengeToken, deviceName, publicKeyPem), privateKeyPem);
  return { challengeToken, deviceName, publicKeyPem, proofSignature };
}

export function signSessionRequest(deviceId: string, privateKeyPem: string, timestamp = Date.now(), nonce = CryptoUtil.randomToken(16)): AndroidSessionRequest {
  const signature = CryptoUtil.signData(sessionRequestPayload(timestamp, nonce), privateKeyPem);
  return { deviceId, timestamp, nonce, signature };
}

export function signAndroidRequest(
  privateKeyPem: string,
  method: string,
  path: string,
  sessionId: string,
  body: unknown,
  timestamp = Date.now(),
  nonce = CryptoUtil.randomToken(16),
): AndroidSignedRequest {
  const canonical = CryptoUtil.buildCanonicalRequestString(method, path, sessionId, timestamp, nonce, body);
  return {
    method: method.toUpperCase(),
    path,
    sessionId,
    timestamp,
    nonce,
    body,
    signature: CryptoUtil.signData(canonical, privateKeyPem),
  };
}

export const ANDROID_NATIVE_REQUIREMENTS = {
  keystore: 'Android Keystore or StrongBox for the Ed25519 (or hardware-backed) private key; the private key must never leave the device.',
  transport: 'TLS to the owner laptop only after an explicit, owner-approved pairing. Loopback/LAN remains the current server bind.',
  permissions: 'Device-specific permission sets assigned at enrollment; revocation must invalidate local sessions immediately.',
  ui: 'Show connection, enrollment, and approval status in the native UI. Browser companion is not a substitute.',
} as const;
