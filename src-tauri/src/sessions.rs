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
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

use crate::dto::{
    EventDto, QueuedDto, SessionEventPayload, SessionQueuePayload, SessionTitledPayload,
    WorktreeRenamedPayload,
};
use crate::state::{AppState, QueuedTurn, SessionMeta, TitleSource};
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

/// How the user answered one row of the permission table — or one of the
/// agent's questions, which reach the table as requests for their own tool
/// (see [`egant_harness::is_interactive_tool`]).
#[derive(Debug, Clone, PartialEq)]
pub enum PermissionAnswer {
    AllowOnce,
    /// Approve, and don't ask again for this — Claude saves the rule it
    /// suggested; opencode, which has no rules, stops asking altogether.
    AllowAlways,
    /// Refuse. `feedback` is what the agent reads instead of the stock
    /// refusal; `stop` also ends the turn.
    Deny {
        feedback: Option<String>,
        stop: bool,
    },
    /// Answers to an AskUserQuestion, keyed by the exact question text: a
    /// label (or free text), or several labels for a multi-select question.
    /// `notes` are per-question remarks the agent reads alongside.
    Answer {
        answers: serde_json::Map<String, serde_json::Value>,
        notes: serde_json::Map<String, serde_json::Value>,
    },
    /// Approves an ExitPlanMode and carries on under `mode`.
    ApprovePlan {
        mode: PermissionMode,
    },
}

/// The most text one answer (or note, or feedback) may carry, and all of an
/// answer's text together — the CLI's own limits for an AskUserQuestion
/// reply, applied here so an oversized one is a readable error rather than a
/// refusal the agent reports as prose.
const MAX_ANSWER_CHARS: usize = 8192;
const MAX_ANSWERS_CHARS: usize = 32768;

impl PermissionAnswer {
    /// The answer's name, for logs that must not carry what the user wrote.
    pub fn kind(&self) -> &'static str {
        match self {
            PermissionAnswer::AllowOnce => "allow",
            PermissionAnswer::AllowAlways => "allow-always",
            PermissionAnswer::Deny { stop: true, .. } => "deny-and-stop",
            PermissionAnswer::Deny { .. } => "deny",
            PermissionAnswer::Answer { .. } => "answer",
            PermissionAnswer::ApprovePlan { .. } => "approve-plan",
        }
    }

    pub fn from_str_name(name: &str) -> Option<Self> {
        match name {
            "allow" | "allow-once" | "once" => Some(PermissionAnswer::AllowOnce),
            "allow-always" | "always" => Some(PermissionAnswer::AllowAlways),
            "deny" | "reject" => Some(PermissionAnswer::Deny {
                feedback: None,
                stop: false,
            }),
            _ => None,
        }
    }

    /// Builds an answer from what a client sent: the decision's name plus the
    /// fields that decision takes. Shared by the window and the phone, so
    /// both are held to the same shapes.
    pub fn from_parts(
        decision: &str,
        answers: Option<serde_json::Map<String, serde_json::Value>>,
        notes: Option<serde_json::Map<String, serde_json::Value>>,
        feedback: Option<String>,
        stop: Option<bool>,
        mode: Option<&str>,
    ) -> Result<Self, String> {
        match decision {
            "answer" => Ok(PermissionAnswer::Answer {
                answers: answers.unwrap_or_default(),
                notes: notes.unwrap_or_default(),
            }),
            "approve-plan" => {
                let mode = mode
                    .and_then(PermissionMode::from_cli_arg)
                    .ok_or_else(|| "say which mode to carry on in".to_string())?;
                if mode == PermissionMode::Plan {
                    return Err("an approved plan can't stay in plan mode".to_string());
                }
                Ok(PermissionAnswer::ApprovePlan { mode })
            }
            other => match Self::from_str_name(other) {
                Some(PermissionAnswer::Deny { .. }) => {
                    let feedback = feedback
                        .map(|text| text.trim().to_string())
                        .filter(|text| !text.is_empty());
                    if feedback
                        .as_ref()
                        .is_some_and(|text| text.chars().count() > MAX_ANSWER_CHARS)
                    {
                        return Err("that note is too long".to_string());
                    }
                    Ok(PermissionAnswer::Deny {
                        feedback,
                        stop: stop.unwrap_or(false),
                    })
                }
                Some(answer) => Ok(answer),
                None => Err(format!("unknown decision `{other}`")),
            },
        }
    }
}

/// The input an answered AskUserQuestion runs with: the question exactly as
/// asked, plus `answers` (and `annotations` for notes). Checked the way the
/// CLI checks it — every key names a question, several labels only for a
/// multi-select one, the size limits — because a reply it refuses is lost:
/// the agent just reports that the answer didn't arrive.
pub fn answered_question_input(
    input: &serde_json::Value,
    answers: &serde_json::Map<String, serde_json::Value>,
    notes: &serde_json::Map<String, serde_json::Value>,
) -> Result<serde_json::Value, String> {
    use serde_json::Value;
    let Some(original) = input.as_object() else {
        return Err("this question arrived malformed".to_string());
    };
    if original.contains_key("answers") || original.contains_key("annotations") {
        return Err("this question already carries answers".to_string());
    }
    // question text → (multi-select, option count)
    let questions: std::collections::HashMap<&str, (bool, usize)> = original
        .get("questions")
        .and_then(Value::as_array)
        .map(|questions| {
            questions
                .iter()
                .filter_map(|q| {
                    let text = q.get("question")?.as_str()?;
                    let multi = q.get("multiSelect").and_then(Value::as_bool) == Some(true);
                    let options = q
                        .get("options")
                        .and_then(Value::as_array)
                        .map_or(0, Vec::len);
                    Some((text, (multi, options)))
                })
                .collect()
        })
        .unwrap_or_default();
    if answers.is_empty() {
        return Err("pick an answer first".to_string());
    }

    let mut total = 0usize;
    let mut measure = |text: &str| -> Result<(), String> {
        let chars = text.chars().count();
        if chars > MAX_ANSWER_CHARS {
            return Err("that answer is too long".to_string());
        }
        total += chars;
        if total > MAX_ANSWERS_CHARS {
            return Err("those answers are too long".to_string());
        }
        Ok(())
    };
    for (question, answer) in answers {
        let Some(&(multi, options)) = questions.get(question.as_str()) else {
            return Err("an answer names a question that wasn't asked".to_string());
        };
        match answer {
            Value::String(text) => measure(text)?,
            Value::Array(picks) => {
                if !multi {
                    return Err("that question takes one answer".to_string());
                }
                // Every option, plus one free-text "Other".
                if picks.len() > options + 1 {
                    return Err("too many answers for that question".to_string());
                }
                for pick in picks {
                    let Some(text) = pick.as_str() else {
                        return Err("an answer must be text".to_string());
                    };
                    measure(text)?;
                }
            }
            _ => return Err("an answer must be text".to_string()),
        }
    }

    let mut annotations = serde_json::Map::new();
    for (question, note) in notes {
        if !questions.contains_key(question.as_str()) {
            return Err("a note names a question that wasn't asked".to_string());
        }
        let Some(text) = note.as_str().map(str::trim).filter(|text| !text.is_empty()) else {
            continue;
        };
        measure(text)?;
        annotations.insert(question.clone(), serde_json::json!({ "notes": text }));
    }

    let mut updated = original.clone();
    updated.insert("answers".into(), Value::Object(answers.clone()));
    if !annotations.is_empty() {
        updated.insert("annotations".into(), Value::Object(annotations));
    }
    Ok(Value::Object(updated))
}

/// A `setMode` permission update, as an approval hands it to the CLI. The
/// CLI calls `manual` by its internal name, `default`.
fn set_mode_update(mode: PermissionMode) -> serde_json::Value {
    let name = match mode {
        PermissionMode::Manual => "default",
        other => other.as_cli_arg(),
    };
    serde_json::json!({ "type": "setMode", "mode": name, "destination": "session" })
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
        title_source: TitleSource::Placeholder,
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
        variant: variant.clone(),
        context,
        permission_mode: PermissionMode::Auto,
        worktree,
        device: None,
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
                    decisions: Default::default(),
                    last_activity_ms: unix_now_ms(),
                    queued: Default::default(),
                    flush_next_end: false,
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
            decisions: Default::default(),
            last_activity_ms: unix_now_ms(),
            queued: Default::default(),
            flush_next_end: false,
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
        // "Pi CLI" is the name: no turns ever pass through here for a
        // generated title to come from.
        title_source: TitleSource::Generated,
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
        variant: None,
        context: None,
        permission_mode: PermissionMode::Auto,
        worktree,
        device: None,
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
            decisions: Default::default(),
            last_activity_ms: unix_now_ms(),
            queued: Default::default(),
            flush_next_end: false,
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
    // Weak, so the listener never keeps its own driver alive: the session's
    // sender is what decides that.
    let wire = command_tx.downgrade();

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
            let turn_succeeded = matches!(
                event,
                HarnessEvent::TurnEnded {
                    is_error: false,
                    ..
                }
            );
            // Whether a turn just ended, and cleanly: what the queue waits on.
            let turn_end = match &event {
                HarnessEvent::TurnEnded { is_error, .. } => Some(!is_error),
                _ => None,
            };
            {
                let app_state = listener_app.state::<Mutex<AppState>>();
                let mut guard = app_state.lock().unwrap();
                let Some(session) = guard.sessions.get_mut(&id) else {
                    break; // the session is gone
                };
                session.last_activity_ms = unix_now_ms();
                // A model switch hands the session a new process (see
                // [`set_model`]). This one is being shut down, and nothing it
                // says now — its exit least of all — belongs in the transcript.
                let replaced = session.commands.as_ref().is_some_and(|current| {
                    wire.upgrade()
                        .is_none_or(|mine| !mine.same_channel(current))
                });
                if replaced {
                    log::debug!(
                        "session {id} listener retired: the session moved to a new process"
                    );
                    break;
                }
                // An "Allow always" answer the CLI had no rule to offer for
                // is remembered here, as patterns, for the run. A live-channel
                // request (Claude) matching one is approved without ever
                // reaching the table — otherwise "always" would ask again
                // every turn. Turn-based denials (opencode) are always shown:
                // approval there means retrying with `--auto`, which the user
                // triggers per table, not silently. A question or a plan is
                // never answered for the user, whatever was remembered.
                let auto_approved: Option<(String, String, serde_json::Value)> = match &event {
                    HarnessEvent::PermissionRequest {
                        request_id,
                        tool_name,
                        patterns,
                        input,
                        ..
                    } if session.meta.agent != AgentId::Opencode
                        && !egant_harness::is_interactive_tool(tool_name)
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
                                updated_permissions: Vec::new(),
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
                // The CLI's own word on its mode, after an approved plan or
                // Claude entering plan mode by itself: the chip and a revived
                // session must follow it, not what the host last asked for.
                if let HarnessEvent::ModeChanged { mode } = &event {
                    session.meta.permission_mode = *mode;
                }
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
                // Published before the lock is released, so a snapshot taken
                // under it never already holds an event its stream will
                // deliver again (see `crate::sync`).
                crate::sync::harness_event(&listener_app, id, &dto);
                crate::sync::session_touched(
                    &listener_app,
                    &guard,
                    id,
                    &crate::sync::Origin::Agent,
                );
            }
            let _ = listener_app.emit(
                "session-event",
                SessionEventPayload {
                    session_id: id,
                    event: dto,
                },
            );
            if turn_succeeded {
                name_session(&listener_app, id);
            }
            if let Some(clean) = turn_end {
                flush_queue(&listener_app, id, clean);
            }
        }
    });

    command_tx
}

/// Sessions being named right now, so a turn that ends while the title is
/// still generating doesn't start a second one.
static NAMING: Mutex<BTreeSet<u64>> = Mutex::new(BTreeSet::new());

/// Names a session after what it is about, once a turn has finished: its
/// title, while that is still the first message's opening line, and its
/// worktree's placeholder branch — `egant/quiet-quartz` becomes
/// `egant/fix-login-flow`.
///
/// zeron's approach (`engine/src/titles.rs`): one throwaway, tool-less run of
/// a small model titles the first prompt, and serves both. Off the listener
/// and best-effort. When that run fails, the title keeps its opening line —
/// already a fair name — and the branch takes the prompt's opening words,
/// which still say more than `quiet-quartz`.
///
/// Every successful turn calls this. After the first it returns at the first
/// check: a settled title and a renamed branch have nothing left to name. A
/// branch whose rename was declined or failed is retried on the next turn; a
/// title is settled either way, since each attempt costs a model call and the
/// opening line stands on its own.
fn name_session(app: &AppHandle, id: u64) {
    let job = {
        let state = app.state::<Mutex<AppState>>();
        let guard = state.lock().unwrap();
        guard.sessions.get(&id).and_then(|session| {
            // A CLI session's turns never pass through here, and its name is
            // the agent's.
            if session.meta.cli_agent.is_some() {
                return None;
            }
            let retitle = session.meta.title_source == TitleSource::FirstLine;
            let worktree = session
                .meta
                .worktree
                .clone()
                .filter(SessionWorktree::has_placeholder_name);
            if !retitle && worktree.is_none() {
                return None;
            }
            let prompt = session
                .transcript
                .entries
                .iter()
                .find_map(|entry| match entry {
                    TranscriptEntry::User { text } => Some(text.clone()),
                    _ => None,
                })?;
            Some((
                retitle,
                worktree,
                prompt,
                session.meta.agent,
                session.meta.model.clone(),
            ))
        })
    };
    let Some((retitle, worktree, prompt, agent, model)) = job else {
        return;
    };
    if !NAMING
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(id)
    {
        return;
    }
    log::info!(
        "session {id} naming (title: {retitle}, worktree: {})",
        worktree
            .as_ref()
            .map_or("-", |worktree| worktree.branch.as_str())
    );

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = tauri::async_runtime::spawn_blocking(move || {
            let generated = egant_harness::titles::generate(agent, model.as_deref(), &prompt);
            let renamed = worktree.map(|worktree| {
                let name = generated.clone().unwrap_or_else(|| opening_words(&prompt));
                let result = crate::worktrees::rename(&worktree, &name);
                (worktree, result)
            });
            (generated, renamed)
        })
        .await;
        match outcome {
            Ok((generated, renamed)) => {
                if retitle {
                    apply_generated_title(&app, id, generated);
                }
                match renamed {
                    Some((previous, Ok(Some(renamed)))) => {
                        apply_worktree_rename(&app, &previous, &renamed)
                    }
                    Some((previous, Ok(None))) => {
                        log::info!("session {id} worktree {} left as is", previous.branch)
                    }
                    Some((_, Err(error))) => {
                        log::warn!("session {id} worktree not renamed: {error}")
                    }
                    None => {}
                }
            }
            Err(error) => log::error!("session {id} naming task failed: {error}"),
        }
        // Released only once the new names are in state, so a turn ending in
        // between cannot see the old ones and start over.
        NAMING
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&id);
    });
}

/// Puts a generated title on a session — unless the user renamed it while the
/// title was being written — and tells the window and the phone. Without a
/// title (the run failed) the opening line stays, settled all the same.
fn apply_generated_title(app: &AppHandle, id: u64, generated: Option<String>) {
    let state = app.state::<Mutex<AppState>>();
    let mut guard = state.lock().unwrap();
    let Some(session) = guard.sessions.get_mut(&id) else {
        return;
    };
    if session.meta.title_source != TitleSource::FirstLine {
        return; // renamed meanwhile: the user's words win
    }
    let titled = settle_generated_title(&mut session.meta, generated);
    guard.persist_session(id);
    let Some(title) = titled else {
        return;
    };
    log::info!("session {id} titled");
    crate::sync::session_touched(app, &guard, id, &crate::sync::Origin::Agent);
    drop(guard);
    // The window skips the agent's own `session` rows on the sync stream (it
    // hears about turns through `session-event`), so a title the app wrote
    // reaches it here — the way a renamed worktree does.
    let _ = app.emit(
        "session-titled",
        SessionTitledPayload {
            session_id: id,
            title,
        },
    );
}

/// Settles a session's title once a generated one is back: takes it while
/// the title is still the first message's opening line, and otherwise leaves
/// what is there — above all a title the user typed. Returns the new title
/// when there is one to announce.
fn settle_generated_title(meta: &mut SessionMeta, generated: Option<String>) -> Option<String> {
    if meta.title_source != TitleSource::FirstLine {
        return None;
    }
    meta.title_source = TitleSource::Generated;
    let title = generated.filter(|title| !title.trim().is_empty())?;
    meta.title = title.clone();
    Some(title)
}

/// The most a title may hold, in characters.
const MAX_TITLE_CHARS: usize = 120;

/// Renames a session to what the user typed, whitespace collapsed. Nothing
/// the app generates replaces it afterwards.
pub fn rename_session(state: &mut AppState, id: u64, title: &str) -> Result<String, String> {
    let title = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if title.is_empty() {
        return Err("a title needs some words".to_string());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err("that title is too long".to_string());
    }
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    log::info!("rename session {id}");
    session.meta.title = title.clone();
    session.meta.title_source = TitleSource::User;
    state.persist_session(id);
    Ok(title)
}

/// Puts a renamed worktree into every session running in it — the one that
/// named it, and any that joined it — and tells the window.
fn apply_worktree_rename(app: &AppHandle, previous: &SessionWorktree, renamed: &SessionWorktree) {
    let state = app.state::<Mutex<AppState>>();
    let mut guard = state.lock().unwrap();
    let ids: Vec<u64> = guard
        .sessions
        .iter()
        .filter(|(_, session)| {
            session
                .meta
                .worktree
                .as_ref()
                .is_some_and(|worktree| worktree.path == previous.path)
        })
        .map(|(id, _)| *id)
        .collect();
    for id in &ids {
        let Some(session) = guard.sessions.get_mut(id) else {
            continue;
        };
        if let Some(worktree) = session.meta.worktree.as_mut() {
            worktree.branch = renamed.branch.clone();
            worktree.name = renamed.name.clone();
        }
        if session.meta.branch.as_deref() == Some(previous.branch.as_str()) {
            session.meta.branch = Some(renamed.branch.clone());
        }
    }
    for id in ids {
        guard.persist_session(id);
        crate::sync::session_touched(app, &guard, id, &crate::sync::Origin::Agent);
    }
    drop(guard);
    let _ = app.emit(
        "worktree-renamed",
        WorktreeRenamedPayload {
            path: renamed.path.display().to_string(),
            branch: renamed.branch.clone(),
            name: renamed.name.clone(),
            previous_branch: previous.branch.clone(),
        },
    );
}

/// The fallback title: the first line's opening words, which still say more
/// about the session than `quiet-quartz` does.
fn opening_words(prompt: &str) -> String {
    prompt
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or_default()
        .split_whitespace()
        .take(5)
        .collect::<Vec<_>>()
        .join(" ")
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
        HarnessEvent::ModeChanged { mode } => {
            log::info!("session {id} mode is now {}", mode.as_cli_arg());
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
    let variant = session.meta.variant.clone();
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
        variant,
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

/// Moves a chat session onto another model and/or effort without leaving the
/// conversation — what the composer's model badge does once a session exists.
///
/// None of the wires can change the model under a process already running
/// it: Claude's is a launch flag on a persistent process, and Codex's and
/// opencode's are fixed into a translator built at spawn. So a live session
/// gets a fresh harness that resumes the same conversation on the new model,
/// the way [`revive`] brings an ended one back. The new one is started before
/// the old one is let go, so a switch that fails leaves the session running
/// exactly as it was.
///
/// A session with nothing running behind it (ended, or restored from disk)
/// only records the pick: its next send revives it onto the new model.
pub fn set_model(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
) -> Result<(), String> {
    let Some(session) = state.sessions.get(&id) else {
        return Err("unknown session".to_string());
    };
    if session.meta.cli_agent.is_some() {
        return Err("this session runs its own CLI — switch models from its terminal".to_string());
    }
    // A turn in flight belongs to the process running it; restarting under
    // it would drop the reply halfway.
    if session.transcript.is_busy() {
        return Err("wait for this turn to finish before switching models".to_string());
    }
    let agent = session.meta.agent;
    log::info!(
        "session {id} switching model agent={} model={model:?} variant={variant:?}",
        agent.as_str()
    );

    if session.commands.is_some() {
        let cwd = session.meta.cwd.clone();
        let resume = session.transcript.session_id.clone();
        let mode = session.meta.permission_mode;
        let project_name = state
            .project(session.meta.project_id)
            .map(|p| p.name.clone())
            .unwrap_or_else(|| egant_harness::project_display_name(&cwd));
        let harness = match start_harness(
            agent,
            &cwd,
            &project_name,
            model.clone(),
            variant.clone(),
            context,
            resume,
            mode,
        ) {
            Ok(harness) => harness,
            Err(error) => {
                log::error!("session {id} model switch failed: {error}");
                if let Some(model) = &model {
                    if looks_like_a_bad_model_error(&error) {
                        state.mark_model_bad(agent, model.clone());
                    }
                }
                return Err(error);
            }
        };
        let command_tx = wire_harness(app, id, harness);
        let Some(session) = state.sessions.get_mut(&id) else {
            return Err("unknown session".to_string());
        };
        // Swapping the sender is what retires the old listener; the old
        // driver still gets a clean shutdown so its process exits now rather
        // than whenever the channel happens to drop.
        if let Some(previous) = session.commands.replace(command_tx) {
            let _ = previous.try_send(SessionCommand::Shutdown);
        }
    }

    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    session.meta.model = model.clone();
    session.meta.variant = variant;
    session.meta.context = context;
    // The badge reads the model the agent last reported. Until the next turn
    // reports the new one, it should name what was just picked rather than
    // the model this session is no longer running.
    session.transcript.model = model;
    state.persist_session(id);
    Ok(())
}

/// Puts a notice in a session's transcript and streams it to the window, the
/// way the listener does for the agent's own errors — for the things the app
/// itself decides, which never arrive on the event channel.
fn notice(app: &AppHandle, session: &mut crate::state::ManagedSession, id: u64, message: String) {
    let event = HarnessEvent::Error { message };
    let dto = EventDto::from(&event);
    session.transcript.apply(event);
    crate::sync::harness_event(app, id, &dto);
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
///
/// A message sent while a turn is still running (or waiting on the user)
/// waits in the session's queue instead, and goes out when that turn ends —
/// see [`flush_queue`]. Echoing it now would put the bubble in the middle of
/// the reply still streaming, reading as the question that reply answers.
pub fn send_text(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    text: String,
    images: Vec<PathBuf>,
) -> Result<SendOutcome, String> {
    if text.trim().is_empty() && images.is_empty() {
        return Ok(SendOutcome::default());
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
    let (text, images) = match state.sessions.get_mut(&id) {
        Some(session) => match enqueue_if_busy(session, text, images) {
            Ok(outcome) => return Ok(outcome),
            Err(unsent) => unsent,
        },
        None => (text, images),
    };
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
            return Ok(SendOutcome::default());
        }
        // The first message names the session until a generated title does
        // (see `name_session`). A placeholder is what a fresh session has; the
        // string check covers one saved before titles were tracked.
        let placeholder = session.meta.title_source == TitleSource::Placeholder
            || (session.meta.title_source != TitleSource::User
                && session.meta.title.starts_with("New session"));
        if session.transcript.entries.is_empty() && placeholder {
            let title = derive_title(&text);
            session.meta.title = title.clone();
            session.meta.title_source = TitleSource::FirstLine;
            new_title = Some(title);
        }
        session.transcript.push_user(text.clone());
        session.last_user_text = Some(text.clone());
        session.last_user_images = images.clone();
        session.last_activity_ms = unix_now_ms();
        dispatch(session, SessionCommand::Send(text, images));
    }
    state.persist_session(id);
    Ok(SendOutcome {
        title: new_title,
        queued: false,
    })
}

/// What sending a message did.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SendOutcome {
    /// The session's new title, when this turn named it.
    pub title: Option<String>,
    /// The agent was busy: the message waits in the queue.
    pub queued: bool,
}

/// Queued messages' ids — unique across sessions, so the composer can name one.
static NEXT_QUEUED_ID: AtomicU64 = AtomicU64::new(1);

/// Queues a message when the session's agent is busy — a turn running, or
/// waiting on the user — and hands it back to be sent now otherwise. A
/// session with no live process is never busy: sending revives it.
fn enqueue_if_busy(
    session: &mut crate::state::ManagedSession,
    text: String,
    images: Vec<PathBuf>,
) -> Result<SendOutcome, (String, Vec<PathBuf>)> {
    let live = session.commands.is_some() && !session.meta.ended;
    if !(live && session.transcript.is_busy()) {
        return Err((text, images));
    }
    let queued = QueuedTurn {
        id: NEXT_QUEUED_ID.fetch_add(1, Ordering::Relaxed),
        text,
        images,
    };
    log::info!(
        "session {} busy: queued message {} ({} waiting)",
        session.meta.id,
        queued.id,
        session.queued.len() + 1
    );
    session.queued.push_back(queued);
    session.last_activity_ms = unix_now_ms();
    Ok(SendOutcome {
        title: None,
        queued: true,
    })
}

/// The queued message a turn's end lets out, taken off the queue: after a
/// clean end with nothing waiting on the user, or — once "Send now" asked for
/// it — after any end. `None` leaves the queue as it is.
fn next_to_flush(
    session: &mut crate::state::ManagedSession,
    clean_end: bool,
) -> Option<QueuedTurn> {
    let forced = std::mem::take(&mut session.flush_next_end);
    if session.queued.is_empty() || session.transcript.is_busy() {
        return None;
    }
    if !forced && (!clean_end || !session.transcript.pending_permissions.is_empty()) {
        return None;
    }
    if forced && session.meta.agent != AgentId::Opencode {
        // An interrupted turn has nobody left to answer its prompts.
        session.transcript.clear_permissions();
    }
    session.queued.pop_front()
}

/// Sends the next queued message once a turn is over: a clean end, with
/// nothing waiting on the user — or, after "Send now" interrupted the turn,
/// however it ended. A turn that failed or was stopped otherwise leaves the
/// queue where it is, for the user to send or edit.
///
/// Runs after the turn's end has reached the window, so the bubble lands
/// behind it rather than ahead of the event that ends the turn it follows.
/// It goes through [`send_text`], so a queued message gets everything a typed
/// one would; clients hear about it as a user message from the app itself.
fn flush_queue(app: &AppHandle, id: u64, clean_end: bool) {
    let state = app.state::<Mutex<AppState>>();
    let mut guard = state.lock().unwrap();
    let Some(session) = guard.sessions.get_mut(&id) else {
        return;
    };
    let Some(next) = next_to_flush(session, clean_end) else {
        return;
    };
    log::info!("session {id} sending queued message {}", next.id);
    let before = session.transcript.entries.len();
    match send_text(app, &mut guard, id, next.text, next.images) {
        Ok(outcome) => {
            crate::sync::transcript_grew(app, &guard, id, before, &crate::sync::Origin::Agent);
            crate::sync::session_touched(app, &guard, id, &crate::sync::Origin::Agent);
            if let Some(title) = outcome.title {
                // A queued first message is rare, but it names the session
                // like any other first message.
                let _ = app.emit(
                    "session-titled",
                    SessionTitledPayload {
                        session_id: id,
                        title,
                    },
                );
            }
        }
        Err(error) => log::warn!("session {id} queued message not sent: {error}"),
    }
    let queue = guard.sessions.get(&id).map(queue_dto).unwrap_or_default();
    drop(guard);
    let _ = app.emit(
        "session-queue",
        SessionQueuePayload {
            session_id: id,
            queued: queue,
        },
    );
}

/// A session's queue as the composer shows it.
pub fn queue_dto(session: &crate::state::ManagedSession) -> Vec<QueuedDto> {
    session
        .queued
        .iter()
        .map(|queued| QueuedDto {
            id: queued.id,
            text: queued.text.clone(),
            image_count: queued.images.len(),
        })
        .collect()
}

/// Takes a message back out of the queue — to edit it, or to drop it.
/// Returns its text, or `None` when it already went out.
pub fn unqueue_message(
    state: &mut AppState,
    id: u64,
    queued_id: u64,
) -> Result<Option<String>, String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    let Some(position) = session.queued.iter().position(|q| q.id == queued_id) else {
        return Ok(None);
    };
    Ok(session.queued.remove(position).map(|queued| queued.text))
}

/// Sends a queued message now rather than when the turn ends. With nothing
/// running, that is simply sending it; with a turn running, the turn is
/// stopped and the message goes out as soon as it has.
pub fn send_queued_now(
    app: &AppHandle,
    state: &mut AppState,
    id: u64,
    queued_id: u64,
) -> Result<SendOutcome, String> {
    let Some(session) = state.sessions.get_mut(&id) else {
        return Err("unknown session".to_string());
    };
    let Some(position) = session.queued.iter().position(|q| q.id == queued_id) else {
        return Ok(SendOutcome::default()); // already went out
    };
    let Some(queued) = session.queued.remove(position) else {
        return Ok(SendOutcome::default());
    };
    if !session.transcript.is_busy() {
        return send_text(app, state, id, queued.text, queued.images);
    }
    log::info!(
        "session {id} sending queued message {} now: stopping the turn",
        queued.id
    );
    session.queued.push_front(queued);
    session.flush_next_end = true;
    dispatch(session, SessionCommand::Interrupt);
    Ok(SendOutcome {
        title: None,
        queued: true,
    })
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
/// - Claude (live approval channel): the answer goes back mid-turn and the
///   turn continues.
///   - Allow once approves the request as proposed.
///   - Allow always also hands back the rule the CLI suggested for it
///     (`Bash(git status:*)`, saved to the project) — or, when it suggested
///     none, remembers the request's patterns for the run. The mode never
///     changes: every other tool keeps asking.
///   - Deny refuses it, with the user's feedback as the reason when there is
///     some; `stop` also ends the turn.
///   - A question (AskUserQuestion) is answered rather than allowed: its
///     answers become part of the input it runs with. A plan (ExitPlanMode)
///     is approved into the mode the user picked. Neither takes a plain
///     Allow, which would run the question with nothing answered.
/// - opencode (no live channel — denials arrive after the turn settled):
///   Allow sets `--auto` for a retry of the last turn; Allow-always sets
///   `--auto` from here on and flips the mode chip to bypass, since `--auto`
///   is the only lever that wire has; Deny just dismisses the row. The retry
///   only happens when the turn already settled — a live turn keeps
///   streaming.
///
/// Returns the new mode's CLI name when this answer changed it (opencode's
/// Allow always, an approved plan), so the frontend can flip its switch
/// without a separate round trip.
pub fn answer_permission(
    state: &mut AppState,
    id: u64,
    request_id: &str,
    answer: PermissionAnswer,
) -> Result<Option<&'static str>, String> {
    // The kind only: answers and feedback are the user's words.
    log::info!(
        "answer permission session {id} {request_id} {}",
        answer.kind()
    );
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

    match (&answer, pending.tool_name.as_str()) {
        (PermissionAnswer::Deny { .. }, _)
        | (PermissionAnswer::Answer { .. }, egant_harness::ASK_USER_QUESTION)
        | (PermissionAnswer::ApprovePlan { .. }, egant_harness::EXIT_PLAN_MODE) => {}
        (PermissionAnswer::Answer { .. }, _) => {
            return Err("this request isn't a question".to_string());
        }
        (PermissionAnswer::ApprovePlan { .. }, _) => {
            return Err("this request isn't a plan".to_string());
        }
        (_, egant_harness::ASK_USER_QUESTION) => {
            return Err("answer the question instead".to_string());
        }
        (_, egant_harness::EXIT_PLAN_MODE) => {
            return Err("approve the plan or keep planning instead".to_string());
        }
        _ => {}
    }

    match answer {
        PermissionAnswer::Deny { feedback, stop } => {
            session.transcript.resolve_permission(request_id);
            if !is_opencode {
                dispatch(
                    session,
                    SessionCommand::Permission {
                        request_id: pending.request_id,
                        decision: PermissionDecision::Deny {
                            reason: feedback
                                .unwrap_or_else(|| "The user declined this action.".into()),
                            interrupt: stop,
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
                            updated_permissions: Vec::new(),
                        },
                    },
                );
            }
            state.persist_session(id);
            Ok(None)
        }
        PermissionAnswer::AllowAlways if is_opencode => {
            // `--auto` is all opencode has, so "always" can only mean it stops
            // asking in this chat — which the chip then says.
            remember_patterns(session, &pending);
            session.meta.permission_mode = egant_harness::PermissionMode::BypassPermissions;
            session.transcript.clear_permissions();
            dispatch(session, SessionCommand::ApproveAlways);
            dispatch(
                session,
                SessionCommand::SetPermissionMode(egant_harness::PermissionMode::BypassPermissions),
            );
            retry_last_turn(session);
            state.persist_session(id);
            Ok(Some(
                egant_harness::PermissionMode::BypassPermissions.as_cli_arg(),
            ))
        }
        PermissionAnswer::AllowAlways => {
            // The CLI's own rule when it offered one; it saves it and stops
            // asking for exactly that. Without one, the request's patterns
            // stand in for the rest of the run (see the listener).
            let update = egant_harness::always_allow_update(&pending.suggestions);
            if update.is_none() {
                remember_patterns(session, &pending);
            }
            session.transcript.resolve_permission(request_id);
            dispatch(
                session,
                SessionCommand::Permission {
                    request_id: pending.request_id,
                    decision: PermissionDecision::Allow {
                        updated_input: Some(pending.input),
                        updated_permissions: update.into_iter().collect(),
                    },
                },
            );
            state.persist_session(id);
            Ok(None)
        }
        PermissionAnswer::Answer { answers, notes } => {
            // Checked before the row goes: a refused answer leaves the
            // question up to be answered again.
            let input = answered_question_input(&pending.input, &answers, &notes)?;
            session.transcript.resolve_permission(request_id);
            dispatch(
                session,
                SessionCommand::Permission {
                    request_id: pending.request_id,
                    decision: PermissionDecision::Allow {
                        updated_input: Some(input),
                        updated_permissions: Vec::new(),
                    },
                },
            );
            state.persist_session(id);
            Ok(None)
        }
        PermissionAnswer::ApprovePlan { mode } => {
            session.transcript.resolve_permission(request_id);
            // The switch rides the approval — the CLI's own way, applied with
            // the plan — and is sent once more on its own behind it, the
            // request egant already uses for the mode picker.
            dispatch(
                session,
                SessionCommand::Permission {
                    request_id: pending.request_id,
                    decision: PermissionDecision::Allow {
                        updated_input: Some(pending.input),
                        updated_permissions: vec![set_mode_update(mode)],
                    },
                },
            );
            session.meta.permission_mode = mode;
            dispatch(session, SessionCommand::SetPermissionMode(mode));
            state.persist_session(id);
            Ok(Some(mode.as_cli_arg()))
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
            PermissionAnswer::Deny {
                feedback: None,
                stop: false,
            }
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
    let session = detach_session(state, id)?;
    // Closing is still meant to forget a session for good — persistence only
    // changes what quitting the app does, not what closing a tab does.
    crate::persist::delete_session(id);
    session.meta.worktree
}

/// Archives a session: its agent stops and it leaves the window, but what was
/// saved of it stays on disk, marked archived, to be restored or deleted
/// from Settings → Archived. Its worktree stays as it is, so a restored
/// session resumes where it ran.
///
/// The last save happens before the row goes — the file is keyed by the
/// project's path, which only the row still knows — and a save that fails
/// leaves the session open rather than taking it out of the window on the
/// strength of a file that says nothing about it.
pub fn archive_session(state: &mut AppState, id: u64) -> Result<(), String> {
    log::info!("archive session {id}");
    if !state.sessions.contains_key(&id) {
        return Err("unknown session".to_string());
    }
    if !state.persist_session_with(id, Some(unix_now_ms())) {
        return Err("couldn't save this session to the archive — it's still open".to_string());
    }
    detach_session(state, id);
    Ok(())
}

/// Brings an archived session back into the window and selects it. It comes
/// back ended, like any session restored at launch: its next message resumes
/// the agent.
pub fn unarchive_session(state: &mut AppState, id: u64) -> Result<(), String> {
    log::info!("unarchive session {id}");
    if state.sessions.contains_key(&id) {
        return Ok(());
    }
    let Some(mut persisted) = crate::persist::load_session(id) else {
        return Err("that archived session is gone".to_string());
    };
    let project_path = persisted.meta.project_path.clone();
    persisted.meta.archived_at_ms = None;
    let Some(session) = crate::state::restore_session(&state.projects, persisted) else {
        return Err(format!(
            "its project isn't open — open {} first",
            project_path.display()
        ));
    };
    let project_id = session.meta.project_id;
    let started = session.meta.started_unix_ms;
    state.sessions.insert(id, session);
    // Back where it was in time: the window's order is chronological.
    let position = state
        .order
        .iter()
        .position(|other| {
            state
                .sessions
                .get(other)
                .is_some_and(|other| other.meta.started_unix_ms > started)
        })
        .unwrap_or(state.order.len());
    state.order.insert(position, id);
    state.active_session = Some(id);
    state.active_project = Some(project_id);
    // Saved again without the mark, so it stays restored after a relaunch.
    state.persist_session(id);
    Ok(())
}

/// Deletes an archived session for good. Returns its worktree, when it had
/// one, for the caller to give back off-thread — the same hand-off as
/// [`close_session`].
pub fn delete_archived_session(id: u64) -> Result<Option<SessionWorktree>, String> {
    log::info!("delete archived session {id}");
    let Some(persisted) = crate::persist::load_session(id) else {
        return Ok(None); // already gone
    };
    if persisted.meta.archived_at_ms.is_none() {
        return Err("that session isn't archived".to_string());
    }
    crate::persist::delete_session(id);
    Ok(persisted.meta.worktree)
}

/// Takes a session out of the window: shuts its agent down, drops its row and
/// keeps the selection somewhere sensible. What happens to what was saved of
/// it is the caller's business — closing deletes it, archiving keeps it.
pub(crate) fn detach_session(
    state: &mut AppState,
    id: u64,
) -> Option<crate::state::ManagedSession> {
    let position = state.order.iter().position(|sid| *sid == id)?;
    let active_index = state
        .active_session
        .and_then(|active| state.order.iter().position(|sid| *sid == active));

    state.order.remove(position);
    let session = state.sessions.remove(&id);
    if let Some(commands) = session
        .as_ref()
        .and_then(|session| session.commands.as_ref())
    {
        let _ = commands.try_send(SessionCommand::Shutdown);
    }

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
    session
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
        MAX_ANSWER_CHARS, PermissionAnswer, PermissionDecision, answer_permission,
        answered_question_input, derive_title, harness_event_error_text,
        looks_like_a_bad_model_error, looks_like_a_long_context_rejection, matches_allowlist,
        set_mode_update,
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
            Some(PermissionAnswer::Deny {
                feedback: None,
                stop: false
            })
        );
        assert_eq!(PermissionAnswer::from_str_name("maybe"), None);
    }

    /// A session with `pending` outstanding, wired to a channel the test
    /// reads to see exactly what would reach the agent. The state has no
    /// projects on purpose: `persist_session` then has nowhere to write, so
    /// no test ever touches the real sessions folder.
    fn waiting_on(
        agent: egant_harness::AgentId,
        pending: egant_harness::PendingPermission,
    ) -> (
        crate::state::AppState,
        async_channel::Receiver<super::SessionCommand>,
    ) {
        let (tx, rx) = async_channel::unbounded();
        let mut transcript = egant_harness::Transcript::new();
        transcript.state = egant_harness::TurnState::AwaitingPermission;
        transcript.pending_permissions.push(pending.clone());
        transcript.pending_permission = Some(pending);
        let session = crate::state::ManagedSession {
            meta: crate::state::SessionMeta {
                id: 1,
                title: "t".into(),
                title_source: crate::state::TitleSource::User,
                project_id: 0,
                cwd: std::path::PathBuf::from("/tmp/egant-test"),
                branch: None,
                started_unix_ms: 1,
                agent,
                cli_agent: None,
                model: None,
                variant: None,
                context: None,
                permission_mode: egant_harness::PermissionMode::Auto,
                worktree: None,
                device: None,
                ended: false,
            },
            transcript,
            commands: Some(tx),
            allowed_patterns: Vec::new(),
            last_user_text: None,
            last_user_images: Vec::new(),
            turn_baseline: None,
            decisions: Default::default(),
            last_activity_ms: 0,
            queued: Default::default(),
            flush_next_end: false,
        };
        let state = crate::state::AppState {
            projects: Vec::new(),
            active_project: None,
            next_project_id: 0,
            sessions: std::collections::HashMap::from([(1, session)]),
            order: vec![1],
            active_session: Some(1),
            next_session_id: 2,
            settings: crate::settings::Settings::default(),
            sidebar_visible: true,
            bad_models: Default::default(),
        };
        (state, rx)
    }

    fn pending(
        tool: &str,
        input: serde_json::Value,
        suggestions: Vec<serde_json::Value>,
    ) -> egant_harness::PendingPermission {
        let (patterns, always_patterns) = egant_harness::permission_patterns(tool, &input);
        egant_harness::PendingPermission {
            request_id: "r1".into(),
            tool_name: tool.into(),
            input,
            patterns,
            always_patterns,
            suggestions,
            description: None,
            blocked_path: None,
        }
    }

    /// The decision the session sent the agent for its one request.
    fn sent_decision(rx: &async_channel::Receiver<super::SessionCommand>) -> PermissionDecision {
        match rx.try_recv().expect("a command was sent") {
            super::SessionCommand::Permission { decision, .. } => decision,
            _ => panic!("expected a permission answer first"),
        }
    }

    #[test]
    fn always_allow_on_claude_saves_the_rule_and_keeps_the_mode() {
        let suggestions = vec![
            serde_json::json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "git status:*"}],
                               "behavior": "allow", "destination": "localSettings"}),
            serde_json::json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
        ];
        let (mut state, rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending(
                "Bash",
                serde_json::json!({"command": "git status"}),
                suggestions,
            ),
        );
        let changed =
            answer_permission(&mut state, 1, "r1", PermissionAnswer::AllowAlways).unwrap();
        assert_eq!(changed, None, "no mode change to report");
        let session = &state.sessions[&1];
        assert_eq!(
            session.meta.permission_mode,
            egant_harness::PermissionMode::Auto
        );
        assert!(session.transcript.pending_permissions.is_empty());
        // The CLI's rule does the remembering, not egant's patterns.
        assert!(session.allowed_patterns.is_empty());
        match sent_decision(&rx) {
            PermissionDecision::Allow {
                updated_input,
                updated_permissions,
            } => {
                assert_eq!(updated_input.unwrap()["command"], "git status");
                assert_eq!(updated_permissions.len(), 1);
                assert_eq!(updated_permissions[0]["type"], "addRules");
            }
            other => panic!("unexpected {other:?}"),
        }
        // And nothing behind it switches the mode.
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn always_allow_without_a_suggested_rule_remembers_the_patterns() {
        let (mut state, rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending(
                "Read",
                serde_json::json!({"file_path": "/tmp/a/b.rs"}),
                Vec::new(),
            ),
        );
        answer_permission(&mut state, 1, "r1", PermissionAnswer::AllowAlways).unwrap();
        let session = &state.sessions[&1];
        assert_eq!(
            session.meta.permission_mode,
            egant_harness::PermissionMode::Auto
        );
        assert!(session.allowed_patterns.iter().any(|p| p == "/tmp/a/*"));
        assert!(matches!(
            sent_decision(&rx),
            PermissionDecision::Allow { ref updated_permissions, .. } if updated_permissions.is_empty()
        ));
    }

    #[test]
    fn a_question_is_answered_never_just_allowed() {
        let question = serde_json::json!({"questions": [{
            "question": "Which color?", "header": "Color", "multiSelect": false,
            "options": [{"label": "Red", "description": ""}, {"label": "Blue", "description": ""}]
        }]});
        let (mut state, rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending(egant_harness::ASK_USER_QUESTION, question, Vec::new()),
        );
        for answer in [PermissionAnswer::AllowOnce, PermissionAnswer::AllowAlways] {
            assert!(answer_permission(&mut state, 1, "r1", answer).is_err());
        }
        // A refused answer leaves the question up.
        assert_eq!(state.sessions[&1].transcript.pending_permissions.len(), 1);
        assert!(rx.try_recv().is_err());

        let answers = serde_json::json!({"Which color?": "Blue"})
            .as_object()
            .cloned()
            .unwrap();
        answer_permission(
            &mut state,
            1,
            "r1",
            PermissionAnswer::Answer {
                answers,
                notes: Default::default(),
            },
        )
        .unwrap();
        match sent_decision(&rx) {
            PermissionDecision::Allow { updated_input, .. } => {
                assert_eq!(updated_input.unwrap()["answers"]["Which color?"], "Blue");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_approved_plan_switches_the_mode() {
        let (mut state, rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending(
                egant_harness::EXIT_PLAN_MODE,
                serde_json::json!({"plan": "# Plan", "planFilePath": "/tmp/p.md"}),
                Vec::new(),
            ),
        );
        assert!(answer_permission(&mut state, 1, "r1", PermissionAnswer::AllowOnce).is_err());
        let changed = answer_permission(
            &mut state,
            1,
            "r1",
            PermissionAnswer::ApprovePlan {
                mode: egant_harness::PermissionMode::AcceptEdits,
            },
        )
        .unwrap();
        assert_eq!(changed, Some("acceptEdits"));
        assert_eq!(
            state.sessions[&1].meta.permission_mode,
            egant_harness::PermissionMode::AcceptEdits
        );
        match sent_decision(&rx) {
            PermissionDecision::Allow {
                updated_input,
                updated_permissions,
            } => {
                assert_eq!(updated_input.unwrap()["plan"], "# Plan");
                assert_eq!(updated_permissions[0]["type"], "setMode");
                assert_eq!(updated_permissions[0]["mode"], "acceptEdits");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(
            rx.try_recv(),
            Ok(super::SessionCommand::SetPermissionMode(
                egant_harness::PermissionMode::AcceptEdits
            ))
        ));
    }

    #[test]
    fn a_deny_hands_the_agent_the_users_words_and_can_stop_the_turn() {
        let (mut state, rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending(
                "Bash",
                serde_json::json!({"command": "rm -rf build"}),
                Vec::new(),
            ),
        );
        answer_permission(
            &mut state,
            1,
            "r1",
            PermissionAnswer::Deny {
                feedback: Some("Use `cargo clean` instead.".into()),
                stop: true,
            },
        )
        .unwrap();
        match sent_decision(&rx) {
            PermissionDecision::Deny { reason, interrupt } => {
                assert_eq!(reason, "Use `cargo clean` instead.");
                assert!(interrupt);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn opencode_always_allow_still_means_stop_asking() {
        let (mut state, _rx) = waiting_on(
            egant_harness::AgentId::Opencode,
            pending(
                "Read",
                serde_json::json!({"filePath": "/tmp/x"}),
                Vec::new(),
            ),
        );
        let changed =
            answer_permission(&mut state, 1, "r1", PermissionAnswer::AllowAlways).unwrap();
        assert_eq!(changed, Some("bypassPermissions"));
        assert_eq!(
            state.sessions[&1].meta.permission_mode,
            egant_harness::PermissionMode::BypassPermissions
        );
    }

    #[test]
    fn a_message_sent_mid_turn_waits_without_touching_the_transcript() {
        let (mut state, _rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending("Bash", serde_json::json!({"command": "ls"}), Vec::new()),
        );
        let session = state.sessions.get_mut(&1).unwrap();
        session.transcript.pending_permissions.clear();
        session.transcript.state = egant_harness::TurnState::Running;
        let before = session.transcript.entries.len();

        let outcome = super::enqueue_if_busy(session, "and also this".into(), Vec::new()).unwrap();
        assert!(outcome.queued);
        assert_eq!(session.transcript.entries.len(), before, "no bubble yet");
        assert_eq!(session.queued.len(), 1);

        // Idle, it goes straight out instead.
        session.transcript.state = egant_harness::TurnState::Idle;
        assert!(super::enqueue_if_busy(session, "now".into(), Vec::new()).is_err());
        assert_eq!(session.queued.len(), 1);

        // A session with no process behind it is revived, never queued.
        session.transcript.state = egant_harness::TurnState::Running;
        session.commands = None;
        assert!(super::enqueue_if_busy(session, "later".into(), Vec::new()).is_err());
    }

    #[test]
    fn a_turns_end_lets_out_one_message_and_only_when_it_ended_cleanly() {
        let (mut state, _rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending("Bash", serde_json::json!({"command": "ls"}), Vec::new()),
        );
        let session = state.sessions.get_mut(&1).unwrap();
        session.transcript.pending_permissions.clear();
        session.transcript.state = egant_harness::TurnState::Running;
        for text in ["first", "second"] {
            super::enqueue_if_busy(session, text.into(), Vec::new()).unwrap();
        }
        session.transcript.state = egant_harness::TurnState::Idle;

        // A failed or stopped turn leaves the queue for the user.
        assert!(super::next_to_flush(session, false).is_none());
        assert_eq!(session.queued.len(), 2);

        // A clean end lets out exactly the oldest.
        assert_eq!(super::next_to_flush(session, true).unwrap().text, "first");
        assert_eq!(session.queued.len(), 1);

        // Something waiting on the user holds the queue back...
        session.transcript.pending_permissions.push(pending(
            "Bash",
            serde_json::json!({"command": "ls"}),
            Vec::new(),
        ));
        assert!(super::next_to_flush(session, true).is_none());

        // ...unless "Send now" stopped the turn, which lets it out whatever
        // the end, and clears the prompts nobody is left to answer.
        session.flush_next_end = true;
        assert_eq!(super::next_to_flush(session, false).unwrap().text, "second");
        assert!(session.transcript.pending_permissions.is_empty());
        assert!(!session.flush_next_end, "the request is used up");
    }

    #[test]
    fn a_generated_title_replaces_only_the_opening_line() {
        let (mut state, _rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending("Bash", serde_json::json!({"command": "ls"}), Vec::new()),
        );
        let meta = &mut state.sessions.get_mut(&1).unwrap().meta;

        meta.title = "Fix the grid it overlaps the sidebar at…".into();
        meta.title_source = crate::state::TitleSource::FirstLine;
        assert_eq!(
            super::settle_generated_title(meta, Some("Fix Sidebar Grid Overlap".into())),
            Some("Fix Sidebar Grid Overlap".into())
        );
        assert_eq!(meta.title, "Fix Sidebar Grid Overlap");
        assert_eq!(meta.title_source, crate::state::TitleSource::Generated);

        // A run that came back empty settles the opening line instead of
        // trying again every turn.
        meta.title = "Opening line".into();
        meta.title_source = crate::state::TitleSource::FirstLine;
        assert_eq!(super::settle_generated_title(meta, None), None);
        assert_eq!(meta.title, "Opening line");
        assert_eq!(meta.title_source, crate::state::TitleSource::Generated);

        // What the user typed is never replaced.
        meta.title = "My name for it".into();
        meta.title_source = crate::state::TitleSource::User;
        assert_eq!(
            super::settle_generated_title(meta, Some("Other".into())),
            None
        );
        assert_eq!(meta.title, "My name for it");
    }

    #[test]
    fn a_rename_is_the_users_and_stays_tidy() {
        let (mut state, _rx) = waiting_on(
            egant_harness::AgentId::Claude,
            pending("Bash", serde_json::json!({"command": "ls"}), Vec::new()),
        );
        assert_eq!(
            super::rename_session(&mut state, 1, "  Ship   the  archive \n").unwrap(),
            "Ship the archive"
        );
        assert_eq!(
            state.sessions[&1].meta.title_source,
            crate::state::TitleSource::User
        );
        assert!(super::rename_session(&mut state, 1, "   ").is_err());
        assert!(super::rename_session(&mut state, 1, &"x".repeat(121)).is_err());
        assert!(super::rename_session(&mut state, 9, "Nope").is_err());
    }

    #[test]
    fn a_deny_carries_trimmed_feedback_and_the_stop_flag() {
        let answer = PermissionAnswer::from_parts(
            "deny",
            None,
            None,
            Some("  use probe-z.txt instead  ".into()),
            Some(true),
            None,
        )
        .unwrap();
        assert_eq!(
            answer,
            PermissionAnswer::Deny {
                feedback: Some("use probe-z.txt instead".into()),
                stop: true
            }
        );
        // Blank feedback is no feedback: the stock refusal goes out instead.
        let answer =
            PermissionAnswer::from_parts("deny", None, None, Some("   ".into()), None, None)
                .unwrap();
        assert_eq!(
            answer,
            PermissionAnswer::Deny {
                feedback: None,
                stop: false
            }
        );
    }

    #[test]
    fn a_plan_is_approved_into_a_mode_other_than_plan() {
        assert_eq!(
            PermissionAnswer::from_parts(
                "approve-plan",
                None,
                None,
                None,
                None,
                Some("acceptEdits")
            ),
            Ok(PermissionAnswer::ApprovePlan {
                mode: egant_harness::PermissionMode::AcceptEdits
            })
        );
        assert!(
            PermissionAnswer::from_parts("approve-plan", None, None, None, None, Some("plan"))
                .is_err()
        );
        assert!(
            PermissionAnswer::from_parts("approve-plan", None, None, None, None, None).is_err()
        );
        assert!(PermissionAnswer::from_parts("perhaps", None, None, None, None, None).is_err());
    }

    #[test]
    fn manual_is_default_inside_a_mode_update() {
        assert_eq!(
            set_mode_update(egant_harness::PermissionMode::Manual)["mode"],
            "default"
        );
        assert_eq!(
            set_mode_update(egant_harness::PermissionMode::AcceptEdits)["mode"],
            "acceptEdits"
        );
    }

    /// The question the CLI actually asked in the capture this was built from.
    fn color_question(multi: bool) -> serde_json::Value {
        serde_json::json!({"questions": [{
            "question": "Which color do you prefer?",
            "header": "Color",
            "options": [
                {"label": "Red", "description": "The color red"},
                {"label": "Blue", "description": "The color blue"}
            ],
            "multiSelect": multi
        }]})
    }

    fn map(value: serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn an_answer_echoes_the_question_and_adds_the_pick() {
        let input = color_question(false);
        let answered = answered_question_input(
            &input,
            &map(serde_json::json!({"Which color do you prefer?": "Blue"})),
            &map(serde_json::json!({"Which color do you prefer?": "  for the header  "})),
        )
        .unwrap();
        // The CLI refuses any change to what it asked, so it goes back as is.
        assert_eq!(answered["questions"], input["questions"]);
        assert_eq!(answered["answers"]["Which color do you prefer?"], "Blue");
        assert_eq!(
            answered["annotations"]["Which color do you prefer?"]["notes"],
            "for the header"
        );
    }

    #[test]
    fn answers_are_held_to_the_clis_rules() {
        let single = color_question(false);
        let none = serde_json::Map::new();
        // Nothing picked.
        assert!(answered_question_input(&single, &none, &none).is_err());
        // A question nobody asked.
        assert!(
            answered_question_input(&single, &map(serde_json::json!({"Why?": "Red"})), &none)
                .is_err()
        );
        // Several picks for a single-select question.
        assert!(
            answered_question_input(
                &single,
                &map(serde_json::json!({"Which color do you prefer?": ["Red", "Blue"]})),
                &none
            )
            .is_err()
        );
        // Too long.
        let long = "x".repeat(MAX_ANSWER_CHARS + 1);
        assert!(
            answered_question_input(
                &single,
                &map(serde_json::json!({"Which color do you prefer?": long})),
                &none
            )
            .is_err()
        );

        // Several picks are fine where the question allows them — up to every
        // option plus one free-text answer.
        let multi = color_question(true);
        assert!(
            answered_question_input(
                &multi,
                &map(serde_json::json!({"Which color do you prefer?": ["Red", "Blue", "Green"]})),
                &none
            )
            .is_ok()
        );
        assert!(
            answered_question_input(
                &multi,
                &map(serde_json::json!({"Which color do you prefer?": ["Red", "Blue", "Green", "Teal"]})),
                &none
            )
            .is_err()
        );
    }
}
