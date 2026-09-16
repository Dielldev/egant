//! Drives the `opencode` CLI one turn per process.
//!
//! ```text
//! opencode run --format json [-s <session>] [-m <provider/model>] "<prompt>"
//! ```
//!
//! prints newline-delimited JSON events (`step_start`, `text`, `tool_use`,
//! `step_finish`, `error`) and exits when the turn settles. `-s` continues
//! the session the previous turn discovered, so from the transcript's point
//! of view the session is persistent — it never sees a process boundary.
//! Approvals follow opencode's own non-interactive policy: tools run the way
//! `opencode run` runs them, with no host prompt in between.

use crate::agents::AgentId;
use crate::runner::{Runner, TurnRequest, TurnTranslator};
use crate::{Harness, HarnessEvent, PermissionDecision, SessionId};
use anyhow::{Context as _, Result};
use async_channel::Receiver;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct OpencodeOptions {
    /// Binary to run. Left as `opencode` it is resolved the way the agent
    /// registry resolves it (env override → `PATH` → login shell → install
    /// dirs → version-manager bins).
    pub program: PathBuf,
    /// Working directory the agent operates in.
    pub cwd: PathBuf,
    /// `provider/model` the turn should use. `None` keeps opencode's default.
    pub model: Option<String>,
    /// Reasoning variant for the turn (`high`, `max`, …). Only sent when the
    /// model advertises variants; `None` keeps opencode's default.
    pub variant: Option<String>,
    /// Continue this opencode session instead of starting fresh.
    pub session: Option<String>,
}

impl Default for OpencodeOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("opencode"),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            model: None,
            variant: None,
            session: None,
        }
    }
}

pub struct OpencodeRun {
    runner: Runner,
}

impl OpencodeRun {
    pub fn spawn(options: OpencodeOptions) -> Result<Self> {
        let program = resolve_program(&options.program)?;
        let translator = OpencodeTranslator {
            program,
            cwd: options.cwd,
            model: options.model,
            variant: options.variant,
            session: options.session,
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
        };
        Ok(Self {
            runner: Runner::spawn(translator),
        })
    }
}

fn resolve_program(program: &Path) -> Result<PathBuf> {
    if program.as_os_str() == "opencode" {
        let desc = AgentId::Opencode.descriptor();
        crate::agents::resolve_executable(desc).with_context(|| {
            format!("opencode is not installed: {}", desc.install_hint)
        })
    } else {
        Ok(program.to_path_buf())
    }
}

#[async_trait]
impl Harness for OpencodeRun {
    fn backend_name(&self) -> &'static str {
        "OpenCode"
    }

    fn agent_id(&self) -> AgentId {
        AgentId::Opencode
    }

    fn session_id(&self) -> Option<SessionId> {
        self.runner.session_id()
    }

    fn events(&self) -> Receiver<HarnessEvent> {
        self.runner.events()
    }

    async fn send(&mut self, text: String) -> Result<()> {
        self.runner.send(text);
        Ok(())
    }

    async fn interrupt(&mut self) -> Result<()> {
        self.runner.interrupt();
        Ok(())
    }

    async fn respond_permission(
        &mut self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> Result<()> {
        // This wire never asks: tools run under opencode's own policy.
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        self.runner.shutdown();
        Ok(())
    }
}

/// Per-turn accounting, reset when the turn settles.
#[derive(Default)]
struct TurnAcc {
    started: Option<Instant>,
    input_tokens: u64,
    output_tokens: u64,
    cost_usd: f64,
    failed: bool,
}

struct OpencodeTranslator {
    program: PathBuf,
    cwd: PathBuf,
    model: Option<String>,
    variant: Option<String>,
    session: Option<SessionId>,
    ready_sent: bool,
    turn: TurnAcc,
    seen_tools: HashSet<String>,
}

impl TurnTranslator for OpencodeTranslator {
    fn build(&mut self, text: &str) -> TurnRequest {
        let mut args = vec![
            "run".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        if let Some(session) = &self.session {
            args.push("-s".to_string());
            args.push(session.clone());
        }
        if let Some(model) = &self.model {
            args.push("-m".to_string());
            args.push(model.clone());
        }
        if let Some(variant) = &self.variant {
            args.push("--variant".to_string());
            args.push(variant.clone());
        }
        args.push(text.to_string());
        self.turn = TurnAcc {
            started: Some(Instant::now()),
            ..TurnAcc::default()
        };
        self.seen_tools.clear();
        TurnRequest {
            program: self.program.clone(),
            args,
            cwd: self.cwd.clone(),
        }
    }

    fn push_line(&mut self, line: &str) -> Vec<HarnessEvent> {
        let value: Value = match serde_json::from_str(line) {
            Ok(value) => value,
            Err(error) => {
                log::debug!("opencode unparsed line: {line} ({error})");
                return Vec::new();
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("step_start") => {
                if let Some(id) = value.get("sessionID").and_then(Value::as_str) {
                    self.session = Some(id.to_string());
                }
                Vec::new()
            }
            Some("text") => match value.get("part") {
                Some(part) if part.get("type").and_then(Value::as_str) == Some("text") => {
                    match part.get("text").and_then(Value::as_str) {
                        Some(text) if !text.is_empty() => {
                            vec![HarnessEvent::AssistantMessage {
                                text: text.to_string(),
                            }]
                        }
                        _ => Vec::new(),
                    }
                }
                _ => Vec::new(),
            },
            Some("tool_use") => self.translate_tool(&value),
            Some("step_finish") => {
                if let Some(part) = value.get("part") {
                    if let Some(tokens) = part.get("tokens") {
                        self.turn.input_tokens += tokens
                            .get("input")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                        self.turn.output_tokens += tokens
                            .get("output")
                            .and_then(Value::as_u64)
                            .unwrap_or(0);
                    }
                    self.turn.cost_usd += part.get("cost").and_then(Value::as_f64).unwrap_or(0.0);
                }
                Vec::new()
            }
            Some("error") => {
                self.turn.failed = true;
                vec![HarnessEvent::Error {
                    message: error_message(&value),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn end_turn(&mut self, interrupted: bool, exit: Option<i32>) -> Vec<HarnessEvent> {
        let turn = std::mem::take(&mut self.turn);
        let duration_ms = turn
            .started
            .map(|s| s.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
            .unwrap_or(0);
        let (result, is_error) = if interrupted {
            (Some("Interrupted.".to_string()), true)
        } else if turn.failed {
            // Already surfaced as an error notice mid-turn; settle quietly.
            (None, true)
        } else if exit.is_some_and(|code| code != 0) {
            (
                Some(format!(
                    "opencode exited with status {}.",
                    exit.unwrap_or_default()
                )),
                true,
            )
        } else {
            (None, false)
        };
        vec![HarnessEvent::TurnEnded {
            result,
            is_error,
            duration_ms,
            cost_usd: turn.cost_usd,
            // This wire accounts for prompt and reply only; it says nothing
            // about cache splits or the window, which stay at zero rather
            // than being invented here.
            usage: crate::TurnUsage {
                input_tokens: turn.input_tokens,
                output_tokens: turn.output_tokens,
                ..Default::default()
            },
        }]
    }

    fn take_ready(&mut self) -> Option<HarnessEvent> {
        if self.ready_sent {
            return None;
        }
        let session_id = self.session.clone()?;
        self.ready_sent = true;
        Some(HarnessEvent::Ready {
            session_id,
            model: self.model.clone(),
            cwd: Some(self.cwd.clone()),
            tools: Vec::new(),
        })
    }

    fn session_id(&self) -> Option<SessionId> {
        self.session.clone()
    }
}

impl OpencodeTranslator {
    fn translate_tool(&mut self, value: &Value) -> Vec<HarnessEvent> {
        let part = match value.get("part") {
            Some(part) if part.get("type").and_then(Value::as_str) == Some("tool") => part,
            _ => return Vec::new(),
        };
        let id = match part.get("callID").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => return Vec::new(),
        };
        let name = part
            .get("tool")
            .and_then(Value::as_str)
            .unwrap_or("tool")
            .to_string();
        let mut events = Vec::new();
        if self.seen_tools.insert(id.clone()) {
            events.push(HarnessEvent::ToolUse {
                id: id.clone(),
                name,
                input: part.get("state").and_then(|s| s.get("input")).cloned().unwrap_or(Value::Null),
            });
        }
        let status = part
            .get("state")
            .and_then(|s| s.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if matches!(status, "completed" | "failed" | "error") {
            let state = part.get("state");
            events.push(HarnessEvent::ToolResult {
                id,
                output: tool_output(state),
                is_error: status != "completed",
            });
        }
        events
    }
}

fn tool_output(state: Option<&Value>) -> String {
    let state = match state {
        Some(state) => state,
        None => return String::new(),
    };
    if let Some(output) = state.get("output").and_then(Value::as_str) {
        return output.to_string();
    }
    if let Some(output) = state
        .get("metadata")
        .and_then(|m| m.get("output"))
        .and_then(Value::as_str)
    {
        return output.to_string();
    }
    String::new()
}

fn error_message(value: &Value) -> String {
    value
        .get("error")
        .and_then(|e| {
            e.get("data")
                .and_then(|d| d.get("message"))
                .and_then(Value::as_str)
                .or_else(|| e.get("message").and_then(Value::as_str))
        })
        .map(str::to_owned)
        .unwrap_or_else(|| {
            let text = value.to_string();
            if text.len() > 500 {
                format!("{}…", &text[..500])
            } else {
                text
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translator() -> OpencodeTranslator {
        OpencodeTranslator {
            program: PathBuf::from("opencode"),
            cwd: PathBuf::from("/tmp"),
            model: Some("prov/mod".into()),
            variant: None,
            session: None,
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
        }
    }

    #[test]
    fn build_starts_fresh_and_resumes_with_session() {
        let mut t = translator();
        let first = t.build("hi");
        assert!(first.args.contains(&"run".to_string()));
        assert!(first.args.contains(&"--format".to_string()));
        assert!(!first.args.iter().any(|a| a == "-s"));
        assert!(first.args.contains(&"prov/mod".to_string()));

        t.session = Some("ses_1".into());
        let second = t.build("again");
        let at = second.args.iter().position(|a| a == "-s").unwrap();
        assert_eq!(second.args[at + 1], "ses_1");
    }

    #[test]
    fn build_passes_variant_when_set() {
        let mut t = translator();
        t.variant = Some("high".into());
        let args = t.build("hi").args;
        let at = args.iter().position(|a| a == "--variant").unwrap();
        assert_eq!(args[at + 1], "high");
    }

    #[test]
    fn step_start_captures_session_and_arms_ready() {
        let mut t = translator();
        let events = t.push_line(r#"{"type":"step_start","sessionID":"ses_9","part":{}}"#);
        assert!(events.is_empty());
        assert_eq!(t.session.as_deref(), Some("ses_9"));
        match t.take_ready() {
            Some(HarnessEvent::Ready {
                session_id, model, ..
            }) => {
                assert_eq!(session_id, "ses_9");
                assert_eq!(model.as_deref(), Some("prov/mod"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(t.take_ready().is_none());
    }

    #[test]
    fn text_and_tool_lines_translate() {
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"text","part":{"type":"text","text":"hello"}}"#,
        );
        assert!(matches!(
            events[0],
            HarnessEvent::AssistantMessage { .. }
        ));

        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"ls"},"output":"a"}}}"#,
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], HarnessEvent::ToolUse { .. }));
        match &events[1] {
            HarnessEvent::ToolResult { output, is_error, .. } => {
                assert_eq!(output, "a");
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
        // A repeated line for the same call never duplicates the call row.
        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"ls"},"output":"a"}}}"#,
        );
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn step_finish_accumulates_and_settles() {
        let mut t = translator();
        t.build("hi");
        t.push_line(
            r#"{"type":"step_finish","part":{"tokens":{"input":10,"output":4},"cost":0.02}}"#,
        );
        match &t.end_turn(false, Some(0))[0] {
            HarnessEvent::TurnEnded {
                cost_usd,
                usage,
                is_error,
                ..
            } => {
                assert!((cost_usd - 0.02).abs() < f64::EPSILON);
                assert_eq!(usage.input_tokens, 10);
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn error_line_fails_the_turn_once() {
        let mut t = translator();
        t.build("hi");
        let events = t.push_line(
            r#"{"type":"error","error":{"name":"X","data":{"message":"boom"}}}"#,
        );
        assert!(matches!(events[0], HarnessEvent::Error { .. }));
        // The message already surfaced: the settled turn carries no duplicate.
        match &t.end_turn(false, Some(0))[0] {
            HarnessEvent::TurnEnded {
                result, is_error, ..
            } => {
                assert!(result.is_none());
                assert!(is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    // Runs the real runner thread against a fake CLI: no network, no auth,
    // but the full spawn → translate → settle → shutdown path.
    #[cfg(unix)]
    mod live {
        use super::*;
        use crate::Harness as _;
        use std::os::unix::fs::PermissionsExt;

        fn sandbox(name: &str) -> PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("egant-opencode-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn fake_cli(dir: &Path, body: &str) -> PathBuf {
            let script = dir.join("fake-opencode");
            std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }

        fn turn_events() -> &'static str {
            r#"printf '%s\n' '{"type":"step_start","sessionID":"ses_1","part":{}}' '{"type":"text","part":{"type":"text","text":"yo"}}' '{"type":"step_finish","part":{"tokens":{"input":5,"output":2},"cost":0.01}}'"#
        }

        /// Drains events until (and including) the first matching one.
        async fn until(
            rx: &Receiver<HarnessEvent>,
            mut f: impl FnMut(&HarnessEvent) -> bool,
        ) -> Vec<String> {
            let mut kinds = Vec::new();
            while let Ok(event) = rx.recv().await {
                let kind = match &event {
                    HarnessEvent::Ready { .. } => "ready",
                    HarnessEvent::AssistantMessage { .. } => "msg",
                    HarnessEvent::TurnEnded { .. } => "end",
                    HarnessEvent::Exited { .. } => "exited",
                    _ => "other",
                };
                kinds.push(kind.to_string());
                if f(&event) {
                    break;
                }
            }
            kinds
        }

        #[test]
        fn turn_settles_and_session_persists_across_turns() {
            let dir = sandbox("turns");
            let script = fake_cli(&dir, turn_events());
            futures_lite::future::block_on(async {
                let mut h = OpencodeRun::spawn(OpencodeOptions {
                    program: script,
                    cwd: dir,
                    model: None,
                    variant: None,
                    session: None,
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into()).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["ready", "msg", "end"]);
                assert_eq!(h.session_id().as_deref(), Some("ses_1"));

                // A second turn reuses the session: no second Ready.
                h.send("again".into()).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["msg", "end"]);

                h.shutdown().await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::Exited { .. })).await;
                assert_eq!(kinds, ["exited"]);
            });
        }

        #[test]
        fn interrupt_settles_the_turn_as_interrupted() {
            let dir = sandbox("interrupt");
            let script = fake_cli(&dir, "sleep 30");
            futures_lite::future::block_on(async {
                let mut h = OpencodeRun::spawn(OpencodeOptions {
                    program: script,
                    cwd: dir,
                    model: None,
                    variant: None,
                    session: None,
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into()).await.unwrap();
                h.interrupt().await.unwrap();
                let mut saw_end = false;
                while let Ok(event) = rx.recv().await {
                    if let HarnessEvent::TurnEnded { result, is_error, .. } = event {
                        assert!(is_error);
                        assert_eq!(result.as_deref(), Some("Interrupted."));
                        saw_end = true;
                        break;
                    }
                }
                assert!(saw_end);
                h.shutdown().await.unwrap();
            });
        }
    }
}
