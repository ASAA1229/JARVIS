import test from 'node:test';
import assert from 'node:assert/strict';
import { containsSecret, redactSecrets } from '../src/developer/secrets.js';

test('redacts private keys and common provider credentials', () => {
  const input = [
    '-----BEGIN PRIVATE KEY-----\nprivate-material\n-----END PRIVATE KEY-----',
    'sk-proj-1234567890abcdefghijklmnop',
    'ghp_abcdefghijklmnopqrstuvwxyz1234567890',
    'github_pat_abcdefghijklmnopqrstuvwxyz12345678901234567890',
    'xoxb-1234567890-abcdefghijkl',
    'AKIA1234567890ABCDEF',
    'AIza12345678901234567890123456789012345',
    'eyJabcdefghijk.abcdefghijk.abcdefghijk',
  ].join('\n');
  const output = redactSecrets(input);
  assert.doesNotMatch(output, /private-material|sk-proj-|ghp_|github_pat_|xoxb-|AKIA[0-9A-Z]{16}|AIza|eyJabcdefghijk/);
  assert.match(output, /REDACTED PRIVATE KEY/);
  assert.match(output, /REDACTED API KEY/);
  assert.match(output, /REDACTED GITHUB TOKEN/);
});

test('redacts secret-looking key/value assignments without exposing values', () => {
  const output = redactSecrets('OPENAI_API_KEY=super-secret-value\nclient_secret: another-secret-value');
  assert.doesNotMatch(output, /super-secret-value|another-secret-value/);
  assert.match(output, /OPENAI_API_KEY=\[REDACTED\]/);
  assert.match(output, /client_secret: \[REDACTED\]/);
});

test('containsSecret agrees with redaction and leaves ordinary text unchanged', () => {
  assert.equal(containsSecret('token=abcdef123456'), true);
  assert.equal(containsSecret('ordinary project status'), false);
  assert.equal(redactSecrets('ordinary project status'), 'ordinary project status');
});

test('redaction is safe for empty and non-string inputs', () => {
  assert.equal(redactSecrets(''), '');
  assert.equal(containsSecret(''), false);
  assert.equal(redactSecrets(null as unknown as string), '');
});
