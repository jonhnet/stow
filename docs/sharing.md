# Shared notes

Use **Share note → Create sharing link**, then send the link. Everyone who has it
can edit and forward it. There is no owner, revocation, read-only role, or action
that deletes the note for everyone. The capability is in the URL fragment, not
its request path. Treat the whole link as a password.

Opening a link joins the shared document. **Add to my notes** explicitly adds a
reference to an authenticated collection. Guests can edit without creating an
account. The participant initials (or Anonymous Chicken for a guest) record who
joined; they are not a presence indicator or an authorization list.

Content, checklist order/nesting/checks, attachments, and content history are
shared. Pinning, placement, color, labels, archive, and trash are personal.
Background refresh currently downloads the private collection, including its
references; shared content synchronizes when Stow is open. Opening a shared link
does not change the private account selected for background refresh.

Shared notes cannot be merged. Restore copy from shared history creates a new
private note, including copies of its images, after adding it to a collection.

Undo remains local to this browser's editing session and survives its reloads.
Private and shared actions use one chronological Undo/Redo ordering. Remote
changes do not become local undo entries. Restoring an old version is a different
operation: it creates a private copy rather than reverting everyone else's work.

Publication copies visible current content to a fresh document. It does not
expose private history, deleted text, or import provenance. The original private
sources are permanently retired. Edits arriving later from an offline device
are discarded for those source IDs. Publication requires synchronization; the
preparation dialog can be cancelled before creating the link. Publication itself
is not undoable. A persisted intent makes retries safe after a lost response or
server restart.

Every authenticated collection reference keeps the shared document alive, even
in archive or trash. Permanent removal drops only that reference. Guests and
participant avatars never retain it. After the last reference disappears, a
seven-day grace period permits re-adding it. Collection leaves a server tombstone
before deleting content and blobs; an old client cannot resurrect it. Ordinary
offline use does not remove references. A reference first added entirely offline
cannot retain a document the server has already collected.

## Hosting and authentication

No infrastructure is deployed by this feature. The existing proxy's allowlist
still applies until its operator changes it. For public guest access, configure
the authentication proxy to allow anonymous requests through to Stow and forward
verified identity only for authenticated requests. Strip user-supplied identity
and proxy-proof headers, as in the existing proxy setup. Stow still requires a
verified authenticated identity for every private-vault request, publication,
and Add to my notes. Guests additionally need the sharing capability and a
server-signed, HttpOnly guest cookie for sync and blob access.

The **Open my collection** link goes to `/`; password-mode installations offer
login there. For SSO installations, set the public build variable
`VITE_STOW_LOGIN_URL` to your auth checker's login URL to show a **Sign in** link
beside it. After signing in, reopen the sharing link and choose **Add to my notes**.
Stow does not place the sharing capability in a login redirect's query string.
The external auth checker and its anonymous-pass-through mode are outside this
repository; the operator must enable that mode before guests can reach Stow.

Preserve WebSocket upgrades and subprotocol headers. Shared sockets negotiate
`stow-shared`; the capability is supplied as another offered subprotocol, never
as a query parameter. Do not log authorization headers or WebSocket subprotocols.
API responses remain `no-store`. Existing sync/blob size limits and transfer
budgets apply to shared documents as well as private vaults.

Back up the entire data directory, including the server identity secret:

- `shared/`: shared CRDTs, history, and blobs.
- `sharing/`: hashed capabilities, participants, publication intents, and collection tombstones.
- `share-references/`: derived authenticated retention indexes and crash markers.
- The existing private vault and identity directories.

Reference indexes are derived from accepted private CRDT state. Before an account
update, a durable dirty marker prevents collection; after acceptance, touched
references are reconciled. A crash repairs the index before serving that account.
A dirty marker conservatively blocks collection until repair. Backups exported
by the UI include each loaded document's current state and history independently;
bearer capabilities in those backups are secrets too. As before, JSON exports
contain attachment metadata, not original image bytes: retain server backups.

## Validation

`npm test` covers fresh snapshots, local/remote undo, redo invalidation, publication
retry/restart, late private edits, authenticated retention including trash,
collection grace/tombstones, guest identity, capability and account binding,
and incremental reference reconciliation. `tests/browser/sharing.spec.ts` tests
multiple real browser contexts with separate accounts and a guest, offline edits
and reload, images, reference removal/re-add, history copies, and account changes.
CI runs these browser cases in both Chromium and Firefox on pushes and PRs.
