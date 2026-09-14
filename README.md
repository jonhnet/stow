# Stow

Stow is a self-hosted personal notes app inspired by Google Keep: a quiet card overview, quick note editing, checklists, images, links, and automatic synchronization between your browsers and phone. Notes are stored on each device and remain editable offline after the first successful load and sync.

Each user has a separate personal vault. Stow uses React, TypeScript, Yjs, IndexedDB, and a Rust server using Axum and Yrs. An authenticating reverse proxy supplies each user's identity; a password mode remains available for a single personal vault. Read the [architecture](docs/architecture.md) for the data model, synchronization guarantees, and the reasoning behind merging and undo.

## First-cut scope

- Text notes and checklists with parent/child groups, a responsive overview, and click-away editing.
- Markdown note text, inline formatting in checklist items, and clickable web/email links.
- Pinning, manual card order, colors, archive, trash, and local text search.
- Selected-note copying and Markdown, plain-text, or HTML downloads.
- Offline image thumbnails, with full images loaded on demand and a 50 MiB cache per account and device.
- Automatic sync while the app is open, with offline editing and reconnect recovery.
- Merge notes while retaining their source identities, so late offline edits appear in the merged view.
- Session undo/redo plus server-stored per-note history, fetched on demand and restorable as new notes.
- Google Keep Takeout import with account-bound previews, retained source files, and append or replacement operations.
- An installable web app with separate user vaults behind an authenticating proxy, or a password-protected personal server.

It does not yet include shared vaults, native apps, push notifications, reminders, OCR, or end-to-end encryption. History recovery creates a new note; it does not restore the session undo stack after reload. This is not a complete Keep replacement or a claim of large-scale production readiness.

Use [Import Google Keep](docs/import-keep.md) to preview a Takeout export and apply it to a selected account. The importer preserves note timestamps, checklist text and checked states, labels, and attachments, saves a backup before applying, and supports retrying a saved plan. Takeout omits checklist nesting; the preview reports that limitation. Importing requires no Google credentials.

Replacement must cover whole notes, including every source joined by a merge. If a saved plan now covers only part of a note, Stow rejects it before changing data and asks you to regenerate and review the plan; it never expands the requested deletion set automatically.

## Install on Android

Open Stow over HTTPS, then choose **Settings → Install Stow** when it appears. This opens the browser's installation confirmation. Chrome decides when installation is available; Stow captures its offer during startup and only opens the prompt after a click. The action is hidden in an installed window, after installation, or while no offer is available. Dismissing a prompt requires a fresh browser offer before trying again. You can also use Chrome's own install menu.

The installed app opens from its own icon in standalone mode. The production service worker caches the app shell and install icons for offline launches; notes synchronize while Stow is open. Android PNG and maskable icons derive from `public/icon.svg`; regenerate them with `node scripts/render-icons.mjs` after changing that source.

## Writing and formatting

Every note can contain both free text and a checklist. The free-text field stays available even when empty, including on notes created as checklists. Adding a checklist preserves existing prose.

Click a note's text or a checklist item's text to edit its Markdown source. The whole field stays in source form while focused, then renders when you move to another field or close the note. Formatting never rewrites the saved text, so ordinary undo, offline edits, and synchronization keep working. Links in an open note open their destinations. Text and link labels on closed cards open the note; their checkboxes stay independently clickable.

Note bodies support headings, paragraphs, bulleted and numbered lists, quotations, horizontal rules, fenced/indented code, and tables. Both note bodies and checklist items support `*italic*`, `**bold**`, `~~strikethrough~~`, inline code, and `[named links](https://example.com)`. Web URLs, `www` addresses, and email addresses are recognized automatically. Checklist items use inline syntax only: a leading `#` or `-` remains ordinary item text. Single line breaks remain visible.

Links remain ordinary clickable links. Webpage preview cards and fetching their titles, descriptions, or thumbnails are outside Stow's intended scope.

Checklist text wraps in cards and while editing. Enter starts the next item; Shift+Enter inserts a line break within the current item. Drag the dotted grip to reorder items, or focus the grip and use the arrow keys.

While editing text, Up/Down move the caret normally within a field. At the first or last displayed line, they move to the previous or next text field: title, free text, checklist items, and the new-item field in displayed order. Collapsed completed items are skipped. Down enters the next field at its start; Up enters the previous field at its end. Modified arrows keep their existing behavior, including selection and Alt+Up/Down checklist reordering.

This first Markdown scope excludes HTML rendering, executable content, math, footnotes, and interactive Markdown task lists. Use Stow's checklist mode for interactive checkboxes. Markdown image references appear as labeled links; attach an image normally to store it in the vault and cache its thumbnail offline. Relative file links have no destination within a vault and display as text. Parsing and automatic link recognition use [markdown-it](https://github.com/markdown-it/markdown-it).

## Note order, copying, and downloads

New notes start with their creation date as their sort date. Pinning or unpinning brings a note to the top of its destination group. Editing or checking an item leaves its position alone. Drag a closed card to place it between other cards; the new sort date is the midpoint between its neighbors. On a phone, a stationary hold selects the card after 450 ms. Moving more than 10 pixels from the starting point after the hold turns that gesture into a drag and clears its provisional selection; ordinary swipes scroll. With a card focused, use Alt+arrow keys to move it. Moving a card supports Undo/Redo and syncs between devices.

Reordering stays within a note's pinned/unpinned and live/archive/trash group. Label and search views share the underlying note order: dropping beside a visible note places it next to that note in the full group. Archived results keep their separate fold. Merging retains the oldest source's stable identity, while the title, color, pin state, and sort date come from the first selected note.

The grid places each note, in sort order, into the shortest column; equal column heights choose the leftmost column. Each pinned/unpinned and live/archive section packs independently. Resizing or changing a card's height can redistribute later cards without changing the saved note order. Plain arrow keys follow neighboring cards on screen; Alt+arrow moves the focused note before its left/up neighbor or after its right/down neighbor.

Only cards near the viewport are rendered. Heights are cached for the current card width, measured changes are batched once per frame, and a visible note anchors scrolling as measurements settle. Overview image galleries reserve their space before thumbnails load. During a drag, new height measurements wait until release or cancellation; a change to the group's order or width cancels the drag.

Select notes with the circle in each card's upper-left corner. On touch screens, the circles stay hidden until a long press selects the first note, then appear on every card for additional selections. They hide again when the selection is cleared. A quick tap still opens a note or image, and checklist boxes remain active. **Ctrl+C** (**Cmd+C** on Mac), or **Copy selected notes** in the selection toolbar, copies those notes in displayed order. The clipboard includes readable text and formatted HTML, including the complete body, completed checklist items, child indentation, and link destinations. Copying inside an editor keeps the normal text-selection behavior. Clipboard errors are reported; a successful copy briefly shows a confirmation.

The selection toolbar's **Export notes** menu downloads the selected notes as **Markdown (.md)**, **Plain text (.txt)**, or **HTML (.html)**. Multiple notes share one file with clear separators. These text exports identify attached files by name; they do not download or embed originals. Use **Download vault backup** in Settings while online for current notes and server history as JSON; offline **Export current notes** excludes history. Back up the data directory for original attachments.

## Merging notes

Select notes in the order you want them combined, then choose **Merge notes**. The title, background color, pin state, and existing sort date come from the first selected note. The body begins with the other selected titles, one per line, followed by a blank line and every selected note's body in selection order, with blank lines between bodies. Empty bodies retain an empty block. Checklist items follow the same selection order, retaining child groups and checked states. Labels and attachments are retained too.

The result has one title, one editable body, and one checklist. You can delete the inserted titles, edit across former boundaries, and drag or indent items anywhere in the combined checklist. Search, copying, downloads, and history previews use these same visible contents. There is no merged-note badge or separate-note editor. **Undo** reverses a merge; per-note history retains the original notes' past versions.

Existing merges open with the same unified editor, using their previously displayed source order. Their old records do not retain the complete original selection order. Source text identities remain hidden in the CRDT so edits from a device that was offline during the merge still arrive in the combined note.

## Labels

Use **Edit labels** in a note or draft to attach, create, or remove labels. Imported Keep labels are already available there. Labels are explicit metadata: typing `#tag` or `Apartment #C3` never attaches a label. Search includes attached label names.

Each label can have a shared chip color. Expand **Labels** in the sidebar and use the palette beside the label; it applies throughout your vault, while each note's background remains independent. The palette and delete buttons appear on the hovered row or when reached by keyboard; touch screens show these controls directly. The picker inside a note only attaches, creates, and removes that note's labels.

The sidebar's delete button removes a label from the catalog and all notes, including archive and trash, without deleting any notes. **Undo** restores the original label, assignments, and color. Creating the same name after deletion starts a fresh label; old offline changes cannot restore the deleted label. History previews retain their original labels, but restoring an older note does not recreate a deleted label or attach a new label that happens to have the same name. Colors and global deletion are vault settings and do not change note edit times. Online label-setting changes appear in the histories of affected notes as nonrestorable settings entries. Explicitly attaching or removing a label on a note does appear in that note's version history. Current label changes work offline and support undo; saved history requires connectivity.

Expand **Labels** in the sidebar to browse the catalog. Both the sidebar and the note's label picker order labels by the newest note edit in each label's set, with name order breaking ties. Both show the same colored chips used on notes. Selecting one shows its active and archived notes; trash is excluded. The search field narrows that label's notes. Label views and search results place archived notes below all live notes, separated by a wide gap and an **Archived notes** heading; pinning stays within each section. Labels you explicitly manage remain available after their last note is unlabelled; labels without matching notes appear last. The catalog starts collapsed.

## Checklist groups

While editing an item, press **Tab** to indent it beneath the preceding parent, or **Shift+Tab** to outdent it. When no indentation change is possible, Tab follows normal keyboard focus navigation. Lists have one child level. A parent with children moves as a group; outdent its children before making that parent a child itself.

Drag the grip vertically to reorder. Shift the drag right to make an item a child, or left to make it a parent. A parent brings its children along, including completed children; a child can move to another parent or out of its group. On a focused grip, use Up/Down to reorder siblings and Left/Right to outdent/indent.

Enter on a parent with children inserts a new first child, ahead of the existing children. Enter on a child creates the next sibling child; Enter on a top-level item without children creates the next top-level item. Checking or unchecking a parent applies that state to its current children. Individual child checkboxes remain independent, and a partially completed group stays together in the active list. Deleting a parent promotes its children without deleting their text. Group edits participate in undo, per-note history, and offline synchronization.

## Note history and images

**Undo** and **Redo** sit next to each other in the top bar, including on phones. Undo is **Ctrl+Z**; redo is **Ctrl+Shift+Z** or **Ctrl+Y**. On Mac, use **Cmd+Z** and **Cmd+Shift+Z**. Hover over the buttons to see the shortcuts. The same actions are available in an open note’s menu. Typing shares an undo step until a half-second pause, two seconds of continuous input, a cursor move, a field change, or a switch between inserting and deleting. A paste, cut, or IME composition stays one operation. These small undo steps remain available after you finish editing. Search and label-filter inputs retain their native text undo. Undo/redo briefly describe the action they reversed or reapplied; ordinary successful actions show no notification. The undo stack lasts for this browser session, while saved version history survives reload.

Open a note's three-dot menu and choose **Version history**. Saved versions live on the server and require a connection to browse. Each preview is a complete snapshot of a state the server observed, with saved time and an edit time when different. **Restore copy** creates a new current note. Label-color settings show before/after chips and cannot restore a note. History works from Notes, Archive, and Trash.

Text saves locally and synchronizes as you type. Five seconds idle, leaving the field, closing the note, window blur, or hiding the tab completes an edit and publishes its last-input time. The connected client then asks the server to save an observed version. Distinct actions generate their own boundaries. Intermediate offline actions are not queued as history; reconnect saves the resulting current state. Saved history may omit intermediate views when devices reconnect or edits race, while current notes still merge normally. Local crash recovery preserves current edits and their modification timestamps without storing a historical snapshot queue.

Above 100 versions, note history keeps the newest 50 and consolidates earlier changes into 25 saved endpoints. **Settings → Storage and history** shows current CRDT bytes separately from server history and offers optional archive cleanup after seven unchanged days, or a confirmed immediate discard. History cleanup preserves current content, dates, and local Undo. History search is deferred.

Image thumbnails download automatically for offline browsing. Click a thumbnail to load the original. Viewed originals remain available offline until evicted from the 50 MiB cache; an uncached original needs a connection. Pending local uploads are retained even when they exceed that cache budget. Evicting a downloaded original never deletes the server copy. Removed images remain on the server while an owning note exists, so Undo does not depend on retained version history; permanently deleting all owning notes allows reclamation.

## Permanent deletion

In **Trash**, use **Delete forever** on a card or an open note, or select notes and use the same action in the top bar. **Empty trash** selects every note currently in Trash. Both require confirmation and cannot be undone. The confirmation names the note or shows the number selected; notes arriving in Trash afterward are not included. If a selected note has been restored or merged with another note while confirmation is open, review the changed selection before deleting.

Permanent deletion removes the selected notes' source content, checklist items, and saved history. It discards undo/redo entries involving those notes while preserving unrelated entries. Shared images and history belonging to surviving notes remain; unused images, thumbnails, and imported raw source copies are reclaimed. A saved Takeout manifest containing a deleted note is also discarded because it repeats that note's content.

Deletion works offline and synchronizes normally. Devices apply cleanup when they receive it; minimal content-free deletion IDs prevent stale edits from resurrecting erased sources. Local update logs and server snapshots are compacted to remove deleted payloads. Independently exported backups and the original Takeout files are outside this operation.

## Run locally

Use Node.js 22 or later and npm for the browser and import tools, Rust 1.94.1 (selected by `rust-toolchain.toml`), and ImageMagick 6 with JPEG, PNG, GIF, WebP, and HEIF/AVIF codecs. On Debian/Ubuntu, install `imagemagick`; `rustup` supplies the pinned Rust toolchain. The production server runs without Node.js. Keep the checkout in `stow-git/` inside a workspace with this layout:

```text
stow/
├── stow-git/     # Source, scripts, and canonical package manifests
├── build/        # Disposable dependencies, compiled app, caches, and test output
├── data/         # Persistent vaults, images, and server identity secret
├── .env          # Private deployment settings
└── node_modules -> build/node_modules
```

From the workspace directory, install dependencies with:

```sh
./stow-git/setup.sh
```

`setup.sh` copies the source's `package.json` and `package-lock.json` to `build/`, runs `npm ci` there, creates the workspace-level `node_modules` link for module resolution, and builds the Rust server. Run this script again after dependency changes. Do not run `npm install` or `npm ci` inside the source checkout.

Run development commands from the source directory:

```sh
cd stow-git
STOW_PASSWORD='choose-a-long-password' npm run dev
```

Open [http://localhost:5173](http://localhost:5173). The development command starts Vite and the Rust server together. When Rust sources change, the current server keeps answering while the replacement builds; a failed build leaves it running. A successful build triggers a brief restart. The npm scripts use `scripts/run.sh` to keep generated files, temporary files, and caches under `../build/`. Use the production build to exercise the installed app and offline application shell.

Temporary session failures (HTTP 500, 502, 503, or 504) display a retry message and reconnect automatically. A fresh page still waits for verified identity before opening a cached vault; authentication denials, redirects, and malformed successful responses remain blocking errors.

```sh
npm run build
STOW_PASSWORD='choose-a-long-password' npm start
```

`npm run build` produces the optimized Rust executable in `../build/cargo-target/release/` and the browser bundle. The production server serves `../build/dist/` and the sync endpoints at [http://localhost:3001](http://localhost:3001). Use the configured password when the app asks to connect.

`build/` is disposable. Stop running Stow processes before removing it, then run `./stow-git/setup.sh` from the workspace to recreate dependencies and `npm run build` from the checkout to recreate the compiled app. Keep `data/` and `.env`: they contain persistent state and private configuration.

```sh
STOW_ORIGIN=https://stow.example.com STOW_PASSWORD='choose-a-long-password' npm run dev:lan
```

Configure nginx to forward `https://stow.example.com` to `http://<dev-machine-LAN-IP>:5173`, then open the HTTPS URL. Vite listens on all interfaces and proxies the API and WebSocket connection to the local backend. `STOW_ORIGIN` also allows that specific hostname through Vite's host check. Substitute your actual hostname, including the public port if it is not 443.

The [nginx example](docs/nginx.conf.example) forwards WebSocket upgrades for sync and live code updates, and allows Stow's 20 MB image uploads. Use a certificate trusted by your devices. No HTTPS or certificate handling is needed in Stow's own server.

To serve the built app on all interfaces instead:

```sh
npm run build
HOST=0.0.0.0 STOW_ORIGIN=https://stow.example.com STOW_PASSWORD='choose-a-long-password' npm start
```

Point nginx's upstream at `http://<dev-machine-LAN-IP>:3001` and open the same HTTPS URL. For a deliberately passwordless home-network instance, replace the password setting with `STOW_ALLOW_INSECURE=true`.

The browser contract is HTTPS, with HTTP localhost supported for development. Opening a plain HTTP LAN URL shows an explanatory message before loading the vault. There are no HTTP-specific crypto implementations. Offline app startup and PWA installation also require the production build; Vite development mode does not register the service worker.

## Self-host

For separate users, configure these server settings in the private workspace `.env` file, alongside `stow-git/`:

```dotenv
STOW_AUTH_MODE=proxy
STOW_PROXY_SECRET=replace-with-a-random-secret-of-at-least-32-characters
STOW_ORIGIN=https://stow.example.com
```

Generate the secret with `openssl rand -hex 32`. In nginx's Stow proxy location, overwrite `X-Stow-Proxy-Secret` with that same value and `X-Auth-User` with the authenticated user's stable identity. Use the identity variable supplied by your existing authentication integration; do not copy a header from the incoming browser request. Forward both headers for HTTP and WebSocket upgrades. The [nginx example](docs/nginx.conf.example) shows where these directives belong.

Every proxy-mode API request and WebSocket handshake verifies the private secret and identity. Missing or invalid identity/proof is rejected; proxy mode does not fall back to a Stow password or a shared vault. A shared Stow password does not establish which user sent a request. Vite forwards the headers, and its file server denies access to the data directory and `.env` files.

Then run from `stow-git/`:

```sh
docker compose --env-file ../.env up --build -d
```

For a single personal vault, use `STOW_AUTH_MODE=password` and `STOW_PASSWORD` instead. The server validates the selected mode at startup. Compose publishes port `3001` on loopback by default and keeps data in the named `stow-data` volume. The explicit Compose project name `stow` preserves the existing `stow_stow-data` volume when the checkout directory is renamed. Put Stow behind an HTTPS reverse proxy that forwards WebSocket upgrades.

The image builds from the source checkout only. Inside the container, source lives at `/stow/stow-git/`, dependencies and the compiled app live at `/stow/build/`, and `/stow/node_modules` links to the build's dependencies. Persistent container data lives at `/data`; it is separate from the host development workspace's `data/` directory.

Each proxy identity opens only its own vault. Startup, sign-in, reload, and sync never copy notes or images from another account, old shared server files, or old browser caches. Existing private vaults keep their data; new accounts start empty. Changing the proxy identity opens a different vault, so keep each user's identity stable.

On a shared browser, Stow verifies the current account before opening its local vault. An account change hides the previous vault and asks you to reload; pending edits remain in that account's database and synchronize when you return. Offline startup reopens the last verified account on that browser. Offline files remain accessible to someone who controls that browser profile or disk; use separate OS/browser profiles when local device privacy is required.

Password mode cannot start against a data directory that contains user vaults. Use a separate data directory for a password-mode installation.

Use the same URL on all devices. Each browser origin has its own local database, so changing hostname, scheme, or port changes the local cache. Complete the first sync and thumbnail downloads before expecting the new device to work offline.

On a phone, install Stow using the browser's Add to Home Screen or Install App action. HTTPS is required for the offline service worker except on localhost; an HTTP LAN address on a phone is not localhost. [Service worker secure-context requirements](https://developer.mozilla.org/en-US/docs/Web/API/Service_Worker_API)

| Environment variable | Purpose |
| --- | --- |
| `HOST` | Server bind address; defaults to loopback. Use `0.0.0.0` when intentionally binding an interface outside the local machine. |
| `PORT` | HTTP and WebSocket server port; defaults to `3001`. |
| `DATA_DIR` | Persistent directory for user vaults, blobs, and server metadata; defaults to `../data` alongside the source checkout. Must stay outside the source checkout and `build/`. The container uses `/data`. |
| `STOW_AUTH_MODE` | `password` (default) for one personal vault, or `proxy` for separate authenticated users. |
| `STOW_PASSWORD` | Password for the personal vault in password mode. Ignored in proxy mode. |
| `STOW_PROXY_SECRET` | Required in proxy mode, at least 32 characters; nginx must overwrite `X-Stow-Proxy-Secret` with this value. |
| `STOW_ORIGIN` | Optional public origin used for origin validation behind a reverse proxy. Include the scheme and hostname. |
| `STOW_ALLOW_INSECURE` | Set to `true` to explicitly allow binding beyond loopback without a password. |
| `STOW_BIND_ADDRESS` | Compose-only host bind address; defaults to `127.0.0.1`. |
| `STOW_PORT` | Compose-only published host port; defaults to `3001`. |

Password mode permits passwordless loopback development. Binding beyond loopback requires a password unless `STOW_ALLOW_INSECURE=true` explicitly overrides that check. Proxy mode always requires its private secret, regardless of bind address. Authentication protects server access; files in the data directory and browser storage are not end-to-end encrypted. Run one server process per data directory.

## Archived history cleanup

Open **Settings → Storage and history** to see server storage usage and enable **Discard history after archived notes have been unchanged for 7 days**. This is off until enabled and requires confirmation. Existing archives get a fresh seven days; editing, receiving an offline edit, or re-archiving restarts the wait. Unarchiving stops eligibility. The server checks every four hours and after restart.

**Discard archived history now…** performs a confirmed immediate cleanup. Both operations preserve current note contents, dates, and local Undo while removing saved versions. Image ownership remains until the owning notes are permanently deleted. The history view records the discard date. New edits create new history; discarded versions cannot be restored. Storage figures show current CRDT bytes separately from saved-version files. See the [retention policy](docs/archive-history-cleanup.md).

## Back up and restore

Back up the **complete data directory**, including `session-secret`, `vault-incarnations.json` if an [account reset](docs/account-reset.md) has been performed, and each vault's `vault.yjs`, `updates/`, `blobs/`, `blob-cleanup.json`, `history/`, and `history-retention.json` under `users/` (or the data directory itself in password mode). A snapshot alone can omit newer edits stored in `updates/`. Include any retained original files too. The server secret and account reset registry determine current user vault IDs, so preserve them. Stop the service first so snapshots, update logs, and blobs are copied together consistently. With Compose, run `docker compose --env-file ../.env stop` from the checkout, copy the persistent volume's contents to your backup destination, then run `docker compose --env-file ../.env start`.

Back up the private workspace `.env` separately with appropriate access controls. The source checkout and disposable `build/` directory are not vault backups.

To restore, stop the service, preserve a copy of the current data directory, place the complete backup in the configured data directory or volume, preserve ownership and permissions, and start the service again.

Restoring a server backup recovers a replica; it does not roll every device back to that point. On reconnect, devices merge their newer local changes into the restored server.

A server backup contains only updates and images that reached the server. Devices can still hold unsynchronized edits. Browser data is also subject to storage quotas, browser eviction, and the user clearing site data. [Browser storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)

## Development checks

After running `setup.sh`, run these commands from `stow-git/`:

```sh
npm test
npm run build
npm run test:e2e
```

The browser tests use Playwright and require its browser dependencies. The implementation's relevant checks cover offline and concurrent editing as well as the UI; passing them does not establish behavior on every mobile browser.

`npm test` runs the native Rust backend tests and the TypeScript client tests, including Yjs interoperability against the actual Rust server. See [contributor checks](CONTRIBUTING.md).

The browser tests serve the production build, so run `npm run build` first. They use Chrome at `/opt/google/chrome/chrome` when present; otherwise install Playwright's Chromium with `npm run browsers:install`, or set `CHROME_PATH` to your Chrome executable. Downloaded browsers, reports, test results, and test-server data stay under `../build/`.

## Design boundaries

Each device loads one vault CRDT containing current live, archived, and trashed notes. Saved history lives separately on the server and is fetched on demand. Incremental indexes and windowed cards limit editing and rendering work. The server durably writes small updates before acknowledging them and periodically compacts its log into a snapshot. Initial loading and memory still grow with the full vault; saved versions do not contribute to client CRDT growth. Note history is bounded on the server, independently of optional archive cleanup. See the [architecture](docs/architecture.md).

Backgrounded mobile web apps may be suspended. Stow synchronizes while active and reconnects when reopened; it does not promise uninterrupted background execution. Thumbnails and cached originals become available offline after they reach that device.

Settings → Download vault backup requires connectivity and downloads current note content, server snapshots, and CRDT data as JSON (`stow-export-v3`). Offline Export current notes downloads current data without saved history. It includes image references, but not the image bytes; use a complete data-directory backup to preserve images too.

The combined current-data, worker-persistence, server-history, and binary-sync contracts are documented in [storage protocol](docs/storage-protocol.md).
