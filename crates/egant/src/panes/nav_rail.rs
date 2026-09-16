//! The far-left rail: global destinations at the top, projects below, settings
//! anchored to the foot.
//!
//! It is the narrowest column in the window and the only one that never
//! scrolls — everything in it is one line high, so the rail reads as a fixed map
//! of the app while the columns to its right change underneath.

use crate::theme;
use gpui_kit::assets::IconName;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

pub const NAV_RAIL_WIDTH: Pixels = px(168.);

/// A place the rail can send the workspace column.
///
/// Search is deliberately not one: it acts on the column that is already there
/// rather than replacing it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NavDestination {
    Inbox,
    Notes,
    Settings,
}

impl NavDestination {
    fn label(self) -> &'static str {
        match self {
            Self::Inbox => "Inbox",
            Self::Notes => "Notes",
            Self::Settings => "Settings",
        }
    }

    fn icon(self) -> IconName {
        match self {
            Self::Inbox => IconName::Inbox,
            Self::Notes => IconName::Notebook,
            Self::Settings => IconName::Settings,
        }
    }
}

/// What the rail shows for one open folder.
#[derive(Debug, Clone)]
pub struct ProjectRow {
    pub name: SharedString,
    /// Home-relative parent directory, shown on hover rather than in the row —
    /// the rail is too narrow to spend width on it.
    pub location: SharedString,
    pub color: Hsla,
    pub selected: bool,
}

pub enum NavEvent {
    /// Put the cursor in the workspace column's filter field.
    Search,
    Go(NavDestination),
    SelectProject(usize),
    AddProject,
}

pub struct NavRail {
    projects: Vec<ProjectRow>,
    destination: Option<NavDestination>,
}

impl NavRail {
    pub fn new() -> Self {
        Self {
            projects: Vec::new(),
            destination: None,
        }
    }

    /// Pushed down by the workspace each render; the rail holds no truth of its
    /// own.
    pub fn set_state(
        &mut self,
        projects: Vec<ProjectRow>,
        destination: Option<NavDestination>,
        cx: &mut Context<Self>,
    ) {
        self.projects = projects;
        self.destination = destination;
        cx.notify();
    }
}

impl EventEmitter<NavEvent> for NavRail {}

impl Render for NavRail {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let search = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(NavEvent::Search));
        let add_project = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(NavEvent::AddProject));

        let destinations = [NavDestination::Inbox, NavDestination::Notes]
            .into_iter()
            .map(|destination| {
                let on_click =
                    cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(NavEvent::Go(destination)));
                nav_row(
                    destination.label(),
                    destination.icon(),
                    None,
                    self.destination == Some(destination),
                    on_click,
                )
            })
            .collect::<Vec<_>>();

        let projects = self
            .projects
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let on_click = cx.listener(move |_, _: &ClickEvent, _, cx| {
                    cx.emit(NavEvent::SelectProject(index))
                });
                project_row(index, row, on_click)
            })
            .collect::<Vec<_>>();

        let settings =
            cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(NavEvent::Go(NavDestination::Settings)));

        v_flex()
            .id("nav-rail")
            .w(NAV_RAIL_WIDTH)
            .flex_shrink_0()
            .h_full()
            .bg(theme::rail())
            .border_r_1()
            .border_color(theme::border())
            // Clears the traffic lights: this column runs to the top of the
            // window rather than sitting under a title bar.
            .pt(px(44.))
            .px_2()
            .pb_2()
            .text_color(theme::muted())
            .child(
                v_flex()
                    .gap_px()
                    .child(nav_row(
                        "Search",
                        IconName::Search,
                        Some("⌘K"),
                        false,
                        search,
                    ))
                    .children(destinations),
            )
            .child(
                v_flex()
                    .id("nav-projects")
                    .flex_1()
                    .overflow_y_scroll()
                    .mt_4()
                    .gap_px()
                    .child(
                        h_flex()
                            .items_center()
                            .justify_between()
                            .px_2()
                            .pb_1()
                            .child(div().text_xs().text_color(theme::faint()).child("Projects"))
                            .child(
                                div()
                                    .id("add-project")
                                    .p_0p5()
                                    .rounded_md()
                                    .text_color(theme::faint())
                                    .cursor_pointer()
                                    .hover(|style| {
                                        style.bg(theme::hover()).text_color(theme::ink())
                                    })
                                    .on_click(add_project)
                                    .child(Icon::new(IconName::Plus).size_3()),
                            ),
                    )
                    .children(projects)
                    .when(self.projects.is_empty(), |this| {
                        this.child(
                            div()
                                .px_2()
                                .py_1()
                                .text_xs()
                                .text_color(theme::faint())
                                .child("No folder open"),
                        )
                    }),
            )
            .child(nav_row(
                "Settings",
                IconName::Settings,
                Some("⌘,"),
                self.destination == Some(NavDestination::Settings),
                settings,
            ))
    }
}

/// One line of the rail: icon, label, and an optional shortcut hint pushed to
/// the right edge.
fn nav_row(
    label: &'static str,
    icon: IconName,
    shortcut: Option<&'static str>,
    selected: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    h_flex()
        .id(label)
        .w_full()
        .items_center()
        .gap_2()
        .px_2()
        .py_1p5()
        .rounded_md()
        .cursor_pointer()
        .when(selected, |this| {
            this.bg(theme::selected()).text_color(theme::ink())
        })
        .hover(|style| style.bg(theme::hover()).text_color(theme::ink()))
        .on_click(on_click)
        .child(Icon::new(icon).size_3p5().flex_shrink_0())
        .child(div().flex_1().text_xs().truncate().child(label))
        .when_some(shortcut, |this, shortcut| {
            this.child(
                div()
                    .text_xs()
                    .text_color(theme::faint())
                    .flex_shrink_0()
                    .child(shortcut),
            )
        })
        .into_any_element()
}

fn project_row(
    index: usize,
    row: &ProjectRow,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let location = row.location.clone();
    let name = row.name.clone();

    h_flex()
        .id(("project", index))
        .w_full()
        .items_center()
        .gap_2()
        .px_2()
        .py_1p5()
        .rounded_md()
        .cursor_pointer()
        .when(row.selected, |this| {
            this.bg(theme::selected()).text_color(theme::ink())
        })
        .hover(|style| style.bg(theme::hover()).text_color(theme::ink()))
        .on_click(on_click)
        // The project's colour is its identity everywhere in the window; here it
        // is the whole mark, because the rail has no room for a folder icon
        // beside it.
        .child(
            Icon::new(IconName::Folder)
                .size_3p5()
                .text_color(row.color)
                .flex_shrink_0(),
        )
        .child(div().flex_1().text_xs().truncate().child(name))
        .when(!location.is_empty(), |this| {
            this.tooltip(move |window, cx| Tooltip::new(location.clone()).build(window, cx))
        })
        .into_any_element()
}
