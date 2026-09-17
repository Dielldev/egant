//! One agent session, as the UI sees it.
//!
//! Three tasks run behind each session, and the split matters:
//!
//! - the **pump** reads the agent's stdout on a background thread,
//! - the **driver** owns the [`Harness`] and applies commands to it, also in the
//!   background, because every write is `async`,
//! - the **listener** runs on the foreground and is the only one that touches
//!   entity state, folding events into the [`Transcript`] and calling `notify`.
//!
//! Commands reach the driver through a channel rather than a shared lock. A
//! lock would have to be held across `await` points — every send writes to a
//! pipe — and the UI thread must never block on that.

use crate::project::ProjectId;
use async_channel::{Sender, TrySendError};
use egant_harness::{
    ClaudeCode, ClaudeOptions, Harness, HarnessEvent, PermissionDecision, PermissionMode,
    Transcript, TranscriptEntry, TurnState,
};
use gpui_kit::*;
use std::path::PathBuf;
use std::time::Instant;

/// What the UI asks of a running agent.
pub enum SessionCommand {
    Send(String),
    Interrupt,
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    SetPermissionMode(PermissionMode),
    /// Only sent by [`AgentSession::shutdown`]; dropping a session takes the
    /// other, implicit path described there.
    Shutdown,
}

pub struct AgentSession {
    pub title: SharedString,
    pub cwd: PathBuf,
    /// Which project this session belongs to.
    pub project: ProjectId,
    /// Branch the working directory is on, read once at startup. Shown under the
    /// session's name the way a terminal prompt shows it.
    pub branch: Option<SharedString>,
    /// When the session started, for the relative age in the sidebar.
    pub started: Instant,
    /// How much freedom the agent has. Mirrors what the driver last sent, so the
    /// composer's mode chip reads the same value the agent is running under.
    pub permission_mode: PermissionMode,
    pub transcript: Transcript,
    /// Set once the agent is gone; the composer disables itself.
    pub ended: bool,
    commands: Option<Sender<SessionCommand>>,
    /// Held, not detached: dropping the session must stop its tasks.
    _tasks: Vec<Task<()>>,
}

impl AgentSession {
    /// Starts an agent in `cwd`.
    ///
    /// A failure to spawn is not an error the caller has to handle: the session
    /// still exists and shows what went wrong in its own transcript, which is
    /// where the user is already looking.
    pub fn new(
        title: impl Into<SharedString>,
        project: ProjectId,
        options: ClaudeOptions,
        cx: &mut Context<Self>,
    ) -> Self {
        let title = title.into();
        let cwd = options.cwd.clone();
        let permission_mode = options.permission_mode;
        let branch = branch_of(&cwd);
        let started = Instant::now();
        let mut transcript = Transcript::new();

        let (harness, pump) = match ClaudeCode::spawn(options) {
            Ok(parts) => parts,
            Err(error) => {
                transcript.entries.push(TranscriptEntry::Notice {
                    text: format!(
                        "Could not start the agent: {error}\n\
                         Check that `claude` is on your PATH, then start a new session."
                    ),
                    is_error: true,
                });
                return Self {
                    title,
                    cwd,
                    project,
                    branch,
                    started,
                    permission_mode,
                    transcript,
                    ended: true,
                    commands: None,
                    _tasks: Vec::new(),
                };
            }
        };

        let events = harness.events();
        let (command_tx, command_rx) = async_channel::unbounded::<SessionCommand>();

        // 1. Read the agent's output.
        let pump_task = cx.background_executor().spawn(pump.run());

        // 2. Own the harness and serialize writes to it.
        let driver_task = cx.background_executor().spawn(async move {
            let mut harness = harness;
            while let Ok(command) = command_rx.recv().await {
                let result = match command {
                    SessionCommand::Send(text) => harness.send(text).await,
                    SessionCommand::Interrupt => harness.interrupt().await,
                    SessionCommand::Permission {
                        request_id,
                        decision,
                    } => harness.respond_permission(&request_id, decision).await,
                    SessionCommand::SetPermissionMode(mode) => {
                        harness.set_permission_mode(mode).await
                    }
                    SessionCommand::Shutdown => {
                        let _ = harness.shutdown().await;
                        break;
                    }
                };
                if let Err(error) = result {
                    log::error!("agent command failed: {error}");
                }
            }
        });

        // 3. Fold events into state. The only task allowed to touch `self`.
        let listener_task = cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                let ended = matches!(event, HarnessEvent::Exited { .. });
                let updated = this.update(cx, |this, cx| {
                    this.transcript.apply(event);
                    if ended {
                        this.ended = true;
                    }
                    cx.notify();
                });
                if updated.is_err() {
                    break; // the session entity is gone
                }
            }
        });

        Self {
            title,
            cwd,
            project,
            branch,
            started,
            permission_mode,
            transcript,
            ended: false,
            commands: Some(command_tx),
            _tasks: vec![pump_task, driver_task, listener_task],
        }
    }

    /// How long this session has been open, as the sidebar writes it: `5m`,
    /// `9h`, `2d`.
    pub fn age_label(&self) -> String {
        age_label(self.started.elapsed())
    }

    /// Sends a turn. Echoes it into the transcript immediately so the message
    /// appears on keypress rather than on the agent's first token.
    pub fn send(&mut self, text: impl Into<String>, cx: &mut Context<Self>) {
        let text = text.into();
        if text.trim().is_empty() || self.ended {
            return;
        }
        self.transcript.push_user(text.clone());
        self.dispatch(SessionCommand::Send(text));
        cx.notify();
    }

    /// Steps to the next permission mode and tells the running agent.
    ///
    /// The agent accepts this mid-conversation, so nothing restarts — the next
    /// tool call is simply judged under the new mode.
    pub fn cycle_permission_mode(&mut self, cx: &mut Context<Self>) {
        if self.ended {
            return;
        }
        self.permission_mode = next_mode(self.permission_mode);
        self.dispatch(SessionCommand::SetPermissionMode(self.permission_mode));
        cx.notify();
    }

    pub fn interrupt(&mut self, cx: &mut Context<Self>) {
        self.dispatch(SessionCommand::Interrupt);
        cx.notify();
    }

    pub fn answer_permission(&mut self, allow: bool, cx: &mut Context<Self>) {
        let Some(pending) = self.transcript.pending_permission.take() else {
            return;
        };
        let decision = if allow {
            PermissionDecision::Allow {
                // Echo the original input: an `allow` without `updatedInput`
                // reads as a deny on older CLIs.
                updated_input: Some(pending.input.clone()),
            }
        } else {
            PermissionDecision::Deny {
                reason: "The user declined this action.".into(),
            }
        };
        self.dispatch(SessionCommand::Permission {
            request_id: pending.request_id,
            decision,
        });
        // Back to running: the agent continues once it has the answer.
        self.transcript.state = TurnState::Running;
        cx.notify();
    }

    /// Ends the session deliberately, before it is dropped.
    ///
    /// Dropping an `AgentSession` already stops the agent — the driver task goes
    /// with it, dropping the harness and closing the child's stdin, which the
    /// CLI treats as "finish and exit". This exists for the case where the user
    /// stops a session but the view stays on screen, which the UI does not offer
    /// yet.
    #[allow(
        dead_code,
        reason = "wired up when sessions can be closed individually"
    )]
    pub fn shutdown(&mut self) {
        self.dispatch(SessionCommand::Shutdown);
        self.ended = true;
    }

    fn dispatch(&mut self, command: SessionCommand) {
        let Some(sender) = &self.commands else {
            return;
        };
        match sender.try_send(command) {
            Ok(()) => {}
            Err(TrySendError::Closed(_)) => {
                // The driver stopped, so the agent is gone with it.
                self.commands = None;
                self.ended = true;
            }
            Err(TrySendError::Full(_)) => {
                log::warn!("session command queue is full; dropping a command");
            }
        }
    }
}

/// The branch `cwd` is on, or `None` outside a repository.
///
/// Read through `egant-vcs` rather than a `git` subprocess so opening a session
/// never waits on a process spawn.
fn branch_of(cwd: &std::path::Path) -> Option<SharedString> {
    let repo = egant_vcs::Repo::discover(cwd).ok()?;
    repo.head_branch().ok().flatten().map(SharedString::from)
}

/// The order the composer's mode chip walks, loosest last so a click never
/// jumps straight from asking about everything to asking about nothing.
fn next_mode(mode: PermissionMode) -> PermissionMode {
    match mode {
        PermissionMode::Default => PermissionMode::Plan,
        PermissionMode::Plan => PermissionMode::AcceptEdits,
        PermissionMode::AcceptEdits => PermissionMode::BypassPermissions,
        PermissionMode::BypassPermissions => PermissionMode::Default,
    }
}

/// What the mode chip reads, in the user's terms rather than the CLI's.
pub fn mode_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "Supervised",
        PermissionMode::Plan => "Plan only",
        PermissionMode::AcceptEdits => "Auto-edit",
        PermissionMode::BypassPermissions => "Unsupervised",
    }
}

fn age_label(elapsed: std::time::Duration) -> String {
    let seconds = elapsed.as_secs();
    match seconds {
        0..=59 => "now".to_string(),
        60..=3599 => format!("{}m", seconds / 60),
        3600..=86_399 => format!("{}h", seconds / 3600),
        _ => format!("{}d", seconds / 86_400),
    }
}

/// Default options for a session rooted at `cwd`.
pub fn default_options(cwd: PathBuf) -> ClaudeOptions {
    ClaudeOptions {
        cwd,
        // Streaming is the whole point of the transcript pane.
        stream_partial: true,
        // Ask before acting. The UI has a prompt for it; bypassing would make
        // the agent act on a repository without the user seeing the request.
        permission_mode: PermissionMode::Default,
        ..ClaudeOptions::default()
    }
}

#[cfg(test)]
mod tests {
    use super::{age_label, mode_label, next_mode};
    use egant_harness::PermissionMode;
    use std::time::Duration;

    #[test]
    fn ages_read_the_way_the_sidebar_writes_them() {
        assert_eq!(age_label(Duration::from_secs(5)), "now");
        assert_eq!(age_label(Duration::from_secs(300)), "5m");
        assert_eq!(age_label(Duration::from_secs(60 * 59)), "59m");
        assert_eq!(age_label(Duration::from_secs(3600 * 9)), "9h");
        assert_eq!(age_label(Duration::from_secs(86_400 * 2)), "2d");
    }

    #[test]
    fn cycling_the_mode_visits_every_one_and_returns() {
        let mut mode = PermissionMode::Default;
        let mut seen = Vec::new();
        for _ in 0..4 {
            seen.push(mode);
            mode = next_mode(mode);
        }
        assert_eq!(mode, PermissionMode::Default, "the cycle closes");
        assert_eq!(seen.len(), 4);
        seen.dedup();
        assert_eq!(seen.len(), 4, "every mode appears once");
    }

    #[test]
    fn every_mode_has_a_label() {
        for mode in [
            PermissionMode::Default,
            PermissionMode::Plan,
            PermissionMode::AcceptEdits,
            PermissionMode::BypassPermissions,
        ] {
            assert!(!mode_label(mode).is_empty());
        }
    }

    #[test]
    fn the_minute_and_hour_boundaries_do_not_overlap() {
        assert_eq!(age_label(Duration::from_secs(59)), "now");
        assert_eq!(age_label(Duration::from_secs(60)), "1m");
        assert_eq!(age_label(Duration::from_secs(3599)), "59m");
        assert_eq!(age_label(Duration::from_secs(3600)), "1h");
    }
}
