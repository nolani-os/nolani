//! Nolani Knowledge, native shell: database plugin, downloads, local API.
//! A library so the same code runs as the desktop binary (main.rs) and as
//! the Android app (mobile entry point).

mod api;

use std::path::PathBuf;
use tauri::Manager;

/// Saves a file the user asked for (export archive, attachment) into the
/// Downloads folder and returns its path. The webview cannot download blobs
/// on every platform, so the native side writes the file.
///
/// The name comes from the web side and is reduced to a plain file name, so
/// it can never point outside the Downloads folder. An existing file is never
/// overwritten: "name (2).zip", "name (3).zip", …
#[tauri::command]
fn save_download(app: tauri::AppHandle, name: String, data: Vec<u8>) -> Result<String, String> {
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let clean: String = name
        .chars()
        .map(|c| if c == '/' || c == '\\' || c.is_control() || c == ':' { '_' } else { c })
        .collect();
    let clean = clean.trim().trim_start_matches('.').to_string();
    let clean = if clean.is_empty() { "download".to_string() } else { clean };
    let (stem, ext) = match clean.rfind('.') {
        Some(i) if i > 0 => (clean[..i].to_string(), clean[i..].to_string()),
        _ => (clean.clone(), String::new()),
    };
    let mut target: PathBuf = dir.join(&clean);
    let mut n = 2;
    while target.exists() {
        target = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::write(&target, data).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

/// The app window only ever shows its own bundled page. Any navigation
/// elsewhere (a link in page text, a script) opens in the system browser
/// instead of replacing the app: on Android a tapped link in the editor
/// otherwise navigated the app window to the foreign page.
fn stay_in_app<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    use tauri_plugin_opener::OpenerExt;
    tauri::plugin::Builder::new("stay-in-app")
        .on_navigation(|webview, url| {
            let own_host = matches!(url.host_str(), Some("tauri.localhost") | Some("ipc.localhost"));
            let own = match url.scheme() {
                "tauri" | "asset" | "ipc" | "about" | "blob" | "data" => true,
                "http" | "https" => own_host || (cfg!(debug_assertions) && url.host_str() == Some("localhost")),
                _ => false,
            };
            if !own && matches!(url.scheme(), "http" | "https" | "mailto" | "tel") {
                let _ = webview.app_handle().opener().open_url(url.as_str(), None::<&str>);
            }
            own
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // The database file lives in the app's data directory; the web side
        // opens it as "sqlite:knowledge.db" and runs its own migrations.
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(stay_in_app())
        .manage(api::ApiState::default())
        .invoke_handler(tauri::generate_handler![
            save_download,
            api::api_start,
            api::api_stop,
            api::api_status,
            api::api_respond
        ])
        .run(tauri::generate_context!())
        .expect("error while running Nolani Knowledge");
}
