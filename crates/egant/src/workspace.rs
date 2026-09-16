//! The window's root view.
//!
//! ```text
//! ┌────────────┬──────────────┬─────────────────────────────────┐
//! │ ●●●        │ Workspace  + │ [tab] [tab] +              [⊟]  │
//! │ ⌕ Search   │ Sessions … │ ╌╌╌╌╌╌╌╌ wallpaper ╌╌╌╌╌╌╌╌╌╌╌╌╌ │
//! │ ⌸ Inbox    │ ⌕ filter     │                                 │
//! │ ✎ Notes    │              │   What should we work on in X?  │
//! │            │  Claude  58m │   ┌───────────────────────────┐ │
//! │ Projects + │  Session one │   │ ⑂ main                    │ │
//! │ 📁 egant   │  ⑂ main      │   │ Ask, build, / for commands│ │
//! │            │              │   │ + [model] [state] [mode] ↑│ │
//! │ ⚙ Settings │              │   └───────────────────────────┘ │
//! │            │              │ Claude Code              $0.00  │
//! └────────────┴──────────────┴─────────────────────────────────┘
//! ```
//!
//! Both rails run the full height of the window rather than sitting under a
//! title bar, so the traffic lights fall over the first one; the tab strip is a
//! `TitleBar` belonging to the stage alone, which is what makes it draggable.
//!
//! The workspace is the only thing that knows what is selected. Every pane is
//! handed a flattened copy of the state it draws and reports clicks back as
//! events, so there is never a second answer to "which session is open".

use crate::panes::{
    ChangeRow, ColumnEvent, ColumnState, EntryRow, NavDestination, NavEvent, NavRail, ProjectRow,
    ProjectTab, SessionRow, StatusBar, StatusEvent, StatusState, TabBar, TabBarEvent, TabRow,
    TranscriptPane, WorkspaceColumn, wallpaper,
};
use crate::project::{Project, ProjectId};
use crate::session::{AgentSession, default_options};
use crate::settings::{Settings, is_supported_image};
use crate::theme;
use crate::{FocusComposer, Interrupt, NewSession, OpenSettings, Search, ToggleSidebar};
use gpui_kit::component::{h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;
use std::path::PathBuf;

/// How many entries the explorer lists before it stops. The column is a glance
/// at the project, not a file manager, and a node_modules directory would
/// otherwise cost a full directory walk on every render.
const EXPLORER_LIMIT: usize = 500;

pub struct Workspace {
    projects: Vec<Project>,
    active_project: usize,
    next_project_id: usize,

    sessions: Vec<Entity<AgentSession>>,
    active_session: usize,

    /// Where the rail has sent the second column. `None` is the project itself.
    destination: Option<NavDestination>,
    tab: ProjectTab,

    settings: Settings,
    sidebar_visible: bool,
    focus: FocusHandle,

    nav_rail: Entity<NavRail>,
    column: Entity<WorkspaceColumn>,
    tab_bar: Entity<TabBar>,
    transcript: Entity<TranscriptPane>,
    status_bar: Entity<StatusBar>,
}

impl Workspace {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let nav_rail = cx.new(|_| NavRail::new());
        let column = cx.new(|cx| WorkspaceColumn::new(window, cx));
        let tab_bar = cx.new(|_| TabBar::new());
        let transcript = cx.new(|cx| TranscriptPane::new(window, cx));
        let status_bar = cx.new(|_| StatusBar::new());

        cx.subscribe_in(
            &nav_rail,
            window,
            |this, _, event, window, cx| match event {
                NavEvent::Search => this.focus_search(window, cx),
                NavEvent::Go(destination) => this.go(*destination, cx),
                NavEvent::SelectProject(index) => this.select_project(*index, cx),
                NavEvent::AddProject => this.pick_project_folder(cx),
            },
        )
        .detach();

        cx.subscribe(&column, |this, _, event, cx| match event {
            ColumnEvent::SelectSession(index) => this.select_session(*index, cx),
            ColumnEvent::NewSession => this.open_session(cx),
            ColumnEvent::SelectTab(tab) => this.select_tab(*tab, cx),
            ColumnEvent::PickWallpaper => this.pick_wallpaper(cx),
            ColumnEvent::ClearWallpaper => this.set_wallpaper(None, cx),
            ColumnEvent::CycleDim => {
                this.settings.cycle_dim();
                cx.notify();
            }
        })
        .detach();

        cx.subscribe(&tab_bar, |this, _, event, cx| match event {
            TabBarEvent::Select(index) => this.select_session(*index, cx),
            TabBarEvent::Close(index) => this.close_session(*index, cx),
            TabBarEvent::New => this.open_session(cx),
            TabBarEvent::ToggleSidebar => this.toggle_sidebar(cx),
        })
        .detach();

        cx.subscribe(&status_bar, |this, _, event, cx| match event {
            StatusEvent::PickWallpaper => this.pick_wallpaper(cx),
        })
        .detach();

        let mut workspace = Self {
            projects: Vec::new(),
            active_project: 0,
            next_project_id: 0,
            sessions: Vec::new(),
            active_session: 0,
            destination: None,
            tab: ProjectTab::default(),
            settings: Settings::load(),
            sidebar_visible: true,
            focus: cx.focus_handle(),
            nav_rail,
            column,
            tab_bar,
            transcript,
            status_bar,
        };

        // The directory the app was launched from is the first project, so the
        // window is never empty on a cold start.
        if let Ok(cwd) = std::env::current_dir() {
            workspace.add_project(cwd, cx);
        }
        workspace
    }

    /// Opens the platform folder picker and adds whatever comes back.
    fn pick_project_folder(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: false,
            directories: true,
            multiple: false,
            prompt: Some("Open".into()),
        });

        cx.spawn(async move |this, cx| {
            // Three layers of "maybe": the channel can be dropped, the prompt
            // can fail, and the user can cancel. All three mean the same thing
            // here — no folder was chosen.
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| this.add_project(path, cx)).ok();
        })
        .detach();
    }

    /// Opens the platform file picker and takes the image it returns as the
    /// stage's wallpaper.
    fn pick_wallpaper(&mut self, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: false,
            prompt: Some("Set wallpaper".into()),
        });

        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let Some(path) = paths.into_iter().next() else {
                return;
            };
            this.update(cx, |this, cx| {
                // The picker has no format filter, so this is where a PDF gets
                // turned away — silently drawing nothing would look like a bug.
                if is_supported_image(&path) {
                    this.set_wallpaper(Some(path), cx);
                } else {
                    log::warn!("{} is not an image this window can draw", path.display());
                }
            })
            .ok();
        })
        .detach();
    }

    fn set_wallpaper(&mut self, path: Option<PathBuf>, cx: &mut Context<Self>) {
        self.settings.set_wallpaper(path);
        cx.notify();
    }

    fn add_project(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        // Re-opening a folder selects the one already there rather than stacking
        // a duplicate row.
        if let Some(index) = self.projects.iter().position(|p| p.path == path) {
            self.select_project(index, cx);
            return;
        }

        let project = Project::new(ProjectId(self.next_project_id), path);
        self.next_project_id += 1;
        self.projects.push(project);
        self.active_project = self.projects.len() - 1;
        self.destination = None;
        self.open_session(cx);
    }

    fn select_project(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.projects.len() {
            return;
        }
        self.active_project = index;
        // Picking a project is also how you leave Inbox, Notes or Settings.
        self.destination = None;

        // Follow the project to its most recent session, if it has one, so
        // switching projects does not leave an unrelated transcript on screen.
        let project = self.projects[index].id;
        if let Some(session) = self
            .sessions
            .iter()
            .rposition(|session| session.read(cx).project == project)
        {
            self.active_session = session;
        }
        cx.notify();
    }

    fn go(&mut self, destination: NavDestination, cx: &mut Context<Self>) {
        // Clicking the destination you are already on goes back to the project,
        // so the rail toggles rather than trapping you.
        self.destination = if self.destination == Some(destination) {
            None
        } else {
            Some(destination)
        };
        cx.notify();
    }

    fn select_tab(&mut self, tab: ProjectTab, cx: &mut Context<Self>) {
        self.tab = tab;
        cx.notify();
    }

    fn focus_search(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        // The filter belongs to the project view, so searching leaves whatever
        // global destination the rail was on.
        self.destination = None;
        self.column
            .update(cx, |column, cx| column.focus_filter(window, cx));
        cx.notify();
    }

    fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.transcript
            .update(cx, |pane, cx| pane.focus_composer(window, cx));
    }

    pub fn open_session(&mut self, cx: &mut Context<Self>) {
        let Some(project) = self.projects.get(self.active_project) else {
            // Nothing to run in yet — ask for a folder instead of failing.
            self.pick_project_folder(cx);
            return;
        };

        let root = project.path.clone();
        let id = project.id;
        let count = self
            .sessions
            .iter()
            .filter(|session| session.read(cx).project == id)
            .count();
        let title = if count == 0 {
            "New session".to_string()
        } else {
            format!("New session {}", count + 1)
        };

        let session = cx.new(|cx| AgentSession::new(title, id, default_options(root), cx));
        cx.observe(&session, |_, _, cx| cx.notify()).detach();

        self.sessions.push(session);
        self.active_session = self.sessions.len() - 1;
        self.destination = None;
        cx.notify();
    }

    fn close_session(&mut self, index: usize, cx: &mut Context<Self>) {
        if index >= self.sessions.len() {
            return;
        }
        let session = self.sessions.remove(index);
        session.update(cx, |session, _| session.shutdown());

        // Keep the selection on the same visual position where possible, and
        // never leave it past the end.
        self.active_session = self
            .active_session
            .saturating_sub(usize::from(index <= self.active_session))
            .min(self.sessions.len().saturating_sub(1));
        cx.notify();
    }

    fn select_session(&mut self, index: usize, cx: &mut Context<Self>) {
        if index < self.sessions.len() {
            self.active_session = index;
            // Selecting a session also moves the project selection to its owner,
            // so the two rails agree.
            let project = self.sessions[index].read(cx).project;
            if let Some(position) = self.projects.iter().position(|p| p.id == project) {
                self.active_project = position;
            }
            cx.notify();
        }
    }

    fn toggle_sidebar(&mut self, cx: &mut Context<Self>) {
        self.sidebar_visible = !self.sidebar_visible;
        cx.notify();
    }

    fn interrupt_active(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.sessions.get(self.active_session).cloned() {
            session.update(cx, |session, cx| session.interrupt(cx));
        }
    }

    fn color_of(&self, project: ProjectId) -> Hsla {
        self.projects
            .iter()
            .find(|candidate| candidate.id == project)
            .map(|candidate| candidate.color)
            .unwrap_or_else(|| hsla(0.0, 0.0, 0.6, 1.0))
    }

    fn active_path(&self) -> Option<&PathBuf> {
        self.projects
            .get(self.active_project)
            .map(|project| &project.path)
    }

    /// The project root's own entries, sorted directories first.
    ///
    /// Read on render rather than watched: the column shows at most a few
    /// hundred names and only while the Explorer tab is up, which is far cheaper
    /// than keeping a filesystem watcher alive for a list nobody is looking at.
    fn explorer_rows(&self) -> Vec<EntryRow> {
        let Some(path) = self.active_path() else {
            return Vec::new();
        };
        let Ok(entries) = std::fs::read_dir(path) else {
            return Vec::new();
        };

        let mut rows: Vec<EntryRow> = entries
            .flatten()
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                // Dotfiles are noise at this size; the agent can still see them.
                if name.starts_with('.') {
                    return None;
                }
                Some(EntryRow {
                    is_dir: entry.file_type().is_ok_and(|kind| kind.is_dir()),
                    name: name.into(),
                })
            })
            .take(EXPLORER_LIMIT)
            .collect();

        rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
        rows
    }

    /// What git reports as changed in the project, staged rows first.
    fn change_rows(&self) -> Vec<ChangeRow> {
        let Some(path) = self.active_path() else {
            return Vec::new();
        };
        let Ok(repo) = egant_vcs::Repo::discover(path) else {
            return Vec::new();
        };
        let Ok(changes) = repo.changes() else {
            return Vec::new();
        };

        let mut rows: Vec<ChangeRow> = changes
            .into_iter()
            .map(|change| ChangeRow {
                path: change.path.display().to_string().into(),
                code: change.status.code().to_string().into(),
                staged: change.staged,
            })
            .collect();

        rows.sort_by(|a, b| b.staged.cmp(&a.staged).then_with(|| a.path.cmp(&b.path)));
        rows
    }

    fn status(&self, cx: &App) -> StatusState {
        let Some(session) = self.sessions.get(self.active_session) else {
            return StatusState {
                backend: "No session".into(),
                ..StatusState::default()
            };
        };
        let session = session.read(cx);
        let transcript = &session.transcript;

        let mut detail = Vec::new();
        if let Some(model) = &transcript.model {
            detail.push(model.clone());
        }
        if transcript.total_cost_usd > 0.0 {
            detail.push(format!("${:.4}", transcript.total_cost_usd));
        }

        StatusState {
            backend: if session.ended {
                "Agent stopped".into()
            } else {
                "Claude Code".into()
            },
            detail: (!detail.is_empty()).then(|| detail.join(" · ").into()),
            busy: transcript.is_busy(),
        }
    }
}

impl Render for Workspace {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let project_rows: Vec<ProjectRow> = self
            .projects
            .iter()
            .enumerate()
            .map(|(index, project)| ProjectRow {
                name: project.name.clone(),
                location: project.location.clone(),
                color: project.color,
                // A global destination takes the highlight off the project, the
                // way it does in a mail client's folder list.
                selected: index == self.active_project && self.destination.is_none(),
            })
            .collect();

        let session_rows: Vec<SessionRow> = self
            .sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                let color = self.color_of(session.read(cx).project);
                let session = session.read(cx);
                SessionRow {
                    title: session.title.clone(),
                    model: session
                        .transcript
                        .model
                        .clone()
                        .map(SharedString::from)
                        .unwrap_or_else(|| "Claude Code".into()),
                    branch: session.branch.clone(),
                    age: session.age_label().into(),
                    color,
                    selected: index == self.active_session,
                    busy: session.transcript.is_busy(),
                }
            })
            .collect();

        let tab_rows: Vec<TabRow> = self
            .sessions
            .iter()
            .enumerate()
            .map(|(index, session)| {
                let color = self.color_of(session.read(cx).project);
                let session = session.read(cx);
                TabRow {
                    title: session.title.clone(),
                    color,
                    selected: index == self.active_session,
                    busy: session.transcript.is_busy(),
                }
            })
            .collect();

        // The lists behind Explorer and Changes cost a filesystem read, so they
        // are gathered only when their tab is the one on screen.
        let on_project = self.destination.is_none();
        let column_state = ColumnState {
            destination: self.destination,
            tab: self.tab,
            project: self
                .projects
                .get(self.active_project)
                .map(|project| project.name.clone()),
            sessions: session_rows,
            entries: if on_project && self.tab == ProjectTab::Explorer {
                self.explorer_rows()
            } else {
                Vec::new()
            },
            changes: if on_project && self.tab == ProjectTab::Changes {
                self.change_rows()
            } else {
                Vec::new()
            },
            wallpaper: self.settings.wallpaper.as_ref().map(|path| {
                path.file_name()
                    .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
                    .unwrap_or_else(|| path.display().to_string().into())
            }),
            dim: self.settings.wallpaper_dim,
        };

        let status = self.status(cx);

        self.nav_rail.update(cx, |rail, cx| {
            rail.set_state(project_rows, self.destination, cx)
        });
        self.column
            .update(cx, |column, cx| column.set_state(column_state, cx));
        self.tab_bar
            .update(cx, |bar, cx| bar.set_tabs(tab_rows, cx));
        self.status_bar
            .update(cx, |bar, cx| bar.set_state(status, cx));

        if let Some(session) = self.sessions.get(self.active_session).cloned() {
            self.transcript
                .update(cx, |pane, cx| pane.set_session(session, cx));
        }

        let has_session = !self.sessions.is_empty();

        h_flex()
            .id("workspace")
            .key_context("Workspace")
            .track_focus(&self.focus)
            .size_full()
            // Translucent on purpose: an opaque colour here would hide the
            // window's blurred backdrop and defeat `WindowBackgroundAppearance`.
            .bg(theme::rail())
            .text_color(theme::ink())
            .on_action(cx.listener(|this, _: &NewSession, _, cx| this.open_session(cx)))
            .on_action(cx.listener(|this, _: &Interrupt, _, cx| this.interrupt_active(cx)))
            .on_action(cx.listener(|this, _: &ToggleSidebar, _, cx| this.toggle_sidebar(cx)))
            .on_action(cx.listener(|this, _: &Search, window, cx| this.focus_search(window, cx)))
            .on_action(
                cx.listener(|this, _: &OpenSettings, _, cx| this.go(NavDestination::Settings, cx)),
            )
            .on_action(
                cx.listener(|this, _: &FocusComposer, window, cx| this.focus_composer(window, cx)),
            )
            .when(self.sidebar_visible, |this| {
                this.child(self.nav_rail.clone()).child(self.column.clone())
            })
            .child(
                v_flex()
                    .flex_1()
                    .min_w(px(420.))
                    .h_full()
                    // The wallpaper is painted into this box, so everything after
                    // it stacks on top.
                    .relative()
                    .overflow_hidden()
                    .child(wallpaper(
                        self.settings.wallpaper.as_ref(),
                        self.settings.wallpaper_dim,
                    ))
                    .child(self.tab_bar.clone())
                    .child(if has_session {
                        div()
                            .flex_1()
                            .overflow_hidden()
                            .child(self.transcript.clone())
                            .into_any_element()
                    } else {
                        empty_state().into_any_element()
                    })
                    .child(self.status_bar.clone()),
            )
    }
}

fn empty_state() -> impl IntoElement {
    v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_1()
        .child(
            div()
                .text_sm()
                .text_color(theme::muted())
                .child("No session open"),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme::faint())
                .child("Press ⌘N to start one"),
        )
}
