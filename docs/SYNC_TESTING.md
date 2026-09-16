# Offline and reconnect tests

Run the focused suite against the production UI build and disposable Rust servers:

```sh
npm run browsers:install -- --with-deps firefox
npm run test:sync
```

The first command installs Chromium and Firefox. The second builds and runs the
schedule, process-crash and protocol tests, then the browser schedules in both
engines. Set `STOW_TEST_BROWSER=chromium` or `firefox` to select one browser.
All data is synthetic and disposable; these tests never contact a deployed Stow
or open an existing account's storage. Generated output stays in `../build`.

## Three layers

| Layer | What it exercises | Boundaries and assertions |
| --- | --- | --- |
| `tests/sync-schedule.test.ts` | Real Vault operations, LocalPersistence, compaction, edit recovery, TabSync and search, using fake IndexedDB | Seeded operation/delivery schedules, partitions, duplicate updates, all six reconnect orders, shared tabs, failed writes and disk-only reload. Reads must not mutate the document. Live sources/items must remain projected exactly once; authored content survives exactly once unless its author undoes it; deletion wins; labels and views converge; resolved replicas have no pending CRDT dependencies. |
| `tests/sync-crash.test.ts` | Real Rust processes, filesystem and WebSockets with three independently edited documents | SIGKILL before rename and after file/directory fsync, for both update logs and deletion snapshots. No acknowledgment before publication completes. Replay after ambiguous completion is safe, unrelated edits survive, and acknowledged writes survive another kill. |
| `tests/browser/sync-schedules.spec.ts` | Production StowStore, workers, actual IndexedDB, HTTP/WebSocket sync, service worker, multiple browsers/tabs and the Rust backend | Session/snapshot/upload/acknowledgment gates, silent connection timeout with automatic recovery, shared compaction with a held write, lost image-upload response, stale socket callbacks and renderer crashes around local durability. Fresh browser contexts verify authoritative server state. |

Complete updates may arrive in a different order across participants, generations
of connections and tab/network paths. Each live WebSocket stays FIFO; malformed
frame ordering belongs to the separate protocol rejection tests.

Convergence alone is insufficient: the scheduler independently tracks authored
content. A self-test deliberately removes that content from every replica to
ensure agreement on a damaged state still fails. Reads also exercise projection
and search; raw checklist parent cycles are permitted, but the effective view
must expose every item once. A reload closes all original replicas before reading
disk, so surviving peers cannot hide a persistence failure.

## Reproduce and reduce a failure

Default CI runs eight fixed seeds of 75 operations plus deterministic schedules.
The manually triggered `Extended sync schedules` job runs 200 seeds of 250 operations.
It has no periodic schedule: unchanged code does not need daily repetitions of
the same deterministic seeds. Normal push/PR CI runs the smaller seeded suite
and the browser and crash coverage.
To choose a workload locally:

```sh
STOW_SYNC_SEEDS=1,42,202 STOW_SYNC_STEPS=250 node --import tsx --test tests/sync-schedule.test.ts
```

Failures save a versioned JSON schedule, seed, operation IDs, delivery events and
error under `../build/sync-failures/`. The test prints its exact replay command:

```sh
STOW_SYNC_REPLAY=../build/sync-failures/schedule-EXAMPLE.json node --import tsx --test tests/sync-schedule.test.ts
python3 -B scripts/reduce-sync-schedule.py ../build/sync-failures/schedule-EXAMPLE.json
```

The reducer keeps original step IDs and only accepts a smaller schedule when it
produces the same error. It stops after 100 attempts by default (`--attempts` can
change that); the result is a smaller reproducer, not a proof of minimality.
UUIDs, client identities and operation times are controlled for reproducible
conflict resolution. Review a reduced case, then preserve it as a named regression.

Browser failures retain Playwright traces/screenshots; gated reconnect cases also
attach their frame schedules. Use `npm run test:e2e -- sync-schedules.spec.ts
--grep 'interrupted at done'` to rerun a specific boundary. CI uploads both forms
of diagnostics.

## Limits and adding scenarios

The fast scheduler is a semantic test layer, not a replacement Rust server or a
replica of StowStore's reconnect implementation. Its fake IndexedDB does not
model browser eviction. Real browser tests cover workers and local commits;
renderer termination uses Chromium's CDP and is explicitly skipped on Firefox.
Desktop Playwright does not simulate Android sleep or operating-system process
eviction. Those still need device testing. SIGKILL tests exercise process death,
not power-loss behavior of physical disks.

Concurrent body-to-checklist conversion remains an executable TODO in
`tests/convert-checklist.test.ts`: both devices currently create new items for
each line. Random workloads exclude simultaneous conversion until that semantic
bug is fixed; a deterministic schedule covers conversion concurrent with remote
edits and Undo/Redo. Existing account-isolation, retention, image ownership and
storage-failure suites remain part of `npm run check`; this harness does not
claim to exhaust their Cartesian product.

To extend coverage, add an operation to the scheduler and its independent content
expectations, or a named multi-participant schedule with an explicit expected
outcome. Use a browser barrier for a reconnect/lifecycle bug. Use the storage gate
for a disk publication bug: it exists only with Rust's `test-support` feature and
is configured only by the disposable test driver. Do not enable it in deployment.
