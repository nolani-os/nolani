# ClaraOS Companion (Android)

Native Android app for a ClaraOS / Nolani server. It is a thin shell (WebView) around the
server's web desktop and adds what a browser tab cannot do: an optional built-in tunnel to a
private network, push notifications, photo and document uploads, a document scanner, access to
device settings and self-update. Install one APK, pair once, done.

Package IDs: `de.nolanios.companion` (generic build), set per variant otherwise. Distribution is
download-only (no app store), so the app updates itself.

## Architecture

```
ShellActivity (WebView) ──proxy override──► local HTTP proxy (127.0.0.1:<port>)
        │                                         │
        │ JS bridges                              ▼
        ├─ ClaraOSNative (scan, device control)   embedded tsnet (userspace Tailscale)
        └─ (shell origin only, message port)       └─► tailnet ─► shell, ntfy, Immich, Paperless
NtfyPushService, ImmichUploadWorker, PaperlessShareActivity ──OkHttp via the same proxy──┘
```

- **WebView shell.** `ShellActivity` loads the shell URL received during pairing (never
  hard-coded) and keeps login, cookies, microphone/camera (trusted hosts only), downloads and
  file/camera pickers working.
- **Optional embedded tunnel.** `tsnet/claratsnet.go` embeds tsnet (Tailscale in userspace) and
  exposes a local HTTP proxy (CONNECT). Every app on the device can reach 127.0.0.1, so the
  proxy requires a random password generated per run and kept only in memory; the WebView
  (routed through it with the `androidx.webkit` `ProxyController`) answers the proxy's 407
  challenge, native clients (push, uploads) use OkHttp with the same proxy and credentials. There is
  **no system `VpnService`**: no VPN consent dialog, no conflict with another VPN on the device,
  and only this app's traffic enters the tailnet. The coordination server (e.g. Headscale)
  and a short-lived pre-auth key come from pairing.
- **Why a tunnel at all.** With an always-on VPN in lockdown mode, an app without its own tunnel
  gets no network. Also, the Chromium WebView uses a different DNS path than the system
  resolver, so internal MagicDNS names may not resolve in a plain WebView even when the
  browser resolves them. Host names are therefore resolved explicitly through the tunnel
  (MagicDNS `100.100.100.100` by default, or the variant's `TAILNET_RESOLVER`).
- **Direct mode.** For publicly reachable instances (e.g. `demo.claraos.de`) the app loads the
  shell directly, without a tunnel (`claraos://connect?server=…`). Only servers under the
  variant's `DIRECT_DOMAIN` are accepted. Push and uploads are not available there.
- **Pairing.** Invite code or `claraos://provision?token=…` → `POST
  {backend}/api/claraos/onboarding/app-provision` → shell URL, control URL, pre-auth key and
  optional ntfy/Immich/Paperless credentials. Re-pairing an already paired device keeps the
  tailnet node and only renews credentials.

### Components

| Path (under `app/src/main/java/de/claraos/companion/`) | Purpose |
|---|---|
| `ShellActivity.java` | WebView shell, onboarding, JS bridges, renderer-crash recovery |
| `ProvisioningClient.java` | Pairing and direct mode; stores the provisioned configuration |
| `vpn/CompanionTunnel.java`, `vpn/AndroidInterfaceProvider.java` (+ `tsnet/claratsnet.go` at the package root) | Embedded tsnet + authenticated HTTP proxy (`tsnet/authproxy.go`) |
| `push/NtfyPushService.java`, `push/PushCredentialRefresher.java` | ntfy WebSocket foreground service; renews an expired ntfy credential using the shell session |
| `boot/BootReceiver.java` | Starts push after reboot and after self-update |
| `upload/` | Photo sync to Immich (WorkManager), share target and document scanner to Paperless |
| `device/DeviceControlBridge.java` | Device settings for the shell (volume, brightness, battery, storage, Wi-Fi, Bluetooth, mic) — contract in `protocol/control-api.md` |
| `update/` | Self-update: daily background check + check after the shell loads |
| `kamera/` | Experimental measurement screens (camera characteristics, acoustic distance) |

## Build variants

Gradle flavor dimension `variant`:

| Flavor | Application ID | Server |
|---|---|---|
| `generic` | `de.nolanios.companion` | none built in — the user enters an invite or a direct-mode server |
| `heim` | from the value file | values from `app/variant.heim.properties` |

The `heim` flavor only exists while `app/variant.heim.properties` exists. That file (like all
`*.heim.*` files) belongs to one installation and is not part of the open-source export.
Keys it provides: `applicationId`, `brand`, `shareLabel`, `defaultBackend`, `directDomain`,
`trustedHostSuffixes` (comma-separated), `tailnetResolver`. They end up as `BuildConfig`
fields (`BRAND`, `DEFAULT_BACKEND`, `DIRECT_DOMAIN`, `TRUSTED_HOST_SUFFIXES`,
`TAILNET_RESOLVER`). To build your own variant, create such a file with your values.

## Building

Requirements: a checkout of [tailscale-android](https://github.com/tailscale/tailscale-android)
and its Docker build image (`make docker-tailscale-debug`), which contains Go, gomobile and the
Android SDK/NDK.

```
./build.sh /path/to/tailscale-android              # Heim if its value file exists, else Generic
FLAVOR=Generic ./build.sh /path/to/tailscale-android
COMPANION_BUILD_IMAGE=<image> ./build.sh /path/to/tailscale-android
```

1. `gomobile bind` of `tsnet/claratsnet.go` inside the build image → `app/libs/claratsnet.aar`
   (≈14 MB, a build artifact, not committed).
2. `./gradlew :app:assemble<FLAVOR>Debug` → `app/build/outputs/apk/<flavor>/debug/`.

Release builds are signed with a fixed keystore from `signing/keystore.properties` (not in
git). Without it `assembleRelease` fails on purpose. Keep the key: Android only installs an
update signed with the same key.

### Self-update

The app fetches `{DEFAULT_BACKEND}/downloads/companion-version.json`
(`{"versionCode": N, "versionName": "x.y.z", "url": "…"}`, `url` optional) and
`/downloads/claraos-companion.apk` without login and without the tunnel, so updates still work
when pairing is broken. Bump `versionCode` for every release — the check compares it.
Nothing is installed silently; the user confirms in the system installer.

## Platform notes

- **tsnet on Android** needs three workarounds (all in the code): interface enumeration via Java
  `NetworkInterface` (Android sandboxes netlink → `netlinkrib: permission denied`),
  `TS_LOGS_DIR` pointing at app-private storage ("no safe place found to store log state"),
  and the version ldflags from tailscale-android in `gomobile bind` (otherwise a version panic).
- **Lockdown VPNs block the tunnel.** The app does not replace another VPN, but an always-on
  VPN in lockdown mode blocks the WireGuard traffic of the embedded tsnet. Test on a device or
  emulator without lockdown, or use direct mode.
- **`POST_NOTIFICATIONS` must be requested at runtime** (Android 13+). Without it the service
  runs and the WebSocket is connected, but every notification is silently dropped while the
  server reports success. Check with
  `adb shell dumpsys package <applicationId> | grep POST_NOTIFICATIONS`.
- **Shared rate limits.** If several devices reach ntfy through the same NAT address, ntfy
  counts them as one visitor; one device hammering with a dead token can lock out all of
  them (`limit reached: too many auth failures`). Hence the exponential reconnect backoff
  and the credential refresh on HTTP 401.
- **After a reboot**, `BOOT_COMPLETED` (and adb access) only arrive after the device has been
  unlocked once — the app is not direct-boot aware.
- **targetSdk 35** forbids starting `dataSync` foreground services from `BOOT_COMPLETED`;
  the service type must change when raising `targetSdk`.
- **Downgrades are impossible in place.** Android refuses a lower `versionCode` with the same
  signature; uninstalling also deletes the tailnet key and the pairing. Rolling back the
  update manifest only protects devices that have not updated yet — test before publishing.
- **Catch-all routes** on the server can answer missing files with the SPA's HTML and
  HTTP 200. The update check verifies Content-Type and content and does not follow redirects.
- **Bluetooth** state is read from `Settings.Global.bluetooth_on`; from API 31 the adapter
  needs `BLUETOOTH_CONNECT`, which the app deliberately does not request.
- **Android WebView has no PDF viewer.** A renderer crash is caught (`onRenderProcessGone`)
  and the shell is reloaded in safe start, so a crashing page cannot cause a crash loop.

App icon: `res/mipmap-*/ic_launcher_foreground.png` is generated from
`packages/shell/public/icon-512-maskable.png` (full bleed, adaptive icon in
`mipmap-anydpi-v26/ic_launcher.xml`, background `#141F39` = logo edge color).
