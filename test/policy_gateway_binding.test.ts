import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { rmSync, existsSync } from 'node:fs';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceRecord, DeviceStatus, Permission, RiskTier } from '../src/core/types.js';
import { PolicyGateway } from '../src/policy/gateway.js';

const auditPath = './data/test_policy_gateway.log';
const grantPath = './data/test_policy_gateway_grants.json';

function makeDevice(id: string): DeviceRecord {
  return {
    id,
    name: id,
    platform: 'test',
    publicKey: 'test-public-key',
    status: DeviceStatus.ACTIVE,
    permissions: [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE],
    enrolledAt: Date.now(),
    lastSeenAt: Date.now(),
  };
}

function setup() {
  for (const path of [auditPath, grantPath]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  const audit = new AuditLogger(auditPath);
  const gateway = new PolicyGateway(audit, grantPath);
  return { audit, gateway };
}

afterEach(() => {
  for (const path of [auditPath, grantPath]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
});

test('approval is bound to the original task even when operation parameters match', () => {
  const { gateway } = setup();
  const device = makeDevice('device-a');
  const parameters = { appId: 'notepad' };
  const approval = gateway.createApprovalRequest('task-original', device.id, 'app:launch', parameters, RiskTier.MEDIUM);
  assert.equal(gateway.resolveApproval(approval.id, true, device.id).success, true);

  const result = gateway.evaluate(
    { operation: 'app:launch', parameters },
    device,
    'task-replayed',
    approval.id,
  );

  assert.equal(result.allowed, false);
  assert.equal(result.requiresApproval, false);
  assert.match(result.reason ?? '', /not bound to this task, device, and operation/i);
});

test('approval is bound to the requesting device', () => {
  const { gateway } = setup();
  const requestingDevice = makeDevice('device-a');
  const otherDevice = makeDevice('device-b');
  const parameters = { appId: 'notepad' };
  const approval = gateway.createApprovalRequest('task-a', requestingDevice.id, 'app:launch', parameters, RiskTier.MEDIUM);
  assert.equal(gateway.resolveApproval(approval.id, true, requestingDevice.id).success, true);

  const result = gateway.evaluate(
    { operation: 'app:launch', parameters },
    otherDevice,
    'task-a',
    approval.id,
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /not bound to this task, device, and operation/i);
});

test('approval is bound to the exact operation', () => {
  const { gateway } = setup();
  const device = makeDevice('device-a');
  const parameters = { appId: 'notepad' };
  const approval = gateway.createApprovalRequest('task-a', device.id, 'app:launch', parameters, RiskTier.MEDIUM);
  assert.equal(gateway.resolveApproval(approval.id, true, device.id).success, true);

  const result = gateway.evaluate(
    { operation: 'desktop:type_text', parameters },
    device,
    'task-a',
    approval.id,
  );

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? '', /not bound to this task, device, and operation/i);
});

test('malformed runtime parameter containers fail closed instead of throwing', () => {
  const { gateway } = setup();
  const device = makeDevice('device-a');

  for (const parameters of [null, [], 'not-an-object', 7] as unknown[]) {
    const result = gateway.evaluate(
      { operation: 'app:launch', parameters: parameters as Record<string, unknown> },
      device,
      'task-a',
    );
    assert.equal(result.allowed, false);
    assert.equal(result.requiresApproval, false);
    assert.match(result.reason ?? '', /parameters must be a plain object/i);
  }
});

test('unknown operation parameters are denied before approval is considered', () => {
  const { gateway } = setup();
  const device = makeDevice('device-a');
  const result = gateway.evaluate(
    { operation: 'app:launch', parameters: { appId: 'notepad', shell: 'powershell' } },
    device,
    'task-a',
  );

  assert.equal(result.allowed, false);
  assert.equal(result.requiresApproval, false);
  assert.match(result.reason ?? '', /disallowed parameter 'shell'/i);
});
