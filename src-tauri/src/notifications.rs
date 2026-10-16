//! The platform-specific pieces of notifications: taking the user to the
//! system page where egant is allowed to post them, and sounding a cue that
//! does not depend on the webview being awake.
//!
//! The banner itself goes through `tauri-plugin-notification`, which on desktop
//! can neither ask for permission nor read it back — it reports "granted"
//! whatever the OS thinks, and hands the banner over. So when one doesn't
//! appear, the user's only recourse is the operating system's own settings,
//! and this is the button that opens them.

use std::process::Command;

/// Opens the operating system's notification settings.
///
/// `async` + `spawn_blocking`: launching the settings app waits on the OS, and
/// a command that shells out must never sit on the thread the UI runs on.
#[tauri::command]
pub async fn open_notification_settings() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(open_settings)
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn open_settings() -> Result<(), String> {
    // Ventura's System Settings renamed the pane; an older macOS only knows
    // the legacy id.
    for url in [
        "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        "x-apple.systempreferences:com.apple.preference.notifications",
    ] {
        if Command::new("open")
            .arg(url)
            .status()
            .is_ok_and(|status| status.success())
        {
            return Ok(());
        }
    }
    Err("could not open System Settings".into())
}

#[cfg(target_os = "windows")]
fn open_settings() -> Result<(), String> {
    // `explorer` exits non-zero even when it works, so only a failure to
    // start it counts as one.
    Command::new("explorer")
        .arg("ms-settings:notifications")
        .spawn()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
fn open_settings() -> Result<(), String> {
    // There is no one settings app on Linux: try the two big desktops'.
    for (program, args) in [
        ("gnome-control-center", ["notifications"]),
        ("systemsettings", ["kcm_notifications"]),
    ] {
        if Command::new(program).args(args).spawn().is_ok() {
            return Ok(());
        }
    }
    Err("no notification settings app found — open your desktop's system settings".into())
}

/// Plays the system sound for a notification `kind` (`completed`, `input` or
/// `errors`), outside the webview.
///
/// The themed cues are synthesized in Web Audio, and WKWebView suspends an
/// audio context while its window is hidden, minimized or fully covered —
/// exactly when the user is away and a cue matters — then refuses to restart
/// it without a click. This path has no such dependency. Only macOS has it;
/// elsewhere it reports an error and the caller keeps the Web Audio cue.
///
/// `async` + `spawn_blocking`: waiting on the player must not sit on the UI thread.
#[tauri::command]
pub async fn play_system_sound(kind: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || play_sound(&kind))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn play_sound(kind: &str) -> Result<(), String> {
    let name = match kind {
        "completed" => "Glass",
        "input" => "Ping",
        "errors" => "Basso",
        other => return Err(format!("unknown notification kind: {other}")),
    };
    let status = Command::new("afplay")
        .arg(format!("/System/Library/Sounds/{name}.aiff"))
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("afplay exited with {status}"))
    }
}

#[cfg(not(target_os = "macos"))]
fn play_sound(_kind: &str) -> Result<(), String> {
    Err("native notification sounds are only available on macOS".into())
}
