# Development

Use Node.js 22 or later, rustup (the toolchain is pinned in `rust-toolchain.toml`), Python 3, and ImageMagick 6 with JPEG, PNG, GIF, WebP, and HEIF/AVIF codecs. On Ubuntu 24.04, install `build-essential`, `pkg-config`, and `imagemagick`.

Give each checkout its own containing workspace. From that workspace:

```sh
git clone YOUR_REPOSITORY_URL stow-git
cd stow-git
./setup.sh
npm run browsers:install -- --with-deps firefox
npm run check
```

`setup.sh` installs locked dependencies into `../build/` and creates the sibling `node_modules` link. Build output, Cargo caches, browser downloads, logs, and disposable test data stay in `../build/`. Persistent vaults and private configuration belong outside both source and build. Use `scripts/cargo.sh` for direct Cargo commands with these paths.

`npm run check` runs the same checks as GitHub CI: Rust formatting and Clippy, native and client tests, TypeScript checking and the production build, tool smoke tests, and Playwright browser journeys. The workflow also scans the tracked tree and complete Git history for secrets. To run that check locally, use `scripts/check-secrets.sh` with Gitleaks on `PATH` or `GITLEAKS_BIN` set to its executable. Logs and failed-browser traces are uploaded on CI failure.

For a narrower check, use `npm test`, `npm run build`, or `npm run test:e2e`. Browser tests serve the production bundle, so build first. Set `CHROME_PATH` to select another Chrome executable; otherwise the suite uses installed Chrome when available or Playwright Chromium. Performance runners use `CHROME_PATH` or Playwright Chromium.

The [browser-only demo](docs/DEMO.md) has its own static build and browser tests:
`npm run build:demo`, then `npm run test:demo`. CI checks it in both Chromium and
Firefox, including the absence of note persistence and sync.

`npm run test:sync` builds and runs the offline/reconnect harness, including seeded three-participant schedules, process-kill durability checks, and Chromium/Firefox browser interruptions. CI runs the Firefox sync cases in addition to the full Chromium suite. See [sync testing](docs/SYNC_TESTING.md) for replaying and reducing saved failures and running larger workloads.

Installer regression tests run with `python3 -B -m unittest discover -s tests/hosting`. Separate CI jobs run `sudo python3 -B tests/hosting/smoke.py --mode MODE` for `home`, `proxy-loopback`, and `proxy-lan` on a systemd host with Podman and the locked Node dependencies installed. Each creates and removes a disposable installation, tests Chromium with real CA trust, and verifies uploads, offline edits across updates, backup/restore, and crash recovery. They also exercise Takeout preview/apply/retry with images, persistent backups, and host development tools blocked. The proxy cases exercise the generated nginx snippet with local and remote HTTP backends. Logs stay in `../build/logs/hosting-MODE`.

For local development, run `npm run dev` and open `http://localhost:5173`. See [developer information](docs/DEVELOPER_INFO.md) for workspace layout, environment variables, HTTPS development, and production builds, or [Podman](docs/PODMAN.md) for the container build.

Backend tests live in `server-rust/tests/` and beside the native fixture, lab, cache, and transport modules. Client interoperability tests send real Yjs updates to the Rust service. Browser journeys cover editing, history, account isolation, offline recovery, and installation. Add a behavioral regression when a change exposes a gap in these checks.

See [architecture](docs/architecture.md), [storage protocol](docs/storage-protocol.md), and [performance tools](docs/performance.md) for the implementation contracts. Stow is licensed under [GNU AGPL v3 or later](LICENSE); contributions use that license.
