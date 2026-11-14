/**
 * Planner rules for the developer assistant (JARVIS-US-063).
 * Only explicit, repo-scoped phrases map to dev:* operations; anything else
 * returns null so the normal planner continues.
 */
import type { PlanProposal } from '../planner/planner.js';

const REPO = '(?:repo(?:sitory)?\\s+)?([a-z0-9][a-z0-9-]{1,40})';

function plan(intent: string, operation: string, parameters: Record<string, unknown>, explanation: string, confidence = 0.9): PlanProposal {
  return {
    intent,
    operations: [{ operation, parameters, justification: 'Owner explicitly asked the developer assistant: ' + intent }],
    confidence,
    explanation,
  };
}

function rx(source: string): RegExp {
  return new RegExp(source, 'i');
}

export function planDeveloperRequest(requestText: string): PlanProposal | null {
  const text = requestText.trim();
  let m: RegExpMatchArray | null;

  if ((m = text.match(/^connect\s+(?:a\s+)?repo(?:sitory)?\s+([a-z0-9][a-z0-9-]{1,40})\s+(?:at|from)\s+(.+?)(?:\s+with\s+scopes?\s+([a-z ,_-]+))?$/i))) {
    return plan('Connect a repository to the developer assistant', 'dev:repo_connect',
      { name: m[1]!.toLowerCase(), path: m[2]!.trim(), scopes: m[3]?.trim() ?? 'read,suggest' },
      'Will connect this repository with the listed scopes after your approval. Default scopes are read and suggest; git-write and ci must be granted explicitly.');
  }
  if ((m = text.match(/^disconnect\s+repo(?:sitory)?\s+([a-z0-9][a-z0-9-]{1,40})$/i))) {
    return plan('Disconnect a repository', 'dev:repo_disconnect', { name: m[1]!.toLowerCase() },
      'Will remove this repository connection after approval; files are not touched.');
  }
  if (/^(?:list|show)\s+(?:my\s+)?(?:connected\s+)?repos(?:itories)?$/i.test(text)) {
    return plan('List connected repositories', 'dev:repo_list', {}, 'Lists connected repositories and their scopes.');
  }
  if ((m = text.match(rx(`^(?:show\\s+)?git\\s+status\\s+(?:of|for|in)\\s+${REPO}$`)))) {
    return plan('Show git status', 'dev:git_status', { repo: m[1]!.toLowerCase() }, 'Read-only git status of the connected repository.');
  }
  if ((m = text.match(rx(`^(?:show\\s+)?git\\s+(?:log|history)\\s+(?:of|for|in)\\s+${REPO}$`)))) {
    return plan('Show git log', 'dev:git_log', { repo: m[1]!.toLowerCase() }, 'Read-only recent commits and branches.');
  }
  if ((m = text.match(rx(`^(?:show\\s+)?(?:git\\s+)?(staged\\s+)?(?:diff|changes)\\s+(?:of|for|in)\\s+${REPO}$`)))) {
    return plan('Show uncommitted changes', 'dev:git_diff', { repo: m[2]!.toLowerCase(), staged: Boolean(m[1]) },
      'Read-only diff of the working tree (secrets redacted).');
  }
  if ((m = text.match(rx(`^(?:show|list)\\s+(?:the\\s+)?(?:files|file\\s+tree|tree)\\s+(?:of|in)\\s+${REPO}(?:\\s+(?:under|in)\\s+(.+))?$`)))) {
    return plan('Show repository files', 'dev:tree', { repo: m[1]!.toLowerCase(), path: m[2]?.trim() || '.' },
      'Lists repository files, excluding secrets, dependencies and git internals.');
  }
  if ((m = text.match(rx(`^(?:show|read|view)\\s+file\\s+(.+?)\\s+(?:in|from)\\s+${REPO}$`)))) {
    return plan('Read a repository file', 'dev:read', { repo: m[2]!.toLowerCase(), path: m[1]!.trim() },
      'Reads a bounded, secret-redacted copy of the file.');
  }
  if ((m = text.match(rx(`^(?:search|grep)\\s+(?:for\\s+)?["“]?(.+?)["”]?\\s+in\\s+${REPO}$`)))) {
    return plan('Search the repository', 'dev:grep', { repo: m[2]!.toLowerCase(), query: m[1]!.trim() },
      'Literal text search across non-protected files.');
  }
  if ((m = text.match(rx(`^explain\\s+(?:the\\s+)?(?:file\\s+)?(.+?)\\s+in\\s+${REPO}(?:\\s*[:,-]\\s*(.+))?$`)))) {
    return plan('Explain code', 'dev:explain', { repo: m[2]!.toLowerCase(), path: m[1]!.trim(), request: m[3]?.trim() ?? '' },
      'Generates an explanation with the local model and stores it as a draft; nothing is changed.');
  }
  if ((m = text.match(rx(`^suggest\\s+(?:a\\s+)?(?:fix|change|improvement|edit)\\s+(?:for|to|in)\\s+(.+?)\\s+in\\s+${REPO}\\s*[:,-]\\s*(.+)$`)))) {
    return plan('Suggest a code change', 'dev:suggest_change', { repo: m[2]!.toLowerCase(), path: m[1]!.trim(), request: m[3]!.trim() },
      'Generates a draft diff with explanation. It is not applied or committed until you ask and approve.');
  }
  if ((m = text.match(rx(`^(?:list|show)\\s+(?:my\\s+)?(?:code\\s+)?suggestions(?:\\s+(?:for|in)\\s+${REPO})?$`)))) {
    return plan('List draft suggestions', 'dev:suggestion_list', m[1] ? { repo: m[1].toLowerCase() } : {},
      'Lists recent draft and applied suggestions.');
  }
  if ((m = text.match(rx(`^apply\\s+suggestion\\s+([a-f0-9]{6,16})(?:\\s+(?:in|to)\\s+${REPO})?$`)))) {
    return plan('Apply a draft suggestion to the working tree', 'dev:apply_suggestion',
      { suggestionId: m[1]!.toLowerCase(), ...(m[2] ? { repo: m[2].toLowerCase() } : {}) },
      'After approval, applies the reviewed diff to the working tree only; it is not committed. Protected branches are refused.');
  }
  if ((m = text.match(rx(`^(?:create|make|start)\\s+(?:a\\s+)?(?:new\\s+)?branch\\s+([A-Za-z0-9._/-]{1,100})\\s+in\\s+${REPO}$`)))) {
    return plan('Create a feature branch', 'dev:branch_create', { repo: m[2]!.toLowerCase(), branch: m[1]! },
      'After approval, creates and switches to the branch. main, master and dev cannot be created or targeted.');
  }
  if ((m = text.match(rx(`^commit\\s+(?:suggestion\\s+([a-f0-9]{6,16})\\s+)?(?:in|to)\\s+${REPO}\\s*(?:[:,-]|with\\s+message)\\s*["“]?(.+?)["”]?$`)))) {
    return plan('Commit changes', 'dev:commit',
      { repo: m[2]!.toLowerCase(), message: m[3]!.trim(), ...(m[1] ? { suggestionId: m[1].toLowerCase() } : {}) },
      'After approval, commits the staged changes (or the applied suggestion files) on the current feature branch. Commits to main, master or dev are refused.');
  }
  if ((m = text.match(rx(`^push\\s+(?:the\\s+)?(?:current\\s+)?(?:branch\\s+)?(?:of\\s+|in\\s+|for\\s+)?${REPO}$`)))) {
    return plan('Push the current feature branch', 'dev:push', { repo: m[1]!.toLowerCase() },
      'After approval, pushes the current feature branch to origin without force. Pushing main, master or dev is refused; integrate through a PR to dev.');
  }
  if ((m = text.match(rx(`^(?:draft|prepare|write)\\s+(?:a\\s+)?(?:pr|pull\\s+request)\\s+(?:for|in|from)\\s+${REPO}(?:\\s*[:,-]\\s*(.+))?$`)))) {
    return plan('Draft a pull request to dev', 'dev:pr_draft', { repo: m[1]!.toLowerCase(), ...(m[2] ? { title: m[2].trim() } : {}) },
      'Prepares PR title and description targeting dev. Nothing is opened remotely.');
  }
  if ((m = text.match(rx(`^(?:open|create|submit)\\s+(?:a\\s+)?(?:pr|pull\\s+request)\\s+(?:for|in|from)\\s+${REPO}(?:\\s*[:,-]\\s*(.+))?$`)))) {
    return plan('Open a pull request into dev', 'dev:pr_create', { repo: m[1]!.toLowerCase(), ...(m[2] ? { title: m[2].trim() } : {}) },
      'After approval, opens a GitHub pull request from the current pushed feature branch into dev (never main) and confirms it with gh.');
  }
  if ((m = text.match(rx(`^(?:run|execute)\\s+(?:the\\s+)?(build|lint|test|tests|typecheck)\\s+(?:script\\s+)?(?:for|in|of)\\s+${REPO}$`)))) {
    const script = m[1]!.toLowerCase() === 'tests' ? 'test' : m[1]!.toLowerCase();
    return plan(`Run the ${script} script`, 'dev:run_script', { repo: m[2]!.toLowerCase(), script },
      `After approval, runs "npm run ${script}" in the repository (ci scope, 5-minute limit) and returns the redacted output.`);
  }
  if ((m = text.match(rx(`^(?:show\\s+)?(?:dev\\s+|task\\s+|assistant\\s+)?history\\s+(?:of|for|in)\\s+${REPO}$`)))) {
    return plan('Show repository task history', 'dev:history', { repo: m[1]!.toLowerCase() },
      'Lists recent developer-assistant operations and outcomes for this repository.');
  }
  if ((m = text.match(rx(`^(?:document|write\\s+docs?\\s+for|draft\\s+docs?\\s+for)\\s+(?:the\\s+)?(?:file\\s+)?(.+?)\\s+in\\s+${REPO}(?:\\s*[:,-]\\s*(.+))?$`)))) {
    return plan('Draft documentation', 'dev:doc_suggest', { repo: m[2]!.toLowerCase(), path: m[1]!.trim(), request: m[3]?.trim() ?? '' },
      'Drafts documentation text with the local model and stores it as a suggestion; nothing is written to any file.');
  }
  if ((m = text.match(rx(`^(?:show\\s+)?ci\\s+(?:status\\s+)?(?:of|for|in)\\s+${REPO}$`)))) {
    return plan('Show CI status', 'dev:ci_status', { repo: m[1]!.toLowerCase() },
      'Read-only recent CI runs for the current branch (requires the ci scope and GitHub CLI).');
  }
  return null;
}
