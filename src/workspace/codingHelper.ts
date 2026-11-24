/**
 * Coding helper for the Code view. It builds a bounded, secret-redacted prompt from the open file and
 * selection, streams the model's answer, and turns any proposed change into a validated unified diff.
 * The helper never writes: a proposal is only a diff the owner must approve through workspace:apply_diff.
 */
import { providerRouter, type ProviderRouter } from '../ai/providerRouter.js';
import { OllamaProvider } from '../ai/ollamaProvider.js';
import type { AIMessage } from '../ai/aiProvider.js';
import { containsSecret, redactSecrets } from '../developer/secrets.js';
import { WorkspaceService, type DiffPreview } from './workspaceService.js';

export type HelperAction = 'chat' | 'explain' | 'fix' | 'refactor' | 'tests' | 'generate';
export const HELPER_ACTIONS: readonly HelperAction[] = ['chat', 'explain', 'fix', 'refactor', 'tests', 'generate'];

export interface HelperRequest {
  root: string;
  action: HelperAction;
  message: string;
  path?: string;
  /** Unsaved editor text; used instead of the disk copy so the model sees what the owner sees. */
  content?: string;
  selection?: { text: string; startLine: number; endLine: number };
  history?: Array<{ role: 'user' | 'assistant'; content: string }>;
}

export type HelperEvent =
  | { type: 'token'; text: string }
  | { type: 'proposal'; valid: boolean; diff?: string; files?: string[]; error?: string }
  | { type: 'error'; message: string }
  | { type: 'done' };

/** A model that streams text. The default uses the local Ollama provider chosen by providerRouter. */
export interface HelperModel {
  stream(messages: AIMessage[], signal?: AbortSignal): AsyncIterable<string>;
}

export function createLocalHelperModel(router: ProviderRouter = providerRouter): HelperModel {
  return {
    async *stream(messages, signal) {
      // Code is private context: only a local (zero-cost) provider is eligible.
      const decision = router.route({ taskType: 'developer', containsPrivateData: true, formats: ['ollama'] });
      const provider = decision.provider;
      if (!provider || !provider.local) throw new Error('No local AI model is available. Start Ollama and try again.');
      const ollama = new OllamaProvider({ baseUrl: provider.baseUrl, model: provider.model, timeoutMs: provider.timeoutMs ?? 120_000 });
      try {
        for await (const token of ollama.stream(messages, { temperature: 0.2, maxTokens: 4096 }, signal)) yield token;
        router.reportSuccess(provider.id);
      } catch (error) {
        if (!signal?.aborted) router.reportFailure(provider.id);
        throw error;
      }
    },
  };
}

const MAX_CONTEXT_CHARS = 24_000;
const MAX_MESSAGE_CHARS = 4_000;
const MAX_HISTORY = 8;
const MAX_ANSWER_CHARS = 200_000;

const SYSTEM_PROMPT = [
  'You are the JARVIS coding helper inside a local code editor. You work only on the files the owner shows you.',
  'Be concise. Never ask for or repeat secrets, tokens, keys or passwords.',
  'When you propose a change to code, finish your answer with exactly ONE fenced block that starts with ```diff and contains a unified diff.',
  'Diff rules: paths are relative to the workspace root, use "--- a/<path>" and "+++ b/<path>", include 3 lines of unchanged context in each hunk, and copy context and removed lines exactly as shown.',
  'To create a new file use "--- /dev/null" and "+++ b/<path>". Do not delete or rename files. Do not change files you were not shown unless creating a new one.',
  'If the question needs no change (for example an explanation), do not include a diff block.',
].join('\n');

const ACTION_INSTRUCTIONS: Record<HelperAction, string> = {
  chat: 'Answer the question about this code.',
  explain: 'Explain what this code does, step by step, and point out anything risky or surprising. Do not include a diff.',
  fix: 'Find and fix the bug or problem described (or the most likely bug in the selection). Explain the cause briefly, then give the diff.',
  refactor: 'Refactor for clarity and maintainability without changing behavior. Explain briefly, then give the diff.',
  tests: 'Write focused tests for this code using the testing approach already used in the project (default to node:test). Put them in a NEW test file via a diff from /dev/null.',
  generate: 'Generate the file or code requested. If it is a new file, give it as a diff from /dev/null with a sensible path.',
};

function numbered(text: string): string {
  return text.split('\n').map((line, index) => `${index + 1}| ${line}`).join('\n');
}

export function extractDiffBlock(answer: string): string | null {
  const matches = [...answer.matchAll(/```(?:diff|patch)[^\n]*\n([\s\S]*?)```/g)];
  if (matches.length) return matches[matches.length - 1]![1]!.replace(/\s+$/, '') + '\n';
  // Some models forget the fence; accept a bare unified diff.
  const bare = /(^|\n)(--- (?:a\/|\/dev\/null)[^\n]*\n\+\+\+ [^\n]*\n@@[\s\S]*)$/.exec(answer);
  return bare ? bare[2]!.replace(/\s+$/, '') + '\n' : null;
}

export class CodingHelper {
  constructor(private readonly workspace: WorkspaceService, private readonly model: HelperModel = createLocalHelperModel()) {}

  buildMessages(request: HelperRequest): AIMessage[] {
    const messages: AIMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
    const parts: string[] = [`Workspace: ${request.root}`];
    if (request.path) {
      let content = request.content;
      if (content === undefined) {
        try { content = this.workspace.readFile(request.root, request.path).content; } catch { content = undefined; }
      }
      parts.push(`Open file: ${request.path}`);
      if (content !== undefined) {
        const clipped = content.length > MAX_CONTEXT_CHARS ? content.slice(0, MAX_CONTEXT_CHARS) + '\n[truncated]' : content;
        parts.push('File content (line-numbered for reference; do not include line numbers in the diff):\n' + numbered(redactSecrets(clipped)));
      }
    }
    if (request.selection?.text) {
      parts.push(`Selected lines ${request.selection.startLine}-${request.selection.endLine}:\n${redactSecrets(request.selection.text.slice(0, 8000))}`);
    }
    messages.push({ role: 'user', content: parts.join('\n\n') });
    messages.push({ role: 'assistant', content: 'Understood. What would you like to do?' });
    for (const turn of (request.history ?? []).slice(-MAX_HISTORY)) {
      messages.push({ role: turn.role, content: redactSecrets(String(turn.content).slice(0, MAX_MESSAGE_CHARS)) });
    }
    messages.push({ role: 'user', content: `${ACTION_INSTRUCTIONS[request.action]}\n\n${redactSecrets(request.message.slice(0, MAX_MESSAGE_CHARS))}`.trim() });
    return messages;
  }

  /** Validate a model-produced diff against the real files without writing anything. */
  validateProposal(root: string, answer: string): HelperEvent | null {
    const diff = extractDiffBlock(answer);
    if (!diff) return null;
    if (containsSecret(diff.split('\n').filter((line) => line.startsWith('+')).join('\n'))) {
      return { type: 'proposal', valid: false, error: 'The proposed change contains something that looks like a secret, so it was discarded.' };
    }
    try {
      const preview: DiffPreview = this.workspace.previewDiff(root, diff);
      return { type: 'proposal', valid: true, diff: preview.diff, files: preview.files.map((file) => file.path) };
    } catch (error) {
      return { type: 'proposal', valid: false, error: error instanceof Error ? error.message : 'The proposed diff is not valid.' };
    }
  }

  async *run(request: HelperRequest, signal?: AbortSignal): AsyncGenerator<HelperEvent> {
    if (!HELPER_ACTIONS.includes(request.action)) { yield { type: 'error', message: 'Unknown helper action.' }; return; }
    if (typeof request.message !== 'string' || (request.action !== 'explain' && !request.message.trim() && !request.selection)) {
      yield { type: 'error', message: 'Tell the helper what you want.' };
      return;
    }
    let messages: AIMessage[];
    try {
      this.workspace.roots.require(request.root);
      messages = this.buildMessages(request);
    } catch (error) {
      yield { type: 'error', message: error instanceof Error ? error.message : 'Request rejected.' };
      return;
    }
    let answer = '';
    try {
      for await (const token of this.model.stream(messages, signal)) {
        answer += token;
        if (answer.length > MAX_ANSWER_CHARS) break;
        yield { type: 'token', text: redactSecrets(token) };
      }
    } catch (error) {
      yield { type: 'error', message: signal?.aborted ? 'Stopped.' : error instanceof Error ? error.message : 'The model failed.' };
      return;
    }
    const proposal = this.validateProposal(request.root, answer);
    if (proposal) yield proposal;
    yield { type: 'done' };
  }
}
