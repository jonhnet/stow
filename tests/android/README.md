# Android background refresh checks

Use a disposable, rooted Android emulator, never a personal device. All profiles,
downloads, logs and emulator data belong in `build/` beside the source checkout.
The test changes emulator connectivity and creates notes only in the disposable
native browser-test server. It does not use production or the dev vault.

Build Stow first (`npm run build`) and start `../build/cargo-target/debug/stow-test-driver browser`
from the source directory. This is also the fixture used by Playwright; do not run
both servers at once. Use `npm test` to build the test driver if necessary.

Create an AVD using the installed SDK's `avdmanager`, with `ANDROID_AVD_HOME`
pointing to `../build/android/avd`. Start it with an unused even port, for example
`-port 5580 -no-window -no-audio -no-snapshot -gpu swiftshader_indirect`.
Run `adb -s emulator-5580 root`. The emulator needs a recent Chrome/Chromium;
the stock browser in older system images may be too old for Stow.

Launch the browser, complete its first-run screens, then forward its debugging
socket (adjust the socket for the installed package if needed):

```sh
adb -s emulator-5580 forward tcp:9223 localabstract:chrome_devtools_remote
PLAYWRIGHT_BROWSERS_PATH=../build/browsers node tests/android/background-sync.mjs \
  --serial emulator-5580 --output ../build/android/forced-result.json
```

The forced-event regression grants periodic-sync eligibility through DevTools,
registers the real production worker, closes every Stow window, creates a note on
a second client, stops the worker, and dispatches a `periodicsync` event. A blank
Chrome control tab stays foreground so Android does not suspend DevTools dispatch;
no Stow document is open. This proves worker behavior, not an Android wake. It then
disables Wi-Fi and mobile data, removes the ADB reverse tunnel and blocks the test
port (including existing connections). It verifies that the server is unreachable
and that the downloaded note opens offline. Cleanup restores connectivity.
No app handler, transport or persistence implementation is mocked.

For a scheduling observation, first install Stow through the browser and launch
it from the Android home screen. Then run:

```sh
PLAYWRIGHT_BROWSERS_PATH=../build/browsers node tests/android/background-sync.mjs \
  --serial emulator-5580 --observe-seconds 600 \
  --output ../build/android/natural-result.json
```

This mode removes permission overrides and requires real browser eligibility.
It disconnects DevTools, toggles connectivity, and waits without forcing events,
changing engagement scores, shortening Chrome's scheduling interval, or invoking
Android jobs. A result with no wake is an observation, not a pass proving periodic
delivery. The log explicitly distinguishes the modes and records actual attempt
and completion times. A standalone shortcut can be insufficient: Chromium on
Android checks for an installed WebAPK or TWA before granting permission.

The normal CI browser suite also runs a closed-window/offline regression with
desktop Chromium. The Android harness is opt-in because it requires a provisioned
emulator. Unit tests cover authentication rejection, interrupted transfers, and
concurrent local writes. Natural scheduling is intentionally not a timed CI assertion.
