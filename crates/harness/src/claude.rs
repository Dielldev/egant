//! Drives the `claude` CLI as a subprocess.
//!
//! The CLI is started in its programmatic mode:
//!
//! ```text
//! claude --print --verbose \
//!        --output-format stream-json \
//!        --input-format  stream-json \
//!        --include-partial-messages \
//!        --permission-prompts host
//! ```
//!
//! which turns stdin/stdout into a bidirectional stream of newline-delimited
//! JSON. `--permission-prompts host` is what routes tool approvals to this app
//! instead of a terminal prompt, and `--include-partial-messages` is what makes
//! the transcript stream rather than appear in one lump.
//!
//! Reading is not done on a runtime of our own: [`ClaudeCode::spawn`] hands
//! back an [`EventPump`] the caller drives on whatever executor it already has
//! (in this app, GPUI's background executor). That keeps this crate free of a
//! runtime choice and makes it testable without one.

use crate::protocol::{
    CliMessage, ContentBlock, ControlRequest, HostContentBlock, HostControlRequest,
    HostControlResponse, HostMessage, HostUserMessage, ImageSource,
};
use crate::{
    AgentId, Harness, HarnessError, HarnessEvent, PermissionDecision, PermissionMode, SessionId,
    TurnProgress, TurnUsage,
};
use anyhow::{Context as _, Result};
use async_channel::{Receiver, Sender};
use async_process::{Child, ChildStdin, Command, Stdio};
use async_trait::async_trait;
use futures_lite::{AsyncBufReadExt as _, AsyncWriteExt as _, StreamExt as _, io::BufReader};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone)]
pub struct ClaudeOptions {
    /// Binary to run. Left as `claude` it is resolved on `PATH`.
    pub program: PathBuf,
    /// Working directory the agent operates in — for an isolated session, the
    /// path of a git worktree rather than the user's checkout.
    pub cwd: PathBuf,
    /// Human name of the project `cwd` belongs to (`Arka` for `…/Arka`).
    /// Grounded into the session via `--append-system-prompt` and a per-turn
    /// envelope so "what folder am I in" answers with this project instead of
    /// whichever one the model saw most recently. `None` derives it from
    /// `cwd`.
    pub project_name: Option<String>,
    pub model: Option<String>,
    /// Reasoning effort for the turn (`low`, `medium`, `high`, `xhigh`,
    /// `max`). `None` keeps the CLI default.
    pub effort: Option<String>,
    /// Context window to run with, in tokens. Claude's CLI has no flag for
    /// this — it takes the wider window as a suffix on the model id
    /// (`--model claude-sonnet-5[1m]`), which is why this is applied in
    /// [`ClaudeOptions::to_args`] rather than pushed as an argument of its
    /// own. `None`, or anything under a million, leaves the model's standard
    /// window alone.
    pub context_window: Option<u64>,
    pub permission_mode: PermissionMode,
    /// Continue an earlier conversation instead of starting fresh.
    pub resume: Option<SessionId>,
    /// The id a *fresh* conversation is given, so it is resumable from the
    /// moment the process starts rather than only once the agent's `init`
    /// frame lands. Ignored when `resume` is set; `None` lets
    /// [`ClaudeCode::spawn`] mint one.
    pub session_id: Option<SessionId>,
    /// Stream partial messages. Off makes the transcript appear per-message.
    pub stream_partial: bool,
    /// Escape hatch for flags this struct does not model yet.
    pub extra_args: Vec<String>,
}

/// The model id as `--model` should receive it: `claude-opus-5` normally,
/// `claude-opus-5[1m]` when a million-token window was asked for. An id that
/// already carries a suffix is left exactly as typed — a custom id is the
/// user's own words, and rewriting it would be guessing.
fn one_million_suffix(model: &str, context_window: Option<u64>) -> String {
    let wants_1m = context_window.is_some_and(|tokens| tokens >= 1_000_000);
    if wants_1m && !model.contains('[') {
        format!("{model}[1m]")
    } else {
        model.to_string()
    }
}

impl Default for ClaudeOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("claude"),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            project_name: None,
            model: None,
            effort: None,
            context_window: None,
            permission_mode: PermissionMode::default(),
            resume: None,
            session_id: None,
            stream_partial: true,
            extra_args: Vec::new(),
        }
    }
}

impl ClaudeOptions {
    fn project_name_resolved(&self) -> String {
        self.project_name
            .clone()
            .unwrap_or_else(|| crate::project_display_name(&self.cwd))
    }

    fn to_args(&self) -> Vec<String> {
        let mut args = vec![
            "--print".into(),
            "--verbose".into(),
            "--output-format".into(),
            "stream-json".into(),
            "--input-format".into(),
            "stream-json".into(),
            "--permission-prompts".into(),
            "host".into(),
            // What the Agent SDK passes when its host answers prompts. It is
            // what the CLI checks before registering the tools that need a
            // person — AskUserQuestion, EnterPlanMode, ExitPlanMode — so
            // without it Plan mode has no way to hand a plan back. (Measured
            // on 2.1.276: without it the tool list lacks all three, and
            // `manual` mode denies writes outright instead of asking.)
            "--permission-prompt-tool".into(),
            "stdio".into(),
            "--permission-mode".into(),
            self.permission_mode.as_cli_arg().into(),
        ];
        if self.stream_partial {
            args.push("--include-partial-messages".into());
        }
        if let Some(model) = &self.model {
            args.push("--model".into());
            args.push(one_million_suffix(model, self.context_window));
        }
        if let Some(effort) = &self.effort {
            args.push("--effort".into());
            args.push(effort.clone());
        }
        if let Some(session) = &self.resume {
            args.push("--resume".into());
            args.push(session.clone());
        } else if let Some(session) = &self.session_id {
            args.push("--session-id".into());
            args.push(session.clone());
        }
        // Ground the model in its project. A resumed CLI reuses the recorded
        // prompt verbatim, so passing the same text on resume is what keeps a
        // revived `Arka` thread answering as `Arka` rather than drifting back
        // to whatever project dominated its history.
        args.push("--append-system-prompt".into());
        args.push(crate::project_system_prompt(
            &self.project_name_resolved(),
            &self.cwd,
        ));
        args.extend(self.extra_args.iter().cloned());
        args
    }
}

/// A fresh conversation id. `--session-id` takes a UUID and rejects anything
/// else, so this is not a place to invent a friendlier format.
fn new_session_id() -> SessionId {
    uuid::Uuid::new_v4().to_string()
}

pub struct ClaudeCode {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<HarnessEvent>,
    session_id: Arc<Mutex<Option<SessionId>>>,
    next_request_id: u64,
    project_name: String,
    cwd: PathBuf,
}

/// The read side of a session. Drive it with `pump.run().await` on a background
/// executor; it finishes when the child's stdout closes.
pub struct EventPump {
    stdout: async_process::ChildStdout,
    stderr: async_process::ChildStderr,
    events: Sender<HarnessEvent>,
    session_id: Arc<Mutex<Option<SessionId>>>,
}

impl ClaudeCode {
    pub fn spawn(options: ClaudeOptions) -> Result<(Self, EventPump)> {
        // A conversation the app names before it starts is one it can always
        // resume. Learning the id from the CLI's `init` frame instead means a
        // session that dies before the handshake — a rejected model id, a CLI
        // that exits on a bad flag — leaves nothing on disk pointing at it,
        // and comes back as "nothing to resume". `--session-id` puts the app
        // in charge of that id instead of the agent.
        let mut options = options;
        if options.resume.is_none() && options.session_id.is_none() {
            options.session_id = Some(new_session_id());
        }

        let mut child = Command::new(&options.program)
            .args(options.to_args())
            .current_dir(&options.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| {
                log::error!(
                    "claude spawn failed program={} cwd={}: {source}",
                    options.program.display(),
                    options.cwd.display(),
                );
                HarnessError::Spawn {
                    program: options.program.display().to_string(),
                    source,
                }
            })?;
        log::info!(
            "claude spawned cwd={} model={:?} resume={}",
            options.cwd.display(),
            options.model,
            options.resume.is_some(),
        );

        let stdin = child.stdin.take().context("child stdin was not piped")?;
        let stdout = child.stdout.take().context("child stdout was not piped")?;
        let stderr = child.stderr.take().context("child stderr was not piped")?;

        // Bounded so a stalled UI applies backpressure instead of growing the
        // queue without limit during a long tool-heavy turn.
        let (tx, rx) = async_channel::bounded(1024);
        // Populated before the first byte is read: `resume` when continuing,
        // otherwise the id just minted for this conversation.
        let session_id = Arc::new(Mutex::new(
            options
                .resume
                .clone()
                .or_else(|| options.session_id.clone()),
        ));

        let pump = EventPump {
            stdout,
            stderr,
            events: tx,
            session_id: session_id.clone(),
        };

        Ok((
            Self {
                child,
                stdin,
                events: rx,
                session_id,
                next_request_id: 1,
                project_name: options.project_name_resolved(),
                cwd: options.cwd.clone(),
            },
            pump,
        ))
    }

    async fn write(&mut self, message: &HostMessage) -> Result<()> {
        let mut line = serde_json::to_vec(message)?;
        line.push(b'\n');
        self.stdin.write_all(&line).await?;
        self.stdin.flush().await?;
        Ok(())
    }

    fn take_request_id(&mut self) -> String {
        let id = self.next_request_id;
        self.next_request_id += 1;
        format!("req_{id}")
    }
}

#[async_trait]
impl Harness for ClaudeCode {
    fn backend_name(&self) -> &'static str {
        "Claude Code"
    }

    fn agent_id(&self) -> AgentId {
        AgentId::Claude
    }

    fn session_id(&self) -> Option<SessionId> {
        // Behind a lock because the pump is what discovers it, from the init
        // frame, after this handle already exists.
        self.session_id.lock().ok().and_then(|id| id.clone())
    }

    fn events(&self) -> Receiver<HarnessEvent> {
        self.events.clone()
    }

    async fn send(&mut self, text: String, images: Vec<PathBuf>) -> Result<()> {
        log::debug!(
            "claude send ({} chars, {} image(s))",
            text.len(),
            images.len()
        );
        // Grounded every turn, not just via the system prompt: sessions
        // created before grounding existed, and resumes that reuse a recorded
        // prompt, still answer with the directory this process runs in. A
        // slash command goes out as typed: the CLI only acts on one that
        // opens the message.
        let text = if is_slash_command(&text) {
            text
        } else {
            crate::wrap_turn_with_project(&self.project_name, &self.cwd, &text)
        };
        let mut content = vec![HostContentBlock::Text { text }];
        // Real vision blocks, not `@path` mentions left for the model to go
        // read itself — the same shape the Messages API takes an image in
        // anywhere else.
        for image in &images {
            match image_content_block(image) {
                Ok(block) => content.push(block),
                Err(error) => {
                    log::warn!("couldn't attach pasted image {}: {error}", image.display());
                }
            }
        }
        let message = HostMessage::User {
            message: HostUserMessage {
                role: "user",
                content,
            },
            session_id: self.session_id(),
        };
        self.write(&message).await
    }

    async fn interrupt(&mut self) -> Result<()> {
        log::debug!("claude interrupt");
        let request_id = self.take_request_id();
        let message = HostMessage::ControlRequest {
            request_id,
            request: HostControlRequest::Interrupt,
        };
        self.write(&message).await
    }

    async fn respond_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<()> {
        let response = match decision {
            PermissionDecision::Allow {
                updated_input,
                updated_permissions,
            } => HostControlResponse::allow(request_id, updated_input, updated_permissions),
            PermissionDecision::Deny { reason, interrupt } => {
                HostControlResponse::deny(request_id, reason, interrupt)
            }
        };
        self.write(&HostMessage::ControlResponse { response }).await
    }

    async fn shutdown(&mut self) -> Result<()> {
        log::info!("claude shutdown");
        // Closing stdin is the graceful stop: the CLI finishes any in-flight
        // turn and exits on EOF.
        self.stdin.close().await.ok();
        match self.child.try_status()? {
            Some(_) => Ok(()),
            None => {
                self.child.kill().ok();
                self.child.status().await?;
                Ok(())
            }
        }
    }

    /// Changes how much the agent may do unattended, mid-session.
    async fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<()> {
        let request_id = self.take_request_id();
        let message = HostMessage::ControlRequest {
            request_id,
            request: HostControlRequest::SetPermissionMode {
                mode: mode.as_cli_arg().to_string(),
            },
        };
        self.write(&message).await
    }
}

/// Whether a turn is a slash command — `/compact`, `/review src/lib.rs`. The
/// CLI only runs one that is the very first thing in the message, so the
/// project envelope in front of it would turn it into prose for the model.
///
/// Only the shape matters here. A leading word that is a path (`/etc/hosts
/// is broken`) is not a command name, and keeps its envelope; a command-shaped
/// word the CLI doesn't know (`/frobnicate`) still reaches the model as an
/// ordinary prompt (measured on 2.1.276), it just goes without the envelope.
fn is_slash_command(text: &str) -> bool {
    let Some(rest) = text.strip_prefix('/') else {
        return false;
    };
    let name = rest.split(char::is_whitespace).next().unwrap_or("");
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':' | '.'))
}

/// Reads an image file and wraps it as the base64 vision block the Messages
/// API takes anywhere an image belongs — same shape whether it arrived as a
/// clipboard paste or a picked attachment.
fn image_content_block(path: &std::path::Path) -> Result<HostContentBlock> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    let data = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes);
    Ok(HostContentBlock::Image {
        source: ImageSource::Base64 {
            media_type: image_media_type(path).to_string(),
            data,
        },
    })
}

/// Best-effort media type from the file's extension. Anthropic's vision input
/// only accepts a handful of raster formats; anything else falls back to PNG
/// rather than failing the whole turn over a guess.
fn image_media_type(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| ext.to_ascii_lowercase())
        .as_deref()
    {
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        _ => "image/png",
    }
}

impl EventPump {
    /// Reads until the child's stdout closes, translating wire messages into
    /// [`HarnessEvent`]s. Returns when the process is done.
    pub async fn run(self) {
        let EventPump {
            stdout,
            stderr,
            events,
            session_id,
        } = self;

        // stderr carries CLI diagnostics that never appear on the JSON stream.
        // Surfacing it is the difference between "nothing happened" and a
        // readable reason.
        let stderr_events = events.clone();
        let stderr_task = async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Some(Ok(line)) = lines.next().await {
                if line.trim().is_empty() {
                    continue;
                }
                log::warn!("claude stderr: {line}");
                let _ = stderr_events
                    .send(HarnessEvent::Error { message: line })
                    .await;
            }
        };

        let stdout_task = async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Some(line) = lines.next().await {
                let line = match line {
                    Ok(line) => line,
                    Err(error) => {
                        let _ = events
                            .send(HarnessEvent::Error {
                                message: format!("read error: {error}"),
                            })
                            .await;
                        break;
                    }
                };
                if line.trim().is_empty() {
                    continue;
                }

                let message: CliMessage = match serde_json::from_str(&line) {
                    Ok(message) => message,
                    Err(error) => {
                        // A frame we cannot parse is worth reporting but never
                        // worth ending the session over.
                        log::debug!("unparsed frame: {line}");
                        let _ = events
                            .send(HarnessEvent::Error {
                                message: format!("malformed frame: {error}"),
                            })
                            .await;
                        continue;
                    }
                };

                for event in translate(message, &session_id) {
                    if events.send(event).await.is_err() {
                        return; // receiver dropped: the session's UI is gone.
                    }
                }
            }
            log::info!("claude stdout closed; process exited");
            let _ = events.send(HarnessEvent::Exited { code: None }).await;
        };

        futures_lite::future::zip(stdout_task, stderr_task).await;
    }
}

/// Maps one wire message onto zero or more app-level events.
fn translate(message: CliMessage, session_id: &Mutex<Option<SessionId>>) -> Vec<HarnessEvent> {
    use crate::protocol::{BlockDelta, StreamEventKind};

    match message {
        CliMessage::System(system) => {
            let system = *system;
            if let Ok(mut slot) = session_id.lock() {
                *slot = Some(system.session_id.clone());
            }
            match system.subtype.as_str() {
                "init" => vec![HarnessEvent::Ready {
                    session_id: system.session_id,
                    model: system.model,
                    cwd: system.cwd,
                    tools: system.tools,
                }],
                "status" => status_events(&system),
                "compact_boundary" => {
                    let metadata = system.compact_metadata.unwrap_or_default();
                    vec![HarnessEvent::Compacted {
                        auto: metadata.trigger == "auto",
                        tokens_before: metadata.pre_tokens,
                        tokens_after: metadata.post_tokens,
                    }]
                }
                // A request failed in a way the CLI retries (overloaded, rate
                // limited, a dropped connection), and it is waiting before the
                // next attempt. Without this the wait reads as a hang.
                "api_retry" => {
                    let delay_ms = system.retry_delay_ms.unwrap_or(0);
                    vec![HarnessEvent::Progress {
                        progress: Some(TurnProgress::Retrying {
                            attempt: system.attempt.unwrap_or(1),
                            max_retries: system.max_retries.unwrap_or(0),
                            retry_at_ms: crate::unix_now_ms().saturating_add(delay_ms),
                            reason: retry_reason(system.error.as_str(), system.error_status),
                        }),
                    }]
                }
                // Turn-scoped on the CLI's side: the next message tries the
                // model that was asked for again.
                "model_fallback" => {
                    let from = system.original_model.unwrap_or_default();
                    let to = system.fallback_model.unwrap_or_default();
                    let message = system
                        .content
                        .filter(|text| !text.trim().is_empty())
                        .unwrap_or_else(|| format!("Switched to {to} because {from} failed"));
                    vec![HarnessEvent::ModelFallback { from, to, message }]
                }
                _ => Vec::new(),
            }
        }

        CliMessage::Assistant(turn) => {
            if let Some(error) = turn.error {
                return vec![HarnessEvent::Error {
                    message: format!("{error}: {}", turn.message.content.as_text()),
                }];
            }
            let mut events = Vec::new();
            // The live occupancy reading. Each assistant message carries the
            // prompt footprint of one API call; the turn-end `usage` sums
            // every call in a multi-step turn, so only this per-step number
            // is an honest "in context" figure. Subagent steps are skipped:
            // their transcript is not what fills the main window. Duplicates
            // from split stream events just rewrite the same value.
            if turn.parent_tool_use_id.is_none() {
                if let Some(usage) = &turn.message.usage {
                    let tokens = usage.input_tokens
                        + usage.output_tokens
                        + usage.cache_creation_input_tokens
                        + usage.cache_read_input_tokens;
                    if tokens > 0 {
                        events.push(HarnessEvent::ContextUpdate {
                            context_tokens: tokens,
                            // The window only arrives on the result message;
                            // `record` keeps the last one it was told.
                            context_window: 0,
                        });
                    }
                }
            }
            for block in turn.message.content.blocks() {
                match block {
                    ContentBlock::ToolUse { id, name, input } => {
                        events.push(HarnessEvent::ToolUse {
                            id: id.clone(),
                            name: name.clone(),
                            input: input.clone(),
                        })
                    }
                    ContentBlock::Text { .. } | ContentBlock::Thinking { .. } => {}
                    _ => {}
                }
            }
            let text = turn.message.content.as_text();
            if !text.is_empty() {
                events.push(HarnessEvent::AssistantMessage { text });
            }
            events
        }

        // `user` messages carry tool results back into the transcript.
        CliMessage::User(turn) => turn
            .message
            .content
            .blocks()
            .iter()
            .filter_map(|block| match block {
                ContentBlock::ToolResult {
                    tool_use_id,
                    content,
                    is_error,
                } => Some(HarnessEvent::ToolResult {
                    id: tool_use_id.clone(),
                    output: stringify(content),
                    is_error: *is_error,
                }),
                _ => None,
            })
            .collect(),

        CliMessage::StreamEvent(stream) => match stream.event {
            StreamEventKind::ContentBlockDelta { delta, .. } => match delta {
                BlockDelta::TextDelta { text } => vec![HarnessEvent::AssistantDelta { text }],
                BlockDelta::ThinkingDelta { thinking } => {
                    vec![HarnessEvent::ThinkingDelta { text: thinking }]
                }
                _ => Vec::new(),
            },
            _ => Vec::new(),
        },

        CliMessage::Result(result) => {
            // Read before the partial moves below; `modelUsage` is the only
            // place the CLI states the window this turn ran under.
            let context_window = result.context_window();
            let usage = result.usage.unwrap_or_default();
            vec![HarnessEvent::TurnEnded {
                result: result.result,
                is_error: result.is_error,
                duration_ms: result.duration_ms,
                cost_usd: result.total_cost_usd,
                usage: TurnUsage {
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cache_creation_tokens: usage.cache_creation_input_tokens,
                    cache_read_tokens: usage.cache_read_input_tokens,
                    context_window,
                },
            }]
        }

        CliMessage::ControlRequest(envelope) => match envelope.request {
            ControlRequest::CanUseTool {
                tool_name,
                input,
                permission_suggestions,
                description,
                blocked_path,
                ..
            } => {
                let (patterns, always_patterns) = crate::permission_patterns(&tool_name, &input);
                vec![HarnessEvent::PermissionRequest {
                    request_id: envelope.request_id,
                    tool_name,
                    input,
                    patterns,
                    always_patterns,
                    suggestions: permission_suggestions,
                    description: description.filter(|text| !text.trim().is_empty()),
                    blocked_path: blocked_path.filter(|path| !path.trim().is_empty()),
                }]
            }
            ControlRequest::Unknown => Vec::new(),
        },

        CliMessage::ControlResponse(_) | CliMessage::Unknown => Vec::new(),
    }
}

/// What one `status` frame says: the mode the CLI now runs under, when it
/// names one — after an approved plan switched it, say, or Claude entered
/// plan mode on its own — and what it is busy with.
///
/// `compacting` starts a compaction. `requesting` is an API call going out,
/// which means whatever the turn was waiting on — a retry's delay, a
/// compaction — is over. A bare `null` ends a compaction too, but a `null`
/// that comes with a mode is only the mode report, and says nothing about
/// progress.
fn status_events(system: &crate::protocol::SystemMessage) -> Vec<HarnessEvent> {
    let mut events = Vec::new();
    // A name this build doesn't know changes nothing.
    if let Some(mode) = system
        .permission_mode
        .as_deref()
        .and_then(PermissionMode::from_cli_arg)
    {
        events.push(HarnessEvent::ModeChanged { mode });
    }
    match system.status.as_deref() {
        Some("compacting") => events.push(HarnessEvent::Progress {
            progress: Some(TurnProgress::Compacting),
        }),
        Some("requesting") => events.push(HarnessEvent::Progress { progress: None }),
        None if system.permission_mode.is_none() => {
            events.push(HarnessEvent::Progress { progress: None })
        }
        _ => {}
    }
    // An automatic compaction that fails leaves the turn to run into a
    // context that is still full — the error that follows needs this to
    // make sense.
    if system.compact_result.as_deref() == Some("failed") {
        let why = system
            .compact_error
            .as_deref()
            .map(str::trim)
            .filter(|why| !why.is_empty())
            .unwrap_or("no reason given");
        events.push(HarnessEvent::Error {
            message: format!("Couldn't compact the conversation: {why}"),
        });
    }
    events
}

/// A retry's cause as the status line words it, from the CLI's own word for
/// the failure and the HTTP status, if there was one. `unknown` without a
/// status is a request that never got an answer at all — what a refused or
/// dropped connection reports.
fn retry_reason(kind: Option<&str>, status: Option<u32>) -> String {
    let reason = match kind.unwrap_or("unknown") {
        "overloaded" => "the API is overloaded",
        "rate_limit" => "rate limited",
        "server_error" => "server error",
        "authentication_failed" => "authentication failed",
        "billing_error" => "billing problem",
        "invalid_request" => "invalid request",
        "model_not_found" => "model not found",
        "unknown" if status.is_none() => "connection failed",
        "unknown" => "request failed",
        other => return other.replace('_', " "),
    };
    match status {
        Some(code) if kind == Some("server_error") || kind == Some("unknown") => {
            format!("{reason} ({code})")
        }
        _ => reason.to_string(),
    }
}

/// Tool results are either a string or a block list; the transcript wants text.
fn stringify(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => {
            items.iter().map(block_text).collect::<Vec<_>>().join("\n")
        }
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// One block of a tool result, as the transcript keeps it. Text is itself.
/// A picture (a Read of a screenshot) or a document is said for what it is —
/// `[image: image/png, 412 KB]` — rather than kept as its base64: as text
/// that is the picture's whole size again in the saved session, and a wall
/// of characters in its tool card. Anything else stays as its JSON.
fn block_text(block: &serde_json::Value) -> String {
    if let Some(text) = block.get("text").and_then(serde_json::Value::as_str) {
        return text.to_owned();
    }
    let kind = block.get("type").and_then(serde_json::Value::as_str);
    let (Some(kind @ ("image" | "document")), Some(source)) = (kind, block.get("source")) else {
        return block.to_string();
    };
    let media = source
        .get("media_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or(kind);
    match source.get("data").and_then(serde_json::Value::as_str) {
        Some(data) => format!("[{kind}: {media}, {}]", size_label(base64_len(data))),
        None => format!("[{kind}: {media}]"),
    }
}

/// How many bytes a base64 string decodes to, without decoding it. Padded or
/// not: each character carries six bits, and `=` carries none.
fn base64_len(data: &str) -> usize {
    let padding = data.bytes().rev().take_while(|&b| b == b'=').count();
    (data.len() - padding) * 3 / 4
}

/// A byte count at a glance: `74 bytes`, `412 KB`, `1.2 MB`.
fn size_label(bytes: usize) -> String {
    const KB: usize = 1024;
    const MB: usize = 1024 * 1024;
    if bytes < KB {
        format!("{bytes} bytes")
    } else if bytes < MB {
        format!("{} KB", bytes.div_ceil(KB))
    } else {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_streaming_args() {
        let args = ClaudeOptions::default().to_args();
        assert!(args.contains(&"--output-format".to_string()));
        assert!(args.contains(&"stream-json".to_string()));
        assert!(args.contains(&"--include-partial-messages".to_string()));
        // Permission prompts must reach the app, not a terminal.
        assert!(args.contains(&"host".to_string()));
        // And through the SDK's own channel, which is what registers
        // AskUserQuestion and ExitPlanMode at all.
        let index = args
            .iter()
            .position(|a| a == "--permission-prompt-tool")
            .expect("the stdio prompt tool is always passed");
        assert_eq!(args[index + 1], "stdio");
    }

    /// Captured from CLI 2.1.276 with `--permission-prompt-tool stdio`.
    const CAN_USE_ASK: &str = r#"{"type":"control_request","request_id":"e4739f12-be94-411b-8ebb-d7088332e4a5","request":{"subtype":"can_use_tool","tool_name":"AskUserQuestion","display_name":"AskUserQuestion","input":{"questions":[{"question":"Which color do you prefer?","header":"Color","options":[{"label":"Red","description":"The color red"},{"label":"Blue","description":"The color blue"}],"multiSelect":false}]},"tool_use_id":"toolu_01V8MLEHC3DetLrn8pygcytE","requires_user_interaction":true}}"#;

    /// Same run, in plan mode. `plan` arrives filled in from the plan file.
    const CAN_USE_EXIT_PLAN: &str = r##"{"type":"control_request","request_id":"bd22c487-4219-4e54-883e-f829c6fe54f2","request":{"subtype":"can_use_tool","tool_name":"ExitPlanMode","display_name":"ExitPlanMode","input":{"plan":"# Plan\n\nCreate `plan-probe.txt` with the contents `hi`.\n","planFilePath":"/Users/x/.claude/plans/plan-how-to-create-peppy-sphinx.md"},"tool_use_id":"toolu_01AV7AFkErfdi2FQ3G4Ysa8V","requires_user_interaction":true}}"##;

    /// What the CLI said right after that plan was approved with a
    /// `setMode acceptEdits` update.
    const STATUS_ACCEPT_EDITS: &str = r#"{"type":"system","subtype":"status","status":null,"permissionMode":"acceptEdits","uuid":"a0ce193f-dc6e-4d4a-ae40-836204f8acd3","session_id":"4ae3d58e-29f9-4072-9607-e02230e3fd2e"}"#;

    #[test]
    fn a_question_arrives_as_a_request_for_its_own_tool() {
        let message = serde_json::from_str(CAN_USE_ASK).unwrap();
        match &translate(message, &Mutex::new(None))[0] {
            HarnessEvent::PermissionRequest {
                tool_name,
                input,
                suggestions,
                ..
            } => {
                assert_eq!(tool_name, crate::ASK_USER_QUESTION);
                assert!(crate::is_interactive_tool(tool_name));
                assert_eq!(
                    input["questions"][0]["question"],
                    "Which color do you prefer?"
                );
                assert!(suggestions.is_empty());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_plan_arrives_with_its_text() {
        let message = serde_json::from_str(CAN_USE_EXIT_PLAN).unwrap();
        match &translate(message, &Mutex::new(None))[0] {
            HarnessEvent::PermissionRequest {
                tool_name, input, ..
            } => {
                assert_eq!(tool_name, crate::EXIT_PLAN_MODE);
                assert!(input["plan"].as_str().unwrap().starts_with("# Plan"));
                assert!(input["planFilePath"].as_str().is_some());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_status_frame_reports_the_mode_the_cli_now_runs_under() {
        let message = serde_json::from_str(STATUS_ACCEPT_EDITS).unwrap();
        let events = translate(message, &Mutex::new(None));
        assert!(matches!(
            events.as_slice(),
            [HarnessEvent::ModeChanged {
                mode: PermissionMode::AcceptEdits
            }]
        ));

        // `manual` is `default` inside the CLI.
        let message = serde_json::from_str(
            r#"{"type":"system","subtype":"status","status":null,"permissionMode":"default","session_id":"s"}"#,
        )
        .unwrap();
        assert!(matches!(
            translate(message, &Mutex::new(None)).as_slice(),
            [HarnessEvent::ModeChanged {
                mode: PermissionMode::Manual
            }]
        ));

        // A status without a mode (compaction progress, say) is no mode news.
        let message = serde_json::from_str(STATUS_COMPACTING).unwrap();
        assert!(
            translate(message, &Mutex::new(None))
                .iter()
                .all(|event| !matches!(event, HarnessEvent::ModeChanged { .. }))
        );
    }

    /// Captured from CLI 2.1.276 with `/compact` sent as a user turn over
    /// stream-json, one exchange into a session: these four frames, in this
    /// order, with a fresh `init` between the second and the third.
    const STATUS_COMPACTING: &str = r#"{"type":"system","subtype":"status","status":"compacting","session_id":"af1403cc-d8fc-4ed3-a281-ea9e1a75fde6","uuid":"cc84c125-4604-48a2-a6f3-6daf68c34328"}"#;
    const STATUS_COMPACTED: &str = r#"{"type":"system","subtype":"status","status":null,"compact_result":"success","session_id":"af1403cc-d8fc-4ed3-a281-ea9e1a75fde6","uuid":"69e7a322-6343-44ed-8481-41f4301f8f33"}"#;
    const COMPACT_BOUNDARY: &str = r#"{"type":"system","subtype":"compact_boundary","session_id":"af1403cc-d8fc-4ed3-a281-ea9e1a75fde6","uuid":"fb1e3b05-aad2-4013-92f5-28991fcc885d","compact_metadata":{"trigger":"manual","pre_tokens":21263,"post_tokens":2053,"cumulative_dropped_tokens":19210,"duration_ms":11915},"logical_parent_uuid":"71cfb452-0516-43ab-b44a-bcd3fdabb1a3"}"#;
    /// The summary that replaces the conversation, as a `user` message whose
    /// content is a plain string (cut short here).
    const COMPACT_SUMMARY: &str = r#"{"type":"user","message":{"role":"user","content":"This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. Primary Request and Intent:"},"session_id":"af1403cc-d8fc-4ed3-a281-ea9e1a75fde6","parent_tool_use_id":null,"uuid":"7811f23b-8f95-43b2-923a-e6468b1c00cd","timestamp":"2026-10-01T00:11:58.143Z","isReplay":false,"isSynthetic":true}"#;

    /// Same CLI, the frame that opens every API call of a turn.
    const STATUS_REQUESTING: &str = r#"{"type":"system","subtype":"status","status":"requesting","session_id":"af1403cc-d8fc-4ed3-a281-ea9e1a75fde6","uuid":"cd340b4b-4b47-4425-808e-5dd23537e8d9"}"#;

    /// Captured with `ANTHROPIC_BASE_URL` pointed at a closed local port and
    /// `CLAUDE_CODE_MAX_RETRIES=2`: a refused connection has no HTTP status,
    /// and the CLI files it as `unknown`.
    const API_RETRY: &str = r#"{"type":"system","subtype":"api_retry","attempt":1,"max_retries":2,"retry_delay_ms":570,"error_status":null,"error":"unknown","session_id":"668ccfdd-1d6d-432d-9046-41d3c52783d7","uuid":"b4bd9d6c-77ef-4273-bbff-f55427186f94"}"#;

    /// Captured with `--model claude-haiku-9-9 --fallback-model haiku`.
    const MODEL_FALLBACK: &str = r#"{"type":"system","subtype":"model_fallback","uuid":"69fcaf76-ff5b-4734-ac2c-18a685afe787","trigger":"model_not_found","original_model":"claude-haiku-9-9","fallback_model":"claude-haiku-4-5-20251001","content":"Switched to Haiku 4.5 because claude-haiku-9-9 is not available","session_id":"5ca49c94-59a4-4d6c-b99d-d5cb8e128d9e"}"#;

    fn translated(frame: &str) -> Vec<HarnessEvent> {
        translate(serde_json::from_str(frame).unwrap(), &Mutex::new(None))
    }

    #[test]
    fn a_compaction_reports_its_progress_then_its_boundary() {
        assert!(matches!(
            translated(STATUS_COMPACTING).as_slice(),
            [HarnessEvent::Progress {
                progress: Some(TurnProgress::Compacting)
            }]
        ));
        assert!(matches!(
            translated(STATUS_COMPACTED).as_slice(),
            [HarnessEvent::Progress { progress: None }]
        ));
        match translated(COMPACT_BOUNDARY).as_slice() {
            [
                HarnessEvent::Compacted {
                    auto,
                    tokens_before,
                    tokens_after,
                },
            ] => {
                assert!(!auto, "a /compact is not automatic");
                assert_eq!(*tokens_before, 21_263);
                assert_eq!(*tokens_after, Some(2_053));
            }
            other => panic!("unexpected {other:?}"),
        }
        // The summary itself is the CLI's business: nothing to draw.
        assert!(translated(COMPACT_SUMMARY).is_empty());
    }

    #[test]
    fn an_automatic_compaction_says_so() {
        let frame = COMPACT_BOUNDARY.replace(r#""trigger":"manual""#, r#""trigger":"auto""#);
        assert!(matches!(
            translated(&frame).as_slice(),
            [HarnessEvent::Compacted { auto: true, .. }]
        ));
    }

    #[test]
    fn a_failed_compaction_ends_the_progress_and_says_why() {
        // The `status` frame's schema in the CLI (`compact_result`,
        // `compact_error`); a failure was never captured.
        let events = translated(
            r#"{"type":"system","subtype":"status","status":null,"compact_result":"failed","compact_error":"prompt too long","session_id":"s","uuid":"u"}"#,
        );
        match events.as_slice() {
            [
                HarnessEvent::Progress { progress: None },
                HarnessEvent::Error { message },
            ] => assert_eq!(
                message,
                "Couldn't compact the conversation: prompt too long"
            ),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_request_going_out_ends_whatever_the_turn_waited_on() {
        assert!(matches!(
            translated(STATUS_REQUESTING).as_slice(),
            [HarnessEvent::Progress { progress: None }]
        ));
        // The mode report is a `null` status too, but says nothing about
        // progress: a retry's countdown must survive a mode change.
        assert!(matches!(
            translated(STATUS_ACCEPT_EDITS).as_slice(),
            [HarnessEvent::ModeChanged { .. }]
        ));
    }

    #[test]
    fn a_retry_counts_down_to_its_next_attempt() {
        let before = crate::unix_now_ms();
        let events = translated(API_RETRY);
        let after = crate::unix_now_ms();
        match events.as_slice() {
            [
                HarnessEvent::Progress {
                    progress:
                        Some(TurnProgress::Retrying {
                            attempt,
                            max_retries,
                            retry_at_ms,
                            reason,
                        }),
                },
            ] => {
                assert_eq!((*attempt, *max_retries), (1, 2));
                assert!((before + 570..=after + 570).contains(retry_at_ms));
                assert_eq!(reason, "connection failed");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn retry_reasons_read_as_words() {
        assert_eq!(
            retry_reason(Some("overloaded"), Some(529)),
            "the API is overloaded"
        );
        assert_eq!(retry_reason(Some("rate_limit"), Some(429)), "rate limited");
        assert_eq!(
            retry_reason(Some("server_error"), Some(503)),
            "server error (503)"
        );
        assert_eq!(retry_reason(Some("unknown"), None), "connection failed");
        assert_eq!(
            retry_reason(Some("unknown"), Some(418)),
            "request failed (418)"
        );
        assert_eq!(retry_reason(None, None), "connection failed");
        // A word this build has never seen is still shown, not dropped.
        assert_eq!(retry_reason(Some("cloud_hiccup"), None), "cloud hiccup");
    }

    #[test]
    fn a_model_fallback_is_told_in_the_clis_words() {
        match translated(MODEL_FALLBACK).as_slice() {
            [HarnessEvent::ModelFallback { from, to, message }] => {
                assert_eq!(from, "claude-haiku-9-9");
                assert_eq!(to, "claude-haiku-4-5-20251001");
                assert_eq!(
                    message,
                    "Switched to Haiku 4.5 because claude-haiku-9-9 is not available"
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_slash_command_is_told_apart_from_a_path() {
        assert!(is_slash_command("/compact"));
        assert!(is_slash_command("/compact keep the auth changes"));
        assert!(is_slash_command("/anthropic-skills:docs"));
        assert!(!is_slash_command("/etc/hosts is broken"));
        assert!(!is_slash_command("/Users/me/notes.md says otherwise"));
        assert!(!is_slash_command("please /compact"));
        assert!(!is_slash_command("/"));
        assert!(!is_slash_command("/ compact"));
    }

    #[test]
    fn a_permission_request_keeps_the_clis_suggestions_and_description() {
        let message = serde_json::from_str(
            r#"{"type":"control_request","request_id":"r1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"touch a.txt"},"description":"Create file a.txt","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch a.txt"}],"behavior":"allow","destination":"localSettings"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"/tmp/p/a.txt","tool_use_id":"t1"}}"#,
        )
        .unwrap();
        match &translate(message, &Mutex::new(None))[0] {
            HarnessEvent::PermissionRequest {
                suggestions,
                description,
                blocked_path,
                ..
            } => {
                assert_eq!(suggestions.len(), 2);
                assert_eq!(description.as_deref(), Some("Create file a.txt"));
                assert_eq!(blocked_path.as_deref(), Some("/tmp/p/a.txt"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn args_pin_the_session_to_its_project() {
        // The reported bug: a session opened in `Arka` answered "what folder
        // am I in" with `egant`. The model only knows what it is told, so
        // every spawn carries the project explicitly.
        let options = ClaudeOptions {
            cwd: PathBuf::from("/tmp/Arka"),
            project_name: Some("Arka".into()),
            ..Default::default()
        };
        let args = options.to_args();
        let index = args
            .iter()
            .position(|a| a == "--append-system-prompt")
            .expect("project grounding flag present");
        let prompt = &args[index + 1];
        assert!(prompt.contains("Arka"), "{prompt}");
        assert!(prompt.contains("/tmp/Arka"), "{prompt}");
    }

    #[test]
    fn project_name_defaults_to_folder_name() {
        let options = ClaudeOptions {
            cwd: PathBuf::from("/tmp/Arka"),
            ..Default::default()
        };
        assert_eq!(options.project_name_resolved(), "Arka");
    }

    #[test]
    fn resume_adds_session_flag() {
        let options = ClaudeOptions {
            resume: Some("abc123".into()),
            ..Default::default()
        };
        let args = options.to_args();
        let index = args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(args[index + 1], "abc123");
    }

    #[test]
    fn a_fresh_session_gets_a_host_assigned_id() {
        let options = ClaudeOptions {
            session_id: Some("7c59951c-8248-475f-9ad8-e352f8a122b0".into()),
            ..Default::default()
        };
        let args = options.to_args();
        let index = args.iter().position(|a| a == "--session-id").unwrap();
        assert_eq!(args[index + 1], "7c59951c-8248-475f-9ad8-e352f8a122b0");
    }

    #[test]
    fn resume_wins_over_a_fresh_session_id() {
        // `spawn` never builds this pair, but the CLI would reject both flags
        // at once, so the precedence is worth pinning down.
        let options = ClaudeOptions {
            resume: Some("abc123".into()),
            session_id: Some("unused".into()),
            ..Default::default()
        };
        let args = options.to_args();
        assert!(args.iter().any(|a| a == "--resume"));
        assert!(!args.iter().any(|a| a == "--session-id"));
    }

    #[test]
    fn a_session_is_resumable_before_the_agent_says_anything() {
        // `cat` stands in for a CLI that has not written a frame yet. The id
        // has to exist from the moment the process does — otherwise a session
        // that dies during its first turn leaves nothing on disk to resume,
        // which is exactly how `sonnet-5` sessions became unrecoverable.
        let (harness, _pump) = ClaudeCode::spawn(ClaudeOptions {
            program: PathBuf::from("/bin/cat"),
            ..Default::default()
        })
        .expect("spawning /bin/cat");
        let id = harness
            .session_id()
            .expect("a fresh session is named at spawn, not at handshake");
        assert!(uuid::Uuid::parse_str(&id).is_ok(), "{id}");
    }

    #[test]
    fn minted_session_ids_are_uuids() {
        // `--session-id` rejects anything that is not one.
        assert!(uuid::Uuid::parse_str(&new_session_id()).is_ok());
    }

    #[test]
    fn effort_adds_flag() {
        let options = ClaudeOptions {
            effort: Some("xhigh".into()),
            ..Default::default()
        };
        let args = options.to_args();
        let index = args.iter().position(|a| a == "--effort").unwrap();
        assert_eq!(args[index + 1], "xhigh");
    }

    #[test]
    fn million_token_context_becomes_a_model_suffix() {
        let options = ClaudeOptions {
            model: Some("claude-sonnet-5".into()),
            context_window: Some(1_000_000),
            ..Default::default()
        };
        let args = options.to_args();
        let index = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[index + 1], "claude-sonnet-5[1m]");

        // The standard window is the CLI's own default — no suffix, no flag.
        let standard = ClaudeOptions {
            model: Some("claude-sonnet-5".into()),
            context_window: Some(200_000),
            ..Default::default()
        };
        let args = standard.to_args();
        let index = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[index + 1], "claude-sonnet-5");

        // An id that already asks for it isn't asked twice.
        let explicit = ClaudeOptions {
            model: Some("claude-opus-5[1m]".into()),
            context_window: Some(1_000_000),
            ..Default::default()
        };
        let args = explicit.to_args();
        let index = args.iter().position(|a| a == "--model").unwrap();
        assert_eq!(args[index + 1], "claude-opus-5[1m]");
    }

    #[test]
    fn init_message_records_session_id() {
        let slot = Mutex::new(None);
        let message = serde_json::from_str(
            r#"{"type":"system","subtype":"init","session_id":"s1","tools":[],"model":"m"}"#,
        )
        .unwrap();
        let events = translate(message, &slot);
        assert!(matches!(events[0], HarnessEvent::Ready { .. }));
        assert_eq!(slot.lock().unwrap().as_deref(), Some("s1"));
    }

    #[test]
    fn a_real_result_frame_yields_the_full_usage_picture() {
        // Trimmed from an actual `--output-format stream-json` run: the flat
        // `usage` object carries the token split, and `modelUsage` is the only
        // place the window appears. Both are needed — `input_tokens` alone
        // reads as 2 on a turn that put 25k into the window.
        let message = serde_json::from_str(
            r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":4200,
                "session_id":"s1","total_cost_usd":0.2522,
                "usage":{"input_tokens":2,"cache_creation_input_tokens":25192,
                         "cache_read_input_tokens":1000,"output_tokens":10},
                "modelUsage":{"claude-opus-5[1m]":{"contextWindow":1000000,
                              "costUSD":0.2522}}}"#,
        )
        .unwrap();
        match &translate(message, &Mutex::new(None))[0] {
            HarnessEvent::TurnEnded {
                usage, cost_usd, ..
            } => {
                assert_eq!(usage.input_tokens, 2);
                assert_eq!(usage.output_tokens, 10);
                assert_eq!(usage.cache_creation_tokens, 25_192);
                assert_eq!(usage.cache_read_tokens, 1_000);
                assert_eq!(usage.context_window, 1_000_000);
                assert_eq!(usage.total_tokens(), 26_204);
                assert!((cost_usd - 0.2522).abs() < f64::EPSILON);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_assistant_step_reports_its_own_prompt_footprint_as_context() {
        // One step of a multi-step turn: the usage here is that single API
        // call's prompt, which is what actually sits in the window — unlike
        // the result message, which sums every call in the turn.
        let message = serde_json::from_str(
            r#"{"type":"assistant","session_id":"s1",
                "message":{"id":"msg_1","role":"assistant",
                 "content":[{"type":"text","text":"hi"}],
                 "usage":{"input_tokens":10,"cache_creation_input_tokens":200,
                          "cache_read_input_tokens":25000,"output_tokens":5}}}"#,
        )
        .unwrap();
        let events = translate(message, &Mutex::new(None));
        match &events[0] {
            HarnessEvent::ContextUpdate {
                context_tokens,
                context_window,
            } => {
                assert_eq!(*context_tokens, 25_215);
                assert_eq!(*context_window, 0);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(matches!(events[1], HarnessEvent::AssistantMessage { .. }));
    }

    #[test]
    fn a_tool_only_step_still_moves_the_context_reading() {
        // Tool-loop steps often carry no text at all — the reading must not
        // depend on there being something to show in the transcript.
        let message = serde_json::from_str(
            r#"{"type":"assistant","session_id":"s1",
                "message":{"role":"assistant",
                 "content":[{"type":"tool_use","id":"t1","name":"Read","input":{}}],
                 "usage":{"input_tokens":10,"output_tokens":5,
                          "cache_read_input_tokens":30000}}}"#,
        )
        .unwrap();
        let events = translate(message, &Mutex::new(None));
        match &events[0] {
            HarnessEvent::ContextUpdate { context_tokens, .. } => {
                assert_eq!(*context_tokens, 30_015);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn subagent_steps_never_touch_the_main_window_reading() {
        let message = serde_json::from_str(
            r#"{"type":"assistant","session_id":"s1","parent_tool_use_id":"t9",
                "message":{"role":"assistant",
                 "content":[{"type":"text","text":"sub"}],
                 "usage":{"input_tokens":5000,"output_tokens":100}}}"#,
        )
        .unwrap();
        let events = translate(message, &Mutex::new(None));
        assert!(
            events
                .iter()
                .all(|e| !matches!(e, HarnessEvent::ContextUpdate { .. }))
        );
    }

    #[test]
    fn a_result_frame_without_model_usage_reports_no_window() {
        // Older CLIs, and the turn-based wires, say nothing about the window.
        // Inventing one here would make the meter confidently wrong.
        let message = serde_json::from_str(
            r#"{"type":"result","is_error":false,"session_id":"s1",
                "usage":{"input_tokens":5,"output_tokens":7}}"#,
        )
        .unwrap();
        match &translate(message, &Mutex::new(None))[0] {
            HarnessEvent::TurnEnded { usage, .. } => {
                assert_eq!(usage.context_window, 0);
                assert_eq!(usage.total_tokens(), 12);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Captured from CLI 2.1.276: a Read of an 8×8 PNG. The picture comes
    /// back as an `image` block — base64 — not as text.
    const READ_IMAGE_RESULT: &str = r#"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01L8DsCzS2zUrWmdhPKuWobc","type":"tool_result","content":[{"type":"image","source":{"type":"base64","data":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=","media_type":"image/png"}}]}]},"parent_tool_use_id":null,"session_id":"f354355b-40cc-4690-a1f2-cc1012a509ba","uuid":"063aed99-71d8-451b-b55e-560444abd563","timestamp":"2026-10-01T00:34:56.497Z","tool_use_result":{"type":"image","file":{"base64":"iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGO4IyKCFTEMLQkAmD9BAZzFjLYAAAAASUVORK5CYII=","type":"image/png","originalSize":74,"dimensions":{"originalWidth":8,"originalHeight":8,"displayWidth":8,"displayHeight":8}}}}"#;

    #[test]
    fn an_image_tool_result_is_described_not_kept_as_base64() {
        match translated(READ_IMAGE_RESULT).as_slice() {
            [HarnessEvent::ToolResult { id, output, .. }] => {
                assert_eq!(id, "toolu_01L8DsCzS2zUrWmdhPKuWobc");
                // 74 bytes: the file's `originalSize`, from its base64 alone.
                assert_eq!(output, "[image: image/png, 74 bytes]");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn a_result_mixing_text_and_a_picture_keeps_both_readable() {
        let output = stringify(&serde_json::json!([
            {"type": "text", "text": "Screenshot taken"},
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                         "data": "A".repeat(4 * 140_000)}},
            {"type": "document", "source": {"type": "base64", "media_type": "application/pdf",
                                            "data": "A".repeat(4 * 600_000)}},
            {"type": "tool_reference", "tool_name": "WebFetch"},
        ]));
        assert_eq!(
            output,
            "Screenshot taken\n[image: image/jpeg, 411 KB]\n[document: application/pdf, 1.7 MB]\n{\"tool_name\":\"WebFetch\",\"type\":\"tool_reference\"}"
        );
    }

    #[test]
    fn sizes_read_at_a_glance() {
        assert_eq!(size_label(74), "74 bytes");
        assert_eq!(size_label(1024), "1 KB");
        assert_eq!(size_label(420_000), "411 KB");
        assert_eq!(size_label(1_800_000), "1.7 MB");
        assert_eq!(base64_len("aGk="), 2);
        assert_eq!(base64_len("aGk"), 2);
        assert_eq!(base64_len("aGVsbG8="), 5);
    }

    #[test]
    fn tool_result_blocks_become_events() {
        let message = serde_json::from_str(
            r#"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":[{"type":"text","text":"done"}],"is_error":false}]},"session_id":"s1"}"#,
        )
        .unwrap();
        let events = translate(message, &Mutex::new(None));
        match &events[0] {
            HarnessEvent::ToolResult { id, output, .. } => {
                assert_eq!(id, "t1");
                assert_eq!(output, "done");
            }
            other => panic!("unexpected {other:?}"),
        }
    }
}
