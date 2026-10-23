import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { loadLocalEnvironmentFile, readRuntimeConfig } from '../src/config/runtimeConfig.js';

test('runtime config supplies the supported development defaults', () => {
  const config = readRuntimeConfig({});
  assert.equal(config.port, 3000);
  assert.equal(config.deviceStatePath, './data/devices.json');
  assert.equal(config.auditPath, './data/audit.log');
  assert.equal(config.ownerControlToken, undefined);
  assert.equal(config.ownerTokenStatus, 'missing');
});

test('runtime config validates port and non-empty persistence paths', () => {
  assert.equal(readRuntimeConfig({
    PORT: '4312',
    JARVIS_DEVICE_STATE_PATH: './data/state.json',
    JARVIS_AUDIT_PATH: './data/events.log',
  }).port, 4312);
  assert.throws(() => readRuntimeConfig({ PORT: '3000oops' }), /PORT must be an integer/);
  assert.throws(() => readRuntimeConfig({ PORT: '65536' }), /PORT must be an integer/);
  assert.throws(() => readRuntimeConfig({ JARVIS_AUDIT_PATH: '  ' }), /JARVIS_AUDIT_PATH must not be empty/);
});

test('owner enrollment rejects absent, placeholder, and weak tokens without exposing values', () => {
  assert.equal(readRuntimeConfig({}).ownerTokenStatus, 'missing');
  const placeholder = readRuntimeConfig({ JARVIS_OWNER_CONTROL_TOKEN: 'REPLACE_WITH_A_RANDOM_SECRET' });
  assert.equal(placeholder.ownerTokenStatus, 'placeholder');
  assert.equal(placeholder.ownerControlToken, undefined);
  assert.equal(readRuntimeConfig({ JARVIS_OWNER_CONTROL_TOKEN: 'too-short' }).ownerTokenStatus, 'invalid');

  const token = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const configured = readRuntimeConfig({ JARVIS_OWNER_CONTROL_TOKEN: token });
  assert.equal(configured.ownerTokenStatus, 'configured');
  assert.equal(configured.ownerControlToken, token);
});

test('Node dotenv loader reads an explicit local env file without printing its values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-env-test-'));
  const path = join(directory, 'test.env');
  const name = `JARVIS_CONFIG_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const previous = process.env[name];
  writeFileSync(path, `${name}=loaded-from-file\n`, 'utf8');

  try {
    delete process.env[name];
    assert.equal(loadLocalEnvironmentFile(path), true);
    assert.equal(process.env[name], 'loaded-from-file');
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dotenv file values do not override an existing process environment value', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-env-precedence-'));
  const path = join(directory, 'test.env');
  const name = `JARVIS_CONFIG_TEST_${randomUUID().replaceAll('-', '').toUpperCase()}`;
  const previous = process.env[name];
  writeFileSync(path, `${name}=file-value\n`, 'utf8');

  try {
    process.env[name] = 'process-value';
    loadLocalEnvironmentFile(path);
    assert.equal(process.env[name], 'process-value');
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('dotenv read errors are sanitized and do not include file contents', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-env-read-error-'));
  const nestedValue = 'VALUE_THAT_MUST_NOT_APPEAR_IN_ERRORS';
  writeFileSync(join(directory, 'contents.txt'), nestedValue, 'utf8');

  try {
    assert.throws(() => loadLocalEnvironmentFile(directory), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /Could not load/);
      assert.equal(error.message.includes(nestedValue), false);
      return true;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('owner token generator writes a secret without displaying it and preserves valid existing values', () => {
  const directory = mkdtempSync(join(tmpdir(), 'jarvis-owner-token-'));
  const envPath = join(directory, '.env');
  const scriptPath = join(process.cwd(), 'scripts', 'configure-owner-token.mjs');
  writeFileSync(envPath, 'JARVIS_OWNER_CONTROL_TOKEN=REPLACE_WITH_A_RANDOM_SECRET\n', 'utf8');

  try {
    const first = spawnSync(process.execPath, [scriptPath], { cwd: directory, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const saved = readFileSync(envPath, 'utf8');
    const token = saved.match(/^JARVIS_OWNER_CONTROL_TOKEN=([a-f0-9]{64})$/m)?.[1];
    assert.ok(token);
    assert.equal(first.stdout.includes(token), false);
    assert.equal(first.stderr.includes(token), false);

    const second = spawnSync(process.execPath, [scriptPath], { cwd: directory, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /already configured; no change made/i);
    assert.equal(readFileSync(envPath, 'utf8'), saved);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

