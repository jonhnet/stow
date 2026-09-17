# Browser-only demo

The demo is a separate, static build of the real Stow interface and editor. Each
page creates a new in-memory Yjs vault with 32 sample notes. Notes, nested
checklists, colors, labels, search, ordering, merging, session Undo/Redo, archive,
trash, and Markdown export work locally. No Stow backend or account is involved.

There is **no timer**. Edits survive while the page remains alive, including when
the tab is merely hidden. Reloading, starting fresh, closing the tab, or the
browser discarding it loses edits. Returning through the back/forward cache also
starts fresh. Separate tabs have independent content. No notes are written to
IndexedDB, local/session storage, cookies, a service worker, or a server.

The persistent Demo banner explains this even when folded away. Its expanded
copy lists the unavailable features: image uploads, saved version history,
device sync, and offline installation. **Install Stow** opens the
[GitHub README](https://github.com/jonhnet/stow#readme), where visitors can choose
a self-hosting setup. It does not install this disposable playground.

## Build and preview

After the normal checkout's `./setup.sh`:

```sh
npm run build:demo
npm run demo:preview
```

Open <http://localhost:4175>. The artifact is `../build/demo/`, independent of
the normal application's `../build/dist/`. The demo build and preview require
only the installed Node dependencies; they do not start or build the Rust server.
The preview binds to loopback and provides only static GET/HEAD routes.

## Hosting

Serve **only the contents of `../build/demo/`** from a static HTTPS origin, such
as `https://stow-demo.tech.jonh.net`. Do not deploy the source tree, workspace,
private configuration, data directory, or Stow server. The static host needs no
credentials, database, writable application directory, WebSocket forwarding,
upload handler, or authentication service. Build on a development/CI machine;
neither Node nor Rust is needed on the static host.

Use a dedicated origin, separate from a real Stow installation. Do not replace
an installed Stow PWA with the demo at the same origin: an existing service
worker could continue serving the real application's cached shell.

For example, the infrastructure owner can serve the build at
`/var/www/stow-demo/current` with this nginx server behind their HTTPS terminator
(or place these locations in their existing TLS server):

```nginx
server {
    listen 80;
    server_name stow-demo.tech.jonh.net;
    root /var/www/stow-demo/current;
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    if ($request_method !~ ^(GET|HEAD)$) { return 405; }
    add_header X-Content-Type-Options nosniff always;
    add_header Referrer-Policy no-referrer always;
    add_header Content-Security-Policy "frame-ancestors 'none'" always;

    location = / { try_files /index.html =404; expires -1; }
    location = /index.html { expires -1; }
    location = /icon.svg { expires -1; }
    location /assets/ {
        try_files $uri =404;
        expires 1y;
    }
    location / { return 404; }
}
```

Retain previous hashed assets across updates so an already-open page can finish
loading them. Publish the new HTML after its assets are available. There is no
vault to migrate or session cleanup job to run. Request logs can contain normal
static-file access information; the application never sends note contents.
The HTML's content security policy forbids fetch/XHR, WebSockets, workers, and
form submission; it allows only bundled scripts/styles and local images. The
static host must independently reject writes—client code is not access control.

After hosting, verify on desktop and phone: the banner is visible, kitten images
open, editing and Undo work, and reload discards edits. Confirm `/api/session`,
`/sync`, `/sw.js`, and unknown files return 404 and POST/PUT requests fail. Then
add the live demo link near the top of the README with the explicit warning
that changes are not saved or synchronized.

## Sample content and assets

The original comedy corpus lives in `src/demo/seed.ts`. A local seeded Markov
generator mixes paragraphs with curated notes about refrigerator diplomacy,
haunted appliances, and kitten committees. Each visit chooses new wording,
colors, shuffled filler notes, and four distinct pictures from twelve bundled
kittens. Four notes begin archived and three in trash. Seed construction leaves
Undo empty; the first Undo always reverses the visitor's own action.

The twelve photos were generated with the built-in imagegen tool, then encoded
as WebP at their original resolution. Together they occupy about 1.2 MB. Only
the four selected photos preload on a visit; thumbnails and originals share
the same static files. The browser may cache these public assets, never edited
notes. See [the exact prompts](../src/demo/kittens/prompts.json) and
[the asset catalogue and hashes](../src/demo/kittens/catalogue.json).

## Implementation and tests

`vite.demo.config.ts` replaces the account store import with `src/demo/store.ts`
at build time. The adapter implements the same public store interface, backed
only by a `Vault` and allowlisted image URLs. Unsupported operations fail with
explanations; they cannot fall through to account, storage, upload, history, or
sync services. The normal build explicitly disables demo mode and does not
include the kitten assets. URL parameters cannot switch a real vault into demo
mode. Startup diagnostics and PWA installation are disabled in the demo.

```sh
npm run build:demo
npm run test:demo
STOW_TEST_BROWSER=firefox npm run test:demo
```

These production-bundle browser tests run in regular CI alongside the real app's
tests. They prohibit storage writes and network APIs while exercising editing,
Undo, search, and export; check tab isolation, reload/navigation disposal,
disabled uploads/history/installation, sample images, and the phone banner;
and check static-host routes. Node tests check diverse deterministic seeds,
content size, initial undo state, and all twelve image hashes.
