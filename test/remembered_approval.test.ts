import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import { AuditLogger } from '../src/audit/audit.js';
import { PolicyGateway } from '../src/policy/gateway.js';
import { DeviceRecord, Permission, RiskTier } from '../src/core/types.js';

const grantPath = './data/test-remembered-approvals.json';
const auditPath = './data/test-remembered-approvals.log';
const ownerToken = 'test-owner-control-token-that-is-long-enough-0123456789';
const device: DeviceRecord = {
  id: 'dev-test-owner',
  name: 'Test Owner',
  platform: 'Browser',
  publicKey: 'test-public-key',
  status: 'ACTIVE' as DeviceRecord['status'],
  permissions: [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH],
  enrolledAt: Date.now(),
  lastSeenAt: Date.now(),
};

afterEach(() => {
  for (const path of [grantPath, auditPath, `${grantPath}.tmp-test`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
});

test('approved app launch is remembered across gateway restarts for the same device and exact parameters', () => {
  for (const path of [grantPath, auditPath]) if (existsSync(path)) rmSync(path, { force: true });
  const first = new PolicyGateway(new AuditLogger(auditPath), grantPath, ownerToken);
  const request = { operation: 'app:launch', parameters: { appId: 'notepad' } };
  const initial = first.evaluate(request, device, 'task-first');
  assert.equal(initial.allowed, false);
  assert.equal(initial.requiresApproval, true);

  const pending = first.createApprovalRequest('task-first', device.id, request.operation, request.parameters, RiskTier.MEDIUM);
  assert.deepEqual(first.resolveApproval(pending.id, true, device.id), { success: true });

  const restarted = new PolicyGateway(new AuditLogger(auditPath), grantPath, ownerToken);
  const repeated = restarted.evaluate(request, device, 'task-second');
  assert.equal(repeated.allowed, true);
  assert.equal(repeated.requiresApproval, false);

  const differentApp = restarted.evaluate({ operation: 'app:launch', parameters: { appId: 'calculator' } }, device, 'task-third');
  assert.equal(differentApp.allowed, false);
  assert.equal(differentApp.requiresApproval, true);
});
