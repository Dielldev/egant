//! The strip of open sessions across the top of the stage.
//!
//! It sits inside the component `TitleBar`, which is what makes the whole strip
//! draggable as the window's title bar while still holding real controls. It
//! draws no background of its own: the wallpaper runs to the top of the window
//! and this floats on it.

use crate::theme;
use gpui_kit::assets::IconName;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, TitleBar, h_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

#[derive(Debug, Clone)]
pub struct TabRow {
    pub title: SharedString,
    pub color: Hsla,
    pub selected: bool,
    pub busy: bool,
}

pub enum TabBarEvent {
    Select(usize),
    Close(usize),
    New,
    ToggleSidebar,
}

pub struct TabBar {
    tabs: Vec<TabRow>,
}

impl TabBar {
    pub fn new() -> Self {
        Self { tabs: Vec::new() }
    }

    pub fn set_tabs(&mut self, tabs: Vec<TabRow>, cx: &mut Context<Self>) {
        self.tabs = tabs;
        cx.notify();
    }
}

impl EventEmitter<TabBarEvent> for TabBar {}

impl Render for TabBar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tabs = self
            .tabs
            .iter()
            .enumerate()
            .map(|(index, tab)| {
                let on_select = cx
                    .listener(move |_, _: &ClickEvent, _, cx| cx.emit(TabBarEvent::Select(index)));
                let on_close =
                    cx.listener(move |_, _: &ClickEvent, _, cx| cx.emit(TabBarEvent::Close(index)));
                tab_element(index, tab, on_select, on_close)
            })
            .collect::<Vec<_>>();

        let on_new = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(TabBarEvent::New));
        let on_toggle = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(TabBarEvent::ToggleSidebar));

        TitleBar::new()
            // The component reserves room on macOS for traffic lights. They sit
            // over the rail here, so the strip starts flush instead.
            .pl_2()
            .pr_2()
            // The component paints a gradient by default. The wallpaper is
            // supposed to run to the top of the window, so the strip carries no
            // surface of its own — only its controls.
            .bg(transparent_black())
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_1()
                    .children(tabs)
                    .child(icon_button(
                        "new-tab",
                        IconName::Plus,
                        "New session · ⌘N",
                        on_new,
                    ))
                    // Pushes the layout control to the far edge, away from the
                    // tabs it has nothing to do with.
                    .child(div().flex_1())
                    .child(icon_button(
                        "toggle-sidebar",
                        IconName::PanelLeft,
                        "Hide sidebar · ⌘B",
                        on_toggle,
                    )),
            )
    }
}

fn tab_element(
    index: usize,
    tab: &TabRow,
    on_select: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    on_close: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> AnyElement {
    let group = SharedString::from(format!("tab-{index}"));

    h_flex()
        .id(("tab", index))
        .group(group.clone())
        .items_center()
        .gap_1p5()
        .max_w(px(200.))
        .px_2()
        .py_1()
        .rounded_md()
        .cursor_pointer()
        // The selected tab is a lit panel; the rest are only text on the
        // wallpaper, which is what keeps the strip from looking like chrome.
        .when(tab.selected, |this| {
            this.bg(theme::white(0.1)).text_color(theme::ink())
        })
        .when(!tab.selected, |this| this.text_color(theme::muted()))
        .hover(|style| style.bg(theme::white(0.06)).text_color(theme::ink()))
        .on_click(on_select)
        .child(
            Icon::new(IconName::Sparkles)
                .size_3()
                .text_color(tab.color)
                .flex_shrink_0(),
        )
        .child(div().flex_1().text_xs().truncate().child(tab.title.clone()))
        .when(tab.busy, |this| {
            this.child(
                div()
                    .size_1p5()
                    .rounded_full()
                    .bg(theme::busy())
                    .flex_shrink_0(),
            )
        })
        .child(
            div()
                .id(("tab-close", index))
                .p_0p5()
                .rounded_sm()
                .flex_shrink_0()
                .text_color(theme::muted())
                // Hidden until the pointer is on the tab: a row of close buttons
                // is noise on a strip this small, and the target is still there
                // the moment it matters.
                .opacity(0.)
                .group_hover(group, |style| style.opacity(1.))
                .hover(|style| style.bg(theme::white(0.12)).text_color(theme::ink()))
                // Stops the click reaching the tab body, which would select the
                // tab on its way to closing it.
                .on_click(on_close)
                .child(Icon::new(IconName::X).size_3()),
        )
        .into_any_element()
}

fn icon_button(
    id: &'static str,
    icon: IconName,
    tooltip: &'static str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .p_1()
        .rounded_md()
        .text_color(theme::muted())
        .cursor_pointer()
        .hover(|style| style.bg(theme::white(0.08)).text_color(theme::ink()))
        .on_click(on_click)
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .child(Icon::new(icon).size_3p5())
}
