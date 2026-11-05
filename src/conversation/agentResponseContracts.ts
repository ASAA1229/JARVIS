import { getCapability } from '../capabilities/registry.js';

/**
 * Strict response schemas and local validators for specialized JARVIS agents.
 * A valid model response is still advisory and never authorizes execution.
 */

export interface AgentFinding {
  kind: 'fact' | 'assumption' | 'risk' | 'recommendation';
  detail: string;
}

export interface DeveloperAssistantResponse {
  summary: string;
  findings: AgentFinding[];
  suggestedChanges: string[];
  clarification: string | null;
  confidence: number;
}

export interface TaskPlanStep {
  id: string;
  title: string;
  description: string;
  dependencies: string[];
  approvalRequired: boolean;
  risk: 'low' | 'medium' | 'high';
}

export interface TaskPlanResponse {
  goal: string;
  status: 'ready' | 'needs_clarification' | 'unsupported';
  steps: TaskPlanStep[];
  clarification: string | null;
  confidence: number;
}

export interface ToolCandidate {
  toolId: string;
  purpose: string;
  rationale: string;
  requiredInputs: string[];
}

export interface ToolCandidateResponse {
  status: 'candidates_found' | 'no_supported_tool' | 'needs_clarification';
  candidates: ToolCandidate[];
  clarification: string | null;
  confidence: number;
}

export interface AgentSummaryResponse {
  summary: string;
  keyPoints: string[];
  decisions: string[];
  completed: string[];
  pending: string[];
  uncertainties: string[];
}

const stringSchema = { type: 'string', minLength: 1, maxLength: 2000 } as const;
const stringListSchema = { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 1000 } } as const;
const confidenceSchema = { type: 'number', minimum: 0, maximum: 1 } as const;
const nullableQuestionSchema = { type: ['string', 'null'], maxLength: 500 } as const;

export const AGENT_RESPONSE_SCHEMAS = {
  'jarvis.agent.response.v1': {
    type: 'object', additionalProperties: false,
    required: ['summary', 'findings', 'suggestedChanges', 'clarification', 'confidence'],
    properties: {
      summary: stringSchema,
      findings: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['kind', 'detail'], properties: { kind: { type: 'string', enum: ['fact', 'assumption', 'risk', 'recommendation'] }, detail: stringSchema } } },
      suggestedChanges: stringListSchema,
      clarification: nullableQuestionSchema,
      confidence: confidenceSchema,
    },
  },
  'jarvis.agent.plan.v1': {
    type: 'object', additionalProperties: false,
    required: ['goal', 'status', 'steps', 'clarification', 'confidence'],
    properties: {
      goal: stringSchema,
      status: { type: 'string', enum: ['ready', 'needs_clarification', 'unsupported'] },
      steps: { type: 'array', maxItems: 30, items: { type: 'object', additionalProperties: false, required: ['id', 'title', 'description', 'dependencies', 'approvalRequired', 'risk'], properties: { id: { type: 'string', minLength: 1, maxLength: 40 }, title: { type: 'string', minLength: 1, maxLength: 160 }, description: { type: 'string', minLength: 1, maxLength: 1200 }, dependencies: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 40 } }, approvalRequired: { type: 'boolean' }, risk: { type: 'string', enum: ['low', 'medium', 'high'] } } } },
      clarification: nullableQuestionSchema,
      confidence: confidenceSchema,
    },
  },
  'jarvis.agent.tool_candidates.v1': {
    type: 'object', additionalProperties: false,
    required: ['status', 'candidates', 'clarification', 'confidence'],
    properties: {
      status: { type: 'string', enum: ['candidates_found', 'no_supported_tool', 'needs_clarification'] },
      candidates: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['toolId', 'purpose', 'rationale', 'requiredInputs'], properties: { toolId: { type: 'string', minLength: 1, maxLength: 120 }, purpose: { type: 'string', minLength: 1, maxLength: 300 }, rationale: { type: 'string', minLength: 1, maxLength: 1000 }, requiredInputs: { type: 'array', maxItems: 20, items: { type: 'string', maxLength: 120 } } } } },
      clarification: nullableQuestionSchema,
      confidence: confidenceSchema,
    },
  },
  'jarvis.agent.summary.v1': {
    type: 'object', additionalProperties: false,
    required: ['summary', 'keyPoints', 'decisions', 'completed', 'pending', 'uncertainties'],
    properties: {
      summary: stringSchema,
      keyPoints: stringListSchema,
      decisions: stringListSchema,
      completed: stringListSchema,
      pending: stringListSchema,
      uncertainties: stringListSchema,
    },
  },
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isText(value: unknown, max = 2000): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function isTextList(value: unknown, maxItems = 20, maxLength = 1000): value is string[] {
  return Array.isArray(value) && value.length <= maxItems && value.every((item) => isText(item, maxLength));
}

function isConfidence(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isQuestion(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && value.length <= 500);
}

/** Validate that a generated plan is a usable acyclic dependency graph. */
function hasValidPlanDependencies(steps: unknown[]): boolean {
  const ids = new Set<string>();
  for (const step of steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || ids.has(step.id)) return false;
    ids.add(step.id);
  }

  const dependencies = new Map<string, string[]>();
  for (const step of steps) {
    if (!isRecord(step) || typeof step.id !== 'string' || !Array.isArray(step.dependencies)) return false;
    const uniqueDependencies = new Set<string>();
    for (const dependency of step.dependencies) {
      if (typeof dependency !== 'string' || dependency === step.id ||
        !ids.has(dependency) || uniqueDependencies.has(dependency)) return false;
      uniqueDependencies.add(dependency);
    }
    dependencies.set(step.id, [...uniqueDependencies]);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (!visit(dependency)) return false;
    }
    visiting.delete(id);
    visited.add(id);
    return true;
  };

  return [...ids].every(visit);
}

export function parseDeveloperAssistantResponse(value: unknown): DeveloperAssistantResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['summary', 'findings', 'suggestedChanges', 'clarification', 'confidence'])) return null;
  if (!isText(value.summary) || !Array.isArray(value.findings) || value.findings.length > 20) return null;
  const findings = value.findings;
  if (!findings.every((item) => isRecord(item) && hasOnlyKeys(item, ['kind', 'detail']) && ['fact', 'assumption', 'risk', 'recommendation'].includes(String(item.kind)) && isText(item.detail))) return null;
  if (!isTextList(value.suggestedChanges) || !isQuestion(value.clarification) || !isConfidence(value.confidence)) return null;
  return value as unknown as DeveloperAssistantResponse;
}

export function parseTaskPlanResponse(value: unknown): TaskPlanResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['goal', 'status', 'steps', 'clarification', 'confidence'])) return null;
  if (!isText(value.goal) || !['ready', 'needs_clarification', 'unsupported'].includes(String(value.status))) return null;
  if (!Array.isArray(value.steps) || value.steps.length > 30) return null;
  const validSteps = value.steps.every((step) => isRecord(step)
    && hasOnlyKeys(step, ['id', 'title', 'description', 'dependencies', 'approvalRequired', 'risk'])
    && isText(step.id, 40) && isText(step.title, 160) && isText(step.description, 1200)
    && isTextList(step.dependencies, 30, 40)
    && typeof step.approvalRequired === 'boolean'
    && ['low', 'medium', 'high'].includes(String(step.risk))
    // Medium- and high-risk proposals must visibly request owner approval.
    && (step.risk === 'low' || step.approvalRequired === true));
  if (!validSteps || !hasValidPlanDependencies(value.steps) ||
    !isQuestion(value.clarification) || !isConfidence(value.confidence)) return null;
  if (value.status === 'ready' && (value.steps.length === 0 || value.clarification !== null)) return null;
  if (value.status === 'needs_clarification' && !value.clarification) return null;
  if (value.status === 'unsupported' && value.steps.length) return null;
  return value as unknown as TaskPlanResponse;
}

export function parseToolCandidateResponse(value: unknown): ToolCandidateResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['status', 'candidates', 'clarification', 'confidence'])) return null;
  if (!['candidates_found', 'no_supported_tool', 'needs_clarification'].includes(String(value.status))) return null;
  if (!Array.isArray(value.candidates) || value.candidates.length > 10) return null;
  const validCandidates = value.candidates.every((candidate) => {
    if (!isRecord(candidate) || !hasOnlyKeys(candidate, ['toolId', 'purpose', 'rationale', 'requiredInputs']) ||
      !isText(candidate.toolId, 120) || !isText(candidate.purpose, 300) ||
      !isText(candidate.rationale, 1000) || !isTextList(candidate.requiredInputs, 20, 120)) return false;

    // Model-proposed IDs must resolve to the live capability catalogue.
    // Restricted capabilities are never offered as usable candidates.
    const capability = getCapability(candidate.toolId);
    return Boolean(capability && capability.status !== 'restricted');
  });
  if (!validCandidates || !isQuestion(value.clarification) || !isConfidence(value.confidence)) return null;
  if (value.status === 'candidates_found' && !value.candidates.length) return null;
  if (value.status === 'no_supported_tool' && value.candidates.length) return null;
  if (value.status === 'needs_clarification' && !value.clarification) return null;
  return value as unknown as ToolCandidateResponse;
}

export function parseAgentSummaryResponse(value: unknown): AgentSummaryResponse | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ['summary', 'keyPoints', 'decisions', 'completed', 'pending', 'uncertainties'])) return null;
  if (!isText(value.summary)) return null;
  const fields = ['keyPoints', 'decisions', 'completed', 'pending', 'uncertainties'] as const;
  if (!fields.every((field) => isTextList(value[field]))) return null;
  return value as unknown as AgentSummaryResponse;
}
