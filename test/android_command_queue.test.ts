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
