/**
 * Permissioned plugins (JARVIS-US-062).
 *
 * A plugin is a *data-only* capability bundle: a manifest declaring identity,
 * version, compatibility, the catalogue capabilities it relates to, the
 * operations it requests permission to use, and optional workflow templates
 * built from those operations. Plugins never ship executable code and never
 * reach a shell; every step still runs through the planner allowlist, the
 * PolicyGateway and per-step approvals.
 *
 * Lifecycle: install (owner approval) -> disabled, no grants -> grant a subset of
 * requested permissions (owner approval) -> enable (owner approval). Disable and
 * revoke are always allowed. Unknown or over-scoped manifests fail closed.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname } from 'node:path';

export const JARVIS_VERSION = '0.1.0';

export interface PluginWorkflowStep {
  id: string;
  operation: string;
  parameters: Record<string, unknown>;
  dependsOn: string[];
}

export interface PluginWorkflowTemplate {
  name: string;
  description: string;
  steps: PluginWorkflowStep[];
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  publisher: string;
  description: string;
  compatibility: { minJarvisVersion: string };
  capabilities: string[];
  permissions: string[];
  workflows?: PluginWorkflowTemplate[];
}

export interface InstalledPlugin {
  manifest: PluginManifest;
  enabled: boolean;
  /** Subset of manifest.permissions the owner approved. */
  grants: string[];
  installedAt: number;
  updatedAt: number;
}

export interface PluginEnvironment {
  /** True when an operation exists in the planner and policy allowlists with these parameter keys. */
  isOperationAllowed(operation: string, parameterKeys: string[]): boolean;
  /** True when a capability id exists in the trusted catalogue and is not restricted. */
  isKnownCapability(capabilityId: string): boolean;
}

/** Operations a plugin may never request: security, identity, memory deletion, raw execution, self-extension. */
const FORBIDDEN_PERMISSION = /^(?:device:|security:|plugin:|workflow:|memory:delete|memory:update|terminal:|file:delete|file:restore|dev:push|dev:commit|dev:repo_connect|comms:handoff_email)/;
const ID_PATTERN = /^[a-z0-9][a-z0-9.-]{2,60}$/;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/;
const MAX_MANIFEST_BYTES = 64 * 1024;

function compareSemver(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return NaN;
  for (let i = 1; i <= 3; i++) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff;
  }
  return 0;
}

function isText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

/** Validate a manifest against the trusted catalogue and policy; returns problems (empty = valid). */
export function validatePluginManifest(value: unknown, env: PluginEnvironment): { manifest?: PluginManifest; problems: string[] } {
  const problems: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { problems: ['Manifest must be a JSON object.'] };
  const m = value as Record<string, unknown>;
  const allowedKeys = new Set(['id', 'name', 'version', 'publisher', 'description', 'compatibility', 'capabilities', 'permissions', 'workflows']);
  for (const key of Object.keys(m)) if (!allowedKeys.has(key)) problems.push(`Unknown manifest field: ${key}.`);
  if (typeof m.id !== 'string' || !ID_PATTERN.test(m.id)) problems.push('id must be 3-61 lowercase letters, digits, dots or hyphens.');
  if (!isText(m.name, 80)) problems.push('name is required (max 80 chars).');
  if (typeof m.version !== 'string' || !SEMVER.test(m.version)) problems.push('version must be semver (x.y.z).');
  if (!isText(m.publisher, 80)) problems.push('publisher is required (max 80 chars).');
  if (!isText(m.description, 500)) problems.push('description is required (max 500 chars).');
  const compatibility = m.compatibility as { minJarvisVersion?: unknown } | undefined;
  if (!compatibility || typeof compatibility.minJarvisVersion !== 'string' || !SEMVER.test(compatibility.minJarvisVersion)) {
    problems.push('compatibility.minJarvisVersion must be semver.');
  } else if (compareSemver(compatibility.minJarvisVersion, JARVIS_VERSION) > 0) {
    problems.push(`Plugin requires JARVIS ${compatibility.minJarvisVersion} or newer (this is ${JARVIS_VERSION}).`);
  }
  const capabilities = Array.isArray(m.capabilities) ? m.capabilities : null;
  if (!capabilities || capabilities.length > 20) problems.push('capabilities must be an array of at most 20 ids.');
  else for (const capability of capabilities) {
    if (typeof capability !== 'string' || !env.isKnownCapability(capability)) problems.push(`Unknown or restricted capability: ${String(capability)}.`);
  }
  const permissions = Array.isArray(m.permissions) ? m.permissions : null;
  if (!permissions || permissions.length === 0 || permissions.length > 30) problems.push('permissions must list 1-30 operation ids.');
  else {
    const seen = new Set<string>();
    for (const permission of permissions) {
      if (typeof permission !== 'string' || seen.has(permission)) { problems.push(`Invalid or duplicate permission: ${String(permission)}.`); continue; }
      seen.add(permission);
      if (FORBIDDEN_PERMISSION.test(permission)) problems.push(`Permission is over-scoped and never grantable to plugins: ${permission}.`);
      else if (!env.isOperationAllowed(permission, [])) problems.push(`Permission is not a known allowlisted operation: ${permission}.`);
    }
  }
  if (m.workflows !== undefined) {
    if (!Array.isArray(m.workflows) || m.workflows.length > 10) problems.push('workflows must be an array of at most 10 templates.');
    else for (const raw of m.workflows) {
      const workflow = raw as Record<string, unknown>;
      if (!workflow || typeof workflow.name !== 'string' || !NAME_PATTERN.test(workflow.name)) { problems.push('Each workflow needs a lowercase slug name.'); continue; }
      if (!isText(workflow.description, 300)) problems.push(`Workflow ${workflow.name} needs a description.`);
      if (!Array.isArray(workflow.steps) || workflow.steps.length === 0 || workflow.steps.length > 20) { problems.push(`Workflow ${workflow.name} needs 1-20 steps.`); continue; }
      for (const rawStep of workflow.steps) {
        const step = rawStep as Record<string, unknown>;
        const operation = String(step?.operation ?? '');
        const parameters = step?.parameters && typeof step.parameters === 'object' && !Array.isArray(step.parameters) ? step.parameters as Record<string, unknown> : null;
        if (!parameters) { problems.push(`Workflow ${workflow.name} step ${String(step?.id)} needs a parameters object.`); continue; }
        if (!permissions?.includes(operation)) problems.push(`Workflow ${workflow.name} uses ${operation}, which the plugin does not request.`);
        else if (!env.isOperationAllowed(operation, Object.keys(parameters))) problems.push(`Workflow ${workflow.name} step ${String(step?.id)} has parameters outside the policy allowlist.`);
      }
    }
  }
  if (problems.length) return { problems };
  return { manifest: value as PluginManifest, problems };
}

interface PluginStateFile {
  version: 1;
  plugins: InstalledPlugin[];
}

export class PluginRegistry {
  private plugins = new Map<string, InstalledPlugin>();

  constructor(private readonly statePath: string, private readonly env: PluginEnvironment) {
    this.load();
  }

  private load(): void {
    if (!existsSync(this.statePath)) return;
    const parsed = JSON.parse(readFileSync(this.statePath, 'utf8')) as PluginStateFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) throw new Error('Plugin state file is invalid; refusing to load plugins.');
    for (const plugin of parsed.plugins) {
      // Re-validate on every load: catalogue or policy changes can make an installed plugin over-scoped.
      const { manifest, problems } = validatePluginManifest(plugin.manifest, this.env);
      if (!manifest) {
        this.plugins.set(plugin.manifest.id, { ...plugin, enabled: false, grants: [] });
        continue;
      }
      this.plugins.set(manifest.id, { ...plugin, grants: plugin.grants.filter((grant) => manifest.permissions.includes(grant)) });
      void problems;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, plugins: [...this.plugins.values()] } satisfies PluginStateFile, null, 2), { mode: 0o600 });
    renameSync(temporary, this.statePath);
  }

  /** Read and validate a manifest file from a local path (JSON only, bounded size). */
  readManifestFile(path: string): PluginManifest {
    if (typeof path !== 'string' || !path.trim() || extname(path).toLowerCase() !== '.json') {
      throw new Error('Plugin manifests must be local .json files.');
    }
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error('Plugin manifest must be a regular file under 64 KiB.');
    let parsed: unknown;
    try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new Error('Plugin manifest is not valid JSON.'); }
    const { manifest, problems } = validatePluginManifest(parsed, this.env);
    if (!manifest) throw new Error('Plugin manifest rejected: ' + problems.slice(0, 5).join(' '));
    return manifest;
  }

  install(manifest: PluginManifest): InstalledPlugin {
    const existing = this.plugins.get(manifest.id);
    if (existing) {
      const order = compareSemver(manifest.version, existing.manifest.version);
      if (!(order > 0)) throw new Error(`Plugin ${manifest.id} ${existing.manifest.version} is already installed; only a newer version can replace it.`);
    }
    const now = Date.now();
    // An upgrade keeps only grants still requested and starts disabled for re-review.
    const plugin: InstalledPlugin = {
      manifest,
      enabled: false,
      grants: existing ? existing.grants.filter((grant) => manifest.permissions.includes(grant)) : [],
      installedAt: existing?.installedAt ?? now,
      updatedAt: now,
    };
    this.plugins.set(manifest.id, plugin);
    this.persist();
    return structuredClone(plugin);
  }

  uninstall(id: string): boolean {
    const removed = this.plugins.delete(id);
    if (removed) this.persist();
    return removed;
  }

  private require(id: string): InstalledPlugin {
    const plugin = this.plugins.get(id);
    if (!plugin) throw new Error(`Plugin ${id} is not installed.`);
    return plugin;
  }

  grant(id: string, permissions: string[]): InstalledPlugin {
    const plugin = this.require(id);
    for (const permission of permissions) {
      if (!plugin.manifest.permissions.includes(permission)) throw new Error(`Plugin ${id} did not request ${permission}; it cannot be granted.`);
      if (FORBIDDEN_PERMISSION.test(permission) || !this.env.isOperationAllowed(permission, [])) throw new Error(`${permission} is not grantable.`);
    }
    plugin.grants = [...new Set([...plugin.grants, ...permissions])];
    plugin.updatedAt = Date.now();
    this.persist();
    return structuredClone(plugin);
  }

  revoke(id: string, permissions: string[]): InstalledPlugin {
    const plugin = this.require(id);
    plugin.grants = plugin.grants.filter((grant) => !permissions.includes(grant));
    plugin.updatedAt = Date.now();
    this.persist();
    return structuredClone(plugin);
  }

  setEnabled(id: string, enabled: boolean): InstalledPlugin {
    const plugin = this.require(id);
    if (enabled && plugin.grants.length === 0) throw new Error(`Grant at least one permission to ${id} before enabling it.`);
    plugin.enabled = enabled;
    plugin.updatedAt = Date.now();
    this.persist();
    return structuredClone(plugin);
  }

  list(): InstalledPlugin[] {
    return [...this.plugins.values()].map((plugin) => structuredClone(plugin));
  }

  get(id: string): InstalledPlugin | undefined {
    const plugin = this.plugins.get(id);
    return plugin ? structuredClone(plugin) : undefined;
  }

  /** True only when the plugin is enabled and the owner granted this operation. */
  allows(id: string, operation: string): boolean {
    const plugin = this.plugins.get(id);
    return Boolean(plugin?.enabled && plugin.grants.includes(operation) && this.env.isOperationAllowed(operation, []));
  }
}
