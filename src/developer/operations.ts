/** Developer-assistant operation ids (JARVIS-US-063). Shared by planner, policy and service. */
export const DEVELOPER_OPERATIONS = [
  'dev:repo_connect', 'dev:repo_disconnect', 'dev:repo_list', 'dev:tree', 'dev:read', 'dev:grep',
  'dev:git_status', 'dev:git_log', 'dev:git_diff', 'dev:explain', 'dev:suggest_change',
  'dev:suggestion_list', 'dev:apply_suggestion', 'dev:branch_create', 'dev:commit', 'dev:push',
  'dev:pr_draft', 'dev:ci_status',
  // Approval-gated remote PR (base `new` by default; promotion bases need an explicit flag), project script runs, history, doc drafts.
  'dev:pr_create', 'dev:run_script', 'dev:history', 'dev:doc_suggest',
] as const;

export type DeveloperOperation = (typeof DEVELOPER_OPERATIONS)[number];

export function isDeveloperOperation(operation: string): operation is DeveloperOperation {
  return (DEVELOPER_OPERATIONS as readonly string[]).includes(operation);
}
