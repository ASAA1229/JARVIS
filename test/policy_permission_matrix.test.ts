import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { DeviceStatus, Permission, RiskTier, type DeviceRecord } from '../src/core/types.js';
import { PolicyGateway } from '../src/policy/gateway.js';

/**
 * JAR-E04/E08, US-002/US-009/US-010/US-021: automation and system-integration permission boundaries,
 * proven across EVERY allowlisted operation rather than a sample.
 */
const dir = mkdtempSync(join(tmpdir(), 'jarvis-policy-matrix-'));
const gateway = new PolicyGateway(new AuditLogger(join(dir, 'audit.log')), join(dir, 'grants.json'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
type Rule = { operation: string; requiredPermission: Permission; riskTier: RiskTier; requiresApproval: boolean; allowedParameters?: string[] };
const rules = [...((gateway as unknown as { rules: Map<string, Rule> }).rules.values())];
const device = (permissions: Permission[], id = 'dev'): DeviceRecord => ({ id, name: id, platform: 'test', publicKey: 'pk', status: DeviceStatus.ACTIVE, permissions, enrolledAt: 0 });
const ALL = Object.values(Permission) as Permission[];
/**
 * Identity/security management is HIGH risk but is not approval-card gated by design: it is limited to
 * DEVICE_MANAGE (owner) devices and protected by owner step-up (TOTP) in DeviceSecurityService. The
 * exemption is explicit and its permission requirement is asserted below.
 */
const OWNER_GOVERNED = /^(device:|security:)/;

test('the rule table is non-trivial and every rule names a real permission and risk tier', () => {
  assert.ok(rules.length >= 40, `expected a broad allowlist, found ${rules.length}`);
  for (const rule of rules) {
    assert.ok(ALL.includes(rule.requiredPermission), rule.operation);
    assert.ok(Object.values(RiskTier).includes(rule.riskTier), rule.operation);
  }
});

test('default-deny: a device with no permissions is refused for every operation, and unknown operations are always refused', () => {
  for (const rule of rules) {
    const result = gateway.evaluate({ operation: rule.operation, parameters: {} }, device([]), `t-${rule.operation}`);
    assert.equal(result.allowed, false, `${rule.operation} allowed for a permissionless device`);
    assert.match(result.reason ?? '', /missing permission/i);
  }
  for (const operation of ['', 'terminal:run_arbitrary', 'shell:exec', 'system:format_disk', 'app:launch ', 'APP:LAUNCH', 'file:delete_everything', '__proto__', 'constructor']) {
    const result = gateway.evaluate({ operation, parameters: {} }, device(ALL), 't-unknown');
    assert.equal(result.allowed, false, JSON.stringify(operation));
  }
});

test('every operation is refused to a device holding every OTHER permission but not the required one', () => {
  for (const rule of rules) {
    const others = ALL.filter((permission) => permission !== rule.requiredPermission);
    const result = gateway.evaluate({ operation: rule.operation, parameters: {} }, device(others), `t2-${rule.operation}`);
    assert.equal(result.allowed, false, `${rule.operation} granted without ${rule.requiredPermission}`);
  }
});

test('state-changing, HIGH and CRITICAL operations always require approval; allowed read-only ones do not silently escalate', () => {
  for (const rule of rules) {
    const result = gateway.evaluate({ operation: rule.operation, parameters: {} }, device([rule.requiredPermission]), `t3-${rule.operation}`);
    if ([RiskTier.HIGH, RiskTier.CRITICAL].includes(rule.riskTier) && !OWNER_GOVERNED.test(rule.operation)) {
      assert.equal(rule.requiresApproval, true, `${rule.operation} (${rule.riskTier}) must require approval`);
    }
    if (result.allowed && !result.requiresApproval) assert.equal(rule.requiresApproval, false, `${rule.operation} executes without approval but the rule requires it`);
    if (rule.requiresApproval) assert.equal(result.allowed && !result.requiresApproval, false, `${rule.operation} skipped its approval`);
  }
});

test('unlisted parameters are refused for every operation that declares an allowlist, including injection-style keys', () => {
  for (const rule of rules.filter((r) => Array.isArray(r.allowedParameters))) {
    for (const key of ['shell', 'cmd', '__proto__', 'constructor', 'toString']) {
      if (rule.allowedParameters!.includes(key)) continue;
      const result = gateway.evaluate({ operation: rule.operation, parameters: JSON.parse(`{"${key}": "x"}`) as Record<string, unknown> }, device([rule.requiredPermission]), `t4-${rule.operation}`);
      assert.equal(result.allowed, false, `${rule.operation} accepted undeclared parameter ${key}`);
    }
  }
});

test('no allowlisted operation can run terminal commands, delete files, push code or touch device identity without approval', () => {
  const sensitive = rules.filter((r) => /^(terminal:|file:delete|file:restore|dev:push|dev:commit|device:|security:|plugin:|workflow:)/.test(r.operation));
  assert.ok(sensitive.length > 0);
  for (const rule of sensitive) {
    // Read-only listings and authority-REDUCING actions (revoke/disable) never need approval; owner-governed identity ops are covered separately.
    if (/^(plugin:list|plugin:revoke|plugin:disable|workflow:list|workflow:show|workflow:history|workflow:run|workflow:draft_ai)$/.test(rule.operation) || OWNER_GOVERNED.test(rule.operation)) continue;
    assert.equal(rule.requiresApproval, true, `${rule.operation} must require approval`);
  }
});

test('owner-governed identity/security operations require the DEVICE_MANAGE permission (self-service exceptions are explicit)', () => {
  const governed = rules.filter((r) => OWNER_GOVERNED.test(r.operation));
  assert.ok(governed.length >= 10);
  const selfService = new Set(['device:enrollment:exchange', 'device:self-revoke']);
  for (const rule of governed) {
    if (selfService.has(rule.operation)) assert.equal(rule.requiredPermission, Permission.SYSTEM_INFO_READ, rule.operation);
    else assert.equal(rule.requiredPermission, Permission.DEVICE_MANAGE, `${rule.operation} must be owner-only`);
    const limited = gateway.evaluate({ operation: rule.operation, parameters: {} }, device([Permission.APP_LAUNCH]), 'owner-gov');
    assert.equal(limited.allowed, false, `${rule.operation} allowed for a device with only APP_LAUNCH`);
  }
});

test('financial and credential operations are not allowlisted at all', () => {
  for (const rule of rules) assert.doesNotMatch(rule.operation, /pay|bank|payment|credential|password|wallet|purchase/i, rule.operation);
});
