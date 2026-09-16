//! The stage's content: the conversation, and the composer that drives it.
//!
//! The pane owns no conversation state. It reads the active session's
//! `Transcript` on render, which is what makes streaming free: the session
//! entity calls `notify` as deltas land, and this re-renders.
//!
//! The composer has two homes. Before the first message it sits in the middle of
//! the stage under a heading, because there is nothing else to look at; once the
//! conversation starts it docks to the bottom and the transcript scrolls above
//! it. It is the same element either way — only the box around it moves.

use crate::session::{AgentSession, mode_label};
use crate::theme;
use egant_harness::{PendingPermission, TranscriptEntry, TurnState};
use gpui_kit::assets::IconName;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::{Icon, h_flex, v_flex};
use gpui_kit::prelude::*;
use gpui_kit::*;

/// How wide the conversation and the docked composer are allowed to get. Long
/// measure is hard to read, and the stage can be very wide.
const COLUMN: Pixels = px(760.);

/// The composer is narrower when it is the only thing on screen — a wide empty
/// box reads as a form rather than an invitation.
const HERO_COLUMN: Pixels = px(560.);

/// What one render needs from the session, read in a single borrow so the rest
/// of the render is free to build listeners from `cx`.
struct Snapshot {
    entries: Vec<TranscriptEntry>,
    pending: Option<PendingPermission>,
    state: TurnState,
    model: SharedString,
    mode: SharedString,
    branch: SharedString,
    project: SharedString,
    ended: bool,
}

pub struct TranscriptPane {
    session: Option<Entity<AgentSession>>,
    composer: Entity<TextareaState>,
    /// Held: dropping the subscription would stop the composer's Enter key from
    /// reaching `submit`.
    _subscription: Subscription,
}

impl TranscriptPane {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .placeholder("Ask, build, / for commands…")
                // Grows with the message rather than scrolling a one-line box.
                .auto_grow(1, 10)
                // Plain Enter sends without inserting a newline; shift-Enter
                // still breaks the line. Without this a multi-line input would
                // swallow Enter entirely.
                .submit_on_enter(true)
        });

        // `subscribe_in` rather than `subscribe`: clearing the composer needs a
        // `&mut Window`, which only the windowed form provides.
        let subscription = cx.subscribe_in(
            &composer,
            window,
            |this, _, event: &InputEvent, window, cx| match event {
                InputEvent::PressEnter { shift, .. } if !shift => this.submit(window, cx),
                // Redraws the send button as the message goes from empty to not.
                InputEvent::Change => cx.notify(),
                _ => {}
            },
        );

        Self {
            session: None,
            composer,
            _subscription: subscription,
        }
    }

    pub fn set_session(&mut self, session: Entity<AgentSession>, cx: &mut Context<Self>) {
        let same = self
            .session
            .as_ref()
            .is_some_and(|current| current.entity_id() == session.entity_id());
        if same {
            return;
        }
        self.session = Some(session);
        cx.notify();
    }

    pub fn focus_composer(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.composer
            .update(cx, |composer, cx| composer.focus(window, cx));
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(session) = self.session.clone() else {
            return;
        };
        let text = self.composer.read(cx).value().to_string();
        if text.trim().is_empty() {
            return;
        }

        session.update(cx, |session, cx| session.send(text, cx));
        self.composer
            .update(cx, |state, cx| state.set_value("", window, cx));
        cx.notify();
    }

    fn interrupt(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.session.clone() {
            session.update(cx, |session, cx| session.interrupt(cx));
        }
    }

    fn cycle_mode(&mut self, cx: &mut Context<Self>) {
        if let Some(session) = self.session.clone() {
            session.update(cx, |session, cx| session.cycle_permission_mode(cx));
        }
    }

    /// Opens the file picker and drops what comes back into the message as an
    /// `@path` mention, which is how the agent is told to read a file.
    fn attach(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let paths = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: true,
            prompt: Some("Attach".into()),
        });

        cx.spawn_in(window, async move |this, cx| {
            // The channel can drop, the prompt can fail, and the user can
            // cancel. All three mean nothing was attached.
            let Ok(Ok(Some(paths))) = paths.await else {
                return;
            };
            let mention = paths
                .iter()
                .map(|path| format!("@{}", path.display()))
                .collect::<Vec<_>>()
                .join(" ");
            if mention.is_empty() {
                return;
            }

            this.update_in(cx, |this, window, cx| {
                this.composer.update(cx, |composer, cx| {
                    let current = composer.value().to_string();
                    let text = if current.trim().is_empty() {
                        format!("{mention} ")
                    } else {
                        format!("{} {mention} ", current.trim_end())
                    };
                    composer.set_value(text, window, cx);
                    composer.focus(window, cx);
                });
            })
            .ok();
        })
        .detach();
    }

    fn snapshot(&self, cx: &App) -> Option<Snapshot> {
        let session = self.session.as_ref()?.read(cx);
        let transcript = &session.transcript;

        Some(Snapshot {
            entries: transcript.entries.clone(),
            pending: transcript.pending_permission.clone(),
            state: transcript.state,
            model: transcript
                .model
                .clone()
                .map(SharedString::from)
                .unwrap_or_else(|| "Claude Code".into()),
            mode: mode_label(session.permission_mode).into(),
            branch: session.branch.clone().unwrap_or_else(|| "no branch".into()),
            project: session
                .cwd
                .file_name()
                .map(|name| SharedString::from(name.to_string_lossy().into_owned()))
                .unwrap_or_else(|| "this project".into()),
            ended: session.ended,
        })
    }
}

impl Render for TranscriptPane {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let Some(snapshot) = self.snapshot(cx) else {
            return div().size_full().into_any_element();
        };

        // Nothing said yet: the heading and the composer share the middle of the
        // stage, and there is no transcript to scroll.
        if snapshot.entries.is_empty() && snapshot.pending.is_none() {
            return v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_4()
                .p_6()
                .child(
                    div()
                        .text_lg()
                        .text_color(theme::ink())
                        .child(format!("What should we work on in {}?", snapshot.project)),
                )
                .child(
                    div()
                        .w_full()
                        .max_w(HERO_COLUMN)
                        .child(self.composer(&snapshot, cx)),
                )
                .into_any_element();
        }

        let entries = snapshot
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| render_entry(index, entry))
            .collect::<Vec<_>>();

        let allow = cx.listener(|this: &mut Self, _: &ClickEvent, _, cx| {
            if let Some(session) = this.session.clone() {
                session.update(cx, |session, cx| session.answer_permission(true, cx));
            }
        });
        let deny = cx.listener(|this: &mut Self, _: &ClickEvent, _, cx| {
            if let Some(session) = this.session.clone() {
                session.update(cx, |session, cx| session.answer_permission(false, cx));
            }
        });

        v_flex()
            .size_full()
            .child(
                v_flex()
                    .id("transcript")
                    .flex_1()
                    .items_center()
                    .overflow_y_scroll()
                    .px_6()
                    .py_4()
                    .child(
                        v_flex()
                            .w_full()
                            .max_w(COLUMN)
                            .gap_4()
                            .children(entries)
                            .when_some(snapshot.pending.clone(), |this, pending| {
                                this.child(render_permission(pending, allow, deny))
                            }),
                    ),
            )
            .child(
                v_flex().w_full().items_center().px_6().pb_3().child(
                    div()
                        .w_full()
                        .max_w(COLUMN)
                        .child(self.composer(&snapshot, cx)),
                ),
            )
            .into_any_element()
    }
}

impl TranscriptPane {
    /// The frosted panel: branch band, message, controls.
    ///
    /// Translucent rather than filled, so the wallpaper reads through it — which
    /// is the whole reason the stage has a wallpaper at all.
    fn composer(&self, snapshot: &Snapshot, cx: &mut Context<Self>) -> impl IntoElement {
        let busy = matches!(snapshot.state, TurnState::Running);
        let has_text = !self.composer.read(cx).value().trim().is_empty();

        let send = cx.listener(|this: &mut Self, _: &ClickEvent, window, cx| {
            this.submit(window, cx);
        });
        let stop = cx.listener(|this: &mut Self, _: &ClickEvent, _, cx| this.interrupt(cx));
        let attach = cx.listener(|this: &mut Self, _: &ClickEvent, window, cx| {
            this.attach(window, cx);
        });
        let cycle_mode = cx.listener(|this: &mut Self, _: &ClickEvent, _, cx| this.cycle_mode(cx));

        v_flex()
            .w_full()
            .rounded_xl()
            .overflow_hidden()
            .bg(theme::glass())
            .border_1()
            .border_color(theme::glass_border())
            .child(
                // The band says which working tree the message is about to act
                // on. That is the one fact worth spending a line on before the
                // message is even written.
                h_flex()
                    .w_full()
                    .items_center()
                    .gap_1p5()
                    .px_3()
                    .py_1()
                    .bg(theme::white(0.04))
                    .border_b_1()
                    .border_color(theme::white(0.05))
                    .text_xs()
                    .text_color(theme::faint())
                    .child(Icon::new(IconName::GitBranch).size_3().flex_shrink_0())
                    .child(div().truncate().child(snapshot.branch.clone())),
            )
            .child(
                v_flex()
                    .w_full()
                    .px_3()
                    .py_2()
                    .gap_2()
                    .child(
                        div()
                            .w_full()
                            .text_sm()
                            .text_color(theme::ink())
                            // The control draws no surface of its own; this panel
                            // is the surface.
                            .child(
                                Textarea::new(&self.composer)
                                    .appearance(false)
                                    .disabled(snapshot.ended),
                            ),
                    )
                    .child(
                        h_flex()
                            .w_full()
                            .items_center()
                            .justify_between()
                            .gap_2()
                            .child(
                                h_flex()
                                    .items_center()
                                    .gap_1()
                                    .flex_1()
                                    .overflow_hidden()
                                    .child(round_button(
                                        "attach",
                                        IconName::Plus,
                                        "Attach a file or folder",
                                        attach,
                                    ))
                                    .child(chip(
                                        "model",
                                        IconName::Sparkles,
                                        snapshot.model.clone(),
                                        None,
                                    ))
                                    .child(chip(
                                        "effort",
                                        IconName::Gauge,
                                        state_label(snapshot.state, snapshot.ended),
                                        None,
                                    ))
                                    .child(chip(
                                        "mode",
                                        IconName::Lock,
                                        snapshot.mode.clone(),
                                        Some(Box::new(cycle_mode)),
                                    )),
                            )
                            .child(if busy {
                                send_button("stop", IconName::X, true, stop).into_any_element()
                            } else {
                                send_button("send", IconName::ArrowUp, has_text, send)
                                    .into_any_element()
                            }),
                    ),
            )
    }
}

/// A chip that acts gets a chevron; one that only reports does not. The chevron
/// is the difference between a control and a label, and guessing wrong is worse
/// than either.
type OnClick = Box<dyn Fn(&ClickEvent, &mut Window, &mut App) + 'static>;

fn chip(
    id: &'static str,
    icon: IconName,
    label: impl Into<SharedString>,
    on_click: Option<OnClick>,
) -> AnyElement {
    let interactive = on_click.is_some();

    h_flex()
        .id(id)
        .items_center()
        .gap_1()
        .max_w(px(180.))
        .px_1p5()
        .py_0p5()
        .rounded_md()
        .text_xs()
        .text_color(theme::muted())
        .when(interactive, |this| {
            this.cursor_pointer()
                .hover(|style| style.bg(theme::white(0.08)).text_color(theme::ink()))
        })
        .child(Icon::new(icon).size_3().flex_shrink_0())
        .child(div().truncate().child(label.into()))
        .when_some(on_click, |this, on_click| {
            this.on_click(on_click)
                .child(Icon::new(IconName::ChevronDown).size_3().flex_shrink_0())
        })
        .into_any_element()
}

fn round_button(
    id: &'static str,
    icon: IconName,
    tooltip: &'static str,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .size_5()
        .flex_shrink_0()
        .rounded_full()
        .bg(theme::white(0.08))
        .text_color(theme::muted())
        .cursor_pointer()
        .hover(|style| style.bg(theme::white(0.14)).text_color(theme::ink()))
        .on_click(on_click)
        .tooltip(move |window, cx| Tooltip::new(tooltip).build(window, cx))
        .child(Icon::new(icon).size_3())
}

/// Lit when there is something to do — an empty composer's send button is still
/// there, just visibly inert.
fn send_button(
    id: &'static str,
    icon: IconName,
    active: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .flex()
        .items_center()
        .justify_center()
        .size_6()
        .flex_shrink_0()
        .rounded_md()
        .cursor_pointer()
        .when(active, |this| {
            this.bg(theme::white(0.85)).text_color(theme::black(0.9))
        })
        .when(!active, |this| {
            this.bg(theme::white(0.08)).text_color(theme::faint())
        })
        .hover(|style| style.opacity(0.85))
        .on_click(on_click)
        .child(Icon::new(icon).size_3p5())
}

fn state_label(state: TurnState, ended: bool) -> SharedString {
    if ended {
        return "Ended".into();
    }
    match state {
        TurnState::Running => "Working".into(),
        TurnState::AwaitingPermission => "Waiting".into(),
        TurnState::Idle => "Ready".into(),
    }
}

fn render_entry(index: usize, entry: &TranscriptEntry) -> AnyElement {
    match entry {
        // The user's turn is a right-aligned bubble; the agent's is plain text on
        // the stage. One of the two has to be the ground, and there is far more
        // agent output than user input.
        TranscriptEntry::User { text } => h_flex()
            .w_full()
            .justify_end()
            .child(
                div()
                    .max_w(relative(0.8))
                    .px_3()
                    .py_2()
                    .rounded_xl()
                    .bg(theme::white(0.1))
                    .text_sm()
                    .text_color(theme::ink())
                    .child(text.clone()),
            )
            .into_any_element(),

        TranscriptEntry::Assistant { text, streaming } => div()
            .w_full()
            .text_sm()
            .text_color(theme::ink())
            // The trailing block is the "still typing" cue. It costs nothing and
            // cannot outlive the stream the way a spinner driven by a separate
            // timer can.
            .child(if *streaming {
                format!("{text}▌")
            } else {
                text.clone()
            })
            .into_any_element(),

        TranscriptEntry::Thinking { text, .. } => div()
            .w_full()
            .text_xs()
            .italic()
            .text_color(theme::faint())
            .child(text.clone())
            .into_any_element(),

        TranscriptEntry::Tool(call) => v_flex()
            .w_full()
            .gap_1()
            .p_2()
            .rounded_lg()
            .bg(theme::white(0.04))
            .border_1()
            .border_color(theme::border())
            .child(
                h_flex()
                    .gap_2()
                    .items_center()
                    .text_xs()
                    .text_color(theme::muted())
                    .child(
                        div()
                            .text_color(theme::ink())
                            .flex_shrink_0()
                            .child(call.name.clone()),
                    )
                    .child(div().flex_1().truncate().child(call.summary()))
                    .when(call.is_running(), |this| {
                        this.child(
                            div()
                                .size_1p5()
                                .rounded_full()
                                .bg(theme::busy())
                                .flex_shrink_0(),
                        )
                    }),
            )
            .when_some(call.output.clone(), |this, output| {
                this.child(
                    div()
                        .id(("tool-output", index))
                        .max_h(px(200.))
                        .overflow_y_scroll()
                        .text_xs()
                        .text_color(if call.is_error {
                            theme::danger()
                        } else {
                            theme::faint()
                        })
                        .child(truncate(&output, 4000)),
                )
            })
            .into_any_element(),

        TranscriptEntry::Notice { text, is_error } => div()
            .w_full()
            .p_2()
            .rounded_lg()
            .text_xs()
            .bg(if *is_error {
                theme::danger().opacity(0.14)
            } else {
                theme::white(0.05)
            })
            .text_color(if *is_error {
                theme::danger()
            } else {
                theme::muted()
            })
            .child(text.clone())
            .into_any_element(),
    }
}

fn render_permission(
    pending: PendingPermission,
    allow: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
    deny: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    // Show the argument that actually says what will happen, not the whole input
    // blob — for Bash that is the command, for edits the path.
    let summary = pending
        .input
        .get("command")
        .or_else(|| pending.input.get("file_path"))
        .and_then(|value| value.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| pending.input.to_string());

    v_flex()
        .w_full()
        .p_3()
        .gap_2()
        .rounded_xl()
        .bg(theme::glass())
        .border_1()
        .border_color(theme::glass_border())
        .child(
            div()
                .text_sm()
                .text_color(theme::ink())
                .child(format!("Allow {}?", pending.tool_name)),
        )
        .child(
            div()
                .text_xs()
                .text_color(theme::muted())
                .child(truncate(&summary, 400)),
        )
        .child(
            h_flex()
                .gap_2()
                .child(answer_button("allow", "Allow", true, allow))
                .child(answer_button("deny", "Deny", false, deny)),
        )
}

fn answer_button(
    id: &'static str,
    label: &'static str,
    primary: bool,
    on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static,
) -> impl IntoElement {
    div()
        .id(id)
        .px_3()
        .py_1()
        .rounded_md()
        .text_xs()
        .cursor_pointer()
        .when(primary, |this| {
            this.bg(theme::white(0.85)).text_color(theme::black(0.9))
        })
        .when(!primary, |this| {
            this.bg(theme::white(0.08))
                .text_color(theme::ink())
                .border_1()
                .border_color(theme::glass_border())
        })
        .hover(|style| style.opacity(0.85))
        .on_click(on_click)
        .child(label)
}

/// Tool output can be megabytes; the transcript shows the head and says so.
fn truncate(text: &str, limit: usize) -> String {
    if text.len() <= limit {
        return text.to_owned();
    }
    let mut end = limit;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… {} more bytes", &text[..end], text.len() - end)
}

#[cfg(test)]
mod tests {
    use super::{state_label, truncate};
    use egant_harness::TurnState;

    #[test]
    fn truncation_keeps_the_head_and_says_what_it_dropped() {
        let text = "a".repeat(10);
        assert_eq!(truncate(&text, 20), text);
        assert!(truncate(&text, 4).starts_with("aaaa"));
        assert!(truncate(&text, 4).contains("6 more bytes"));
    }

    #[test]
    fn truncation_never_splits_a_character() {
        let text = "é".repeat(10);
        // The limit falls inside a two-byte character; the cut moves back.
        let cut = truncate(&text, 5);
        assert!(cut.starts_with("éé"));
    }

    #[test]
    fn an_ended_session_reports_ended_whatever_the_turn_says() {
        assert_eq!(state_label(TurnState::Running, true), "Ended");
        assert_eq!(state_label(TurnState::Running, false), "Working");
        assert_eq!(state_label(TurnState::Idle, false), "Ready");
    }
}
