# Personal Memory — Retention, Deletion and Backups

## Where memory lives
| Store | File (default) | Contents | Protection |
|---|---|---|---|
| Personal memory | `data/personal-memory.enc` | Saved facts/preferences | AES-256-GCM, key derived from `JARVIS_OWNER_CONTROL_TOKEN` |
| Task journal | `data/tasks.enc` | Task history incl. memory requests and list results | AES-256-GCM, same owner token |
| Audit log | `data/audit.log` | Event metadata (memory id, category, outcome) — never memory text | Hash-chained, tamper-evident |
| Conversation sessions | process memory only | Recent chat turns for continuity | Bounded, expire, never written to disk |
| Site AI gateway | — | Never receives personal memory | — |

## Retention
- Memories have no expiry unless saved with a TTL (1–3650 days); expired records are removed on the next read or save.
- Credentials, payment data and instruction-like text are refused at save time.
- Only devices with `DEVICE_MANAGE` can save, correct, list or delete memories, and each change needs approval.

## Deletion ("forget memory <id>")
1. The record is removed and the encrypted file is rewritten atomically.
2. The file is re-read and decrypted to verify the record is gone (`diskVerified`).
3. Task history is scrubbed: memory save/update requests and stored memory-list results that contain the memory are redacted to `[deleted personal memory]` and the encrypted journal is rewritten (`secondaryTasksScrubbed`).
4. If either step cannot be confirmed the task is reported **UNCERTAIN**, not successful.
5. The audit log keeps that a deletion happened (memory id, outcome) but never the text.

Limits: an assistant reply already shown in a live conversation may have quoted a memory; conversation sessions are in-memory only and expire, and restarting JARVIS clears them immediately.

## Backups
JARVIS makes no backup copies. Copies made outside JARVIS (OneDrive/File History sync of the `data/` folder, manual copies) are **not** reached by deletion. Exclude `data/` from cloud sync, or treat synced versions as containing deleted memories until they age out of the sync service's version history.
