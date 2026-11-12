const baseUrl = (process.env.OLLAMA_URL || 'http://localhost:11434').replace(/\/+$/, '');
const model = process.env.OLLAMA_MODEL || 'llama3.2:latest';
const timeoutSeconds = Number(process.env.OLLAMA_TIMEOUT || 120);

if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) {
  throw new Error('OLLAMA_TIMEOUT must be an integer from 1 through 600 seconds.');
}

const signal = () => AbortSignal.timeout(timeoutSeconds * 1000);

console.log('[JARVIS] Checking Ollama at ' + baseUrl);
const tagsResponse = await fetch(baseUrl + '/api/tags', { signal: signal() });
if (!tagsResponse.ok) throw new Error('Ollama health check failed with HTTP ' + tagsResponse.status);
const tags = await tagsResponse.json();
const installed = Array.isArray(tags.models) ? tags.models.map((entry) => entry.name) : [];
if (!installed.includes(model) && !( !model.includes(':') && installed.some((name) => typeof name === 'string' && name.split(':', 1)[0] === model))) {
  throw new Error('Model ' + model + ' is not installed. Run: ollama pull ' + model);
}
console.log('[JARVIS] Ollama is reachable and model ' + model + ' is installed.');

const response = await fetch(baseUrl + '/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  signal: signal(),
  body: JSON.stringify({
    model,
    messages: [{ role: 'user', content: 'Reply with exactly: OLLAMA_OK' }],
    stream: false,
    options: { temperature: 0 },
  }),
});
if (!response.ok) throw new Error('Ollama chat test failed with HTTP ' + response.status);
const payload = await response.json();
const answer = payload?.message?.content;
if (typeof answer !== 'string' || !answer.trim()) throw new Error('Ollama returned an empty or invalid chat response.');
console.log('[JARVIS] Native /api/chat test passed.');
console.log('Model: ' + model);
console.log('Response: ' + answer.trim().slice(0, 300));
