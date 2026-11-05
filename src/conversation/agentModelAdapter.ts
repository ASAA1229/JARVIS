/**
 * OpenAI-compatible adapter for advisory JARVIS agents.
 * Local endpoint is the default. Remote providers require explicit opt-in.
 */
import { AgentModelAdapter, AgentModelProviderError } from './agentOrchestrator.js';

const MAX_PROVIDER_RESPONSE_BYTES = 256 * 1024;
const MAX_MODEL_CONTENT_LENGTH = 32 * 1024;

async function readBoundedResponse(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PROVIDER_RESPONSE_BYTES) {
    throw new AgentModelProviderError('response_too_large');
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new AgentModelProviderError('response_too_large');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_PROVIDER_RESPONSE_BYTES) {
        await reader.cancel();
        throw new AgentModelProviderError('response_too_large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createConfiguredAgentModelAdapter(): AgentModelAdapter | null {
  const baseUrl = (process.env.JARVIS_AI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/$/, '');
  const model = process.env.JARVIS_AI_MODEL || 'llama3.2';
  const apiKey = process.env.JARVIS_AI_API_KEY;
  const local = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(baseUrl + '/');
  if (!local && process.env.JARVIS_AI_ALLOW_REMOTE !== 'true') return null;

  return {
    async generate(prompt, signal): Promise<unknown> {
      let response: Response;
      try {
        response = await fetch(baseUrl + '/chat/completions', {
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
      } catch (error) {
        if (signal.aborted) throw error;
        throw new AgentModelProviderError('network');
      }
      if (!response.ok) throw new AgentModelProviderError('http', response.status);
      let payload: {
        choices?: Array<{ message?: { content?: unknown; refusal?: unknown } }>;
      };
      try {
        payload = await response.json() as typeof payload;
      } catch {
        throw new AgentModelProviderError('provider_response');
      }
      const message = payload.choices?.[0]?.message;
      if (typeof message?.refusal === 'string' && message.refusal.trim()) {
        throw new AgentModelProviderError('refusal');
      }
      if (typeof message?.content !== 'string') throw new AgentModelProviderError('provider_response');
      try {
        return JSON.parse(message.content) as unknown;
      } catch {
        return message.content;
      }
    },
  };
}
