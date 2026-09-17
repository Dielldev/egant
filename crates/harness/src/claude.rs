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
    HostControlResponse, HostMessage, HostUserMessage,
};
use crate::{
    AgentId, Harness, HarnessError, HarnessEvent, PermissionDecision, PermissionMode, SessionId,
    TurnUsage,
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
            .map_err(|source| HarnessError::Spawn {
                program: options.program.display().to_string(),
                source,
            })?;

        let stdin = child.stdin.take().context("child stdin was not piped")?;
        let stdout = child.stdout.take().context("child stdout was not piped")?;
        let stderr = child.stderr.take().context("child stderr was not piped")?;

        // Bounded so a stalled UI applies backpressure instead of growing the
        // queue without limit during a long tool-heavy turn.
        let (tx, rx) = async_channel::bounded(1024);
        // Populated before the first byte is read: `resume` when continuing,
        // otherwise the id just minted for this conversation.
        let session_id = Arc::new(Mutex::new(
            options.resume.clone().or_else(|| options.session_id.clone()),
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

    async fn send(&mut self, text: String) -> Result<()> {
        let message = HostMessage::User {
            message: HostUserMessage {
                role: "user",
                content: vec![HostContentBlock::Text { text }],
            },
            session_id: self.session_id(),
        };
        self.write(&message).await
    }

    async fn interrupt(&mut self) -> Result<()> {
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
            PermissionDecision::Allow { updated_input } => {
                HostControlResponse::allow(request_id, updated_input)
            }
            PermissionDecision::Deny { reason } => HostControlResponse::deny(request_id, reason),
        };
        self.write(&HostMessage::ControlResponse { response }).await
    }

    async fn shutdown(&mut self) -> Result<()> {
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
            if let Ok(mut slot) = session_id.lock() {
                *slot = Some(system.session_id.clone());
            }
            if system.subtype != "init" {
                return Vec::new();
            }
            vec![HarnessEvent::Ready {
                session_id: system.session_id,
                model: system.model,
                cwd: system.cwd,
                tools: system.tools,
            }]
        }

        CliMessage::Assistant(turn) => {
            if let Some(error) = turn.error {
                return vec![HarnessEvent::Error {
                    message: format!("{error}: {}", turn.message.content.as_text()),
                }];
            }
            let mut events = Vec::new();
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
                tool_name, input, ..
            } => vec![HarnessEvent::PermissionRequest {
                request_id: envelope.request_id,
                tool_name,
                input,
            }],
            ControlRequest::Unknown => Vec::new(),
        },

        CliMessage::ControlResponse(_) | CliMessage::Unknown => Vec::new(),
    }
}

/// Tool results are either a string or a block list; the transcript wants text.
fn stringify(value: &serde_json::Value) -> String {
    match value {
        serde_json::Value::String(text) => text.clone(),
        serde_json::Value::Array(items) => items
            .iter()
            .map(|item| {
                item.get("text")
                    .and_then(|text| text.as_str())
                    .map(str::to_owned)
                    .unwrap_or_else(|| item.to_string())
            })
            .collect::<Vec<_>>()
            .join("\n"),
        serde_json::Value::Null => String::new(),
        other => other.to_string(),
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
            HarnessEvent::TurnEnded { usage, cost_usd, .. } => {
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
