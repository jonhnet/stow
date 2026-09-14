# Synthetic performance tools

These tools exercise current data, server history, worker persistence, and binary transfer against the Rust implementation. They use synthetic fixtures and disposable accounts. Reports belong in the sibling `build/` directory and are not source files.

After `./setup.sh` and `npm run build`, run commands from the checkout with the build environment:

```sh
export STOW_SOURCE_DIR="$PWD"
. scripts/environment.sh
node --import tsx scripts/experiment-storage-lifetime.ts --max-actions 101
mkdir -p ../build/storage-lab
node --import tsx scripts/storage-lab/fixtures.ts
node --import tsx scripts/storage-lab/build.ts
./scripts/cargo.sh build --locked --release --features test-support --bin stow-test-driver
../build/cargo-target/release/stow-test-driver lab --local-test
```

The last command stays running. In another shell with the same environment, use `node scripts/storage-lab/automate.mjs --engine chromium` for browser measurements, `node scripts/storage-lab/check-ui.mjs` for harness focus/error/completion checks, or `node --import tsx scripts/storage-lab/transfers.ts` for large transfers. Install Playwright Chromium or set `CHROME_PATH`. Firefox runs additionally need Firefox and geckodriver; the runner accepts `--firefox-bin` and `--geckodriver`.

The lifetime experiment refuses an existing output directory; select a new `--output` under `build/` for another run. Fixture generation likewise refuses reuse. The gateway accepts `--fixtures-dir`, `--bundle-dir`, and `--base` to select a frozen trial, and the browser runners accept matching `--origin` and `--base` values. Keep bundle and fixture inputs fixed while collecting comparable device reports.

For device access over HTTPS, run `scripts/storage-lab/serve.sh PRIVATE_ENV_FILE HTTPS_ORIGIN` and proxy `/storage-lab/` unchanged, including WebSocket upgrades, to port 4180. The environment must supply the private proxy proof. The gateway derives separate accounts for each verified principal, scenario, and run; `--local-test` cookie authentication is restricted to loopback origins. It never opens a deployment vault.

Open `/storage-lab/fresh/?startup-profile=1&auto=1` to measure all five fixture policies. Keep the page visible through initial loading, cached reloads, history previews, synthetic editor input, and worker compaction. Reports contain numeric timings and source, bundle, and fixture fingerprints. Synthetic DOM events and desktop mobile viewports do not measure a phone keyboard or phone performance.

CI runs a short lifetime experiment and an HTTP/WebSocket lab smoke test. These check runnable tools, isolation, numeric report filtering, and compression behavior. Device timings remain separate measurements. Cold history opening still parses saved bundles, and a preview reads its component bundle; compression bounds endpoint counts rather than total lifetime CRDT bytes.
