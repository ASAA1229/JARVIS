import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { TOTP, Secret } from 'otpauth';
import QRCode from 'qrcode';
import { AuditLogger } from '../audit/audit.js';
import { DeviceIdentityManager } from './identity.js';
import { PolicyGateway } from '../policy/gateway.js';
import { DeviceRecord, Permission } from './types.js';
import { CryptoUtil } from '../crypto/crypto.js';

export type EnrollmentState = 'WAITING_FOR_SCAN' | 'AWAITING_OWNER_AUTHORIZATION' | 'ENROLLED' | 'REJECTED' | 'CANCELLED' | 'EXPIRED';
interface EnrollmentTransaction {
  id: string; tokenHash: string; expiresAt: number; createdAt: number; createdBy: string;
  permissions: Permission[]; state: EnrollmentState; deviceId?: string; request?: { name: string; platform: string; publicKey: string; requestHash: string; requestedAt: number };
}

/** Owner security controls: hashed, single-use enrollment codes and encrypted TOTP state. */
export class DeviceSecurityService {
  private readonly transactions = new Map<string, EnrollmentTransaction>();
  private readonly key: Buffer;
  private readonly statePath?: string;
  private readonly failures: number[] = [];
  private lastAcceptedStep = -1;
  private pendingTotp?: string;
  private enabledSecret?: string;

  constructor(private readonly identity: DeviceIdentityManager, private readonly audit: AuditLogger, private readonly policy: PolicyGateway, ownerToken?: string, statePath = './data/security.json') {
    if (!ownerToken || ownerToken.length < 32) throw new Error('Owner control token is required for encrypted security state');
    this.key = Buffer.from(hkdfSync('sha256', Buffer.from(ownerToken), Buffer.from('JARVIS-device-security-v1'), Buffer.from('totp-at-rest'), 32));
    this.statePath = statePath;
    this.load();
  }

  private load(): void {
    if (!this.statePath || !existsSync(this.statePath)) return;
    try {
      const item = JSON.parse(readFileSync(this.statePath, 'utf8')) as { iv: string; tag: string; data: string };
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(item.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(item.tag, 'base64'));
      const parsed = JSON.parse(Buffer.concat([decipher.update(Buffer.from(item.data, 'base64')), decipher.final()]).toString('utf8')) as { secret?: string; lastAcceptedStep?: number; failures?: number[] };
      this.enabledSecret = parsed.secret;
      this.lastAcceptedStep = parsed.lastAcceptedStep ?? -1;
      this.failures.push(...(parsed.failures ?? []).filter((v) => Date.now() - v < 15 * 60_000));
    } catch { throw new Error('Encrypted device-security state is unavailable; security operations are blocked'); }
  }

  private persist(): void {
    if (!this.statePath) return;
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify({ secret: this.enabledSecret, lastAcceptedStep: this.lastAcceptedStep, failures: this.failures }), 'utf8'), cipher.final()]);
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp-${CryptoUtil.randomToken(6)}`;
    writeFileSync(temporary, JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  getTotpStatus(): 'DISABLED' | 'PENDING' | 'ENABLED' { return this.enabledSecret ? 'ENABLED' : this.pendingTotp ? 'PENDING' : 'DISABLED'; }

  async startTotpSetup(device: DeviceRecord): Promise<{ secret: string; otpauth: string; qrSvg: string }> {
    this.requireManage(device);
    if (this.enabledSecret) throw new Error('Authenticator is already enabled');
    this.pendingTotp = new Secret({ size: 20 }).base32;
    const uri = new TOTP({ issuer: 'JARVIS', label: 'JARVIS Owner', algorithm: 'SHA1', digits: 6, period: 30, secret: this.pendingTotp }).toString();
    try { this.audit.record('TOTP_SETUP_STARTED', {}, device.id); } catch (error) { this.pendingTotp = undefined; throw error; }
    return { secret: this.pendingTotp, otpauth: uri, qrSvg: await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 220 }) };
  }

  verifyTotpSetup(device: DeviceRecord, code: string): boolean {
    this.requireManage(device);
    if (!this.pendingTotp || !this.verifyCode(this.pendingTotp, code, true)) { this.audit.record('TOTP_SETUP_FAILED', {}, device.id); return false; }
    this.audit.record('TOTP_SETUP_VERIFIED', {}, device.id);
    const pending = this.pendingTotp;
    this.enabledSecret = this.pendingTotp;
    this.pendingTotp = undefined;
    try { this.persist(); } catch (error) { this.enabledSecret = undefined; this.pendingTotp = pending; throw error; }
    this.audit.record('TOTP_ENABLED', {}, device.id);
    return true;
  }

  disableTotp(device: DeviceRecord, code: string): boolean {
    this.requireManage(device);
    if (!this.enabledSecret || !this.verifyCode(this.enabledSecret, code, true)) { this.audit.record('TOTP_DISABLE_FAILED', {}, device.id); return false; }
    this.audit.record('TOTP_DISABLE_AUTHORIZED', {}, device.id);
    const previousSecret = this.enabledSecret;
    const previousStep = this.lastAcceptedStep;
    this.enabledSecret = undefined;
    this.lastAcceptedStep = -1;
    try { this.persist(); } catch (error) { this.enabledSecret = previousSecret; this.lastAcceptedStep = previousStep; throw error; }
    this.audit.record('TOTP_DISABLED', {}, device.id);
    return true;
  }

  verifyStepUp(device: DeviceRecord, code: string): boolean {
    this.requireManage(device);
    if (!this.enabledSecret) return false;
    const ok = this.verifyCode(this.enabledSecret, code, true);
    this.audit.record(ok ? 'TOTP_STEP_UP_SUCCEEDED' : 'TOTP_STEP_UP_FAILED', {}, device.id);
    return ok;
  }

  private verifyCode(secret: string, code: string, consume: boolean): boolean {
    const now = Date.now();
    while (this.failures.length && now - this.failures[0] > 15 * 60_000) this.failures.shift();
    if (this.failures.length >= 5) return false;
    if (!/^\d{6}$/.test(code)) { this.noteFailure(now); return false; }
    const totp = new TOTP({ issuer: 'JARVIS', label: 'JARVIS Owner', algorithm: 'SHA1', digits: 6, period: 30, secret });
    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) { this.noteFailure(now); return false; }
    const step = Math.floor(now / 30_000) + delta;
    if (step <= this.lastAcceptedStep) { this.noteFailure(now); return false; }
    if (consume) { this.lastAcceptedStep = step; this.failures.length = 0; this.persist(); }
    return true;
  }

  private noteFailure(now: number): void {
    this.failures.push(now);
    try { this.persist(); }
    catch (error) { this.audit.record('TOTP_FAILURE_STATE_PERSIST_FAILED', {}, undefined); throw error; }
  }

  async createEnrollment(device: DeviceRecord, totpCode: string, permissions: Permission[] = [Permission.SYSTEM_INFO_READ]): Promise<{ transactionId: string; code: string; expiresAt: number; qrSvg: string }> {
    this.expire();
    this.requireManage(device);
    if (!this.verifyStepUp(device, totpCode)) throw new Error('Fresh authenticator verification required');
    const safePermissions = this.validatePermissions(permissions);
    if (this.transactions.size >= 100) throw new Error('Enrollment request limit reached; wait for existing requests to expire');
    const code = randomBytes(32).toString('base64url');
    const transactionId = `enr-${CryptoUtil.randomToken(16)}`;
    const expiresAt = Date.now() + 120_000;
    const transaction: EnrollmentTransaction = { id: transactionId, tokenHash: CryptoUtil.sha256(code), expiresAt, createdAt: Date.now(), createdBy: device.id, permissions: safePermissions, state: 'WAITING_FOR_SCAN' };
    this.audit.record('ENROLLMENT_TRANSACTION_CREATED', { transactionId, expiresAt, permissions: safePermissions }, device.id);
    this.transactions.set(transactionId, transaction);
    const uri = `jarvis://enroll?transaction=${encodeURIComponent(transactionId)}&code=${encodeURIComponent(code)}`;
    return { transactionId, code, expiresAt, qrSvg: await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 240 }) };
  }

  exchangeEnrollment(input: { transactionId: string; code: string; name: string; platform: string; publicKey: string; proofSignature: string }): { state: EnrollmentState } {
    this.expire();
    const tx = this.transactions.get(input.transactionId);
    if (!tx || tx.state !== 'WAITING_FOR_SCAN' || tx.expiresAt <= Date.now() || !this.tokenMatches(tx, input.code)) {
      this.audit.record('ENROLLMENT_EXCHANGE_REJECTED', { reason: 'INVALID_EXPIRED_OR_REUSED' }); throw new Error('Enrollment code is invalid, expired, or already used');
    }
    if (!input.name.trim() || input.name.length > 80 || !/^[a-zA-Z0-9 ._-]{1,40}$/.test(input.platform) || !CryptoUtil.isValidEd25519PublicKey(input.publicKey)) throw new Error('Invalid enrollment details');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(input.proofSignature)) throw new Error('Enrollment proof verification failed');
    if (!/^[A-Za-z0-9+/]{86}==$/.test(input.proofSignature)) throw new Error('Enrollment proof verification failed');
    const requestHash = CryptoUtil.canonicalHash({ transactionId: tx.id, name: input.name.trim(), platform: input.platform, publicKey: input.publicKey, permissions: tx.permissions, expiresAt: tx.expiresAt });
    const proof = `JARVIS_ENROLLMENT_V1:${tx.id}:${requestHash}:${input.code}`;
    if (!CryptoUtil.verifySignature(proof, input.proofSignature, input.publicKey)) throw new Error('Enrollment proof verification failed');
    const provisional: DeviceRecord = { id: tx.id, name: input.name.trim(), publicKey: input.publicKey, status: 'ACTIVE' as DeviceRecord['status'], permissions: [...tx.permissions], enrolledAt: Date.now(), lastSeenAt: Date.now(), platform: input.platform };
    const policy = this.policy.evaluate({ operation: 'device:enrollment:exchange', parameters: {} }, provisional, `enrollment-${tx.id}`);
    if (!policy.allowed) throw new Error('Enrollment request denied by security policy');
    this.audit.record('ENROLLMENT_REQUEST_RECEIVED', { transactionId: tx.id, deviceName: input.name.trim(), platform: input.platform, requestHash }, tx.createdBy);
    tx.state = 'AWAITING_OWNER_AUTHORIZATION';
    tx.request = { name: input.name.trim(), platform: input.platform, publicKey: input.publicKey, requestHash, requestedAt: Date.now() };
    return { state: tx.state };
  }

  getEnrollmentDetails(transactionId: string, code: string): { permissions: Permission[]; expiresAt: number } | undefined {
    this.expire();
    const tx = this.transactions.get(transactionId);
    if (!tx || tx.state !== 'WAITING_FOR_SCAN' || tx.expiresAt <= Date.now() || !this.tokenMatches(tx, code)) return undefined;
    return { permissions: [...tx.permissions], expiresAt: tx.expiresAt };
  }

  statusForEnrollment(transactionId: string, code: string): { state: EnrollmentState; expiresAt: number; deviceId?: string } | undefined {
    this.expire(); const tx = this.transactions.get(transactionId);
    if (!tx || !this.tokenMatches(tx, code)) return undefined;
    return { state: tx.state, expiresAt: tx.expiresAt, deviceId: tx.state === 'ENROLLED' ? tx.deviceId : undefined };
  }

  private tokenMatches(tx: EnrollmentTransaction, code: string): boolean {
    if (!tx.tokenHash || !/^[A-Za-z0-9_-]{40,50}$/.test(code)) return false;
    const expected = Buffer.from(tx.tokenHash);
    const actual = Buffer.from(CryptoUtil.sha256(code));
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  }

  listPending(device: DeviceRecord): Array<{ transactionId: string; deviceName: string; platform: string; requestedAt: number; permissions: Permission[]; requestHash: string }> {
    this.requireManage(device);
    this.expire();
    return [...this.transactions.values()].filter((tx) => tx.state === 'AWAITING_OWNER_AUTHORIZATION' && tx.request).map((tx) => ({ transactionId: tx.id, deviceName: tx.request!.name, platform: tx.request!.platform, requestedAt: tx.request!.requestedAt, permissions: tx.permissions, requestHash: tx.request!.requestHash }));
  }

  async approve(device: DeviceRecord, transactionId: string, requestHash: string, code: string): Promise<{ deviceId: string }> {
    this.expire();
    this.requireManage(device);
    if (!this.verifyStepUp(device, code)) throw new Error('Fresh authenticator verification required');
    const tx = this.transactions.get(transactionId);
    if (!tx || tx.state !== 'AWAITING_OWNER_AUTHORIZATION' || tx.expiresAt <= Date.now() || !tx.request || tx.request.requestHash !== requestHash) throw new Error('Enrollment request expired or changed');
    this.audit.record('ENROLLMENT_OWNER_APPROVED', { transactionId, requestHash, permissions: tx.permissions }, device.id);
    const challenge = await this.identity.createEnrollmentChallenge(tx.permissions, 120);
    const enrolled = this.identity.enrollDevice(challenge.challengeToken, tx.request.name, tx.request.publicKey, tx.request.platform);
    if (!enrolled.success || !enrolled.deviceId) throw new Error(enrolled.error || 'Enrollment could not be completed');
    tx.state = 'ENROLLED'; tx.deviceId = enrolled.deviceId;
    return { deviceId: enrolled.deviceId };
  }

  reject(device: DeviceRecord, transactionId: string): boolean { return this.resolve(device, transactionId, 'REJECTED', 'ENROLLMENT_OWNER_REJECTED'); }
  cancel(device: DeviceRecord, transactionId: string): boolean {
    this.requireManage(device);
    this.expire();
    const tx = this.transactions.get(transactionId);
    if (!tx || tx.createdBy !== device.id || !['WAITING_FOR_SCAN', 'AWAITING_OWNER_AUTHORIZATION'].includes(tx.state)) return false;
    this.audit.record('ENROLLMENT_CANCELLED', { transactionId }, device.id); tx.state = 'CANCELLED'; return true;
  }
  status(transactionId: string): { state: EnrollmentState; expiresAt: number; deviceId?: string } | undefined { this.expire(); const tx = this.transactions.get(transactionId); return tx ? { state: tx.state, expiresAt: tx.expiresAt, deviceId: tx.deviceId } : undefined; }

  private resolve(device: DeviceRecord, transactionId: string, state: 'REJECTED', event: string): boolean {
    this.requireManage(device); this.expire(); const tx = this.transactions.get(transactionId);
    if (!tx || tx.state !== 'AWAITING_OWNER_AUTHORIZATION') return false;
    this.audit.record(event, { transactionId }, device.id); tx.state = state; return true;
  }
  private expire(): void {
    const now = Date.now();
    for (const [id, tx] of this.transactions) {
      if (tx.expiresAt <= now && ['WAITING_FOR_SCAN', 'AWAITING_OWNER_AUTHORIZATION'].includes(tx.state)) { this.audit.record('ENROLLMENT_EXPIRED', { transactionId: tx.id }); tx.state = 'EXPIRED'; }
      if (tx.expiresAt + 10 * 60_000 <= now && ['ENROLLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].includes(tx.state)) this.transactions.delete(id);
    }
  }
  private requireManage(device: DeviceRecord): void { if (!device.permissions.includes(Permission.DEVICE_MANAGE) || device.status !== 'ACTIVE') throw new Error('Device lacks active device-management permission'); }
  private validatePermissions(values: Permission[]): Permission[] {
    if (!Array.isArray(values) || !values.length || values.some((permission) => ![Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE].includes(permission)) || new Set(values).size !== values.length || !values.includes(Permission.SYSTEM_INFO_READ)) throw new Error('Requested permissions exceed the enrollment allowlist');
    return [...values];
  }
}
