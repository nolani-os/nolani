#!/usr/bin/env bash
# ClaraOS Companion Desktop — build (Docker on the build host; same pattern as android/build.sh).
# Stage 1: clarad (Go) for linux+windows · Stage 2: Tauri bundles.
set -euo pipefail
cd "$(dirname "$0")"

GO_IMAGE="${GO_IMAGE:-golang:1.26}"
VERSION="${VERSION:-dev}"

# Variant: "heim" = this household's ClaraOS (values from variant.heim.sh, Tauri
# overlay tauri.heim.conf.json); "generic" = the open-source build without any
# built-in server. Default: heim if its value file is present, else generic.
if [ -z "${VARIANT:-}" ]; then
  if [ -f variant.heim.sh ]; then VARIANT=heim; else VARIANT=generic; fi
fi
LDFLAGS="-X main.version=${VERSION}"
TAURI_CONFIG=""
DEVICE_CONTROL=off
case "$VARIANT" in
  heim)
    # shellcheck source=/dev/null
    . ./variant.heim.sh
    M=claraos.de/companion/clarad/internal
    LDFLAGS="$LDFLAGS -X $M/provision.DefaultBackend=${COMPANION_DEFAULT_BACKEND}"
    LDFLAGS="$LDFLAGS -X $M/tsnode.FallbackResolverAddr=${COMPANION_FALLBACK_RESOLVER}"
    LDFLAGS="$LDFLAGS -X $M/provision.DirectDomain=${COMPANION_DIRECT_DOMAIN}"
    LDFLAGS="$LDFLAGS -X $M/state.AppDirName=${COMPANION_APP_DIR}"
    TAURI_CONFIG="--config tauri.heim.conf.json"
    DEVICE_CONTROL=on   # home: device control on by default, as before
    ;;
  generic) ;;
  *) echo "unknown VARIANT=$VARIANT (heim|generic)"; exit 1 ;;
esac
echo "== Variante: $VARIANT =="

echo "== Stufe 1: clarad (${VERSION}) =="
docker run --rm -v "$PWD/daemon:/src" -w /src "$GO_IMAGE" sh -c "
  go mod tidy &&
  CGO_ENABLED=0 go build -ldflags '${LDFLAGS}' -o clarad-linux ./cmd/clarad &&
  CGO_ENABLED=0 GOOS=windows go build -ldflags '${LDFLAGS}' -o clarad-windows.exe ./cmd/clarad &&
  go vet ./...
"
mkdir -p app/src-tauri/binaries
# Tauri externalBin naming convention: <name>-<rust-target-triple>
cp daemon/clarad-linux app/src-tauri/binaries/clarad-x86_64-unknown-linux-gnu
cp daemon/clarad-windows.exe app/src-tauri/binaries/clarad-x86_64-pc-windows-msvc.exe
echo "== clarad ok =="

if [ "${SKIP_TAURI:-0}" = "1" ]; then
  echo "== Stufe 2 (Tauri) übersprungen (SKIP_TAURI=1) =="
  exit 0
fi

# IMPORTANT: tag :2604 = Ubuntu 26.04 + WebRTC/codec packages (269 GStreamer elements).
# :latest is the OLD 22.04 image — AppImages built with it mix WebKitGTK 2.50
# with the host's HarfBuzz from 26.04 (a known crash cause, see Dockerfile.linux)
# and lack the WebRTC elements. 0.4.10 fell into exactly this trap because the
# right image was only passed via env and the default was never updated.
TAURI_IMAGE="${TAURI_IMAGE:-claraos-desktop-build:2604}"   # Linux/AppImage (Ubuntu 26.04)
WIN_IMAGE="${WIN_IMAGE:-claraos-desktop-win}"        # Windows/NSIS 3.11 (Debian trixie)
APP_DIR="${APP_DIR:-$PWD/app}"   # the app next to this script (build.sh cd-s here)
CARGO_CACHE="${CARGO_CACHE:-clarad-cargo-cache}"
# IMPORTANT: persistent tool cache (~/.cache/tauri): otherwise the tauri CLI
# re-downloads AppRun/linuxdeploy/NSIS utils from GitHub on EVERY build — its
# rustls downloader repeatedly failed on transient TLS errors
# ("received fatal alert: InternalError") that curl never saw.
# Once filled, the build no longer needs the network.
TOOL_CACHE="${TOOL_CACHE:-clarad-tool-cache}"
# Pass signing keys through only if set (the release script sets them).
SIGN_ENV=()
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] && SIGN_ENV+=(-e TAURI_SIGNING_PRIVATE_KEY)
[ -n "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ] && SIGN_ENV+=(-e TAURI_SIGNING_PRIVATE_KEY_PASSWORD)

echo "== Stufe 2a: AppImage (Linux) =="
# IMPORTANT: PATH must contain the tool cache: linuxdeploy looks for its
# plugin scripts (`linuxdeploy-plugin-gstreamer.sh` etc.) only in PATH. If they
# sit only in ~/.cache/tauri, the step is **silently skipped** — the AppImage
# shipped without GStreamer elements and Selkies hung at "Waiting for stream"
# ("autoaudiosink not found"). No error in the log.
docker run --rm -v "$APP_DIR:/src" -w /src/src-tauri \
  -v "$CARGO_CACHE:/root/.cargo/registry" -v "$TOOL_CACHE:/root/.cache" \
  -e PATH="/root/.cache/tauri:/root/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" \
  -e COMPANION_DEVICE_CONTROL="$DEVICE_CONTROL" "${SIGN_ENV[@]}" "$TAURI_IMAGE" \
  bash -lc "cargo tauri build ${TAURI_CONFIG} --bundles appimage"

if [ "${SKIP_WINDOWS:-0}" = "1" ]; then
  echo "== Stufe 2b (Windows) übersprungen (SKIP_WINDOWS=1) =="
  exit 0
fi
echo "== Stufe 2b: NSIS (Windows, cross via cargo-xwin) =="
# IMPORTANT: SEPARATE image (Debian trixie, NSIS 3.11) — NOT the Ubuntu 22.04 one!
# Its NSIS 3.08 produces an installer that fails its own checksum: Windows
# reports "Installer integrity check has failed", the silent run ends with
# exit code 2. The package looks perfectly healthy (7-Zip tests it without
# errors, hashes match) — only NSIS itself refuses to start. This was noticed
# only after shipping.
# IMPORTANT: failure is FATAL: an earlier `|| echo` silently swallowed a
# cross build that had been broken for weeks (Cargo.toml crates in the
# linux-only block) — releases went out without a Windows artifact and nobody
# noticed. For deliberate Linux-only runs: SKIP_WINDOWS=1 (above) or
# ALLOW_WIN_FAIL=1 (build continues, the warning stays visible).
if ! docker run --rm -v "$APP_DIR:/src" -w /src/src-tauri \
  -v "$CARGO_CACHE:/root/.cargo/registry" -v "$TOOL_CACHE:/root/.cache" \
  -e COMPANION_DEVICE_CONTROL="$DEVICE_CONTROL" "${SIGN_ENV[@]}" "$WIN_IMAGE" \
  bash -lc "cargo tauri build ${TAURI_CONFIG} --runner cargo-xwin --target x86_64-pc-windows-msvc --bundles nsis"; then
  if [ "${ALLOW_WIN_FAIL:-0}" = "1" ]; then
    echo "   ⚠ Windows-Cross-Build fehlgeschlagen (toleriert wegen ALLOW_WIN_FAIL=1)"
  else
    echo "   ✖ Windows-Cross-Build fehlgeschlagen — Abbruch (ALLOW_WIN_FAIL=1 zum Tolerieren)"
    exit 1
  fi
fi
