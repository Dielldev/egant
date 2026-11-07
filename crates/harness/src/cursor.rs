//! Drives the `cursor-agent` CLI one turn per process.
//!
//! ```text
//! cursor-agent -p --force \
//!   --output-format stream-json \
//!   --stream-partial-output \
//!   --workspace <cwd> \
//!   [--model <id>] \
//!   [--resume <session_id>] \
//!   "<prompt>"
//! ```
//!
//! prints newline-delimited JSON events (`system`, `assistant`, `tool_call`,
//! `result`) and exits when the turn settles. `--resume` continues the
//! session the previous turn discovered, so from the transcript's point of
//! view the session is persistent — it never sees a process boundary.
//!
//! There is no host-answered approval channel here (unlike the Claude wire's
//! `--permission-prompts host`): `cursor-agent -p` has nobody to ask, so
//! `--force` / `--mode plan` decide what the agent may do up front. The
//! session's [`PermissionMode`] is mapped onto those flags per turn.

use crate::agents::AgentId;
use crate::runner::{Runner, TurnRequest, TurnTranslator};
use crate::{Harness, HarnessEvent, PermissionDecision, PermissionMode, SessionId};
use anyhow::{Context as _, Result};
use async_channel::Receiver;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct CursorOptions {
    /// Binary to run. Left as `cursor-agent` it is resolved the way the agent
    /// registry resolves it (env override → `PATH` → login shell → install
    /// dirs → version-manager bins).
    pub program: PathBuf,
    /// Working directory the agent operates in (also passed as `--workspace`).
    pub cwd: PathBuf,
    /// Human name of the project `cwd` belongs to. Folded into every turn's
    /// prompt so "what folder am I in" answers with this project. `None`
    /// derives it from `cwd`.
    pub project_name: Option<String>,
    /// Model the turn should use. `None` keeps the CLI default.
    pub model: Option<String>,
    /// Continue this cursor-agent session instead of starting a new one.
    pub session: Option<String>,
    /// What the agent may do without asking, since nothing here can ask.
    /// Mapped onto `--force` / `--mode` per turn — see the module doc.
    pub permission_mode: PermissionMode,
}

impl Default for CursorOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("cursor-agent"),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            project_name: None,
            model: None,
            session: None,
            permission_mode: PermissionMode::default(),
        }
    }
}

pub struct CursorAgent {
    runner: Runner,
    mode: Arc<Mutex<PermissionMode>>,
}

impl CursorAgent {
    pub fn spawn(options: CursorOptions) -> Result<Self> {
        log::info!(
            "cursor spawn cwd={} model={:?} session={}",
            options.cwd.display(),
            options.model,
            options.session.is_some(),
        );
        let program = resolve_program(&options.program)?;
        let mode = Arc::new(Mutex::new(options.permission_mode));
        let project_name = options
            .project_name
            .clone()
            .unwrap_or_else(|| crate::project_display_name(&options.cwd));
        let translator = CursorTranslator {
            program,
            cwd: options.cwd,
            project_name,
            model: options.model,
            session: options.session,
            mode: mode.clone(),
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
            settled: false,
        };
        Ok(Self {
            runner: Runner::spawn(translator),
            mode,
        })
    }
}

fn resolve_program(program: &Path) -> Result<PathBuf> {
    if program.as_os_str() == "cursor-agent" {
        let desc = AgentId::Cursor.descriptor();
        crate::agents::resolve_executable(desc)
            .with_context(|| format!("cursor-agent is not installed: {}", desc.install_hint))
    } else {
        Ok(program.to_path_buf())
    }
}

#[async_trait]
impl Harness for CursorAgent {
    fn backend_name(&self) -> &'static str {
        "Cursor"
    }

    fn agent_id(&self) -> AgentId {
        AgentId::Cursor
    }

    fn session_id(&self) -> Option<SessionId> {
        self.runner.session_id()
    }

    fn events(&self) -> Receiver<HarnessEvent> {
        self.runner.events()
    }

    async fn send(&mut self, text: String, images: Vec<PathBuf>) -> Result<()> {
        log::debug!(
            "cursor send ({} chars, {} image(s))",
            text.len(),
            images.len()
        );
        self.runner.send(text, images);
        Ok(())
    }

    async fn interrupt(&mut self) -> Result<()> {
        log::debug!("cursor interrupt");
        self.runner.interrupt();
        Ok(())
    }

    async fn respond_permission(
        &mut self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> Result<()> {
        // This wire never asks: `--force` / `--mode` decide everything up front.
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        log::info!("cursor shutdown");
        self.runner.shutdown();
        Ok(())
    }

    /// Takes effect on the next turn: the mode flags are launch args, so a
    /// turn already running keeps the mode it started with.
    async fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<()> {
        if let Ok(mut slot) = self.mode.lock() {
            *slot = mode;
        }
        Ok(())
    }
}

/// Per-turn accounting, reset when the turn settles.
#[derive(Default)]
struct TurnAcc {
    started: Option<Instant>,
    duration_ms: Option<u64>,
    failed: bool,
}

struct CursorTranslator {
    program: PathBuf,
    cwd: PathBuf,
    project_name: String,
    model: Option<String>,
    session: Option<SessionId>,
    mode: Arc<Mutex<PermissionMode>>,
    ready_sent: bool,
    turn: TurnAcc,
    seen_tools: HashSet<String>,
    /// Whether `result` has already settled this turn, so the process exiting
    /// afterwards isn't reported as a second turn ending.
    settled: bool,
}

/// Launch flags for one permission mode. `cursor-agent -p` has nobody to ask,
/// so Plan/Manual land on `--mode plan` (read-only) and everything else gets
/// `--force` so edits actually apply — matching the headless docs' scripting
/// recipe and what Codex's workspace-write sandbox does for the same modes.
fn mode_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::Plan | PermissionMode::Manual => {
            vec!["--mode".into(), "plan".into()]
        }
        PermissionMode::Auto | PermissionMode::AcceptEdits | PermissionMode::BypassPermissions => {
            vec!["--force".into()]
        }
    }
}

impl CursorTranslator {
    /// Ends the turn: one `TurnEnded` carrying whatever the turn accumulated,
    /// and the accounting reset behind it. Called once per turn — either by
    /// `result` on the wire or, when that never came, by the process exiting
    /// — and the `settled` flag is what keeps it to once.
    fn settle(&mut self, result: Option<String>, is_error: bool) -> Vec<HarnessEvent> {
        let turn = std::mem::take(&mut self.turn);
        self.settled = true;
        let duration_ms = turn.duration_ms.unwrap_or_else(|| {
            turn.started
                .map(|s| s.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(0)
        });
        // This wire reports duration on `result`, not token usage.
        vec![HarnessEvent::TurnEnded {
            result,
            is_error,
            duration_ms,
            cost_usd: 0.0,
            usage: crate::TurnUsage::default(),
        }]
    }
}

impl TurnTranslator for CursorTranslator {
    fn build(&mut self, text: &str, images: &[PathBuf]) -> TurnRequest {
        let mode = self.mode.lock().map(|guard| *guard).unwrap_or_default();
        let mut args = vec![
            "-p".to_string(),
            "--output-format".to_string(),
            "stream-json".to_string(),
            "--stream-partial-output".to_string(),
            // Headless: never stop to ask whether this folder is trusted.
            "--trust".to_string(),
            "--workspace".to_string(),
            self.cwd.display().to_string(),
        ];
        args.extend(mode_args(mode));
        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        if let Some(session) = &self.session {
            args.push("--resume".to_string());
            args.push(session.clone());
        }
        // `cursor-agent` has no image flag: file paths in the prompt are how
        // the headless docs attach media (the agent reads them via tools).
        let mut prompt = crate::wrap_turn_with_project(&self.project_name, &self.cwd, text);
        for image in images {
            prompt.push('\n');
            prompt.push_str(&image.display().to_string());
        }
        args.push(prompt);
        self.turn = TurnAcc {
            started: Some(Instant::now()),
            ..TurnAcc::default()
        };
        self.seen_tools.clear();
        self.settled = false;
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
                log::debug!("cursor unparsed line: {line} ({error})");
                return Vec::new();
            }
        };
        if let Some(id) = value.get("session_id").and_then(Value::as_str) {
            self.session = Some(id.to_string());
        }
        match value.get("type").and_then(Value::as_str) {
            Some("system") => {
                if value.get("subtype").and_then(Value::as_str) == Some("init") {
                    if let Some(model) = value.get("model").and_then(Value::as_str) {
                        // Prefer the CLI's live name when the spawn didn't pick one.
                        if self.model.is_none() {
                            self.model = Some(model.to_string());
                        }
                    }
                }
                Vec::new()
            }
            Some("user") => Vec::new(),
            Some("assistant") => translate_assistant(&value),
            Some("tool_call") => self.translate_tool(&value),
            Some("result") => {
                let is_error = value
                    .get("is_error")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Some(ms) = value.get("duration_ms").and_then(Value::as_u64) {
                    self.turn.duration_ms = Some(ms);
                }
                if is_error {
                    self.turn.failed = true;
                    let message = value
                        .get("result")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .unwrap_or("the turn failed")
                        .to_string();
                    // Surface once as an error notice; settle quietly so
                    // TurnEnded doesn't duplicate the same text.
                    let mut events = vec![HarnessEvent::Error { message }];
                    events.extend(self.settle(None, true));
                    events
                } else {
                    // Settle as soon as the CLI says the turn is over — waiting
                    // for process exit would leave the window claiming the agent
                    // is still working while teardown runs.
                    self.settle(None, false)
                }
            }
            _ => Vec::new(),
        }
    }

    fn end_turn(&mut self, interrupted: bool, exit: Option<i32>) -> Vec<HarnessEvent> {
        // `result` already closed the turn; process teardown (any exit code)
        // is not a second ending. Only an interrupt that killed the child
        // before `result` arrived still needs to settle here.
        if self.settled {
            return Vec::new();
        }
        let (result, is_error) = if interrupted {
            (Some("Interrupted.".to_string()), true)
        } else if exit.is_some_and(|code| code != 0) {
            (
                Some(format!(
                    "cursor-agent exited with status {}.",
                    exit.unwrap_or_default()
                )),
                true,
            )
        } else {
            (None, false)
        };
        self.settle(result, is_error)
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

/// With `--stream-partial-output` (always on here), only deltas that carry
/// `timestamp_ms` and lack `model_call_id` are new text — the other two
/// assistant shapes are duplicate flushes (docs: Output format → Streaming
/// partial output). The transcript settles streaming text when a tool starts
/// or the turn ends, so the skipped flushes are never needed as
/// `AssistantMessage`.
fn translate_assistant(value: &Value) -> Vec<HarnessEvent> {
    let has_ts = value.get("timestamp_ms").is_some();
    let has_model_call = value.get("model_call_id").is_some();
    if !(has_ts && !has_model_call) {
        return Vec::new();
    }
    let text = assistant_text(value);
    if text.is_empty() {
        return Vec::new();
    }
    vec![HarnessEvent::AssistantDelta { text }]
}

fn assistant_text(value: &Value) -> String {
    let Some(content) = value
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(Value::as_array)
    else {
        return String::new();
    };
    content
        .iter()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) != Some("text") {
                return None;
            }
            block.get("text").and_then(Value::as_str)
        })
        .collect::<Vec<_>>()
        .join("")
}

impl CursorTranslator {
    fn translate_tool(&mut self, value: &Value) -> Vec<HarnessEvent> {
        let id = match value.get("call_id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => return Vec::new(),
        };
        let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("");
        let tool_call = value.get("tool_call").unwrap_or(&Value::Null);
        let (name, input) = normalize_tool_call(tool_call);
        let mut events = Vec::new();
        if subtype == "started" && self.seen_tools.insert(id.clone()) {
            events.push(HarnessEvent::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            });
        }
        if subtype == "completed" {
            if self.seen_tools.insert(id.clone()) {
                // A completion without a prior start still needs a row.
                events.push(HarnessEvent::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                });
            }
            let (output, is_error) = tool_result(tool_call);
            events.push(HarnessEvent::ToolResult {
                id,
                output,
                is_error,
            });
        }
        events
    }
}

/// Maps Cursor's camelCase tool envelopes onto the Claude-shaped names and
/// args the transcript cards already understand (`Read`/`file_path`, …).
fn normalize_tool_call(tool_call: &Value) -> (String, Value) {
    let Some(obj) = tool_call.as_object() else {
        return ("tool".to_string(), Value::Null);
    };
    if let Some((key, body)) = obj.iter().next() {
        let args = body.get("args").cloned().unwrap_or(Value::Null);
        return match key.as_str() {
            "readToolCall" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                (
                    "Read".to_string(),
                    serde_json::json!({ "file_path": path }),
                )
            }
            "writeToolCall" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let content = args
                    .get("fileText")
                    .or_else(|| args.get("contents"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                (
                    "Write".to_string(),
                    serde_json::json!({ "file_path": path, "content": content }),
                )
            }
            "editToolCall" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                let old_string = args
                    .get("old_string")
                    .or_else(|| args.get("oldString"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let new_string = args
                    .get("new_string")
                    .or_else(|| args.get("newString"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                (
                    "Edit".to_string(),
                    serde_json::json!({
                        "file_path": path,
                        "old_string": old_string,
                        "new_string": new_string,
                    }),
                )
            }
            "deleteToolCall" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                (
                    "Delete".to_string(),
                    serde_json::json!({ "file_path": path }),
                )
            }
            "shellToolCall" | "bashToolCall" => {
                let command = args.get("command").and_then(Value::as_str).unwrap_or("");
                (
                    "Bash".to_string(),
                    serde_json::json!({ "command": command }),
                )
            }
            "grepToolCall" => {
                let pattern = args.get("pattern").and_then(Value::as_str).unwrap_or("");
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                (
                    "Grep".to_string(),
                    serde_json::json!({ "pattern": pattern, "path": path }),
                )
            }
            "globToolCall" => {
                let pattern = args
                    .get("globPattern")
                    .or_else(|| args.get("glob_pattern"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let path = args
                    .get("targetDirectory")
                    .or_else(|| args.get("target_directory"))
                    .and_then(Value::as_str)
                    .unwrap_or("");
                (
                    "Glob".to_string(),
                    serde_json::json!({ "pattern": pattern, "path": path }),
                )
            }
            "lsToolCall" => {
                let path = args.get("path").and_then(Value::as_str).unwrap_or("");
                ("LS".to_string(), serde_json::json!({ "path": path }))
            }
            "function" => {
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("tool")
                    .to_string();
                let arguments = args.get("arguments").cloned().unwrap_or(Value::Null);
                let input = match arguments {
                    Value::String(s) => serde_json::from_str(&s).unwrap_or(Value::String(s)),
                    other => other,
                };
                (name, input)
            }
            other => {
                // Strip the `ToolCall` suffix for a readable card title.
                let name = other.strip_suffix("ToolCall").unwrap_or(other);
                (name.to_string(), args)
            }
        };
    }
    ("tool".to_string(), Value::Null)
}

fn tool_result(tool_call: &Value) -> (String, bool) {
    let Some(obj) = tool_call.as_object() else {
        return (String::new(), false);
    };
    let Some((_, body)) = obj.iter().next() else {
        return (String::new(), false);
    };
    let Some(result) = body.get("result") else {
        return (String::new(), false);
    };
    if let Some(success) = result.get("success") {
        return (format_success(success), false);
    }
    if let Some(error) = result.get("error") {
        let message = error
            .get("errorMessage")
            .or_else(|| error.get("message"))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| error.to_string());
        return (message, true);
    }
    if let Some(message) = result.as_str() {
        return (message.to_string(), true);
    }
    (String::new(), false)
}

fn format_success(success: &Value) -> String {
    if let Some(content) = success.get("content").and_then(Value::as_str) {
        return content.to_string();
    }
    if let Some(stdout) = success.get("stdout").and_then(Value::as_str) {
        let stderr = success
            .get("stderr")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if stderr.is_empty() {
            return stdout.to_string();
        }
        return format!("{stdout}\n{stderr}");
    }
    // Compact summary for write/edit when there's no body text.
    if let Some(path) = success.get("path").and_then(Value::as_str) {
        let mut parts = vec![path.to_string()];
        if let Some(n) = success.get("linesCreated").and_then(Value::as_u64) {
            parts.push(format!("{n} lines created"));
        }
        if let Some(n) = success.get("linesAdded").and_then(Value::as_u64) {
            parts.push(format!("+{n}"));
        }
        if let Some(n) = success.get("linesRemoved").and_then(Value::as_u64) {
            parts.push(format!("-{n}"));
        }
        return parts.join(" · ");
    }
    success.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translator() -> CursorTranslator {
        CursorTranslator {
            program: PathBuf::from("cursor-agent"),
            cwd: PathBuf::from("/tmp"),
            project_name: "tmp".to_string(),
            model: Some("auto".into()),
            session: None,
            mode: Arc::new(Mutex::new(PermissionMode::Auto)),
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
            settled: false,
        }
    }

    #[test]
    fn build_starts_fresh_and_resumes_with_session() {
        let mut t = translator();
        let first = t.build("hi", &[]);
        assert!(first.args.contains(&"-p".to_string()));
        assert!(first.args.contains(&"stream-json".to_string()));
        assert!(first.args.contains(&"--stream-partial-output".to_string()));
        assert!(first.args.contains(&"--force".to_string()));
        assert!(first.args.contains(&"--workspace".to_string()));
        assert!(!first.args.iter().any(|a| a == "--resume"));
        assert!(first.args.contains(&"auto".to_string()));

        t.session = Some("ses_1".into());
        let second = t.build("again", &[]);
        let at = second.args.iter().position(|a| a == "--resume").unwrap();
        assert_eq!(second.args[at + 1], "ses_1");
    }

    #[test]
    fn build_maps_permission_modes() {
        let mut t = translator();
        t.mode = Arc::new(Mutex::new(PermissionMode::Plan));
        let plan = t.build("hi", &[]).args;
        assert!(plan.windows(2).any(|w| w == ["--mode", "plan"]));
        assert!(!plan.iter().any(|a| a == "--force"));

        t.mode = Arc::new(Mutex::new(PermissionMode::BypassPermissions));
        let bypass = t.build("hi", &[]).args;
        assert!(bypass.iter().any(|a| a == "--force"));
    }

    #[test]
    fn build_attaches_images_in_the_prompt() {
        let mut t = translator();
        let images = vec![PathBuf::from("/tmp/pasted-1.png")];
        let req = t.build("look", &images);
        let prompt = req.args.last().expect("prompt is last");
        assert!(prompt.contains("look"), "{prompt}");
        assert!(prompt.contains("/tmp/pasted-1.png"), "{prompt}");
    }

    #[test]
    fn every_turn_carries_its_project() {
        let mut t = translator();
        t.cwd = PathBuf::from("/tmp/Arka");
        t.project_name = "Arka".to_string();
        let req = t.build("what folder am I in", &[]);
        let prompt = req.args.last().expect("prompt is the last arg");
        assert!(prompt.contains("Arka"), "{prompt}");
        assert!(prompt.contains("/tmp/Arka"), "{prompt}");
    }

    #[test]
    fn system_init_captures_session_and_arms_ready() {
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"system","subtype":"init","session_id":"ses_9","model":"Composer 2.5","cwd":"/tmp"}"#,
        );
        assert!(events.is_empty());
        assert_eq!(t.session.as_deref(), Some("ses_9"));
        match t.take_ready() {
            Some(HarnessEvent::Ready {
                session_id, model, ..
            }) => {
                assert_eq!(session_id, "ses_9");
                // Spawn already picked a model; init must not overwrite it.
                assert_eq!(model.as_deref(), Some("auto"));
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(t.take_ready().is_none());
    }

    #[test]
    fn partial_deltas_stream_and_duplicates_are_skipped() {
        let mut t = translator();
        let delta = t.push_line(
            r#"{"type":"assistant","timestamp_ms":1,"message":{"role":"assistant","content":[{"type":"text","text":"Hel"}]},"session_id":"s"}"#,
        );
        assert!(matches!(
            &delta[0],
            HarnessEvent::AssistantDelta { text } if text == "Hel"
        ));

        let before_tool = t.push_line(
            r#"{"type":"assistant","timestamp_ms":2,"model_call_id":"m1","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"s"}"#,
        );
        assert!(before_tool.is_empty());

        let final_flush = t.push_line(
            r#"{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello"}]},"session_id":"s"}"#,
        );
        assert!(final_flush.is_empty());
    }

    #[test]
    fn tool_start_and_complete_translate() {
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"tool_call","subtype":"started","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"/a/b.rs"}}},"session_id":"s"}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HarnessEvent::ToolUse { name, input, .. } => {
                assert_eq!(name, "Read");
                assert_eq!(
                    input.get("file_path").and_then(Value::as_str),
                    Some("/a/b.rs")
                );
            }
            other => panic!("unexpected {other:?}"),
        }

        let events = t.push_line(
            r#"{"type":"tool_call","subtype":"completed","call_id":"c1","tool_call":{"readToolCall":{"args":{"path":"/a/b.rs"},"result":{"success":{"content":"fn main() {}","totalLines":1}}}},"session_id":"s"}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HarnessEvent::ToolResult {
                output, is_error, ..
            } => {
                assert_eq!(output, "fn main() {}");
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn result_settles_the_turn_once() {
        let mut t = translator();
        t.build("hi", &[]);
        let events = t.push_line(
            r#"{"type":"result","subtype":"success","duration_ms":42,"is_error":false,"result":"done","session_id":"s"}"#,
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            HarnessEvent::TurnEnded {
                duration_ms,
                is_error,
                ..
            } => {
                assert_eq!(*duration_ms, 42);
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
        // Process exit after result is quiet.
        assert!(t.end_turn(false, Some(0)).is_empty());
    }

    #[test]
    fn write_and_shell_tools_normalize() {
        let (name, input) = normalize_tool_call(&serde_json::json!({
            "writeToolCall": { "args": { "path": "a.txt", "fileText": "hi" } }
        }));
        assert_eq!(name, "Write");
        assert_eq!(input.get("file_path").and_then(Value::as_str), Some("a.txt"));
        assert_eq!(input.get("content").and_then(Value::as_str), Some("hi"));

        let (name, input) = normalize_tool_call(&serde_json::json!({
            "shellToolCall": { "args": { "command": "ls" } }
        }));
        assert_eq!(name, "Bash");
        assert_eq!(input.get("command").and_then(Value::as_str), Some("ls"));
    }

    // Runs the real runner thread against a fake CLI: no network, no auth,
    // but the full spawn → translate → settle → shutdown path.
    #[cfg(unix)]
    mod live {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn sandbox(name: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("egant-cursor-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        fn fake_cli(dir: &Path, body: &str) -> PathBuf {
            let script = dir.join("fake-cursor-agent");
            std::fs::write(&script, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }

        fn turn_events() -> &'static str {
            r#"printf '%s\n' '{"type":"system","subtype":"init","session_id":"ses_1","model":"auto","cwd":"/tmp"}' '{"type":"assistant","timestamp_ms":1,"message":{"role":"assistant","content":[{"type":"text","text":"yo"}]}}' '{"type":"result","subtype":"success","duration_ms":10,"is_error":false,"result":"yo","session_id":"ses_1"}'"#
        }

        async fn until(
            rx: &Receiver<HarnessEvent>,
            mut f: impl FnMut(&HarnessEvent) -> bool,
        ) -> Vec<String> {
            let mut kinds = Vec::new();
            while let Ok(event) = rx.recv().await {
                let kind = match &event {
                    HarnessEvent::Ready { .. } => "ready",
                    HarnessEvent::AssistantDelta { .. } => "delta",
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
                let mut h = CursorAgent::spawn(CursorOptions {
                    program: script,
                    cwd: dir,
                    project_name: None,
                    model: None,
                    session: None,
                    permission_mode: PermissionMode::Auto,
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into(), vec![]).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["ready", "delta", "end"]);
                assert_eq!(h.session_id().as_deref(), Some("ses_1"));

                h.send("again".into(), vec![]).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["delta", "end"]);

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
                let mut h = CursorAgent::spawn(CursorOptions {
                    program: script,
                    cwd: dir,
                    project_name: None,
                    model: None,
                    session: None,
                    permission_mode: PermissionMode::Auto,
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into(), vec![]).await.unwrap();
                h.interrupt().await.unwrap();
                let mut saw_end = false;
                while let Ok(event) = rx.recv().await {
                    if let HarnessEvent::TurnEnded {
                        result, is_error, ..
                    } = event
                    {
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
