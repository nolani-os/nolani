fn main() {
    // Build-variant default of device control (main.rs: device_control_default).
    println!("cargo:rerun-if-env-changed=COMPANION_DEVICE_CONTROL");
    // IMPORTANT: app commands MUST be declared here, otherwise tauri-build
    // generates no ACL permissions for them — and the shell (a remote origin,
    // capability shell-remote) gets "Command … not allowed by ACL" at runtime.
    // This is exactly why companion_shutdown silently fell back to the
    // claraos:// URL for a long time. The identifiers are then named
    // `allow-<command-name>` and are listed in capabilities/shell-remote.json.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "daemon_status",
            "daemon_provision",
            "daemon_connect",
            "app_brand",
            "open_shell",
            "set_autostart",
            "autostart_enabled",
            "sync_config",
            "set_sync_config",
            "answer_consent",
            "companion_shutdown",
            "companion_toggle_fullscreen",
            "device_state",
            "device_set",
            "device_get",
            "device_connect",
        ]),
    ))
    .expect("tauri_build");
}
