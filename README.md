# JARVIS

**JARVIS is a local-first personal AI operating assistant** combining conversational AI, voice interaction, a desktop HUD, guarded application control, multi-step workflows, encrypted personal memory and separately enrolled companion devices.

The project is intended to evolve into a cross-platform personal AI operating system. It is not an unrestricted remote-control tool: capabilities depend on the operating system, available APIs, permissions and owner authorization.

## What it does

- **Chat and agents:** local-first conversational AI using Ollama and `llama3.2:latest`, versioned prompts, structured agent responses and replaceable provider interfaces.
- **Voice and HUD:** browser-based desktop HUD, text input, push-to-talk and consent-aware voice lifecycle; optional local wake-word, speech recognition and Piper speech output.
- **Desktop automation:** discover and launch supported applications, interact with selected UI controls and verify outcomes where platform adapters permit.
- **Tasks and workflows:** plan work, enforce dependencies, request scoped approvals, checkpoint progress, cancel work and expose uncertain outcomes for owner reconciliation.
- **Memory and learning:** bounded conversation context, encrypted long-term personal memory, semantic/lexical retrieval, owner-reviewed learning candidates and feedback.
- **Companion devices:** native Android foundation for independent enrollment, approvals, notifications and bounded synchronization.
- **Owner tools:** data-only plugins, versioned workflows, workflow composition, developer-assistant drafts, memory management and an isolated website AI gateway.
- **Release integrity:** build provenance, SHA-256 inventories and offline customer verification utilities.

## Current implementation boundary

The shared core is a Node.js 24 / TypeScript modular monolith. The primary host adapter is Windows-focused and an Android companion exists. macOS and Linux desktop adapters exist behind the fail-closed contract but are IMPLEMENTED — NOT TESTED (mocked runner, no hardware); iOS is not implemented. None is an accepted implementation. Android build/two-phone acceptance, target-Windows voice/automation acceptance and exact-head release validation require separate evidence.

The concurrent workflow DAG executor is integrated with the live workflow route, isolated child tasks, policy approvals, encrypted checkpoints, audit and outcome verification; exact-head CI and crash/restart acceptance are still required. Learning quality metrics are connected to the ranked retriever and a versioned synthetic benchmark; representative owner-labelled evaluation and regression thresholds remain outstanding. Document RAG and PDF/DOCX/local OCR parser sources exist; their adversarial, relevance, deletion and real-environment acceptance remain separate gates.

**Source presence is not release readiness.**

## Quick start — Windows PowerShell

Prerequisites: Node.js 24, npm, Git, Ollama and Windows 11 for the current desktop adapter.

Install the model and configure:

~~~powershell
ollama pull llama3.2:latest
Copy-Item .env.example .env
node scripts/configure-owner-token.mjs
npm ci
~~~

Run validation and start:

~~~powershell
npm run build
npm run lint
npm test
npm run test:browser
npm run test:ollama
npm start
~~~

Open http://127.0.0.1:3000/. Keep the main JARVIS API bound to loopback. Protect .env, owner-control material, keys and runtime data; never commit them.

## Configuration

~~~dotenv
OLLAMA_URL=http://localhost:11434
OLLAMA_MODEL=llama3.2:latest
OLLAMA_TIMEOUT=120
JARVIS_EMBED_MODEL=nomic-embed-text
~~~

See `.env.example` for all settings.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — components, AI providers, Ollama, agents, memory, retrieval, concurrency and platform strategy.
- [POC](docs/POC.md) — current capability baseline, constraints and acceptance gates.
- [User Stories](docs/USER_STORIES.md) — outcome-based stories and acceptance criteria.
- [Gap Analysis](docs/GAP_ANALYSIS.md) — prioritized delivery gaps and closure sequence.
- [Project Status](docs/PROJECT_STATUS.md) — authoritative maturity scores, gap register and current evidence.
- [Release Readiness](docs/RELEASE_READINESS.md) — release gates and current GO/NO-GO decision.
- [Requirements](docs/REQUIREMENTS.md) — consolidated product scope, constraints and acceptance criteria.
- [Development](docs/DEVELOPMENT.md) — workstation setup, commands, branch policy and testing.
- [Operations](docs/OPERATIONS.md) — startup, monitoring, backup, recovery, connectivity and release procedures.
- [Security](docs/SECURITY.md) — trust model, authorization, privacy, cryptography and prohibited operations.

## Project status

JARVIS is an evolving development project and is **not declared production-ready**. Every validation claim must identify the exact commit, environment, command/scenario, result and limitations. Automated CI, Windows host acceptance, Android physical-device acceptance and production release approval are distinct gates.
