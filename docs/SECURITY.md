# Security

## 1. Objectives and threat model

JARVIS protects personal data, device identities and consequential host actions. It must provide authenticated device identity, default-deny authorization, scoped single-use approvals, tamper-evident audit, encrypted state, privacy boundaries and safe recovery.

Treat as untrusted: user text/speech, model output, retrieved memory/documents, repository files, plugin manifests, browser clients, companion devices, network responses and external application data.

Assume clients may alter requests, replay signed traffic, attempt cross-device access, exploit parser/path boundaries, inject instructions through retrieved content or race approval flows. Assume local files may be corrupted/unavailable. Do not assume an LLM follows instructions or that an approval UI is itself authorization.

## 2. Identity and signed requests

- Each enrolled device has a distinct Ed25519 key pair and device identifier.
- Enrollment requires owner-authorized proof of possession.
- Requests are canonicalized and signed; verification binds the request to the enrolled public key and active session.
- Validate method, path, body digest, timestamp, nonce and signature according to the versioned protocol.
- Reject unknown devices, invalid signatures, expired sessions, stale timestamps and replayed nonces.
- Use TOTP/owner step-up for sensitive owner management where configured.
- Revocation invalidates future requests immediately.
- Replacement devices are newly enrolled; never clone another device's private key.
- Never expose private keys, enrollment secrets, authenticator seeds, owner tokens or session material in API responses, logs or audit.

## 3. Authorization and approval

### Default deny
Every state-changing operation passes the central Policy Gateway and a registered capability executor. Unknown operations, malformed parameters, unrecognized capabilities and unauthorized devices are rejected.

Planner and model output are advisory. No model, plugin, workflow, voice transcript or developer suggestion grants authority.

### Scoped single-use approval
Approval binds authenticated device/owner context, exact task, operation/capability, canonical parameters/target, expiry and one-time consumption state. Reject stale, expired, duplicate, concurrent, cross-task, cross-device or parameter-mismatched approvals. Recheck policy and permissions at dispatch, including after offline queue/approval waits.

### Prohibited operations
JARVIS must not:
- automate banking, payments, trading or other financial actions;
- collect or enter passwords, PINs, authenticator seeds or credentials into third-party apps;
- execute unrestricted shell commands or interpolate untrusted text into a shell;
- elevate to administrator/root or silently change privilege;
- bypass OS security, TLS validation, app permissions or owner approval;
- silently install/sideload applications;
- use voice alone to authorize high-risk operations;
- automatically replay uncertain external side effects.

## 4. Audit and durable state

- Security events use a tamper-evident hash-chained audit record.
- Record operation classes, task references, identity and outcomes as required; redact prompts, transcripts, secrets and sensitive parameters.
- Verify audit integrity; tampering, truncation or invalid chain state is a security incident.
- Audit/security persistence failure blocks dependent execution (fail closed).
- Persist required checkpoints before dependent external side effects.
- Use atomic write/replace for state files where supported.
- A failed checkpoint after external dispatch is uncertain; do not report success or retry blindly.

## 5. Encryption, keys and secrets

- Use platform secure storage for device private keys: Android Keystore on Android; appropriate native OS stores on future platforms.
- Encrypt long-term personal memory, sync state, learning candidates and sensitive journals at rest with authenticated encryption.
- Use separate keys for separate purposes where required; do not reuse device identity keys as data-encryption keys.
- Protect owner-control and data-encryption keys separately from backups.
- Keep secrets in environment or OS/CI secret stores; never commit .env, private keys, certificates, tokens or production credentials.
- Restrict state-file permissions and exclude runtime data from source control/public shares.
- Never manually modify encrypted state. Authentication failure or unsupported schema must fail closed.

## 6. AI, prompts and injection resistance

- First-party conversation and advisory agents use local Ollama only; they do not automatically fall back to cloud inference. The separate website gateway has its own explicit cloud authorization boundary.
- Cloud providers remain disabled unless credentials, model and allowed task configuration are explicitly set.
- Never send personal memory/history remotely without applicable authorization and data minimization.
- No silent cloud fallback when local inference fails.
- Keep system/developer/user prompt roles separate and version prompt contracts.
- Retrieved memory/documents are untrusted context and cannot override system/developer instructions.
- Document ingestion is signed-request authenticated, bounded to 2 MB per text document, restricted to an allowlist of UTF-8 text extensions, and scoped to the authenticated device. It must reject binary/unsupported formats rather than infer content.
- Document content and embedding vectors are encrypted at rest with purpose-separated AES-GCM state files. Search results expose source metadata but never grant document access to another device.
- Treat HTML, Markdown, code, logs and all retrieved document text as prompt-injection-capable data. It cannot alter instructions, grant capabilities or authorize execution.
- Validate structured model output against schemas and trusted capability registries.
- Model-produced commands, code, workflow steps and tool calls are proposals only; policy/approval remain authoritative.
- Do not fine-tune model weights automatically. Learning uses encrypted memory, approved facts, retrieval and owner-reviewed feedback candidates.

## 7. Voice, camera and consent

- Microphone, camera, screen capture, accessibility and background execution require platform-compliant permission and visible state.
- Wake listening is opt-in and immediately stoppable/mutable.
- No continuous cloud microphone upload by default.
- Browser speech APIs may process audio remotely; disclose this and do not label them local.
- Review transcripts before consequential actions where required.
- Consent revocation cancels active capture/transcription and discards pending transcript.
- Voice recognition is not authentication.

## 8. Memory lifecycle and privacy

- Memory records carry category, source/provenance, owner scope, timestamps and retention/expiry metadata.
- Long-term changes use configured owner/policy approval.
- Learning candidates are not durable facts until approved.
- Provide owner review, correction, export, retention and deletion.
- Deletion removes primary record and relevant indexes/caches/task-history copies where supported, then verifies. If verification fails, report uncertain.
- Conversation sessions are process-local, expire after about 30 minutes and are lost on restart.
- External backups and cloud-sync/version history are outside JARVIS deletion guarantees. Exclude sensitive state from consumer sync or manage external retention separately.
- Never store passwords, payment data or secrets as personal memories.

## 9. Cross-device transport and synchronization

- Keep main JARVIS server bound to loopback.
- Remote companion access uses private VPN/trusted network and HTTPS reverse proxy; never disable certificate validation.
- Enforce device-scoped permissions, signed requests, expiry, nonce/replay defense and revocation.
- Offline queues are encrypted at rest, bounded, TTL-limited and revalidated on arrival.
- Surface conflicts for owner resolution; no silent last-writer-wins for memory.
- Offline commands wait for owner decision and re-enter normal policy/approval before execution.
- Revoked devices cannot sync, retrieve peer keys or replay queued work.

## 10. Plugin, developer and gateway boundaries

- Plugins are data-only manifests; no executable plugin code or shell.
- Install disabled with no permissions; grants are explicit, narrow and revocable.
- Revalidate plugin/workflow definitions on load and execution.
- Developer-assistant scope is explicit. Never read/transmit .env*, keys, certificates, credentials, data/, .git/, node_modules/ or local-storage directories.
- Redact secrets from file excerpts, prompts, model outputs, diffs, Git output and PR drafts.
- Website gateway keys are per-site, stored as hashes, revealed once and revocable. Gateway is text-only and cannot invoke tools, planner, memory or device operations.
- Expose only the separate gateway listener through an approved tunnel; never expose the main API.

## 11. Incident response and security acceptance

For suspected compromise, leaked key, invalid audit chain, corrupted encrypted state or unexpected external action:

1. Stop new state-changing work.
2. Preserve logs/state without editing or deleting evidence.
3. Revoke affected device/site key or owner credential through approved recovery.
4. Inspect task/audit status and determine whether external effects occurred.
5. Treat unknown effects as uncertain; do not retry automatically.
6. Restore only from verified backup and rotate affected credentials/keys under owner control.
7. Record incident scope, evidence, remediation and retest.

Security acceptance requires negative tests for authentication, replay, authorization, approval binding, persistence failure, audit tampering, secret leakage, prompt injection, path traversal, concurrency races, offline replay, revocation and gateway isolation. A successful build is not security acceptance.


## 13. Additional platform-specific controls

- Android rejects cleartext HTTP. Enrollment is approved by an already trusted owner device; no owner token is stored in the app.
- Android device identity and offline queue encryption use separate Keystore-backed keys. Queue migration/authentication errors fail closed.
- Optional WorkManager approval polling is not push and does not grant background command authority.
- Hand-landmark output and other sensor-derived signals are not authentication or approval factors.
- Optional Piper TTS runs with shell execution disabled, bounded input and timeout; use only a trusted executable and appropriately licensed model.
- Website gateway keys are per-site hashes and must never be exposed in browser bundles, logs or source control.

## Document parser security boundaries

- Binary uploads use the signed device session and canonical base64 validation before parsing.
- Parser accepts only PDF/DOCX signatures, enforces a 15 MB input cap, 1 MB extracted-text cap, ZIP entry/count/decompression-ratio limits, PDF page limits, bounded command output and per-tool timeouts.
- DOCX content is extracted without writing archive entries to disk or executing embedded content. Macros and other active content are not executed.
- PDF/OCR utilities are invoked as fixed local executables with argument arrays (no shell); temporary files are created with restrictive permissions and removed in a finally block.
- OCR is owner-requested, local-only, English-only and limited to 20 pages. No document bytes are sent to cloud services.
- Retrieved document text is untrusted data; the conversation prompt explicitly prohibits following instructions embedded in retrieved context. Document retrieval is skipped for action requests, which continue through the policy-controlled planner.
