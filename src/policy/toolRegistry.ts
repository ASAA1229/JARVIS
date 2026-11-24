/**
 * The single tool registry (E:D4.6).
 *
 * Every operation JARVIS can execute is declared here exactly once with its required permission,
 * risk tier, approval requirement and declared parameters (names and, where unambiguous, types).
 * The Policy Gateway evaluates against it, the planner may only emit operations registered here,
 * and the executor re-validates parameters against it immediately before running an adapter.
 * Default deny: anything not in this table is refused.
 */
import { Permission, RiskTier } from '../core/types.js';

export interface PolicyRule {
  operation: string;
  requiredPermission: Permission;
  riskTier: RiskTier;
  requiresApproval: boolean;
  allowedParameters?: string[];
}

// Explicit default-deny allowlist of supported operations
export const TOOL_REGISTRY: ReadonlyMap<string, PolicyRule> = new Map<string, PolicyRule>([
  // Read-only system info queries (LOW risk, no interactive approval needed)
  [
    'system:get_os_info',
    {
      operation: 'system:get_os_info',
      requiredPermission: Permission.SYSTEM_INFO_READ,
      riskTier: RiskTier.LOW,
      requiresApproval: false,
    },
  ],
  [
    'system:get_memory_info',
    {
      operation: 'system:get_memory_info',
      requiredPermission: Permission.SYSTEM_INFO_READ,
      riskTier: RiskTier.LOW,
      requiresApproval: false,
    },
  ],
  [
    'system:get_battery_status',
    {
      operation: 'system:get_battery_status',
      requiredPermission: Permission.SYSTEM_INFO_READ,
      riskTier: RiskTier.LOW,
      requiresApproval: false,
    },
  ],
  [
    'system:get_disk_space',
    {
      operation: 'system:get_disk_space',
      requiredPermission: Permission.SYSTEM_INFO_READ,
      riskTier: RiskTier.LOW,
      requiresApproval: false,
      allowedParameters: ['drive'],
    },
  ],
  // Selected Application Launch (MEDIUM risk, requires explicit task-scoped approval)
  [
    'app:launch',
    {
      operation: 'app:launch',
      requiredPermission: Permission.APP_LAUNCH,
      riskTier: RiskTier.MEDIUM,
      requiresApproval: true,
      allowedParameters: ['appId'],
    },
  ],
  ...[
    ['memory:save', ['category', 'content', 'ttlDays']],
    ['memory:update', ['id', 'content', 'expectedUpdatedAt']],
    ['memory:list', []],
    ['memory:delete', ['id']],
    ['desktop:launch_and_type', ['appId', 'text']],
    ['desktop:browser_search', ['appId', 'query']],
    ['desktop:save_and_verify', ['path', 'contains', 'expectProcess']],
    ['desktop:notepad_write_and_save', ['path', 'text']],
    ['desktop:type_text', ['text', 'expectProcess']],
    ['desktop:paste_text', ['text', 'expectProcess']],
    ['desktop:hotkey', ['keys', 'expectProcess']],
    ['desktop:zoom', ['direction', 'expectProcess']],
    ['desktop:copy_selection', ['expectProcess']],
    ['desktop:paste_clipboard', ['expectProcess']],
    ['desktop:inspect_window', ['expectProcess']],
    ['desktop:read_control', ['name', 'automationId', 'expectProcess']],
    ['desktop:click_control', ['name', 'automationId', 'expectProcess']],
    ['desktop:set_value', ['name', 'automationId', 'text', 'expectProcess']],
    ['desktop:set_toggle', ['name', 'automationId', 'state', 'expectProcess']],
  ].map(([operation, allowedParameters]) => [operation as string, {
    operation: operation as string,
    requiredPermission: (operation as string).startsWith('memory:') ? Permission.DEVICE_MANAGE : Permission.APP_LAUNCH,
    riskTier: operation === 'desktop:inspect_window' || operation === 'memory:list' ? RiskTier.LOW : RiskTier.HIGH,
    requiresApproval: !['desktop:inspect_window', 'memory:list'].includes(operation as string),
    allowedParameters: allowedParameters as string[],
  }] as [string, PolicyRule]),
  // Window discovery/focus, workspace files, terminal, and scheduling. Read-only
  // name listings need no approval; everything that reads content, changes state,
  // runs a process, or schedules future work requires a fresh single-use approval.
  ...([
    ['desktop:list_windows', Permission.APP_LAUNCH, RiskTier.LOW, false, []],
    ['desktop:focus_window', Permission.APP_LAUNCH, RiskTier.MEDIUM, true, ['processName', 'titleContains']],
    ['file:list', Permission.APP_LAUNCH, RiskTier.LOW, false, ['path']],
    ['file:search', Permission.APP_LAUNCH, RiskTier.LOW, false, ['query', 'path']],
    ['file:read', Permission.APP_LAUNCH, RiskTier.MEDIUM, true, ['path']],
    ['file:verify_saved', Permission.APP_LAUNCH, RiskTier.LOW, false, ['path', 'since', 'contains']],
    ['file:write', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['path', 'content']],
    ['file:edit', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['path', 'find', 'replace']],
    ['file:delete', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['path']],
    ['file:restore', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['quarantineId']],
    ['terminal:run', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['command', 'args', 'cwd']],
    ['schedule:create', Permission.DEVICE_MANAGE, RiskTier.HIGH, true, ['requestText', 'runAt', 'everyMinutes']],
    ['schedule:list', Permission.DEVICE_MANAGE, RiskTier.LOW, false, []],
    ['schedule:cancel', Permission.DEVICE_MANAGE, RiskTier.MEDIUM, true, ['id']],
    ['app:inventory', Permission.APP_LAUNCH, RiskTier.LOW, false, []],
    ['comms:handoff_email', Permission.APP_LAUNCH, RiskTier.HIGH, true, ['to', 'cc', 'subject', 'body']],
    ['comms:unsupported', Permission.SYSTEM_INFO_READ, RiskTier.LOW, false, ['channel', 'reason']],
  ] as Array<[string, Permission, RiskTier, boolean, string[]]>).map(([operation, requiredPermission, riskTier, requiresApproval, allowedParameters]) => [operation, {
    operation,
    requiredPermission,
    riskTier,
    requiresApproval,
    allowedParameters,
  }] as [string, PolicyRule]),
  // Plugins and workflows (JARVIS-US-062). Owner-only. Installing, granting, enabling,
  // creating and approving need fresh approval; reducing access (disable/revoke) and
  // read-only listing do not. Running a workflow only expands its steps: every
  // expanded step is evaluated by this gateway and approved separately when required.
  ...([
    ['plugin:install', RiskTier.HIGH, true, ['path']],
    ['plugin:list', RiskTier.LOW, false, []],
    ['plugin:grant', RiskTier.HIGH, true, ['id', 'permissions']],
    ['plugin:revoke', RiskTier.LOW, false, ['id', 'permissions']],
    ['plugin:enable', RiskTier.MEDIUM, true, ['id']],
    ['plugin:disable', RiskTier.LOW, false, ['id']],
    ['plugin:uninstall', RiskTier.MEDIUM, true, ['id']],
    ['workflow:list', RiskTier.LOW, false, []],
    ['workflow:show', RiskTier.LOW, false, ['name']],
    ['workflow:history', RiskTier.LOW, false, ['name']],
    ['workflow:run', RiskTier.MEDIUM, false, ['name']],
    ['workflow:create', RiskTier.HIGH, true, ['name', 'description', 'steps']],
    ['workflow:draft_ai', RiskTier.LOW, false, ['name', 'goal']],
    ['workflow:approve_draft', RiskTier.HIGH, true, ['name']],
    ['workflow:archive', RiskTier.MEDIUM, true, ['name']],
    // Visual composer: explicit steps with dependencies, saved as a new active version.
    ['workflow:compose', RiskTier.HIGH, true, ['name', 'description', 'steps']],
    // Personal AI gateway site clients (J-E09). Issuing a key or widening a site's
    // limits/profile scope needs approval; listing and revoking (reducing access) do not.
    ['gateway:site_list', RiskTier.LOW, false, []],
    ['gateway:site_create', RiskTier.HIGH, true, ['name', 'limits', 'allowedProfiles']],
    ['gateway:site_update', RiskTier.MEDIUM, true, ['id', 'limits', 'allowedProfiles']],
    ['gateway:site_revoke', RiskTier.LOW, false, ['id']],
  ] as Array<[string, RiskTier, boolean, string[]]>).map(([operation, riskTier, requiresApproval, allowedParameters]) => [operation, {
    operation,
    requiredPermission: Permission.DEVICE_MANAGE,
    riskTier,
    requiresApproval,
    allowedParameters,
  }] as [string, PolicyRule]),
  // Developer assistant (JARVIS-US-063). Owner-only. Read-only intelligence and draft
  // suggestions run on repositories the owner explicitly connected with that scope;
  // connecting, applying, branching, committing and pushing need fresh approval.
  ...([
    ['dev:repo_connect', RiskTier.HIGH, true, ['name', 'path', 'scopes']],
    ['dev:repo_disconnect', RiskTier.MEDIUM, true, ['name']],
    ['dev:repo_list', RiskTier.LOW, false, []],
    ['dev:tree', RiskTier.LOW, false, ['repo', 'path']],
    ['dev:read', RiskTier.LOW, false, ['repo', 'path']],
    ['dev:grep', RiskTier.LOW, false, ['repo', 'query']],
    ['dev:git_status', RiskTier.LOW, false, ['repo']],
    ['dev:git_log', RiskTier.LOW, false, ['repo', 'count']],
    ['dev:git_diff', RiskTier.LOW, false, ['repo', 'staged']],
    ['dev:explain', RiskTier.LOW, false, ['repo', 'path', 'request']],
    ['dev:suggest_change', RiskTier.MEDIUM, false, ['repo', 'path', 'request']],
    ['dev:suggestion_list', RiskTier.LOW, false, ['repo']],
    ['dev:apply_suggestion', RiskTier.HIGH, true, ['repo', 'suggestionId']],
    ['dev:branch_create', RiskTier.HIGH, true, ['repo', 'branch']],
    ['dev:commit', RiskTier.HIGH, true, ['repo', 'message', 'suggestionId']],
    ['dev:push', RiskTier.HIGH, true, ['repo']],
    ['dev:pr_draft', RiskTier.LOW, false, ['repo', 'title']],
    ['dev:ci_status', RiskTier.LOW, false, ['repo']],
    // Opens a PR on GitHub (remote side effect): base dev only, fresh approval.
    ['dev:pr_create', RiskTier.HIGH, true, ['repo', 'title']],
    // Executes the repository's own build/lint/test/typecheck script: approval each time.
    ['dev:run_script', RiskTier.HIGH, true, ['repo', 'script']],
    ['dev:history', RiskTier.LOW, false, ['repo', 'count']],
    // Documentation drafts are stored as suggestions only, never written to files.
    ['dev:doc_suggest', RiskTier.LOW, false, ['repo', 'path', 'request']],
  ] as Array<[string, RiskTier, boolean, string[]]>).map(([operation, riskTier, requiresApproval, allowedParameters]) => [operation, {
    operation,
    requiredPermission: Permission.DEVICE_MANAGE,
    riskTier,
    requiresApproval,
    allowedParameters,
  }] as [string, PolicyRule]),
  // JARVIS Studio Code view: owner-approved workspace roots. Reads need no approval; adding a root and
  // every write, create, rename, delete or diff apply needs fresh approval. Secret files stay denied by the adapter.
  ...([
    ['workspace:root_list', RiskTier.LOW, false, []],
    ['workspace:root_add', RiskTier.HIGH, true, ['name', 'path']],
    ['workspace:root_remove', RiskTier.MEDIUM, true, ['name']],
    ['workspace:read', RiskTier.LOW, false, ['root', 'path']],
    ['workspace:search', RiskTier.LOW, false, ['root', 'query']],
    ['workspace:write', RiskTier.HIGH, true, ['root', 'path', 'content', 'baseHash']],
    ['workspace:create', RiskTier.HIGH, true, ['root', 'path', 'content']],
    ['workspace:rename', RiskTier.HIGH, true, ['root', 'path', 'to']],
    ['workspace:delete', RiskTier.HIGH, true, ['root', 'path']],
    ['workspace:apply_diff', RiskTier.HIGH, true, ['root', 'diff']],
  ] as Array<[string, RiskTier, boolean, string[]]>).map(([operation, riskTier, requiresApproval, allowedParameters]) => [operation, {
    operation,
    requiredPermission: Permission.DEVICE_MANAGE,
    riskTier,
    requiresApproval,
    allowedParameters,
  }] as [string, PolicyRule]),
  ...['device:enrollment:create', 'device:enrollment:list', 'device:enrollment:approve', 'device:enrollment:reject', 'device:enrollment:cancel', 'device:list', 'security:totp:setup', 'security:totp:verify', 'security:totp:disable', 'device:revoke'].map((operation) => [operation, {
    operation,
    requiredPermission: Permission.DEVICE_MANAGE,
    riskTier: RiskTier.HIGH,
    requiresApproval: false,
  }] as [string, PolicyRule]),
  ['device:enrollment:exchange', { operation: 'device:enrollment:exchange', requiredPermission: Permission.SYSTEM_INFO_READ, riskTier: RiskTier.MEDIUM, requiresApproval: false }],
  ['device:self-revoke', { operation: 'device:self-revoke', requiredPermission: Permission.SYSTEM_INFO_READ, riskTier: RiskTier.HIGH, requiresApproval: false }],
]);

export function isRegisteredTool(operation: unknown): operation is string {
  return typeof operation === 'string' && TOOL_REGISTRY.has(operation);
}

type ParameterType = 'string' | 'array';

/**
 * Declared types for parameters whose shape is unambiguous across every operation that accepts
 * them. Parameters not listed here are checked by name only and validated by their adapter.
 */
const PARAMETER_TYPES: Readonly<Record<string, ParameterType>> = {
  appId: 'string', expectProcess: 'string', processName: 'string', titleContains: 'string',
  path: 'string', query: 'string', text: 'string', content: 'string', find: 'string', replace: 'string',
  command: 'string', cwd: 'string', quarantineId: 'string', requestText: 'string', automationId: 'string',
  repo: 'string', root: 'string', to: 'string', diff: 'string', baseHash: 'string', branch: 'string', script: 'string', suggestionId: 'string', direction: 'string',
  args: 'array', keys: 'array',
};

/**
 * Validates parameters against the registered declaration: the operation must be registered, every
 * key must be declared, and declared types must match (string arrays for args/keys). Returns the
 * first problem, or undefined when the parameters are acceptable.
 */
export function validateToolParameters(operation: string, parameters: unknown): string | undefined {
  const rule = TOOL_REGISTRY.get(operation);
  if (!rule) return `Operation '${operation}' is not registered`;
  if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) return 'Operation parameters must be a plain object';
  const allowed = rule.allowedParameters;
  for (const [key, value] of Object.entries(parameters as Record<string, unknown>)) {
    if (allowed && !allowed.includes(key)) return `Disallowed parameter '${key}' for operation '${operation}'`;
    if (value === undefined || value === null) continue;
    const declared = PARAMETER_TYPES[key];
    if (declared === 'string' && typeof value !== 'string') return `Parameter '${key}' must be a string`;
    if (declared === 'array' && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) return `Parameter '${key}' must be an array of strings`;
  }
  return undefined;
}
