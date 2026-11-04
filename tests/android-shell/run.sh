#!/bin/sh
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$source_dir"
serial=${1:?Supply an isolated emulator serial}
case "$serial" in emulator-[0-9]*) ;; *) printf '%s\n' 'Refusing to clear a physical device.' >&2; exit 1 ;; esac
build_dir="$source_dir/../build/android-shell"
mkdir -p "$build_dir/logs"
./android/build.sh stageStowDebug -PstowVersionCode=2
mkdir -p "$build_dir/updates"
cp "$build_dir/publish/debug/"* "$build_dir/updates/"
./android/build.sh testDebugUnitTest assembleDebug assembleRelease assembleDebugAndroidTest lintDebug
adb -s "$serial" install -r -d "$build_dir/gradle/app/outputs/apk/debug/app-debug.apk"
adb -s "$serial" install -r -d "$build_dir/gradle/app/outputs/apk/androidTest/debug/app-debug-androidTest.apk"
adb -s "$serial" shell pm clear net.stowapp.android
# Replacement broadcasts from an earlier installed test APK must finish before
# instrumentation starts its application process. Force-stop cancels those wakes.
adb -s "$serial" shell am force-stop net.stowapp.android
adb -s "$serial" shell am instrument -w net.stowapp.android.test/androidx.test.runner.AndroidJUnitRunner > "$build_dir/logs/instrumentation.log"
cat "$build_dir/logs/instrumentation.log"
# Android's shell exits zero even when instrumentation tests fail.
rg -q 'OK \([0-9]+ tests\)' "$build_dir/logs/instrumentation.log"
node tests/android-shell/emulator.mjs --serial "$serial"
