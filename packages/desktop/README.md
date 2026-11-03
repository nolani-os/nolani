# ClaraOS Companion Desktop (Windows + Linux)

A small desktop app that opens your ClaraOS shell in a native window — on
Windows and Linux, without admin rights. Same principle as the Android
companion (`packages/android/`): an **embedded tsnet node (userspace Tailscale,
NOT a system VPN) + a local SOCKS5 proxy**, and the WebView loads the shell
through the app's own tunnel. No VPN-slot conflict (it coexists with commercial
VPN clients), and one invitation code is enough to set a device up.

The tunnel is optional: a server that is reachable directly needs no tailnet.
The SOCKS proxy listens on 127.0.0.1 and only accepts connections from processes of
the user the app runs as (Linux: owner of the client socket in `/proc/net/tcp`;
Windows: owner of the connecting process), so other accounts on a shared machine
cannot use the device's tailnet identity.

## Architecture

```
┌─ Tauri 2 (Rust, deliberately thin) ─────────────────────────┐
│ Onboarding/status window (local, no proxy)                  │
│ Shell window: proxy_url = socks5://127.0.0.1:<port>         │
│ Tray · autostart · deep link claraos:// · updater · hotkey  │
└──────────────┬──────────────────────────────────────────────┘
               │ sidecar (stdin pipe = liveness signal)
               │ control API: handshake file → 127.0.0.1:<port> + bearer
┌──────────────┴─ clarad (Go, ONE binary) ────────────────────┐
│ tsnode: tsnet + SOCKS5 (optional tunnel)                    │
│ provision: app-provision against the ClaraOS server         │
│ modules: ntfy push · Immich/Paperless folder sync ·         │
│          device control · registry + consent                │
└─────────────────────────────────────────────────────────────┘
```

- **Tauri app** (`app/`): onboarding window, the shell window, tray menu,
  autostart, `claraos://provision?token=…` deep link, self-update, global
  hotkey. It also injects `window.ClaraOSNative` into the shell (bridge to the
  device-control module).
- **clarad** (`daemon/`): everything long-running lives here, not in the GUI —
  a future remote-control module must not have its control channel inside the
  session it controls.
- **Contract** daemon ↔ UI and shell ↔ companion bridge:
  [`protocol/control-api.md`](protocol/control-api.md) (source of truth).

### Modules

- **ntfy push**: follows ntfy's JSON stream (`GET /{topic}/json`) through the
  tunnel, with a `since` cursor and reconnect backoff; delivered as native
  notifications.
- **Folder sync** (`daemon/internal/modules/foldersync`): uploads user-selected
  folders to **Immich** (photos) and **Paperless** (documents). Empty folder
  list = no sync (default — nothing is uploaded without being asked).
- **Device control**: volume, microphone, brightness, Wi-Fi, Bluetooth,
  battery, storage, displays and a camera/microphone privacy indicator for the
  local machine. Capabilities are probed at runtime; see the platform matrix
  in the contract.
- **Consent RPC**: blocks until answer or timeout, default is NO, a grant
  covers exactly one connection and is never stored. The dialog is always
  rendered by the Tauri app, never by the shell WebView.

## Build variants

| Variant | What it is |
|---|---|
| `generic` | "Nolani Companion" — the open-source build. No built-in server; the user enters their own. |
| `heim` | A build preconfigured for one specific installation. |

`build.sh` picks the variant via `VARIANT=generic|heim` (default: `heim` if
`variant.heim.sh` exists, otherwise `generic`). The `heim` variant takes its
values from home-only files that are not part of the published source:

- `variant.heim.sh` — default backend and fallback resolver, injected into
  clarad via `-ldflags -X`,
- `app/src-tauri/tauri.heim.conf.json` — Tauri config overlay (`--config`),
- `app/src-tauri/capabilities/shell-remote.heim.json` — the capability that
  lets the remote shell origin call the app's commands.

## Building

Everything builds in Docker; no Windows machine is needed.

| Image | Base | Used for |
|---|---|---|
| `claraos-desktop-build:2604` | Ubuntu 26.04 | AppImage, headless GUI tests via Xvfb |
| `claraos-desktop-win` | Debian trixie | NSIS 3.11 → Windows installer (cross build via cargo-xwin) |

```sh
docker build -t claraos-desktop-build:2604 -f docker/Dockerfile.linux docker/
docker build -t claraos-desktop-win -f docker/Dockerfile.windows docker/

./build.sh                                  # stage 1 + 2, variant auto-detected
VARIANT=generic VERSION=0.5.15 ./build.sh   # explicit variant/version
SKIP_TAURI=1 ./build.sh                     # daemon only
SKIP_WINDOWS=1 ./build.sh                   # no Windows installer
```

- **Stage 1** builds `clarad` for linux and windows in a `golang` container and
  copies it to `app/src-tauri/binaries/clarad-<rust-target-triple>` (Tauri's
  `externalBin` naming convention).
- **Stage 2** builds the AppImage and the NSIS installer from `APP_DIR`
  (default `~/clarad-build/app`). A Windows build failure is fatal unless
  `ALLOW_WIN_FAIL=1`.
- Updater signing keys are passed through only when
  `TAURI_SIGNING_PRIVATE_KEY(_PASSWORD)` are set. Note: without
  `bundle.createUpdaterArtifacts: true`, Tauri 2 produces no `.sig` files.

Standalone daemon test: `./clarad-linux --state-dir /tmp/clarad-test`, then read
the handshake file and
`curl -H "Authorization: Bearer <token>" http://127.0.0.1:<port>/v1/status`.

## State paths

| | Linux | Windows |
|---|---|---|
| Config (+ secrets) | `~/.config/claraos-companion/` | `%APPDATA%\ClaraOS Companion\` |
| tsnet state, handshake | `~/.local/share/claraos-companion/` | `%LOCALAPPDATA%\ClaraOS Companion\` |
| Logs (rotating 3×5 MB) | `~/.local/state/claraos-companion/logs/` | `%LOCALAPPDATA%\ClaraOS Companion\logs\` |

Secrets: on Linux a 0600 file (the tsnet node key is a file anyway — a keyring
would be theatre plus KWallet pop-ups); on Windows the whole config.json is
encrypted with **DPAPI** (user scope). The `auth_key` (short-lived pre-auth
key) is NEVER persisted.

## tailscale.com version pin

`daemon/go.mod` pins **exactly the same tailscale.com version as the Android
companion**, so both apps show the same control-plane behaviour against the
coordination server (e.g. Headscale). Bump it only deliberately and for both
companions together, then test against the coordination server.

## Platform notes and gotchas

- **DNS through the tunnel must use TCP.** WebKitGTK/curl correctly hand the
  hostname to the SOCKS proxy (remote DNS), but DNS over UDP through the
  userspace netstack times out while TCP to the tailnet resolver works.
  `lookupHostTCP()` does DNS over TCP itself (RFC 1035 §4.2.2), UDP is only a
  fallback.
- **The Linux build image must match the target system.** An AppImage built on
  an older base bundles WebKitGTK/GTK/Pango but takes HarfBuzz from the host;
  the ABI mix crashes on new text layouts (see `docker/Dockerfile.linux`).
  Price: the AppImage needs a recent distribution.
- **GStreamer/WebRTC elements** must be installed in the build image and
  linuxdeploy's plugin scripts must be on `PATH` — otherwise the step is
  silently skipped and Selkies remote desktops hang at "Waiting for stream".
- **NSIS version matters.** NSIS 3.08 produces installers that fail their own
  integrity check on Windows ("Installer integrity check has failed", silent
  install exits with code 2) while 7-Zip and hashes look fine. Use NSIS ≥ 3.11.
  The Windows image also needs `libayatana-appindicator3-dev`, because the
  Tauri CLI checks this host library for the tray icon even when cross-building.
  Always run the installer on a real Windows machine (`/S`, exit code must be 0)
  before publishing.
- **AppImage self-update** swaps the file via rename; `/tmp` is usually a tmpfs
  on another mount point, which fails ("temp directory is not on the same mount
  point as the AppImage"). `align_tmpdir_with_appimage()` puts TMPDIR next to
  the AppImage.
- **Tracking prevention in WebKitGTK** blocks the SSO session of embedded apps;
  the app switches it off for the shell window (Linux only).
- **Wayland global hotkeys**: the compositor owns hotkeys, so
  `tauri-plugin-global-shortcut` registers nothing there. Bind a desktop
  shortcut to `ClaraOS-Companion --show-clara` instead; the running instance
  receives the flag via single-instance and opens Clara. On other platforms
  the default is `Ctrl+Alt+Space`.
- **Paperless needs `Content-Length`**: a streamed (chunked) multipart body
  arrives as an empty file in Django (`400 "No file was submitted."`). The
  Paperless uploader therefore buffers to a temporary file; Immich stays
  streamed. Unit tests with Go's `httptest` cannot show this — test each target
  service with at least one real call.
- **Folder sync polls** (every 5 min) instead of using file events: fsnotify
  behaves differently across Windows, Linux and network drives and loses events
  on bulk copies. Identity = `sha1(relpath|mtime|size)` (no content hash);
  files younger than 30 s wait for the next run.
- Frontend assets are **embedded at compile time** — an HTML change needs a
  rebuild. `externalBin` requires `binaries/clarad-<triple>` already at compile
  time, `generate_context!` needs an RGBA icon, and Windows builds require
  `icons/icon.ico`.
- No Windows code signing: users confirm SmartScreen once on first install.
  Self-updates are verified with the updater's minisign key; if that key is
  lost, installed apps can no longer update themselves.
