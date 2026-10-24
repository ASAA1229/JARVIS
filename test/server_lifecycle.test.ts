import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';

test('SERVER-01: Startup rejects when the requested port is already occupied', async () => {
  const directory = mkdtempSync('./data/test-server-lifecycle-');
  const blocker = createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });

  const address = blocker.address();
  assert.ok(address && typeof address !== 'string');
  const server = new JarvisServer(address.port, join(directory, 'audit.log'));

  try {
    await assert.rejects(server.start(), /EADDRINUSE/);
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => error ? reject(error) : resolve());
    });
    rmSync(directory, { recursive: true, force: true });
  }
});

test('SERVER-02: Stop is safe before startup and after the server has stopped', async () => {
  const directory = mkdtempSync('./data/test-server-lifecycle-');
  const server = new JarvisServer(0, join(directory, 'audit.log'));

  try {
    await server.stop();
    await server.start();
    await server.stop();
    await server.stop();
  } finally {
    await server.stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
