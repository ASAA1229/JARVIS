# Device Sync, Offline Queues and Conflicts (JARVIS-US-060 / US-027)

Status: implemented in source, **not yet tested** (development-only phase).

## Modes

| Mode | How it works | Source of truth |
|---|---|---|
| Laptop hub (default) | Phones push/pull over the signed companion API | Laptop |
| Offline queue | Phones queue changes with a sequence number and TTL; pushed when the hub is reachable | Laptop, after revalidation |
| Peer-to-peer (optional) | Devices that negotiated `p2p-envelope` exchange signed envelopes; LAN discovery/transport is future work | Laptop, when next reachable |

Capabilities are negotiated with `POST /api/sync/capabilities` (`hub-sync`, `offline-queue`, `p2p-envelope`).

## Endpoints (all require the device's signed session)

| Route | Who | Purpose |
|---|---|---|
| `POST /api/sync/capabilities` | any active device | Negotiate capabilities |
| `POST /api/sync/push` `{ changes }` | any active device | Up to 50 offline changes |
| `GET /api/sync/pull?since=<ms>` | any active device | Permitted memory index + changed records + own open conflicts |
| `GET /api/sync/peers` | p2p devices | Enrolled public keys of other p2p devices (revoked devices never listed) |
| `GET /api/sync/overview` | DEVICE_MANAGE | Devices, last sync, open conflicts, queued commands (HUD "Sync & conflicts") |
| `POST /api/sync/conflicts/resolve` `{ id, resolution: keep_hub\|keep_device\|merge, mergedContent? }` | DEVICE_MANAGE | Owner decides |
| `POST /api/sync/commands/decide` `{ id, decision: run\|discard }` | DEVICE_MANAGE | Owner runs or discards an offline command |

## Change format

```json
{ "changeId": "8-64 chars [A-Za-z0-9_-]", "deviceSeq": 12, "createdAt": 1794000000000, "ttlSeconds": 86400,
  "op": "memory.create | memory.update | memory.delete | command.queue",
  "category": "preference|project|routine|general", "memoryId": "32 hex", "baseUpdatedAt": 1794000000000,
  "content": "...", "text": "..." }
```

`baseUpdatedAt` is the hub record's `updatedAt` the device last saw (its version).

## Rules

- **Revalidation on arrival:** device must be active (revoked → 401/403); TTL ≤ 7 days and not expired; `createdAt` not in the future; payload bounds; per-device monotonic `deviceSeq` and a recent `changeId` window make replays `duplicate`.
- **Permissions:** long-term memory is owner data. Only devices with `DEVICE_MANAGE` sync memory categories; others get an empty index and their memory changes are rejected.
- **No silent writes:** accepted memory changes are submitted through the planner/policy gateway (`remember …`, `update memory … to …`, `forget memory …`) and need the owner's approval. Deletion then also scrubs task-history and Memory Manager copies.
- **Conflicts, never last-writer-wins:** a stale base becomes a stored conflict (`concurrent_update`, `deleted_on_hub`, `update_vs_delete`). Only byte-identical content is auto-resolved (`no_op`). Resolving with keep_device/merge again goes through approval; resolved conflicts keep no text.
- **Offline commands** are held as "waiting for owner" and are never executed automatically; running one submits it through policy/approval with the owner's session. Expired commands expire; commands and conflicts from revoked devices are discarded and audited.
- **Encryption and audit:** sync state (`data/device-sync.enc`) is AES-256-GCM with a key derived from the owner control token; audit records hold counts/ids/outcomes only.

## Peer envelope

```
{ v:1, from, to, seq, issuedAt, expiresAt (≤24h), type: sync.changes|sync.ack|presence,
  payload: base64(JSON, ≤64 KiB), payloadSha256, signature }
signature = Ed25519(sender device key) over
  "JARVIS_PEER_V1\nv\nfrom\nto\nseq\nissuedAt\nexpiresAt\ntype\npayloadSha256"
```

Receivers verify against the hub-issued peer list, check recipient, expiry, payload hash and that `seq` is higher than the last seen from that sender (`src/sync/peerEnvelope.ts`). Envelope contents are pushed to the hub when it is reachable; the hub's rules above still apply.

## Android

`SyncClient.kt` keeps a private queue file (sequence, TTL, max 200 changes), pushes in batches of 50, pulls since the last server time and surfaces open conflicts. `JarvisApiClient` gains `syncNegotiate`, `syncPush`, `syncPull` (query string is not part of the request signature).

## What to test (pending)

- Unit: `test/device_sync.test.ts` (written, not run).
- Integration: signed push/pull/overview/resolve/decide over HTTP; revoked device rejected.
- Two-phone: enroll both phones; edit the same memory offline on both; reconnect; confirm one change goes to approval and the other becomes a conflict; resolve each way; revoke phone A and confirm its queued commands/conflicts are discarded while phone B keeps syncing; confirm phone B without DEVICE_MANAGE syncs no memory.
- P2P: exchange an envelope between phones, then reject a tampered and a replayed one.
