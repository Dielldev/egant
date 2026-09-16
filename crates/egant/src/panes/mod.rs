//! The panes the workspace arranges.
//!
//! Each is a GPUI entity with its own state. None of them reach back into the
//! workspace: they report what happened as events, and the workspace decides
//! what it means. [`stage`] is the exception and is not an entity at all — the
//! wallpaper has no state and no behaviour, only layers.
//!
//! The browser pane is not mounted yet; `egant-webview` is written and tested,
//! but nothing renders it.

mod nav_rail;
mod stage;
mod status_bar;
mod tab_bar;
mod transcript;
mod workspace_column;

pub use nav_rail::{NavDestination, NavEvent, NavRail, ProjectRow};
pub use stage::wallpaper;
pub use status_bar::{StatusBar, StatusEvent, StatusState};
pub use tab_bar::{TabBar, TabBarEvent, TabRow};
pub use transcript::TranscriptPane;
pub use workspace_column::{
    ChangeRow, ColumnEvent, ColumnState, EntryRow, ProjectTab, SessionRow, WorkspaceColumn,
};
