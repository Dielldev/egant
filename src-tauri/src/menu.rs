//! The native menu bar.
//!
//! Tauri's stock menu has the standard Edit/Window items and nothing of
//! egant's. This replaces it with the set a Mac app is expected to have: the
//! app menu (About, updates, Settings, Services, Hide, Quit), File, Edit, View,
//! a Conversation menu, Window, and Help. The items that are egant's own carry
//! an id and are forwarded to the frontend as a `menu-action` event — the
//! window state they act on lives there, not here. Help's links are the one
//! exception: they open in the browser from here.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// The event the frontend listens for; its payload is the menu item's id.
pub const MENU_ACTION_EVENT: &str = "menu-action";

const REPO: &str = "https://github.com/Dielldev/egant";

/// Help's links: menu id → page. Fixed here rather than taken from the event,
/// so nothing a page or a file says can make this open anything else.
fn link(id: &str) -> Option<String> {
    match id {
        "link:releases" => Some(format!("{REPO}/releases/latest")),
        "link:github" => Some(REPO.to_string()),
        "link:issues" => Some(format!("{REPO}/issues/new")),
        _ => None,
    }
}

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, text);
        match accelerator {
            Some(keys) => builder.accelerator(keys).build(app),
            None => builder.build(app),
        }
    };

    let settings = item("settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let check_updates = item("check-updates", "Check for Updates…", None)?;

    let new_conversation = item("new-conversation", "New Conversation", Some("CmdOrCtrl+N"))?;
    let open_folder = item("open-folder", "Open Folder…", Some("CmdOrCtrl+O"))?;
    let search = item("search", "Search…", Some("CmdOrCtrl+P"))?;

    let toggle_sidebar = item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?;
    let toggle_panel = item(
        "toggle-panel",
        "Toggle Workspace Panel",
        Some("CmdOrCtrl+J"),
    )?;
    let maximize_panel = item(
        "toggle-panel-maximized",
        "Fill Window with Workspace Panel",
        Some("CmdOrCtrl+Shift+J"),
    )?;
    let library = item("library", "Library", Some("CmdOrCtrl+Shift+L"))?;
    let filter = item("filter", "Filter Conversations", Some("CmdOrCtrl+K"))?;
    let focus_composer = item("focus-composer", "Focus Message Box", Some("CmdOrCtrl+L"))?;
    let zoom_in = item("zoom-in", "Zoom In", Some("CmdOrCtrl+="))?;
    let zoom_out = item("zoom-out", "Zoom Out", Some("CmdOrCtrl+-"))?;
    let zoom_reset = item("zoom-reset", "Actual Size", Some("CmdOrCtrl+0"))?;

    let previous = item("previous-conversation", "Previous Conversation", None)?;
    let next = item("next-conversation", "Next Conversation", None)?;
    let stop = item("interrupt", "Stop Generating", Some("CmdOrCtrl+Escape"))?;
    let archive = item("archive-conversation", "Archive Conversation", None)?;

    let shortcuts = item("shortcuts", "Keyboard Shortcuts", None)?;
    let release_notes = item("link:releases", "Release Notes", None)?;
    let github = item("link:github", "egant on GitHub", None)?;
    let report = item("link:issues", "Report an Issue…", None)?;

    // Only macOS keeps a menu named for the app; there Settings lives in it.
    // Elsewhere the first menu is File, and Settings goes at its foot.
    let mut file = SubmenuBuilder::new(app, "File")
        .item(&new_conversation)
        .item(&open_folder)
        .separator()
        .item(&search)
        .separator()
        .close_window();
    if !cfg!(target_os = "macos") {
        file = file.separator().item(&settings).quit();
    }
    let file = file.build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&toggle_sidebar)
        .item(&toggle_panel)
        .item(&maximize_panel)
        .item(&library)
        .separator()
        .item(&filter)
        .item(&focus_composer)
        .separator()
        .item(&zoom_in)
        .item(&zoom_out)
        .item(&zoom_reset)
        .separator()
        .fullscreen()
        .build()?;

    let conversation = SubmenuBuilder::new(app, "Conversation")
        .item(&previous)
        .item(&next)
        .separator()
        .item(&stop)
        .item(&archive)
        .build()?;

    let mut window = SubmenuBuilder::new(app, "Window").minimize().maximize();
    if cfg!(target_os = "macos") {
        window = window.separator().bring_all_to_front();
    }
    let window = window.build()?;

    let mut help = SubmenuBuilder::new(app, "Help").item(&shortcuts);
    // macOS keeps this in the app menu; elsewhere Help is where it lives.
    if !cfg!(target_os = "macos") {
        help = help.item(&check_updates);
    }
    let help = help
        .separator()
        .item(&release_notes)
        .item(&github)
        .item(&report)
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let name = app.package_info().name.clone();
        let app_menu = SubmenuBuilder::new(app, name)
            .about(None)
            .item(&check_updates)
            .separator()
            .item(&settings)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        menu = menu.item(&app_menu);
    }
    menu.items(&[&file, &edit, &view, &conversation, &window, &help])
        .build()
}

/// Hands a click on one of egant's own items to the frontend, or opens one of
/// Help's links.
pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    if let Some(url) = link(id) {
        open_in_browser(&url);
        return;
    }
    // The predefined items (copy, quit, …) are handled natively and never
    // reach here with an id of ours; anything unknown is simply passed on and
    // ignored by the frontend.
    let _ = app.emit(MENU_ACTION_EVENT, id);
}

/// Opens a page in the default browser. Only ever called with the fixed URLs
/// from [`link`].
fn open_in_browser(url: &str) {
    #[cfg(target_os = "macos")]
    let command = std::process::Command::new("open").arg(url).spawn();
    #[cfg(target_os = "windows")]
    let command = std::process::Command::new("cmd")
        .args(["/c", "start", "", url])
        .spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let command = std::process::Command::new("xdg-open").arg(url).spawn();

    if let Err(error) = command {
        log::warn!("couldn't open {url}: {error}");
    }
}
