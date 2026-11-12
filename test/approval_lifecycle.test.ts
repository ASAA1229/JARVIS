import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceRecord, DeviceStatus, Permission, RiskTier } from '../src/core/types.js';
import { PolicyGateway } from '../src/policy/gateway.js';

/**
 * Approval lifecycle regression tests (unit level, no real desktop or device).
 * These exercise the in-process PolicyGateway only; they use a temporary
 * directory so they never touch the repository's data/ directory.
 */

const OPERATION = 'desktop:type_text';
const realNow = Date.now.bind(Date);
let skewMs = 0;
let directory: string;
let audit: AuditLogger;
let gateway: PolicyGateway;

function makeDevice(id: string, permissions: Permission[] = [Permission.SYSTEM_INFO_READ, Permission.APP_LAUNCH, Permission.DEVICE_MANAGE]): DeviceRecord {
  return {
    id,
    name: id,
    platform: 'test',
    publicKey: 'test-public-key',
    status: DeviceStatus.ACTIVE,
    permissions,
    enrolledAt: realNow(),
    lastSeenAt: realNow(),
  };
}

function auditEvents(type: string) {
  return audit.getRecords().filter((record) => record.eventType === type);
}

describe('PolicyGateway approval lifecycle', () => {
  beforeEach(() => {
    skewMs = 0;
    mock.method(Date, 'now', () => realNow() + skewMs);
    directory = mkdtempSync(join(tmpdir(), 'jarvis-approval-'));
    audit = new AuditLogger(join(directory, 'audit.log'));
    gateway = new PolicyGateway(audit, join(directory, 'grants.json'));
  });

  afterEach(() => {
    mock.restoreAll();
    rmSync(directory, { recursive: true, force: true });
  });

  test('an expired approval is denied and the attempt is audited', () => {
    const device = makeDevice('device-a');
    const parameters = { text: 'hello' };
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, parameters, RiskTier.HIGH, 60);
    assert.equal(gateway.resolveApproval(approval.id, true, device.id).success, true);

    skewMs = 61_000;
    const result = gateway.evaluate({ operation: OPERATION, parameters }, device, 'task-1', approval.id);

    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /expired/i);
    assert.equal(gateway.getApproval(approval.id)?.consumed ?? false, false);
    const events = auditEvents('POLICY_DENIED_APPROVAL_UNUSABLE');
    assert.equal(events.length, 1);
    assert.equal(events[0].details.denialReason, 'EXPIRED');
  });

  test('an approval cannot be resolved after it has expired', () => {
    const device = makeDevice('device-a');
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, { text: 'x' }, RiskTier.HIGH, 30);
    skewMs = 31_000;
    const result = gateway.resolveApproval(approval.id, true, device.id);
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /expired/i);
  });

  test('an approval is single-use and a replay is audited', () => {
    const device = makeDevice('device-a');
    const parameters = { text: 'hello' };
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, parameters, RiskTier.HIGH);
    gateway.resolveApproval(approval.id, true, device.id);

    const first = gateway.evaluate({ operation: OPERATION, parameters }, device, 'task-1', approval.id);
    assert.equal(first.allowed, true);

    const replay = gateway.evaluate({ operation: OPERATION, parameters }, device, 'task-1', approval.id);
    assert.equal(replay.allowed, false);
    assert.match(replay.reason ?? '', /already been consumed/i);
    const events = auditEvents('POLICY_DENIED_APPROVAL_UNUSABLE');
    assert.equal(events.length, 1);
    assert.equal(events[0].details.denialReason, 'ALREADY_CONSUMED');
  });

  test('a changed payload is denied without consuming the approval', () => {
    const device = makeDevice('device-a');
    const approved = { text: 'safe text' };
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, approved, RiskTier.HIGH);
    gateway.resolveApproval(approval.id, true, device.id);

    const altered = gateway.evaluate({ operation: OPERATION, parameters: { text: 'different text' } }, device, 'task-1', approval.id);
    assert.equal(altered.allowed, false);
    assert.match(altered.reason ?? '', /scope was modified/i);
    assert.equal(auditEvents('POLICY_DENIED_SCOPE_EXPANSION').length, 1);
    assert.equal(gateway.getApproval(approval.id)?.consumed ?? false, false);

    // The exact approved payload is still honoured exactly once.
    const original = gateway.evaluate({ operation: OPERATION, parameters: approved }, device, 'task-1', approval.id);
    assert.equal(original.allowed, true);
  });

  test('a rejected approval can never authorize execution', () => {
    const device = makeDevice('device-a');
    const parameters = { text: 'hello' };
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, parameters, RiskTier.HIGH);
    assert.equal(gateway.resolveApproval(approval.id, false, device.id).success, true);

    const result = gateway.evaluate({ operation: OPERATION, parameters }, device, 'task-1', approval.id);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /rejected/i);
    assert.equal(auditEvents('POLICY_DENIED_APPROVAL_UNUSABLE')[0].details.denialReason, 'REJECTED');

    // A rejection is final; it cannot be flipped to an approval afterwards.
    assert.equal(gateway.resolveApproval(approval.id, true, device.id).success, false);
  });

  test('an unresolved approval does not authorize execution', () => {
    const device = makeDevice('device-a');
    const parameters = { text: 'hello' };
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, parameters, RiskTier.HIGH);

    const result = gateway.evaluate({ operation: OPERATION, parameters }, device, 'task-1', approval.id);
    assert.equal(result.allowed, false);
    assert.equal(result.requiresApproval, true);
  });

  test('an unknown approval id is denied and audited with a bounded identifier', () => {
    const device = makeDevice('device-a');
    const hostileId = 'appr-' + 'x'.repeat(500);
    const result = gateway.evaluate({ operation: OPERATION, parameters: { text: 'hi' } }, device, 'task-1', hostileId);

    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /not found/i);
    const events = auditEvents('POLICY_DENIED_APPROVAL_NOT_FOUND');
    assert.equal(events.length, 1);
    assert.equal(String(events[0].details.approvalIdPrefix).length, 12);
  });

  test('an approval cannot be resolved twice', () => {
    const device = makeDevice('device-a');
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, { text: 'x' }, RiskTier.HIGH);
    assert.equal(gateway.resolveApproval(approval.id, true, device.id).success, true);
    const second = gateway.resolveApproval(approval.id, true, device.id);
    assert.equal(second.success, false);
    assert.match(second.error ?? '', /no longer pending/i);
  });

  test('a device without the required permission is denied even with an approved approval', () => {
    const limited = makeDevice('device-limited', [Permission.SYSTEM_INFO_READ]);
    const parameters = { text: 'hello' };
    const approval = gateway.createApprovalRequest('task-1', limited.id, OPERATION, parameters, RiskTier.HIGH);
    gateway.resolveApproval(approval.id, true, limited.id);

    const result = gateway.evaluate({ operation: OPERATION, parameters }, limited, 'task-1', approval.id);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /missing permission/i);
  });

  test('stale approval records are pruned and a pruned approval is still unusable', () => {
    const device = makeDevice('device-a');
    const parameters = { text: 'hello' };
    const approval = gateway.createApprovalRequest('task-1', device.id, OPERATION, parameters, RiskTier.HIGH, 60);
    gateway.resolveApproval(approval.id, true, device.id);

    // Recently expired records are retained so replays still get an accurate reason.
    skewMs = 10 * 60 * 1000;
    assert.equal(gateway.pruneApprovals(), 0);
    assert.ok(gateway.getApproval(approval.id));

    // Records expired for more than an hour are dropped.
    skewMs = 2 * 60 * 60 * 1000;
    assert.equal(gateway.pruneApprovals(), 1);
    assert.equal(gateway.getApproval(approval.id), undefined);

    const result = gateway.evaluate({ operation: OPERATION, parameters }, device, 'task-1', approval.id);
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /not found/i);
  });

  test('audit corruption makes policy denials fail closed instead of continuing silently', () => {
    const device = makeDevice('device-a');
    audit.record('SETUP_EVENT_ONE', { value: 1 });
    audit.record('SETUP_EVENT_TWO', { value: 2 });

    const records = audit.getRecords() as unknown as { details: Record<string, unknown> }[];
    records[0].details = { value: 'TAMPERED' };

    assert.throws(
      () => gateway.evaluate({ operation: 'cmd:exec_arbitrary', parameters: {} }, device, 'task-1'),
      /Audit log is unhealthy/,
    );
    assert.throws(
      () => gateway.createApprovalRequest('task-2', device.id, OPERATION, { text: 'x' }, RiskTier.HIGH),
      /Audit log is unhealthy/,
    );
  });
  test('AutomationId control actions are allowlisted but approvals remain bound to the exact selector', () => {
    const device = makeDevice('device-ui-automation');
    const operation = 'desktop:click_control';
    const parameters = { automationId: 'SaveButton', expectProcess: 'notepad' };
    const initial = gateway.evaluate({ operation, parameters }, device, 'task-ui-automation');
    assert.equal(initial.allowed, false);
    assert.equal(initial.requiresApproval, true);

    const approval = gateway.createApprovalRequest('task-ui-automation', device.id, operation, parameters, RiskTier.HIGH);
    assert.equal(gateway.resolveApproval(approval.id, true, device.id).success, true);

    const changedSelector = gateway.evaluate(
      { operation, parameters: { automationId: 'DeleteButton', expectProcess: 'notepad' } },
      device,
      'task-ui-automation',
      approval.id,
    );
    assert.equal(changedSelector.allowed, false);
    assert.match(changedSelector.reason || '', /scope was modified/i);

    const exactSelector = gateway.evaluate({ operation, parameters }, device, 'task-ui-automation', approval.id);
    assert.equal(exactSelector.allowed, true);
  });


});
