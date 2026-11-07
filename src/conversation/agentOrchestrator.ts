/**
 * JARVIS agent orchestration boundary.
 *
 * Routes advisory work to a specialized prompt profile, validates model output,
 * and explicitly keeps executable requests on the existing policy-gateway path.
 * This module never invokes tools or performs desktop/device actions.
 */
import {
  buildAgentPrompt,
  AgentPromptProfile,
  AgentPromptContextItem,
  BuiltAgentPrompt,
} from './agentPromptProfiles.js';
import {
  DeveloperAssistantResponse,
  TaskPlanResponse,
  ToolCandidateResponse,
  AgentSummaryResponse,
  parseDeveloperAssistantResponse,
  parseTaskPlanResponse,
  parseToolCandidateResponse,
  parseAgentSummaryResponse,
} from './agentResponseContracts.js';

export type AgentRoute =
  | { destination: 'agent'; profile: AgentPromptProfile; reason: string }
  | { destination: 'policy_gateway'; reason: string };

export type AgentResponse =
  | DeveloperAssistantResponse
  | TaskPlanResponse
  | ToolCandidateResponse
  | AgentSummaryResponse;

export type AgentFailureCode =
  | 'invalid_input'
  | 'request_too_large'
  | 'prompt_unavailable'
  | 'invalid_json'
  | 'contract_mismatch'
  | 'timeout'
  | 'network'
  | 'http_error'
  | 'rate_limited'
  | 'provider_refusal'
  | 'provider_response'
  | 'response_too_large'
  | 'adapter_unavailable';

export type AgentRunResult =
  | { status: 'completed'; profile: AgentPromptProfile; response: AgentResponse }
  | { status: 'invalid_response'; profile: AgentPromptProfile; reason: string; failureCode: AgentFailureCode }
  | { status: 'unavailable'; profile: AgentPromptProfile; reason: string; failureCode: AgentFailureCode }
  | { status: 'gateway_required'; reason: string };

export type AgentProviderFailureKind = 'network' | 'http' | 'refusal' | 'provider_response' | 'response_too_large';

/** Safe, non-sensitive provider failure classification for fallback and audit. */
export class AgentModelProviderError extends Error {
  constructor(
    readonly kind: AgentProviderFailureKind,
    readonly httpStatus?: number,
  ) {
    super('Agent model provider failure: ' + kind);
    this.name = 'AgentModelProviderError';
  }
}

export interface AgentModelAdapter {
  /** Return the model's structured JSON value or its raw JSON text. */
  generate(prompt: BuiltAgentPrompt, signal: AbortSignal): Promise<unknown>;
}

export interface AgentOrchestrationInput {
  request: string;
  context?: AgentPromptContextItem[];
  profile?: AgentPromptProfile;
  timeoutMs?: number;
}

const MAX_REQUEST_LENGTH = 12000;
const MAX_CONTEXT_CANDIDATES = 32;
const DEFAULT_TIMEOUT_MS = 25000;
const MAX_TIMEOUT_MS = 60000;

/**
 * Execution directives are never sent to advisory agents. The caller must
 * continue through the existing signed-request and policy-gateway workflow.
 */
const EXECUTION_DIRECTIVE = /\b(open|launch|close|click|type|paste|copy|press|run|execute|delete|remove|install|shutdown|restart|send|call|message|schedule|cancel|remember|forget|save|edit file|write file|create file|move file|switch to|focus)\b/i;

export function routeAgentRequest(request: string): AgentRoute {
  const text = typeof request === 'string' ? request.trim() : '';
  if (!text) return { destination: 'agent', profile: 'developer_assistant', reason: 'Empty request must be rejected by input validation.' };

  if (EXECUTION_DIRECTIVE.test(text)) {
    return {
      destination: 'policy_gateway',
      reason: 'The request may change application, device, file, memory, or external state; use the existing policy-controlled request path.',
    };
  }

  if (/\b(summarize|summary|recap|condense|key points|what did we decide)\b/i.test(text)) {
    return { destination: 'agent', profile: 'summarization', reason: 'The request asks to summarize supplied context.' };
  }
  if (/\b(which tool|what tool|select a tool|tool selection|which integration|which api)\b/i.test(text)) {
    return { destination: 'agent', profile: 'tool_selection', reason: 'The request asks for advisory tool selection, not execution.' };
  }
  if (/\b(plan|planning|roadmap|break down|steps|approach|implementation plan)\b/i.test(text)) {
    return { destination: 'agent', profile: 'task_planning', reason: 'The request asks for a bounded task plan.' };
  }
  return {
    destination: 'agent',
    profile: 'developer_assistant',
    reason: 'The request is best handled as advisory analysis or developer assistance.',
  };
}

function decodeModelValue(value: unknown): unknown | null {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function validateForProfile(profile: AgentPromptProfile, value: unknown): AgentResponse | null {
  switch (profile) {
    case 'developer_assistant': return parseDeveloperAssistantResponse(value);
    case 'task_planning': return parseTaskPlanResponse(value);
    case 'tool_selection': return parseToolCandidateResponse(value);
    case 'summarization': return parseAgentSummaryResponse(value);
  }
}

/**
 * Runs one advisory agent with bounded context and a locally enforced timeout.
 * A successful model response is data only; it cannot authorize an action.
 */
export async function runAgent(
  input: AgentOrchestrationInput,
  adapter: AgentModelAdapter,
): Promise<AgentRunResult> {
  if (!input || typeof input.request !== 'string' || !input.request.trim()) {
    return { status: 'invalid_response', profile: input?.profile ?? 'developer_assistant', reason: 'A non-empty request is required.', failureCode: 'invalid_input' };
  }
  if (input.request.length > MAX_REQUEST_LENGTH) {
    return { status: 'invalid_response', profile: input.profile ?? 'developer_assistant', reason: 'The request exceeds the configured length limit.', failureCode: 'request_too_large' };
  }

  const classifiedRoute = routeAgentRequest(input.request);
  if (classifiedRoute.destination === 'policy_gateway') {
    return { status: 'gateway_required', reason: classifiedRoute.reason };
  }
  const route = input.profile
    ? { destination: 'agent' as const, profile: input.profile, reason: 'The caller explicitly selected an advisory profile.' }
    : classifiedRoute;

  const prompt = buildAgentPrompt({
    profile: route.profile,
    request: input.request,
    context: (input.context ?? []).slice(-32),
  });
  if (!prompt) {
    return { status: 'invalid_response', profile: route.profile, reason: 'The agent prompt could not be assembled from the registered profile.', failureCode: 'prompt_unavailable' };
  }

  const timeoutMs = Number.isFinite(input.timeoutMs)
    ? Math.min(Math.max(Number(input.timeoutMs), 1000), MAX_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort();
        reject(new Error('agent_model_timeout'));
      }, timeoutMs);
    });
    const raw = await Promise.race([
      adapter.generate(prompt, controller.signal),
      timeoutPromise,
    ]);
    const decoded = decodeModelValue(raw);
    if (decoded === null) {
      return { status: 'invalid_response', profile: route.profile, reason: 'The model did not return valid JSON.', failureCode: 'invalid_json' };
    }
    const response = validateForProfile(route.profile, decoded);
    if (!response) {
      return { status: 'invalid_response', profile: route.profile, reason: 'The model response did not satisfy the selected agent contract.', failureCode: 'contract_mismatch' };
    }
    return { status: 'completed', profile: route.profile, response };
  } catch (error) {
    const providerError = error instanceof AgentModelProviderError ? error : null;
    const failureCode = controller.signal.aborted
      ? 'timeout'
      : providerError?.kind === 'network'
        ? 'network'
        : providerError?.kind === 'http'
          ? providerError.httpStatus === 429 ? 'rate_limited' : 'http_error'
          : providerError?.kind === 'refusal'
            ? 'provider_refusal'
            : providerError?.kind === 'provider_response'
              ? 'provider_response'
              : providerError?.kind === 'response_too_large'
                ? 'response_too_large'
                : 'adapter_unavailable';
    const reason = failureCode === 'timeout'
      ? 'The model request timed out.'
      : failureCode === 'network'
        ? 'The configured model provider could not be reached.'
        : failureCode === 'rate_limited'
          ? 'The model provider rate-limited the request.'
          : failureCode === 'http_error'
            ? 'The model provider returned an unsuccessful HTTP response.'
            : failureCode === 'provider_refusal'
              ? 'The model provider declined the request.'
              : failureCode === 'provider_response'
                ? 'The model provider returned an unusable response.'
                : 'The configured model adapter is unavailable.';
    return { status: 'unavailable', profile: route.profile, reason, failureCode };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
