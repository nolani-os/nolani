# clarad control API — contract daemon ↔ UI

**Source of truth** for the local interface between the Go daemon `clarad` and
the Tauri app. Go structs (`daemon/internal/core`, `…/control`) and TS types
(`app/src/api.ts`) follow this document.

## Handshake

clarad binds the API to `127.0.0.1:0` and atomically writes (0600):

```json
{ "port": 46637, "token": "<64 hex>", "pid": 12345 }
```

to `--handshake-file` (default `<data-dir>/handshake.json`). The UI polls the
file (≤10 s) and authenticates every request with `Authorization: Bearer <token>`.
On a clean exit clarad deletes the file. Sidecar mode: `--watch-stdin` makes
clarad exit cleanly on stdin EOF (parent process gone).

## States

`unprovisioned` → (provision) → `connecting` → `up` | `error`
`starting` = provisioned, tunnel not started yet · `down` = stopped manually.

## Endpoints (v1)

| Method/path | Body | Response | Notes |
|---|---|---|---|
| `GET /v1/status` | — | `Status` | any time |
| `POST /v1/provision` | `{"token":"<invite>","backend":"https://example.org"?}` | `Status` | calls app-provision; 404 = invite invalid/expired, 410 = claim limit (the server's status codes are passed through); tunnel setup afterwards is asynchronous |
| `POST /v1/connect` | `{"server":"example.org","control_url":"…"?,"auth_key":"…"?}` | `Status` | pair without an invite: `server` becomes `https://home.<domain>/` (https and a host name only). Without `control_url`/`auth_key` ⇒ **direct mode** (no tunnel, `socks_port` 0); a tunnel needs an auth key (`control_url` empty ⇒ Tailscale's default) |
| `POST /v1/push/refresh` | `{"cookies":"<shell session cookies>"}` | `{"ok":true}` | the app passes the signed-in shell session once; the daemon fetches its own push credential from the server (`/api/claraos/ntfy/device-token`) and stores only that, never the cookies. 502 if the server refuses |
| `POST /v1/up` | — | `Status` | tunnel from persisted state; 409 if unprovisioned |
| `POST /v1/down` | — | `Status` | stop the tunnel |
| `GET /v1/events` | — | SSE | see Events; initially sends one `state.changed` |
| `POST /v1/shutdown` | — | `{"ok":true}` | daemon exits |

| `GET /v1/modules` | — | `Info[]` | state of all modules |
| `POST /v1/modules/{id}/start\|stop` | — | `Info[]` | control a module; 404 if unknown/unavailable |

| `GET\|PUT /v1/sync/config` | `SyncConfig` | `SyncConfig` | folder sync; PUT checks that every path is a folder and restarts the modules |
| `POST /v1/modules/{id}/consent` | `{nonce, granted}` | `{ok}` | 409 if the nonce is unknown/expired — the UI must never wrongly report "granted" |

### SyncConfig

```json
{ "immich":    { "enabled": true, "folders": ["C:\\Users\\x\\Bilder"] },
  "paperless": { "enabled": true, "folders": ["C:\\Users\\x\\Scans"] } }
```

Empty folder list = no sync. This is the default: nothing is uploaded before
the user has picked a folder.

### Module info

```json
{ "id": "ntfy-push", "state": "running", "error": "", "allowed_peers": [] }
```

`state`: `stopped | running | error | unavailable`. `unavailable` = the module is
part of the contract but not built (yet) — currently `remote-desktop`.
`allowed_peers` is reserved for future remote-control modules (gate 3 of the
three-gate model): which tailnet peers may address it at all.

### Status

```json
{ "state": "up", "socks_port": 39281, "hostname": "nolani-office-pc",
  "shell_url": "https://home.example.org/", "version": "0.1.0", "error": "",
  "direct": false, "can_invite": false, "push": true }
```

`direct`: connected without a tunnel (no proxy for the shell) · `can_invite`:
this build has a pairing server, so invitation codes work · `push`: push
credentials are configured.

## Device control (v0.5)

Control of the LOCAL device (volume, brightness, Wi-Fi, Bluetooth, battery,
storage, displays). Lives as the module `device-control` in the daemon (control
channel outside the controlled session), reachable ONLY via the local control
API — i.e. only by the Tauri process. No consent gate: the caller is the local
user's own session. Remote access (later) goes through the three-gate model.

### Capabilities

At startup the module probes every capability (`exec.LookPath`, D-Bus ping,
COM instantiation). Failed probe ⇒ the cap is missing from `caps` and the
matching section is missing from the state. Read and write are separate caps
(`"audio"` = status readable, `"audio.set"` = controllable) — this also applies
to device selection: `"audio.devices"` (list) and `"audio.devices.set"`
(switch) are granted **separately**, because Windows only allows switching
through an undocumented interface:

`audio, audio.set, audio.devices, audio.devices.set, brightness,
brightness.set, wifi, wifi.set, wifi.connect, bluetooth, bluetooth.set,
bluetooth.connect, mic, mic.set, battery, storage, displays, privacy`

Note: `…set` and `…connect` are separate too: on Windows the companion can
switch the **radio** (WinRT radios) but can connect neither to a Wi-Fi network
nor to a Bluetooth device — there `wifi.connect`/`bluetooth.connect` are
missing while `wifi.set`/`bluetooth.set` are present.

### Endpoints

| Method/path | Body | Response | Notes |
|---|---|---|---|
| `GET /v1/device/state` | — | `DeviceState` | full snapshot incl. `caps` |
| `POST /v1/device/audio` | `{"volume":0..100?,"muted":bool?}` | section `audio` | |
| `POST /v1/device/brightness` | `{"level":0..100}` | section `brightness` | |
| `POST /v1/device/wifi` | `{"enabled":bool}` | section `wifi` | radio on/off |
| `GET /v1/device/wifi/networks` | — | `[{ssid,signal,secured,known}]` | triggers a scan (may take ~2 s) |
| `POST /v1/device/wifi/connect` | `{"ssid":"…","psk":"…"?}` | `{"ok":true}` | PSK only for unknown networks; NM/the OS stores it, clarad never does |
| `POST /v1/device/bluetooth` | `{"enabled":bool}` | section `bluetooth` | |
| `GET /v1/device/bluetooth/devices` | — | `[{address,name,connected,paired}]` | |
| `POST /v1/device/bluetooth/connect` | `{"address":"…","disconnect":bool?}` | `{"ok":true}` | paired devices only; pairing stays with the OS |
| `POST /v1/device/mic` | `{"muted":bool?,"volume":0..100?}` | section `mic` | device-wide microphone mute/level (Android: `muted` only) |
| `GET /v1/device/audio/devices` | — | `[{id,name,kind,default}]` | `kind` = `sink` (output) or `source` (input); monitor sources are filtered out |
| `POST /v1/device/audio/default` | `{"sink":"…"}` or `{"source":"…"}` | section `audio` | switches output or input |

#### Section `privacy` (cap `privacy`, read-only)

"Who is using the camera and microphone right now?" — the question one expects
an operating system to answer. Read-only: none of the three systems allows
**hard-disabling** the camera from the user context; muting belongs to `mic`.

```json
"privacy": {
  "mic":    {"in_use": true, "apps": ["Discord"]},
  "camera": {"in_use": false}
}
```

`apps` names **only who is accessing right now** (display names, no paths) and
is absent when nobody is. A sub-section is missing entirely if the device does
not have it — a desktop without a camera thus gets no dead row.

Note — **Windows**: `CapabilityAccessManager\ConsentStore` in the registry —
the same source Windows uses for its own taskbar icon.
`LastUsedTimeStop == 0` **with** `LastUsedTimeStart` set = in use right now;
both conditions are required, otherwise every permission ever granted counts
as active use. Measured in both directions on a test machine.

**Error codes:** `501` = cap not available on this device (UI: hide/disable
the element) · `400` = invalid input (range, missing fields) ·
`502` = backend call failed (`{"error":"…"}`) — treat as transient.

### DeviceState

```json
{ "caps": ["audio","audio.set","brightness","brightness.set","wifi","wifi.set",
           "wifi.connect","bluetooth","battery","storage","displays"],
  "audio":      { "volume": 55, "muted": false, "sink": "Built-in Audio" },
  "brightness": { "level": 80 },
  "wifi":       { "enabled": true, "connected": "HomeNet", "signal": 72 },
  "bluetooth":  { "enabled": true, "connected": [{"address":"AA:BB:…","name":"Kopfhörer"}] },
  "mic":        { "muted": false, "volume": 62, "source": "Internes Mikrofon" },
  "battery":    { "percent": 88, "charging": true, "time_to_empty_min": 0,
                  "devices": [{"name":"Maus","percent":40}] },
  "storage":    [ { "mount": "/", "label": "System", "total_gb": 512.0,
                    "free_gb": 210.3, "removable": false } ],
  "displays":   [ { "id": "DP-1", "name": "LG 27\"", "resolution": "2560x1440",
                    "scale": 1.25, "enabled": true, "primary": true } ] }
```

Sections are missing when the cap is missing. `displays` is read-only in v1.

### Note: caps may change at runtime (since 0.5.6)

`wifi.set` and `wifi.connect` are **not** fixed at module start: on Linux,
polkit decides, and polkit answers differently depending on the session.
Measured — the same action, two answers:

| Caller | `enable-disable-wifi` | `settings.modify.own` |
|---|---|---|
| `Active` session (the user's Wayland session) | `yes` | `yes` |
| SSH without a session (service user) | `no` | `auth` |

The module therefore asks NetworkManager `GetPermissions` at most every 30 s
and switches the two caps on or off live. `"auth"` (polkit would prompt)
counts as **no** — a service without a screen cannot answer a password
dialog. Clients must therefore not cache caps once; the shell's 30 s safety
poll covers this.

IMPORTANT: **new Wi-Fi profiles are assigned to the user**
(`connection.permissions = user:<name>`). Reason: `settings.modify.system`
requires admin rights (`auth_admin_keep`), `settings.modify.own` does not.
Without this assignment every connection to an unknown network silently fails
at polkit. Consequence: the profile belongs to this user and does not show up
in other sessions — intended for a personal device.

Note: if activation fails (wrong password), **clarad deletes the profile it
just created**. Otherwise the network would count as `known` on the next
attempt, the UI would no longer ask for the password, and the user would keep
running into the same wrong password.

### Platform matrix (v0.5.0 → v0.5.x)

| Cap | Linux (Kubuntu/KDE, without root) | Windows 11 (without admin) |
|---|---|---|
| audio(.set) | wpctl/PipeWire (fallback pactl) — 0.5.0 | **go-wca/WASAPI — 0.5.9 ✅** (`IAudioEndpointVolume`) |
| audio.devices(.set) | **`pactl -f json` — 0.5.7 ✅** (list + default device) | **WASAPI list + IPolicyConfig — 0.5.9 ✅**; `.set` is **probed separately** because IPolicyConfig is undocumented |
| mic(.set) | **pactl `@DEFAULT_SOURCE@` — 0.5.7 ✅** (mute + level) | **WASAPI capture endpoint — 0.5.9 ✅** (mute + level) |
| brightness(.set) | KDE ScreenBrightness → PowerDevil → login1 — 0.5.0 | status only (WMI, internal panels) — open |
| wifi(.set/.connect) | **NetworkManager D-Bus — 0.5.6 ✅** | **complete — 0.5.10 ✅** radio switch via WinRT radios, network list/signal via `Windows.Devices.WiFi`, connecting **two ways**: known network via `netsh wlan connect` (Windows has the key), unknown via `ConnectWithPasswordCredentialAsync` (PSK **in memory**, never on disk) |
| bluetooth(…) | **BlueZ D-Bus — 0.5.6 ✅** | **WinRT radios — 0.5.9 ✅** radio switch only (`bluetooth`+`bluetooth.set`); device list/connecting open (needs `Windows.Devices.Enumeration`) |
| battery | UPower D-Bus — 0.5.0 | GetSystemPowerStatus — 0.5.0 |
| storage | Statfs + UDisks2 — 0.5.0 | GetLogicalDrives/GetDiskFreeSpaceEx — 0.5.0 |
| displays | kscreen-doctor -j (read-only) — 0.5.x | n/a |
| **privacy** | open (approach: `/dev/video*` + open file descriptors in `/proc`) | **ConsentStore registry — 0.5.11 ✅** (microphone + camera, "who right now") |

## Bridge contract shell ↔ companion (`window.ClaraOSNative`)

Injected by BRIDGE_JS (Tauri); the Android companion implements THE SAME
contract. The shell (the ClaraOS web origin) is the only consumer.

```js
window.ClaraOSNative = {
  version: "0.5.0",                      // real CARGO_PKG_VERSION
  caps: ["shutdown", "device-control-v1"], // COARSE: what this companion version can do
  shutdown() {…},                        // existing
  device: {                              // only present with "device-control-v1"
    getState()            → Promise<DeviceState>,  // incl. FINE caps (see above)
    set(section, payload) → Promise<Section>,      // section: audio|brightness|wifi|bluetooth
    get(section)          → Promise<…>,            // section: wifi/networks|bluetooth/devices
    connect(section, payload) → Promise<{ok}>,     // section: wifi|bluetooth
  },
};
```

- **Two-step negotiation:** `ClaraOSNative.caps` = "can this app do device
  control at all" (old installs: field missing ⇒ hide everything, `shutdown`
  stays usable). `DeviceState.caps` = what THIS device/OS can really do.
- **Live events:** `window.dispatchEvent(new CustomEvent("claraos:device-changed",
  {detail: {section, state}}))`. Source: SSE `device.changed` → Tauri →
  `w.eval` (the JSON is parsed and re-serialised on the Rust side — SSID names
  are radio input, never raw in eval strings!). The daemon coalesces per
  section to ≥500 ms.
- Daemon unreachable ⇒ `device.*` rejects with an error message; the shell
  shows the tiles disabled and retries on the next event.
- Security boundary: Tauri commands are callable only from the **paired
  shell origin** (a runtime capability granted for exactly that origin once
  the daemon reports it) — hence a fixed **section allowlist** in the Rust
  command; the daemon validates ranges. Changing calls (`device.set`,
  `device.connect`) additionally need the user's switch "Allow device
  control" in the tray (default off in the open-source build).

### Android companion — same contract, OS limits

Implementation: a `WebViewCompat.addWebMessageListener` port plus a
document-start shim that builds the contract-conforming `window.ClaraOSNative`
on top of it (promises, request ids). Both exist **only in the top frame of the
paired shell origin** — the listener checks origin and main frame again on
every message, so iframes (also same-origin ones) and other pages never reach
the device. Deliberately no `addJavascriptInterface`: that object is visible
to every frame, including foreign iframes. `device.changed` events are only
dispatched while the paired shell is the loaded page. Changing calls
(`set`, `openPanel`, `requestPermission`) ask the user once natively before
they work. Without WebMessageListener/DOCUMENT_START_SCRIPT support (very old
WebView) there is no bridge — the shell degrades as with old companions.

| Section | Android behaviour |
|---|---|
| audio(.set) | STREAM_MUSIC (media volume) via AudioManager — v1 |
| mic(.set) | `AudioManager.setMicrophoneMute` — **device-wide**, not just the app (`MODIFY_AUDIO_SETTINGS`, since 0.5.6). No broadcast ⇒ 3 s poll |
| Hotspot/tethering | **no switch possible** (system/carrier restriction) — only `openPanel("tethering")` |
| brightness | always readable; **`brightness.set` only after WRITE_SETTINGS is granted** (user dialog, see `requestPermission`) |
| battery / storage | BatteryManager / StatFs — v1 |
| wifi / bluetooth | **status only** (Android ≥10 forbids app toggles). `set` returns a 501-equivalent rejection; the UI uses `openPanel` as a jump-off |
| Airplane mode/SIM | display only + `openPanel` jump-off (system limit) |

**Optional bridge extensions (feature detection, the desktop doesn't have them):**
Note: **`audio/default` goes through `device.set`**, not through a separate
bridge call: the Tauri allowlist builds the path from the section name, so
`/v1/device/audio/default` stays reachable without loosening the allowlist.

- `device.openPanel(name)` — opens system UI; allowlist `wifi | internet |
  volume | bluetooth | display | tethering | privacy`. Returns void;
  unknown name = no-op. `tethering` first tries the direct hotspot page
  (`com.android.settings.TetherSettings`) and falls back to the network
  overview — the direct name is vendor-specific.
- `device.requestPermission(section)` → `Promise<{granted: boolean}>` —
  v1 only `"brightness"` (opens ACTION_MANAGE_WRITE_SETTINGS; `granted`
  reflects the state AFTER returning to the app).
- Events: the same `claraos:device-changed` CustomEvents, coalesced on the
  Java side per section to ≥500 ms (sources: battery receiver, brightness
  ContentObserver, Wi-Fi/BT state receivers, volume poll every 3 s with diff).
  Values go through `org.json` — SSIDs are radio input, never raw in
  evaluateJavascript strings.

## Events (SSE, `event:` field = type)

| Type | Data | Status |
|---|---|---|
| `state.changed` | `Status` | ✅ |
| `notification` | `{title, body, click_url?, priority?}` (ntfy) | ✅ |
| `module.changed` | `Info` (see above) | ✅ |
| `sync.progress` | `{module, done, total, last_error?}` | ✅ |
| `module.consent_request` | `{module_id, peer, capabilities[], nonce, ttl}` | ✅ (contract defined; no module uses it yet) |
| `device.changed` | `{section, state}` — section as in `DeviceState` | v0.5 (coalesced to ≥500 ms) |
| `push.auth-stale` | `{}` — ntfy rejected the stored credential | ✅ the app answers with `POST /v1/push/refresh` the next time the shell is loaded |


## Security model

- Bind loopback only; token is 32 random bytes, constant-time comparison.
- The tunnel's local proxy only serves the own user: desktop SOCKS5 checks the
  owner of each connecting socket/process; Android uses an HTTP proxy with a
  random per-run password (every app shares 127.0.0.1 there), which the WebView
  and OkHttp answer.
- tsnet log upload to Tailscale's log service is switched off (`TS_NO_LOGS_NO_SUPPORT`).
- The handshake file is user-private (0600, or the Windows user profile).
- Device control from the shell is bound to the paired origin (desktop: runtime
  Tauri capability; Android: origin-bound message port) and needs the user's
  explicit consent; the open-source build ships with it switched off.
- Consent dialogs are ALWAYS rendered by the Tauri app (own window), never by
  the shell WebView — the control channel stays outside the controlled session.
