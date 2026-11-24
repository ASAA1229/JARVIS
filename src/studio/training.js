// JARVIS Studio: chat-format training data helpers (shared by the Studio export
// route and scripts/build-training-set.mjs). Data stays local; nothing is uploaded.

export const TEST_DATA_LABEL = 'TEMPORARY / TEST DATA';
export const MAX_RECORD_CHARS = 32_000;
export const MAX_MESSAGES = 200;

const SENSITIVE = /(\bsk-[A-Za-z0-9_-]{16,}|\bjsk_[A-Za-z0-9_-]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}|\b[A-Za-z0-9_]*(?:api[_-]?key|secret|passw(?:or)?d|token)\s*[:=]\s*\S{8,})/i;

export function looksSensitive(text) {
  return SENSITIVE.test(String(text ?? ''));
}

/** Returns a list of problems; an empty list means the record is valid chat format. */
export function validateTrainingRecord(record) {
  const problems = [];
  if (!record || typeof record !== 'object' || Array.isArray(record)) return ['record must be an object'];
  const messages = record.messages;
  if (!Array.isArray(messages) || messages.length < 2) return ['messages must be an array of at least 2 items'];
  if (messages.length > MAX_MESSAGES) problems.push('too many messages');
  let expected = null;
  messages.forEach((message, position) => {
    if (!message || typeof message !== 'object' || !['system', 'user', 'assistant'].includes(message.role) || typeof message.content !== 'string' || !message.content.trim()) {
      problems.push(`message ${position} needs a role (system|user|assistant) and non-empty text`);
      return;
    }
    if (message.role === 'system') {
      if (position !== 0) problems.push('only the first message may be a system message');
      return;
    }
    if (expected === null) expected = 'user';
    if (message.role !== expected) problems.push(`message ${position} breaks user/assistant alternation`);
    expected = message.role === 'user' ? 'assistant' : 'user';
  });
  if (!messages.some((message) => message?.role === 'assistant')) problems.push('at least one assistant message is required');
  if (messages[messages.length - 1]?.role !== 'assistant') problems.push('the last message must be from the assistant');
  if (JSON.stringify(record).length > MAX_RECORD_CHARS) problems.push('record is too large');
  if (messages.some((message) => looksSensitive(message?.content))) problems.push('record looks like it contains a secret');
  return problems;
}

export function isTestData(record) {
  return Array.isArray(record?.messages) && record.messages.some((message) => typeof message?.content === 'string' && message.content.includes(TEST_DATA_LABEL));
}

/**
 * Turn one Studio conversation into a training record, or explain why not.
 * Exchanges whose assistant reply was rated down or stopped early are dropped.
 */
export function conversationToTrainingRecord(conversation, persona) {
  const pairs = [];
  const messages = Array.isArray(conversation?.messages) ? conversation.messages : [];
  for (let position = 0; position + 1 < messages.length; position += 1) {
    const user = messages[position];
    const assistant = messages[position + 1];
    if (user.role !== 'user' || assistant.role !== 'assistant') continue;
    position += 1;
    if (assistant.rating === 'down' || assistant.stopped || assistant.error || !String(assistant.content).trim()) continue;
    pairs.push(user, assistant);
  }
  if (!pairs.length) return { record: null, reason: 'no usable exchanges' };
  const record = { messages: [] };
  if (typeof persona === 'string' && persona.trim()) record.messages.push({ role: 'system', content: persona.trim() });
  for (const message of pairs) record.messages.push({ role: message.role, content: String(message.content) });
  const problems = validateTrainingRecord(record);
  return problems.length ? { record: null, reason: problems[0] } : { record, reason: null };
}

/** Validate, drop duplicates and (unless allowed) labelled test data; keeps first-seen order. */
export function mergeTrainingRecords(records, { includeTestData = false } = {}) {
  const seen = new Set();
  const kept = [];
  const rejected = [];
  records.forEach((record, position) => {
    const problems = validateTrainingRecord(record);
    if (problems.length) return void rejected.push({ position, reason: problems[0] });
    if (!includeTestData && isTestData(record)) return void rejected.push({ position, reason: 'labelled test data' });
    const key = JSON.stringify(record.messages.map((message) => [message.role, message.content.trim()]));
    if (seen.has(key)) return void rejected.push({ position, reason: 'duplicate' });
    seen.add(key);
    kept.push(record);
  });
  return { kept, rejected };
}

export function toJsonl(records) {
  return records.map((record) => JSON.stringify(record)).join('\n') + (records.length ? '\n' : '');
}
