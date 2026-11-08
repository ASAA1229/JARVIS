/** plugin:* and workflow:* operation ids (JARVIS-US-062). */
export const WORKFLOW_OPERATIONS = [
  'plugin:install', 'plugin:list', 'plugin:enable', 'plugin:disable', 'plugin:uninstall', 'plugin:grant', 'plugin:revoke',
  'workflow:list', 'workflow:show', 'workflow:history', 'workflow:run', 'workflow:create', 'workflow:draft_ai',
  'workflow:approve_draft', 'workflow:archive',
] as const;
