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
use crate::worktrees::SessionWorktree;

/// What the backend asks of a running agent.
pub enum SessionCommand {
    Send(String, Vec<PathBuf>),
    Interrupt,
    Permission {
        request_id: String,
        decision: PermissionDecision,
    },
    /// opencode's `--auto` for the next turn only (Allow once).
    ApproveNextTurn,
    /// opencode's `--auto` from here on (Allow always).
    ApproveAlways,
    SetPermissionMode(PermissionMode),
    /// Only sent by [`close_session`]; dropping a session takes the other,
    /// implicit path (the channel closes, the driver exits, the harness drops
    /// and the child sees EOF).
    Shutdown,
}

/// How the user answered one row of the permission table.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionAnswer {
    AllowOnce,
    AllowAlways,
    Deny,
}

impl PermissionAnswer {
    pub fn from_str_name(name: &str) -> Option<Self> {
        match name {
            "allow" | "allow-once" | "once" => Some(PermissionAnswer::AllowOnce),
            "allow-always" | "always" => Some(PermissionAnswer::AllowAlways),
            "deny" | "reject" => Some(PermissionAnswer::Deny),
            _ => None,
        }
    }
}

impl SessionCommand {
    fn is_shutdown(&self) -> bool {
        matches!(self, Self::Shutdown)
    }
}

/// Short name for driver logging (never includes message text).
fn command_name(command: &SessionCommand) -> &'static str {
    match command {
        SessionCommand::Send(..) => "send",
        SessionCommand::Interrupt => "interrupt",
        SessionCommand::Permission { .. } => "permission",
        SessionCommand::ApproveNextTurn => "approve-next-turn",
        SessionCommand::ApproveAlways => "approve-always",
        SessionCommand::SetPermissionMode(_) => "set-permission-mode",
        SessionCommand::Shutdown => "shutdown",
    }
}

/// Starts an agent session in the given project, on the given agent.
///
/// A failure to spawn is not an error the caller has to handle: the session
/// still exists and shows what went wrong in its own transcript, which is
/// where the user is already looking.
///
/// `worktree` is an isolated checkout already cut for this session (see
/// [`crate::worktrees`]); when there is one the agent runs there instead of in
/// the project folder, and so does everything that follows the session's
/// working directory.
pub fn spawn_session(
    app: &AppHandle,
    state: &mut AppState,
    project_id: usize,
    agent: AgentId,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
    worktree: Option<SessionWorktree>,
) -> Result<u64, String> {
    let project = state
        .project(project_id)
        .cloned()
        .ok_or_else(|| "unknown project".to_string())?;
    // Verify before spawning: a project whose folder vanished (moved, deleted)
    // must fail here with a readable notice, not spawn the agent in a stale
    // directory where it answers with the wrong folder.
    let cwd = crate::project::verify_project_path(&project.fs_path())?;
    // The worktree is where the session actually runs. The project keeps
    // naming the session in the sidebar, but every path below — the agent's
    // own working directory included — is the checkout's.
    let cwd = match &worktree {
        Some(worktree) => worktree.path.clone(),
        None => cwd,
    };
    let project_name = project.name.clone();

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
        branch: worktree
            .as_ref()
            .map(|worktree| worktree.branch.clone())
            .or_else(|| branch_of(&cwd)),
        started_unix_ms: unix_now_ms(),
        agent,
        cli_agent: None,
        model: model.clone(),
        context,
        permission_mode: PermissionMode::Auto,
        worktree,
        ended: false,
    };

    let harness: Box<dyn Harness> = match start_harness(
        agent,
        &cwd,
        &project_name,
        model,
        variant,
        context,
        None,
        egant_harness::PermissionMode::Auto,
    ) {
        Ok(harness) => harness,
        Err(error) => {
            log::error!(
                "session spawn failed agent={} cwd={} model={:?}: {error}",
                agent.as_str(),
                cwd.display(),
                meta.model,
            );
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
                    meta: SessionMeta {
                        ended: true,
                        ..meta
                    },
                    transcript,
                    commands: None,
                    allowed_patterns: Vec::new(),
                    last_user_text: None,
                    last_user_images: Vec::new(),
                    turn_baseline: None,
                },
            );
            state.order.push(id);
            state.active_session = Some(id);
            state.active_project = Some(project_id);
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
            allowed_patterns: Vec::new(),
            last_user_text: None,
            last_user_images: Vec::new(),
            turn_baseline: None,
        },
    );
    state.order.push(id);
    state.active_session = Some(id);
    // A new session always belongs to the project it was spawned in: without
    // this the header (session's project) and the sidebar (selected project)
    // can name two different folders after a programmatic spawn.
    state.active_project = Some(project_id);
    state.persist_session(id);
    log::info!(
        "spawned session {id} agent={} cwd={}",
        agent.as_str(),
        cwd.display(),
    );
    Ok(id)
}

/// Opens a session that *is* an agent's own CLI, in the given project.
///
/// Nothing is spawned here. A CLI session has no harness, no driver and no
/// listener — its whole content is a terminal the frontend opens onto the
/// agent's binary (`pty_spawn_agent`), which is also what lets the process
/// live and die with the view rather than with this record. What the backend
/// owns is the row itself: the sidebar entry, the project it belongs to, the
/// working directory the panel's files and git read from, and the fact that
/// it survives a relaunch.
///
/// The CLI is resolved up front so an agent that isn't installed fails here,
/// as an error the picker can show, instead of opening an empty terminal
/// that immediately says "command not found".
pub fn spawn_cli_session(
    state: &mut AppState,
    project_id: usize,
    agent: &str,
    worktree: Option<SessionWorktree>,
) -> Result<u64, String> {
    log::info!("spawn cli session agent={agent} project={project_id}");
    let launch = egant_harness::catalog::launch(agent).map_err(|error| {
        log::error!("cli session agent={agent} failed to resolve: {error}");
        error
    })?;
    let project = state
        .project(project_id)
        .cloned()
        .ok_or_else(|| "unknown project".to_string())?;
    let cwd = crate::project::verify_project_path(&project.fs_path())?;
    // As for a chat session: the terminal opens in the checkout, so the CLI
    // the user drives by hand is on the same branch as everything else the
    // session shows.
    let cwd = match &worktree {
        Some(worktree) => worktree.path.clone(),
        None => cwd,
    };

    // Numbered per agent, not per project: "Pi CLI" beside "Claude Code CLI"
    // reads as two different things, which is what they are.
    let count = state
        .order
        .iter()
        .filter_map(|sid| state.sessions.get(sid))
        .filter(|session| {
            session.meta.project_id == project_id
                && session.meta.cli_agent.as_deref() == Some(launch.id)
        })
        .count();
    let title = if count == 0 {
        format!("{} CLI", launch.name)
    } else {
        format!("{} CLI {}", launch.name, count + 1)
    };

    let id = state.next_session_id;
    state.next_session_id += 1;

    let meta = SessionMeta {
        id,
        title,
        project_id,
        cwd: cwd.clone(),
        branch: worktree
            .as_ref()
            .map(|worktree| worktree.branch.clone())
            .or_else(|| branch_of(&cwd)),
        started_unix_ms: unix_now_ms(),
        // Placeholder. `cli_agent` is what every reader of a CLI session
        // actually looks at — see [`crate::state::SessionMeta::cli_agent`].
        agent: AgentId::from_str(launch.id).unwrap_or(AgentId::Claude),
        cli_agent: Some(launch.id.to_string()),
        model: None,
        context: None,
        permission_mode: PermissionMode::Auto,
        worktree,
        // Live for as long as the row exists: "ended" is a statement about a
        // harness, and there isn't one. The terminal reports its own CLI's
        // exit, in the terminal, where it happened.
        ended: false,
    };

    state.sessions.insert(
        id,
        crate::state::ManagedSession {
            meta,
            transcript: Transcript::new(),
            commands: None,
            allowed_patterns: Vec::new(),
            last_user_text: None,
            last_user_images: Vec::new(),
            turn_baseline: None,
        },
    );
    state.order.push(id);
    state.active_session = Some(id);
    state.active_project = Some(project_id);
    state.persist_session(id);
    log::info!(
        "spawned cli session {id} agent={} cwd={}",
        launch.id,
        cwd.display()
    );
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
            log::debug!("session {id} driver: {}", command_name(&command));
            let result = match command {
                SessionCommand::Send(text, images) => harness.send(text, images).await,
                SessionCommand::Interrupt => harness.interrupt().await,
                SessionCommand::Permission {
                    request_id,
                    decision,
                } => harness.respond_permission(&request_id, decision).await,
                SessionCommand::ApproveNextTurn => harness.approve_next_turn().await,
                SessionCommand::ApproveAlways => harness.approve_always().await,
                SessionCommand::SetPermissionMode(mode) => harness.set_permission_mode(mode).await,
                SessionCommand::Shutdown => harness.shutdown().await,
            };
            if let Err(error) = result {
                log::error!("session {id} agent command failed: {error}");
            }
            if shutdown {
                log::info!("session {id} driver shutdown");
                break;
            }
        }
    });

    // 2. Fold events into state and stream them to the window. The only task
    // that touches the transcript.
    let listener_app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok(event) = events.recv().await {
            log_harness_event(id, &event);
            let dto = EventDto::from(&event);
            let ended = matches!(event, HarnessEvent::Exited { .. });
            // The agent's handshake names the directory it actually runs in.
            // A mismatch against the session's folder is exactly the "wrong
            // project" bug surfacing — log it so it is diagnosable instead of
            // a model confidently naming the wrong folder.
            if let HarnessEvent::Ready {
                cwd: Some(reported),
                ..
            } = &event
            {
                let app_state = listener_app.state::<Mutex<AppState>>();
                if let Ok(guard) = app_state.lock() {
                    if let Some(session) = guard.sessions.get(&id) {
                        let expected = crate::project::canonicalize_path(&session.meta.cwd);
                        let actual = crate::project::canonicalize_path(reported);
                        if expected != actual {
                            log::warn!(
                                "session {id} runs in {} but the agent reports {}",
                                expected.display(),
                                actual.display()
                            );
                        }
                    }
                }
            }
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
                // An "Allow always" answer remembers patterns for the run. A
                // live-channel request (Claude) matching one is approved
                // without ever reaching the table — otherwise "always" would
                // ask again every turn. Turn-based denials (opencode) are
                // always shown: approval there means retrying with `--auto`,
                // which the user triggers per table, not silently.
                // Bypassed sessions never reach here: the CLI stops asking
                // once `bypassPermissions` lands, so this is only the
                // pattern-remembered fallback for sessions that haven't
                // flipped yet.
                let auto_approved: Option<(String, String, serde_json::Value)> = match &event {
                    HarnessEvent::PermissionRequest {
                        request_id,
                        tool_name,
                        patterns,
                        input,
                        ..
                    } if session.meta.agent != AgentId::Opencode
                        && matches_allowlist(patterns, tool_name, &session.allowed_patterns) =>
                    {
                        Some((request_id.clone(), tool_name.clone(), input.clone()))
                    }
                    _ => None,
                };
                if let Some((request_id, tool_name, input)) = auto_approved {
                    log::info!("session {id} auto-approved {tool_name} (remembered pattern)");
                    session.transcript.apply(event);
                    dispatch(
                        session,
                        SessionCommand::Permission {
                            request_id: request_id.clone(),
                            decision: PermissionDecision::Allow {
                                // Echo the original input: an `allow` without
                                // `updatedInput` reads as a deny on older CLIs.
                                updated_input: Some(input),
                            },
                        },
                    );
                    session.transcript.resolve_permission(&request_id);
                    if worth_persisting {
                        guard.persist_session(id);
                    }
                    continue; // swallowed: the table never sees it
                }
                let error_text = harness_event_error_text(&event);
                let bad_model = error_text
                    .filter(|text| looks_like_a_bad_model_error(text))
                    .and_then(|_| session.meta.model.clone())
                    .map(|model| (session.meta.agent, model));
                // Asking for the million-token window is this app's default,
                // so a refusal has to teach it something — otherwise every
                // session with that model would walk into the same wall.
                let denied_wide_window = error_text
                    .filter(|text| looks_like_a_long_context_rejection(text))
                    .and_then(|_| session.meta.model.clone());
                session.transcript.apply(event);
                if ended {
                    session.meta.ended = true;
                }
                if let Some((agent, model)) = bad_model {
                    guard.mark_model_bad(agent, model);
                }
                if let Some(model) = denied_wide_window {
                    egant_harness::models::deny_wide_context(&model);
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

/// One line per meaningful harness event: lifecycle at info, tool traffic at
/// debug, per-token deltas skipped (they fire per token and would flood the
/// console). Long text is truncated — the transcript holds the full content.
fn log_harness_event(id: u64, event: &HarnessEvent) {
    match event {
        HarnessEvent::Ready { model, cwd, .. } => {
            log::info!(
                "session {id} ready model={} cwd={}",
                model.as_deref().unwrap_or("-"),
                cwd.as_ref()
                    .map(|p| p.display().to_string())
                    .unwrap_or_default(),
            );
        }
        HarnessEvent::TurnEnded {
            result,
            is_error,
            duration_ms,
            cost_usd,
            ..
        } => {
            if *is_error {
                log::error!(
                    "session {id} turn failed after {duration_ms}ms: {}",
                    truncate_event_text(result.as_deref().unwrap_or("unknown error")),
                );
            } else {
                log::info!("session {id} turn ended in {duration_ms}ms (${cost_usd:.4})");
            }
        }
        HarnessEvent::Error { message } => {
            log::error!("session {id} error: {}", truncate_event_text(message));
        }
        HarnessEvent::Exited { code } => {
            log::info!("session {id} exited code={code:?}");
        }
        HarnessEvent::PermissionRequest { tool_name, .. } => {
            log::info!("session {id} permission request: {tool_name}");
        }
        HarnessEvent::ToolUse { name, .. } => {
            log::debug!("session {id} tool use: {name}");
        }
        HarnessEvent::ToolResult {
            id: tool_id,
            is_error,
            ..
        } => {
            log::debug!("session {id} tool result {tool_id} error={is_error}");
        }
        HarnessEvent::AssistantMessage { text } => {
            log::debug!("session {id} assistant message ({} chars)", text.len());
        }
        // AssistantDelta / ThinkingDelta: per token, never logged.
        _ => {}
    }
}

fn truncate_event_text(text: &str) -> String {
    const MAX: usize = 300;
    let flat: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if flat.len() <= MAX {
        return flat;
    }
    format!("{}…", flat.chars().take(MAX).collect::<String>())
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
    let saved_mode = session.meta.permission_mode;
    log::info!(
        "reviving session {id} agent={} resume={}",
        agent.as_str(),
        resume_id
    );
    // Revival must run where the session always ran — and say so. The project
    // row is the source of the display name; the session's own `cwd` is the
    // source of the directory, so a session whose folder vanished revives in
    // its project rather than in a deleted directory.
    let project_name = state
        .project(session.meta.project_id)
        .map(|p| p.name.clone())
        .unwrap_or_else(|| egant_harness::project_display_name(&cwd));
    let cwd = if cwd.is_dir() {
        crate::project::canonicalize_path(&cwd)
    } else if let Some(project) = state.project(session.meta.project_id) {
        project.fs_path()
    } else {
        cwd
    };

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

    let harness = start_harness(
        agent,
        &cwd,
        &project_name,
        model,
        None,
        context,
        Some(resume_id),
        saved_mode,
    )
    .map_err(|error| {
        log::error!("revive session {id} failed: {error}");
        error
    })?;
    let command_tx = wire_harness(app, id, harness);
    log::info!("revived session {id}");

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
    images: Vec<PathBuf>,
) -> Result<Option<String>, String> {
    if text.trim().is_empty() && images.is_empty() {
        return Ok(None);
    }
    // An image-only turn still needs something in the bubble — an empty one
    // would look broken — and a short caption gives the model a framing for
    // the vision blocks alongside it rather than nothing at all.
    let text = if text.trim().is_empty() {
        if images.len() == 1 {
            "Here's an image.".to_string()
        } else {
            format!("Here are {} images.", images.len())
        }
    } else {
        text
    };
    log::info!(
        "send to session {id} ({} chars, {} image(s))",
        text.len(),
        images.len()
    );
    // A CLI session's input goes to its terminal, not through here. Without
    // this it would look revivable (no command channel) and `revive` would
    // start a *second*, harness-driven agent behind a view that shows a
    // terminal — a turn running somewhere the user cannot see.
    if let Some(session) = state.sessions.get(&id) {
        if let Some(agent) = &session.meta.cli_agent {
            return Err(format!(
                "this session runs the {agent} CLI — type into its terminal instead"
            ));
        }
        // Verify the folder still exists before sending: a session whose
        // directory vanished (moved, deleted) must say so instead of letting
        // the agent answer from a stale directory as the wrong project.
        if !session.meta.cwd.is_dir() {
            // The project may still exist under its canonical path (symlink
            // swing, rename back) — re-resolve through it before failing.
            let fallback = state.project(session.meta.project_id).map(|p| p.fs_path());
            let recovered = fallback.filter(|p| p.is_dir());
            if let Some(path) = recovered {
                if let Some(session) = state.sessions.get_mut(&id) {
                    // A worktree that is no longer on disk was removed from
                    // somewhere egant doesn't watch. The session carries on in
                    // its project folder, and stops claiming a branch it is no
                    // longer on — the header's chip reads `meta.worktree`.
                    if let Some(worktree) = session.meta.worktree.take() {
                        log::info!(
                            "session {id} lost its worktree at {} — continuing in {}",
                            worktree.path.display(),
                            path.display()
                        );
                        session.meta.branch = branch_of(&path);
                    }
                    session.meta.cwd = path;
                }
            } else {
                return Err(format!(
                    "this session's folder no longer exists ({})",
                    session.meta.cwd.display()
                ));
            }
        }
    }
    let needs_revive = state
        .sessions
        .get(&id)
        .is_some_and(|session| session.meta.ended && session.commands.is_none());
    if needs_revive {
        revive(app, state, id)?;
    }

    // The turn starts here, so this is where "what has this turn done" gets
    // its answer to measure from.
    if let Some(session) = state.sessions.get(&id) {
        if !session.meta.ended {
            mark_turn_baseline(app, id, session.meta.cwd.clone());
        }
    }

    let mut new_title = None;
    {
        let Some(session) = state.sessions.get_mut(&id) else {
            return Err("unknown session".to_string());
        };
        if session.meta.ended {
            return Ok(None);
        }
        if session.transcript.entries.is_empty() && session.meta.title.starts_with("New session") {
            let title = derive_title(&text);
            session.meta.title = title.clone();
            new_title = Some(title);
        }
        session.transcript.push_user(text.clone());
        session.last_user_text = Some(text.clone());
        session.last_user_images = images.clone();
        dispatch(session, SessionCommand::Send(text, images));
    }
    state.persist_session(id);
    Ok(new_title)
}

/// Records the tree the working directory was in as a turn begins, so the
/// panel's "Latest turn" scope has a point to measure from.
///
/// Off the calling thread and best-effort. It shells out (`git stash create`),
/// and a turn must never wait on git to start — which does mean an agent fast
/// enough to write a file in the first few milliseconds would have that file
/// counted as something that was already there. The alternative is a composer
/// that stalls on every send in a large repository, which is the worse trade.
///
/// A folder that isn't a repository simply never gets a baseline, and the
/// scope falls back to HEAD (see `commands::resolve_scope`).
fn mark_turn_baseline(app: &AppHandle, id: u64, cwd: PathBuf) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let baseline = tauri::async_runtime::spawn_blocking(move || {
            let repo = egant_vcs::Repo::discover(&cwd).ok()?;
            repo.snapshot_tree().ok()
        })
        .await
        .ok()
        .flatten();
        let Some(baseline) = baseline else { return };
        let state = app.state::<Mutex<AppState>>();
        let mut guard = state.lock().unwrap();
        if let Some(session) = guard.sessions.get_mut(&id) {
            session.turn_baseline = Some(baseline);
        }
    });
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
    log::info!("interrupt session {id}");
    let Some(session) = state.sessions.get_mut(&id) else {
        log::warn!("interrupt unknown session {id}");
        return Err("unknown session".to_string());
    };
    dispatch(session, SessionCommand::Interrupt);
    Ok(())
}

/// Answers one row of the permission table.
///
/// - Claude (live approval channel): Allow/Allow-always approves this
///   request mid-turn and the turn continues; Deny refuses it. Allow-always
///   additionally flips the session to `bypassPermissions` so nothing else in
///   this chat asks again (plus remembers patterns as a fallback for the
///   window before the mode switch lands).
/// - opencode (no live channel — denials arrive after the turn settled):
///   Allow sets `--auto` for a retry of the last turn; Allow-always sets
///   `--auto` from here on and flips the mode chip to bypass; Deny just
///   dismisses the row. The retry only happens when the turn already settled —
///   a live turn keeps streaming.
///
/// Returns the new mode's CLI name when this answer changed it (i.e. on
/// Allow-always → `bypassPermissions`), so the frontend can flip its switch
/// without a separate round trip.
pub fn answer_permission(
    state: &mut AppState,
    id: u64,
    request_id: &str,
    answer: PermissionAnswer,
) -> Result<Option<&'static str>, String> {
    log::info!("answer permission session {id} {request_id} {answer:?}");
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    let Some(position) = session
        .transcript
        .pending_permissions
        .iter()
        .position(|p| p.request_id == request_id)
    else {
        return Ok(None); // already answered (double-click, stale snapshot)
    };
    let pending = session.transcript.pending_permissions[position].clone();
    let is_opencode = session.meta.agent == AgentId::Opencode;

    match answer {
        PermissionAnswer::Deny => {
            session.transcript.resolve_permission(request_id);
            if !is_opencode {
                dispatch(
                    session,
                    SessionCommand::Permission {
                        request_id: pending.request_id,
                        decision: PermissionDecision::Deny {
                            reason: "The user declined this action.".into(),
                        },
                    },
                );
            } else if session.transcript.pending_permissions.is_empty() {
                // opencode has nothing live to refuse: the tool already
                // failed, and no retry follows a deny. Back to idle — leaving
                // `AwaitingPermission`/`Running` would spin the composer with
                // no process behind it.
                session.transcript.state = egant_harness::TurnState::Idle;
            }
            // opencode has nothing live to refuse: the tool already failed.
            // Dropping the row is the whole answer.
            state.persist_session(id);
            Ok(None)
        }
        PermissionAnswer::AllowOnce => {
            if is_opencode {
                session.transcript.clear_permissions();
                dispatch(session, SessionCommand::ApproveNextTurn);
                retry_last_turn(session);
            } else {
                session.transcript.resolve_permission(request_id);
                dispatch(
                    session,
                    SessionCommand::Permission {
                        request_id: pending.request_id,
                        // Echo the original input: an `allow` without
                        // `updatedInput` reads as a deny on older CLIs.
                        decision: PermissionDecision::Allow {
                            updated_input: Some(pending.input),
                        },
                    },
                );
            }
            state.persist_session(id);
            Ok(None)
        }
        PermissionAnswer::AllowAlways => {
            remember_patterns(session, &pending);
            // "Always allow" means "stop asking in this chat": flip the
            // session to bypassPermissions. The current request is still
            // answered explicitly first (the CLI is blocked on it), then the
            // mode switch lands right behind it on the same ordered channel.
            session.meta.permission_mode = egant_harness::PermissionMode::BypassPermissions;
            if is_opencode {
                session.transcript.clear_permissions();
                dispatch(session, SessionCommand::ApproveAlways);
                dispatch(
                    session,
                    SessionCommand::SetPermissionMode(
                        egant_harness::PermissionMode::BypassPermissions,
                    ),
                );
                retry_last_turn(session);
            } else {
                session.transcript.resolve_permission(request_id);
                dispatch(
                    session,
                    SessionCommand::Permission {
                        request_id: pending.request_id,
                        decision: PermissionDecision::AllowAlways {
                            patterns: vec![],
                            updated_input: Some(pending.input),
                        },
                    },
                );
                dispatch(
                    session,
                    SessionCommand::SetPermissionMode(
                        egant_harness::PermissionMode::BypassPermissions,
                    ),
                );
            }
            state.persist_session(id);
            Ok(Some(
                egant_harness::PermissionMode::BypassPermissions.as_cli_arg(),
            ))
        }
    }
}

/// Legacy single-flag entry point. Kept for already-built frontends calling
/// `answer_permission(id, allow)`; routes to the first outstanding request.
pub fn answer_permission_legacy(
    state: &mut AppState,
    id: u64,
    allow: bool,
) -> Result<Option<&'static str>, String> {
    let request_id = state
        .sessions
        .get(&id)
        .and_then(|s| {
            s.transcript
                .pending_permissions
                .first()
                .map(|p| p.request_id.clone())
        })
        .or_else(|| {
            state.sessions.get(&id).and_then(|s| {
                s.transcript
                    .pending_permission
                    .clone()
                    .map(|p| p.request_id)
            })
        });
    let Some(request_id) = request_id else {
        return Ok(None);
    };
    answer_permission(
        state,
        id,
        &request_id,
        if allow {
            PermissionAnswer::AllowOnce
        } else {
            PermissionAnswer::Deny
        },
    )
}

/// Remembers an "Allow always" answer for the rest of the run: the request's
/// specific + always patterns, so a later read of the same file (or anything
/// under the same directory) is approved without asking.
fn remember_patterns(
    session: &mut crate::state::ManagedSession,
    pending: &egant_harness::PendingPermission,
) {
    for pattern in pending
        .patterns
        .iter()
        .chain(pending.always_patterns.iter())
    {
        if !session.allowed_patterns.iter().any(|p| p == pattern) {
            session.allowed_patterns.push(pattern.clone());
        }
    }
    // The tool itself is always a valid fallback match.
    if !session
        .allowed_patterns
        .iter()
        .any(|p| p == &pending.tool_name)
    {
        session.allowed_patterns.push(pending.tool_name.clone());
    }
}

/// Whether a request matches a remembered "allow always" pattern. A stored
/// `/a/b/*` covers `/a/b/c.rs`; a stored `git status *` covers
/// `git status --porcelain`; otherwise an exact (case-insensitive) match.
pub fn matches_allowlist(request_patterns: &[String], tool_name: &str, allowed: &[String]) -> bool {
    let candidates: Vec<String> = request_patterns
        .iter()
        .cloned()
        .chain(std::iter::once(tool_name.to_string()))
        .collect();
    for allow in allowed {
        let allow_lower = allow.to_lowercase();
        // Glob prefix: `foo/*` covers anything starting with `foo/`.
        if let Some(prefix) = allow_lower.strip_suffix('*') {
            let prefix = prefix.trim_end_matches('/');
            if candidates
                .iter()
                .any(|c| c.to_lowercase().starts_with(prefix))
            {
                return true;
            }
            continue;
        }
        if candidates.iter().any(|c| c.to_lowercase() == allow_lower) {
            return true;
        }
    }
    false
}

/// Re-sends the last user turn so a turn-based wire (opencode) retries with
/// the newly approved `--auto` flag. Only when the session is idle — a live
/// turn will pick the flag up on its own next turn.
fn retry_last_turn(session: &mut crate::state::ManagedSession) {
    if session.transcript.is_busy() {
        return;
    }
    let Some(text) = session.last_user_text.clone() else {
        return;
    };
    let images = session.last_user_images.clone();
    session.transcript.push_user(text.clone());
    dispatch(session, SessionCommand::Send(text, images));
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

/// Forgets a session: shuts its agent down, drops the row and deletes what was
/// saved of it.
///
/// Returns the worktree it was running in, when it had one. Giving that back
/// shells out to `git` and so cannot happen here, under the state lock and on
/// the UI's thread — the caller does it off-thread through
/// [`crate::worktrees::release`], which is also where the decision not to
/// delete it lives.
#[must_use]
pub fn close_session(state: &mut AppState, id: u64) -> Option<SessionWorktree> {
    log::info!("close session {id}");
    let Some(position) = state.order.iter().position(|sid| *sid == id) else {
        return None;
    };
    let active_index = state
        .active_session
        .and_then(|active| state.order.iter().position(|sid| *sid == active));

    state.order.remove(position);
    let mut worktree = None;
    if let Some(session) = state.sessions.remove(&id) {
        worktree = session.meta.worktree;
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
            Some(active) if position < active => state.order.get(active.saturating_sub(1)).copied(),
            _ => state
                .order
                .get(position.min(state.order.len().saturating_sub(1)))
                .copied(),
        };
        // The project selection must follow the session: otherwise closing the
        // last `meme-cam` thread leaves the sidebar on `meme-cam` while the
        // stage shows an `egant` thread (or vice versa). When nothing is left,
        // keep the project so the window still points at a folder.
        if let Some(next) = state.active_session {
            if let Some(session) = state.sessions.get(&next) {
                state.active_project = Some(session.meta.project_id);
            }
        }
    }
    worktree
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
pub(crate) fn branch_of(cwd: &Path) -> Option<String> {
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
///
/// `permission_mode` is the mode the harness should start under: `Auto` for a
/// fresh session, the saved mode when reviving (so an "Allow always" →
/// bypass flip survives a relaunch rather than silently reverting to asking).
fn start_harness(
    agent: AgentId,
    cwd: &Path,
    project_name: &str,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
    resume: Option<String>,
    permission_mode: egant_harness::PermissionMode,
) -> Result<Box<dyn Harness>, String> {
    // The agent must run in a real folder: spawning in a deleted directory
    // leaves the process somewhere the model cannot name truthfully.
    if !cwd.is_dir() {
        log::error!(
            "start harness agent={} failed: {} is not a folder",
            agent.as_str(),
            cwd.display()
        );
        return Err(format!("{} is not a folder", cwd.display()));
    }
    log::info!(
        "start harness agent={} cwd={} model={:?} resume={}",
        agent.as_str(),
        cwd.display(),
        model,
        resume.is_some(),
    );
    let cwd = cwd.to_path_buf();
    let project_name = project_name.to_string();
    match agent {
        AgentId::Claude => {
            // The big window is the default, not a setting: Claude's larger
            // models all run at a million tokens when asked (measured — see
            // `models::claude_models`), and a session that quietly took a
            // fifth of what the model can hold is the kind of thing nobody
            // thinks to go and turn on. An explicit choice still wins, which
            // is the only way to ask for less.
            let context_window = context.or_else(|| {
                model
                    .as_deref()
                    .and_then(|id| egant_harness::models::max_context(AgentId::Claude, id))
            });
            let (harness, pump) = ClaudeCode::spawn(ClaudeOptions {
                program: resolve_cli(agent)?,
                cwd,
                project_name: Some(project_name),
                model,
                effort: variant,
                // Claude takes the wider window as a model-id suffix rather
                // than a flag; `ClaudeOptions::to_args` applies it.
                context_window,
                permission_mode,
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
            project_name: Some(project_name),
            model,
            context_window: context,
            reasoning_effort: variant,
            thread: resume,
            permission_mode,
        })
        .map(|harness| Box::new(harness) as Box<dyn Harness>)
        .map_err(|error| error.to_string()),
        AgentId::Opencode => OpencodeRun::spawn(OpencodeOptions {
            program: resolve_cli(agent)?,
            cwd,
            project_name: Some(project_name),
            model,
            variant,
            session: resume,
            // Bypass means `--auto` from here on; anything else starts
            // asking again until the user flips it.
            auto_approve: permission_mode == PermissionMode::BypassPermissions,
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

/// Whether a turn failed because the model was asked for the million-token
/// window and this account, model or auth style may not have it. Measured
/// wording, not a guess: `claude --model claude-haiku-4-5[1m]` answers `API
/// Error: 400 This authentication style is incompatible with the long context
/// beta header`. Kept as narrow as the bad-model matcher next to it — a false
/// positive here silently shrinks a window that was working.
fn looks_like_a_long_context_rejection(message: &str) -> bool {
    message.to_lowercase().contains("long context beta")
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
    use super::{
        PermissionAnswer, derive_title, harness_event_error_text, looks_like_a_bad_model_error,
        looks_like_a_long_context_rejection, matches_allowlist,
    };
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
        assert!(looks_like_a_bad_model_error(
            "Model metadata for `gpt-5.4-mini` not found."
        ));
    }

    #[test]
    fn a_refused_wide_window_is_recognized_but_is_not_a_bad_model() {
        const REFUSAL: &str = "API Error: 400 This authentication style is incompatible with the long context beta header.";
        assert!(looks_like_a_long_context_rejection(REFUSAL));
        // It says nothing about the model itself, so it must not grey the
        // model out in the picker.
        assert!(!looks_like_a_bad_model_error(REFUSAL));
        assert!(!looks_like_a_long_context_rejection("model_not_found"));
    }

    #[test]
    fn unrelated_failures_are_not_mistaken_for_a_bad_model() {
        assert!(!looks_like_a_bad_model_error("request timed out"));
        assert!(!looks_like_a_bad_model_error("the turn was interrupted"));
        assert!(!looks_like_a_bad_model_error(
            "rate limit exceeded, try again later"
        ));
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
        assert!(
            !title.ends_with(" …"),
            "should trim before the ellipsis: {title}"
        );
    }

    #[test]
    fn a_blank_message_falls_back_to_the_default_title() {
        assert_eq!(derive_title("   \n  "), "New session");
    }

    #[test]
    fn allow_always_patterns_match_their_scope() {
        // A remembered `/tmp/meme-cam/*` covers reads under it, not elsewhere.
        assert!(matches_allowlist(
            &["/tmp/meme-cam/app.py".to_string()],
            "Read",
            &["/tmp/meme-cam/*".to_string()],
        ));
        assert!(!matches_allowlist(
            &["/tmp/other/app.py".to_string()],
            "Read",
            &["/tmp/meme-cam/*".to_string()],
        ));
        // Command prefixes and bare tool names match too.
        assert!(matches_allowlist(
            &["git status --porcelain".to_string()],
            "Bash",
            &["git status *".to_string()],
        ));
        assert!(matches_allowlist(
            &["whatever".to_string()],
            "Read",
            &["Read".to_string()]
        ));
        assert!(!matches_allowlist(&["x".to_string()], "Read", &[]));
    }

    #[test]
    fn permission_answers_parse_from_the_table() {
        assert_eq!(
            PermissionAnswer::from_str_name("allow"),
            Some(PermissionAnswer::AllowOnce)
        );
        assert_eq!(
            PermissionAnswer::from_str_name("allow-always"),
            Some(PermissionAnswer::AllowAlways)
        );
        assert_eq!(
            PermissionAnswer::from_str_name("deny"),
            Some(PermissionAnswer::Deny)
        );
        assert_eq!(PermissionAnswer::from_str_name("maybe"), None);
    }
}
