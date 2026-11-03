// ClaraOS Companion Desktop — Tauri layer (deliberately thin).
//
// Tasks: start clarad as a sidecar (stdin pipe = liveness signal), poll the
// handshake file, proxy commands to the control API, and AFTER the tunnel is up
// build the shell window with proxy_url(socks5://127.0.0.1:<port>) — the port is
// dynamic, so the window cannot be declared statically in tauri.conf.json.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Deserialize;
use std::sync::Mutex;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::process::CommandChild;
use tauri_plugin_shell::ShellExt;

/// Scheme of the shell's action navigations (`claraos://companion/<action>`,
/// fallback channel of the ClaraOSNative bridge). Internal — part of the shell
/// contract, the same in every variant. The scheme the OS hands to the app for
/// pairing links comes from the Tauri config instead (`link_scheme`).
///
/// Deep-link scheme. Pairing: `claraos://provision?token=…` (identical to the
/// Android app's AndroidManifest.xml). Shell actions:
/// `claraos://companion/<action>` (fallback channel of the ClaraOSNative bridge).
const DEEP_LINK_SCHEME: &str = "claraos";

/// Clara hotkey. Ctrl+Alt+Space collides with neither Windows nor KDE default
/// bindings. On Wayland the plugin registers nothing (the compositor owns
/// hotkeys) → documented desktop shortcut on
/// `ClaraOS-Companion --show-clara`, see README.
const CLARA_HOTKEY: &str = "CmdOrControl+Alt+Space";

const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Injected into every shell page: counterpart of the Android bridge
/// (`ShellActivity.java`, `window.ClaraOSNative`). The shell loads remote
/// content and deliberately has NO general IPC access — actions run as
/// navigation to `claraos://companion/<action>` and are intercepted in
/// `open_shell::on_navigation`. F11 = fullscreen toggle.
const BRIDGE_JS: &str = r#"
(function () {
  if (window.__CLARAOS_COMPANION_BRIDGE__) return;
  window.__CLARAOS_COMPANION_BRIDGE__ = true;
  // Fallback channel: navigation to claraos://companion/… (caught by
  // on_navigation). ?n=… makes every URL unique — WebKit swallows repeated
  // navigations to the IDENTICAL blocked URL (an action would fire only once).
  var n = 0;
  var nav = function (a) {
    try { window.location.href = "claraos://companion/" + a + "?n=" + (++n) + "-" + Date.now(); } catch (e) {}
  };
  // Primary channel: real IPC (the shell-remote capability allows the shell
  // origin exactly our companion_* commands). Checked at call time, not at
  // injection — the order of init scripts is not guaranteed.
  var act = function (cmd, a) {
    var t = window.__TAURI__ && window.__TAURI__.core;
    if (t && t.invoke) { t.invoke(cmd).catch(function () { nav(a); }); } else { nav(a); }
  };
  window.ClaraOSNative = window.ClaraOSNative || {};
  window.ClaraOSNative.shutdown = function () { act("companion_shutdown", "shutdown"); };
  // Capability negotiation (contract: protocol/control-api.md). COARSE level:
  // can this companion version do device control? The FINE level (what the
  // device really supports) comes from device.getState().caps. Old installs
  // without this field: the shell hides quick settings entirely.
  window.ClaraOSNative.version = "__COMPANION_VERSION__";
  window.ClaraOSNative.caps = ["shutdown", "device-control-v1"];
  // Device API: real IPC ONLY — the claraos:// navigation fallback cannot
  // return anything and carries no payloads.
  var ipc = function (cmd, args) {
    var t = window.__TAURI__ && window.__TAURI__.core;
    if (!t || !t.invoke) return Promise.reject(new Error("kein IPC-Kanal"));
    return t.invoke(cmd, args || {});
  };
  window.ClaraOSNative.device = {
    getState: function () { return ipc("device_state"); },
    set:      function (section, payload) { return ipc("device_set", { section: section, payload: payload }); },
    get:      function (section) { return ipc("device_get", { section: section }); },
    connect:  function (section, payload) { return ipc("device_connect", { section: section, payload: payload }); },
  };
  // IMPORTANT: no fullscreen toggle. Any window size change made WebKitGTK
  // 2.52.3 abort — reproduced with real fullscreen, borderless-maximised and
  // with glass effects off, each within one or two rounds. The shell starts
  // screen-filling anyway; F11 was pure convenience and reliably killed the
  // app. F11 is swallowed so the shell itself cannot trigger a change either.
  window.addEventListener("keydown", function (e) {
    if (e.key === "F11") { e.preventDefault(); }
  });
})();
"#;

/// Diagnostic switch (`CLARAOS_NO_GLASS=1`): turns off the shell's glass look —
/// backdrop blur, filters, blend modes and size transitions.
/// Background: the start menu is a `position:fixed` element with
/// `backdrop-filter: blur(40px)` whose size depends on `vw/vh`; a window resize
/// starts a transition on it while Framer Motion animates the same element.
/// The Clara button additionally carries an endlessly rotating
/// `filter: blur(8px)` element *inside* the also-blurred bar. Exactly this layer
/// stack is the suspect for the abort on "start menu open + F11".
/// Runs in ALL frames (including the app iframes) — the Selkies apps need two
/// interventions because WebKitGTK 2.52 cannot handle their default video path
/// (GStreamer log: "h264parse: AVC caps, but no codec_data"):
/// 1. The Selkies 3 client configures WebCodecs H.264 without `description`
///    (= Annex B). WebKit builds an avc pipeline without codec_data from it,
///    which GStreamer rejects ⇒ audio plays, the picture stays at "Waiting for
///    stream". Hence: force the client's encoder setting to `jpeg` (key scheme
///    `<sanitised href>_encoder`, identical to the client code).
/// 2. The client decodes the jpeg path with the `ImageDecoder` API — which
///    WebKit doesn't have at all (Chromium only). Hence a mini polyfill on top of
///    `createImageBitmap`; the client only uses width/height/close/drawImage
///    (codedWidth added defensively, only read in shared mode).
/// Limited on purpose to the shell's own domain (`__SHELL_DOMAIN__`, filled in
/// from the shell URL by `selkies_compat_js`).
// r##…## instead of r#…#: the JS contains `split("#")`, whose `"#` would end
// the simple raw-string delimiter prematurely.
const SELKIES_COMPAT_JS: &str = r##"
(function () {
  var h = window.location.hostname || "";
  var d = "__SHELL_DOMAIN__";
  if (!d || !(h === d || h.slice(-(d.length + 1)) === "." + d)) return;
  try {
    var prefix = window.location.href.split("#")[0].replace(/[^a-zA-Z0-9.-_]/g, "_");
    window.localStorage.setItem(prefix + "_encoder", "jpeg");
  } catch (e) {}
  if (typeof window.ImageDecoder === "undefined") {
    var ID = function (init) {
      this._blob = new Blob([init.data], { type: (init && init.type) || "image/jpeg" });
    };
    ID.prototype.decode = function () {
      return createImageBitmap(this._blob).then(function (bmp) {
        try { bmp.codedWidth = bmp.width; bmp.codedHeight = bmp.height; } catch (e) {}
        return { image: bmp };
      });
    };
    ID.prototype.close = function () {};
    ID.isTypeSupported = function (t) {
      return Promise.resolve(typeof t === "string" && t.indexOf("image/") === 0);
    };
    window.ImageDecoder = ID;
  }
})();
"##;

/// Domain the shell belongs to: the shell host without a leading `home.`
/// (`home.example.org` → `example.org`). Its subdomains are the shell's apps.
fn shell_domain(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host.strip_prefix("home.").unwrap_or(&host).to_string()
}

/// The shell this device is paired with, set when the shell window opens. Everything
/// that hands data or rights to the page checks against it.
static PAIRED_SHELL: std::sync::Mutex<Option<tauri::Url>> = std::sync::Mutex::new(None);

fn paired_shell() -> Option<tauri::Url> {
    PAIRED_SHELL.lock().ok().and_then(|g| g.clone())
}

/// `scheme://host[:port]` of a URL.
fn origin_of(url: &tauri::Url) -> String {
    let host = url.host_str().unwrap_or("");
    match url.port() {
        Some(p) => format!("{}://{}:{}", url.scheme(), host, p),
        None => format!("{}://{}", url.scheme(), host),
    }
}

/// The page is the paired shell itself (same origin).
fn is_shell_origin(url: &tauri::Url) -> bool {
    paired_shell().is_some_and(|s| origin_of(&s) == origin_of(url))
}

/// The page belongs to the paired system: the shell's domain or one of its
/// subdomains (apps, login), over the shell's scheme.
fn is_shell_site(url: &tauri::Url) -> bool {
    let Some(shell) = paired_shell() else { return false };
    if url.scheme() != shell.scheme() {
        return false;
    }
    let domain = shell_domain(&shell);
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
}

/// Runs a script in the shell window only while it shows the paired shell — device
/// state and notification targets never go to another page.
fn eval_in_shell(w: &tauri::WebviewWindow, js: &str) {
    match w.url() {
        Ok(u) if is_shell_origin(&u) => {
            let _ = w.eval(js);
        }
        _ => {}
    }
}

/// Opens an http(s) URL in the system browser. No shell is involved, so the URL
/// cannot inject commands (it is a parsed `Url` anyway).
fn open_in_browser(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    #[cfg(target_os = "linux")]
    let r = std::process::Command::new("xdg-open").arg(url.as_str()).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("rundll32")
        .args(["url.dll,FileProtocolHandler", url.as_str()])
        .spawn();
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg(url.as_str()).spawn();
    if let Err(e) = r {
        log_line_static(&format!("Browser nicht startbar: {e}"));
    }
}

/// Creates a directory readable by the own user only (Unix: 0700). The app data
/// directory holds the session cookies and the log.
fn create_private_dir(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

/// `SELKIES_COMPAT_JS` bound to the domain of the shell being opened. The
/// domain comes from a parsed URL host, so it holds no quote or backslash.
fn selkies_compat_js(url: &tauri::Url) -> String {
    SELKIES_COMPAT_JS.replace("__SHELL_DOMAIN__", &shell_domain(url))
}

/// Lets the shell this device connected to (and only that origin, only in the shell
/// window) call the companion and device commands — the runtime twin of the home
/// build's static capability. Whether a device call goes through is decided later by
/// `require_device_control`.
fn grant_shell_ipc(app: &AppHandle, url: &tauri::Url) {
    if url.host_str().is_none() {
        return;
    }
    let origin = origin_of(url);
    // Only the app's own commands — no core:default: the shell needs no window,
    // event, menu or tray APIs, and a server must not get them.
    let cap = tauri::ipc::CapabilityBuilder::new("shell-remote-connected")
        .remote(origin.clone())
        .window("shell")
        .permission("allow-companion-shutdown")
        .permission("allow-device-state")
        .permission("allow-device-set")
        .permission("allow-device-get")
        .permission("allow-device-connect");
    match app.add_capability(cap) {
        Ok(()) => log_line_static(&format!("IPC für die Shell freigegeben: {origin}")),
        Err(e) => log_line_static(&format!("IPC-Freigabe für {origin} fehlgeschlagen: {e}")),
    }
}

/// Name of the system the app connects to, for window titles and the tray:
/// the product name without its " Companion" suffix ("Nolani Companion" ->
/// "Nolani"). The product name comes from the Tauri config, so a variant build
/// renames the app in one place.
fn brand_name(app: &AppHandle) -> String {
    let name = &app.package_info().name;
    name.strip_suffix(" Companion").unwrap_or(name).to_string()
}


const GLASS_OFF_JS: &str = r#"
(function () {
  var s = document.createElement("style");
  s.id = "claraos-no-glass";
  s.textContent = "*{backdrop-filter:none!important;-webkit-backdrop-filter:none!important;" +
    "mix-blend-mode:normal!important;filter:none!important}" +
    "[class*='panel'],[class*='Panel']{transition:none!important}" +
    "*{animation:none!important}";
  (document.head || document.documentElement).appendChild(s);
})();
"#;

/// Runs a companion action from the shell (`claraos://companion/…`).
/// `shutdown` = real exit like the tray entry: the app exit closes the
/// sidecar stdin pipe, clarad shuts the tunnel down cleanly.
fn handle_companion_action(app: &AppHandle, action: &str) {
    match action {
        "shutdown" => app.exit(0),
        "toggle-fullscreen" => {
            if let Some(w) = app.get_webview_window("shell") {
                // Clean up the borderless-maximised state left over from 0.3.8, so
                // the window doesn't get stuck undecorated in windowed mode.
                if !w.is_decorated().unwrap_or(true) {
                    let _ = w.set_decorations(true);
                    let _ = w.unmaximize();
                }
                let fs = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!fs);
            }
        }
        _ => log_line(app, &format!("unbekannte companion-Aktion: {action}")),
    }
}

/// Extracts an action from `claraos://companion/<action>` arguments — fallback
/// for when the WebView doesn't intercept the navigation itself but the OS
/// launches the registered scheme handler (second launch → single_instance argv).
fn companion_action_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    let prefix = format!("{DEEP_LINK_SCHEME}://companion/");
    args.into_iter().find_map(|a| {
        a.strip_prefix(&prefix)
            .map(|r| {
                r.split('?').next().unwrap_or("").trim_end_matches('/').to_string()
            })
            .filter(|r| !r.is_empty())
    })
}

/// IPC counterparts of the companion actions — callable ONLY from the shell
/// origin (capability `shell-remote`). Primary channel of the
/// `window.ClaraOSNative` bridge; the claraos:// navigation path stays a fallback.
#[tauri::command]
async fn companion_shutdown(app: AppHandle) {
    handle_companion_action(&app, "shutdown");
}

#[tauri::command]
async fn companion_toggle_fullscreen(app: AppHandle) {
    handle_companion_action(&app, "toggle-fullscreen");
}

// ── Device control (v0.5, contract protocol/control-api.md) ────────────────
//
// SECURITY: every registered command is automatically callable from the shell
// origin (capability shell-remote) — the FIXED section allowlist here therefore
// IS the security boundary. Caller input is never concatenated into the path.

fn device_path(kind: &str, section: &str) -> Result<String, String> {
    let ok = match kind {
        // "audio/default" goes through the set branch: the path is built from
        // the section, so /v1/device/audio/default is reachable without
        // loosening the allowlist.
        "set" => matches!(section,
            "audio" | "brightness" | "wifi" | "bluetooth" | "mic" | "audio/default"),
        "get" => matches!(section, "wifi/networks" | "bluetooth/devices" | "audio/devices"),
        "connect" => matches!(section, "wifi" | "bluetooth"),
        _ => false,
    };
    if !ok {
        return Err(format!("unbekannte Sektion: {section}"));
    }
    Ok(match kind {
        "connect" => format!("/v1/device/{section}/connect"),
        _ => format!("/v1/device/{section}"),
    })
}

// ── Device control: off unless the user allows it ──────────────────────────
//
// The shell is remote content. Changing this computer's settings (Wi-Fi, Bluetooth,
// audio, brightness …) from it is powerful, so the generic build starts with it OFF:
// the user switches it on in the tray menu ("Gerätesteuerung erlauben"). The home
// build starts with it on (build.sh sets COMPANION_DEVICE_CONTROL=on), as before.
// Reading the state stays allowed — the shell needs it to show its controls.

fn device_control_default() -> bool {
    matches!(option_env!("COMPANION_DEVICE_CONTROL"), Some("on"))
}

fn device_flag_file(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("device-control"))
}

/// The user's choice ("on"/"off" in the config dir), else the build's default.
fn device_control_allowed(app: &AppHandle) -> bool {
    match device_flag_file(app).and_then(|f| std::fs::read_to_string(f).ok()) {
        Some(v) if v.trim() == "on" => true,
        Some(v) if v.trim() == "off" => false,
        _ => device_control_default(),
    }
}

fn set_device_control(app: &AppHandle, on: bool) {
    if let Some(f) = device_flag_file(app) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(f, if on { "on" } else { "off" });
    }
    log_line_static(&format!("Gerätesteuerung: {}", if on { "erlaubt" } else { "aus" }));
}

/// Tray entry, kept so its check mark can be read after a click.
struct DeviceToggle(CheckMenuItem<tauri::Wry>);

static DEVICE_HINT_SHOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Refuses a changing device call while device control is off — and tells the user
/// once per run where to switch it on.
fn require_device_control(app: &AppHandle) -> Result<(), String> {
    if device_control_allowed(app) {
        return Ok(());
    }
    if !DEVICE_HINT_SHOWN.swap(true, std::sync::atomic::Ordering::SeqCst) {
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(&app.package_info().name)
            .body("Die Gerätesteuerung ist aus. Erlauben: Tray-Symbol → „Gerätesteuerung erlauben“.")
            .show();
    }
    Err("Gerätesteuerung ist ausgeschaltet".into())
}

#[tauri::command]
async fn device_state(app: AppHandle) -> Result<serde_json::Value, String> {
    daemon_call(&app, reqwest::Method::GET, "/v1/device/state", None).await
}

#[tauri::command]
async fn device_set(
    app: AppHandle,
    section: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_device_control(&app)?;
    let path = device_path("set", &section)?;
    daemon_call(&app, reqwest::Method::POST, &path, Some(payload)).await
}

#[tauri::command]
async fn device_get(app: AppHandle, section: String) -> Result<serde_json::Value, String> {
    require_device_control(&app)?;
    let path = device_path("get", &section)?;
    daemon_call(&app, reqwest::Method::GET, &path, None).await
}

#[tauri::command]
async fn device_connect(
    app: AppHandle,
    section: String,
    payload: serde_json::Value,
) -> Result<serde_json::Value, String> {
    require_device_control(&app)?;
    let path = device_path("connect", &section)?;
    daemon_call(&app, reqwest::Method::POST, &path, Some(payload)).await
}

#[derive(Clone, Deserialize)]
struct Handshake {
    port: u16,
    token: String,
}

/// Held sidecar process: dropping it would close the stdin pipe and end clarad
/// (--watch-stdin) cleanly — which is exactly what happens on app exit.
struct DaemonState {
    child: Mutex<Option<CommandChild>>,
    conn: Mutex<Option<Handshake>>,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy() // the control API is loopback — never via a system proxy
        .build()
        .expect("reqwest client")
}

async fn daemon_call(
    app: &AppHandle,
    method: reqwest::Method,
    path: &str,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let conn = {
        let st = app.state::<DaemonState>();
        let guard = st.conn.lock().unwrap();
        guard.clone().ok_or("daemon nicht verbunden")?
    };
    let url = format!("http://127.0.0.1:{}{}", conn.port, path);
    let mut req = client()
        .request(method, &url)
        .bearer_auth(&conn.token)
        .timeout(std::time::Duration::from_secs(45));
    if let Some(b) = body {
        req = req.json(&b);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    let val: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(val["error"].as_str().unwrap_or("unbekannter Fehler").to_string());
    }
    Ok(val)
}

#[tauri::command]
async fn daemon_status(app: AppHandle) -> Result<serde_json::Value, String> {
    daemon_call(&app, reqwest::Method::GET, "/v1/status", None).await
}

#[tauri::command]
async fn daemon_provision(app: AppHandle, token: String) -> Result<serde_json::Value, String> {
    daemon_call(
        &app,
        reqwest::Method::POST,
        "/v1/provision",
        Some(serde_json::json!({ "token": token })),
    )
    .await
}

/// Connect by server address (no invitation): direct, or through a tunnel with a
/// coordination server + auth key the user enters.
#[tauri::command]
async fn daemon_connect(
    app: AppHandle,
    server: String,
    control_url: Option<String>,
    auth_key: Option<String>,
) -> Result<serde_json::Value, String> {
    daemon_call(
        &app,
        reqwest::Method::POST,
        "/v1/connect",
        Some(serde_json::json!({
            "server": server,
            "control_url": control_url.unwrap_or_default(),
            "auth_key": auth_key.unwrap_or_default(),
        })),
    )
    .await
}

/// Name of the system for the onboarding window ("Nolani", "ClaraOS").
#[tauri::command]
fn app_brand(app: AppHandle) -> String {
    brand_name(&app)
}

/// Builds the shell window through the tunnel. Called by the onboarding window
/// as soon as the status reports `up` (the frontend polls daemon_status).
/// Read/write sync folders (status window). The daemon validates the paths.
#[tauri::command]
async fn sync_config(app: AppHandle) -> Result<serde_json::Value, String> {
    daemon_call(&app, reqwest::Method::GET, "/v1/sync/config", None).await
}

#[tauri::command]
async fn set_sync_config(app: AppHandle, config: serde_json::Value) -> Result<serde_json::Value, String> {
    daemon_call(&app, reqwest::Method::PUT, "/v1/sync/config", Some(config)).await
}

/// Answer to a consent dialog (remote-control foundation). Deliberately here and
/// not in the shell WebView: that one could be remote-controlled.
#[tauri::command]
async fn answer_consent(app: AppHandle, module_id: String, nonce: String, granted: bool)
    -> Result<serde_json::Value, String> {
    daemon_call(
        &app,
        reqwest::Method::POST,
        &format!("/v1/modules/{module_id}/consent"),
        Some(serde_json::json!({ "nonce": nonce, "granted": granted })),
    )
    .await
}

#[tauri::command]
async fn open_shell(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window("shell").is_some() {
        return Ok(());
    }
    let status = daemon_call(&app, reqwest::Method::GET, "/v1/status", None).await?;
    if status["state"] != "up" {
        return Err("Tunnel ist nicht up".into());
    }
    // Direct (no tunnel): no SOCKS port, the shell loads without proxy.
    let port = status["socks_port"].as_u64().unwrap_or(0);
    let direct = status["direct"].as_bool().unwrap_or(false);
    if port == 0 && !direct {
        return Err("kein socks_port".into());
    }
    let shell_url = status["shell_url"].as_str().ok_or("keine shell_url")?.to_string();
    log_line_static(&format!("open_shell: state=up socks_port={port} direct={direct}"));

    // UA marker like Android (ShellActivity): the shell uses it to recognise the
    // companion (IS_COMPANION) and suppress install offers. The platform in
    // parentheses feeds the shell's platform matrix.
    let platform = if cfg!(windows) { "windows" } else { "linux" };
    let ua = format!(
        "Mozilla/5.0 ({}) AppleWebKit/537.36 (KHTML, like Gecko) ClaraOSCompanion/{} ({})",
        if cfg!(windows) { "Windows NT 10.0; Win64; x64" } else { "X11; Linux x86_64" },
        VERSION,
        platform
    );

    let proxy: Option<tauri::Url> = if port > 0 {
        Some(
            format!("socks5://127.0.0.1:{port}")
                .parse()
                .map_err(|e| format!("proxy-url: {e}"))?,
        )
    } else {
        None
    };
    let url: tauri::Url = shell_url.parse().map_err(|e| format!("shell-url: {e}"))?;
    // The shell gets IPC, microphone and device events — only ever over https with a
    // real host name, whatever a pairing server answered.
    if url.scheme() != "https" || url.domain().is_none() {
        return Err(format!("shell-url nicht erlaubt: {}", origin_of(&url)));
    }
    if let Ok(mut g) = PAIRED_SHELL.lock() {
        *g = Some(url.clone());
    }
    let compat_js = selkies_compat_js(&url);
    grant_shell_ipc(&app, &url);

    let nav_app = app.clone();
    let mut builder = WebviewWindowBuilder::new(&app, "shell", WebviewUrl::External(url))
        .title(&brand_name(&app))
        .inner_size(1280.0, 820.0)
        .user_agent(&ua)
        .initialization_script(&BRIDGE_JS.replace("__COMPANION_VERSION__", VERSION))
        .initialization_script_for_all_frames(&compat_js)
        .initialization_script(if std::env::var("CLARAOS_NO_GLASS").as_deref() == Ok("1") {
            GLASS_OFF_JS
        } else {
            ""
        })
        .on_navigation(move |u| {
            if u.scheme() == DEEP_LINK_SCHEME {
                // claraos:// is never a loadable page. Run actions
                // asynchronously — app.exit() doesn't belong in the policy callback.
                if u.host_str() == Some("companion") {
                    let action = u.path().trim_start_matches('/').to_string();
                    let app2 = nav_app.clone();
                    tauri::async_runtime::spawn(async move {
                        handle_companion_action(&app2, &action);
                    });
                }
                return false;
            }
            true
        });
    if let Some(p) = proxy {
        builder = builder.proxy_url(p);
    }
    // Direct setup (no invitation, so no push credentials from provisioning): once
    // the shell itself has loaded — the user is signed in — fetch this device's push
    // credentials with the session. Only on the shell host (not the login pages) and
    // only while push is not set up; `erneuere_push_zugang` limits it to once per 10 min.
    //
    // Every top-level page outside the paired system (a link in a document, an app
    // frame redirecting the top window) opens in the system browser instead: the
    // borderless window has no address bar, so a foreign page here would look like
    // the shell. (Not in on_navigation: on WebKitGTK that also sees iframes.)
    {
        let shell_host = shell_url
            .parse::<tauri::Url>()
            .ok()
            .and_then(|u| u.host_str().map(str::to_string));
        let load_app = app.clone();
        builder = builder.on_page_load(move |w, payload| {
            let url = payload.url();
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                if matches!(url.scheme(), "http" | "https") && !is_shell_site(url) {
                    log_line_static(&format!("fremde Seite im Browser geöffnet: {}", origin_of(url)));
                    open_in_browser(url);
                    let _ = w.eval("history.back()");
                }
                return;
            }
            if !direct || !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            if url.host_str().map(str::to_string) != shell_host {
                return;
            }
            let app2 = load_app.clone();
            tauri::async_runtime::spawn(async move {
                let push = daemon_call(&app2, reqwest::Method::GET, "/v1/status", None)
                    .await
                    .map(|s| s["push"].as_bool().unwrap_or(false))
                    .unwrap_or(true);
                if push {
                    return;
                }
                match erneuere_push_zugang(&app2).await {
                    Ok(()) => log_line_static("direkt: Push eingerichtet"),
                    Err(e) => log_line_static(&format!("direkt: Push nicht eingerichtet: {e}")),
                }
            });
        });
    }
    // IMPORTANT — Windows/WebView2: the onboarding window starts the WebView2
    // browser process WITHOUT proxy arguments. A second window in the same
    // user data folder must not request DIFFERENT environment options — with
    // `--proxy-server` from proxy_url the initialisation therefore hung forever
    // (the window existed only in Tauri's registry,
    // is_visible → FailedToReceiveMessage, MainWindowHandle=0: the Windows
    // shell window never appeared). Own data directory = own browser process
    // = own arguments. Cookies/SSO thus persist in shell-profile/ (persisted
    // as intended).
    #[cfg(windows)]
    {
        if let Ok(dir) = app.path().app_local_data_dir() {
            builder = builder.data_directory(dir.join("shell-profile"));
        }
    }
    let shell_window = builder
        .build()
        .map_err(|e| {
            // IMPORTANT: without a file log this error was invisible on Windows —
            // the string only went to the onboarding UI (which is destroyed next).
            log_line_static(&format!("open_shell: shell-build FEHLER: {e}"));
            e.to_string()
        })?;
    log_line_static("open_shell: shell-build ok");
    // Windows diagnostics: is the shell window still alive 2 s after the build,
    // and is it visible? WebView2 initialises asynchronously — a failure there
    // removes the window AFTER a successful build().
    {
        let probe = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            match probe.get_webview_window("shell") {
                Some(w) => log_line_static(&format!(
                    "shell nach 2s: vorhanden, visible={:?} minimized={:?}",
                    w.is_visible(),
                    w.is_minimized()
                )),
                None => log_line_static("shell nach 2s: FENSTER WEG"),
            }
        });
    }

    // IMPORTANT: turn off tracking prevention (ITP) — otherwise no SSO in the apps.
    // The shell embeds apps as frames under their own hostnames (app subdomains
    // inside the shell's frame). WebKitGTK 2.52 treats their cookies as
    // third-party cookies and blocks them ⇒ the app shows the Authentik login
    // instead of its content (observed right after moving from WebKitGTK 2.50
    // to 2.52).
    #[cfg(target_os = "linux")]
    {
        let win = app.get_webview_window("shell");
        if let Some(w) = win {
            let cookie_db = app
                .path()
                .app_local_data_dir()
                .map(|d| d.join("cookies.sqlite"))
                .ok();
            let _ = w.with_webview(move |wv| {
                use webkit2gtk::{
                    CookieManagerExt, CookiePersistentStorage, WebContextExt, WebViewExt,
                    WebsiteDataManagerExt,
                };
                let webview: webkit2gtk::WebView = wv.inner();
                // IMPORTANT: WebRTC is OFF by default in WebKitGTK (WebKitSettings).
                // Without these switches Selkies stays at "Waiting for stream",
                // even if all GStreamer elements are bundled — the engine then
                // doesn't even attempt the connection.
                {
                    use webkit2gtk::SettingsExt;
                    if let Some(s) = WebViewExt::settings(&webview) {
                        s.set_enable_webrtc(true);
                        s.set_enable_media_stream(true);
                        s.set_enable_mediasource(true);
                        s.set_enable_encrypted_media(true);
                        log_line_static("WebRTC/Media-Stream aktiviert");
                    }
                }
                // IMPORTANT: otherwise nobody catches renderer death: if the
                // WebKitWebProcess dies — observed as SIGABRT in the Mesa/GBM
                // cleanup routine on process exit (core dump) — the app keeps
                // running in the UI process but only shows a blank pane.
                // Reload instead of showing a dead view; a brake prevents reload
                // loops if the renderer dies again immediately.
                {
                    use std::sync::atomic::{AtomicU64, Ordering};
                    static LAST_RELOAD: AtomicU64 = AtomicU64::new(0);
                    webview.connect_web_process_terminated(|wv, reason| {
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map(|d| d.as_secs())
                            .unwrap_or(0);
                        let last = LAST_RELOAD.swap(now, Ordering::SeqCst);
                        if now.saturating_sub(last) < 10 {
                            log_line_static(&format!(
                                "WebProcess erneut gestorben ({reason:?}) — Reload-Bremse aktiv"
                            ));
                            return;
                        }
                        log_line_static(&format!(
                            "WebProcess gestorben ({reason:?}) — Shell wird neu geladen"
                        ));
                        wv.reload();
                    });
                }
                // Microphone/camera for Clara voice: without its own handler
                // WebKitGTK silently denies every permission request —
                // getUserMedia returned NotAllowedError in the companion (verified
                // on a test laptop), the shell's mic button simply did nothing.
                // Granted only while the window shows the paired system (shell,
                // its apps) — never to a foreign page that got loaded.
                {
                    use webkit2gtk::glib::prelude::ObjectExt as _;
                    use webkit2gtk::{
                        DeviceInfoPermissionRequest, PermissionRequestExt,
                        UserMediaPermissionRequest,
                    };
                    webview.connect_permission_request(|wv, req| {
                        let own = wv
                            .uri()
                            .and_then(|u| u.as_str().parse::<tauri::Url>().ok())
                            .is_some_and(|u| is_shell_site(&u));
                        if own
                            && (req.is::<UserMediaPermissionRequest>()
                                || req.is::<DeviceInfoPermissionRequest>())
                        {
                            req.allow();
                        } else {
                            req.deny();
                        }
                        true
                    });
                }
                if let Some(ctx) = webview.context() {
                    if let Some(mgr) = ctx.website_data_manager() {
                        mgr.set_itp_enabled(false);
                        if let Some(cookies) = mgr.cookie_manager() {
                            // Accept all cookies — the default would be "first
                            // party only", and the apps run as frames under
                            // their own subdomains.
                            cookies.set_accept_policy(webkit2gtk::CookieAcceptPolicy::Always);
                            // Note: persistent storage: without it the login is
                            // gone after every app restart — the apps then show
                            // the Authentik login again. In 0.4.3 this was only
                            // an ineffective placeholder.
                            if let Some(path) = cookie_db.as_ref().and_then(|p| p.to_str()) {
                                cookies.set_persistent_storage(
                                    path,
                                    CookiePersistentStorage::Sqlite,
                                );
                                // SECURITY: readable by the own user only. The
                                // file contains session credentials (no
                                // passwords) — 0644 would be needlessly wide.
                                #[cfg(unix)]
                                {
                                    use std::os::unix::fs::PermissionsExt;
                                    let p = std::path::Path::new(path);
                                    for _ in 0..20 {
                                        if p.exists() {
                                            let _ = std::fs::set_permissions(
                                                p,
                                                std::fs::Permissions::from_mode(0o600),
                                            );
                                            break;
                                        }
                                        std::thread::sleep(std::time::Duration::from_millis(200));
                                    }
                                }
                                log_line_static(&format!("Cookie-Ablage: {path}"));
                            }
                        }
                    }
                }
            });
        }
    }

    // Real fullscreen — slightly delayed because WebKit otherwise tracks the size
    // incorrectly. 0.3.8 used borderless-maximised here (the fullscreen path was
    // suspected); that was a red herring — the crashes came from a `setenv` in a
    // worker thread. Maximised also respects the panel reservation, which left the
    // KDE panel visible.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        let _ = shell_window.set_fullscreen(true);
    });

    if let Some(w) = app.get_webview_window("onboarding") {
        log_line_static(&format!(
            "open_shell: onboarding wird zerstört (fenster gesamt={})",
            app.webview_windows().len()
        ));
        // destroy instead of close: close() would be intercepted by the
        // CloseRequested handler (which now only hides windows).
        let _ = w.destroy();
    }
    Ok(())
}

/// Autostart on/off (the onboarding UI offers it after pairing).
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    let m = app.autolaunch();
    if enabled {
        m.enable().map_err(|e| e.to_string())
    } else {
        m.disable().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> Result<bool, String> {
    use tauri_plugin_autostart::ManagerExt;
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Linux: without libfuse2 the AppImage only runs in extract-and-run fallback
/// mode — that is slow AND unsafe with multiple launches (the shared /tmp
/// extraction directory gets deleted when the SECOND launch exits → SIGABRT of
/// the running instance). Without root the app cannot install it itself (AppImages
/// have no "installer integration") → show a friendly hint once.
#[cfg(target_os = "linux")]
fn hint_missing_fuse_once(app: &AppHandle) {
    let have_fuse = [
        "/usr/lib/x86_64-linux-gnu/libfuse.so.2",
        "/usr/lib64/libfuse.so.2",
        "/usr/lib/libfuse.so.2",
    ]
    .iter()
    .any(|p| std::path::Path::new(p).exists());
    if have_fuse || std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    let Ok(dir) = app.path().app_local_data_dir() else { return };
    let marker = dir.join("fuse-hint-shown");
    if marker.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&marker, b"1");
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title(&app.package_info().name)
        .body("Tipp: Einmal »sudo apt install libfuse2t64« (bzw. libfuse2) installieren — die App startet dann schneller und Updates laufen zuverlässiger.")
        .show();
}

fn spawn_daemon(app: &AppHandle) -> Result<(), String> {
    let data_dir = app
        .path()
        .app_local_data_dir()
        .map_err(|e| e.to_string())?;
    create_private_dir(&data_dir).map_err(|e| e.to_string())?;
    let hs_path = data_dir.join("clarad-handshake.json");
    let _ = std::fs::remove_file(&hs_path); // a stale handshake would be a lie

    let sidecar = app
        .shell()
        .sidecar("clarad")
        .map_err(|e| e.to_string())?
        .args([
            "--watch-stdin",
            "--handshake-file",
            hs_path.to_str().ok_or("handshake-pfad")?,
        ]);
    let (mut _rx, child) = sidecar.spawn().map_err(|e| e.to_string())?;
    app.state::<DaemonState>().child.lock().unwrap().replace(child);

    // Poll the handshake (≤10 s), then store the connection + emit an event to the UI.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..100 {
            if let Ok(raw) = tokio::fs::read(&hs_path).await {
                if let Ok(hs) = serde_json::from_slice::<Handshake>(&raw) {
                    app2.state::<DaemonState>().conn.lock().unwrap().replace(hs);
                    let _ = tauri::Emitter::emit(&app2, "daemon-ready", ());
                    return;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let _ = tauri::Emitter::emit(&app2, "daemon-failed", "Handshake-Timeout (10 s)");
    });
    Ok(())
}

/// Brings the window to the front (tray click, second launch, deep link).
fn focus_main_window(app: &AppHandle) {
    for label in ["shell", "onboarding"] {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.show();
            let _ = w.unminimize();
            let _ = w.set_focus();
            return;
        }
    }
    // IMPORTANT: no window left: since the app keeps running when the "last
    // window is closed", the tray entry "open" must not reach into the void.
    // Rebuild the onboarding window — it polls the status and calls
    // open_shell again by itself on `up`.
    log_line_static("kein Fenster vorhanden — Onboarding wird neu gebaut");
    match WebviewWindowBuilder::new(app, "onboarding", WebviewUrl::App("index.html".into()))
        .title(&app.package_info().name)
        .inner_size(480.0, 580.0)
        .resizable(false)
        .center()
        .build()
    {
        Ok(w) => {
            let _ = w.set_focus();
        }
        Err(e) => log_line_static(&format!("Onboarding-Neubau fehlgeschlagen: {e}")),
    }
}

/// Scheme the OS hands to the app for pairing links: the first scheme of the
/// deep-link plugin in the Tauri config (variant-specific: `nolani`, `claraos`).
fn link_scheme(app: &AppHandle) -> String {
    app.config()
        .plugins
        .0
        .get("deep-link")
        .and_then(|d| d.get("desktop"))
        .and_then(|d| d.get("schemes"))
        .and_then(|s| s.get(0))
        .and_then(|s| s.as_str())
        .unwrap_or(DEEP_LINK_SCHEME)
        .to_string()
}

/// A pairing link from the process arguments.
#[derive(Debug, PartialEq)]
enum Link {
    /// `<scheme>://provision?token=…` — invitation, pairs right away.
    Token(String),
    /// `<scheme>://connect?server=…` — only fills in the address; connecting
    /// takes a click (a link must not point the app at a server unasked).
    Server(String),
}

/// Extracts a pairing link from the arguments. Deliberately without a URL crate:
/// deep links arrive as a process argument (Windows/Linux).
fn link_from_args<I: IntoIterator<Item = String>>(args: I, scheme: &str) -> Option<Link> {
    for a in args {
        let Some(rest) = a.strip_prefix(&format!("{scheme}://")) else { continue };
        let (target, query) = rest.split_once('?').unwrap_or((rest, ""));
        let key = match target.trim_end_matches('/') {
            "provision" => "token=",
            "connect" => "server=",
            _ => continue,
        };
        for pair in query.split('&') {
            if let Some(v) = pair.strip_prefix(key) {
                let v = v.trim_end_matches('/');
                if v.is_empty() {
                    continue;
                }
                return Some(if key == "token=" {
                    Link::Token(v.to_string())
                } else {
                    Link::Server(percent_decode(v))
                });
            }
        }
    }
    None
}

/// Minimal %XX decoding for a server address from a link (`https%3A%2F%2F…`).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // Byte-wise (not &s[..]): a multi-byte character after '%' must not panic.
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| (c as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Hands a pairing link to the onboarding window.
fn deliver_link(app: &AppHandle, link: Link) {
    match link {
        Link::Token(t) => deliver_token(app, t),
        Link::Server(s) => {
            focus_main_window(app);
            let _ = tauri::Emitter::emit(app, "connect-server", s);
        }
    }
}

/// Hands the deep-link token to the onboarding window (fills in the input field
/// and pairs automatically — like `ShellActivity.tokenFromIntent()` on Android).
fn deliver_token(app: &AppHandle, token: String) {
    focus_main_window(app);
    let _ = tauri::Emitter::emit(app, "provision-token", token);
}

/// Shows the shell and sends it to Clara (hotkey/tray entry).
fn show_clara(app: &AppHandle) {
    focus_main_window(app);
    if let Some(w) = app.get_webview_window("shell") {
        // The shell listens for this event and opens its Clara panel; until that
        // is wired up in the shell, at least the window is in front.
        eval_in_shell(&w, "window.dispatchEvent(new CustomEvent('claraos:open-clara'))");
    }
}

/// Subscribes to the daemon's SSE stream: forwards notifications and module/status
/// events to the UI or the system.
fn subscribe_events(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wait until the handshake is there.
        let conn = loop {
            {
                let st = app.state::<DaemonState>();
                let guard = st.conn.lock().unwrap();
                if let Some(c) = guard.clone() {
                    break c;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        };
        let url = format!("http://127.0.0.1:{}/v1/events", conn.port);
        loop {
            match client().get(&url).bearer_auth(&conn.token).send().await {
                Ok(resp) => {
                    use futures_util::StreamExt;
                    let mut stream = resp.bytes_stream();
                    let mut buf = String::new();
                    let mut event = String::new();
                    while let Some(Ok(chunk)) = stream.next().await {
                        buf.push_str(&String::from_utf8_lossy(&chunk));
                        while let Some(pos) = buf.find('\n') {
                            let line = buf[..pos].trim_end().to_string();
                            buf.drain(..=pos);
                            if let Some(v) = line.strip_prefix("event: ") {
                                event = v.to_string();
                            } else if let Some(v) = line.strip_prefix("data: ") {
                                handle_daemon_event(&app, &event, v);
                            }
                        }
                    }
                }
                Err(e) => log_line(&app, &format!("events: {e}")),
            }
            // Daemon restarted or similar → subscribe again.
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
    });
}

/// Target of the log file; set in `setup`.
///
/// IMPORTANT: on Windows `windows_subsystem = "windows"` is set ⇒ there is NO
/// console, and stderr goes nowhere — even `Start-Process
/// -RedirectStandardError` yields an empty file. When debugging a Windows
/// machine (the app vanished after ~40 s) there was therefore no trace at all
/// except the clarad log. Since then the app also writes to its own file next
/// to the daemon log.
static LOG_PATH: std::sync::OnceLock<std::path::PathBuf> = std::sync::OnceLock::new();

fn log_line(_app: &AppHandle, msg: &str) {
    log_line_static(msg);
}

/// Log line without an AppHandle — for callbacks that must not hold one.
fn log_line_static(msg: &str) {
    eprintln!("[companion] {msg}");
    if let Some(path) = LOG_PATH.get() {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{secs}] {msg}");
        }
    }
}

/// Time of the last credential refresh — guards against self-amplification.
static LETZTE_ERNEUERUNG: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Fetches a fresh ntfy credential using the logged-in session of the shell window.
///
/// IMPORTANT — the bug behind this: ntfy issues tokens with a 72 h lifetime, but the
/// daemon only stored its token at pairing time. Three days after pairing a
/// Windows machine logged "stream ended (ntfy HTTP 401)" every 64 seconds — 3160
/// times, with nothing healing it. It could only be repaired by hand.
///
/// Note — division of labour: **we** have the session (the cookies live in the
/// WebView), **the daemon** has the tunnel (the shell URL may only be reachable
/// through the tailnet). So we only hand over the cookies and let it fetch — this
/// needs no second secret on the device and no new trust path on the server.
async fn erneuere_push_zugang(app: &AppHandle) -> Result<(), String> {
    {
        let mut letzte = LETZTE_ERNEUERUNG.lock().unwrap();
        if let Some(t) = *letzte {
            if t.elapsed() < std::time::Duration::from_secs(600) {
                return Err("Mindestabstand noch nicht erreicht".into());
            }
        }
        *letzte = Some(std::time::Instant::now());
    }

    let fenster = app
        .get_webview_window("shell")
        .ok_or("kein Shell-Fenster — App einmal oeffnen")?;
    let status = daemon_call(app, reqwest::Method::GET, "/v1/status", None).await?;
    let shell_url = status["shell_url"].as_str().unwrap_or_default();
    if shell_url.is_empty() {
        return Err("keine Shell-URL im Status".into());
    }
    let url: tauri::Url = shell_url.parse().map_err(|e| format!("shell-url: {e}"))?;
    let kekse = fenster
        .cookies_for_url(url)
        .map_err(|e| format!("Kekse nicht lesbar: {e}"))?;
    let kopfzeile = kekse
        .iter()
        .map(|c| format!("{}={}", c.name(), c.value()))
        .collect::<Vec<_>>()
        .join("; ");
    if kopfzeile.is_empty() {
        return Err("keine Sitzung im Fenster (App einmal oeffnen und anmelden)".into());
    }
    daemon_call(
        app,
        reqwest::Method::POST,
        "/v1/push/refresh",
        Some(serde_json::json!({ "cookies": kopfzeile })),
    )
    .await?;
    log_line_static("push-zugang erneuert");
    Ok(())
}

/// How many notifications are currently waiting for a click (one notify-send
/// process each). Above the limit the plugin shows them without a click target,
/// so a burst of notifications doesn't pile up processes.
#[cfg(target_os = "linux")]
static KLICK_WARTENDE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(target_os = "linux")]
const KLICK_WARTENDE_MAX: usize = 20;

/// Shows the notification via `notify-send --action` and waits for the click in
/// its own thread. Click ⇒ window to the front + the click target sent into the
/// shell as `claraos:companion-notification-click` (the shell evaluates it with
/// `parseShellDeepLink`, like "open" in the ClaraOS notification).
/// `false` ⇒ notify-send is missing/fails — the caller then uses the plugin.
#[cfg(target_os = "linux")]
fn zeige_mit_klickziel(app: &AppHandle, title: &str, body: &str, click_url: &str) -> bool {
    use std::process::{Command, Stdio};
    use std::sync::atomic::Ordering;
    if KLICK_WARTENDE.load(Ordering::SeqCst) >= KLICK_WARTENDE_MAX {
        return false;
    }
    let mut cmd = Command::new("notify-send");
    cmd.arg(format!("--app-name={}", app.package_info().name))
        .arg("--action=default=Öffnen")
        .arg("--")
        .arg(title)
        .arg(body)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // IMPORTANT: the AppImage redirects library and module paths into its bundle; a
    // system notify-send would then load foreign glib/gio parts and die silently.
    for var in [
        "LD_LIBRARY_PATH", "LD_PRELOAD", "GIO_MODULE_DIR", "GIO_EXTRA_MODULES",
        "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR", "GSETTINGS_SCHEMA_DIR",
        "GTK_PATH", "GTK_EXE_PREFIX", "GTK_DATA_PREFIX", "GTK_IM_MODULE_FILE",
    ] {
        cmd.env_remove(var);
    }
    let Ok(child) = cmd.spawn() else {
        log_line_static("notify-send nicht startbar — Meldung ohne Klickziel");
        return false;
    };
    KLICK_WARTENDE.fetch_add(1, Ordering::SeqCst);
    let app = app.clone();
    let click_url = click_url.to_string();
    std::thread::spawn(move || {
        let out = child.wait_with_output();
        KLICK_WARTENDE.fetch_sub(1, Ordering::SeqCst);
        let Ok(out) = out else { return };
        if String::from_utf8_lossy(&out.stdout).trim() != "default" {
            return; // dismissed or expired
        }
        // SECURITY: as with device.changed: the URL comes from outside (ntfy) and is
        // serialised as JSON, never put raw into the eval string.
        let Ok(safe) = serde_json::to_string(&serde_json::json!({ "url": click_url })) else {
            return;
        };
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            focus_main_window(&app2);
            if let Some(w) = app2.get_webview_window("shell") {
                eval_in_shell(&w, &format!(
                    "window.dispatchEvent(new CustomEvent('claraos:companion-notification-click',{{detail:{safe}}}))"
                ));
            }
        });
    });
    true
}

fn handle_daemon_event(app: &AppHandle, event: &str, data: &str) {
    match event {
        // The daemon reports that ntfy rejects its credential (401).
        // Only we can reach the session — so we fetch a fresh one.
        "push.auth-stale" => {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = erneuere_push_zugang(&app2).await {
                    log_line_static(&format!("push-zugang nicht erneuert: {e}"));
                }
            });
        }
        "notification" => {
            #[derive(Deserialize)]
            struct N {
                title: String,
                body: String,
                #[serde(default)]
                click_url: String,
            }
            if let Ok(n) = serde_json::from_str::<N>(data) {
                // The notification plugin doesn't report clicks back on the
                // desktop — the event `notification-click-url` fired here earlier
                // never had a receiver, a click on the popup only closed it.
                // On Linux we therefore use notify-send (--action waits and
                // prints the click).
                #[cfg(target_os = "linux")]
                if !n.click_url.is_empty() && zeige_mit_klickziel(app, &n.title, &n.body, &n.click_url) {
                    return;
                }
                use tauri_plugin_notification::NotificationExt;
                let _ = app.notification().builder().title(&n.title).body(&n.body).show();
            }
        }
        // Device change → as a CustomEvent into the shell WebView (missing link
        // daemon→shell; contract control-api.md). SECURITY: data is parsed and
        // RE-SERIALISED, never put raw into the eval string: SSID/device names are
        // radio input and could otherwise break out of the JS string. The daemon
        // already coalesces (>=500 ms) — spare WebKitGTK's eval.
        "device.changed" => {
            if let Some(w) = app.get_webview_window("shell") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Ok(safe) = serde_json::to_string(&v) {
                        eval_in_shell(&w, &format!(
                            "window.dispatchEvent(new CustomEvent('claraos:device-changed',{{detail:{safe}}}))"
                        ));
                    }
                }
            }
        }
        // state.changed / module.changed only matter to the UI.
        _ => {
            let _ = tauri::Emitter::emit(app, &format!("daemon:{event}"), data.to_string());
        }
    }
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let open_label = format!("{} öffnen", brand_name(app));
    let open = MenuItem::with_id(app, "open", &open_label, true, None::<&str>)?;
    let clara = MenuItem::with_id(app, "clara", "Clara fragen", true, Some(CLARA_HOTKEY))?;
    // Fullscreen entry removed: see BRIDGE_JS — resize = crash.
    let device = CheckMenuItem::with_id(
        app, "device", "Gerätesteuerung erlauben", true, device_control_allowed(app), None::<&str>,
    )?;
    let quit = MenuItem::with_id(app, "quit", "Beenden", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &clara, &device, &quit])?;
    app.manage(DeviceToggle(device.clone()));
    TrayIconBuilder::with_id("main")
        .icon(app.default_window_icon().unwrap().clone())
        .tooltip(&app.package_info().name)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open" => focus_main_window(app),
            "clara" => show_clara(app),
            "fullscreen" => handle_companion_action(app, "toggle-fullscreen"),
            // The check item toggles itself on click; persist what it now shows.
            "device" => {
                let on = app
                    .try_state::<DeviceToggle>()
                    .and_then(|t| t.0.is_checked().ok())
                    .unwrap_or(false);
                set_device_control(app, on);
            }
            // Quit means really quit: windows close, the sidecar stdin closes
            // → clarad shuts the tunnel down cleanly.
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                focus_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Registers the global hotkey. On Wayland this fails (the compositor owns
/// hotkeys) — not an error case; that's what `--show-clara` is for.
fn register_hotkey(app: &AppHandle) {
    use tauri_plugin_global_shortcut::{Builder as ShortcutBuilder, ShortcutState};
    let handle = app.clone();
    let plugin = ShortcutBuilder::new()
        .with_handler(move |_app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                show_clara(&handle);
            }
        })
        .build();
    if let Err(e) = app.plugin(plugin) {
        log_line(app, &format!("global-shortcut-Plugin nicht geladen: {e}"));
        return;
    }
    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    if let Err(e) = app.global_shortcut().register(CLARA_HOTKEY) {
        // Wayland/hotkey taken: just log it, the app keeps running normally.
        log_line(app, &format!("Clara-Hotkey {CLARA_HOTKEY} nicht registriert: {e}"));
    }
}

/// Update check at startup and every 6 h after that — fail-silent like on Android
/// (`SelfUpdateManager`): an unreachable manifest must never get in the way.
fn schedule_update_checks(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // Wait briefly so startup doesn't compete for the network.
        tokio::time::sleep(std::time::Duration::from_secs(20)).await;
        // Clean up leftovers of previous updates BEFORE the next one creates
        // more. Runs on its own thread because it walks directories of hundreds
        // of MB and must not hold up the update schedule.
        tauri::async_runtime::spawn_blocking(raeume_update_reste_auf);
        loop {
            check_for_update(&app).await;
            tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
        }
    });
}

/// The AppImage self-update replaces the running file via rename — which only
/// works within the same mount point. On most Linux systems `/tmp` is a tmpfs,
/// i.e. a different mount than `~/Applications` or similar; the update then
/// aborts with "temp directory is not on the same mount point" (reproduced).
/// Therefore put TMPDIR next to the AppImage.
///
/// IMPORTANT: **call ONLY from main(), never from a thread.** `setenv()` is not
/// thread-safe in glibc (which is why Rust marks `set_var` as `unsafe` since
/// 1.80). Previously this ran in the update worker **20 s after startup** — at a
/// time when dozens of WebKit threads use `getenv`/`tzset`. Result: memory
/// corruption and an abort at a random place. That matches the measured crashes
/// after 29/30/48 s **without any user interaction**.
#[cfg(target_os = "linux")]
fn align_tmpdir_with_appimage() {
    let Ok(appimage) = std::env::var("APPIMAGE") else { return };
    let Some(dir) = std::path::Path::new(&appimage).parent() else { return };
    let tmp = dir.join(".claraos-update-tmp");
    if std::fs::create_dir_all(&tmp).is_ok() {
        std::env::set_var("TMPDIR", &tmp);
    }
}

#[cfg(not(target_os = "linux"))]
fn align_tmpdir_with_appimage() {}

// ── Safeguard updates and clean up leftovers ────────────────────────────────

/// Backup of the running AppImage as a **hard link**.
///
/// Note — why not copy: copying 205 MB takes time and space. A hard link points
/// to the same inode; when the plugin moves the file aside and writes a new one
/// in its place, our link keeps the old version alive — for free.
#[cfg(target_os = "linux")]
fn sicherung_anlegen() -> Option<std::path::PathBuf> {
    let appimage = std::env::var("APPIMAGE").ok()?;
    let pfad = std::path::Path::new(&appimage);
    let ziel = pfad.with_extension("vorherige-fassung");
    let _ = std::fs::remove_file(&ziel);
    match std::fs::hard_link(pfad, &ziel) {
        Ok(()) => Some(ziel),
        Err(e) => {
            log_line_static(&format!("Sicherung nicht anlegbar: {e}"));
            None
        }
    }
}

#[cfg(target_os = "linux")]
fn sicherung_verwerfen(sicherung: Option<std::path::PathBuf>) {
    if let Some(s) = sicherung {
        let _ = std::fs::remove_file(s);
    }
}

#[cfg(target_os = "linux")]
fn sicherung_zurueckspielen(
    sicherung: Option<std::path::PathBuf>,
    ziel: &std::path::Path,
) -> std::io::Result<()> {
    let s = sicherung.ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "keine Sicherung vorhanden")
    })?;
    std::fs::remove_file(ziel)?;
    std::fs::rename(&s, ziel)?;
    auf_platte_zwingen(ziel)
}

/// Forces the file to really be on disk.
///
/// IMPORTANT: without this, `write` already reports success while the data is
/// only in the page cache — exactly how the all-zero file came about.
#[cfg(target_os = "linux")]
fn auf_platte_zwingen(pfad: &std::path::Path) -> std::io::Result<()> {
    std::fs::File::open(pfad)?.sync_all()
}

/// Is this an AppImage that can be started at all?
///
/// Checks the ELF magic at the start of the file — exactly what was missing in
/// the failure case (the file started with nothing but zeros) — and a plausible size.
#[cfg(target_os = "linux")]
fn ist_brauchbares_appimage(pfad: &std::path::Path) -> bool {
    use std::io::Read;
    let Ok(md) = std::fs::metadata(pfad) else { return false };
    if md.len() < 10 * 1024 * 1024 {
        return false;
    }
    let Ok(mut f) = std::fs::File::open(pfad) else { return false };
    let mut kopf = [0u8; 4];
    if f.read_exact(&mut kopf).is_err() {
        return false;
    }
    kopf == [0x7f, b'E', b'L', b'F']
}

/// Cleans up what updates leave behind. Runs in the background at startup.
///
/// IMPORTANT: one laptop had **7.7 GB** in 20 `appimage_extracted_*` folders —
/// one per update, never cleaned up. They appear because the restart after an
/// update uses `--appimage-extract-and-run` and we put `TMPDIR` next to the
/// AppImage (needed for the update, see above). On Windows it's smaller but just
/// as permanent: one folder per update,
/// `%TEMP%\ClaraOS Companion-<version>-updater-…`, holding the ~18 MB
/// installer (measured on one device: 8 of them, 122 MB).
///
/// Note: the folder the running instance is executing from is **never** deleted
/// (compared against `current_exe`), nor is anything from the last hour —
/// a parallel update must not get in our way.
fn raeume_update_reste_auf() {
    let jetzt = std::time::SystemTime::now();
    let eigener_pfad = std::env::current_exe().unwrap_or_default();

    let mut kandidaten: Vec<std::path::PathBuf> = Vec::new();
    let mut orte: Vec<std::path::PathBuf> = vec![std::env::temp_dir()];
    if let Ok(appimage) = std::env::var("APPIMAGE") {
        if let Some(dir) = std::path::Path::new(&appimage).parent() {
            orte.push(dir.join(".claraos-update-tmp"));
        }
    }
    orte.sort();
    orte.dedup();

    for ort in orte {
        let Ok(eintraege) = std::fs::read_dir(&ort) else { continue };
        for e in eintraege.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !ist_update_rest(&name) {
                continue;
            }
            let pfad = e.path();
            if eigener_pfad.starts_with(&pfad) {
                continue; // the current instance runs from here
            }
            if let Ok(md) = e.metadata() {
                if let Ok(alter) = md.modified().and_then(|m| jetzt.duration_since(m).map_err(|_| {
                    std::io::Error::new(std::io::ErrorKind::Other, "Zeit")
                })) {
                    if alter.as_secs() < 3600 {
                        continue; // fresh — could be an update in progress
                    }
                }
            }
            kandidaten.push(pfad);
        }
    }

    let mut befreit: u64 = 0;
    let anzahl = kandidaten.len();
    for k in kandidaten {
        befreit += groesse_von(&k);
        let _ = if k.is_dir() {
            std::fs::remove_dir_all(&k)
        } else {
            std::fs::remove_file(&k)
        };
    }
    if anzahl > 0 {
        log_line_static(&format!(
            "Update-Reste aufgeräumt: {anzahl} Einträge, {} MB frei",
            befreit / (1024 * 1024)
        ));
    }
}

/// Is this directory/file name a leftover from an update?
///
/// Deliberately narrow: only the three patterns we create ourselves. Everything
/// else in the TEMP directory belongs to other programs and is not touched.
fn ist_update_rest(name: &str) -> bool {
    name.starts_with("appimage_extracted_")            // our restart after the update
        || name.starts_with("tauri_current_app")        // the update plugin's backup
        || (name.contains(" Companion-") && name.contains("-updater-")) // Windows: "<productName>-<version>-updater-…"
}

fn groesse_von(p: &std::path::Path) -> u64 {
    let Ok(md) = std::fs::metadata(p) else { return 0 };
    if md.is_file() {
        return md.len();
    }
    let Ok(eintraege) = std::fs::read_dir(p) else { return 0 };
    eintraege.flatten().map(|e| groesse_von(&e.path())).sum()
}

async fn check_for_update(app: &AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    // TMPDIR is set in main() — NOT here any more (thread safety, see above).
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => {
            log_line(app, &format!("Updater nicht verfügbar: {e}"));
            return;
        }
    };
    match updater.check().await {
        Ok(Some(update)) => {
            log_line(app, &format!("Update {} verfügbar — lade …", update.version));
            let _ = tauri::Emitter::emit(app, "update-available", update.version.clone());
            // The plugin does the signature check itself (minisign); if it
            // fails, nothing is installed.
            //
            // IMPORTANT — the incident the following block prevents: after the update
            // to 0.5.12 a laptop had an AppImage with **the right length but made
            // entirely of zeros** (first 20 MB `\0`, `file` only said `data`).
            // The app had exited to restart and could not come back — ClaraOS was
            // dead until a human replaced the file by hand.
            //
            // Note: the bytes were demonstrably fine: the plugin verifies the
            // minisign signature over the **complete** buffer before writing
            // (updater.rs). It broke only while writing — `std::fs::write` reports
            // success as soon as the data is in the page cache, and **nobody calls
            // fsync**. The machine rebooted 47 seconds later, before 205 MB had
            // reached the disk. ext4 is notorious for exactly this.
            //
            // IMPORTANT: and there was nothing to fall back to: the backup the plugin
            // creates lives in a `tempfile::TempDir` and is **deleted** when the
            // function returns (updater.rs).
            //
            // Hence here: our own backup as a **hard link** (costs neither space nor
            // time — it points to the same inode the plugin is about to move aside),
            // then a forced write to disk and a check that a program actually came
            // out. Only then do we exit.
            #[cfg(target_os = "linux")]
            let sicherung = sicherung_anlegen();

            if let Err(e) = update.download_and_install(|_, _| {}, || {}).await {
                log_line(app, &format!("Update fehlgeschlagen: {e}"));
                #[cfg(target_os = "linux")]
                sicherung_verwerfen(sicherung);
                return;
            }

            #[cfg(target_os = "linux")]
            if let Ok(appimage) = std::env::var("APPIMAGE") {
                let pfad = std::path::PathBuf::from(&appimage);
                // Force to disk first, THEN check — otherwise we check the page
                // cache and confirm a file that doesn't exist yet.
                if let Err(e) = auf_platte_zwingen(&pfad) {
                    log_line(app, &format!("Update: fsync fehlgeschlagen: {e}"));
                }
                if !ist_brauchbares_appimage(&pfad) {
                    log_line(app, "🔴 Update ergab KEIN lauffähiges Programm — stelle die alte Fassung wieder her");
                    match sicherung_zurueckspielen(sicherung, &pfad) {
                        Ok(()) => log_line(app, "alte Fassung wiederhergestellt — kein Neustart"),
                        Err(e) => log_line(app, &format!("🔴 Wiederherstellung fehlgeschlagen: {e}")),
                    }
                    // Do NOT exit: better keep running on the old version than leave
                    // behind a device that can no longer start anything.
                    return;
                }
                sicherung_verwerfen(sicherung);
            }

            log_line(app, "Update installiert — Neustart");
            // AppImage: restart ourselves instead of app.restart() — the built-in
            // relaunch runs $APPIMAGE WITHOUT --appimage-extract-and-run and dies
            // silently on systems without libfuse2 (observed: update OK, app then
            // simply gone). sleep 2 lets the old instance release the
            // single-instance lock before the new one checks it.
            #[cfg(target_os = "linux")]
            if let Ok(appimage) = std::env::var("APPIMAGE") {
                let _ = std::process::Command::new("sh")
                    .arg("-c")
                    .arg("sleep 2; exec \"$CLARAOS_APPIMAGE\" --appimage-extract-and-run")
                    .env("CLARAOS_APPIMAGE", &appimage)
                    .spawn();
                app.exit(0);
                return;
            }
            app.restart();
        }
        Ok(None) => log_line(app, "kein Update"),
        Err(e) => log_line(app, &format!("Update-Prüfung fehlgeschlagen: {e}")),
    }
}

fn main() {
    // WebKitGTK under Wayland+NVIDIA is the source of repeated SIGABRTs in the
    // middle of JS dispatch (4 core dumps with identical signature) — even with
    // the DMA-BUF renderer disabled, which only made the app sluggish without
    // protecting it (a crash happened WITH the flag). Established stable path:
    // run under XWayland (X11 backend) — fully hardware-accelerated. Bonus:
    // the global hotkey works again under X11. A user-set value wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    // IMPORTANT — ROOT CAUSE of the crashes: JavaScriptCore's top JIT tier (FTL)
    // reproducibly makes WebKitGTK abort on affected systems — the app died
    // **without any user interaction** after 29/30/48 s once the shell had loaded;
    // stack always identical in libjavascriptcoregtk.
    // Measured: FTL off ⇒ stable for >3 min (JIT fully off too, but slower).
    // Baseline and DFG JIT stay active, the speed loss is small.
    // Escape hatch if it ever happens again: set JSC_useJIT=0 externally —
    // user settings win because we only set the variable when it's absent.
    #[cfg(target_os = "linux")]
    if std::env::var_os("JSC_useFTLJIT").is_none() && std::env::var_os("JSC_useJIT").is_none() {
        std::env::set_var("JSC_useFTLJIT", "0");
    }
    // TMPDIR for the AppImage self-update — here, while the app is still
    // single-threaded (previously in the update worker: see the warning there).
    align_tmpdir_with_appimage();
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // Second launch: window to the front — and if a deep link came along
            // (Windows/Linux pass it as an argument), take over the token.
            // `--show-clara` is the Wayland replacement for the global hotkey: the
            // desktop shortcut simply launches the app again with this flag.
            if argv.iter().any(|a| a == "--show-clara") {
                show_clara(app);
                return;
            }
            if let Some(action) = companion_action_from_args(argv.iter().cloned()) {
                handle_companion_action(app, &action);
                return;
            }
            match link_from_args(argv, &link_scheme(app)) {
                Some(l) => deliver_link(app, l),
                None => focus_main_window(app),
            }
        }))
        .manage(DaemonState {
            child: Mutex::new(None),
            conn: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            daemon_status,
            daemon_provision,
            daemon_connect,
            app_brand,
            open_shell,
            set_autostart,
            autostart_enabled,
            sync_config,
            set_sync_config,
            answer_consent,
            companion_shutdown,
            companion_toggle_fullscreen,
            device_state,
            device_set,
            device_get,
            device_connect
        ])
        .on_window_event(|window, event| {
            // The window X does NOT close the app (tunnel + push should keep running)
            // — EVERY window goes to the tray. Previously this only applied to
            // "shell": the onboarding X, as the last window, ended the whole app
            // including the tunnel. Quitting goes through the tray menu or the
            // shell's start menu.
            if let WindowEvent::Destroyed = event {
                log_line_static(&format!("Fenster '{}' zerstört", window.label()));
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                log_line_static(&format!("Fenster '{}' CloseRequested → Tray", window.label()));
                api.prevent_close();
                // Unmapping a fullscreen window made WebKitGTK abort; since 0.3.8
                // the shell runs borderless-maximised instead of real fullscreen —
                // the safeguard stays for old installs.
                if window.is_fullscreen().unwrap_or(false) {
                    let _ = window.set_fullscreen(false);
                }
                let _ = window.hide();
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();
            // Log file first: everything after this can be read back on failure
            // (on Windows the ONLY trace, see LOG_PATH).
            if let Ok(dir) = handle.path().app_local_data_dir() {
                let _ = create_private_dir(&dir);
                let _ = LOG_PATH.set(dir.join("companion.log"));
            }
            log_line_static(&format!("Start {VERSION}"));
            build_tray(&handle)?;
            #[cfg(target_os = "linux")]
            hint_missing_fuse_once(&handle);
            spawn_daemon(&handle)?;
            subscribe_events(&handle);
            register_hotkey(&handle);
            schedule_update_checks(&handle);
            // Deep link on cold start (the app wasn't open yet).
            if let Some(l) = link_from_args(std::env::args(), &link_scheme(&handle)) {
                let h = handle.clone();
                tauri::async_runtime::spawn(async move {
                    // wait briefly until the WebView has registered its listener
                    tokio::time::sleep(std::time::Duration::from_millis(1200)).await;
                    deliver_link(&h, l);
                });
            }
            // Linux/AppImage: register the scheme handler at runtime (on
            // Windows the NSIS installer does this).
            #[cfg(target_os = "linux")]
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let _ = app.deep_link().register(link_scheme(&handle));
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri build")
        // IMPORTANT: do NOT exit the app when no window is open any more.
        // Otherwise Tauri ends the process as soon as the last window is
        // DESTROYED — the CloseRequested handler above only catches the
        // window X. But `open_shell` deliberately destroys the onboarding
        // window; if the shell window disappears afterwards (e.g. WebView
        // death), no window is left and the app ended CLEANLY and invisibly —
        // reproduced on Windows: clarad starts, tunnel up, ntfy connected,
        // then after ~40 s everything is gone, without a crash report.
        // With a tray icon "no window" is a normal state: quitting happens
        // only via the tray menu/start menu (app.exit(0)).
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none() {
                    // code == None ⇒ "last window closed", not app.exit(…)
                    api.prevent_exit();
                    log_line_static("ExitRequested ohne Code — App bleibt im Tray");
                    let _ = app;
                }
            }
        });
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_site_and_origin() {
        *PAIRED_SHELL.lock().unwrap() = Some("https://home.example.org/".parse().unwrap());
        let u = |s: &str| s.parse::<tauri::Url>().unwrap();
        assert!(is_shell_origin(&u("https://home.example.org/x?y=1")));
        assert!(!is_shell_origin(&u("https://auth.example.org/")));
        assert!(is_shell_site(&u("https://auth.example.org/flow")));
        assert!(is_shell_site(&u("https://example.org/")));
        assert!(!is_shell_site(&u("http://home.example.org/")));
        assert!(!is_shell_site(&u("https://evilexample.org/")));
        assert!(!is_shell_site(&u("https://example.org.evil.tld/")));
        assert_eq!(origin_of(&u("https://h.example.org:8443/a")), "https://h.example.org:8443");
    }

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn pairing_links() {
        assert_eq!(
            link_from_args(args(&["app", "nolani://provision?token=abc/"]), "nolani"),
            Some(Link::Token("abc".into()))
        );
        assert_eq!(
            link_from_args(args(&["nolani://connect?server=https%3A%2F%2Fexample.org"]), "nolani"),
            Some(Link::Server("https://example.org".into()))
        );
        assert_eq!(
            link_from_args(args(&["nolani://connect/?x=1&server=example.org"]), "nolani"),
            Some(Link::Server("example.org".into()))
        );
        // other scheme, unknown target, empty value, action navigation: no link
        assert_eq!(link_from_args(args(&["claraos://provision?token=abc"]), "nolani"), None);
        assert_eq!(link_from_args(args(&["nolani://other?token=abc"]), "nolani"), None);
        assert_eq!(link_from_args(args(&["nolani://connect?server="]), "nolani"), None);
        assert_eq!(link_from_args(args(&["nolani://companion/shutdown"]), "nolani"), None);
    }

    #[test]
    fn percent_decoding() {
        assert_eq!(percent_decode("a%2Fb"), "a/b");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("%aä"), "%aä");
    }

    /// Exactly this file was found on a laptop — right length, only zeros.
    /// Had the check let it through, the device would have been dead again.
    #[cfg(target_os = "linux")]
    #[test]
    fn null_datei_wird_nicht_fuer_brauchbar_gehalten() {
        let dir = std::env::temp_dir().join(format!("clara-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("null.AppImage");
        std::fs::write(&p, vec![0u8; 12 * 1024 * 1024]).unwrap();
        assert!(!ist_brauchbares_appimage(&p), "Null-Datei muss abgelehnt werden");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn echte_elf_datei_wird_akzeptiert_zu_kleine_nicht() {
        let dir = std::env::temp_dir().join(format!("clara-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        let gross = dir.join("gut.AppImage");
        let mut inhalt = vec![0u8; 12 * 1024 * 1024];
        inhalt[0..4].copy_from_slice(&[0x7f, b'E', b'L', b'F']);
        std::fs::write(&gross, &inhalt).unwrap();
        assert!(ist_brauchbares_appimage(&gross), "gültige ELF muss durchgehen");

        // Right magic, but far too small — e.g. an aborted transfer.
        let klein = dir.join("kurz.AppImage");
        std::fs::write(&klein, &[0x7f, b'E', b'L', b'F', 0, 0, 0, 0]).unwrap();
        assert!(!ist_brauchbares_appimage(&klein), "Bruchstück muss abgelehnt werden");

        assert!(!ist_brauchbares_appimage(&dir.join("gibtsnicht")), "fehlende Datei = nicht brauchbar");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Cleanup may ONLY hit our own leftovers. A pattern that is too broad
    /// would damage other programs in the TEMP directory.
    #[test]
    fn erkennt_eigene_reste_und_laesst_fremdes_in_ruhe() {
        assert!(ist_update_rest("appimage_extracted_2156f995a3c98303"));
        assert!(ist_update_rest("tauri_current_appXYZ"));
        assert!(ist_update_rest("ClaraOS Companion-0.5.12-updater-IaMxum"));
        assert!(ist_update_rest("Nolani Companion-0.6.0-updater-Ab12Cd"));

        assert!(!ist_update_rest("ClaraOS-Companion_0.5.12_x64-setup.exe")); // manual install
        assert!(!ist_update_rest("systemd-private-abc"));
        assert!(!ist_update_rest("snap.firefox"));
        assert!(!ist_update_rest(".X11-unix"));
        assert!(!ist_update_rest("appimage"));
    }
}
