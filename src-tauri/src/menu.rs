//! The native menu bar.
//!
//! Tauri's stock menu has the standard Edit/Window items and nothing of
//! egant's: no Settings, no way to start a conversation or search from the
//! File menu, an empty Help. This replaces it. The items that are egant's own
//! carry an id and are forwarded to the frontend as a `menu-action` event —
//! the window state they act on lives there, not here.

use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Runtime};

/// The event the frontend listens for; its payload is the menu item's id.
pub const MENU_ACTION_EVENT: &str = "menu-action";

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        let builder = MenuItemBuilder::with_id(id, text);
        match accelerator {
            Some(keys) => builder.accelerator(keys).build(app),
            None => builder.build(app),
        }
    };

    let settings = item("settings", "Settings…", Some("CmdOrCtrl+,"))?;
    let new_conversation = item("new-conversation", "New Conversation", Some("CmdOrCtrl+N"))?;
    let open_folder = item("open-folder", "Open Folder…", Some("CmdOrCtrl+O"))?;
    let search = item("search", "Search…", Some("CmdOrCtrl+P"))?;
    let toggle_sidebar = item("toggle-sidebar", "Toggle Sidebar", Some("CmdOrCtrl+B"))?;
    let toggle_panel = item(
        "toggle-panel",
        "Toggle Workspace Panel",
        Some("CmdOrCtrl+J"),
    )?;
    let library = item("library", "Library", Some("CmdOrCtrl+Shift+L"))?;
    let shortcuts = item("shortcuts", "Keyboard Shortcuts", None)?;

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
        .item(&library)
        .separator()
        .fullscreen()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .build()?;

    let help = SubmenuBuilder::new(app, "Help").item(&shortcuts).build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        let name = app.package_info().name.clone();
        let app_menu = SubmenuBuilder::new(app, name)
            .about(None)
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
    menu.items(&[&file, &edit, &view, &window, &help]).build()
}

/// Hands a click on one of egant's own items to the frontend.
pub fn forward<R: Runtime>(app: &AppHandle<R>, id: &str) {
    // The predefined items (copy, quit, …) are handled natively and never
    // reach here with an id of ours; anything unknown is simply passed on and
    // ignored by the frontend.
    let _ = app.emit(MENU_ACTION_EVENT, id);
}
