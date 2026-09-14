# Archived history cleanup

Saved versions are independent server snapshots. Current notes remain in one vault CRDT; deleting versions does not rewrite notes or generate client history tombstones.

## Policy and UI

Automatic cleanup is disabled until explicitly enabled in **Settings → Storage and history**. Enabling requires confirmation. Notes must have been archived and unchanged for seven days; existing archives receive the full wait when enabled or re-enabled. The server checks every four hours and catches up after restart.

Archive activity is measured by server observation time, independently of user modification timestamps:

- Archiving starts the wait. Any accepted edit to the archived component restarts it, including typing before a coarse boundary.
- Unarchiving stops eligibility; re-archiving starts a fresh wait.
- A late offline edit restarts the wait when received, regardless of its author date.
- Cleanup does not count as a user edit. Notes without saved versions need no repeated cleanup until history returns.

Per-account `history-retention.json` persists scheduling state. One vault queue serializes current edits, policy updates, history capture, and cleanup. Observation is persisted before accepting the current edit, so a failed edit may delay cleanup but cannot cause premature expiry.

Manual **Discard archived history now…** requires connectivity and confirmation, skips the grace period, and works with automatic cleanup disabled. A selection token binds confirmation to the archive's selected sources, content, history, and observed activity. A changed selection is rejected for review. Unrelated live edits do not invalidate it.

The storage dialog separately shows current CRDT bytes, saved history bytes on the server, current snapshot/log files, originals, and thumbnails. The per-note timeline displays the known date of an earlier discard. No success toast or card badge is added.

## Reclamation and late devices

Cleanup removes affected versions from server history bundles. Mixed-source snapshots are redacted to surviving sources, including text recipes, action excerpts, and attachment references. A durable source-cutoff journal lets restart finish an interrupted discard. These cutoffs remain server metadata and are never synchronized to clients.

Current source, text, item, and merge identities remain intact, as do creation, modification, and placement dates. Cleanup does not retire session Undo or pending modification timestamps. Offline devices cannot resurrect old versions because they have no history upload queue. Their current edits still merge normally and may create a new server-observed snapshot after reconnect. There is no revision dependency graph to corrupt.

Historical image references protect originals while any surviving snapshot needs them. Removed references enter a durable cleanup journal. Image ownership also survives while any original source note exists, protecting session Undo independently of best-effort history. Full images and thumbnails are reclaimed only after all owners are permanently deleted and no current, history, or pending-upload references remain. Discarding history alone therefore reclaims version payloads, not removed images owned by surviving notes. The client fetches historical images only for an opened preview. Independent exports, Takeout inputs, and backups remain outside cleanup.

Endpoint consolidation applies in Notes, Archive, and Trash; the archive grace period controls full discard only. Independently, above 100 records, preserve the newest 50 and 25 older endpoints, combining adjacent older time intervals while preserving the first endpoint. Removing a snapshot never breaks another preview.

## Verification

Tests cover grace boundaries, accepted archive edits, old offline timestamps, unarchive/rearchive, existing archives, restart catch-up, stale manual confirmations, failures, source redaction, image references, account isolation, and unchanged current CRDT bytes after cleanup.


History compression is a separate, default-on account setting in Storage and history. Disabling compression retains future saved boundaries without thinning. Re-enabling applies the 100/50/25 endpoint policy to existing history in Notes, Archive, and Trash. It does not enable complete archive-history deletion.
