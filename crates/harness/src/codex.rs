//! Drives the `codex` CLI one turn per process.
//!
//! ```text
//! codex exec --json --skip-git-repo-check --sandbox <mode> -C <dir> [-m <model>] "<prompt>"
//! codex exec --json --skip-git-repo-check --sandbox <mode> -C <dir> resume <thread> "<prompt>"
//! ```
//!
//! prints newline-delimited JSON events (`thread.started`, `item.completed`,
//! `turn.completed`, `turn.failed`, `error`) and exits when the turn settles.
//! `resume` continues the thread the previous turn discovered, so from the
//! transcript's point of view the session is persistent.
//!
//! There is no host-answered approval channel here (unlike the Claude wire's
//! `--permission-prompts host`): `codex exec` has nobody to ask, so the
//! sandbox mode itself is what decides what the agent may do. Without an
//! explicit `--sandbox`, the CLI defaults to read-only, which makes every
//! edit fail with a permission error the model reports as prose — indistin-
//! guishable from a real bug unless you already know to look for it. The
//! session's [`PermissionMode`] is mapped onto `--sandbox` (or
//! `--dangerously-bypass-approvals-and-sandbox` for bypass) so a Codex
//! session can actually write files, matching what the same mode gets a
//! Claude session via its permission prompts.

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
pub struct CodexOptions {
    /// Binary to run. Left as `codex` it is resolved the way the agent
    /// registry resolves it (env override → `PATH` → login shell → install
    /// dirs → version-manager bins).
    pub program: PathBuf,
    /// Working directory the agent operates in (also passed as `-C`).
    pub cwd: PathBuf,
    /// Human name of the project `cwd` belongs to. Folded into every turn's
    /// prompt so "what folder am I in" answers with this project. `None`
    /// derives it from `cwd`.
    pub project_name: Option<String>,
    /// Model the first turn should use. `None` keeps the CLI default; resumed
    /// threads keep the model they started with.
    pub model: Option<String>,
    /// Context window override, passed as `-c model_context_window=N`.
    /// `None` keeps the CLI default.
    pub context_window: Option<u64>,
    /// Reasoning effort, passed as `-c model_reasoning_effort=<level>`
    /// (`minimal`, `low`, `medium`, `high`). `None` keeps the CLI default.
    pub reasoning_effort: Option<String>,
    /// Continue this codex thread instead of starting a new one.
    pub thread: Option<String>,
    /// What the agent may do without asking, since nothing here can ask.
    /// Mapped onto `--sandbox` per turn — see the module doc.
    pub permission_mode: PermissionMode,
}

impl Default for CodexOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("codex"),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            project_name: None,
            model: None,
            context_window: None,
            reasoning_effort: None,
            thread: None,
            permission_mode: PermissionMode::default(),
        }
    }
}

pub struct CodexExec {
    runner: Runner,
    mode: Arc<Mutex<PermissionMode>>,
}

impl CodexExec {
    pub fn spawn(options: CodexOptions) -> Result<Self> {
        log::info!(
            "codex spawn cwd={} model={:?} thread={}",
            options.cwd.display(),
            options.model,
            options.thread.is_some(),
        );
        let program = resolve_program(&options.program)?;
        let mode = Arc::new(Mutex::new(options.permission_mode));
        let project_name = options.project_name.clone().unwrap_or_else(|| {
            crate::project_display_name(&options.cwd)
        });
        let translator = CodexTranslator {
            program,
            cwd: options.cwd,
            project_name,
            model: options.model,
            context_window: options.context_window,
            reasoning_effort: options.reasoning_effort,
            thread: options.thread,
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
    if program.as_os_str() == "codex" {
        let desc = AgentId::Codex.descriptor();
        crate::agents::resolve_executable(desc)
            .with_context(|| format!("codex is not installed: {}", desc.install_hint))
    } else {
        Ok(program.to_path_buf())
    }
}

#[async_trait]
impl Harness for CodexExec {
    fn backend_name(&self) -> &'static str {
        "Codex"
    }

    fn agent_id(&self) -> AgentId {
        AgentId::Codex
    }

    fn session_id(&self) -> Option<SessionId> {
        self.runner.session_id()
    }

    fn events(&self) -> Receiver<HarnessEvent> {
        self.runner.events()
    }

    async fn send(&mut self, text: String, images: Vec<PathBuf>) -> Result<()> {
        log::debug!("codex send ({} chars, {} image(s))", text.len(), images.len());
        self.runner.send(text, images);
        Ok(())
    }

    async fn interrupt(&mut self) -> Result<()> {
        log::debug!("codex interrupt");
        self.runner.interrupt();
        Ok(())
    }

    async fn respond_permission(
        &mut self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> Result<()> {
        // This wire never asks: the sandbox mode decides everything up front.
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        log::info!("codex shutdown");
        self.runner.shutdown();
        Ok(())
    }

    /// Takes effect on the next turn: the sandbox is a launch flag, so a turn
    /// already running keeps the mode it started with.
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
    input_tokens: u64,
    output_tokens: u64,
    failed: bool,
}

struct CodexTranslator {
    program: PathBuf,
    cwd: PathBuf,
    project_name: String,
    model: Option<String>,
    context_window: Option<u64>,
    reasoning_effort: Option<String>,
    thread: Option<String>,
    mode: Arc<Mutex<PermissionMode>>,
    ready_sent: bool,
    turn: TurnAcc,
    seen_tools: HashSet<String>,
    /// Whether `turn.completed` has already settled this turn, so the process
    /// exiting afterwards isn't reported as a second turn ending.
    settled: bool,
}

/// `--sandbox` (or the bypass flag, which drops the sandbox entirely) for one
/// permission mode. `codex exec`'s own default absent any flag is read-only,
/// which is why this must always be passed rather than only on request.
///
/// `Manual` ("always ask before making changes") has nothing to ask here —
/// there's no live approval channel — so it lands on the same read-only
/// sandbox as `Plan` rather than silently allowing writes it can't actually
/// gate.
fn sandbox_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::Plan | PermissionMode::Manual => {
            vec!["--sandbox".into(), "read-only".into()]
        }
        PermissionMode::Auto | PermissionMode::AcceptEdits => {
            vec!["--sandbox".into(), "workspace-write".into()]
        }
        PermissionMode::BypassPermissions => {
            vec!["--dangerously-bypass-approvals-and-sandbox".into()]
        }
    }
}

impl CodexTranslator {
    /// Ends the turn: one `TurnEnded` carrying whatever the turn accumulated,
    /// and the accounting reset behind it. Called once per turn — either by
    /// `turn.completed` on the wire or, when that never came, by the process
    /// exiting — and the `settled` flag is what keeps it to once.
    fn settle(&mut self, result: Option<String>, is_error: bool) -> Vec<HarnessEvent> {
        let turn = std::mem::take(&mut self.turn);
        self.settled = true;
        vec![HarnessEvent::TurnEnded {
            result,
            is_error,
            duration_ms: turn
                .started
                .map(|s| s.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
                .unwrap_or(0),
            // `exec` reports usage, not cost.
            cost_usd: 0.0,
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
}

impl TurnTranslator for CodexTranslator {
    fn build(&mut self, text: &str, images: &[PathBuf]) -> TurnRequest {
        let cwd = self.cwd.display().to_string();
        // `-c` is a global option: it must precede the `exec` subcommand.
        let mut args = Vec::new();
        if let Some(n) = self.context_window {
            args.push("-c".to_string());
            args.push(format!("model_context_window={n}"));
        }
        if let Some(effort) = &self.reasoning_effort {
            args.push("-c".to_string());
            args.push(format!("model_reasoning_effort={effort}"));
        }
        let mode = self.mode.lock().map(|guard| *guard).unwrap_or_default();
        args.push("exec".to_string());
        args.push("--json".to_string());
        args.push("--skip-git-repo-check".to_string());
        args.extend(sandbox_args(mode));
        args.push("-C".to_string());
        args.push(cwd);
        if let Some(thread) = &self.thread {
            args.push("resume".to_string());
            args.push(thread.clone());
        } else if let Some(model) = &self.model {
            // A resumed thread keeps the model it started with.
            args.push("-m".to_string());
            args.push(model.clone());
        }
        // Real vision input, not a `@path` mention the model would have to
        // go read itself — `codex exec` (and `exec resume`) both take this
        // natively.
        for image in images {
            args.push("--image".to_string());
            args.push(image.display().to_string());
        }
        // `codex exec` has no system-prompt flag: the project fact travels in
        // the prompt itself, on every turn, so a resumed thread keeps
        // answering with the folder it runs in.
        args.push(crate::wrap_turn_with_project(
            &self.project_name,
            &self.cwd,
            text,
        ));
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
                log::debug!("codex unparsed line: {line} ({error})");
                return Vec::new();
            }
        };
        match value.get("type").and_then(Value::as_str) {
            Some("thread.started") => {
                if let Some(id) = value.get("thread_id").and_then(Value::as_str) {
                    self.thread = Some(id.to_string());
                }
                Vec::new()
            }
            Some("turn.started") | Some("item.started") => Vec::new(),
            Some("item.completed") => match value.get("item") {
                Some(item) => self.translate_item(item),
                None => Vec::new(),
            },
            Some("turn.completed") => {
                if let Some(usage) = value.get("usage") {
                    self.turn.input_tokens +=
                        usage.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
                    self.turn.output_tokens += usage
                        .get("output_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                }
                // `codex exec` says this the moment the turn is genuinely over,
                // then spends another second or so tearing the process down.
                // Waiting for the exit would leave the window claiming the
                // agent is still working long after it has stopped, so the
                // turn settles here and `end_turn` stays quiet about the exit.
                self.settle(None, false)
            }
            Some("turn.failed") => {
                self.turn.failed = true;
                let message = value
                    .get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(Value::as_str)
                    .unwrap_or("the turn failed");
                vec![HarnessEvent::Error {
                    message: message.to_string(),
                }]
            }
            Some("error") => {
                self.turn.failed = true;
                vec![HarnessEvent::Error {
                    message: value
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("codex reported an error")
                        .to_string(),
                }]
            }
            _ => Vec::new(),
        }
    }

    fn end_turn(&mut self, interrupted: bool, exit: Option<i32>) -> Vec<HarnessEvent> {
        // A turn `turn.completed` already settled: the process winding down
        // afterwards is not news. An interrupt or a bad exit still is, and
        // falls through to the report below.
        if self.settled && !interrupted && exit.unwrap_or(0) == 0 {
            return Vec::new();
        }
        let (result, is_error) = if interrupted {
            (Some("Interrupted.".to_string()), true)
        } else if self.turn.failed {
            // Already surfaced as an error notice mid-turn; settle quietly.
            (None, true)
        } else if exit.is_some_and(|code| code != 0) {
            (
                Some(format!(
                    "codex exited with status {}.",
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
        let session_id = self.thread.clone()?;
        self.ready_sent = true;
        Some(HarnessEvent::Ready {
            session_id,
            model: self.model.clone(),
            cwd: Some(self.cwd.clone()),
            tools: Vec::new(),
        })
    }

    fn session_id(&self) -> Option<SessionId> {
        self.thread.clone()
    }
}

impl CodexTranslator {
    fn translate_item(&mut self, item: &Value) -> Vec<HarnessEvent> {
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("");
        match kind {
            "agent_message" => match item.get("text").and_then(Value::as_str) {
                Some(text) if !text.is_empty() => vec![HarnessEvent::AssistantMessage {
                    text: text.to_string(),
                }],
                _ => Vec::new(),
            },
            "reasoning" => match reasoning_text(item) {
                Some(text) => vec![HarnessEvent::ThinkingDelta { text }],
                None => Vec::new(),
            },
            "error" => vec![HarnessEvent::Error {
                message: item
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("codex reported an error")
                    .to_string(),
            }],
            _ => self.translate_tool_item(item, kind),
        }
    }

    /// Any other completed item is a tool call with a best-effort result, so
    /// nothing the agent did stays stuck as "running" in the transcript.
    fn translate_tool_item(&mut self, item: &Value, kind: &str) -> Vec<HarnessEvent> {
        let id = match item.get("id").and_then(Value::as_str) {
            Some(id) => id.to_string(),
            None => return Vec::new(),
        };
        let mut events = Vec::new();
        if self.seen_tools.insert(id.clone()) {
            let name = if kind == "command_execution" {
                "exec".to_string()
            } else {
                kind.to_string()
            };
            events.push(HarnessEvent::ToolUse {
                id: id.clone(),
                name,
                input: tool_input(item),
            });
        }
        events.push(HarnessEvent::ToolResult {
            id,
            output: tool_output(item),
            is_error: tool_failed(item),
        });
        events
    }
}

fn reasoning_text(item: &Value) -> Option<String> {
    if let Some(text) = item.get("text").and_then(Value::as_str) {
        if !text.is_empty() {
            return Some(text.to_string());
        }
    }
    // Some builds carry `summary` blocks instead of plain text.
    let summary = item.get("summary")?.as_array()?;
    let joined = summary
        .iter()
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then_some(joined)
}

fn tool_input(item: &Value) -> Value {
    if item.get("type").and_then(Value::as_str) == Some("command_execution") {
        if let Some(command) = item.get("command").and_then(Value::as_str) {
            return serde_json::json!({ "command": command });
        }
    }
    item.clone()
}

fn tool_output(item: &Value) -> String {
    for key in ["aggregated_output", "output", "text"] {
        if let Some(text) = item.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    String::new()
}

fn tool_failed(item: &Value) -> bool {
    if item.get("type").and_then(Value::as_str) == Some("command_execution") {
        return item
            .get("exit_code")
            .and_then(Value::as_u64)
            .is_some_and(|code| code != 0);
    }
    item.get("is_error").and_then(Value::as_bool).unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translator() -> CodexTranslator {
        CodexTranslator {
            program: PathBuf::from("codex"),
            cwd: PathBuf::from("/tmp"),
            project_name: "tmp".to_string(),
            model: Some("gpt-5".into()),
            context_window: None,
            reasoning_effort: None,
            thread: None,
            mode: Arc::new(Mutex::new(PermissionMode::Auto)),
            ready_sent: false,
            settled: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
        }
    }

    #[test]
    fn build_defaults_to_workspace_write_sandbox() {
        // Without this, codex exec's own default is read-only and every
        // edit fails with a permission error reported as assistant prose.
        let mut t = translator();
        let req = t.build("hi", &[]);
        let at = req.args.iter().position(|a| a == "--sandbox").expect("--sandbox present");
        assert_eq!(req.args[at + 1], "workspace-write");
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
        assert!(prompt.contains("what folder am I in"), "{prompt}");
    }

    #[test]
    fn plan_mode_uses_read_only_sandbox() {
        let mut t = translator();
        *t.mode.lock().unwrap() = PermissionMode::Plan;
        let req = t.build("hi", &[]);
        let at = req.args.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(req.args[at + 1], "read-only");
    }

    #[test]
    fn manual_mode_also_uses_read_only_sandbox() {
        // Codex can't honor "always ask" — there's no approval channel — so
        // it falls back to the same safe read-only sandbox as Plan.
        let mut t = translator();
        *t.mode.lock().unwrap() = PermissionMode::Manual;
        let req = t.build("hi", &[]);
        let at = req.args.iter().position(|a| a == "--sandbox").unwrap();
        assert_eq!(req.args[at + 1], "read-only");
    }

    #[test]
    fn bypass_mode_drops_the_sandbox_flag_entirely() {
        let mut t = translator();
        *t.mode.lock().unwrap() = PermissionMode::BypassPermissions;
        let req = t.build("hi", &[]);
        assert!(
            req.args
                .iter()
                .any(|a| a == "--dangerously-bypass-approvals-and-sandbox")
        );
        assert!(!req.args.iter().any(|a| a == "--sandbox"));
    }

    #[test]
    fn build_prepends_context_window_override() {
        let mut t = translator();
        t.context_window = Some(200_000);
        let req = t.build("hi", &[]);
        // Global `-c` precedes the subcommand.
        assert_eq!(req.args[0], "-c");
        assert_eq!(req.args[1], "model_context_window=200000");
        assert!(req.args.contains(&"exec".to_string()));

        t.context_window = None;
        let req = t.build("hi", &[]);
        assert!(!req.args.iter().any(|a| a == "-c"));
    }

    #[test]
    fn build_attaches_images_with_the_native_flag() {
        // Real vision input via `--image`, not a `@path` mention baked into
        // the prompt text — the CLI reads the file itself either way.
        let mut t = translator();
        let images = vec![PathBuf::from("/tmp/pasted-1.png"), PathBuf::from("/tmp/pasted-2.png")];
        let req = t.build("look at this", &images);
        let flags: Vec<&String> = req
            .args
            .iter()
            .zip(req.args.iter().skip(1))
            .filter(|(a, _)| *a == "--image")
            .map(|(_, path)| path)
            .collect();
        assert_eq!(flags, vec!["/tmp/pasted-1.png", "/tmp/pasted-2.png"]);
        // The prompt text itself carries no mention of the path.
        assert!(!req.args.last().unwrap().contains("pasted"));
    }

    #[test]
    fn build_prepends_reasoning_effort_override() {
        let mut t = translator();
        t.reasoning_effort = Some("high".into());
        let req = t.build("hi", &[]);
        let at = req.args.iter().position(|a| a == "-c").unwrap();
        assert_eq!(req.args[at + 1], "model_reasoning_effort=high");
    }

    #[test]
    fn build_runs_fresh_then_resumes() {
        let mut t = translator();
        let first = t.build("hi", &[]);
        assert!(first.args.contains(&"exec".to_string()));
        assert!(!first.args.iter().any(|a| a == "resume"));
        assert!(first.args.contains(&"gpt-5".to_string()));

        t.thread = Some("thr_1".into());
        let second = t.build("again", &[]);
        let at = second.args.iter().position(|a| a == "resume").unwrap();
        assert_eq!(second.args[at + 1], "thr_1");
        // A resumed thread keeps its own model: no `-m` override.
        assert!(!second.args.iter().any(|a| a == "-m"));
    }

    #[test]
    fn thread_start_arms_ready_once() {
        let mut t = translator();
        assert!(t
            .push_line(r#"{"type":"thread.started","thread_id":"thr_9"}"#)
            .is_empty());
        assert_eq!(t.thread.as_deref(), Some("thr_9"));
        assert!(matches!(
            t.take_ready(),
            Some(HarnessEvent::Ready { .. })
        ));
        assert!(t.take_ready().is_none());
    }

    #[test]
    fn items_translate() {
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hi"}}"#,
        );
        assert!(matches!(
            events[0],
            HarnessEvent::AssistantMessage { .. }
        ));

        let events = t.push_line(
            r#"{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"ls","aggregated_output":"a","exit_code":0,"status":"completed"}}"#,
        );
        assert_eq!(events.len(), 2);
        match &events[0] {
            HarnessEvent::ToolUse { name, .. } => assert_eq!(name, "exec"),
            other => panic!("unexpected {other:?}"),
        }
        match &events[1] {
            HarnessEvent::ToolResult { output, is_error, .. } => {
                assert_eq!(output, "a");
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }

    }

    /// `codex exec` prints `turn.completed` and then spends another second or
    /// so exiting, so the turn has to settle on that line — otherwise the
    /// window claims the agent is still working through the whole teardown.
    /// The exit that follows must not settle the same turn twice.
    #[test]
    fn turn_completed_settles_before_the_process_exits() {
        let mut t = translator();
        t.build("hi", &[]);
        let events =
            t.push_line(r#"{"type":"turn.completed","usage":{"input_tokens":7,"output_tokens":3}}"#);
        assert_eq!(events.len(), 1);
        match &events[0] {
            HarnessEvent::TurnEnded {
                usage, is_error, ..
            } => {
                assert_eq!(usage.input_tokens, 7);
                assert_eq!(usage.output_tokens, 3);
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
        // The process exiting cleanly afterwards is not a second turn ending.
        assert!(t.end_turn(false, Some(0)).is_empty());

        // A turn that settled and *then* died still gets reported.
        t.build("next", &[]);
        t.push_line(r#"{"type":"turn.completed","usage":{}}"#);
        match &t.end_turn(false, Some(3))[0] {
            HarnessEvent::TurnEnded {
                result, is_error, ..
            } => {
                assert!(result.as_deref().is_some_and(|text| text.contains("status 3")));
                assert!(is_error);
            }
            other => panic!("unexpected {other:?}"),
        }

        // So does an interrupt mid-turn, with no `turn.completed` at all.
        t.build("third", &[]);
        match &t.end_turn(true, None)[0] {
            HarnessEvent::TurnEnded {
                result, is_error, ..
            } => {
                assert_eq!(result.as_deref(), Some("Interrupted."));
                assert!(is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn failed_turn_surfaces_once() {
        let mut t = translator();
        t.build("hi", &[]);
        let events = t.push_line(
            r#"{"type":"turn.failed","error":{"message":"bad model"}}"#,
        );
        assert!(matches!(events[0], HarnessEvent::Error { .. }));
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

        #[test]
        fn turn_settles_and_thread_persists() {
            let dir = std::env::temp_dir()
                .join(format!("egant-codex-live-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fake-codex");
            std::fs::write(
                &script,
                "#!/bin/sh\nprintf '%s\\n' '{\"type\":\"thread.started\",\"thread_id\":\"thr_1\"}' '{\"type\":\"item.completed\",\"item\":{\"id\":\"item_0\",\"type\":\"agent_message\",\"text\":\"yo\"}}' '{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":7,\"output_tokens\":3}}'\n",
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

            futures_lite::future::block_on(async {
                let mut h = CodexExec::spawn(CodexOptions {
                    program: script,
                    cwd: dir,
                    project_name: None,
                    model: None,
                    context_window: None,
                    reasoning_effort: None,
                    thread: None,
                    permission_mode: PermissionMode::Auto,
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into(), vec![]).await.unwrap();
                let mut kinds = Vec::new();
                while let Ok(event) = rx.recv().await {
                    let kind = match &event {
                        HarnessEvent::Ready { .. } => "ready",
                        HarnessEvent::AssistantMessage { .. } => "msg",
                        HarnessEvent::TurnEnded { .. } => "end",
                        _ => "other",
                    };
                    kinds.push(kind);
                    if matches!(event, HarnessEvent::TurnEnded { .. }) {
                        break;
                    }
                }
                assert_eq!(kinds, ["ready", "msg", "end"]);
                assert_eq!(h.session_id().as_deref(), Some("thr_1"));
                h.shutdown().await.unwrap();
            });
        }
    }
}
