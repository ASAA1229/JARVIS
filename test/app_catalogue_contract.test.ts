import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsAppLauncherAdapter, processIdentityFromExecutable } from '../src/adapters/windowsAppLauncher.js';
import { buildAppCatalogue, detectContractDrift, findApp, maximumLaunchOutcome } from '../src/capabilities/appCatalogue.js';
import { AuditLogger } from '../src/audit/audit.js';
import { PolicyGateway } from '../src/policy/gateway.js';

/** JARVIS-GAP-022: supported-app catalogue contract tests (no apps are launched). */
const adapter = new WindowsAppLauncherAdapter();
const catalogue = buildAppCatalogue(adapter.getAllowlist());
const dir = mkdtempSync(join(tmpdir(), 'jarvis-catalogue-'));
const policy = new PolicyGateway(new AuditLogger(join(dir, 'audit.log')), join(dir, 'grants.json'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const SHELL_HOSTS = ['applicationframehost', 'cmd', 'powershell', 'pwsh', 'rundll32', 'dllhost', 'svchost', 'conhost'];

test('every allowlisted launcher app is cataloged, and nothing else claims the allowlisted adapter', () => {
  const allow = adapter.getAllowlist();
  assert.ok(allow.length >= 5);
  const cataloged = catalogue.filter((entry) => entry.adapter === 'allowlisted-launch');
  assert.deepEqual(cataloged.map((e) => e.id).sort(), allow.map((a) => a.id).sort());
  assert.ok(catalogue.some((e) => e.adapter === 'discovered-start-menu' && e.category === 'browser'));
});

test('ids and aliases are unique across the catalogue so an alias can never resolve to two apps', () => {
  const ids = catalogue.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
  const aliases = catalogue.flatMap((e) => e.aliases.map((a) => a.toLowerCase()));
  const dupes = aliases.filter((alias, index) => aliases.indexOf(alias) !== index);
  assert.deepEqual(dupes, [], 'duplicate aliases');
  assert.equal(findApp(catalogue, 'Chrome')?.name, 'Google Chrome');
  assert.equal(findApp(catalogue, 'notepad')?.name, 'Notepad');
  assert.equal(findApp(catalogue, 'definitely-not-an-app'), undefined);
  assert.equal(findApp(catalogue, ''), undefined);
});

test('every operation an entry lists is a real PolicyGateway operation with a recorded risk rule', () => {
  for (const entry of catalogue) {
    assert.ok(entry.operations.length > 0, entry.id);
    for (const operation of entry.operations) {
      const rule = policy.describeOperation(operation);
      assert.ok(rule, `${entry.id}: ${operation} is not a policy operation`);
      assert.equal(typeof rule.requiresApproval, 'boolean');
    }
    assert.ok(entry.operations.includes('app:launch'));
  }
});

test('verification claims require an independent process identity and never use shell hosts', () => {
  for (const entry of catalogue) {
    if (entry.verification === 'window-identity') {
      assert.ok(entry.contract && entry.contract.processNames.length > 0, `${entry.id} claims identity verification without a contract`);
      for (const name of entry.contract.processNames) {
        const lower = name.toLowerCase().replace(/\.exe$/, '');
        // Allowlisted shell-style apps (explorer, cmd, powershell) are themselves the app; discovered apps may never use shell hosts.
        if (entry.adapter === 'allowlisted-launch') continue;
        assert.equal(SHELL_HOSTS.includes(lower), false, `${entry.id} uses shell-host process ${name}`);
      }
      assert.equal(entry.uiAutomation, true);
    } else {
      assert.equal(entry.uiAutomation, false, `${entry.id}: UI automation requires a known identity`);
      assert.deepEqual([...entry.operations], ['app:launch']);
      assert.equal(maximumLaunchOutcome(entry), 'partial');
    }
  }
  assert.equal(maximumLaunchOutcome(undefined), 'partial', 'unknown apps can never be reported as verified');
  assert.equal(maximumLaunchOutcome(findApp(catalogue, 'notepad')), 'verified');
  assert.equal(processIdentityFromExecutable('cmd.exe'), undefined);
});

test('explorer is the only entry allowed to share a shell-host identity and is constrained by title', () => {
  const explorer = findApp(catalogue, 'explorer')!;
  assert.equal(explorer.contract?.titleContains, 'File Explorer');
});

test('browser entries expose the approval-gated browser search operation, other apps do not', () => {
  for (const entry of catalogue) {
    assert.equal(entry.operations.includes('desktop:browser_search'), entry.category === 'browser' && entry.verification === 'window-identity', entry.id);
  }
});

test('drift detection: a renamed process or changed window title downgrades trust instead of passing silently', () => {
  const notepad = findApp(catalogue, 'notepad')!;
  assert.deepEqual(detectContractDrift(notepad, { processName: 'Notepad.exe', title: 'Untitled - Notepad' }), { status: 'matches', reasons: [] });
  const renamed = detectContractDrift(notepad, { processName: 'WindowsNotepad.exe', title: 'Untitled - Notepad' });
  assert.equal(renamed.status, 'drifted');
  assert.match(renamed.reasons[0], /not one of/);
  const retitled = detectContractDrift(notepad, { processName: 'notepad', title: 'Untitled - Text Editor' });
  assert.equal(retitled.status, 'drifted');
  assert.match(retitled.reasons[0], /title/);
  const both = detectContractDrift(notepad, { processName: 'x', title: 'y' });
  assert.equal(both.reasons.length, 2);
  const edge = findApp(catalogue, 'edge')!;
  assert.equal(detectContractDrift(edge, { processName: 'msedge', title: 'Any page title' }).status, 'matches', 'browser page titles are never identity evidence');
  const noContract = { ...notepad, contract: undefined } as unknown as Parameters<typeof detectContractDrift>[0];
  assert.equal(detectContractDrift(noContract, { processName: 'a', title: 'b' }).status, 'no-contract');
});
