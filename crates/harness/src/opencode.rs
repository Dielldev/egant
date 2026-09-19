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
use crate::{Harness, HarnessEvent, PermissionDecision, PermissionMode, SessionId};
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
    /// Human name of the project `cwd` belongs to. Folded into every turn's
    /// prompt so "what folder am I in" answers with this project. `None`
    /// derives it from `cwd`.
    pub project_name: Option<String>,
    /// `provider/model` the turn should use. `None` keeps opencode's default.
    pub model: Option<String>,
    /// Reasoning variant for the turn (`high`, `max`, …). Only sent when the
    /// model advertises variants; `None` keeps opencode's default.
    pub variant: Option<String>,
    /// Continue this opencode session instead of starting fresh.
    pub session: Option<String>,
    /// Approve permissions not explicitly denied (`opencode run --auto`).
    /// Set after the user approves a denial in the permission table — the
    /// retry (and, for allow-always, every later turn) runs with it.
    pub auto_approve: bool,
}

impl Default for OpencodeOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("opencode"),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            project_name: None,
            model: None,
            variant: None,
            session: None,
            auto_approve: false,
        }
    }
}

pub struct OpencodeRun {
    runner: Runner,
    auto: std::sync::Arc<std::sync::Mutex<OpencodeAuto>>,
}

#[derive(Debug, Default, Clone, Copy)]
struct OpencodeAuto {
    /// `--auto` on every future turn (allow-always).
    always: bool,
    /// `--auto` on the next turn only (allow-once retry).
    once: bool,
}

impl OpencodeRun {
    pub fn spawn(options: OpencodeOptions) -> Result<Self> {
        log::info!(
            "opencode spawn cwd={} model={:?} session={}",
            options.cwd.display(),
            options.model,
            options.session.is_some(),
        );
        let program = resolve_program(&options.program)?;
        let project_name = options
            .project_name
            .clone()
            .unwrap_or_else(|| crate::project_display_name(&options.cwd));
        let auto = std::sync::Arc::new(std::sync::Mutex::new(OpencodeAuto {
            always: options.auto_approve,
            once: false,
        }));
        let translator = OpencodeTranslator {
            program,
            cwd: options.cwd,
            project_name,
            model: options.model,
            variant: options.variant,
            session: options.session,
            auto: auto.clone(),
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
            seen_permission_requests: HashSet::new(),
        };
        Ok(Self {
            runner: Runner::spawn(translator),
            auto,
        })
    }

    /// Approve the next turn's permissions (`--auto` on the next `run` only).
    /// What "Allow once" in the permission table means for this wire, which
    /// has no live approval channel: the denied turn is retried with
    /// auto-approve rather than answered mid-turn.
    pub fn approve_next_turn_once(&self) {
        if let Ok(mut auto) = self.auto.lock() {
            auto.once = true;
        }
    }

    /// Approve every future turn (`--auto` from here on). What "Allow always"
    /// means for this wire.
    pub fn approve_all_future_turns(&self) {
        if let Ok(mut auto) = self.auto.lock() {
            auto.always = true;
        }
    }

    /// Sets whether every future turn runs with `--auto`, the proactive
    /// counterpart to [`Self::approve_all_future_turns`]: it also turns the
    /// flag back off, which nothing else here can do once "Allow always" has
    /// set it. What the mode picker's "Bypass permissions" toggle needs,
    /// since it must be able to flip back to asking, not just stop asking.
    pub fn set_always_auto(&self, always: bool) {
        if let Ok(mut auto) = self.auto.lock() {
            auto.always = always;
        }
    }
}

fn resolve_program(program: &Path) -> Result<PathBuf> {
    if program.as_os_str() == "opencode" {
        let desc = AgentId::Opencode.descriptor();
        crate::agents::resolve_executable(desc)
            .with_context(|| format!("opencode is not installed: {}", desc.install_hint))
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

    async fn send(&mut self, text: String, images: Vec<PathBuf>) -> Result<()> {
        log::debug!(
            "opencode send ({} chars, {} image(s))",
            text.len(),
            images.len()
        );
        self.runner.send(text, images);
        Ok(())
    }

    async fn interrupt(&mut self) -> Result<()> {
        log::debug!("opencode interrupt");
        self.runner.interrupt();
        Ok(())
    }

    async fn respond_permission(
        &mut self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> Result<()> {
        // This wire never asks live: denials arrive as failed tools after the
        // fact, and approval means retrying with `--auto` (see
        // `approve_next_turn` / `approve_always`), not answering mid-turn.
        Ok(())
    }

    async fn approve_next_turn(&mut self) -> Result<()> {
        log::info!("opencode approve next turn");
        self.approve_next_turn_once();
        Ok(())
    }

    async fn approve_always(&mut self) -> Result<()> {
        log::info!("opencode approve always");
        self.approve_all_future_turns();
        Ok(())
    }

    /// This wire's only lever is `--auto`, so every mode besides bypass
    /// collapses onto "ask normally" — there's no live channel to make
    /// `Manual` or `Plan` behave differently from each other. Unlike
    /// `approve_always`, this can also turn `--auto` back off, which is what
    /// lets the bypass toggle flip both ways instead of only ever enabling
    /// it for the rest of the session.
    async fn set_permission_mode(&mut self, mode: PermissionMode) -> Result<()> {
        log::info!("opencode set permission mode {mode:?}");
        self.set_always_auto(mode == PermissionMode::BypassPermissions);
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        log::info!("opencode shutdown");
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
    project_name: String,
    model: Option<String>,
    variant: Option<String>,
    session: Option<SessionId>,
    auto: std::sync::Arc<std::sync::Mutex<OpencodeAuto>>,
    ready_sent: bool,
    turn: TurnAcc,
    seen_tools: HashSet<String>,
    seen_permission_requests: HashSet<String>,
}

impl TurnTranslator for OpencodeTranslator {
    fn build(&mut self, text: &str, images: &[PathBuf]) -> TurnRequest {
        let mut args = vec![
            "run".to_string(),
            "--format".to_string(),
            "json".to_string(),
        ];
        // `--auto` approves permissions not explicitly denied. Set for the
        // retry after an "Allow" answer, or persistently after "Allow always".
        let auto = self.auto.lock().map(|mut auto| {
            let use_auto = auto.always || auto.once;
            // A one-shot approval covers exactly one turn.
            auto.once = false;
            use_auto
        });
        if auto.unwrap_or(false) {
            args.push("--auto".to_string());
        }
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
        // Real vision input via `-f`, not a `@path` mention baked into the
        // prompt text — `opencode run` reads the file itself either way, but
        // this way it isn't left to the model to decide to go look.
        for image in images {
            args.push("-f".to_string());
            args.push(image.display().to_string());
        }
        // `-f`/`--file` is a yargs array flag: with no separator, it greedily
        // swallows the prompt that follows as another file path, and
        // `opencode run` fails with `Error: File not found: <prompt text>`
        // (exit 1) instead of ever reaching the model. `--` ends the option
        // list so the prompt lands as the positional `message` again — it's
        // a no-op when there are no images, so it's always applied rather
        // than only when `images` is non-empty.
        args.push("--".to_string());
        // opencode has no system-prompt flag on `run`: ground every turn in
        // the prompt itself so a resumed session keeps answering with the
        // folder it runs in.
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
        self.seen_permission_requests.clear();
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
                        self.turn.input_tokens +=
                            tokens.get("input").and_then(Value::as_u64).unwrap_or(0);
                        self.turn.output_tokens +=
                            tokens.get("output").and_then(Value::as_u64).unwrap_or(0);
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
        // This wire accounts for prompt and reply only; it says nothing
        // about cache splits or the window, which stay at zero rather
        // than being invented here.
        let usage = crate::TurnUsage {
            input_tokens: turn.input_tokens,
            output_tokens: turn.output_tokens,
            ..Default::default()
        };
        let mut events = Vec::new();
        // The turn total *is* the occupancy here — one accounting point per
        // turn, not a sum across loop iterations — so it doubles as the
        // context reading the meter shows.
        if usage.is_reported() {
            events.push(HarnessEvent::ContextUpdate {
                context_tokens: usage.total_tokens(),
                context_window: usage.context_window,
            });
        }
        events.push(HarnessEvent::TurnEnded {
            result,
            is_error,
            duration_ms,
            cost_usd: turn.cost_usd,
            usage,
        });
        events
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
        let raw_input = part
            .get("state")
            .and_then(|s| s.get("input"))
            .cloned()
            .unwrap_or(Value::Null);
        let (display_name, display_input) = normalize_tool_call(&name, raw_input);
        if self.seen_tools.insert(id.clone()) {
            events.push(HarnessEvent::ToolUse {
                id: id.clone(),
                name: display_name.clone(),
                input: display_input.clone(),
            });
        }
        let status = part
            .get("state")
            .and_then(|s| s.get("status"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if matches!(status, "completed" | "failed" | "error") {
            let state = part.get("state");
            let output = normalize_tool_output(&name, tool_output(state));
            let is_error = status != "completed";
            // Rejection wording lives in `state.error`, not `state.output`
            // (measured: `"status":"error", ..., "error":"The user rejected
            // permission to use this specific tool call."`). The card shows
            // the output; denial detection needs both.
            let error_text = tool_error(state);
            let denial_text = if output.is_empty() {
                error_text.clone()
            } else if error_text.is_empty() {
                output.clone()
            } else {
                format!("{output}\n{error_text}")
            };
            let is_denial = is_error && is_permission_denial(&denial_text);
            // A denial hasn't failed — nothing ran yet, the tool is parked
            // waiting for the approval table. Showing the CLI's "rejected"
            // wording as a red error before the user has answered reads as
            // an accusation ("you already rejected this") and flashes a red
            // card under every request. Keep it neutral; the permission table
            // below is the actual UI for this.
            let (display_output, display_is_error) = if is_denial {
                ("Waiting for approval — nothing ran yet.".to_string(), false)
            } else if output.is_empty() && !error_text.is_empty() {
                (error_text.clone(), is_error)
            } else {
                (output, is_error)
            };
            events.push(HarnessEvent::ToolResult {
                id: id.clone(),
                output: display_output,
                is_error: display_is_error,
            });
            // `opencode run --format json` auto-rejects anything its permission
            // map marks `ask` (notably `external_directory` for paths outside
            // the project, e.g. reading meme-cam from egant). That used to be
            // a bare tool error with no approval UI — the turn looked stalled.
            // Surface it as a permission request so the table can offer
            // Allow once / Allow always / Deny like every other app.
            if is_denial && self.seen_permission_requests.insert(id.clone()) {
                let (patterns, always_patterns) =
                    crate::permission_patterns(&display_name, &display_input);
                events.push(HarnessEvent::PermissionRequest {
                    request_id: id,
                    tool_name: display_name,
                    input: display_input,
                    patterns,
                    always_patterns,
                });
            }
        }
        events
    }
}

/// Whether a failed tool output is opencode refusing on permissions rather
/// than the tool itself failing. Measured wording from `opencode run
/// --format json` (v1.18): the tool errors with "rejected permission", while
/// the human-readable stderr line names the rule (`external_directory`,
/// `doom_loop`, …) — which never reaches us, since the runner pipes only
/// stdout.
fn is_permission_denial(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("rejected permission")
        || lower.contains("permission denied")
        || lower.contains("permission requested")
        || lower.contains("requires approval")
        || lower.contains("needs approval")
}

/// opencode names its own tools and shapes their arguments differently than
/// Claude does — lowercase `read` with a camelCase `filePath`, vs. Claude's
/// `Read` with `file_path` — even where they mean the same thing to the
/// user. Converging the well-known ones here, rather than teaching every
/// tool card in the frontend each agent's dialect, means the read preview,
/// the activity rows, and the per-file diff counts all just work, for any
/// agent.
fn normalize_tool_call(name: &str, input: Value) -> (String, Value) {
    match name {
        "read" => {
            let file_path = input.get("filePath").and_then(Value::as_str).unwrap_or("");
            (
                "Read".to_string(),
                serde_json::json!({ "file_path": file_path }),
            )
        }
        "edit" => {
            let file_path = input.get("filePath").and_then(Value::as_str).unwrap_or("");
            let old_string = input.get("oldString").and_then(Value::as_str).unwrap_or("");
            let new_string = input.get("newString").and_then(Value::as_str).unwrap_or("");
            (
                "Edit".to_string(),
                serde_json::json!({
                    "file_path": file_path,
                    "old_string": old_string,
                    "new_string": new_string,
                }),
            )
        }
        "write" => {
            let file_path = input.get("filePath").and_then(Value::as_str).unwrap_or("");
            let content = input.get("content").and_then(Value::as_str).unwrap_or("");
            (
                "Write".to_string(),
                serde_json::json!({ "file_path": file_path, "content": content }),
            )
        }
        "apply_patch" | "patch" => {
            let file_path = input
                .get("filePath")
                .or_else(|| input.get("file_path"))
                .and_then(Value::as_str)
                .unwrap_or("");
            let diff = input.get("diff").and_then(Value::as_str).unwrap_or("");
            (
                "Edit".to_string(),
                serde_json::json!({
                    "file_path": file_path,
                    "old_string": "",
                    "new_string": diff,
                }),
            )
        }
        _ => (name.to_string(), input),
    }
}

/// opencode's `read` tool wraps its result in `<path>…</path><type>…</type>
/// <content>1: line one\n…</content>` (or `<entries>…</entries>` for a
/// directory). Claude's own `Read` just returns the numbered text directly,
/// which is what the transcript's read preview expects — so the envelope
/// comes off here, once, rather than in the UI. Anything that doesn't match
/// the shape (an error string, say) passes through untouched.
fn normalize_tool_output(name: &str, output: String) -> String {
    if name != "read" {
        return output;
    }
    match extract_tag(&output, "content").or_else(|| extract_tag(&output, "entries")) {
        Some(content) => content.trim_matches('\n').to_string(),
        None => output,
    }
}

/// The text strictly between `<tag>` and `</tag>`, or `None` when either
/// side is missing.
fn extract_tag<'a>(text: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)?;
    Some(&text[start..start + end])
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

/// The failure text of a tool part, if any. Permission rejections arrive here
/// (`state.error`), not in `state.output` — see `translate_tool`.
fn tool_error(state: Option<&Value>) -> String {
    let state = match state {
        Some(state) => state,
        None => return String::new(),
    };
    if let Some(error) = state.get("error").and_then(Value::as_str) {
        return error.to_string();
    }
    if let Some(error) = state
        .get("error")
        .and_then(|e| e.get("message"))
        .and_then(Value::as_str)
    {
        return error.to_string();
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
            project_name: "tmp".to_string(),
            model: Some("prov/mod".into()),
            variant: None,
            session: None,
            auto: std::sync::Arc::new(std::sync::Mutex::new(OpencodeAuto::default())),
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
            seen_permission_requests: HashSet::new(),
        }
    }

    #[test]
    fn build_starts_fresh_and_resumes_with_session() {
        let mut t = translator();
        let first = t.build("hi", &[]);
        assert!(first.args.contains(&"run".to_string()));
        assert!(first.args.contains(&"--format".to_string()));
        assert!(!first.args.iter().any(|a| a == "-s"));
        assert!(first.args.contains(&"prov/mod".to_string()));

        t.session = Some("ses_1".into());
        let second = t.build("again", &[]);
        let at = second.args.iter().position(|a| a == "-s").unwrap();
        assert_eq!(second.args[at + 1], "ses_1");
    }

    #[test]
    fn build_attaches_images_with_the_native_flag() {
        // Real vision input via `-f`, not a `@path` mention baked into the
        // prompt text.
        let mut t = translator();
        let images = vec![
            PathBuf::from("/tmp/pasted-1.png"),
            PathBuf::from("/tmp/pasted-2.png"),
        ];
        let req = t.build("look at this", &images);
        let flags: Vec<&String> = req
            .args
            .iter()
            .zip(req.args.iter().skip(1))
            .filter(|(a, _)| *a == "-f")
            .map(|(_, path)| path)
            .collect();
        assert_eq!(flags, vec!["/tmp/pasted-1.png", "/tmp/pasted-2.png"]);
        assert!(!req.args.last().unwrap().contains("pasted"));
    }

    #[test]
    fn build_passes_variant_when_set() {
        let mut t = translator();
        t.variant = Some("high".into());
        let args = t.build("hi", &[]).args;
        let at = args.iter().position(|a| a == "--variant").unwrap();
        assert_eq!(args[at + 1], "high");
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
        let events = t.push_line(r#"{"type":"text","part":{"type":"text","text":"hello"}}"#);
        assert!(matches!(events[0], HarnessEvent::AssistantMessage { .. }));

        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"bash","callID":"c1","state":{"status":"completed","input":{"command":"ls"},"output":"a"}}}"#,
        );
        assert_eq!(events.len(), 2);
        assert!(matches!(events[0], HarnessEvent::ToolUse { .. }));
        match &events[1] {
            HarnessEvent::ToolResult {
                output, is_error, ..
            } => {
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

    /// opencode's `read` tool reports `filePath` and wraps its output in an
    /// XML envelope; the frontend's read cards only know Claude's shape
    /// (`file_path`, plain numbered text), so this is what makes them work
    /// for an opencode session too.
    #[test]
    fn read_tool_normalizes_to_claudes_shape() {
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c1","state":{"status":"completed","input":{"filePath":"/a/b.rs"},"output":"<path>/a/b.rs</path>\n<type>file</type>\n<content>\n1: fn main() {}\n\n(End of file - total 1 lines)\n</content>"}}}"#,
        );
        assert_eq!(events.len(), 2);
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
        match &events[1] {
            HarnessEvent::ToolResult {
                output, is_error, ..
            } => {
                assert_eq!(output, "1: fn main() {}\n\n(End of file - total 1 lines)");
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn edit_and_write_tools_normalize_to_claudes_shape() {
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"edit","callID":"c2","state":{"status":"completed","input":{"filePath":"/a/b.rs","oldString":"foo\n","newString":"bar\nbaz\n"},"output":"ok"}}}"#,
        );
        assert_eq!(events.len(), 2);
        match &events[0] {
            HarnessEvent::ToolUse { name, input, .. } => {
                assert_eq!(name, "Edit");
                assert_eq!(
                    input.get("file_path").and_then(Value::as_str),
                    Some("/a/b.rs")
                );
                assert_eq!(
                    input.get("old_string").and_then(Value::as_str),
                    Some("foo\n")
                );
                assert_eq!(
                    input.get("new_string").and_then(Value::as_str),
                    Some("bar\nbaz\n")
                );
            }
            other => panic!("unexpected {other:?}"),
        }

        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"write","callID":"c3","state":{"status":"completed","input":{"filePath":"/a/c.rs","content":"fn main() {}\n"},"output":"ok"}}}"#,
        );
        assert_eq!(events.len(), 2);
        match &events[0] {
            HarnessEvent::ToolUse { name, input, .. } => {
                assert_eq!(name, "Write");
                assert_eq!(
                    input.get("file_path").and_then(Value::as_str),
                    Some("/a/c.rs")
                );
                assert_eq!(
                    input.get("content").and_then(Value::as_str),
                    Some("fn main() {}\n")
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn step_finish_accumulates_and_settles() {
        let mut t = translator();
        t.build("hi", &[]);
        t.push_line(
            r#"{"type":"step_finish","part":{"tokens":{"input":10,"output":4},"cost":0.02}}"#,
        );
        let events = t.end_turn(false, Some(0));
        assert_eq!(events.len(), 2);
        match &events[0] {
            HarnessEvent::ContextUpdate { context_tokens, .. } => assert_eq!(*context_tokens, 14),
            other => panic!("unexpected {other:?}"),
        }
        match &events[1] {
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
        t.build("hi", &[]);
        let events =
            t.push_line(r#"{"type":"error","error":{"name":"X","data":{"message":"boom"}}}"#);
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

    #[test]
    fn auto_flag_is_off_by_default_and_on_when_approved() {
        let mut t = translator();
        let first = t.build("hi", &[]);
        assert!(!first.args.iter().any(|a| a == "--auto"));
        t.auto.lock().unwrap().once = true;
        let second = t.build("again", &[]);
        assert!(second.args.iter().any(|a| a == "--auto"));
        // One-shot: consumed by the turn that used it.
        let third = t.build("third", &[]);
        assert!(!third.args.iter().any(|a| a == "--auto"));
        t.auto.lock().unwrap().always = true;
        let fourth = t.build("fourth", &[]);
        assert!(fourth.args.iter().any(|a| a == "--auto"));
    }

    #[test]
    fn a_rejected_read_surfaces_as_a_permission_request() {
        // Measured from `opencode run --format json` reading outside the
        // project: the rejection lives in `state.error` (not `state.output`)
        // while stderr names the rule (`external_directory`). The table is
        // built from this.
        let mut t = translator();
        let events = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c9","state":{"status":"error","input":{"filePath":"/tmp/meme-cam/app.py"},"error":"The user rejected permission to use this specific tool call."}}}"#,
        );
        assert_eq!(events.len(), 3);
        assert!(matches!(events[0], HarnessEvent::ToolUse { .. }));
        match &events[1] {
            HarnessEvent::ToolResult {
                output, is_error, ..
            } => {
                // Neutral, not red: nothing ran yet, the approval table below
                // is the UI for this — the CLI's "rejected" wording must never
                // read as the user already having said no.
                assert!(!is_error);
                assert!(output.contains("Waiting for approval"), "{output}");
            }
            other => panic!("unexpected {other:?}"),
        }
        match &events[2] {
            HarnessEvent::PermissionRequest {
                request_id,
                tool_name,
                patterns,
                always_patterns,
                ..
            } => {
                assert_eq!(request_id, "c9");
                assert_eq!(tool_name, "Read");
                assert_eq!(patterns, &vec!["/tmp/meme-cam/app.py".to_string()]);
                assert_eq!(always_patterns, &vec!["/tmp/meme-cam/*".to_string()]);
            }
            other => panic!("unexpected {other:?}"),
        }
        // The same denial repeated (opencode re-emits the part) must not
        // double the table row.
        let repeat = t.push_line(
            r#"{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"c9","state":{"status":"error","input":{"filePath":"/tmp/meme-cam/app.py"},"error":"The user rejected permission to use this specific tool call."}}}"#,
        );
        assert!(
            repeat
                .iter()
                .all(|e| !matches!(e, HarnessEvent::PermissionRequest { .. }))
        );
    }

    // Runs the real runner thread against a fake CLI: no network, no auth,
    // but the full spawn → translate → settle → shutdown path.
    #[cfg(unix)]
    mod live {
        use super::*;
        use crate::Harness as _;
        use std::os::unix::fs::PermissionsExt;

        fn sandbox(name: &str) -> PathBuf {
            let dir =
                std::env::temp_dir().join(format!("egant-opencode-{name}-{}", std::process::id()));
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
                    HarnessEvent::ContextUpdate { .. } => "ctx",
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
                    project_name: None,
                    model: None,
                    variant: None,
                    session: None,
                    auto_approve: false,
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into(), vec![]).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["ready", "msg", "ctx", "end"]);
                assert_eq!(h.session_id().as_deref(), Some("ses_1"));

                // A second turn reuses the session: no second Ready.
                h.send("again".into(), vec![]).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["msg", "ctx", "end"]);

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
                    project_name: None,
                    model: None,
                    variant: None,
                    session: None,
                    auto_approve: false,
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

        #[test]
        fn set_permission_mode_toggles_auto_for_future_turns() {
            // The bug this exists to prevent: `approve_all_future_turns` (what
            // "Allow always" in the permission table sends) could only ever
            // turn `--auto` on — nothing could turn it back off once a
            // session had flipped to bypass. The mode picker's Bypass toggle
            // needs both directions, which is what `set_permission_mode`
            // adds.
            let dir = sandbox("bypass-toggle");
            let log = dir.join("argv.log");
            // NUL-separated: the wrapped prompt (`wrap_turn_with_project`)
            // embeds a real newline, so a newline-delimited log would slice
            // one invocation's args into several lines.
            let script = fake_cli(
                &dir,
                &format!(
                    "printf '%s\\0' \"$*\" >> {}\n{}",
                    log.display(),
                    turn_events()
                ),
            );
            futures_lite::future::block_on(async {
                let mut h = OpencodeRun::spawn(OpencodeOptions {
                    program: script,
                    cwd: dir.clone(),
                    project_name: None,
                    model: None,
                    variant: None,
                    session: None,
                    auto_approve: false,
                })
                .unwrap();
                let rx = h.events();

                h.send("first".into(), vec![]).await.unwrap();
                until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;

                h.set_permission_mode(PermissionMode::BypassPermissions)
                    .await
                    .unwrap();
                h.send("second".into(), vec![]).await.unwrap();
                until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;

                // Flipping back off is the part that used to be impossible.
                h.set_permission_mode(PermissionMode::Auto).await.unwrap();
                h.send("third".into(), vec![]).await.unwrap();
                until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;

                h.shutdown().await.unwrap();
                until(&rx, |e| matches!(e, HarnessEvent::Exited { .. })).await;

                let logged = std::fs::read(&log).unwrap();
                let calls: Vec<&str> = logged
                    .split(|&b| b == 0)
                    .filter(|c| !c.is_empty())
                    .map(|c| std::str::from_utf8(c).unwrap())
                    .collect();
                assert_eq!(calls.len(), 3, "{calls:?}");
                assert!(!calls[0].contains("--auto"), "{}", calls[0]);
                assert!(calls[1].contains("--auto"), "{}", calls[1]);
                assert!(!calls[2].contains("--auto"), "{}", calls[2]);
            });
        }
    }
}
