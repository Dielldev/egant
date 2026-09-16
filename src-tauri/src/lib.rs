//! egant — a native desktop workspace for coding agents (Tauri edition).
//!
//! The window is a web frontend with two columns: a sidebar listing the
//! conversations on this machine, and a stage carrying the active one — its
//! header, its transcript, and the composer that drives it — over a wallpaper.
//! The agent lives behind `egant-harness`, git behind `egant-vcs`; this crate
//! is only presentation state and wiring.

mod commands;
mod dto;
mod persist;
mod project;
mod sessions;
mod settings;
mod state;

use std::sync::Mutex;
use state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(AppState::new()))
        .invoke_handler(commands::handlers())
        .setup(|_app| {
            // The window opens transparent (see `tauri.conf.json`); on macOS this
            // paints a real frosted-glass blur of whatever is behind it, which is
            // what makes the transparent stage read as glass instead of a hole.
            // The frontend can turn it back off (Appearance > Glass > Opaque) via
            // `sync_window_appearance`, which starts from this same state.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = _app.get_webview_window("main") {
                    let _ = window_vibrancy::apply_vibrancy(
                        &window,
                        window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                        None,
                        None,
                    );
                }
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run egant");
}
