//! The thin strip along the foot of the stage.
//!
//! It carries what the window is doing rather than what it can do: the agent
//! backend on the left, the session's cost and turn state on the right. The one
//! control it holds is the wallpaper picker, because that is the setting people
//! reach for most and burying it two clicks deep in the settings column would be
//! its own kind of unfriendly.

use crate::theme;
use gpui_kit::assets::IconName;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, h_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

/// Short enough to read as a footer rather than a toolbar.
pub const STATUS_BAR_HEIGHT: Pixels = px(26.);

#[derive(Debug, Clone, Default)]
pub struct StatusState {
    /// Which agent is behind the session — "Claude Code" and the like.
    pub backend: SharedString,
    /// Right-hand summary: cost, model, whatever the session knows.
    pub detail: Option<SharedString>,
    pub busy: bool,
}

pub enum StatusEvent {
    PickWallpaper,
}

pub struct StatusBar {
    state: StatusState,
}

impl StatusBar {
    pub fn new() -> Self {
        Self {
            state: StatusState::default(),
        }
    }

    pub fn set_state(&mut self, state: StatusState, cx: &mut Context<Self>) {
        self.state = state;
        cx.notify();
    }
}

impl EventEmitter<StatusEvent> for StatusBar {}

impl Render for StatusBar {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let wallpaper = cx.listener(|_, _: &ClickEvent, _, cx| cx.emit(StatusEvent::PickWallpaper));

        h_flex()
            .w_full()
            .h(STATUS_BAR_HEIGHT)
            .flex_shrink_0()
            .items_center()
            .justify_between()
            .px_3()
            .gap_2()
            .border_t_1()
            .border_color(theme::white(0.05))
            .text_xs()
            .text_color(theme::faint())
            .child(
                h_flex()
                    .items_center()
                    .gap_1p5()
                    .overflow_hidden()
                    .when(self.state.busy, |this| {
                        this.child(
                            div()
                                .size_1p5()
                                .rounded_full()
                                .bg(theme::busy())
                                .flex_shrink_0(),
                        )
                    })
                    .child(Icon::new(IconName::Sparkles).size_3().flex_shrink_0())
                    .child(div().truncate().child(self.state.backend.clone())),
            )
            .child(
                h_flex()
                    .items_center()
                    .gap_2()
                    .flex_shrink_0()
                    .when_some(self.state.detail.clone(), |this, detail| {
                        this.child(div().truncate().child(detail))
                    })
                    .child(
                        div()
                            .id("wallpaper")
                            .p_0p5()
                            .rounded_sm()
                            .cursor_pointer()
                            .hover(|style| style.text_color(theme::ink()))
                            .on_click(wallpaper)
                            .tooltip(|window, cx| {
                                Tooltip::new("Choose a wallpaper").build(window, cx)
                            })
                            .child(Icon::new(IconName::Image).size_3()),
                    ),
            )
    }
}
