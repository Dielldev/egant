//! The second column: what the selected project contains, or whichever global
//! destination the rail has sent us to.
//!
//! It owns exactly one piece of state — the text in its filter field — because
//! that is keystroke-rate and belongs next to the list it narrows. Everything
//! else is pushed down by the workspace on each render.

use crate::panes::NavDestination;
use crate::theme;
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

pub const COLUMN_WIDTH: Pixels = px(212.);

/// The three views onto a project.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ProjectTab {
    #[default]
    Sessions,
    Explorer,
    Changes,
}

impl ProjectTab {
    pub const ALL: [Self; 3] = [Self::Sessions, Self::Explorer, Self::Changes];

    fn label(self) -> &'static str {
        match self {
            Self::Sessions => "Sessions",
            Self::Explorer => "Explorer",
            Self::Changes => "Changes",
        }
    }

    fn filter_placeholder(self) -> &'static str {
        match self {
            Self::Sessions => "Search conversations…",
            Self::Explorer => "Search files…",
            Self::Changes => "Search changes…",
        }
    }
}

/// One conversation, flattened for display.
#[derive(Debug, Clone)]
pub struct SessionRow {
    pub title: SharedString,
    /// The model the agent reported, shown above the title the way a mail client
    /// shows a sender.
    pub model: SharedString,
    pub branch: Option<SharedString>,
    pub age: SharedString,
    pub color: Hsla,
    pub selected: bool,
    pub busy: bool,
}

/// One entry in the project root.
#[derive(Debug, Clone)]
pub struct EntryRow {
    pub name: SharedString,
    pub is_dir: bool,
}

/// One path git reports as changed.
#[derive(Debug, Clone)]
pub struct ChangeRow {
    pub path: SharedString,
    /// The `git status --short` letter.
    pub code: SharedString,
    pub staged: bool,
}

/// Everything the column draws, gathered by the workspace in one pass.
#[derive(Debug, Clone, Default)]
pub struct ColumnState {
    /// `None` means the rail is on a project rather than a global destination.
    pub destination: Option<NavDestination>,
    pub tab: ProjectTab,
    pub project: Option<SharedString>,
    pub sessions: Vec<SessionRow>,
    pub entries: Vec<EntryRow>,
    pub changes: Vec<ChangeRow>,
    /// File name of the current wallpaper, for the settings view.
    pub wallpaper: Option<SharedString>,
    pub dim: f32,
}

pub enum ColumnEvent {
    SelectSession(usize),
    NewSession,
    SelectTab(ProjectTab),
    PickWallpaper,
    ClearWallpaper,
    CycleDim,
}

pub struct WorkspaceColumn {
    state: ColumnState,
    filter: Entity<InputState>,
    /// Held: dropping it would stop the list from narrowing as you type.
    _subscription: Subscription,
}

impl WorkspaceColumn {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let filter = cx.new(|cx| {
            InputState::new(window, cx).placeholder(ProjectTab::default().filter_placeholder())
        });
        let subscription = cx.subscribe(&filter, |_, _, event: &InputEvent, cx| {
            if matches!(event, InputEvent::Change) {
                cx.notify();
            }
        });

        Self {
            state: ColumnState::default(),
            filter,
            _subscription: subscription,
        }
    }

    pub fn set_state(&mut self, state: ColumnState, cx: &mut Context<Self>) {
        self.state = state;
        cx.notify();
    }

    pub fn focus_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.filter
            .update(cx, |filter, cx| filter.focus(window, cx));
    }

    /// The filter text, lowercased once so the matching below does not do it per
    /// row.
    fn needle(&self, cx: &App) -> String {
        self.filter.read(cx).value().trim().to_lowercase()
    }
}

impl EventEmitter<ColumnEvent> for WorkspaceColumn {}

impl Render for WorkspaceColumn {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let new_session = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(ColumnEvent::NewSession));

        v_flex()
            .id("workspace-column")
            .w(COLUMN_WIDTH)
            .flex_shrink_0()
            .h_full()
            .bg(theme::panel())
            .border_r_1()
            .border_color(theme::border())
            .pt(px(44.))
            .text_color(theme::muted())
            .child(header(
                self.title(),
                self.state.project.clone(),
                new_session,
            ))
            .child(self.body(cx))
    }
}

impl WorkspaceColumn {
    fn title(&self) -> SharedString {
        match self.state.destination {
            Some(NavDestination::Inbox) => "Inbox".into(),
            Some(NavDestination::Notes) => "Notes".into(),
            Some(NavDestination::Settings) => "Settings".into(),
            None => "Workspace".into(),
        }
    }

    fn body(&self, cx: &mut Context<Self>) -> AnyElement {
        match self.state.destination {
            Some(NavDestination::Settings) => self.settings_view(cx),
            Some(NavDestination::Inbox) => {
                empty_view("Nothing in your inbox", "Agent notifications land here.")
            }
            Some(NavDestination::Notes) => {
                empty_view("No notes yet", "Scratch space that follows the project.")
            }
            None => self.project_view(cx),
        }
    }

    fn project_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let needle = self.needle(cx);
        let tabs = ProjectTab::ALL.map(|tab| {
            let on_click =
                cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(ColumnEvent::SelectTab(tab)));
            segment(tab, tab == self.state.tab, on_click)
        });

        v_flex()
            .flex_1()
            .overflow_hidden()
            .child(h_flex().px_2().pb_2().gap_1().children(tabs))
            .child(self.filter_field())
            .child(match self.state.tab {
                ProjectTab::Sessions => self.session_list(&needle, cx),
                ProjectTab::Explorer => self.entry_list(&needle),
                ProjectTab::Changes => self.change_list(&needle),
            })
            .into_any_element()
    }

    fn filter_field(&self) -> impl IntoElement {
        h_flex()
            .mx_2()
            .mb_2()
            .px_2()
            .py_1()
            .gap_1p5()
            .items_center()
            .rounded_md()
            .bg(white_field())
            .child(
                Icon::new(IconName::Search)
                    .size_3()
                    .text_color(theme::faint())
                    .flex_shrink_0(),
            )
            .child(
                div()
                    .flex_1()
                    .text_xs()
                    // The control draws nothing of its own; the row around it is
                    // the field, which is what keeps it the same height as the
                    // list rows beside it.
                    .child(Input::new(&self.filter).appearance(false)),
            )
            .child(
                Icon::new(IconName::SlidersHorizontal)
                    .size_3()
                    .text_color(theme::faint())
                    .flex_shrink_0(),
            )
    }

    fn session_list(&self, needle: &str, cx: &mut Context<Self>) -> AnyElement {
        let rows = self
            .state
            .sessions
            .iter()
            .enumerate()
            .filter(|(_, row)| matches(needle, &[&row.title, &row.model]))
            .map(|(index, row)| {
                let on_click = cx.listener(move |_, _: &ClickEvent, _, cx| {
                    cx.emit(ColumnEvent::SelectSession(index))
                });
                session_row(index, row, on_click)
            })
            .collect::<Vec<_>>();

        scroller("sessions", rows, "No conversations yet")
    }

    fn entry_list(&self, needle: &str) -> AnyElement {
        let rows = self
            .state
            .entries
            .iter()
            .filter(|row| matches(needle, &[&row.name]))
            .enumerate()
            .map(|(index, row)| {
                h_flex()
                    .id(("entry", index))
                    .w_full()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .text_xs()
                    .hover(|style| style.bg(theme::hover()))
                    .child(
                        Icon::new(if row.is_dir {
                            IconName::Folder
                        } else {
                            IconName::FileText
                        })
                        .size_3()
                        .text_color(theme::faint())
                        .flex_shrink_0(),
                    )
                    .child(div().flex_1().truncate().child(row.name.clone()))
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        scroller("entries", rows, "Nothing here")
    }

    fn change_list(&self, needle: &str) -> AnyElement {
        let rows = self
            .state
            .changes
            .iter()
            .filter(|row| matches(needle, &[&row.path]))
            .enumerate()
            .map(|(index, row)| {
                h_flex()
                    .id(("change", index))
                    .w_full()
                    .items_center()
                    .gap_2()
                    .px_2()
                    .py_1()
                    .rounded_md()
                    .text_xs()
                    .hover(|style| style.bg(theme::hover()))
                    .child(
                        div()
                            .w(px(10.))
                            .flex_shrink_0()
                            // Staged and unstaged copies of a path both appear;
                            // the dimmer letter is the one still in the working
                            // tree.
                            .text_color(if row.staged {
                                theme::ink()
                            } else {
                                theme::faint()
                            })
                            .child(row.code.clone()),
                    )
                    .child(div().flex_1().truncate().child(row.path.clone()))
                    .into_any_element()
            })
            .collect::<Vec<_>>();

        scroller("changes", rows, "Working tree is clean")
    }

    fn settings_view(&self, cx: &mut Context<Self>) -> AnyElement {
        let pick = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(ColumnEvent::PickWallpaper));
        let clear = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(ColumnEvent::ClearWallpaper));
        let dim = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(ColumnEvent::CycleDim));

        let current = self
            .state
            .wallpaper
            .clone()
            .unwrap_or_else(|| "None".into());

        v_flex()
            .id("settings")
            .flex_1()
            .overflow_y_scroll()
            .px_2()
            .gap_1()
            .child(
                div()
                    .px_2()
                    .pb_1()
                    .text_xs()
                    .text_color(theme::faint())
                    .child("Wallpaper"),
            )
            .child(
                div()
                    .px_2()
                    .pb_1()
                    .text_xs()
                    .text_color(theme::ink())
                    .truncate()
                    .child(current),
            )
            .child(setting_row("Choose image…", IconName::Image, pick))
            .child(setting_row(
                format!("Dim {:.0}%", self.state.dim * 100.),
                IconName::Gauge,
                dim,
            ))
            .when(self.state.wallpaper.is_some(), |this| {
                this.child(setting_row("Remove wallpaper", IconName::X, clear))
            })
            .into_any_element()
    }
}

/// `subtitle` is the project the column is looking at. It is a tooltip rather
/// than a second line because the header has to stay the same height as the
/// rail's first row beside it.
fn header(
    title: SharedString,
    subtitle: Option<SharedString>,
    on_new: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    h_flex()
        .w_full()
        .items_center()
        .justify_between()
        .px_3()
        .pb_2()
        .child(
            div()
                .id("column-title")
                .text_xs()
                .text_color(theme::ink())
                .font_weight(FontWeight::MEDIUM)
                .when_some(subtitle, |this, subtitle| {
                    this.tooltip(move |window, cx| Tooltip::new(subtitle.clone()).build(window, cx))
                })
                .child(title),
        )
        .child(
            div()
                .id("new-session")
                .p_0p5()
                .rounded_md()
                .text_color(theme::faint())
                .cursor_pointer()
                .hover(|style| style.bg(theme::hover()).text_color(theme::ink()))
                .on_click(on_new)
                .tooltip(|window, cx| Tooltip::new("New session · ⌘N").build(window, cx))
                .child(Icon::new(IconName::Plus).size_3()),
        )
}

fn segment(
    tab: ProjectTab,
    selected: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    div()
        .id(tab.label())
        .px_2()
        .py_0p5()
        .rounded_md()
        .text_xs()
        .cursor_pointer()
        .when(selected, |this| {
            this.bg(theme::selected()).text_color(theme::ink())
        })
        .when(!selected, |this| this.text_color(theme::muted()))
        .hover(|style| style.text_color(theme::ink()))
        .on_click(on_click)
        .child(tab.label())
        .into_any_element()
}

fn session_row(
    index: usize,
    row: &SessionRow,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    v_flex()
        .id(("session", index))
        .w_full()
        .gap_0p5()
        .px_2()
        .py_1p5()
        .rounded_md()
        .cursor_pointer()
        .when(row.selected, |this| this.bg(theme::selected()))
        .hover(|style| style.bg(theme::hover()))
        .on_click(on_click)
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap_1p5()
                .text_xs()
                .text_color(theme::muted())
                .child(
                    Icon::new(IconName::Sparkles)
                        .size_3()
                        .text_color(row.color)
                        .flex_shrink_0(),
                )
                .child(div().flex_1().truncate().child(row.model.clone()))
                .when(row.busy, |this| {
                    this.child(
                        div()
                            .size_1p5()
                            .rounded_full()
                            .bg(theme::busy())
                            .flex_shrink_0(),
                    )
                })
                .child(div().flex_shrink_0().child(row.age.clone())),
        )
        .child(
            div()
                .w_full()
                .text_xs()
                .text_color(theme::ink())
                .truncate()
                .child(row.title.clone()),
        )
        .when_some(row.branch.clone(), |this, branch| {
            this.child(
                h_flex()
                    .items_center()
                    .gap_1()
                    .text_xs()
                    .text_color(theme::faint())
                    .child(Icon::new(IconName::GitBranch).size_3().flex_shrink_0())
                    .child(div().truncate().child(branch)),
            )
        })
        .into_any_element()
}

fn setting_row(
    label: impl Into<SharedString>,
    icon: IconName,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    let label = label.into();
    h_flex()
        .id(SharedString::from(format!("setting-{label}")))
        .w_full()
        .items_center()
        .gap_2()
        .px_2()
        .py_1p5()
        .rounded_md()
        .text_xs()
        .cursor_pointer()
        .hover(|style| style.bg(theme::hover()).text_color(theme::ink()))
        .on_click(on_click)
        .child(Icon::new(icon).size_3().flex_shrink_0())
        .child(div().flex_1().truncate().child(label))
}

/// The scrolling body every list shares, so an empty one looks the same
/// whichever tab produced it.
fn scroller(id: &'static str, rows: Vec<AnyElement>, empty: &'static str) -> AnyElement {
    v_flex()
        .id(id)
        .flex_1()
        .overflow_y_scroll()
        .px_2()
        .pb_2()
        .gap_px()
        .when(rows.is_empty(), |this| {
            this.child(
                div()
                    .px_2()
                    .py_1()
                    .text_xs()
                    .text_color(theme::faint())
                    .child(empty),
            )
        })
        .children(rows)
        .into_any_element()
}

fn empty_view(title: &'static str, detail: &'static str) -> AnyElement {
    v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap_1()
        .px_4()
        .text_center()
        .child(div().text_xs().text_color(theme::muted()).child(title))
        .child(div().text_xs().text_color(theme::faint()).child(detail))
        .into_any_element()
}

/// An empty needle matches everything, which is what makes the filter field
/// invisible until it is used.
fn matches(needle: &str, haystacks: &[&SharedString]) -> bool {
    needle.is_empty()
        || haystacks
            .iter()
            .any(|haystack| haystack.to_lowercase().contains(needle))
}

fn white_field() -> Hsla {
    theme::white(0.05)
}

#[cfg(test)]
mod tests {
    use super::matches;
    use gpui_kit::SharedString;

    #[test]
    fn an_empty_filter_keeps_every_row() {
        let title = SharedString::from("SEO & GEO Improvements");
        assert!(matches("", &[&title]));
    }

    #[test]
    fn the_filter_ignores_case_and_looks_at_every_field() {
        let title = SharedString::from("SEO & GEO Improvements");
        let model = SharedString::from("Claude Opus");
        assert!(matches("geo", &[&title, &model]));
        assert!(matches("opus", &[&title, &model]));
        assert!(!matches("sonnet", &[&title, &model]));
    }
}
