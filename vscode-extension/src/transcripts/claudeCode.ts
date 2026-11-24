import { classifyCommand } from '../classify';
import { head, stableId, tail, type Episode, type EpisodeStep } from '../episodes';
import type { TranscriptParser } from './types';

/**
 * Claude Code JSONL transcript parser (~/.claude/projects/<project>/*.jsonl).
 * One line = one JSON message: {type:'user'|'assistant', uuid, sessionId, timestamp, cwd, message:{content}}.
 * A user message with text (not a tool_result) starts an episode; the assistant tool calls that follow
 * (Edit/Write/MultiEdit/Bash) become steps, and the last assistant text is the closing summary.
 */
interface Open {
  episode: Episode;
  startOffset: number;
  pendingTools: Map<string, EpisodeStep>;
  lastAssistantText?: string;
}
export interface ClaudeState { sessionId?: string; cwd?: string; open?: Open }

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'NotebookEdit']);
const MAX_OUTPUT = 800;
const MAX_DIFF = 2000;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isObject(part) && part['type'] === 'text' && typeof part['text'] === 'string' ? part['text'] : '')).filter(Boolean).join('\n');
}

/** Slash-command echoes, hook output and caveats are not owner prompts. */
function isSyntheticPrompt(text: string): boolean {
  return /^\s*<(?:command-name|command-message|local-command|system-reminder|user-prompt-submit-hook)/.test(text) || /^\s*Caveat:/.test(text) || /^\s*\[Request interrupted/.test(text);
}

function toolResultText(block: Record<string, unknown>): string {
  const content = block['content'];
  return typeof content === 'string' ? content : textOf(content);
}

function diffOf(oldText: unknown, newText: unknown): string {
  const minus = typeof oldText === 'string' && oldText ? oldText.split('\n').map((l) => `- ${l}`).join('\n') : '';
  const plus = typeof newText === 'string' && newText ? newText.split('\n').map((l) => `+ ${l}`).join('\n') : '';
  return head([minus, plus].filter(Boolean).join('\n'), MAX_DIFF);
}

function closeOpen(state: ClaudeState): Episode[] {
  const open = state.open;
  state.open = undefined;
  if (!open) return [];
  const { episode } = open;
  if (open.lastAssistantText) episode.assistantSummary = head(open.lastAssistantText, 1500);
  const commands = episode.steps.filter((s) => s.kind === 'command' && s.exitCode !== undefined);
  const failed = commands.filter((s) => (s.exitCode ?? 0) !== 0);
  const last = commands[commands.length - 1];
  episode.outcome = commands.length === 0
    ? { status: 'unknown' }
    : last && (last.exitCode ?? 0) === 0
      ? { status: 'success', ...(failed.length ? { summary: `${failed.length} earlier command(s) failed before the last one succeeded` } : {}) }
      : { status: 'failure', summary: 'The last command failed' };
  episode.assistantGenerated = episode.steps.some((s) => s.assistantGenerated) || Boolean(episode.assistantSummary);
  // Nothing happened after the prompt: not a learning episode.
  return episode.steps.length === 0 && !episode.assistantSummary ? [] : [episode];
}

export const claudeCodeParser: TranscriptParser<ClaudeState> = {
  id: 'claude-code',

  accepts(firstLine: string): boolean {
    try {
      const parsed: unknown = JSON.parse(firstLine);
      if (!isObject(parsed)) return false;
      const type = parsed['type'];
      return typeof type === 'string' && ['user', 'assistant', 'summary', 'system', 'file-history-snapshot', 'queue-operation'].includes(type) &&
        (typeof parsed['sessionId'] === 'string' || type === 'summary' || type === 'file-history-snapshot' || isObject(parsed['message']));
    } catch { return false; }
  },

  newState: () => ({}),

  feedLine(state, line, offset): Episode[] {
    let msg: unknown;
    try { msg = JSON.parse(line); } catch { return []; }
    if (!isObject(msg)) return [];
    if (typeof msg['sessionId'] === 'string') state.sessionId = msg['sessionId'];
    if (typeof msg['cwd'] === 'string') state.cwd = msg['cwd'];
    if (msg['isSidechain'] === true || msg['isMeta'] === true) return [];
    const message = msg['message'];
    if (!isObject(message)) return [];
    const timestamp = typeof msg['timestamp'] === 'string' && !Number.isNaN(Date.parse(msg['timestamp'])) ? msg['timestamp'] : new Date().toISOString();
    const content = message['content'];

    if (msg['type'] === 'user') {
      // tool results belong to the open episode
      if (Array.isArray(content)) {
        for (const block of content) {
          if (!isObject(block) || block['type'] !== 'tool_result') continue;
          const step = state.open?.pendingTools.get(String(block['tool_use_id']));
          if (!step) continue;
          const text = toolResultText(block);
          if (step.kind === 'command') {
            const exit = /Exit code[:\s]+(-?\d+)/i.exec(text);
            step.exitCode = exit ? Number(exit[1]) : block['is_error'] === true ? 1 : 0;
            step.outputTail = tail(text, MAX_OUTPUT);
          } else if (block['is_error'] === true) {
            step.summary = `${step.summary ?? step.kind} (failed)`;
          }
          state.open!.pendingTools.delete(String(block['tool_use_id']));
          state.open!.episode.endedAt = timestamp;
        }
        if (content.some((b) => isObject(b) && b['type'] === 'tool_result')) return [];
      }
      const prompt = textOf(content).trim();
      if (!prompt || isSyntheticPrompt(prompt)) return [];
      const closed = closeOpen(state);
      const episode: Episode = {
        schemaVersion: 1,
        id: stableId('cc', state.sessionId ?? 'nosession', typeof msg['uuid'] === 'string' ? msg['uuid'] : String(offset)),
        source: 'claude-code',
        startedAt: timestamp,
        endedAt: timestamp,
        ...(state.cwd ? { workspace: state.cwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '' } : {}),
        prompt: head(prompt, 8000),
        assistantGenerated: false,
        steps: [],
      };
      state.open = { episode, startOffset: offset, pendingTools: new Map() };
      return closed;
    }

    if (msg['type'] === 'assistant' && state.open && Array.isArray(content)) {
      const open = state.open;
      open.episode.endedAt = timestamp;
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block['type'] === 'text' && typeof block['text'] === 'string' && block['text'].trim()) open.lastAssistantText = block['text'].trim();
        if (block['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue;
        const input = isObject(block['input']) ? block['input'] : {};
        const name = block['name'];
        let step: EpisodeStep | undefined;
        if (EDIT_TOOLS.has(name)) {
          const path = String(input['file_path'] ?? input['notebook_path'] ?? '');
          if (!path) continue;
          step = { kind: 'edit', assistantGenerated: true, path, diff: diffOf(input['old_string'], input['new_string']) };
        } else if (name === 'Write') {
          const path = String(input['file_path'] ?? '');
          if (!path) continue;
          step = { kind: 'write', assistantGenerated: true, path, summary: `wrote ${typeof input['content'] === 'string' ? input['content'].split('\n').length : '?'} lines` };
        } else if (name === 'Bash' && typeof input['command'] === 'string') {
          step = { kind: 'command', assistantGenerated: true, command: head(input['command'], 2000), commandClass: classifyCommand(input['command']),
            ...(typeof input['description'] === 'string' ? { summary: head(input['description'], 300) } : {}) };
        }
        if (!step) continue;
        open.episode.steps.push(step);
        if (typeof block['id'] === 'string') open.pendingTools.set(block['id'], step);
      }
    }
    return [];
  },

  flush: (state) => closeOpen(state),
  openStart: (state) => state.open?.startOffset,
};
