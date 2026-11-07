/**
 * JARVIS conversational agent.
 * Uses versioned role-separated prompts and a locally validated JSON response contract.
 * It never executes tools; action-like requests are delegated to the policy-controlled planner.
 */
import { providerRouter } from '../ai/providerRouter.js';
import { chatCompletion, ProviderCallError } from '../ai/providerClient.js';
import {
  buildConversationPrompt,
  parseConversationModelResponse,
  PromptMemoryItem,
  PromptConversationMessage,
} from './promptContract.js';

export interface ConversationMemory extends PromptMemoryItem {}

const MAX_REQUEST_LENGTH = 6000;

export interface ConversationalAnswerResult {
  answer: string;
  persistInHistory: boolean;
}

function normalized(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9' ]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function isActionRequest(text: string): boolean {
  return /\b(open|launch|bring\s+up|close|start|stop|click|type|paste|copy|zoom|press|run|execute|delete|remove|restore|create file|write file|edit file|read file|list files|search files|schedule|cancel schedule|remember|forget|save|(?:list|show) (?:my )?memories|what do you remember|(?:update|correct) memory|send|call|message|install|shutdown|restart|list windows|show windows|show my windows|(?:what|which) (?:apps?|windows|applications|programs) (?:are )?(?:open|running|installed)|(?:what|which|tell me|get|check|show) (?:is |me )?(?:the )?(?:os version|windows version|system memory|memory usage|ram usage|battery status|disk space)|switch to|focus|(?:list|show) (?:my )?schedules|every \d+ (?:minutes?|hours?)|find (?:a )?files?|(?:create|make|write|save) (?:a )?(?:new )?file|in file|show (?:me )?(?:the |my )?files?|show me file|list (?:the )?installed apps?|show (?:the )?installed apps?|discover installed apps|draft email|compose email|whatsapp|sms)\b/i.test(text);
}

function identityAnswer(text: string, memory: ConversationMemory[]): string | null {
  const value = normalized(text);
  if (/^(hi|hello|hey|good morning|good afternoon|good evening)( jarvis)?$/.test(value)) {
    return 'Hello, sir. How can I help you today?';
  }
  if (/^(who are you|what are you|introduce yourself|tell me about yourself|tell me about jarvis|describe yourself)$/.test(value)) {
    return 'I am JARVIS, your personal AI assistant, built by you. I am designed to answer questions, help with software and everyday tasks, and interact with supported applications through the security and approval controls you established. My capabilities depend on the integrations currently available, and I will tell you when something is not supported.';
  }
  if (/^(who created you|who built you|who made you)$/.test(value)) {
    return 'You created me, sir. You are developing JARVIS as your personal AI assistant, with the long-term goal of building a secure assistant that can work across your devices.';
  }
  if (/^(tell me about myself|tell me about me|what do you know about me|who am i|describe me|what are my interests|what projects am i working on|what do you remember about me)$/.test(value)) {
    if (!memory.length) {
      return 'Sir, I do not have any owner memories available to this session. I know from this project context that you are developing JARVIS, but I do not want to guess at other personal details.';
    }
    const items = memory.slice(0, 8).map((item) => item.content.trim()).filter(Boolean);
    return items.length
      ? 'Sir, here is what I can confirm from the personal information available to me:\n' + items.map((item) => '- ' + item).join('\n')
      : 'Sir, I do not have any relevant personal memories available right now.';
  }
  if (/^(what is artificial intelligence|define artificial intelligence|what is ai)$/.test(value)) {
    return 'Artificial intelligence (AI) is a field of computing focused on building systems that perform tasks such as understanding language, recognizing patterns, solving problems, and generating content. Different AI systems use different techniques, and not every system learns or reasons in the same way.';
  }
  if (/^(what is generative ai|define generative ai)$/.test(value)) {
    return 'Generative AI is a type of AI that creates new content—such as text, code, images, audio, or video—based on patterns learned from training data. A language model can generate an answer from your prompt and relevant context; retrieval tools can provide supporting information from your own approved data.';
  }
  if (/^(what is machine learning|define machine learning)$/.test(value)) {
    return 'Machine learning is a branch of AI in which a system learns patterns from data to make predictions or produce outputs, rather than relying only on hand-written rules. Examples include spam detection, recommendations, and image classification.';
  }
  return null;
}


async function generateWithConfiguredModel(text: string, memory: ConversationMemory[], history: PromptConversationMessage[]): Promise<string | null> {
  // Adaptive routing (US-059): local first; personal memory or history => local only;
  // a cloud provider is used only when the owner authorized it for this task type.
  const containsPrivateData = memory.length > 0 || history.length > 0;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const decision = providerRouter.route({ taskType: 'conversation', containsPrivateData });
    const provider = decision.provider;
    if (!provider) return null;
    const messages = buildConversationPrompt({
      request: text,
      // Personal context never leaves the device, even if routing is misconfigured.
      memories: provider.local ? memory.slice(0, 5) : [],
      history: provider.local ? history : [],
    });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const content = await chatCompletion(provider, messages, { temperature: 0.35, json: true }, controller.signal);
      providerRouter.reportSuccess(provider.id);
      let decoded: unknown;
      try {
        decoded = JSON.parse(content);
      } catch {
        return null;
      }
      const structured = parseConversationModelResponse(decoded);
      if (!structured) return null;
      return structured.followUpQuestion
        ? structured.answer + '\n\n' + structured.followUpQuestion
        : structured.answer;
    } catch (error) {
      if (error instanceof ProviderCallError && error.kind !== 'invalid_response') providerRouter.reportFailure(provider.id);
      else return null;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

/**
 * Returns a conversational answer when the request is not an action directive.
 * null means the existing policy-controlled planner should handle the request.
 */
export async function answerConversationalMessageResult(
  requestText: string,
  memory: ConversationMemory[] = [],
  history: PromptConversationMessage[] = [],
): Promise<ConversationalAnswerResult | null> {
  const text = requestText.trim();
  if (!text || text.length > MAX_REQUEST_LENGTH || isActionRequest(text)) return null;

  const deterministic = identityAnswer(text, memory);
  if (deterministic) return { answer: deterministic, persistInHistory: true };

  const minimizedMemory = memory
    .filter((item) => item && typeof item.content === 'string' && item.content.trim())
    .slice(0, 5)
    .map((item) => ({ content: item.content.slice(0, 500), category: item.category }));
  const boundedHistory = history.slice(-20).filter((item) =>
    (item.role === 'user' || item.role === 'assistant') && typeof item.content === 'string' && item.content.trim(),
  ).map((item) => ({ role: item.role, content: item.content.slice(0, 4000) }));
  const generated = await generateWithConfiguredModel(text, minimizedMemory, boundedHistory);
  if (generated) return { answer: generated, persistInHistory: true };

  return {
    answer: 'I can help with that, sir, but no AI provider returned a valid response. Check that the local model (Ollama) is running and JARVIS_AI_BASE_URL / JARVIS_AI_MODEL are configured. Cloud providers are used only when configured and authorized by you, and never for requests that include personal memory.',
    persistInHistory: false,
  };
}

/** Backwards-compatible string API for callers that only need the displayed answer. */
export async function answerConversationalMessage(
  requestText: string,
  memory: ConversationMemory[] = [],
  history: PromptConversationMessage[] = [],
): Promise<string | null> {
  const result = await answerConversationalMessageResult(requestText, memory, history);
  return result?.answer ?? null;
}
