import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { DeviceIdentityManager } from '../src/core/identity.js';
import {
  ANDROID_COMPANION_PROTOCOL_VERSION,
  ANDROID_NATIVE_REQUIREMENTS,
  enrollmentProofPayload,
  signAndroidRequest,
  signEnrollmentProof,
  signSessionRequest,
} from '../src/android/companionContract.js';

test('Android companion contract matches laptop enrollment and signed-request verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-android-contract-'));
  try {
    assert.equal(ANDROID_COMPANION_PROTOCOL_VERSION, 1);
    assert.match(ANDROID_NATIVE_REQUIREMENTS.keystore, /Keystore/);
    const identity = new DeviceIdentityManager(new AuditLogger(join(directory, 'audit.log')), join(directory, 'devices.json'));
    const keyPair = CryptoUtil.generateEd25519KeyPair();
    const challenge = identity.createEnrollmentChallenge();
    const proof = signEnrollmentProof(challenge.challengeToken, 'Pixel Test', keyPair.publicKey, keyPair.privateKey);
    assert.equal(
      CryptoUtil.verifySignature(enrollmentProofPayload(proof.challengeToken, proof.deviceName, proof.publicKeyPem), proof.proofSignature, keyPair.publicKey),
      true,
    );
    const enrolled = identity.enrollDevice(proof.challengeToken, proof.deviceName, proof.publicKeyPem, 'Android');
    assert.equal(enrolled.success, true);
    assert.equal(identity.getDevice(enrolled.deviceId!)?.platform, 'Android');
    const sessionReq = signSessionRequest(enrolled.deviceId!, keyPair.privateKey);
    const session = identity.createSession(sessionReq.deviceId, sessionReq.signature, sessionReq.timestamp, sessionReq.nonce);
    assert.equal(session.success, true);
    const signed = signAndroidRequest(keyPair.privateKey, 'POST', '/api/request', session.sessionId!, { text: 'What is the OS version?' });
    const verified = identity.validateSignedRequest(
      signed.sessionId,
      signed.method,
      signed.path,
      signed.timestamp,
      signed.nonce,
      signed.body,
      signed.signature,
    );
    assert.equal(verified.valid, true);
    const replay = identity.validateSignedRequest(
      signed.sessionId,
      signed.method,
      signed.path,
      signed.timestamp,
      signed.nonce,
      signed.body,
      signed.signature,
    );
    assert.equal(replay.valid, false);
    assert.match(replay.error || '', /nonce/i);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
