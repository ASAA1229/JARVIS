import test from 'node:test';
import assert from 'node:assert/strict';
import { AndroidCommandQueue } from '../src/android/commandQueue.js';

test('Android inventory command is scoped to target, claimed once, and completed once', () => {
  const queue = new AndroidCommandQueue();
  const command = queue.create('phone-a', 'owner');
  assert.equal(command.operation, 'android.app.list');
  assert.equal(queue.claimNext('phone-b'), undefined);
  assert.equal(queue.claimNext('phone-a')?.id, command.id);
  assert.equal(queue.claimNext('phone-a'), undefined);
  assert.equal(queue.complete('phone-b', command.id, []), false);
  assert.equal(queue.complete('phone-a', command.id, [{ label: 'Settings', packageName: 'com.android.settings' }]), true);
  assert.equal(queue.complete('phone-a', command.id, []), false);
  assert.deepEqual(queue.resultsForRequester('owner')[0].apps, [{ label: 'Settings', packageName: 'com.android.settings' }]);
  assert.equal(queue.resultsForRequester('other').length, 0);
});

test('Android inventory command rejects same-device targeting and expires', async () => {
  const queue = new AndroidCommandQueue();
  assert.throws(() => queue.create('same', 'same'));
  const command = queue.create('phone-a', 'owner', 1000);
  await new Promise((resolve) => setTimeout(resolve, 1050));
  assert.equal(queue.claimNext('phone-a'), undefined);
  assert.equal(queue.complete('phone-a', command.id, []), false);
});

test('Android command queue clamps invalid TTLs and rejects malformed device IDs', () => {
  const queue = new AndroidCommandQueue();
  const command = queue.create('phone-a', 'owner', Number.NaN);
  assert.equal(command.expiresAt - command.createdAt, 60_000);
  assert.throws(() => queue.create(' phone-a', 'owner'));
  assert.throws(() => queue.create('phone-a', 'owner\n'));
  assert.equal(queue.claimNext(' phone-a'), undefined);
  assert.deepEqual(queue.resultsForRequester(' owner'), []);
});

test('invalid app inventory cannot complete a claimed command or poison its result', () => {
  const queue = new AndroidCommandQueue();
  const command = queue.create('phone-a', 'owner');
  queue.claimNext('phone-a');
  assert.equal(queue.complete('phone-a', command.id, [{ label: '  ', packageName: 'com.example.app' }]), false);
  assert.equal(queue.complete('phone-a', command.id, [{ label: 'Settings\nsecret', packageName: 'com.example.app' }]), false);
  assert.equal(queue.complete('phone-a', command.id, [{ label: 'Settings', packageName: 'com.example.app' }, null] as never), false);
  assert.equal(queue.resultsForRequester('owner')[0].state, 'CLAIMED');
  assert.equal(queue.complete('phone-a', command.id, [{ label: ' Settings ', packageName: 'com.example.app ' }]), true);
  assert.deepEqual(queue.resultsForRequester('owner')[0].apps, [{ label: 'Settings', packageName: 'com.example.app' }]);
});

test('inventory results are defensive copies and excessive app lists are rejected', () => {
  const queue = new AndroidCommandQueue();
  const command = queue.create('phone-a', 'owner');
  queue.claimNext('phone-a');
  const apps = Array.from({ length: 301 }, (_, index) => ({ label: 'App ' + index, packageName: 'com.example.app' }));
  assert.equal(queue.complete('phone-a', command.id, apps), false);
  assert.equal(queue.complete('phone-a', command.id, [{ label: 'Settings', packageName: 'com.android.settings' }]), true);
  const result = queue.resultsForRequester('owner');
  result[0].apps![0].label = 'tampered';
  assert.equal(queue.resultsForRequester('owner')[0].apps![0].label, 'Settings');
});
