import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROFILE_LIMITS, ResourceManager, selectProfile, type ResourceReadings } from '../src/resources/resourceManager.js';

const base: ResourceReadings = { cpuPercent: 20, freeMemPercent: 50, freeMemMB: 8000, totalMemMB: 16000, battery: { percent: 90, charging: true }, sampledAt: 0 };

test('automatic profile selection protects battery and busy machines', () => {
  assert.equal(selectProfile(base).profile, 'intensive');
  assert.equal(selectProfile({ ...base, battery: { percent: 20, charging: false } }).profile, 'idle');
  assert.equal(selectProfile({ ...base, cpuPercent: 90 }).profile, 'idle');
  assert.equal(selectProfile({ ...base, freeMemPercent: 5 }).profile, 'idle');
  assert.equal(selectProfile({ ...base, battery: { percent: 80, charging: false } }).profile, 'normal');
  assert.equal(selectProfile({ ...base, cpuPercent: 60 }).profile, 'normal');
});

test('owner can pin a profile and limits follow it', () => {
  const manager = new ResourceManager(async () => null);
  manager.setMode('idle');
  assert.deepEqual(manager.current(), { mode: 'idle', profile: 'idle', reason: 'pinned by the owner' });
  assert.deepEqual(manager.limits(), PROFILE_LIMITS.idle);
  assert.equal(manager.limits().recurringJobsAllowed, false);
  assert.throws(() => manager.setMode('turbo' as never), /Unknown resource profile/);
});

test('heavy work is visible and can be stopped individually or all at once', () => {
  const manager = new ResourceManager(async () => null);
  let cancelled = 0;
  const first = manager.registerHeavyWork('model_inference', 'site AI request', () => { cancelled += 1; });
  manager.registerHeavyWork('indexing', 'memory index', () => { cancelled += 1; });
  assert.equal(manager.listHeavyWork().length, 2);
  assert.equal(manager.stopHeavyWork(first.id), 1);
  assert.equal(manager.stopHeavyWork(), 1);
  assert.equal(cancelled, 2);
  assert.equal(manager.listHeavyWork().length, 0);
});

test('sampling never throws when the battery reader fails', async () => {
  const manager = new ResourceManager(async () => { throw new Error('no battery'); });
  const readings = await manager.sample();
  assert.equal(readings.battery, null);
  assert.ok(readings.totalMemMB > 0);
});
