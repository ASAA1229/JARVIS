# JARVIS Ollama integration

## Configuration

The primary inference provider is the local Ollama service.

```dotenv
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_TIMEOUT=120
```

The timeout is in seconds (1–600). Legacy `JARVIS_AI_BASE_URL` and
`JARVIS_AI_MODEL` values remain accepted as migration fallbacks. New deployments
should use the `OLLAMA_*` settings.

## Architecture

```mermaid
flowchart TD
  UI[HUD / Browser / Android] --> API[Signed JARVIS API]
  API --> Auth[Device session authentication]
  Auth --> Router{Action or conversation?}
  Router -->|Action| Planner[Planner]
  Planner --> Policy[Default-deny Policy Gateway]
  Policy --> Approval[Approval and task execution]
  Router -->|Conversation| Chat[Conversational assistant]
  Chat --> Prompt[Versioned prompt contract]
  Chat --> Memory[MemoryManager retrieval]
  Chat --> Provider[ProviderRouter]
  Provider --> Ollama[OllamaProvider]
  Ollama --> Model[Ollama /api/chat]
  Model --> Chat
  Chat --> API
  API --> UI
```

## Request flow

1. The client submits the existing signed `POST /api/request` request.
2. The server validates the device session and determines whether the text is an action.
3. Action requests continue to the existing planner and PolicyGateway without model execution.
4. Conversational requests retrieve bounded working-memory and authorized long-term context.
5. The versioned prompt contract builds the system/developer/user messages.
6. ProviderRouter selects local Ollama. The provider sends a non-streaming request to
   `POST /api/chat`, validates the response, and returns text to the existing response contract.
7. The existing response shape and conversation ID are preserved.

## Memory flow

```mermaid
flowchart TD
  Request[Authenticated conversation request] --> Session[ConversationSessionStore]
  Session --> Working[WorkingMemory: RAM-only]
  Request --> Manager[MemoryManager]
  Working --> Retrieve[Ranked retrieval]
  Manager --> Retrieve
  Retrieve --> Semantic[Ollama local embeddings]
  Retrieve --> LongTerm[Encrypted PersonalMemoryStore]
  Semantic --> Rank[Semantic + lexical + recency ranking]
  LongTerm --> Rank
  Rank --> Prompt[Bounded untrusted context]
  Prompt --> Model[Ollama /api/chat]
  Model --> Reply[Assistant response]
  Reply --> Session
  Feedback[Owner feedback / conversation outcome] --> Candidate[Encrypted learning candidate]
  Candidate --> Review[Owner approval or rejection]
  Review -->|Approve| LongTerm
```

- Conversation history is isolated per authenticated device and conversation ID in the
  existing bounded process-local ConversationSessionStore. It currently expires after
  30 minutes and is not restored after a server restart.
- Working memory is short-lived and RAM-only.
- Long-term personal memories remain encrypted at rest in PersonalMemoryStore.
- MemoryManager ranks relevant memories using local Ollama embeddings plus lexical
  overlap and recency; it falls back to lexical retrieval if embeddings are unavailable.
- Retrieved content is supplied as untrusted context, never as system instructions.
- Learning candidates and feedback remain owner-reviewable; no automatic model fine-tuning occurs.

## RAG / retrieval flow

```mermaid
flowchart LR
  Query[User query] --> Embed[Local Ollama embedding]
  Embed --> Compare[Cosine similarity]
  Query --> Lexical[Lexical overlap]
  Compare --> Rank[Combine semantic, lexical and recency scores]
  Lexical --> Rank
  Rank --> TopK[Bounded relevant memory records]
  TopK --> Prompt[Conversation prompt]
  Prompt --> Chat[Ollama /api/chat]
  Embed -. unavailable .-> Fallback[Lexical + recency fallback]
  Fallback --> TopK
```

The existing retrieval is memory-RAG: it searches approved personal memories and
conversation-scoped working memory. It is not a document ingestion/vector-RAG pipeline;
document parsing, chunking, access-control metadata and document citations are separate
future components.

## Health checks

- Direct Ollama health: `GET http://localhost:11434/api/tags`
- JARVIS provider configuration: authenticated `GET /api/ai/providers`
- JARVIS Ollama connectivity/model check: authenticated `GET /api/ai/health`

The JARVIS endpoints require the existing signed device session and a device-management
permission. They do not expose Ollama credentials or unrestricted provider URLs.

## Tests

Run the provider unit tests with:

```powershell
npm test
```

Validate the locally installed model end-to-end:

```powershell
npm run test:ollama
# or
.\scripts\test-ollama.ps1
```

## cURL examples

List installed models:

```bash
curl http://localhost:11434/api/tags
```

Send a native chat request:

```bash
curl http://localhost:11434/api/chat \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.2:latest","messages":[{"role":"user","content":"Reply with exactly: OLLAMA_OK"}],"stream":false}'
```

The authenticated JARVIS provider endpoints must be called through the existing signed
client; do not replace the signature headers with an unauthenticated request. In a logged-in
JARVIS browser session, use the existing device crypto helper:

```javascript
const healthResponse = await window.JarvisDeviceCrypto.signedFetch('/api/ai/health', { method: 'GET' });
console.log('health', healthResponse.status, await healthResponse.json());

const chatResponse = await window.JarvisDeviceCrypto.signedFetch('/api/request', {
  method: 'POST',
  body: { text: 'Explain how JARVIS conversation memory works.' },
});
console.log('chat', chatResponse.status, await chatResponse.json());
```

## PowerShell API test

```powershell
$env:OLLAMA_URL = 'http://localhost:11434'
$env:OLLAMA_MODEL = 'llama3.2:latest'
$env:OLLAMA_TIMEOUT = '120'
.\scripts\test-ollama.ps1
```

## Provider expansion

The new `AIProvider` contract defines chat, streaming and health-check capabilities.
Ollama is implemented against the native API. The existing OpenAI-compatible and
Anthropic transports remain available through the shared provider client. Gemini is
not enabled yet; a future adapter can implement `AIProvider` and be registered in
ProviderRouter without changing the conversation API or HUD.

## Future self-learning path

Keep inference separate from learning. Future work can improve:

1. Conversation history persistence with explicit retention, export and deletion controls.
2. User-profile facts proposed from conversations, stored as attributed learning candidates.
3. Owner feedback (helpful/not helpful/correction) linked to the source interaction.
4. Retrieval over approved documents using a separate document collection and embedding index.
5. Evaluation datasets and retrieval-quality metrics before promoting any learning candidate.

Approved facts are stored in the encrypted memory store. Learning candidates require owner
approval. No online weight updates or automatic fine-tuning are part of this design.


## Storage and future schema recommendation

No relational database migration is required for this Ollama provider change. JARVIS
currently uses encrypted local files for long-term memory, learning candidates and
semantic vectors, while active conversation sessions are process-local.

If conversation history must survive restarts and synchronize across multiple JARVIS
instances/devices, introduce a persistence layer with these logical records:

| Entity | Important fields |
|---|---|
| conversation_sessions | id, owner_device_id, created_at, updated_at, expires_at, retention_state |
| conversation_messages | id, conversation_id, sequence, role, encrypted_content, created_at |
| user_memories | id, owner_id, category, encrypted_content, source_kind, source_ref, approved_at, expires_at |
| memory_embeddings | memory_id, model, content_hash, encrypted_vector |
| learning_candidates | id, owner_id, category, encrypted_content, source_kind, source_ref, status, decided_at |
| feedback_events | id, owner_id, conversation_id, message_id, rating, encrypted_comment, created_at |
| knowledge_documents | id, owner_id, source, checksum, classification, status |
| document_chunks | id, document_id, chunk_index, encrypted_content, embedding_id |

Required indexes would include (owner_device_id, updated_at) for sessions,
(conversation_id, sequence) for messages, and (owner_id, category, updated_at)
for memories. Retention, export, deletion, tenant isolation and encryption-key rotation
must be designed before enabling durable transcript storage.

The current encrypted file stores remain the source of truth for this migration. Do not
create a database merely to support Ollama.
