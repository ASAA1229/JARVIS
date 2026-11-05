/**
 * OpenAI-compatible adapter for advisory JARVIS agents.
 * Local endpoint is the default. Remote providers require explicit opt-in.
 */
import { AgentModelAdapter } from './agentOrchestrator.js';

export function createConfiguredAgentModelAdapter(): AgentModelAdapter | null {
  const baseUrl = (process.env.JARVIS_AI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const model = process.env.JARVIS_AI_MODEL || 'llama3.2';
  const apiKey = process.env.JARVIS_AI_API_KEY;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(baseUrl + '/');
  if (!local && process.env.JARVIS_AI_ALLOW_REMOTE !== 'true') return null;

  return {
    async generate(prompt, signal): Promise<unknown> {
      const response = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: 'Bearer ' + apiKey } : {}),
        },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          response_format: { type: 'json_object' },
          messages: prompt.messages,
        }),
        signal,
      });
      if (!response.ok) throw new Error('Configured agent model request failed');
      const payload = await response.json() as {
        choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
      };
      const message = payload.choices?.[0]?.message;
      if (typeof message?.refusal === 'string' && message.refusal.trim()) {
        throw new Error('Agent model declined the request');
      }
      if (typeof message?.content !== 'string') return null;
      try {
        return JSON.parse(message.content) as unknown;
      } catch {
        return message.content;
      }
    },
  };
}
