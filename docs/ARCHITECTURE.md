# Architecture

## 1. Architectural direction

JARVIS is a **Node.js 24 / TypeScript modular monolith** with a browser HUD, platform adapters, an Android companion and optional isolated gateway listeners. Shared business rules are separated from operating-system-specific capabilities. One product experience does not require one binary or a universal OS adapter.

Principles:
- Preserve existing business logic, API contracts, UI and workflows when changing infrastructure such as AI providers.
- Keep authentication, policy, approvals, audit, task lifecycle and outcome verification authoritative outside the model.
- Treat model output, retrieved memory, repository content, plugin manifests and external application data as untrusted.
- Prefer local inference and local storage for private information.
- Use narrow interfaces and dependency injection at provider, platform, storage and execution boundaries.
- Report unsupported, partial and uncertain outcomes honestly.

## 2. Logical system

~~~mermaid
flowchart TD
  subgraph Clients
    HUD[Browser HUD / Companion]
    AND[Native Android Companion]
    FUTURE[Future macOS, Linux and iOS clients]
  end
  HUD --> API
  AND --> API
  FUTURE -. future contract .-> API
  API[Authenticated JARVIS API] --> CORE[Core request router]
  CORE --> CONV[Conversation service]
  CORE --> PLAN[Planner and task service]
  PLAN --> POLICY[Default-deny Policy Gateway]
  POLICY --> APPROVAL[Scoped approvals]
  APPROVAL --> EXEC[Capability adapters]
  EXEC --> VERIFY[Outcome verification]
  VERIFY --> JOURNAL[Task journal and recovery]
  CONV --> PROMPT[Prompt registry and contracts]
  CONV --> MEMORY[Memory Manager]
  MEMORY --> STORE[Encrypted personal memory]
  MEMORY --> RETRIEVE[Semantic and lexical retrieval]
  CONV --> ROUTER[AI Provider Router]
  ROUTER --> OLLAMA[Native Ollama Provider]
  ROUTER -. explicitly authorized .-> CLOUD[Optional cloud providers]
  OLLAMA --> MODEL[llama3.2:latest]
  CORE --> AUDIT[Tamper-evident audit]
  EXEC --> AUDIT
  APPROVAL --> AUDIT
~~~

## 3. Source module map

| Area | Responsibility |
|---|---|
| `src/server`, `src/index.ts` | HTTP server, routes and startup |
| `src/core`, `src/config` | Core orchestration and runtime configuration |
| `src/ai` | Provider contract, Ollama, routing and shared client |
| `src/conversation` | Chat handling, sessions, prompts and agents |
| `src/planner`, `src/policy` | Intent/task plans and default-deny authorization |
| `src/adapters`, `src/capabilities` | OS/application capabilities and executors |
| `src/stores`, `src/crypto`, `src/audit` | Persistence, encryption, identity and audit |
| `src/memory` | Working/long-term memory, semantic index and learning candidates |
| `src/workflows`, `src/scheduler` | Workflow definitions, dependencies, scheduling and coordination |
| `src/voice` | Wake, capture, transcription and speech lifecycle |
| `src/companion`, `src/android`, `src/sync`, `src/peers` | Companion clients and device synchronization |
| `src/plugins`, `src/developer` | Data-only plugins and scoped developer assistant |
| `src/gateway` | Separate website AI gateway |
| `src/resources`, `src/verification` | Resource profiles and outcome verification |

This is a responsibility map, not a reason to create duplicate services. Extend existing modules first.

## 4. AI provider architecture

`src/ai/aiProvider.ts` defines the provider contract. `src/ai/ollamaProvider.ts` implements native Ollama chat and health/model checks. `src/ai/providerRouter.ts` selects a provider using task type, privacy classification, configuration and explicit cloud authorization. `src/ai/providerClient.ts` is the shared transport boundary for conversation and agent callers.

The abstraction is designed to accommodate future OpenAI, Gemini and Anthropic adapters without changing business APIs or the HUD. Provider wire formats belong inside adapters.

### Ollama defaults

~~~dotenv
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_TIMEOUT=120
~~~

The native provider calls `POST /api/chat` with normalized role/content messages, generation options and the requested stream mode. It validates response shape, bounds output, classifies timeout/network/HTTP failures, uses bounded retry behavior for retryable failures and logs operational metadata without prompts or secrets.

Timeout is seconds, constrained to 1–600. Streaming uses Ollama newline-delimited JSON when the caller already supports streaming. Health/model checks prove provider availability, not end-to-end workflow acceptance.

Legacy `JARVIS_AI_BASE_URL` and `JARVIS_AI_MODEL` are compatibility fallbacks; new installations should use `OLLAMA_*`.

### Routing and privacy

- Local Ollama is the primary provider and default for private conversation, memory-bearing context and local tasks.
- Remote providers are unavailable unless configured and explicitly authorized for the relevant task type.
- No automatic cloud fallback may transmit private memory/history without authorization.
- Provider failure must be surfaced or handled by a deterministic safe fallback; never silently relax privacy.
- Model output cannot authorize an action, grant a capability or approve a task.

## 5. Conversation, prompts and agents

1. An authenticated client submits the existing signed request.
2. The server classifies it as an action request or conversational request.
3. Action requests continue through planner, capability allowlists, Policy Gateway, approvals and executor. Chat is not an alternate execution path.
4. Conversation requests obtain bounded device/conversation history and authorized memory context.
5. Versioned prompt profiles construct role-separated system, developer and user messages.
6. The provider returns text or structured output.
7. Structured agent output is parsed and validated before downstream use.
8. Existing API response shape and conversation identifiers are preserved.

Specialized agents are advisory workers under a central orchestrator. Tool-selection candidates and task plans are validated against trusted capability and dependency registries. Agents have no direct host execution authority.

## 6. Memory and learning

- **Conversation history:** bounded and isolated by device/conversation; process-local, expires after about 30 minutes and is not restored after server restart.
- **Working memory:** short-lived RAM context.
- **Long-term memory:** encrypted local storage with categories, provenance, owner review, retention and deletion controls.
- **Semantic index:** local Ollama embeddings where configured, combined with lexical overlap and recency; lexical fallback remains available.
- **Learning candidates:** encrypted, attributed candidates from feedback/useful interactions, awaiting owner approval.

~~~mermaid
flowchart TD
  Q[Authenticated request] --> S[Device and conversation session]
  S --> W[Working memory]
  Q --> MM[Memory Manager]
  MM --> LS[Encrypted long-term store]
  MM --> EMB[Local embeddings and lexical retrieval]
  LS --> R[Rank, filter and bound context]
  EMB --> R
  W --> R
  R --> P[Untrusted memory context]
  P --> AI[Ollama chat]
  AI --> RESP[Assistant response]
  RESP --> S
  RESP --> CAND[Learning candidate and feedback]
  CAND --> REVIEW[Owner review]
  REVIEW -->|Approved| LS
  REVIEW -->|Rejected| DISCARD[Discard]
~~~

Retrieved content is untrusted data, never system instructions. JARVIS does not automatically fine-tune or modify model weights.

**RAG boundary:** current retrieval is personal-memory RAG, not general document RAG. Document ingestion, parsing, chunking, document ACLs, source citations and document lifecycle remain future work. A database is not required merely to use Ollama.

## 7. Task execution and concurrency

Every state-changing operation remains governed by planner/policy/approval/executor. Current coordination design includes bounded planner/provider admission, bounded adapter queues, global active adapter limit 4, per-device limit 2, interactive priority with aging, duplicate admission rejection, re-entrancy protection, atomic canonical resource locking, cooperative cancellation and guaranteed lock release.

Resource keys cover shared desktop/app control, memory, plugin/workflow registries and workspace/file operations. The lock protocol avoids circular wait caused by partial lock acquisition; it does not detect arbitrary deadlocks inside an OS or third-party app.

The workflow DAG executor supports bounded concurrent branches, branch-scoped approval references, serialized checkpoints, resource exclusion, dependency-aware joins, partial outcomes and explicit no-effect reconciliation. A branch left running after restart becomes uncertain and is never replayed automatically.

**Integration limitation:** the live `workflow:run` service route still uses its sequential lifecycle at this checkpoint. Do not claim saved workflows execute concurrently until the branch executor is wired through child task records, encrypted journal, policy approval consumption, audit and independent outcome verification.

## 8. Cross-platform strategy

| Platform | Intended implementation | Current boundary |
|---|---|---|
| Windows desktop | Shared core + native process/window/UI Automation adapters | Primary host |
| macOS desktop | Shared core + native accessibility adapters | Not implemented/validated |
| Linux desktop | Shared core + accessibility/portal adapters | Not implemented/validated |
| Android | Kotlin client, Android Keystore and native adapters | Source exists; build/device acceptance required |
| iOS | Swift/SwiftUI, Keychain/Secure Enclave where available | Not implemented |

Capabilities declare supported OS/version/architecture, permissions, foreground/background/offline behavior, risk tier, approval requirement, verification method and evidence. Platform independence means shared contracts and tested native adapters, not one binary for all systems.

## 9. Website AI gateway

The optional gateway is a separate listener with OpenAI-compatible `/v1/chat/completions`, `/v1/models` and `/v1/health` routes. Per-site bearer keys are stored as hashes, revealed once and individually revocable; rate and output limits apply. It is text-only and cannot access planner, tools, personal memory, device control or owner routes. Only this separate listener may be considered for approved HTTPS tunnel exposure.

## 10. Decision rules

- Reuse existing business services and API contracts.
- Avoid unnecessary frameworks, microservices, databases and worker threads.
- Do not create unbounded queues or threads.
- JavaScript async I/O concurrency is not CPU parallelism.
- Multi-process deployment requires a transactional shared queue/lease and state store; current coordination is process-local.
- A successful build is not device or release acceptance.
