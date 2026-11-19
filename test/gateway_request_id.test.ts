import { afterEach, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditLogger } from '../src/audit/audit.js';
import { REQUEST_ID_PATTERN, SiteAiGateway, resolveRequestId, type ModelEndpoint } from '../src/gateway/siteAiGateway.js';
import { SiteClientStore } from '../src/gateway/siteClientStore.js';

const endpoint: ModelEndpoint = { baseUrl: 'http://model.test/v1', model: 'local-test-model' };

describe('site AI gateway X-Request-ID correlation (ASAA ecosystem contract v1)', () => {
  let dir: string;
  let gateway: SiteAiGateway;
  let base: string;
  let key: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'jarvis-gateway-reqid-'));
    const store = new SiteClientStore(join(dir, 'site-clients.json'));
    key = store.create('portfolio', { requestsPerMinute: 50, maxOutputTokens: 300 }).apiKey;
    // Mock upstream model: no network.
    const fakeFetch = (async () => Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })) as typeof fetch;
    gateway = new SiteAiGateway({ store, audit: new AuditLogger(join(dir, 'audit.log')), modelEndpoint: () => endpoint, fetchImpl: fakeFetch });
    base = `http://127.0.0.1:${await gateway.start(0)}`;
  });

  afterEach(async () => {
    await gateway.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  const chat = (headers: Record<string, string> = {}, token: string | null = key) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  const auditRecords = () => readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { eventType: string; details: Record<string, unknown> });

  test('a valid incoming X-Request-ID is echoed and recorded in the metadata-only audit entry', async () => {
    const response = await chat({ 'X-Request-ID': 'corr-1234.abcd_EF' });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-request-id'), 'corr-1234.abcd_EF');
    const record = auditRecords().filter((entry) => entry.eventType === 'SITE_AI_REQUEST').pop();
    assert.equal(record?.details.requestId, 'corr-1234.abcd_EF');
    assert.equal(JSON.stringify(record).includes('"hi"'), false, 'audit stays metadata-only');
  });

  test('a missing or invalid X-Request-ID is replaced by a generated one', async () => {
    const missing = await chat();
    const generated = missing.headers.get('x-request-id');
    assert.match(generated ?? '', REQUEST_ID_PATTERN);
    for (const bad of ['short', 'has space in it!', 'x'.repeat(65), 'bad/slash/chars']) {
      const response = await chat({ 'X-Request-ID': bad });
      const echoed = response.headers.get('x-request-id');
      assert.notEqual(echoed, bad, bad);
      assert.match(echoed ?? '', REQUEST_ID_PATTERN);
    }
    assert.notEqual((await chat()).headers.get('x-request-id'), generated, 'generated ids are unique');
  });

  test('health, auth failures and errors also echo the id; auth failures are audited with it', async () => {
    assert.equal((await fetch(`${base}/v1/health`, { headers: { 'X-Request-ID': 'health-check-0001' } })).headers.get('x-request-id'), 'health-check-0001');
    const denied = await chat({ 'X-Request-ID': 'denied-request-01' }, null);
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get('x-request-id'), 'denied-request-01');
    const failure = auditRecords().filter((entry) => entry.eventType === 'SITE_AI_AUTH_FAILED').pop();
    assert.equal(failure?.details.requestId, 'denied-request-01');
    assert.equal((await fetch(`${base}/v1/nope`, { headers: { 'X-Request-ID': 'notfound-req-001' } })).headers.get('x-request-id'), 'notfound-req-001');
  });

  test('resolveRequestId rejects arrays and non-matching values', () => {
    assert.equal(resolveRequestId('valid-id-0001'), 'valid-id-0001');
    assert.notEqual(resolveRequestId(['valid-id-0001', 'x']), 'valid-id-0001');
    assert.match(resolveRequestId(undefined), REQUEST_ID_PATTERN);
  });
});
