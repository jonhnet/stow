# Developer information

Stow uses React, TypeScript, Yjs, and IndexedDB in the browser, with an Axum/Tokio/Yrs server written in Rust. See [contributing](../CONTRIBUTING.md) for prerequisites, dependency installation, tests, and CI.

## Local development

Give each checkout its own workspace:

```text
workspace/
├── stow-git/     # Source checkout
├── build/        # Disposable dependencies, binaries, caches, and test output
├── data/         # Persistent vaults, attachments, and server identity
├── .env          # Optional private configuration
└── node_modules -> build/node_modules
```

From the checkout, run `./setup.sh` and `npm run dev`, then open `http://localhost:5173`. The command starts Vite and the Rust server. Rust changes build while the existing server keeps answering; a successful build triggers a restart, while a failed build leaves the existing process running.

`setup.sh` installs the locked JavaScript dependencies and builds the Rust server. Run it again after dependency changes. Dependencies belong in `../build/`, so do not run `npm install` inside the checkout. Stop Stow before deleting the disposable build directory; keep `data/` and private configuration.

`run-dev.sh`, `import-keep.sh`, and `reset-account.sh` source the sibling `.env` as shell settings, with file values overriding existing shell variables. `run-dev.sh` requires the credential for the selected authentication mode. Direct `npm run dev` and `npm start` require server settings to be exported in their environment; they do not source that file. Vite separately reads workspace env files for its browser build.

To use another device during development, configure an HTTPS proxy and run:

```sh
STOW_ORIGIN=https://notes.example.com STOW_PASSWORD='choose-a-long-password' npm run dev:lan
```

Forward HTTPS and WebSocket traffic to the development machine's port 5173. Vite listens on all interfaces, permits the configured hostname, and proxies `/api` and `/sync` to the Rust server on port 3001. Its file server denies access to private data and configuration. See the [nginx example](nginx.conf.example); it also supports hot reload and 20 MB image uploads.

## Production build

```sh
npm run build
STOW_PASSWORD='choose-a-long-password' npm start
```

The build produces `../build/cargo-target/release/stow-server` and `../build/dist/`. The server serves the browser bundle, API, and WebSocket sync from one origin, defaulting to `http://localhost:3001`. Node.js is needed for the browser build and import tools, but not for the production server. The native server needs ImageMagick and its supported image codecs.

Settings displays the running browser bundle's commit hash and commit date (UTC),
with a modified marker for a dirty checkout. Vite embeds these at build time;
an old tab therefore identifies its own code. `git archive` exports the same
metadata through `build-version.json` and `.gitattributes`, without shipping
`.git`. `self-host.py` passes it into the container build. For a direct container
build from a checkout, supply `--build-arg STOW_BUILD_INFO='{"commit":"<full Git hash>","committedAt":"<ISO commit date>","dirty":false}'`.
Source copies without Git or substituted archive metadata display “unversioned”.

For a separately installed executable, explicitly configure `DATA_DIR` and `STOW_STATIC_DIR`; their defaults refer to the workspace where the executable was compiled. The [Podman image](PODMAN.md) sets these paths inside the container.

## Environment variables

The disposable [browser-only demo](DEMO.md) is a separate static artifact built
with `npm run build:demo`; it does not use the server settings below.

Keep credentials outside the checkout and `build/`. Start with [`.env.example`](../.env.example). Only browser-visible build settings should use Vite's `VITE_` prefix.

| Variable | Meaning |
| --- | --- |
| `HOST` | Server bind address; defaults to `127.0.0.1`. Use `0.0.0.0` to accept connections on other interfaces. |
| `PORT` | Server HTTP and WebSocket port; defaults to `3001`. Vite's development proxy targets port 3001. |
| `DATA_DIR` | Persistent vaults, blobs, settings, and server identity; defaults to the compiled workspace's `data/`. Must be outside source, build, and static assets. |
| `STOW_STATIC_DIR` | Built browser assets; defaults to the compiled workspace's `build/dist/`. |
| `STOW_AUTH_MODE` | `password` (default) for one personal vault, or `proxy` for distinct authenticated users. |
| `STOW_PASSWORD` | Personal vault password; ignored in proxy mode. Passwordless access is permitted on loopback for development. |
| `STOW_PROXY_SECRET` | Required in proxy mode, at least 32 characters. The proxy must overwrite `X-Stow-Proxy-Secret` with this value. |
| `STOW_ORIGIN` | Exact browser-facing origin, including scheme and any nondefault port. Sets origin validation and enables Secure session cookies for HTTPS. Also configures Vite's allowed hostname and hot-reload URL. |
| `STOW_ALLOW_INSECURE` | Explicitly permits passwordless binding beyond loopback when set to `true`; never relaxes proxy authentication. |
| `STOW_SERVER_BIN` | Optional native executable override for administrative/import tools. Does not change the executable used by `npm start`. |
| `VITE_STOW_DEVELOPMENT` | Set to `true` while building to mark an intentionally non-authoritative production bundle. Development builds always show the warning. |
| `CHROME_PATH` | Optional Chrome executable for browser tests and performance runners. |

## Multiple users behind an authenticating proxy

Use `STOW_AUTH_MODE=proxy` with a private `STOW_PROXY_SECRET` and the HTTPS `STOW_ORIGIN`. Generate the secret with `openssl rand -hex 32`. Configure the proxy to overwrite `X-Auth-User` with its verified stable identity and `X-Stow-Proxy-Secret` with that secret on both HTTP requests and WebSocket upgrades. Never forward a browser-supplied identity as verified authentication. See the [proxy header example](nginx.conf.example).

Each identity owns separate server and browser storage. A shared Stow password supplies one vault, not multiple user identities. Proxy mode rejects missing identity/proof without falling back to password mode. Password mode refuses a data directory containing proxy-user vaults. Use a separate directory when setting up a password instance.

Account changes hide the previous vault and retain its pending edits until that account returns. Offline startup may reopen the last verified account. Local files are accessible to anyone controlling the browser profile or disk; authentication is server access control, not end-to-end encryption. Startup and login never import another account's data.

## Offline operation and installation

Use one stable HTTPS URL across devices. HTTP localhost is supported for development; an HTTP LAN address on a phone is not localhost. The production build registers the offline service worker; Vite development mode does not.

In Android Chrome, **Settings → Install Stow** opens the browser's installation confirmation when Chrome offers it. The installed PWA has its own icon and window. Its app shell is cached for offline opening. Complete the first sync and thumbnail downloads before expecting a device to work offline. Sync runs while Stow is active and reconnects when reopened; background mobile apps may be suspended.

Android install assets derive from `public/icon.svg`. Regenerate them with `node scripts/render-icons.mjs` after changing the SVG. Browser tests cover installation and the offline shell.

Viewed originals use a 50 MiB cache; thumbnails download automatically. Pending uploads are retained beyond that budget. Clearing browser data can discard edits or images that have not reached the server. **Download vault backup** requires connectivity and includes server history; offline **Export current notes** excludes history. Neither includes image bytes, so retain a [complete data-directory backup](../README.md#back-up-and-restore).

## Behavior and maintenance references

The [architecture](architecture.md) documents stable note/item identities, ordering, merges, undo, permanent deletion, and image ownership. Undo/Redo survives reload and PWA restart in the same browser, with a combined 200-step limit per stack. Cleanup keeps at most three inactive stacks, expiring them after a week without changes; live tabs retain their own stacks. Individual steps have no age limit. Saved server history restores copies across devices. Intermediate offline edits may merge into one server-observed version.

See [label identity](label-model.md), [archive history cleanup](archive-history-cleanup.md), and [storage protocol](storage-protocol.md) for their current contracts. Administration and measurement procedures live in [Keep import](import-keep.md), [account reset](account-reset.md), [startup diagnostics](startup-diagnostics.md), and [performance tools](performance.md).
