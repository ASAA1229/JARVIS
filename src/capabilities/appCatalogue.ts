/**
 * Supported-application catalogue (JARVIS-GAP-022).
 *
 * Derived from the launcher allowlist and the discovered-window identity table so the
 * catalogue can never claim an app the adapter does not actually recognise. It is
 * descriptive: it grants nothing and never bypasses PolicyGateway.
 *
 * Verification levels:
 *  - 'window-identity': a launch/focus is independently verified by matching the
 *    observed window's process (and title hint) to the contract below.
 *  - 'launch-only': the OS accepted the request; no independent identity is known,
 *    so the outcome is reported as PARTIAL, never verified.
 *
 * Drift detection compares a live observed window with the contract. A mismatch
 * (renamed process, changed title) downgrades trust instead of silently passing.
 */
import { discoveredWindowIdentity, type AllowlistedApp } from '../adapters/windowsAppLauncher.js';

export type AppAdapterKind = 'allowlisted-launch' | 'discovered-start-menu';
export type AppVerification = 'window-identity' | 'launch-only';

export interface AppContract {
  processNames: readonly string[];
  titleContains?: string;
}

export interface SupportedAppEntry {
  readonly id: string;
  readonly name: string;
  readonly aliases: readonly string[];
  readonly category: 'system-utility' | 'browser' | 'inbox-app';
  readonly adapter: AppAdapterKind;
  readonly verification: AppVerification;
  readonly contract?: AppContract;
  /** Policy operations that may target this app. All still require PolicyGateway approval rules. */
  readonly operations: readonly string[];
  /** UI automation (typing, controls) additionally requires a known process identity. */
  readonly uiAutomation: boolean;
}

const LAUNCH_OPERATIONS = ['app:launch'] as const;
const UI_OPERATIONS = ['app:launch', 'desktop:focus_window', 'desktop:inspect_window', 'desktop:type_text', 'desktop:hotkey'] as const;
const BROWSER_OPERATIONS = ['app:launch', 'desktop:focus_window', 'desktop:browser_search'] as const;

const INBOX_APPS: ReadonlyArray<{ name: string; aliases: string[]; category: SupportedAppEntry['category'] }> = [
  { name: 'Settings', aliases: ['settings', 'windows settings'], category: 'inbox-app' },
  { name: 'Microsoft Store', aliases: ['microsoft store', 'store'], category: 'inbox-app' },
  { name: 'Photos', aliases: ['photos'], category: 'inbox-app' },
  { name: 'Clock', aliases: ['clock'], category: 'inbox-app' },
  { name: 'Google Chrome', aliases: ['google chrome', 'chrome'], category: 'browser' },
  { name: 'Microsoft Edge', aliases: ['microsoft edge', 'edge'], category: 'browser' },
  { name: 'Mozilla Firefox', aliases: ['mozilla firefox', 'firefox'], category: 'browser' },
  { name: 'Brave Browser', aliases: ['brave browser', 'brave'], category: 'browser' },
  { name: 'Opera', aliases: ['opera'], category: 'browser' },
];

/** Builds the catalogue from the launcher allowlist plus the discovered-identity table. */
export function buildAppCatalogue(allowlist: readonly AllowlistedApp[]): SupportedAppEntry[] {
  const entries: SupportedAppEntry[] = [];
  for (const app of allowlist) {
    entries.push({
      id: app.id,
      name: app.name,
      aliases: [...new Set([app.id, app.name.toLowerCase()])],
      category: 'system-utility',
      adapter: 'allowlisted-launch',
      verification: app.windowMatch ? 'window-identity' : 'launch-only',
      ...(app.windowMatch ? { contract: { processNames: [...app.windowMatch.processNames], ...(app.windowMatch.titleContains ? { titleContains: app.windowMatch.titleContains } : {}) } } : {}),
      operations: app.windowMatch ? [...UI_OPERATIONS] : [...LAUNCH_OPERATIONS],
      uiAutomation: Boolean(app.windowMatch),
    });
  }
  for (const app of INBOX_APPS) {
    const identity = discoveredWindowIdentity(app.name) ?? app.aliases.map((alias) => discoveredWindowIdentity(alias)).find(Boolean);
    entries.push({
      id: app.aliases[app.aliases.length - 1].replace(/[^a-z0-9]+/g, '-'),
      name: app.name,
      aliases: app.aliases,
      category: app.category,
      adapter: 'discovered-start-menu',
      verification: identity ? 'window-identity' : 'launch-only',
      ...(identity ? { contract: { processNames: [...identity.processNames], ...(identity.titleContains ? { titleContains: identity.titleContains } : {}) } } : {}),
      operations: identity ? [...(app.category === 'browser' ? BROWSER_OPERATIONS : UI_OPERATIONS)] : [...LAUNCH_OPERATIONS],
      uiAutomation: Boolean(identity),
    });
  }
  return entries;
}

export function findApp(catalogue: readonly SupportedAppEntry[], query: string): SupportedAppEntry | undefined {
  const needle = String(query ?? '').trim().toLowerCase();
  return needle ? catalogue.find((entry) => entry.id === needle || entry.aliases.includes(needle)) : undefined;
}

export type DriftStatus = 'matches' | 'drifted' | 'no-contract';

/** Compare an observed window with the cataloged contract; any difference is drift. */
export function detectContractDrift(entry: SupportedAppEntry, observed: { processName: string; title: string }): { status: DriftStatus; reasons: string[] } {
  if (!entry.contract) return { status: 'no-contract', reasons: ['No independent identity is cataloged for this app.'] };
  const reasons: string[] = [];
  const process = observed.processName.toLowerCase().replace(/\.exe$/, '');
  if (!entry.contract.processNames.some((name) => name.toLowerCase().replace(/\.exe$/, '') === process)) {
    reasons.push(`Observed process "${observed.processName}" is not one of: ${entry.contract.processNames.join(', ')}.`);
  }
  if (entry.contract.titleContains && !observed.title.toLowerCase().includes(entry.contract.titleContains.toLowerCase())) {
    reasons.push(`Window title no longer contains "${entry.contract.titleContains}".`);
  }
  return { status: reasons.length ? 'drifted' : 'matches', reasons };
}

/** The outcome class an adapter may report for a launch of this app without independent evidence beyond the OS. */
export function maximumLaunchOutcome(entry: SupportedAppEntry | undefined): 'verified' | 'partial' {
  return entry?.verification === 'window-identity' ? 'verified' : 'partial';
}
