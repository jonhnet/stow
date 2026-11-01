# Stow

Stow is a lightweight, self-hosted personal notes app with a comfortable, familiar user interface.
It features a draggable overview, markdown text body, checklists, images, links, note colors, and labels.
It synchronizes between your browsers and phone and supports offline
editing. It can be installed as an app (PWA) on Android.

After the first online visit, launches use the installed application shell and
the last verified account's local notes immediately. Checking sign-in and syncing
run afterward; a slow network does not hold the cache behind a spinner. A newly
verified different account stops sync and asks for a reload, keeping pending
edits in their original account. A fresh device still needs its initial download.

Installed apps can refresh notes while closed when the browser grants Periodic
Background Sync permission. Stow requests opportunities at least an hour apart;
the browser chooses the actual timing and may not run them. Settings shows
eligibility, the last successful sync, and the background worker’s last attempt,
success, and error on this device. Registration does not mean a refresh has run. Background refresh
downloads note content and metadata, preserves pending local edits and Undo, and
requires a still-valid sign-in. Image fetching and uploading local edits happen
when Stow is open. Before relying on a newly edited note offline, open Stow on that
device while connected and check that the note has arrived.

Settings → **Download background log** exports this device's most recent 200
events for the current account: permission/registration checks, browser wake-ups,
starts, skipped overlaps, failures, and successful downloads (duration and bytes).
Wake/start records are durable before the work begins, so an interrupted attempt
remains visible. Logs upload automatically on opening/reconnecting, roughly every
five minutes while Stow is open, and after background refresh attempts. Uploads
include a persistent browser-profile identifier, browser, and build, but no note
text or images. Offline records wait locally for a verified connection. The server
retains up to 30 days, 5,000 events per device, and 16 devices per account; see
[diagnostic storage and retrieval](docs/storage-protocol.md#background-diagnostics).
Foreground sync does not replace the worker's results. A registered app with no recorded
wakes has not observed a scheduling opportunity since logging began; this does
not predict whether the browser will schedule it later.

The [Android background-sync tests](tests/android/README.md) distinguish forced
worker execution from observation of the browser's real scheduling.

[Try the live demo](https://stow-demo.tech.jonh.net/).

## Writing and formatting

Note bodies support markdown-style headings, paragraphs, bulleted and numbered lists, quotations, horizontal rules, fenced/indented code, and tables.
Both note bodies and checklist items support inline markdown: `*italic*`, `**bold**`, `~~strikethrough~~`, inline code, and `[named links](https://example.com)`.

## Shared notes

Use **Share note** to create an editable link. Anyone with the link can participate;
**Add to my notes** keeps a personal reference with private labels, placement,
and archive state. See [sharing behavior and hosting requirements](docs/sharing.md).

## Run a dev server locally

Install the [development prerequisites](CONTRIBUTING.md), then run from the checkout:

```sh
./setup.sh
npm run dev
```

Open http://localhost:5173. See [developer information](docs/DEVELOPER_INFO.md) for environment variables, network development, and production builds.

## Self-host a production server inside your house

Run the [home setup](docs/HOME_HOSTING.md) on an always-on Linux computer with Podman and systemd. Reserve its local IP address in your router, then run `sudo ./self-host.py --address 192.168.1.20` from the checkout, substituting your server's address. Choose a Stow password when prompted. You need no domain name, port forwarding, or cloud account.

Browsers require HTTPS for Stow's offline support and security APIs, even on your home network, so this setup uses a locally trusted certificate. The setup gives you a local HTTPS address and a [local CA certificate](https://caddyserver.com/docs/automatic-https#local-https). Install that certificate once on each phone or computer, then open Stow, sign in, and optionally install the PWA. Notes sync over your home network. Away from home, you can edit cached notes; they sync when you return.

## Self-host an internet-facing production server

Run the [internet setup](docs/INTERNET_HOSTING.md) to put Stow behind your existing HTTPS proxy. One command builds the container, prompts for a Stow password, and installs its boot service. Point your domain and HTTPS proxy at the resulting HTTP endpoint; the installer supplies an nginx configuration snippet.

Open your HTTPS URL, sign in, and optionally install the PWA. Devices sync wherever they have internet access; no per-device certificate installation is needed.

## Bulk import from Keep Takeout

Follow the [Keep import guide](docs/import-keep.md) to import notes, checklists, labels, and images from a Google Keep Takeout export. Both self-hosting setups include a Podman import command that previews changes before applying them; no development tools are needed on the host.

## Back up and restore

For an installer-managed server, follow the [home](docs/HOME_HOSTING.md#back-up-and-restore) or [internet](docs/INTERNET_HOSTING.md#back-up-and-restore) backup commands, which also preserve its private configuration.

Back up the **complete data directory**, including the `shared/`, `sharing/`, and `share-references/` directories for [shared notes](docs/sharing.md), `session-secret`, `vault-incarnations.json` if an [account reset](docs/account-reset.md) has been performed, and each vault's `account.json`, `vault.yjs`, `updates/`, `blobs/`, `blob-cleanup.json`, `history/`, and `history-retention.json` under `users/` (or the data directory itself in password mode). A snapshot alone can omit newer edits stored in `updates/`. Include any retained original files too. The server secret and account reset registry determine current user vault IDs, so preserve them. Stop the service first so snapshots, update logs, and blobs are copied together consistently. For the container described in the [Podman guide](docs/PODMAN.md), run `podman stop stow` before copying its volume and `podman start stow` afterward.

To identify a vault directory, read its `account.json`: it records the verified username, authentication mode, and vault ID. Older directories acquire this file when their owner next opens Stow. Directories without it have an unknown owner; the server does not infer one from their contents.

Back up the private workspace `.env` separately with appropriate access controls. The source checkout and disposable `build/` directory are not vault backups.

To restore, stop the service, preserve a copy of the current data directory, place the complete backup in the configured data directory or volume, preserve ownership and permissions, and start the service again.

Restoring a server backup recovers a replica; it does not roll every device back to that point. On reconnect, devices merge their newer local changes into the restored server.

A server backup contains only updates and images that reached the server. Devices can still hold unsynchronized edits. Browser data is also subject to storage quotas, browser eviction, and the user clearing site data. [Browser storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
