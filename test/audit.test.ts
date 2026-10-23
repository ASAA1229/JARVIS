import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { CryptoUtil } from '../src/crypto/crypto.js';
import { AuditRecord } from '../src/core/types.js';

function withAuditDirectory(run: (directory: string) => void): void {
  const directory = mkdtempSync('./data/test-audit-regression-');
  try {
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('AUD-02: Audit redaction covers nested arrays, secret text, and legacy API records', () => {
  withAuditDirectory((directory) => {
    const logPath = join(directory, 'audit.log');
    const audit = new AuditLogger(logPath);
    const privateKey = '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----';
    audit.record('REDACTION_TEST', {
      nested: [{ privateKey: 'private-field-secret', authToken: 'token-field-secret' }],
      message: 'message-field-secret',
      rawText: `Bearer bearer-secret ${privateKey}`,
    });

    const persisted = readFileSync(logPath, 'utf8');
    for (const secret of ['private-field-secret', 'token-field-secret', 'message-field-secret', 'bearer-secret', 'private-material']) {
      assert.strictEqual(persisted.includes(secret), false, `audit file contains ${secret}`);
    }

    const record = JSON.parse(persisted) as AuditRecord;
    record.details = {
      requestText: 'legacy-request-secret',
      nested: [{ signature: 'legacy-signature-secret' }],
    };
    const payload = `${record.index}:${record.timestamp}:${record.eventType}:${record.deviceId ?? ''}:${record.taskId ?? ''}:${JSON.stringify(record.details)}:${record.prevHash}`;
    record.hash = CryptoUtil.sha256(payload);
    writeFileSync(logPath, `${JSON.stringify(record)}\n`, 'utf8');

    const recovered = new AuditLogger(logPath);
    assert.strictEqual(recovered.verifyIntegrity().valid, true);
    const publicRecord = recovered.getPublicRecords()[0];
    const publicJson = JSON.stringify(publicRecord);
    assert.strictEqual(publicJson.includes('legacy-request-secret'), false);
    assert.strictEqual(publicJson.includes('legacy-signature-secret'), false);
    assert.strictEqual('hash' in publicRecord, false);
    assert.strictEqual('prevHash' in publicRecord, false);
  });
});

test('AUD-03: A truncated audit log is detected and remains fail-closed', () => {
  withAuditDirectory((directory) => {
    const logPath = join(directory, 'audit.log');
    const audit = new AuditLogger(logPath);
    audit.record('BEFORE_TRUNCATION', { state: 'recorded' });
    appendFileSync(logPath, '{"partial":', 'utf8');

    const recovered = new AuditLogger(logPath);
    const integrity = recovered.verifyIntegrity();
    assert.strictEqual(integrity.valid, false);
    assert.match(integrity.reason || '', /AUDIT_LOG_TRUNCATED/);
    assert.throws(() => recovered.record('MUST_NOT_APPEND', {}), /Audit log is unhealthy/);
  });
});

test('AUD-04: An unavailable audit log blocks further records without success-shaped fallback', () => {
  withAuditDirectory((directory) => {
    const logPath = join(directory, 'audit.log');
    const audit = new AuditLogger(logPath);
    audit.record('BEFORE_UNAVAILABLE', { state: 'recorded' });
    rmSync(logPath);
    mkdirSync(logPath);

    const integrity = audit.verifyIntegrity();
    assert.strictEqual(integrity.valid, false);
    assert.match(integrity.reason || '', /AUDIT_LOG_READ_FAILED/);
    assert.strictEqual(audit.getRecords().length, 1);
    assert.throws(() => audit.record('MUST_NOT_APPEND', {}), /Audit log is unhealthy/);
  });
});

test('AUD-05: Runtime file tampering is detected before a new audit append', () => {
  withAuditDirectory((directory) => {
    const logPath = join(directory, 'audit.log');
    const audit = new AuditLogger(logPath);
    audit.record('BEFORE_TAMPERING', { state: 'recorded' });
    appendFileSync(logPath, '{"index":99}\n', 'utf8');

    const integrity = audit.verifyIntegrity();
    assert.strictEqual(integrity.valid, false);
    assert.match(integrity.reason || '', /AUDIT_LOG_CONTENT_MISMATCH/);
    assert.throws(() => audit.record('MUST_NOT_APPEND', {}), /Audit log is unhealthy/);
  });
});
