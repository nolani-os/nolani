#!/usr/bin/env bash
# Builds the ClaraOS companion app in two steps:
#   1) claratsnet.aar (gomobile bind of our tsnet wrapper) in the tailscale-android build image
#   2) the app against that .aar
#
# Requirements: a tailscale-android checkout + the Docker build image
# `tailscale-android-build-amd64-*` (created once via `make docker-tailscale-debug`),
# which contains the Go toolchain + gomobile + Android SDK/NDK.
#
# Usage:  ./build.sh /path/to/tailscale-android
# Environment:
#   FLAVOR=Heim|Generic      default Heim while app/variant.heim.properties exists
#   BUILD_TYPE=Debug|Release default Debug; Release signs with signing/keystore.properties
#                            if present (storeFile, storePassword, storeAlias, keyPassword),
#                            otherwise the APK stays unsigned
#   VERSION_NAME, VERSION_CODE  override the version in app/build.gradle (CI releases)
set -euo pipefail

TS_ANDROID="${1:?Pfad zum tailscale-android-Checkout angeben}"
IMG="${COMPANION_BUILD_IMAGE:-tailscale-android-build-amd64-070325-1}"
HERE="$(cd "$(dirname "$0")" && pwd)"
# Flavor: Heim (this household's ClaraOS, needs app/variant.heim.properties) or
# Generic (open-source build). Default: Heim if its value file exists.
if [ -z "${FLAVOR:-}" ]; then
  if [ -f "$HERE/app/variant.heim.properties" ]; then FLAVOR=Heim; else FLAVOR=Generic; fi
fi
BUILD_TYPE="${BUILD_TYPE:-Debug}"
case "$BUILD_TYPE" in Debug|Release) ;; *) echo "BUILD_TYPE must be Debug or Release"; exit 1 ;; esac
GRADLE_PROPS=""
[ -n "${VERSION_NAME:-}" ] && GRADLE_PROPS="$GRADLE_PROPS -PcompanionVersionName=$VERSION_NAME"
[ -n "${VERSION_CODE:-}" ] && GRADLE_PROPS="$GRADLE_PROPS -PcompanionVersionCode=$VERSION_CODE"

echo "== 1/2: claratsnet.aar (gomobile bind) =="
mkdir -p "$TS_ANDROID/claratsnet"
rm -f "$TS_ANDROID"/claratsnet/*.go
cp "$HERE"/tsnet/*.go "$TS_ANDROID/claratsnet/"
cd "$TS_ANDROID"
VOLS="-v $(pwd):/build/tailscale-android -v $(pwd)/.android-docker:/root/.android -v $(pwd)/.gradle-docker:/build/.gradle -v $(pwd)/.cache-docker:/build/.cache --env GOPATH=/build/.cache/go --env GOMODCACHE=/build/.cache/go/pkg/mod"
docker run --rm $VOLS "$IMG" bash -lc '
  set -e; cd /build/tailscale-android
  ./tool/go install golang.org/x/mobile/cmd/gomobile golang.org/x/mobile/cmd/gobind
  export GOROOT=$(./tool/go env GOROOT)
  export PATH=$GOROOT/bin:/build/.cache/go/bin:$PATH
  export ANDROID_NDK_HOME=$ANDROID_HOME/ndk/23.1.7779620
  gomobile bind -target android/arm64,android/amd64 -androidapi 26 \
    -tags "$(./build-tags.sh) ts_omit_cachenetmap" \
    -ldflags "$(./version-ldflags.sh)" \
    -o /build/tailscale-android/claratsnet.aar ./claratsnet
'
mkdir -p "$HERE/app/libs"
cp "$TS_ANDROID/claratsnet.aar" "$HERE/app/libs/claratsnet.aar"
echo "   -> app/libs/claratsnet.aar"

echo "== 2/2: App (assemble${FLAVOR}${BUILD_TYPE}) =="
cp "$TS_ANDROID/android/gradlew" "$HERE/" 2>/dev/null || true
cp -r "$TS_ANDROID/android/gradle" "$HERE/" 2>/dev/null || true
cd "$HERE"
docker run --rm -v "$HERE":/proj -v "$TS_ANDROID/.gradle-docker":/root/.gradle -w /proj \
  -e ANDROID_HOME=/build/android-sdk -e ANDROID_SDK_ROOT=/build/android-sdk \
  "$IMG" bash -lc "./gradlew :app:assemble${FLAVOR}${BUILD_TYPE} $GRADLE_PROPS --no-daemon"
echo "   -> app/build/outputs/apk/${FLAVOR,,}/${BUILD_TYPE,,}/"
