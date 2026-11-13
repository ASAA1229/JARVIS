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
JARVIS_EMBED_MODEL=nomic-embed-text
~~~

The native provider calls `POST /api/chat` with normalized role/content messages, generation options and the requested stream mode. Non-streaming and NDJSON streaming responses are byte-bounded; streaming must end with Ollama's explicit `done` event. HTTP status, timeout, network and malformed-response errors are classified, retry is bounded to one attempt for transient gateway statuses, and logs contain operational metadata only. Live health checks separately report chat-model and optional embedding-model availability.

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

- **Conversation history:** bounded and isolated by device/conversation; when owner control is configured, AES-256-GCM encrypted local persistence restores active sessions after restart. Sessions expire after about 30 minutes. Without owner control, history remains process-local.
- **Working memory:** short-lived RAM context.
- **Long-term memory:** encrypted local storage with categories, provenance, owner review, retention and deletion controls.
- **Semantic index:** local Ollama `POST /api/embed` embeddings using `JARVIS_EMBED_MODEL` (default `nomic-embed-text`) where installed, combined with lexical overlap and recency; lexical fallback remains available.
- **Learning candidates:** encrypted, attributed candidates from feedback/useful interactions, awaiting owner approval.
- **Learning quality:** the owner evaluation path reruns the actual ranked long-term retriever for a supplied query and compares returned memory IDs with owner-labelled relevant IDs. Precision@K, Recall@K, MRR, helpful/correction rates and candidate approval rates are stored as encrypted aggregates; query text and memory IDs are not persisted in quality telemetry. A versioned synthetic benchmark fixture provides deterministic offline regression coverage; it is not a substitute for an owner-labelled production corpus.

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

**Document RAG:** `src/memory/documentRagStore.ts` provides encrypted local storage, per-device document ownership, bounded chunking, duplicate detection, lexical retrieval and optional loopback-Ollama embeddings. Signed routes expose ingest, search, list and delete. Conversation requests retrieve up to three document chunks alongside a bounded personal-memory context; returned API metadata includes source filename, title, document ID and chunk position. Retrieved content remains untrusted data. The current ingestion contract accepts UTF-8 TXT, Markdown, CSV, JSON, LOG, YAML, XML and HTML text only; PDF/DOCX and image OCR parsing are not implemented. The index is local and encrypted; no database is required.

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


## 11. Companion and synchronization contracts

The laptop is the default source of truth. Companion capabilities are negotiated through signed sessions. Current sync route family:

| Route | Purpose |
|---|---|
| `POST /api/sync/capabilities` | Negotiate hub-sync, offline-queue and p2p-envelope capabilities |
| `POST /api/sync/push` | Submit up to 50 queued changes |
| `GET /api/sync/pull?since=<ms>` | Retrieve permitted memory changes and the requesting device's conflicts |
| `GET /api/sync/peers` | Retrieve enrolled public keys for negotiated peer-envelope devices |
| `GET /api/sync/overview` | Owner view of devices, sync state, conflicts and queued commands |
| `POST /api/sync/conflicts/resolve` | Owner resolution: keep hub, keep device or merge |
| `POST /api/sync/commands/decide` | Owner chooses run or discard for a queued command |

Arrival validation includes active device state, TTL no greater than seven days, non-future creation time, payload bounds, monotonic per-device sequence and replay/change-ID checks. Memory sync is restricted to devices with DEVICE_MANAGE. Memory mutations still pass through planner/policy/approval. Conflicts include concurrent update, deleted-on-hub and update-vs-delete; no last-writer-wins. Offline commands remain waiting for owner decision.

Android SyncClient bounds its encrypted queue to 200 changes, pushes in batches of 50 and uses a separate AES-GCM Android Keystore key. Queue authentication/schema failures stop sync rather than silently resetting state. Peer envelopes are signed by the sender, recipient-bound, expire within 24 hours and include a payload hash and monotonic sequence. LAN discovery/transport remains future work.

## 12. Plugin and workflow model

A workflow is a versioned template of 1–20 steps with unique IDs and acyclic dependencies. Steps must be allowlisted by both planner and policy gateway with permitted parameter keys. Workflow/plugin recursion and self-escalation are prohibited. Each version is appended; history is not rewritten. AI drafts are advisory and cannot run until validated and owner-approved. Existing built-ins include morning-brief and open-dev-workspace.

Plugins are data-only manifests, not executable packages. Installation starts disabled with no grants; each permission is explicitly granted, revocable and checked on every load. Invalid or unknown manifest fields, unsupported versions, restricted capabilities and unapproved permission requests fail closed. Plugin state and workflow state are persisted separately in local state files.

The developer assistant operates only on explicitly connected repositories and granted scopes:
- read: bounded tree/file/search and Git status/log/diff;
- suggest: model-generated explanations and draft diffs;
- git-write: apply reviewed suggestion, create feature branch, commit or push feature branch;
- ci: read recent CI status when GitHub CLI is available.

Model suggestions never apply/commit/push themselves. Applying, branch creation, commit and push are separately approved. Protected branches and secret/runtime paths are blocked.

## 13. Voice and hand-landmark components

Optional local Piper TTS is invoked by the authenticated signed voice-synthesis route. Input is capped at 1,200 characters; subprocess execution uses no shell; WAV output is validated; response audio is no-store. A 20-second generation timeout applies. If local TTS is unavailable, the HUD can fall back to browser speech synthesis. Browser speech processing may be remote and is not equivalent to local STT.

The bundled MediaPipe Hand Landmarker full-float16 model is served locally rather than fetched from a CDN at runtime. The documented upstream model card identifies Apache-2.0 licensing; the recorded bundle SHA-256 is `fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1`. Verify source, license, digest and compatibility before replacing it. Hand landmarks are experimental under difficult camera conditions and must never be used as an authorization signal.

## Binary document ingestion

The local DocumentParser accepts PDF and DOCX files before encrypted RAG ingestion. DOCX main-document XML is extracted in-process using bounded ZIP/DEFLATE handling. PDF text extraction uses the local Poppler `pdftotext` utility. Scanned PDFs can use opt-in OCR through local Poppler `pdftoppm` plus Tesseract; document bytes are not sent to a cloud OCR provider. Retrieved chunks retain document, filename, and chunk-position citations.
