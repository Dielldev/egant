//! egant — a native desktop workspace for coding agents.
//!
//! The window is one [`Workspace`]: a rail of destinations and projects, a
//! column of what the selected project holds, and a stage carrying the tab
//! strip, the conversation and its composer over a wallpaper. The agent lives
//! behind `egant-harness`, so this crate is only ever presentation and wiring.

mod panes;
mod project;
mod session;
mod settings;
mod theme;
mod workspace;

use gpui_kit::assets::icon_assets;
use gpui_kit::component::Root;
use gpui_kit::*;
use workspace::Workspace;

// Icons are SVGs loaded through an asset source, so every one the UI names has
// to be embedded here — a name with no asset behind it renders as nothing at
// all. Listing them explicitly keeps the binary from carrying all 1,800 bundled
// Lucide icons to use a dozen.
icon_assets!(
    Assets,
    [
        ArrowUp,
        ChevronDown,
        FileText,
        Folder,
        Gauge,
        GitBranch,
        Image,
        Inbox,
        Lock,
        Notebook,
        PanelLeft,
        Plus,
        Search,
        Settings,
        SlidersHorizontal,
        Sparkles,
        X,
    ]
);

gpui_kit::actions!(
    egant,
    [
        /// Quit the application.
        Quit,
        /// Start a new agent session.
        NewSession,
        /// Stop the turn currently running.
        Interrupt,
        /// Show or hide both left rails.
        ToggleSidebar,
        /// Put the cursor in the workspace column's filter field.
        Search,
        /// Show the settings view in the workspace column.
        OpenSettings,
        /// Put the cursor back in the message composer.
        FocusComposer,
    ]
);

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    gpui_kit::application()
        .with_assets(Assets)
        .run(|cx: &mut App| {
            // Brings up the theme, assets and component layers. Nothing from
            // gpui-component works before this.
            gpui_kit::init(cx);
            register_global_actions(cx);

            let bounds = Bounds::centered(None, size(px(1320.), px(860.)), cx);
            let options = WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(880.), px(560.))),
                // The vibrant background. The theme must leave the window's own
                // background translucent for this to show through; see
                // `workspace::Workspace::render`.
                window_background: WindowBackgroundAppearance::Blurred,
                // The rails run to the top of the window and the traffic lights
                // sit over them, so the system title bar is hidden and the
                // lights are placed by hand.
                titlebar: Some(TitlebarOptions {
                    title: None,
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(14.), px(16.))),
                }),
                // The tab strip is a `TitleBar`, which moves the window itself.
                app_owns_titlebar_drag: true,
                ..Default::default()
            };

            cx.open_window(options, |window, cx| {
                // Before the first render: the shell is a single dark design and
                // a window that opened light and then repainted would flash.
                theme::apply(window, cx);

                let workspace = cx.new(|cx| Workspace::new(window, cx));
                // `Root` hosts modals, drawers and notifications. Every window
                // that uses gpui-component overlays needs it as the outermost
                // view.
                cx.new(|cx| Root::new(workspace, window, cx))
            })
            .expect("failed to open window");

            cx.activate(true);
        });
}

fn register_global_actions(cx: &mut App) {
    cx.on_action(|_: &Quit, cx| cx.quit());

    cx.bind_keys([
        KeyBinding::new("cmd-q", Quit, None),
        KeyBinding::new("cmd-n", NewSession, None),
        KeyBinding::new("cmd-escape", Interrupt, None),
        KeyBinding::new("cmd-b", ToggleSidebar, None),
        KeyBinding::new("cmd-k", Search, None),
        KeyBinding::new("cmd-,", OpenSettings, None),
        KeyBinding::new("cmd-l", FocusComposer, None),
    ]);
}
