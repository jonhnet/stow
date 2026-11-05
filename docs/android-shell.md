# Android shell and offline refresh

Status: implemented; validation results below. No production deployment or real-device trial is part of this change.

## Product contract

Stow's Android application retains the existing web editor. Opening an initialized account displays the installed web release and locally saved notes without waiting for authentication, a version check, or a network response. Google Play services, Firebase, and third-party push infrastructure are not runtime dependencies.

Android schedules a bounded refresh every 15 minutes with a connected-network constraint. Network availability requests another refresh when the last successful refresh is at least five minutes old. Requests coalesce; interrupted work retries with backoff. Registration survives process death and is restored after reboot. These are opportunities, not deadlines: Doze and Android power policy can defer work.

The foreground app records native registration and starts uploading diagnostics even before its first worker run. Server `lastForegroundAt` is evidence of an app check-in; `lastBackgroundAt` and wake/success events describe actual worker activity. A foreground registration is not evidence that Android ran a background refresh.

The acceptance case is: edit a note on another client, leave Android Stow closed, provide an online opportunity, disconnect, then open Stow and read the new note. Merely logging a worker wake does not pass.

This first shell reuses the existing background refresh scope: download the private vault's note content and metadata. Uploading local edits, fetching images, and refreshing separately stored shared-note contents happen in the foreground. It does not add a second native implementation of those synchronization paths.

## Implementation

1. **Native host:** a small Android application, WorkManager scheduler, persistent network registration, WebView host, external-browser account pairing, release installer, and narrowly scoped native messaging. Generated Android SDK/Gradle outputs and emulator data live in sibling `build/`.
2. **Shared JavaScript:** a dedicated background entry point uses Stow's existing Yjs download, atomic IndexedDB persistence, account checks, and diagnostics. A scheduled native worker creates a bounded, offscreen WebView using the same application profile and installed release as the foreground UI. It explicitly executes the refresh; browser periodic-sync scheduling is not involved. Emulation must establish that this works after process death and during Android-granted execution windows.
3. **Account pairing:** authentication happens in the external browser. A short-lived, single-use pairing request with a secret verifier grants a revocable Stow device credential bound to one account and vault incarnation. Native credentials never grant access to a different account. Credentials are stored in app-private storage and provided to same-origin native API requests, not arbitrary pages. No Google credentials are collected.
4. **Proxy routing:** `/native/` is served by Stow without an upstream interactive-login challenge. It has its own device authentication; ordinary browser and administrator routes continue using their configured authentication. Pairing approval occurs through an ordinarily authenticated browser route. Document the operator routing change; do not change production.
5. **Web releases:** a build manifest identifies a complete release, content hashes, and minimum shell API. Download to staging, validate every asset, and publish the installed-release pointer atomically. HTML and assets always come from one release. Incomplete or incompatible releases cannot displace the installed version. Vault storage is independent of application bundles.
6. **Activation:** show “New Stow update available” with Restart only after staging completes. Explicit restart flushes local writes and captures view state. Automatic activation requires the app to become hidden, with no editor, drag, selection, modal, or unfinished local operation. Restore view, filter, and scroll anchor. Remote acknowledgment is not required; local durability is.
7. **Shell updates:** manifest metadata advertises the recommended APK, version, checksum, Android requirement, and shell API. A compatible web release may continue on an older shell. Offer a user-initiated download and Android installer confirmation for a signed shell update. Release signing keys remain outside Git/build. No automatic production publication.
8. **Diagnostics:** record native scheduling triggers/outcomes as well as JavaScript refresh results, with device, shell, and web build stamps. Upload bounded logs when online. Distinguish native scheduling, successful cache writes, authentication failures, and canceled attempts.

## Test matrix

| Case | Required evidence |
| --- | --- |
| Fresh pairing | Browser approval and secret verifier required; returned credential opens exactly the approved account. |
| Pairing attacks | Wrong verifier, replay, expiration, foreign origin, and unauthorized approval rejected. |
| Account boundaries | Wrong vault binding, revoked credential, changed incarnation, and a second account cannot access or overwrite the first account's cache. |
| Closed app | Native worker runs with no Stow activity and no foreground browser control tab; another client's note is durable before success. |
| Process death/reboot | Scheduler and connectivity registration recover; cached notes still open offline. Force-stop is tested separately from ordinary process death. |
| Offline launch | Cached content appears with server unreachable or hanging; no network deadline controls display. |
| Connection loss | Disconnect before handshake, mid-transfer, and during retries; no false success, partial durable update, or lost pending local edits. |
| Reconnection | Wi-Fi/mobile availability after process death requests work; repeated network events coalesce and respect recent-success throttling. |
| Doze | Observe deferral in forced Doze; verify recovery at an allowed opportunity/exit. Record separately any forced JobScheduler executions and natural scheduling observations. |
| Concurrent editing | Background download and foreground local writes converge; local pending edits survive interruption/restart. |
| Web updates | Complete release installs; missing/corrupt assets, HTML login responses, redirects, interrupted downloads, and incompatible shell API do not activate. |
| Update activation | Restart works offline; no automatic restart during edit/composition/drag/modal/local save; view/filter/scroll restored. |
| Update/process races | Terminate during staging and after publication; installed release is complete. Existing page and worker continue loading assets from their pinned release. |
| APK updates | Advertise only valid metadata; verify checksum/package/signing identity; cancellation retains current app and data. |
| Security boundary | External navigation has no native bridge; unsupported origin/protocol and untrusted frame calls rejected. |
| Diagnostics | Trigger, start, finish/failure/cancellation and build stamps persist through process death and upload without note content or credentials. |

## Validation and handoff

Run focused Rust, JavaScript, native unit/instrumentation tests, then the full existing CI suite. Use an isolated emulator and disposable test server/accounts. Exercise actual radio changes and verify that ADB forwarding cannot conceal offline status. Preserve machine-readable results under `build/android-shell/`.

Run a natural periodic observation without shortening Android's interval or forcing the job. Report observed scheduling separately from deterministic fault-injection coverage. Emulation establishes correctness; eventual phone/tablet trials measure manufacturer power policy and battery cost. Do not request human trials until the emulator suite is passing.

Before completion, commit and push tested changes to the common repository, verify shared main, and report remaining work. GitHub publication and production deployment require separate authorization.

## Build and operate

Requirements: Java 17, Android SDK platform/build-tools 35, a current Android System WebView, and the normal Stow build prerequisites. The shell supports Android 9/API 28 and later. Set `ANDROID_HOME` to an SDK outside the source tree. `./android/build.sh` downloads checksum-pinned Gradle into `../build/android-shell/`, then runs native unit tests and builds a debug APK. Outputs are in `../build/android-shell/gradle/app/outputs/apk/`. The debug signing key is disposable and also lives in `build/`.

The native shell connects to a Rust server serving a compiled web release. Vite's source/HMR development server is not an installable release; use the isolated compiled-server emulator harness below for Android development.

For a real release, keep a long-lived signing keystore outside both Git and disposable build storage. Set `STOW_ANDROID_KEYSTORE`, `STOW_ANDROID_STORE_PASSWORD`, `STOW_ANDROID_KEY_ALIAS`, and `STOW_ANDROID_KEY_PASSWORD`, then run:

```sh
./android/build.sh stageStowRelease -PstowVersionCode=1 -PstowVersionName=0.1
```

Increment `versionCode` for every APK update and keep the signing key. The application verifies the APK checksum, package name, version, and signing identity before offering it to Android's installer. The user must permit installation from Stow and approve the update; cancellation leaves the installed app and account untouched.

`npm run build` emits the web `release.json`. `stageStowRelease` produces a signed APK with a content-addressed filename and matching APK metadata in `../build/android-shell/publish/release/`.

Publish the APK into the server's **`DATA_DIR/android-release/`** first; then atomically replace that directory's `release.json` with the generated metadata. This is a public artifact directory: never put signing keys or private configuration there. The native manifest endpoint combines the current web release with this persistent APK announcement. Ordinary web deployments do not need to rebuild, copy, or remember the APK. With no APK publication, compatible web updates still work; malformed/incomplete publications produce an explicit error and cannot displace an installed release.

In the web app or installed PWA, open **Settings → Get Android app** to download the published APK. This link appears when Settings discovers an APK in `/native/release.json`; opening notes never waits for that check. APK publication remains part of the operator's deployment process. The Android shell uses its existing update prompt instead of this initial-install link.

An APK announcement looks like this (the build task supplies the real checksum):

```json
{"version":2,"minSdk":28,"url":"/native/android/stow-2-<hash-prefix>.apk","sha256":"<64 lowercase hex digits>"}
```

This task does not publish an APK or alter any production server. The disposable debug key and debug APK are for emulation; use the permanent release signing key before installing on real devices that will hold real notes. HTTPS accepts system roots and roots explicitly installed by the device owner, including a self-hosted local CA; certificate errors are never bypassed.

For a proxy-authenticated installation, route `/native/` directly to Stow **without the interactive login middleware**. Preserve Host, Origin, cookies, and WebSocket upgrades. This is not anonymous vault access: `/native/api/*` and `/native/sync` require a separately revocable Stow device credential. Public routes expose only web/APK assets and the unapproved pairing handshake. `/device.html` and `/api/devices/*` retain the normal browser authentication middleware. The existing proxy proof continues protecting ordinary proxy identity headers. Never expose a second endpoint that accepts untrusted identity headers.

The first launch asks for the Stow HTTPS origin and a device name, displays a pairing code, then opens the external browser when you press Open sign-in page (copying the code for pasting). Approve that code in your normal authenticated browser, then return to the app for its first download. Subsequent launches use the installed release and this installation's account cache. An installation is bound to one origin and one account/incarnation; signing in again can replace a revoked credential for that same account, never migrate cached notes into another account. Settings → Connected Android devices opens the browser's revocation page.

A changed vault incarnation requires a fresh installation/account cache. Preserve/export old pending edits first. Android backup and device transfer are disabled; a new device pairs independently. Neither the app nor its public Git repository contains Google credentials, deployment credentials, or a production signing key.

## Repeat the emulator checks

Use a **disposable, rooted emulator**, not a phone or an emulator containing personal data. The harness clears `net.stowapp.android` in that emulator, uses temporary accounts and a local test server, and changes only the test port's firewall rules. It restores connectivity and Doze overrides on exit.

Build the normal test server and web release, boot an emulator, then:

```sh
# With the normal scripts/environment.sh environment loaded:
cargo build --locked --features test-support
npx vite build
tests/android-shell/run.sh emulator-5580

# Separate observation: no forced jobs or shortened Android interval.
node tests/android-shell/emulator.mjs --serial emulator-5580 --observe 1200
```

The deterministic suite and native instrumentation are in the Android CI job. The existing browser CI also checks update activation and browser pairing. Natural observation is a separate experiment because Android scheduling is not a deadline contract.

Android force-stop intentionally suppresses jobs until the user launches the app again. Network callbacks and periodic work survive ordinary process death, but cannot override force-stop, disabled background execution, or manufacturer battery restrictions. Doze may defer work until a maintenance opportunity or exit. Emulator evidence does not establish battery cost or scheduling reliability on every manufacturer's device.

## Validation results (2026-11-04)

The test environment is an isolated Android 16/API 36 emulator with WebView 133. The deterministic suite disables Play services (and the Google assistant, which otherwise opens a Play-services repair screen over test touches), then restores their original enabled state. No production accounts or real devices are used.

- **Natural scheduling:** after the activity closed and its process was killed, a periodic worker saved a new desktop note at 04:18:32 UTC, about 15.5 minutes into the observation. The harness subsequently removed connectivity and verified that note in a freshly opened app. This observation did not shorten the periodic interval or force a JobScheduler run. Evidence: `build/android-shell/trial-r9SVuW/`.
- **Deterministic recovery:** actual process death, radio/forwarding loss before the handshake and during a sync payload, reconnection wake, retained offline edits, forced Doze deferral and recovery on exit, offline reboot, explicit force-stop suppression, and WebView renderer death. A port-specific firewall prevents existing ADB-forwarded sockets from disguising an offline device.
- **Updates:** interrupted staging retains the installed release; verified staging can activate offline. Hidden activation restores search; browser tests also verify scroll-anchor restoration and editing/selection/composition/drag/modal barriers. APK cancellation and an actual Android installer update preserve the same offline vault. Native instrumentation covers bad checksums, missing assets, redirects, incompatible shell API, account mismatch, export integrity, and concurrent release download/activation.
- **Native UI:** first tap opens for reading; a real second touch opens the keyboard with the toolbar above it. The image test uses Android's photo picker → Browse and a real `content://` selection, rather than injecting a file through browser automation.
- **Diagnostics:** native events retain the trigger and shell version at creation, including when a later worker uploads them. Server-received diagnostics and successful durable refreshes are checked separately.

`npm run check` passed: 146 Rust tests, 526 JavaScript tests, 237 Chromium browser tests, 46 Firefox sync/account tests (three explicitly unsupported cases skipped), both eight-test demo suites, typecheck, Clippy, formatting, hosting unit checks, and tool smoke checks. The final targeted rebuild also passed 17 shell/background unit tests and eight browser regressions. Android adds three JVM tests, seven on-device instrumentation tests, lint, debug/release compilation, and the end-to-end emulator scenario. Android CI repeats the deterministic scenario; natural scheduling remains a separately runnable observation.

The final deterministic run passed in `build/android-shell/trial-IOT0eT/`, including uploaded diagnostic stamps and the native image picker. Full-check output is `build/android-shell/logs/full-check-release.log`; final Android output is `build/android-shell/logs/verified-emulator.log`. Logs, screenshots, and generated artifacts are disposable.

The remaining rollout work is operator configuration: publish a permanently signed APK and its metadata, deploy the server/web changes, and exempt `/native/` from interactive proxy login as described above. Real-device trials then measure scheduling and battery behavior on the intended phone/tablet; emulation cannot establish those manufacturer-specific outcomes.
