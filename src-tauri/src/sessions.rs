//! One agent session, as the backend sees it.
//!
//! Three tasks run behind each session, and the split matters:
//!
//! - the **pump** reads the agent's stdout in the background,
//! - the **driver** owns the harness and serializes writes to it, also in the
//!   background, because every write is `async`,
//! - the **listener** folds events into the [`Transcript`] and emits them to
//!   the window as `session-event`s, so the transcript streams token by token.
//!
//! Commands reach the driver through a channel rather than a shared lock. A
//! lock would have to be held across `await` points — every send writes to a
//! pipe — and a command handler must never block on that.
//!
//! Ported from the GPUI shell's `session.rs`; the only structural change is
//! that the foreground listener emits Tauri events instead of notifying a view.

use async_channel::Sender;
use egant_harness::{
    AgentId, ClaudeCode, ClaudeOptions, CodexExec, CodexOptions, Harness, HarnessEvent,
    OpencodeOptions, OpencodeRun, PermissionDecision, PermissionMode, Transcript, TranscriptEntry,
};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::dto::{EventDto, SessionEventPayload};
use crate::state::{AppState, SessionMeta};

/// What the backend asks of a running agent.
pub enum SessionCommand {
    Send(String),
    Interrupt,
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    SetPermissionMode(PermissionMode),
    /// Only sent by [`close_session`]; dropping a session takes the other,
    /// implicit path (the channel closes, the driver exits, the harness drops
    /// and the child sees EOF).
    Shutdown,
}

impl SessionCommand {
    fn is_shutdown(&self) -> bool {
        matches!(self, Self::Shutdown)
    }
}

/// Starts an agent session in the given project, on the given agent.
///
/// A failure to spawn is not an error the caller has to handle: the session
/// still exists and shows what went wrong in its own transcript, which is
/// where the user is already looking.
pub fn spawn_session(
    app: &AppHandle,
    state: &mut AppState,
    project_id: usize,
    agent: AgentId,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
) -> Result<u64, String> {
    let project = state
        .project(project_id)
        .cloned()
        .ok_or_else(|| "unknown project".to_string())?;
    let cwd = project.fs_path();

    let count = state
        .order
        .iter()
        .filter_map(|sid| state.sessions.get(sid))
        .filter(|session| session.meta.project_id == project_id)
        .count();
    let title = if count == 0 {
        "New session".to_string()
    } else {
        format!("New session {}", count + 1)
    };

    let id = state.next_session_id;
    state.next_session_id += 1;

    let meta = SessionMeta {
        id,
        title,
        project_id,
        cwd: cwd.clone(),
        branch: branch_of(&cwd),
        started_unix_ms: unix_now_ms(),
        agent,
        model: model.clone(),
        context,
        permission_mode: PermissionMode::Auto,
        ended: false,
    };

    let harness: Box<dyn Harness> = match start_harness(agent, &cwd, model, variant, context, None) {
        Ok(harness) => harness,
        Err(error) => {
            if let Some(model) = &meta.model {
                if looks_like_a_bad_model_error(&error) {
                    state.mark_model_bad(agent, model.clone());
                }
            }
            let mut transcript = Transcript::new();
            transcript.entries.push(TranscriptEntry::Notice {
                text: format!("Could not start {}: {error}", agent.descriptor().name),
                is_error: true,
            });
            state.sessions.insert(
                id,
                crate::state::ManagedSession {
                    meta: SessionMeta { ended: true, ..meta },
                    transcript,
                    commands: None,
                },
            );
            state.order.push(id);
            state.active_session = Some(id);
            return Ok(id);
        }
    };

    // Claude's wire mints the conversation id itself rather than waiting for
    // the agent to name it, so record it before a single event arrives: a
    // session that dies during its first turn is then still resumable, which
    // is the whole point of assigning the id up front. Wires that cannot name
    // a conversation before the handshake return `None` and are unchanged.
    let mut transcript = Transcript::new();
    transcript.session_id = harness.session_id();
    let command_tx = wire_harness(app, id, harness);
    state.sessions.insert(
        id,
        crate::state::ManagedSession {
            meta,
            transcript,
            commands: Some(command_tx),
        },
    );
    state.order.push(id);
    state.active_session = Some(id);
    state.persist_session(id);
    Ok(id)
}

/// Spawns the two background tasks a running harness needs — the driver that
/// serializes writes to it, and the listener that folds its events into the
/// session's transcript and streams them to the window — and returns the
/// channel used to send it commands.
///
/// Shared by [`spawn_session`] and [`revive`]: a freshly started harness and a
/// resumed one are wired up identically from here on, they just arrive by
/// different paths.
fn wire_harness(app: &AppHandle, id: u64, harness: Box<dyn Harness>) -> Sender<SessionCommand> {
    let events = harness.events();
    let (command_tx, command_rx) = async_channel::unbounded::<SessionCommand>();

    // 1. Own the harness and serialize writes to it.
    tauri::async_runtime::spawn(async move {
        let mut harness = harness;
        while let Ok(command) = command_rx.recv().await {
            let shutdown = command.is_shutdown();
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
                SessionCommand::Shutdown => harness.shutdown().await,
            };
            if let Err(error) = result {
                log::error!("agent command failed: {error}");
            }
            if shutdown {
                break;
            }
        }
    });

    // 2. Fold events into state and stream them to the window. The only task
    // that touches the transcript.
    let listener_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            let dto = EventDto::from(&event);
            let ended = matches!(event, HarnessEvent::Exited { .. });
            // Deltas fire per token; persisting on every one would turn a
            // long reply into thousands of disk writes. Every coarser event
            // (a settled message, a tool call, a turn ending) still saves.
            let worth_persisting = !matches!(
                event,
                HarnessEvent::AssistantDelta { .. } | HarnessEvent::ThinkingDelta { .. }
            );
            {
                let app_state = listener_app.state::<Mutex<AppState>>();
                let mut guard = app_state.lock().unwrap();
                let Some(session) = guard.sessions.get_mut(&id) else {
                    break; // the session is gone
                };
                let bad_model = harness_event_error_text(&event)
                    .filter(|text| looks_like_a_bad_model_error(text))
                    .and_then(|_| session.meta.model.clone())
                    .map(|model| (session.meta.agent, model));
                session.transcript.apply(event);
                if ended {
                    session.meta.ended = true;
                }
                if let Some((agent, model)) = bad_model {
                    guard.mark_model_bad(agent, model);
                }
                if worth_persisting {
                    guard.persist_session(id);
                }
            }
            let _ = listener_app.emit(
                "session-event",
                SessionEventPayload {
                    session_id: id,
                    event: dto,
                },
            );
        }
    });

    command_tx
}

/// Restarts the agent process behind a session that is no longer running —
/// either it exited mid-run, or it was loaded from disk on app launch and
/// never had a process to begin with. Uses the transcript's own recorded
/// session id, via each agent's resume support (`claude --resume`, `codex
/// exec resume <thread>`, `opencode run -s <session>`), so the CLI picks the
/// conversation back up rather than starting over.
///
/// A reasoning-effort override chosen for the original turn is not restored:
/// `SessionMeta` never carried it (only `spawn_session`'s caller knew it),
/// so a revived session falls back to the model's default effort.
fn revive(app: &AppHandle, state: &mut AppState, id: u64) -> Result<(), String> {
    let Some(session) = state.sessions.get(&id) else {
        return Err("unknown session".to_string());
    };
    if session.commands.is_some() {
        return Ok(()); // already alive
    }
    let Some(resume_id) = session.transcript.session_id.clone() else {
        return Err(
            "this conversation never started — nothing to resume; open a new session instead"
                .to_string(),
        );
    };
    let agent = session.meta.agent;
    let cwd = session.meta.cwd.clone();
    let context = session.meta.context;

    // A session saved under a model id this build no longer recognizes would
    // otherwise be revived straight onto the wall it died against — a
    // transcript full of `unrecognized_model`, one turn at a time. Fall back
    // to the CLI's own default and say so in the transcript, rather than
    // spawning a turn that can only fail the same way.
    let stale_model = session
        .meta
        .model
        .clone()
        .filter(|model| !egant_harness::is_known_model(agent, model));
    let model = match stale_model {
        Some(_) => None,
        None => session.meta.model.clone(),
    };

    let harness = start_harness(agent, &cwd, model, None, context, Some(resume_id))?;
    let command_tx = wire_harness(app, id, harness);

    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    session.commands = Some(command_tx);
    session.meta.ended = false;
    if let Some(stale) = &stale_model {
        session.meta.model = None;
        notice(
            app,
            session,
            id,
            format!(
                "{} no longer recognizes the model this session was saved under \
                 (`{stale}`); continuing on its default model instead.",
                agent.descriptor().name
            ),
        );
    }
    if let Some(stale) = stale_model {
        // The picker greys it out for the rest of the run, so the same dead
        // id cannot be picked again by hand.
        state.mark_model_bad(agent, stale);
    }
    Ok(())
}

/// Puts a notice in a session's transcript and streams it to the window, the
/// way the listener does for the agent's own errors — for the things the app
/// itself decides, which never arrive on the event channel.
fn notice(app: &AppHandle, session: &mut crate::state::ManagedSession, id: u64, message: String) {
    let event = HarnessEvent::Error { message };
    let dto = EventDto::from(&event);
    session.transcript.apply(event);
    let _ = app.emit(
        "session-event",
        SessionEventPayload {
            session_id: id,
            event: dto,
        },
    );
}

/// Sends a turn. Echoes it into the transcript immediately so the message
/// appears on keypress rather than on the agent's first token. The frontend
/// applies the same echo locally; both folds are deterministic, so they agree.
///
/// Returns the session's new title when this turn renamed it — the first
/// message replaces the "New session" placeholder with what the session is
/// about, the way the sidebar should read it instead of "New session 3".
///
/// A session with no live process behind it — because it exited, or because
/// it was just restored from disk on launch — is revived first rather than
/// silently dropping the message: see [`revive`].
pub fn send_text(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    text: String,
) -> Result<Option<String>, String> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let needs_revive = state
        .sessions
        .get(&id)
        .is_some_and(|session| session.meta.ended && session.commands.is_none());
    if needs_revive {
        revive(app, state, id)?;
    }

    let mut new_title = None;
    {
        let Some(session) = state.sessions.get_mut(&id) else {
            return Err("unknown session".to_string());
        };
        if session.meta.ended {
            return Ok(None);
        }
        if session.transcript.entries.is_empty() && session.meta.title.starts_with("New session")
        {
            let title = derive_title(&text);
            session.meta.title = title.clone();
            new_title = Some(title);
        }
        session.transcript.push_user(text.clone());
        dispatch(session, SessionCommand::Send(text));
    }
    state.persist_session(id);
    Ok(new_title)
}

/// Turns a first message into a short session title, so the sidebar reads
/// what a session is about rather than "New session 3".
///
/// Only the first line is considered, since the rest is usually detail
/// ("fix this grid\n\nit overlaps the sidebar at 800px") rather than the
/// subject.
fn derive_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text).trim();
    let collapsed = first_line.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return "New session".to_string();
    }

    const MAX_CHARS: usize = 48;
    let mut title = if collapsed.chars().count() > MAX_CHARS {
        let truncated: String = collapsed.chars().take(MAX_CHARS).collect();
        format!("{}…", truncated.trim_end())
    } else {
        collapsed
    };

    if let Some(first) = title.chars().next() {
        let upper: String = first.to_uppercase().collect();
        title.replace_range(0..first.len_utf8(), &upper);
    }
    title
}

pub fn interrupt(state: &mut AppState, id: u64) -> Result<(), String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    dispatch(session, SessionCommand::Interrupt);
    Ok(())
}

pub fn answer_permission(state: &mut AppState, id: u64, allow: bool) -> Result<(), String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    let Some(pending) = session.transcript.pending_permission.take() else {
        return Ok(());
    };
    let decision = if allow {
        PermissionDecision::Allow {
            updated_input: None,
        }
    } else {
        PermissionDecision::Deny {
            reason: "The user declined this action.".into(),
        }
    };
    dispatch(
        session,
        SessionCommand::Permission {
            request_id: pending.request_id,
            decision,
        },
    );
    // Back to running: the agent continues once it has the answer.
    session.transcript.state = egant_harness::TurnState::Running;
    Ok(())
}

/// Steps to the next permission mode and tells the running agent.
///
/// The agent accepts this mid-conversation, so nothing restarts — the next
/// tool call is simply judged under the new mode. Returns the new mode's CLI
/// name.
pub fn cycle_permission_mode(state: &mut AppState, id: u64) -> Result<&'static str, String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    if session.meta.ended {
        return Ok(session.meta.permission_mode.as_cli_arg());
    }
    session.meta.permission_mode = next_mode(session.meta.permission_mode);
    let mode = session.meta.permission_mode;
    dispatch(session, SessionCommand::SetPermissionMode(mode));
    Ok(mode.as_cli_arg())
}

/// Jumps straight to a mode, rather than stepping through `cycle_permission_mode`
/// one click at a time — what the composer's mode-info popover uses so picking
/// a row there takes effect immediately instead of just naming the mode.
pub fn set_permission_mode(
    state: &mut AppState,
    id: u64,
    mode: PermissionMode,
) -> Result<&'static str, String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    if session.meta.ended {
        return Ok(session.meta.permission_mode.as_cli_arg());
    }
    session.meta.permission_mode = mode;
    dispatch(session, SessionCommand::SetPermissionMode(mode));
    Ok(mode.as_cli_arg())
}

pub fn close_session(state: &mut AppState, id: u64) {
    let Some(position) = state.order.iter().position(|sid| *sid == id) else {
        return;
    };
    let active_index = state
        .active_session
        .and_then(|active| state.order.iter().position(|sid| *sid == active));

    state.order.remove(position);
    if let Some(session) = state.sessions.remove(&id) {
        if let Some(commands) = session.commands {
            let _ = commands.try_send(SessionCommand::Shutdown);
        }
    }
    // Closing is still meant to forget a session for good — persistence only
    // changes what quitting the app does, not what closing a tab does.
    crate::persist::delete_session(id);

    // Keep the selection on the same visual position where possible, and never
    // leave it past the end.
    if state.active_session == Some(id) {
        state.active_session = match active_index {
            None => state.order.first().copied(),
            Some(active) if position < active => {
                state.order.get(active.saturating_sub(1)).copied()
            }
            _ => state
                .order
                .get(position.min(state.order.len().saturating_sub(1)))
                .copied(),
        };
    }
}

fn dispatch(session: &mut crate::state::ManagedSession, command: SessionCommand) {
    let Some(sender) = &session.commands else {
        return;
    };
    match sender.try_send(command) {
        Ok(()) => {}
        Err(async_channel::TrySendError::Closed(_)) => {
            // The driver stopped, so the agent is gone with it.
            session.commands = None;
            session.meta.ended = true;
        }
        Err(async_channel::TrySendError::Full(_)) => {
            log::warn!("session command queue is full; dropping a command");
        }
    }
}

/// The branch `cwd` is on, or `None` outside a repository.
fn branch_of(cwd: &Path) -> Option<String> {
    let repo = egant_vcs::Repo::discover(cwd).ok()?;
    repo.head_branch().ok().flatten()
}

/// The order the mode picker's numbered rows walk — mirrors Claude Code
/// Desktop's own ordering. `BypassPermissions` is deliberately excluded from
/// this loop: it's reached only by picking it directly, so a few quick
/// clicks (or the composer's blind-cycle chip) can never step you into the
/// mode that asks for nothing.
fn next_mode(mode: PermissionMode) -> PermissionMode {
    match mode {
        PermissionMode::Auto => PermissionMode::Manual,
        PermissionMode::Manual => PermissionMode::AcceptEdits,
        PermissionMode::AcceptEdits => PermissionMode::Plan,
        PermissionMode::Plan => PermissionMode::Auto,
        PermissionMode::BypassPermissions => PermissionMode::Auto,
    }
}

/// Starts the backend for one agent: resolves its CLI and spawns. The
/// persistent Claude wire additionally pumps stdout on the Tauri runtime;
/// the turn-based wires (`opencode run`, `codex exec`) pump themselves.
///
/// `resume` continues an earlier conversation instead of starting fresh —
/// Claude's `--resume`, Codex's `resume <thread>`, opencode's `-s <session>` —
/// used by [`revive`] to bring an ended session back with its history intact
/// rather than as a blank one under the same tab.
fn start_harness(
    agent: AgentId,
    cwd: &Path,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
    resume: Option<String>,
) -> Result<Box<dyn Harness>, String> {
    let cwd = cwd.to_path_buf();
    match agent {
        AgentId::Claude => {
            let (harness, pump) = ClaudeCode::spawn(ClaudeOptions {
                program: resolve_cli(agent)?,
                cwd,
                model,
                effort: variant,
                // Claude judges each action itself, asking through the UI's
                // permission prompt only when it decides to. Matches Claude
                // Code Desktop's own default mode.
                permission_mode: PermissionMode::Auto,
                // Streaming is the whole point of the transcript pane.
                stream_partial: true,
                resume,
                ..ClaudeOptions::default()
            })
            .map_err(|error| error.to_string())?;
            tauri::async_runtime::spawn(pump.run());
            Ok(Box::new(harness))
        }
        AgentId::Codex => CodexExec::spawn(CodexOptions {
            program: resolve_cli(agent)?,
            cwd,
            model,
            context_window: context,
            reasoning_effort: variant,
            thread: resume,
            // New sessions always start in `Auto`, matching `SessionMeta`;
            // `set_permission_mode`/`cycle_permission_mode` update it live
            // from here on.
            permission_mode: PermissionMode::Auto,
        })
        .map(|harness| Box::new(harness) as Box<dyn Harness>)
        .map_err(|error| error.to_string()),
        AgentId::Opencode => OpencodeRun::spawn(OpencodeOptions {
            program: resolve_cli(agent)?,
            cwd,
            model,
            variant,
            session: resume,
        })
        .map(|harness| Box::new(harness) as Box<dyn Harness>)
        .map_err(|error| error.to_string()),
        other => {
            let descriptor = other.descriptor();
            Err(if resolve_cli(other).is_ok() {
                format!(
                    "{} sessions aren't drivable yet — Claude, Codex and OpenCode are.",
                    descriptor.name
                )
            } else {
                descriptor.install_hint.to_string()
            })
        }
    }
}

/// Resolves the agent's CLI the way detection does, or explains how to fix it.
fn resolve_cli(agent: AgentId) -> Result<PathBuf, String> {
    let descriptor = agent.descriptor();
    egant_harness::agents::resolve_executable(descriptor)
        .ok_or_else(|| descriptor.install_hint.to_string())
}

/// The message text of an event that reports a failed turn, if any — an
/// `Error` event always carries one; a `TurnEnded` only when that turn
/// itself failed. Everything else (deltas, tool events, a clean turn end)
/// has nothing worth checking.
fn harness_event_error_text(event: &HarnessEvent) -> Option<&str> {
    match event {
        HarnessEvent::Error { message } => Some(message.as_str()),
        HarnessEvent::TurnEnded {
            is_error: true,
            result: Some(result),
            ..
        } => Some(result.as_str()),
        _ => None,
    }
}

/// Whether an error's text names the model itself as the problem — a bad id,
/// or a real model this account's plan/tier can't run — rather than
/// something transient (a network blip, an interrupted turn) that says
/// nothing about whether the model works. Deliberately narrow: these are the
/// exact phrases seen from live-testing `claude`/`codex`'s own catalogs (see
/// `crates/harness/src/models.rs`'s doc comments), not a guess at every way a
/// turn can fail. A false negative here just means a model has to fail twice
/// before the picker remembers it; a false positive would grey out a model
/// that actually works, which is the worse mistake.
fn looks_like_a_bad_model_error(message: &str) -> bool {
    const NEEDLES: &[&str] = &[
        "model_not_found",
        "unrecognized_model",
        "isn't described by this version's model catalog",
        "model metadata for",
        "not supported when using codex",
    ];
    let lower = message.to_lowercase();
    NEEDLES.iter().any(|needle| lower.contains(needle))
}

fn unix_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[allow(dead_code)]
fn _sender_is_send() {
    fn assert_send<T: Send>() {}
    assert_send::<Sender<SessionCommand>>();
}

#[cfg(test)]
mod tests {
    use super::{derive_title, harness_event_error_text, looks_like_a_bad_model_error};
    use egant_harness::HarnessEvent;

    #[test]
    fn bad_model_wording_is_recognized_case_insensitively() {
        assert!(looks_like_a_bad_model_error(
            "model_not_found: There's an issue with the selected model (sonnet-5)."
        ));
        assert!(looks_like_a_bad_model_error(
            "\"fable-5.1\" isn't described by this version's model catalog"
        ));
        assert!(looks_like_a_bad_model_error(
            "The 'gpt-5.4' model is NOT SUPPORTED when using Codex with a ChatGPT account."
        ));
        assert!(looks_like_a_bad_model_error("Model metadata for `gpt-5.4-mini` not found."));
    }

    #[test]
    fn unrelated_failures_are_not_mistaken_for_a_bad_model() {
        assert!(!looks_like_a_bad_model_error("request timed out"));
        assert!(!looks_like_a_bad_model_error("the turn was interrupted"));
        assert!(!looks_like_a_bad_model_error("rate limit exceeded, try again later"));
    }

    #[test]
    fn error_text_extracts_from_error_and_failed_turn_events_only() {
        assert_eq!(
            harness_event_error_text(&HarnessEvent::Error {
                message: "model_not_found".into()
            }),
            Some("model_not_found")
        );
        assert_eq!(
            harness_event_error_text(&HarnessEvent::TurnEnded {
                result: Some("model_not_found".into()),
                is_error: true,
                duration_ms: 0,
                cost_usd: 0.0,
                usage: egant_harness::TurnUsage::default(),
            }),
            Some("model_not_found")
        );
        // A turn that succeeded, or one that failed with no message, has
        // nothing to check.
        assert_eq!(
            harness_event_error_text(&HarnessEvent::TurnEnded {
                result: None,
                is_error: false,
                duration_ms: 0,
                cost_usd: 0.0,
                usage: egant_harness::TurnUsage::default(),
            }),
            None
        );
        assert_eq!(
            harness_event_error_text(&HarnessEvent::AssistantDelta { text: "hi".into() }),
            None
        );
    }

    #[test]
    fn titles_come_from_the_first_message() {
        assert_eq!(derive_title("fix this grid"), "Fix this grid");
        assert_eq!(
            derive_title("fix this grid\n\nit overlaps the sidebar at 800px"),
            "Fix this grid"
        );
    }

    #[test]
    fn titles_truncate_long_messages_at_a_word_boundary() {
        let text = "please refactor the entire authentication and session \
                     handling layer to use a new token format";
        let title = derive_title(text);
        assert!(title.chars().count() <= 49, "{title}");
        assert!(title.ends_with('…'));
        assert!(!title.ends_with(" …"), "should trim before the ellipsis: {title}");
    }

    #[test]
    fn a_blank_message_falls_back_to_the_default_title() {
        assert_eq!(derive_title("   \n  "), "New session");
    }
}
