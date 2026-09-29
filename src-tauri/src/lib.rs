//! egant — a native desktop workspace for coding agents (Tauri edition).
//!
//! The window is a web frontend with two columns: a sidebar listing the
//! conversations on this machine, and a stage carrying the active one — its
//! header, its transcript, and the composer that drives it — over a wallpaper.
//! The agent lives behind `egant-harness`, git behind `egant-vcs`; this crate
//! is only presentation state and wiring.
//!
//! A session can run in the project folder or in an isolated checkout of it —
//! see [`worktrees`] for which, and for what becomes of the checkout when the
//! conversation is closed.

mod browser;
mod commands;
mod dto;
mod files;
mod github;
mod mobile;
mod notifications;
mod persist;
mod project;
mod pty;
mod service;
mod sessions;
mod settings;
mod state;
mod sync;
mod worktrees;

use state::AppState;
use std::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    log::info!("egant starting (set RUST_LOG=debug for protocol details)");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Mutex::new(AppState::new()))
        // Terminals live beside the window state rather than inside it: the
        // reader thread behind every terminal tab must never wait on the lock
        // the whole UI takes to render a snapshot.
        .manage(Mutex::new(pty::Terminals::default()))
        // The numbered stream every client follows (see `sync`), and phone
        // access (see `mobile`). Managed up front so no command can arrive
        // before them; `setup` hands them the app once it exists.
        .manage(sync::SyncHub::new())
        .manage(mobile::MobileService::load())
        .invoke_handler(commands::handlers())
        .setup(|app| {
            {
                use tauri::Manager;
                app.state::<sync::SyncHub>().attach(app.handle().clone());
                mobile::init(app.handle());
            }

            // Warm the login-shell environment snapshot off the main thread.
            // Opening an agent's CLI needs it, and capturing it costs a shell
            // that sources the user's rc files — a second or more on a busy
            // profile. Paid here, at launch, it is already cached by the time
            // anyone clicks "Start"; paid on demand it would be a visible
            // stall between the dialog and the terminal.
            std::thread::spawn(|| {
                let _ = egant_harness::agents::login_shell_env();
            });

            // The window opens transparent (see `tauri.conf.json`); on macOS this
            // paints a real frosted-glass blur of whatever is behind it, which is
            // what makes the transparent stage read as glass instead of a hole.
            // The frontend can turn it back off (Appearance > Glass > Opaque) via
            // `sync_window_appearance`, which starts from this same state.
            #[cfg(target_os = "macos")]
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
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
