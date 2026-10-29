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

mod activity;
mod browser;
mod commands;
mod dto;
mod files;
mod github;
mod library;
mod menu;
mod mobile;
mod notifications;
mod persist;
mod project;
mod pty;
mod revert;
mod search;
mod service;
mod sessions;
mod settings;
mod state;
mod sync;
mod worktrees;

use state::AppState;
use std::sync::Mutex;

/// A panic on the main thread aborts the app (it unwinds into AppKit's
/// event hook, which cannot unwind), and a launched `.app` has no terminal to
/// print the message to — so the crash report only says "abort". Keep the
/// message, place and backtrace in `crash.log` beside the saved sessions.
fn keep_panic_reports() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(dir) = settings::config_dir() {
            use std::io::Write;
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or_default();
            let thread = std::thread::current();
            let backtrace = std::backtrace::Backtrace::force_capture();
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                let _ = writeln!(
                    file,
                    "[{stamp}] panic on thread {:?}: {info}\n{backtrace}\n",
                    thread.name().unwrap_or("<unnamed>"),
                );
            }
        }
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "windows")]
    {
        // Prevent WebView2 from flashing white before HTML/CSS loads:
        // Sets the default background color of WebView2 to fully transparent.
        // SAFETY: Called early during main thread startup before worker threads run.
        unsafe {
            std::env::set_var("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", "0x00000000");
        }
    }

    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    log::info!("egant starting (set RUST_LOG=debug for protocol details)");
    keep_panic_reports();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
        .menu(menu::build)
        .on_menu_event(|app, event| menu::forward(app, event.id().as_ref()))
        .invoke_handler(commands::handlers())
        .setup(|app| {
            {
                use tauri::Manager;
                // Windows draws its own caption and menu bar (the window is
                // undecorated there — see `tauri.windows.conf.json`), so a
                // native HMENU would put an unthemed second menu strip above
                // it. The items themselves still reach the frontend through
                // the custom bar, which calls the same actions.
                #[cfg(target_os = "windows")]
                let _ = app.remove_menu();

                app.state::<sync::SyncHub>().attach(app.handle().clone());
                mobile::init(app.handle());

                // Sessions are saved off the state lock, by a writer that
                // takes each one's snapshot here — see `persist`.
                let handle = app.handle().clone();
                persist::start_saver(move |id| {
                    let state = handle.state::<Mutex<AppState>>();
                    let guard = state.lock().ok()?;
                    guard.session_snapshot(id, None)
                });
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

            // The window opens transparent (see the per-platform configs); on
            // macOS and Windows this paints the platform's real backdrop of
            // whatever is behind the window, which is what makes the
            // transparent stage read as glass instead of a hole. The frontend
            // can turn it back off (Appearance > Glass > Opaque) via
            // `sync_window_appearance`, which starts from this same state.
            {
                use tauri::Manager;
                if let Some(window) = app.get_webview_window("main") {
                    #[cfg(target_os = "windows")]
                    {
                        let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
                    }
                    let effect = commands::apply_window_glass(&window, true, true);
                    log::info!("window backdrop: {effect}");
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build egant")
        .run(|_app, event| {
            // What changed in the last moment before quitting is still
            // waiting for the writer: save it now, before the process goes.
            if let tauri::RunEvent::Exit = event {
                persist::flush();
            }
        });
}
