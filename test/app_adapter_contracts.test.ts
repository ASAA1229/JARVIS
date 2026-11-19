import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WindowsAppLauncherAdapter, discoveredLaunchResult, discoveredWindowIdentity, matchesExpectedAppWindow, selectUniqueExpectedAppWindow, type AllowlistedApp } from '../src/adapters/windowsAppLauncher.js';
import { buildAppCatalogue, detectContractDrift, type SupportedAppEntry } from '../src/capabilities/appCatalogue.js';
import { VerificationOutcome } from '../src/core/types.js';
import { AuditLogger } from '../src/audit/audit.js';
import { PolicyGateway } from '../src/policy/gateway.js';

/**
 * JARVIS-GAP-022: one generated adapter-contract suite per catalogued app. These tests drive the
 * pure identity/verification functions the adapter uses with synthetic windows; they do not launch
 * applications. Real per-app launch evidence on the MSI remains OWNER ACCEPTANCE PENDING.
 */
const allowlist = new WindowsAppLauncherAdapter().getAllowlist();
const catalogue = buildAppCatalogue(allowlist);
const dir = mkdtempSync(join(tmpdir(), 'jarvis-app-contract-'));
const policy = new PolicyGateway(new AuditLogger(join(dir, 'audit.log')), join(dir, 'grants.json'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

const contractOf = (entry: SupportedAppEntry) => entry.contract!;
const windowFor = (entry: SupportedAppEntry, pid = 100) => ({ pid, processName: contractOf(entry).processNames[0], title: `${contractOf(entry).titleContains ?? 'Some page'} - sample` });
const foreign = { pid: 999, processName: 'definitely-other-app', title: 'Unrelated window' };

test('catalogue covers the whole allowlist and every discovered-identity entry resolves to the adapter identity table', () => {
  assert.ok(catalogue.length >= 14);
  for (const entry of catalogue.filter((e) => e.adapter === 'discovered-start-menu' && e.verification === 'window-identity')) {
    const identity = entry.aliases.map((alias) => discoveredWindowIdentity(alias)).find(Boolean);
    assert.ok(identity, `${entry.id} has no adapter identity`);
    assert.deepEqual([...entry.contract!.processNames], identity.processNames, entry.id);
  }
});

for (const entry of catalogue) {
  test(`app contract: ${entry.name} (${entry.adapter})`, () => {
    // Policy: every listed operation exists and parameter keys the adapter uses are allowlisted.
    for (const operation of entry.operations) {
      const rule = policy.describeOperation(operation);
      assert.ok(rule, `${operation} must be a policy operation`);
      if (operation === 'app:launch') assert.equal(rule.requiresApproval, true, 'launching an app is approval-gated');
    }
    assert.ok(policy.describeOperation('app:launch', ['appId']), 'app:launch accepts appId');
    assert.equal(policy.describeOperation('app:launch', ['shellCommand']), undefined, 'unknown parameters are refused');
    if (entry.operations.includes('desktop:browser_search')) assert.ok(policy.describeOperation('desktop:browser_search', ['appId', 'query']));
    if (entry.operations.includes('desktop:type_text')) assert.ok(policy.describeOperation('desktop:type_text', ['text', 'expectProcess']));

    if (entry.verification === 'launch-only') {
      assert.equal(entry.contract, undefined);
      assert.equal(entry.uiAutomation, false);
      return;
    }
    const c = contractOf(entry);
    const good = windowFor(entry);
    // Identity matching accepts the real window and rejects an unrelated one.
    assert.equal(matchesExpectedAppWindow(good, { windowMatch: { processNames: [...c.processNames], titleContains: c.titleContains } }), true);
    assert.equal(matchesExpectedAppWindow(foreign, { windowMatch: { processNames: [...c.processNames], titleContains: c.titleContains } }), false);
    // Process-name case and .exe suffix are tolerated, titles are case-insensitive.
    assert.equal(matchesExpectedAppWindow({ ...good, processName: good.processName.toUpperCase() + '.exe', title: good.title.toUpperCase() }, { windowMatch: { processNames: [...c.processNames], titleContains: c.titleContains } }), true);
    // A right-process window with the wrong title is not identity (when a title constraint exists).
    if (c.titleContains) assert.equal(matchesExpectedAppWindow({ ...good, title: 'Something else entirely' }, { windowMatch: { processNames: [...c.processNames], titleContains: c.titleContains } }), false);
    // Unique-window selection: one match is focusable, two are ambiguous, none is absent.
    const spec = { windowMatch: { processNames: [...c.processNames], titleContains: c.titleContains } };
    assert.equal(selectUniqueExpectedAppWindow([good, foreign], spec).window?.pid, good.pid);
    const ambiguous = selectUniqueExpectedAppWindow([good, { ...good, pid: 101 }], spec);
    assert.equal(ambiguous.window, undefined);
    assert.equal(ambiguous.matchCount, 2);
    assert.equal(selectUniqueExpectedAppWindow([foreign], spec).matchCount, 0);
    // Drift detection agrees with matching.
    assert.equal(detectContractDrift(entry, good).status, 'matches');
    assert.equal(detectContractDrift(entry, foreign).status, 'drifted');
    // Discovered apps: launch outcome is VERIFIED only with an identity-matching new window.
    if (entry.adapter === 'discovered-start-menu') {
      const selected = { Name: entry.name, AppID: `${entry.id}!App` };
      assert.equal(discoveredLaunchResult(selected, good, { processNames: [...c.processNames], titleContains: c.titleContains }).outcome, VerificationOutcome.VERIFIED_SUCCESS);
      assert.equal(discoveredLaunchResult(selected, foreign, { processNames: [...c.processNames], titleContains: c.titleContains }).outcome, VerificationOutcome.PARTIAL_SUCCESS);
      assert.equal(discoveredLaunchResult(selected, undefined, { processNames: [...c.processNames], titleContains: c.titleContains }).outcome, VerificationOutcome.PARTIAL_SUCCESS);
      assert.equal(discoveredLaunchResult(selected, good, undefined).outcome, VerificationOutcome.PARTIAL_SUCCESS, 'no identity => never verified');
    }
  });
}

test('allowlisted launcher entries are internally consistent (id, executable, process and window identity)', () => {
  for (const app of allowlist as AllowlistedApp[]) {
    assert.match(app.id, /^[a-z0-9]+$/);
    assert.match(app.executable, /^[a-z0-9]+\.exe$/i);
    assert.ok(app.windowMatch && app.windowMatch.processNames.length > 0, `${app.id} needs a window identity`);
    assert.ok(app.windowMatch.titleContains, `${app.id} needs a title constraint`);
  }
});
