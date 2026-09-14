# Browser persistence and sync protocol

## Browser persistence

The fresh account-scoped IndexedDB schema is version 1, with exactly three stores:

| Store | Contents |
| --- | --- |
| `updates` | Binary current-state Yjs updates; compacted at 500 entries or after permanent deletion/recovery |
| `pendingEdits` | Per-page `{ modifiedAt: { sourceId: timestamp } }`, without historical text or anchors |
| `maintenance` | The validated log-tail key following sanitization, and an initial-sync-complete marker |

A fresh browser cache keeps the notes view loading until the first server snapshot is durable. The account-local completion marker also distinguishes a synchronized empty vault from an unfinished download, so empty accounts remain usable offline. Existing cached notes appear immediately while reconnecting. The marker is written once, after current data commits; it neither changes the CRDT nor appends empty updates on reload.

The worker owns the append/sanitize/encode/replace transaction. Another tab's write occurs wholly before or after it. The main thread retains pending buffers until commit and receives only the correction relative to its state vector. Web Locks prevent recovery of an active owner's timestamps. Orphan recovery commits modification timestamps and owner retirement together. Old database layouts and replicated-history roots are rejected without rewriting their stored bytes; there is no migration.

Worker death before a write, during compaction, or after commit leaves unacknowledged input retryable. Page departure waits for durability before releasing the worker and vault; a failed departure retains the in-memory current data and offers an emergency backup. Returning through browser navigation history reloads durable data. Storage protection is requested only through the explicit Settings button. Incremental label invalidation, memoized checklist rows, textarea measurement, cooperative search construction, and account-scoped tab broadcasts remain in place.

## Sync protocol 2

WebSocket admission requires both `protocol=2` and `schema=stow-current-v1`, plus the exact verified `vaultId`. Rejection happens before opening account data. Password/proxy authentication, private proxy proof, incarnation reset, origin rules, and account-scoped HTTP headers remain required.

All messages use `SyncTransfer`: JSON control frames (`begin`, receipts, `done`, failure) and ordered binary chunks, each with an eight-byte transfer-ID/offset prefix. SHA-256 validates a complete logical unit before application. Chunk receipts grant flow-control credit; `done` follows fsync on the server or IndexedDB commit in the browser. Lost acknowledgments replay safely through Yjs idempotence.

| Bound | Value |
| --- | --- |
| Binary frame | 256 KiB including header |
| In-flight payload | Four frames, at most 1,048,544 bytes |
| Current logical unit | 128 MiB |
| History hint or notification | 256 KiB |
| Outgoing queued bytes, including active unit | 128 MiB |
| Waiting outgoing units | 128 |
| Concurrent directions | One upload and one download |
| Server aggregate reserved bytes | 256 MiB |
| Connections per account | 16 |
| JSON control frame | 4 KiB |
| Timeout | 60 seconds idle; five minutes absolute |

Logical kinds are `sync-request`, `sync`, `update`, `history-boundary`, `sync-complete`, `history-changed`, and `history-failure`. `sync-request` is a Yjs state vector. `sync` is UTF-8 `stow-current-v1` plus NUL, a four-byte big-endian vector length, then vector and current update. The client validates this marker before applying data. `update` is binary Yjs. History kinds carry UTF-8 JSON; `history-boundary` carries the boundary object directly and `sync-complete` carries `{}`. Notifications carry their corresponding object, including `type` and source IDs or error message.

History hints are ordered after the durable acknowledgment of the corresponding current upload. They have no offline outbox. Invalid history hints or history-write failures do not reject current updates or close the connection. Optional hint/notification admission failure does not close current sync. The initial `sync-complete` captures the sources accepted during catch-up once; an unchanged reload creates no arbitrary version. The client waits for outstanding hints before on-demand history or complete export, avoiding an HTTP read racing its own history request.

The server leases cached vaults during requests and connections and evicts idle documents after 30 seconds, after queued operations settle. Current-only emergency export and complete online export are distinct operations.
