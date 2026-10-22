# ADR-001: Technology Stack Selection for JARVIS POC

## Status
Accepted

## Context
JARVIS requires:
1. Windows 11 Home host application operating as a secure modular core.
2. Android companion application (minimum 1, architected for 2 independent phones).
3. Secure local/remote communication with mutual authentication, encrypted channel, and zero public exposure.
4. Default-deny policy gateway with strictly bounded execution adapters (read-only Windows system facts, selected app launching).
5. Replaceable AI planner with structured output validation, offline safe mode, and strict data minimization.
6. Privacy-conscious audit trail, verification, and recovery mechanisms.
7. Zero paid API keys required for development baseline; low resource footprint on Windows 11 Home laptop.

Host environment available:
- Node.js v24.16.0 & npm 11.13.0
- Python 3.14.7
- .NET 11.0 SDK preview
- Java 21 LTS

## Options Considered

### Option A: Python-only Stack (FastAPI/Aiohttp + Pydantic + PyCryptodome)
- **Pros**:
  - Python is present (Python 3.14.7).
  - Pydantic offers structured schemas and validation.
  - Good for future local AI/ML pipelines (Ollama, llama.cpp-python, transformers).
  - Easy cross-platform scripting.
- **Cons**:
  - Python 3.14.7 is a very bleeding-edge alpha/preview release where some binary C-extensions (like certain cryptography wheels or native win32 packages) may fail or require compilation tools.
  - Distribution and bundling as a background service or desktop UI on Windows Home requires PyInstaller or similar heavyweight packaging.

### Option B: Node.js / TypeScript Core + Web Companion / Capacitor / React Native
- **Pros**:
  - Node.js v24.16.0 and npm 11.13.0 are installed, stable, and have first-class built-in `node:crypto` (Ed25519, X25519, AES-256-GCM, HMAC-SHA256, HKDF) without needing C-extensions.
  - Fast modular architecture: TypeScript enables end-to-end type safety across the core domain, schemas, policy gateway, and adapters.
  - Built-in SQLite via `node:sqlite` in modern Node 22/24 allows zero-dependency relational persistence and audit integrity logging.
  - Web companion UI (PWA / Mobile web view) easily accessible from Android phones via local Wi-Fi / WireGuard / Tailscale overlay, with biometric WebAuthn / Passkeys and Web Crypto API.
  - Modern, responsive desktop UI can be served locally (Fastify / Express / native HTTP) with low resource overhead (< 60MB RAM).
- **Cons**:
  - Needs careful Windows API integration (child_process with strict argument arrays, no shell: true).

### Option C: .NET / C# Core + MAUI / Kotlin
- **Pros**: Strong Windows integration.
- **Cons**: .NET installed is an unreleased preview (`11.0.100-rc.2.26504.105`), higher setup ceremony, more complex for rapid cross-device companion iteration.

## Decision
We select **TypeScript / Node.js (v24.16.0)** for the Windows Core Host modular monolith:
1. **Core Runtime**: Node.js v24 with TypeScript (`tsx` for dev runtime, strict compilation).
2. **Persistence**: SQLite (using Node's robust SQLite capabilities or clean sqlite3/better-sqlite3) + structured JSON/WAL for tamper-evident audit logs with hash chains.
3. **Cryptography**: Native `node:crypto` using standard Ed25519 / X25519 device keys and AES-256-GCM authenticated encryption.
4. **Networking & Local Communication**:
   - HTTP/2 & WebSockets over TLS / authenticated local mutual token/HMAC challenge-response.
   - Zero-trust network model (untrusted network assumption, all payloads signed/authenticated with device keys).
5. **Companion UI**: Responsive, secure Web Companion (PWA-ready with Web Crypto API and Camera QR scanner for single-use enrollment), fully accessible from Android browsers or wrapped in Android WebView/Capacitor, ensuring immediate compatibility with Android devices without requiring heavy native compilation chains.
6. **Execution Adapters**:
   - Windows System Info: explicit allowlist of WMI / PowerShell read-only commands executed through safe, parameter-sanitized exec files (`cmd.exe /c` avoided, direct executable invocation with strict argument arrays only).
   - App Launcher: explicit allowlist of registered Windows applications (e.g., Notepad, Calculator, Paint), verifying process spawn without shell interpolation.

## Consequences
- Fast developer loop, 100% automated testability using native test runner (`node:test` or `vitest`).
- Zero paid dependencies.
- Strict isolation of AI advisory layer from execution adapters.
