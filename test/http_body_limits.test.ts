import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JarvisServer } from '../src/server/server.js';

test('HTTP JSON body validation rejects wrong content type, malformed JSON, and oversized payloads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-http-body-'));
  const probe = createNetServer();
  let server: JarvisServer | undefined;
  try {
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
    server = new JarvisServer(port, join(dir, 'audit.log'), join(dir, 'devices.json'));
    await server.start();

    const wrongType = await fetch(`http://127.0.0.1:${port}/api/enrollment/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{"text":"hello"}',
    });
    assert.equal(wrongType.status, 415);
    assert.equal((await wrongType.json() as { error: string }).error, 'Content-Type must be application/json');

    const malformed = await fetch(`http://127.0.0.1:${port}/api/enrollment/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"text":',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json() as { error: string }).error, 'Invalid JSON payload');

    const oversized = await fetch(`http://127.0.0.1:${port}/api/enrollment/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'x'.repeat(70 * 1024) }),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json() as { error: string }).error, 'Payload too large');
  } finally {
    if (server) await server.stop();
    else if (probe.listening) await new Promise<void>((resolve) => probe.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
