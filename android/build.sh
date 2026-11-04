#!/bin/sh
# Source-only checkout; Gradle, SDK caches, signing for debug, and outputs in build/.
set -eu
source_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
build_dir=$(CDPATH= cd -- "$source_dir/../build" && pwd)/android-shell
export GRADLE_USER_HOME="$build_dir/gradle-home"
mkdir -p "$build_dir/tools"
if [ ! -x "$build_dir/tools/gradle-8.11.1/bin/gradle" ]; then
    curl --fail --location --retry 3 https://services.gradle.org/distributions/gradle-8.11.1-bin.zip -o "$build_dir/tools/gradle.zip"
    printf '%s  %s\n' f397b287023acdba1e9f6fc5ea72d22dd63669d59ed4a289a29b1a76eee151c6 "$build_dir/tools/gradle.zip" | sha256sum --check
    unzip -q "$build_dir/tools/gradle.zip" -d "$build_dir/tools"
    rm "$build_dir/tools/gradle.zip"
fi
if [ ! -f "$build_dir/debug.keystore" ]; then
    keytool -genkeypair -keystore "$build_dir/debug.keystore" -storepass android -alias androiddebugkey -keypass android -dname 'CN=Stow Debug' -keyalg RSA -keysize 2048 -validity 10000 >/dev/null
fi
if [ "$#" -eq 0 ]; then set -- testDebugUnitTest assembleDebug; fi
exec "$build_dir/tools/gradle-8.11.1/bin/gradle" -p "$source_dir/android" --project-cache-dir "$build_dir/project-cache" "$@"
