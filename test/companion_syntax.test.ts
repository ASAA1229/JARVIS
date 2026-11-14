import { test } from 'node:test';
import assert from 'node:assert';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Browser companion scripts are served as-is (no bundler). A single syntax error
// — such as a duplicated const declaration — prevents the entire HUD from running,
// so every served script must parse. `node --check` covers classic and module scripts.
test('companion browser scripts parse without syntax errors', () => {
  const dir = 'src/companion';
  const scripts = readdirSync(dir).filter((name) => name.endsWith('.js'));
  assert.ok(scripts.includes('hud.js'));
  for (const name of scripts) {
    const result = spawnSync(process.execPath, ['--check', join(dir, name)], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, `${name} must parse:\n${result.stderr}`);
  }
});
