import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getCapability,
  listCapabilities,
  listCapabilitiesByStatus,
  listCapabilitiesForPlatform,
} from '../src/capabilities/registry.js';

test('capability catalogue uses unique stable identifiers', () => {
  const capabilities = listCapabilities();
  const ids = capabilities.map((capability) => capability.id);
  assert.ok(capabilities.length >= 15);
  assert.equal(new Set(ids).size, ids.length);
});

test('planned desktop automation is not represented as already implemented', () => {
  assert.equal(getCapability('desktop.ui-automation')?.status, 'planned');
  assert.equal(getCapability('desktop.text-and-clipboard')?.status, 'partial');
  assert.equal(getCapability('desktop.zoom-gesture')?.status, 'partial');
});

test('financial automation and voice-only unlock remain blocked', () => {
  for (const id of ['security.financial-app-automation', 'security.voice-only-unlock']) {
    const capability = getCapability(id);
    assert.equal(capability?.status, 'restricted');
    assert.equal(capability?.risk, 'blocked');
  }
});

test('platform query includes shared capabilities and excludes unrelated mobile-only capabilities', () => {
  const windowsIds = listCapabilitiesForPlatform('windows').map((capability) => capability.id);
  assert.ok(windowsIds.includes('memory.personal-context'));
  assert.ok(windowsIds.includes('desktop.app-launch'));
  assert.ok(!windowsIds.includes('ios.supported-integrations'));
});

test('status query provides an explicit implementation boundary', () => {
  assert.ok(listCapabilitiesByStatus('implemented').length >= 1);
  assert.ok(listCapabilitiesByStatus('planned').length >= 1);
  assert.ok(listCapabilitiesByStatus('restricted').length >= 2);
});
