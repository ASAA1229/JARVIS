import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, writeFileSync } from 'node:fs';
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

test('remembered approval never bypasses fresh approval for other state-changing operations', () => {
  const first = new PolicyGateway(new AuditLogger(auditPath), grantPath, ownerToken);
  const launch = { operation: 'app:launch', parameters: { appId: 'notepad' } };
  const pending = first.createApprovalRequest('task-launch', device.id, launch.operation, launch.parameters, RiskTier.MEDIUM);
  assert.deepEqual(first.resolveApproval(pending.id, true, device.id), { success: true });

  const typedText = first.evaluate(
    { operation: 'desktop:type_text', parameters: { text: 'hello', expectProcess: 'notepad' } },
    device,
    'task-type-text',
  );
  assert.equal(typedText.allowed, false);
  assert.equal(typedText.requiresApproval, true);
});


test('task-scoped approvals reject changed scope and are single-use', () => {
  const previousTtl = process.env.JARVIS_REMEMBER_LAUNCH_MINUTES;
  process.env.JARVIS_REMEMBER_LAUNCH_MINUTES = '0';
  try {
    const gateway = new PolicyGateway(new AuditLogger(auditPath), grantPath, ownerToken);
    const request = { operation: 'app:launch', parameters: { appId: 'notepad' } };
    const pending = gateway.createApprovalRequest('task-bound', device.id, request.operation, request.parameters, RiskTier.MEDIUM);
    assert.deepEqual(gateway.resolveApproval(pending.id, true, device.id), { success: true });

    const changedParameters = gateway.evaluate(
      { operation: 'app:launch', parameters: { appId: 'calculator' } },
      device,
      'task-bound',
      pending.id,
    );
    assert.equal(changedParameters.allowed, false);
    assert.match(changedParameters.reason || '', /scope was modified/i);

    const changedTask = gateway.evaluate(request, device, 'another-task', pending.id);
    assert.equal(changedTask.allowed, false);
    assert.match(changedTask.reason || '', /not bound to this task/i);

    const firstUse = gateway.evaluate(request, device, 'task-bound', pending.id);
    assert.equal(firstUse.allowed, true);
    assert.equal(firstUse.requiresApproval, false);

    const replay = gateway.evaluate(request, device, 'task-bound', pending.id);
    assert.equal(replay.allowed, false);
    assert.equal(replay.requiresApproval, true);
    assert.match(replay.reason || '', /already been consumed/i);
  } finally {
    if (previousTtl === undefined) delete process.env.JARVIS_REMEMBER_LAUNCH_MINUTES;
    else process.env.JARVIS_REMEMBER_LAUNCH_MINUTES = previousTtl;
  }
});

test('corrupted remembered-approval state fails closed and cannot create a remembered grant', () => {
  const previousTtl = process.env.JARVIS_REMEMBER_LAUNCH_MINUTES;
  process.env.JARVIS_REMEMBER_LAUNCH_MINUTES = '30';
  try {
    writeFileSync(grantPath, JSON.stringify({ payload: 'tampered', mac: '00' }), 'utf8');
    const gateway = new PolicyGateway(new AuditLogger(auditPath), grantPath, ownerToken);
    const request = { operation: 'app:launch', parameters: { appId: 'notepad' } };

    const evaluation = gateway.evaluate(request, device, 'task-corrupt-state');
    assert.equal(evaluation.allowed, false);
    assert.equal(evaluation.requiresApproval, true);
    assert.match(evaluation.reason || '', /state is unhealthy/i);

    const pending = gateway.createApprovalRequest('task-corrupt-state', device.id, request.operation, request.parameters, RiskTier.MEDIUM);
    const resolution = gateway.resolveApproval(pending.id, true, device.id);
    assert.equal(resolution.success, false);
    assert.match(resolution.error || '', /could not safely persist/i);
  } finally {
    if (previousTtl === undefined) delete process.env.JARVIS_REMEMBER_LAUNCH_MINUTES;
    else process.env.JARVIS_REMEMBER_LAUNCH_MINUTES = previousTtl;
  }
});
