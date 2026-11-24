/** JARVIS Studio Code view operation ids. Shared by the policy registry, planner allowlist and service. */
export const WORKSPACE_OPERATIONS = [
  'workspace:root_list', 'workspace:root_add', 'workspace:root_remove', 'workspace:read', 'workspace:search',
  'workspace:write', 'workspace:create', 'workspace:rename', 'workspace:delete', 'workspace:apply_diff',
] as const;

export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
