# ADR-004: Request Canonicalization, Persistent State, and Recovery Semantics

## Status
Accepted

## Context
Milestone 6 requires formalizing:
1. End-to-end request canonicalization and cryptographic signature validation.
2. Persistence of enrolled device identities and revocation states across host restarts.
3. Fail-closed recovery semantics when persistent storage, audit chains, or execution sessions are interrupted.
4. Browser companion key storage realities vs. native Android platform security.

## Decision

### 1. Request Canonicalization & Signing Protocol
To prevent man-in-the-middle tampering, parameter injection, and replay attacks across untrusted networks:
- Requests carry:
  - `x-session-id`: Active session identifier.
  - `x-timestamp`: Unix epoch milliseconds of request creation.
  - `x-nonce`: Cryptographically random 16-byte hex nonce.
  - `x-signature`: Base64-encoded Ed25519 signature over canonical string:
    `METHOD:PATH:SESSION_ID:TIMESTAMP:NONCE:SHA256(BODY)`
- The host validates:
  - Timestamp freshness (`|now - timestamp| <= 60000ms`).
  - Nonce freshness (rejected if replayed within session cache).
  - Public key signature verification against enrolled device public key.

### 2. Device Identity & Revocation Persistence
- Devices and their revocation states are persisted to an atomic JSON record (`data/devices.json`).
- If a device is revoked, its status is immediately written to disk with an accompanying SHA-256 chained audit record.
- Upon host restart, revoked devices remain permanently revoked. Active ephemeral sessions do not persist across restarts to guarantee fresh authentication.

### 3. Fail-Closed Audit Chain Integrity
- Before any state-changing execution adapter is invoked, `AuditLogger.verifyIntegrity()` is evaluated.
- If any audit record is altered, deleted, or truncated, `JarvisCoreService` refuses execution with an explicit audit integrity violation.

### 4. Browser PWA vs. Native Android Keystore Evaluation
- **PWA Companion Reality**: Browser Web Crypto API stores keys in IndexedDB/LocalStorage. While protected by Same-Origin Policy, it is vulnerable to local device compromise or malicious browser extensions.
- **Hardware-Backed Anchor**: True non-exportable hardware-backed keys require the Android Keystore (`KeyGenParameterSpec.Builder(..., PURPOSE_SIGN).setIsStrongBoxBacked(true)`).
- **Milestone 6 Posture**: The PWA companion is explicitly designated for local POC and development testing. Production deployment for remote operation mandates either a native Android companion or a hardened mobile container.

## Consequences
- Verified replay protection, hardened restart behavior, and honest reporting of platform key boundaries.
