import assert from 'node:assert/strict';
import test from 'node:test';
import { buildControlActionScript } from '../src/adapters/windowsDesktopAgent.js';

test('desktop:click_control validates and indexes the same UI Automation collection', () => {
  const script = buildControlActionScript('desktop:click_control', 'Save');

  assert.match(script, /\$foundControls = \$root\.FindAll/);
  assert.match(script, /if \(\$foundControls\.Count -ne 1\)/);
  assert.match(script, /\$element = \$foundControls\.Item\(0\)/);
  assert.doesNotMatch(script, /if \(\$matches\.Count/);
});

test('desktop:set_value validates and indexes the same UI Automation collection', () => {
  const script = buildControlActionScript('desktop:set_value', 'Title', 'JARVIS');

  assert.match(script, /\$matches = \$root\.FindAll/);
  assert.match(script, /if \(\$matches\.Count -ne 1\)/);
  assert.match(script, /\$element = \$matches\.Item\(0\)/);
  assert.doesNotMatch(script, /if \(\$foundControls\.Count/);
});

test('UI Automation control scripts escape PowerShell single-quoted values', () => {
  const clickScript = buildControlActionScript('desktop:click_control', "O'Brien");
  const valueScript = buildControlActionScript('desktop:set_value', "O'Brien", "It's JARVIS");

  assert.ok(clickScript.includes("NameProperty, 'O''Brien'"));
  assert.ok(valueScript.includes("NameProperty, 'O''Brien'"));
  assert.ok(valueScript.includes("$pattern.SetValue('It''s JARVIS')"));
  assert.ok(valueScript.includes("$actual -cne 'It''s JARVIS'"));
});
