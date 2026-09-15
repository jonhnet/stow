# Stow

Stow is a lightweight, self-hosted personal notes app with a comfortable, familiar user interface.
It features a draggable overview, markdown text body, checklists, images, links, note colors, and labels.
It synchronizes between your browsers and phone and supports offline
editing. It can be installed as an app (PWA) on Android.

## Writing and formatting

Note bodies support headings, paragraphs, bulleted and numbered lists, quotations, horizontal rules, fenced/indented code, and tables. Both note bodies and checklist items support `*italic*`, `**bold**`, `~~strikethrough~~`, inline code, and `[named links](https://example.com)`. Web URLs, `www` addresses, and email addresses are recognized automatically. Checklist items use inline syntax only: a leading `#` or `-` remains ordinary item text. Single line breaks remain visible.

Links remain ordinary clickable links. Webpage preview cards and fetching their titles, descriptions, or thumbnails are outside Stow's intended scope.

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

Proposed workflow: run the Podman setup on a Linux server, enter your domain name and Stow password, and point the domain at the server. With ports 80 and 443 reachable, [Caddy obtains and renews the HTTPS certificate](https://caddyserver.com/docs/automatic-https). If you already have an HTTPS reverse proxy, use it to forward Stow's HTTP and WebSocket traffic instead.

Open your HTTPS URL from any device, sign in, and optionally install the PWA. No per-device certificate installation is needed. Your server stores the notes, and your devices can sync wherever they have internet access.

The internet-facing setup is still proposed. For now, use the [Podman guide](docs/PODMAN.md) with an existing HTTPS proxy.

## Back up and restore

For the home setup, follow its [backup and restore commands](docs/HOME_HOSTING.md#back-up-and-restore), which also preserve the password and local certificate authority.

Back up the **complete data directory**, including `session-secret`, `vault-incarnations.json` if an [account reset](docs/account-reset.md) has been performed, and each vault's `vault.yjs`, `updates/`, `blobs/`, `blob-cleanup.json`, `history/`, and `history-retention.json` under `users/` (or the data directory itself in password mode). A snapshot alone can omit newer edits stored in `updates/`. Include any retained original files too. The server secret and account reset registry determine current user vault IDs, so preserve them. Stop the service first so snapshots, update logs, and blobs are copied together consistently. For the container described in the [Podman guide](docs/PODMAN.md), run `podman stop stow` before copying its volume and `podman start stow` afterward.

Back up the private workspace `.env` separately with appropriate access controls. The source checkout and disposable `build/` directory are not vault backups.

To restore, stop the service, preserve a copy of the current data directory, place the complete backup in the configured data directory or volume, preserve ownership and permissions, and start the service again.

Restoring a server backup recovers a replica; it does not roll every device back to that point. On reconnect, devices merge their newer local changes into the restored server.

A server backup contains only updates and images that reached the server. Devices can still hold unsynchronized edits. Browser data is also subject to storage quotas, browser eviction, and the user clearing site data. [Browser storage persistence](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)
