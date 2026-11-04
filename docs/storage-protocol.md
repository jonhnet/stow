# Browser persistence and sync protocol

## Browser persistence

The account-scoped IndexedDB schema is version 4, with four stores:

| Store | Contents |
| --- | --- |
| `updates` | Binary current-state Yjs updates; compacted at 500 entries or after permanent deletion/recovery |
| `pendingEdits` | Per-page `{ modifiedAt: { sourceId: timestamp } }`, without historical text or anchors |
| `maintenance` | The validated log-tail key following sanitization, and an initial-sync-complete marker |
| `undo` | Per-tab Undo/Redo stacks, descriptions, and Yjs redo links; committed with the corresponding updates |

A fresh browser cache keeps the notes view loading until the first server snapshot is durable. The account-local completion marker also distinguishes a synchronized empty vault from an unfinished download, so empty accounts remain usable offline. Existing cached notes appear immediately while reconnecting. The marker is written once, after current data commits; it neither changes the CRDT nor appends empty updates on reload.

Startup opens the last verified account's local storage before requesting a
session. The installed service worker serves its complete cached shell before
network access. Session verification still precedes every replication connection;
a different identity hides the old vault, preserves its edits, and requires a
reload into the new identity. Explicit client-update reloads use a one-navigation
`stow-update` query flag to fetch a fresh shell rather than repeat the incompatible
installed build. The entry point removes that flag while preserving navigation
and Undo state. Ordinary launches never take that network-first update path.

The worker owns the append/sanitize/encode/replace transaction. Another tab's write occurs wholly before or after it. The main thread retains pending buffers until commit and receives only the correction relative to its state vector. Web Locks prevent recovery of an active owner's timestamps or Undo stack. Orphan recovery commits modification timestamps and owner retirement together. Version 1 current-only caches gain an empty `undo` store without changing their existing data; earlier database layouts and replicated-history roots are rejected without rewriting their stored bytes.

Undo survives reload and PWA restart on the same browser profile. Reload prefers that page's previous stack; a fresh launch resumes the most recently edited inactive stack. Active tabs have separate stacks. Loading and compaction retain deleted CRDT content needed by saved stacks, including parent records; permanent deletion prunes affected stack entries and their retained content. Undo metadata stays local to this account and browser, outside backups and sync. Clearing browser storage clears it. `persistent-undo.ts` depends on Yjs 13's stack/delete-set and redo-link representation; its reload/compaction tests must pass when upgrading Yjs.

Each stack retains at most 200 entries across Undo and Redo combined. Removing old entries releases their retained deleted content; normal log compaction reclaims its persisted bytes. Opening an older oversized stack trims it and compacts storage. The nearest Undo steps take priority, followed by the nearest Redo steps, so trimming never skips over an intermediate step.

Startup and update-log compaction also clean inactive stacks in this browser/account. Cleanup retains at most three inactive stacks, discards empty stacks, and expires stacks whose existing `updatedAt` is at least one week old. The cleaner holds each owner's Web Lock through the atomic record removal and compaction; live tabs and concurrently adopted stacks remain protected. The week limit applies to inactive stacks as a whole: individual entries have no saved timestamps, so active stacks use the count limit only. No additional timestamp records or database migration are required.

Outgoing updates and tab responses wait for local durability. Otherwise a receiving tab could compact a newly deleted range before its author's Undo metadata becomes visible in the shared database. Storage failure retains pending edits and prevents publishing that incomplete local transaction.

Worker death before a write, during compaction, or after commit leaves unacknowledged input retryable. Page departure waits for durability before releasing the worker and vault; a failed departure retains the in-memory current data and offers an emergency backup. Returning through browser navigation history reloads durable data. Storage protection is requested only through the explicit Settings button. Incremental label invalidation, memoized checklist rows, textarea measurement, cooperative search construction, and account-scoped tab broadcasts remain in place.

## Background diagnostics

Diagnostic events use the separate `stow-background-v1` IndexedDB database, not
the notes CRDT. It retains the latest 200 events per account and a random browser-
profile ID. Registration checks, permissions, actual worker wakes, starts,
skipped overlaps, errors, and successful download durations/byte counts are
recorded. No note text or images are included.

Each event carries `build`, the full application Git commit compiled into the
tab or service worker that recorded it. The stamp is saved with the event before
uploading and remains unchanged across upgrades, uploads by a different tab or
worker, and retries. Events queued or stored before stamping was introduced have
an absent or null build, meaning unknown; they are never attributed to the later
uploader or the currently deployed server.

After account verification, foreground visits/reconnects attempt an upload and
retry about every five minutes while open, using the existing connection check.
The five-minute throttle persists across tabs/reloads, including failed attempts.
Each worker refresh also attempts an upload on completion or failure, regardless
of that throttle. Uploads independently verify the session, bind `X-Stow-Vault`,
and have a ten-second network deadline. A Web Lock prevents concurrent uploads
from this profile/account. Upload failure never blocks displaying cached notes
or changes a successful note refresh into a failure.

`POST /api/diagnostics/background` sends new events and their increasing local
sequence numbers. The server deduplicates retries and durably acknowledges the
sequence watermark before the device advances its cursor. Empty uploads serve
as heartbeats. If more than 200 events accumulate locally, the oldest are removed;
`droppedUnacknowledged` counts removals beyond the acknowledged watermark. Some
may already be on the server if its acknowledgment was lost. Clearing browser
storage creates a new device identity and loses its unsent records.

The server stores `diagnostics/background-sync/<vaultId>.json` under its data
directory, separate from each vault. Files survive service restarts and deployments.
Retention is 30 days by server receipt time, up to 5,000 events per device and
16 most recently seen devices per account. Pruning happens on read/upload;
inactive files are not swept by a separate timer. Each device includes its
browser, last upload's build, last foreground/background upload times, client
event times, server receipt times, and unacknowledged-drop count.
The device's `lastUploadBuild` describes only its latest uploader; use each
event's `build` to compare background behavior across client versions.

The Android shell uses this same account-scoped log and upload endpoint through
its authenticated `/native/api/` route. Its `native` events include the shell
version, scheduling trigger, native event time, and a bounded diagnostic message;
the ordinary refresh events retain their web build stamp. Native events survive
process death and are copied into the next background refresh's upload. Android
requests a 15-minute interval; the PWA registration continues requesting its
browser-controlled interval. See [Android shell behavior and tests](android-shell.md).

An authenticated `GET /api/diagnostics/background` with the matching
`X-Stow-Vault` returns that account's devices and events. Operators can also read
the JSON files directly to compare devices. Shared-note capabilities cannot read
or upload these private diagnostics. No log contents are replicated to other
devices automatically. Recent foreground heartbeats plus no worker wakes help
distinguish an active device with no observed scheduling from a device that has
not contacted the server. Neither absence guarantees what Android will do next.
After deployment, open the updated app once on each device to start collecting.

## Compatibility epoch 4

`SYNC_PROTOCOL_VERSION` is a compatibility epoch shared by server admission,
tab broadcast channel names, and the IndexedDB version. Bump it only when older
clients must stop participating; ordinary releases keep it unchanged and leave
open notes and tabs alone. Keep the Rust server constant in step with the browser.

Epoch 4 retains protocol 3's conversion masks and protocol 2's frame format, and
adds isolation through browser storage and tab broadcasts. Broadcast channels
include the verified vault ID, schema and epoch; they never answer unversioned
legacy hellos. An in-place IndexedDB upgrade keeps current updates, pending edit
metadata and Undo, but first requires every older connection to close. A notified
tab freezes editing, stops server and tab communication, finishes its pending
edit and drains retained writes before closing storage. The drain uses the
existing main-thread connection: reopening a worker connection could deadlock
behind the upgrade it is blocking. Failed saves retain in-memory notes for export
and prevent reload. Opening an already newer cache reports an update requirement
without reading or rewriting it. No data is copied between account caches.

Already-running clients from before these safeguards cannot gain the new reload
notice retroactively. Their old channels are isolated, and upgrading IndexedDB
closes their old handles and prevents reopening at the old version. Close those
legacy tabs once when first deploying this release.

Conversion records carry the identities of the source characters and their
initial text/rank. Equivalent conversions display once; intentional repeated
lines have different character identities. Untouched copies are suppressed when
a copy is edited or deleted. Distinct edited copies remain visible as conflict
versions, and children of equivalent parents follow the visible parent. Raw
records remain independent so reconnection cannot overwrite nested text edits.

`text-mask:*` fields in the owning note hold exact Yjs character spans for each
conversion. They hide the original body/title/join characters without deleting
them, so concurrent Undo reveals the original once instead of reinserting copies.
Later insertions have new identities and remain visible. Body editing skips
masked spans. This retains original converted text as current structural data
(and separate records for concurrent conversions), not a keystroke history.
Permanent source deletion removes the owning note and its masks. Both browser
projection and Rust history capture apply these rules without writing repairs.

WebSocket admission requires both `protocol=5` and `schema=stow-current-v1`, plus the exact verified `vaultId`. Rejection happens before opening account data. Password/proxy authentication, private proxy proof, incarnation reset, origin rules, and account-scoped HTTP headers remain required.

Browsers send `X-Stow-Sync-Protocol` and `X-Stow-Schema` on the authenticated
`/api/session` check. An incompatible client receives the verified account plus
`syncRejection: {code, message, action, target}`. If compatibility changes between
preflight and connection, the authenticated WebSocket upgrades only to send
`{type: "sync-rejection", rejection: {code, message, action, target}}`, followed
by a policy close (1008). Browser WebSocket APIs hide HTTP handshake rejections,
so those cannot communicate a terminal update instruction. The rejection path
never opens the vault or processes or acknowledges sync data. Headerless
identity-only callers remain supported, but cannot bypass WebSocket admission.
Authentication, origin and vault identity checks run before this rejection path.
Account changes take priority over update handling.

`client_update_required` isolates the tab as above and leaves a persistent notice.
For `action: "reload"`, the client reloads
after five seconds of inactivity in a visible page, with no active input
composition, pending local note/image writes, or local storage failure. It
finishes the edit, awaits IndexedDB durability, then rechecks activity and safety
before navigation. This preserves offline content without waiting for a server
acknowledgment. The local Undo/Redo stack is committed with the edits. One automatic attempt
per account and required target is recorded in sessionStorage; a still-rejected
bundle keeps the notice and a manual Reload button instead of looping. Storage
failure prevents automatic navigation and offers a current-notes export. The
open note remains in browser navigation state and reopens after reload.
`action: "none"` surfaces the rejection
without scheduling a reload.

All messages use `SyncTransfer`: JSON control frames (`begin`, receipts, `done`, failure) and ordered binary chunks, each with an eight-byte transfer-ID/offset prefix. SHA-256 validates a complete logical unit before application. Chunk receipts grant flow-control credit; `done` follows fsync on the server or IndexedDB commit in the browser. Lost acknowledgments replay safely through Yjs idempotence.

Client-initiated failure closes use application codes 4008 (invalid), 4009 (limit), and 4013 (retry/storage), which the browser WebSocket API permits. Server-initiated closes may use standard codes 1008/1009/1013. A retryable client failure must actually close the socket so the store can reconnect.

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

History hints are ordered after the durable acknowledgment of the corresponding current upload. They have no offline outbox. Invalid history hints or history-write failures do not reject current updates or close the connection. A panic during capture is caught before it can poison the account lock; the server discards the in-memory vault and reopens durable current and history files. If reopening fails, subsequent operations retry recovery before accessing that account. Optional hint/notification admission failure does not close current sync. The initial `sync-complete` captures the sources accepted during catch-up once; an unchanged reload creates no arbitrary version. The client waits for outstanding hints before on-demand history or complete export, avoiding an HTTP read racing its own history request.

The server leases cached vaults during requests and connections and evicts idle documents after 30 seconds, after queued operations settle. A panic while opening one vault is caught before it can poison the shared account registry. Current-only emergency export and complete online export are distinct operations.

Shared notes use separate capability-authorized documents. Protocol 5 prevents older clients from treating private shared references as ordinary notes; see [sharing](sharing.md) for publication, scope isolation, retention, and recovery.
