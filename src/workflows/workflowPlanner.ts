/**
 * Planner rules for plugins and workflows (JARVIS-US-062). Only explicit phrases
 * map to plugin:* / workflow:* operations; anything else returns null so the
 * normal planner continues.
 */
import type { PlanProposal } from '../planner/planner.js';

const NAME = '([a-z0-9][a-z0-9-]{1,40})';
const PLUGIN_ID = '([a-z0-9][a-z0-9.-]{2,60})';

function plan(intent: string, operation: string, parameters: Record<string, unknown>, explanation: string): PlanProposal {
  return {
    intent,
    operations: [{ operation, parameters, justification: 'Owner explicitly asked: ' + intent }],
    confidence: 0.9,
    explanation,
  };
}

function list(text: string): string[] {
  return text.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

export function planWorkflowRequest(requestText: string): PlanProposal | null {
  const text = requestText.trim().replace(/[.!]+$/, '');
  let m: RegExpMatchArray | null;

  // ---- plugins ----
  if ((m = text.match(/^install\s+(?:a\s+)?plugin\s+from\s+(.+\.json)$/i))) {
    return plan('Install a plugin', 'plugin:install', { path: m[1]!.trim().replace(/^["']|["']$/g, '') },
      'Will validate the manifest and install the plugin disabled with no permissions, after your approval.');
  }
  if (/^(?:list|show)\s+(?:my\s+|installed\s+)?plugins$/i.test(text)) {
    return plan('List plugins', 'plugin:list', {}, 'Lists installed plugins, requested permissions and grants.');
  }
  if ((m = text.match(new RegExp(`^grant\\s+plugin\\s+${PLUGIN_ID}\\s+(?:permissions?\\s+)?(.+)$`, 'i')))) {
    return plan('Grant plugin permissions', 'plugin:grant', { id: m[1]!.toLowerCase(), permissions: list(m[2]!) },
      'Will grant only the listed, requested permissions after your approval.');
  }
  if ((m = text.match(new RegExp(`^revoke\\s+plugin\\s+${PLUGIN_ID}\\s+(?:permissions?\\s+)?(.+)$`, 'i')))) {
    return plan('Revoke plugin permissions', 'plugin:revoke', { id: m[1]!.toLowerCase(), permissions: list(m[2]!) },
      'Removes the listed grants immediately; workflows needing them stop working.');
  }
  if ((m = text.match(new RegExp(`^(enable|disable|uninstall)\\s+plugin\\s+${PLUGIN_ID}$`, 'i')))) {
    const action = m[1]!.toLowerCase();
    return plan(`${action[0]!.toUpperCase()}${action.slice(1)} a plugin`, `plugin:${action}`, { id: m[2]!.toLowerCase() },
      action === 'disable' ? 'Disables the plugin and archives its workflows.' : `Will ${action} the plugin after your approval.`);
  }

  // ---- workflows ----
  if (/^(?:list|show)\s+(?:my\s+)?workflows$/i.test(text)) {
    return plan('List workflows', 'workflow:list', {}, 'Lists workflow templates with their current version and status.');
  }
  if ((m = text.match(new RegExp(`^(?:show\\s+)?workflow\\s+history\\s+(?:of|for)?\\s*${NAME}$`, 'i')))) {
    return plan('Show workflow history', 'workflow:history', { name: m[1]!.toLowerCase() }, 'Lists every version of this workflow.');
  }
  if ((m = text.match(new RegExp(`^show\\s+workflow\\s+${NAME}$`, 'i')))) {
    return plan('Show a workflow', 'workflow:show', { name: m[1]!.toLowerCase() }, 'Shows the latest version of this workflow.');
  }
  if ((m = text.match(new RegExp(`^(?:run|start)\\s+(?:the\\s+)?workflow\\s+${NAME}$`, 'i')))) {
    return plan('Run a workflow', 'workflow:run', { name: m[1]!.toLowerCase() },
      'Expands the workflow into its steps. Each step is checked by policy, and actions that change anything ask for your approval.');
  }
  if ((m = text.match(new RegExp(`^create\\s+(?:a\\s+)?workflow\\s+${NAME}\\s*[:=-]\\s*(.+)$`, 'i')))) {
    const steps = m[2]!.split(/\s*(?:;|\bthen\b|\n)\s*/i).map((step) => step.trim()).filter(Boolean);
    return plan('Create a workflow', 'workflow:create', { name: m[1]!.toLowerCase(), steps },
      'Will map each step to a supported action and save the workflow as a new version after your approval.');
  }
  if ((m = text.match(new RegExp(`^(?:draft|generate|suggest)\\s+(?:a\\s+)?workflow\\s+${NAME}\\s*(?::|to|for)\\s*(.+)$`, 'i')))) {
    return plan('Draft a workflow with AI', 'workflow:draft_ai', { name: m[1]!.toLowerCase(), goal: m[2]!.trim() },
      'The local AI proposes steps that are saved as an advisory draft. Nothing runs until you approve the draft.');
  }
  if ((m = text.match(new RegExp(`^approve\\s+(?:the\\s+)?workflow\\s+draft\\s+${NAME}$|^approve\\s+draft\\s+workflow\\s+${NAME}$`, 'i')))) {
    return plan('Approve a workflow draft', 'workflow:approve_draft', { name: (m[1] ?? m[2])!.toLowerCase() },
      'Re-validates the draft and makes it the active version after your approval.');
  }
  if ((m = text.match(new RegExp(`^archive\\s+workflow\\s+${NAME}$`, 'i')))) {
    return plan('Archive a workflow', 'workflow:archive', { name: m[1]!.toLowerCase() }, 'Archives the workflow as a new version after your approval.');
  }
  // Schedules reuse the existing scheduler: each run re-plans "run workflow <name>".
  if ((m = text.match(new RegExp(`^schedule\\s+workflow\\s+${NAME}\\s+every\\s+(\\d{1,4})\\s+(minutes?|hours?)$`, 'i')))) {
    const amount = Number(m[2]);
    const everyMinutes = /^hour/i.test(m[3]!) ? amount * 60 : amount;
    return {
      intent: 'Schedule a recurring workflow',
      operations: [{ operation: 'schedule:create', parameters: { requestText: `run workflow ${m[1]!.toLowerCase()}`, runAt: Date.now() + Math.max(everyMinutes, 1) * 60_000, everyMinutes }, justification: 'Owner asked to run a workflow on a schedule' }],
      confidence: 0.86,
      explanation: 'Will create the schedule after approval. Each run is planned and authorized again, and changing steps ask for fresh approval.',
    };
  }
  return null;
}
