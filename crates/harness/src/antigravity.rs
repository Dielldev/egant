//! Drives the `agy` (Antigravity) CLI one turn per process.
//!
//! ```text
//! agy --output-format stream-json [--model <id>] [--mode <mode>] --print=<prompt>
//! agy --output-format stream-json --conversation <id> [...]       --print=<prompt>
//! ```
//!
//! prints newline-delimited JSON on stdout and exits when the turn settles:
//! an `init` event naming the conversation, `step_update` events as each step
//! (`user_input`, `agent_response`, a tool call…) goes `ACTIVE` then `DONE`,
//! and a closing `result` with the turn's status and token accounting.
//! `--conversation` continues the conversation the previous turn named, so
//! from the transcript's point of view the session is persistent.
//!
//! The prompt must be *attached to the flag* (`--print=<prompt>`): a detached
//! one is read as the flag's value and silently dropped, which is exactly what
//! `--print <prompt>` looks like to the CLI's own parser.
//!
//! There is nobody to ask: print mode "soft-denies" any tool confirmation it
//! would otherwise have shown (measured: `run_command` under `--mode
//! accept-edits` fails with `state: "ERROR"` and the turn ends with an empty
//! reply; `--sandbox` does not lift it). So the session's [`PermissionMode`] is
//! mapped onto the CLI's own `--mode` / `--dangerously-skip-permissions` up
//! front — see [`mode_args`] — and a denial that still happens comes back as a
//! [`HarnessEvent::PermissionRequest`], the way opencode's does. Approving it
//! retries the turn with `--dangerously-skip-permissions`: once for "Allow",
//! from then on for "Allow always".
//!
//! The model id carries its own reasoning effort (`gemini-3.1-pro-high`,
//! `…-low`), so there is no separate effort variant to pick.

use crate::agents::AgentId;
use crate::runner::{Runner, TurnRequest, TurnTranslator};
use crate::{Harness, HarnessEvent, PermissionDecision, PermissionMode, SessionId};
use anyhow::{Context as _, Result};
use async_channel::Receiver;
use async_trait::async_trait;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

#[derive(Debug, Clone)]
pub struct AntigravityOptions {
    /// Binary to run. Left as `agy` it is resolved the way the agent registry
    /// resolves it (env override → `PATH` → login shell → install dirs).
    pub program: PathBuf,
    /// Working directory the agent operates in.
    pub cwd: PathBuf,
    /// Human name of the project `cwd` belongs to. Folded into every turn's
    /// prompt so "what folder am I in" answers with this project. `None`
    /// derives it from `cwd`.
    pub project_name: Option<String>,
    /// Model to run, from `agy models`. `None` keeps the CLI default.
    pub model: Option<String>,
    /// Continue this conversation instead of starting a new one.
    pub conversation: Option<String>,
    /// What the agent may do without asking, since nothing here can ask.
    pub permission_mode: PermissionMode,
}

impl Default for AntigravityOptions {
    fn default() -> Self {
        Self {
            program: PathBuf::from("agy"),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")),
            project_name: None,
            model: None,
            conversation: None,
            permission_mode: PermissionMode::default(),
        }
    }
}

pub struct AntigravityRun {
    runner: Runner,
    mode: Arc<Mutex<PermissionMode>>,
    /// Set by an "Allow" on a denied turn: the retry that follows runs with
    /// every permission approved, and the flag clears as it starts.
    approve_next: Arc<AtomicBool>,
}

impl AntigravityRun {
    pub fn spawn(options: AntigravityOptions) -> Result<Self> {
        log::info!(
            "antigravity spawn cwd={} model={:?} conversation={}",
            options.cwd.display(),
            options.model,
            options.conversation.is_some(),
        );
        let program = resolve_program(&options.program)?;
        let mode = Arc::new(Mutex::new(options.permission_mode));
        let approve_next = Arc::new(AtomicBool::new(false));
        let project_name = options
            .project_name
            .clone()
            .unwrap_or_else(|| crate::project_display_name(&options.cwd));
        let translator = AntigravityTranslator {
            program,
            cwd: options.cwd,
            project_name,
            model: options.model,
            conversation: options.conversation,
            mode: mode.clone(),
            approve_next: approve_next.clone(),
            tools: Vec::new(),
            init_model: None,
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
            requests: HashSet::new(),
            last_tool: None,
            texts: HashMap::new(),
            settled: false,
        };
        Ok(Self {
            runner: Runner::spawn(translator),
            mode,
            approve_next,
        })
    }
}

fn resolve_program(program: &Path) -> Result<PathBuf> {
    if program.as_os_str() == "agy" {
        let desc = AgentId::Antigravity.descriptor();
        crate::agents::resolve_executable(desc)
            .with_context(|| format!("agy is not installed: {}", desc.install_hint))
    } else {
        Ok(program.to_path_buf())
    }
}

#[async_trait]
impl Harness for AntigravityRun {
    fn backend_name(&self) -> &'static str {
        "Antigravity"
    }

    fn agent_id(&self) -> AgentId {
        AgentId::Antigravity
    }

    fn session_id(&self) -> Option<SessionId> {
        self.runner.session_id()
    }

    fn events(&self) -> Receiver<HarnessEvent> {
        self.runner.events()
    }

    async fn send(&mut self, text: String, images: Vec<PathBuf>) -> Result<()> {
        log::debug!(
            "antigravity send ({} chars, {} image(s))",
            text.len(),
            images.len()
        );
        self.runner.send(text, images);
        Ok(())
    }

    async fn interrupt(&mut self) -> Result<()> {
        log::debug!("antigravity interrupt");
        self.runner.interrupt();
        Ok(())
    }

    async fn respond_permission(
        &mut self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> Result<()> {
        // This wire never asks live: a denial arrives after the fact, and
        // approving it means retrying the turn (see `approve_next_turn` and
        // `approve_always`), not answering mid-turn.
        Ok(())
    }

    async fn approve_next_turn(&mut self) -> Result<()> {
        log::info!("antigravity approve next turn");
        self.approve_next.store(true, Ordering::SeqCst);
        Ok(())
    }

    async fn approve_always(&mut self) -> Result<()> {
        log::info!("antigravity approve always");
        if let Ok(mut slot) = self.mode.lock() {
            *slot = PermissionMode::BypassPermissions;
        }
        Ok(())
    }

    async fn shutdown(&mut self) -> Result<()> {
        log::info!("antigravity shutdown");
        self.runner.shutdown();
        Ok(())
    }

    /// Takes effect on the next turn: the mode is a launch flag, so a turn
    /// already running keeps the one it started with.
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
    /// Whether any assistant text reached the transcript this turn, so the
    /// closing `result`'s `response` is only used as a fallback.
    spoke: bool,
    failed: bool,
    /// Whether a step already gave a live context reading, so the turn's own
    /// usage — a sum over every step — doesn't overwrite it.
    context_seen: bool,
}

struct AntigravityTranslator {
    program: PathBuf,
    cwd: PathBuf,
    project_name: String,
    model: Option<String>,
    conversation: Option<String>,
    mode: Arc<Mutex<PermissionMode>>,
    approve_next: Arc<AtomicBool>,
    /// What `init` advertised, for the `Ready` event.
    tools: Vec<String>,
    /// The model `init` says is running, for the `Ready` event — which is not
    /// `model`, the flag, when the session runs on the CLI's default.
    init_model: Option<String>,
    ready_sent: bool,
    turn: TurnAcc,
    seen_tools: HashSet<String>,
    /// Tool calls already raised as permission requests this turn.
    requests: HashSet<String>,
    /// The most recent tool call, as the transcript knows it — what a denial
    /// the CLI only reports at the end (`denied_actions`) is attributed to.
    last_tool: Option<(String, String, Value)>,
    /// Text of each in-flight `agent_response` step, by step index, so the
    /// step's `DONE` can settle it as one message.
    texts: HashMap<u64, String>,
    /// Whether the closing `result` has already settled this turn, so the
    /// process exiting afterwards isn't reported as a second turn ending.
    settled: bool,
}

/// The CLI flags for one permission mode. Nothing can answer a confirmation in
/// print mode — the CLI soft-denies it, and the model reports the refusal as
/// prose — so what the mode allows has to be decided before the turn starts.
///
/// `Manual` ("always ask before making changes") has nothing to ask, so it
/// takes the CLI's default mode, which is exactly the one that denies whatever
/// would need a confirmation. `Auto` shares `AcceptEdits`' footing: edits go
/// through, nothing riskier is waved on.
fn mode_args(mode: PermissionMode) -> Vec<String> {
    match mode {
        PermissionMode::Plan => vec!["--mode".into(), "plan".into()],
        PermissionMode::Manual => Vec::new(),
        PermissionMode::Auto | PermissionMode::AcceptEdits => {
            vec!["--mode".into(), "accept-edits".into()]
        }
        PermissionMode::BypassPermissions => vec!["--dangerously-skip-permissions".into()],
    }
}

impl AntigravityTranslator {
    /// Ends the turn: one `TurnEnded` carrying whatever the turn accumulated,
    /// and the accounting reset behind it. Called once per turn — either by
    /// `result` on the wire or, when that never came, by the process exiting —
    /// and the `settled` flag is what keeps it to once.
    fn settle(
        &mut self,
        result: Option<String>,
        is_error: bool,
        duration_ms: Option<u64>,
        usage: crate::TurnUsage,
    ) -> Vec<HarnessEvent> {
        let turn = std::mem::take(&mut self.turn);
        self.settled = true;
        self.texts.clear();
        let mut events = Vec::new();
        // The turn's usage sums every model call in it, so it only stands in
        // for the context reading when no step gave a live one.
        if usage.is_reported() && !turn.context_seen {
            events.push(HarnessEvent::ContextUpdate {
                context_tokens: usage.total_tokens(),
                context_window: usage.context_window,
            });
        }
        events.push(HarnessEvent::TurnEnded {
            result,
            is_error,
            duration_ms: duration_ms.unwrap_or_else(|| {
                turn.started
                    .map(|s| s.elapsed().as_millis().min(u128::from(u64::MAX)) as u64)
                    .unwrap_or(0)
            }),
            // The CLI reports tokens, not money.
            cost_usd: 0.0,
            usage,
        });
        events
    }

    fn translate_init(&mut self, value: &Value) -> Vec<HarnessEvent> {
        if let Some(id) = value.get("conversation_id").and_then(Value::as_str) {
            self.conversation = Some(id.to_string());
        }
        self.init_model = value
            .get("init")
            .and_then(|init| init.get("model"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(tools) = value
            .get("init")
            .and_then(|init| init.get("tools"))
            .and_then(Value::as_array)
        {
            self.tools = tools
                .iter()
                .filter_map(|tool| {
                    tool.as_str()
                        .or_else(|| tool.get("name").and_then(Value::as_str))
                        .map(str::to_string)
                })
                .collect();
        }
        Vec::new()
    }

    fn translate_step(&mut self, step: &Value) -> Vec<HarnessEvent> {
        let index = step.get("step_index").and_then(Value::as_u64).unwrap_or(0);
        let state = match step.get("state").and_then(Value::as_str) {
            Some(state) if state.eq_ignore_ascii_case("done") => StepState::Done,
            // A tool the CLI refused or that failed ends in `ERROR`, never `DONE`.
            Some(state) if state.eq_ignore_ascii_case("error") => StepState::Error,
            _ => StepState::Active,
        };
        let done = state != StepState::Active;
        let kind = step
            .get("step_type")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let delta = step.get("text_delta").and_then(Value::as_str).unwrap_or("");

        // The prompt echoed back: already in the transcript.
        if kind == "user_input" {
            return Vec::new();
        }
        if kind == "agent_response" {
            return self.translate_response(index, done, delta, step.get("usage"));
        }
        if kind.contains("think") || kind.contains("reason") {
            return if delta.is_empty() {
                Vec::new()
            } else {
                vec![HarnessEvent::ThinkingDelta {
                    text: delta.to_string(),
                }]
            };
        }
        if kind.contains("error") {
            self.turn.failed = true;
            let message = if delta.is_empty() {
                step.get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Antigravity reported an error")
            } else {
                delta
            };
            return vec![HarnessEvent::Error {
                message: message.to_string(),
            }];
        }
        // Anything else carrying a `tool_info` is a tool call; a step type
        // that is neither (a checkpoint, say) contributes nothing.
        match step.get("tool_info") {
            Some(info) if info.is_object() => self.translate_tool(index, state, &kind, info),
            _ => Vec::new(),
        }
    }

    fn translate_response(
        &mut self,
        index: u64,
        done: bool,
        delta: &str,
        usage: Option<&Value>,
    ) -> Vec<HarnessEvent> {
        let mut events = Vec::new();
        if !delta.is_empty() {
            self.texts.entry(index).or_default().push_str(delta);
            events.push(HarnessEvent::AssistantDelta {
                text: delta.to_string(),
            });
        }
        if done {
            // The step's own usage is one model call: its prompt *is* the
            // conversation so far, which is what the context meter shows.
            // (The closing `result` sums every call, and would read as several
            // windows' worth after one multi-step turn.)
            let step_usage = usage.map(turn_usage).unwrap_or_default();
            if step_usage.is_reported() {
                self.turn.context_seen = true;
                events.push(HarnessEvent::ContextUpdate {
                    context_tokens: step_usage.total_tokens(),
                    context_window: 0,
                });
            }
            // Settled text drops the newline the CLI closes every reply with.
            let text = self.texts.remove(&index).unwrap_or_default();
            let text = text.trim_end();
            if !text.is_empty() {
                self.turn.spoke = true;
                events.push(HarnessEvent::AssistantMessage {
                    text: text.to_string(),
                });
            }
        }
        events
    }

    fn translate_tool(
        &mut self,
        index: u64,
        state: StepState,
        kind: &str,
        info: &Value,
    ) -> Vec<HarnessEvent> {
        let id =
            string_field(info, &["id", "tool_call_id"]).unwrap_or_else(|| format!("step-{index}"));
        let raw_name = string_field(info, &["name", "tool_name", "canonical_name"])
            .unwrap_or_else(|| kind.to_string());
        let raw_input = ["parameters", "params", "args", "input"]
            .iter()
            .find_map(|key| info.get(*key))
            .cloned()
            .unwrap_or(Value::Null);
        let (name, input) = normalize_tool_call(&raw_name, raw_input);
        self.last_tool = Some((id.clone(), name.clone(), input.clone()));

        let mut events = Vec::new();
        if self.seen_tools.insert(id.clone()) {
            events.push(HarnessEvent::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            });
        }
        if state == StepState::Active {
            return events;
        }
        // A refusal hasn't failed — nothing ran, and the permission table
        // below is the actual UI for it. A red "denied" card under every
        // request would read as an accusation.
        let denied = is_permission_denial(info);
        events.push(HarnessEvent::ToolResult {
            id: id.clone(),
            output: if denied {
                "Waiting for approval — nothing ran yet.".to_string()
            } else {
                tool_output(info)
            },
            is_error: !denied && (state == StepState::Error || tool_failed(info)),
        });
        if denied && self.requests.insert(id.clone()) {
            events.push(permission_request(id, name, input));
        }
        events
    }

    fn translate_result(&mut self, value: &Value) -> Vec<HarnessEvent> {
        let result = value.get("result").unwrap_or(&Value::Null);
        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let response = result.get("response").and_then(Value::as_str).unwrap_or("");
        let failed = self.turn.failed
            || ["error", "fail", "cancel", "timeout", "abort"]
                .iter()
                .any(|word| status.contains(word));
        let usage = result.get("usage").map(turn_usage).unwrap_or_default();
        let duration_ms = result
            .get("duration_seconds")
            .and_then(Value::as_f64)
            .map(|seconds| (seconds * 1000.0).round().max(0.0) as u64);

        let mut events = Vec::new();
        // The CLI also lists what it refused. Usually a tool step already said
        // so; when one only finished quietly (`--sandbox` does this), the
        // request is raised here, against the last call, so the refusal is
        // never just an empty reply.
        let refused = result
            .get("denied_actions")
            .and_then(Value::as_array)
            .is_some_and(|actions| !actions.is_empty());
        if refused && self.requests.is_empty() {
            if let Some((id, name, input)) = self.last_tool.clone() {
                self.requests.insert(id.clone());
                events.push(permission_request(id, name, input));
            }
        }
        // A turn whose steps never carried the reply still has it here.
        if !failed && !self.turn.spoke && !response.is_empty() {
            events.push(HarnessEvent::AssistantMessage {
                text: response.to_string(),
            });
        }
        let message = if failed && !self.turn.failed {
            // A failed turn that raised no error step of its own: say what
            // the CLI said about it.
            Some(if response.is_empty() {
                format!("Antigravity ended the turn with status `{status}`.")
            } else {
                response.to_string()
            })
        } else {
            None
        };
        events.extend(self.settle(message, failed, duration_ms, usage));
        events
    }
}

/// The token accounting of a `result`. Thinking tokens are output the model
/// produced, so they count with the reply rather than vanishing.
fn turn_usage(usage: &Value) -> crate::TurnUsage {
    let count = |key: &str| usage.get(key).and_then(Value::as_u64).unwrap_or(0);
    crate::TurnUsage {
        input_tokens: count("input_tokens"),
        output_tokens: count("output_tokens").saturating_add(count("thinking_tokens")),
        cache_read_tokens: count("cache_read_tokens"),
        ..Default::default()
    }
}

/// Where a step is in its life. `Error` is terminal like `Done`, and is how a
/// refused or failed tool ends.
#[derive(Clone, Copy, PartialEq, Eq)]
enum StepState {
    Active,
    Done,
    Error,
}

/// The CLI's tools are snake_case with PascalCase parameters
/// (`view_file { AbsolutePath }`); converge the ones whose shape was captured
/// onto the vocabulary the tool cards already speak, rather than teaching the
/// frontend another dialect. The wire omits file contents (a write reports
/// only its `TargetFile`), so edits show a path and no diff. Anything not
/// listed keeps its own name and arguments.
fn normalize_tool_call(name: &str, input: Value) -> (String, Value) {
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    match name {
        "view_file" => (
            "Read".to_string(),
            serde_json::json!({ "file_path": text("AbsolutePath") }),
        ),
        "write_to_file" => (
            "Write".to_string(),
            serde_json::json!({ "file_path": text("TargetFile") }),
        ),
        "replace_file_content" | "multi_replace_file_content" => (
            "Edit".to_string(),
            serde_json::json!({ "file_path": text("TargetFile") }),
        ),
        "run_command" => (
            "Bash".to_string(),
            serde_json::json!({ "command": text("CommandLine") }),
        ),
        _ => (name.to_string(), input),
    }
}

/// A tool's error text: the CLI sends `{ "type": …, "message": … }`, though a
/// bare string is read too.
fn error_message(info: &Value) -> Option<String> {
    let error = info.get("error")?;
    error
        .get("message")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Whether a tool failed because print mode refused it rather than because it
/// broke. Measured wording: `permission check failed for unsandboxed "echo
/// hi": user denied permission to run command…`.
fn is_permission_denial(info: &Value) -> bool {
    error_message(info).is_some_and(|message| {
        let lower = message.to_lowercase();
        lower.contains("permission") && (lower.contains("denied") || lower.contains("check failed"))
    })
}

fn permission_request(id: String, name: String, input: Value) -> HarnessEvent {
    let (patterns, always_patterns) = crate::permission_patterns(&name, &input);
    HarnessEvent::PermissionRequest {
        request_id: id,
        tool_name: name,
        input,
        patterns,
        always_patterns,
        // The CLI offers no rules of its own: "always" can only mean
        // `--dangerously-skip-permissions` from now on.
        suggestions: Vec::new(),
        description: None,
        blocked_path: None,
    }
}

fn string_field(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// What the card shows: the tool's output — with the CRLFs a shell's terminal
/// writes turned back into newlines — or, when it printed none, why it failed.
fn tool_output(info: &Value) -> String {
    let output = match info.get("output").or_else(|| info.get("result")) {
        Some(Value::String(text)) => text.replace("\r\n", "\n"),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    };
    if output.is_empty() {
        error_message(info).unwrap_or_default()
    } else {
        output
    }
}

fn tool_failed(info: &Value) -> bool {
    info.get("is_error")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        || info
            .get("error")
            .is_some_and(|error| !error.is_null() && error.as_str() != Some(""))
}

impl TurnTranslator for AntigravityTranslator {
    fn build(&mut self, text: &str, images: &[PathBuf]) -> TurnRequest {
        let mut args = vec!["--output-format".to_string(), "stream-json".to_string()];
        if let Some(conversation) = &self.conversation {
            args.push("--conversation".to_string());
            args.push(conversation.clone());
        }
        // On a resume too: a session switched onto another model mid-
        // conversation is resumed on purpose to change exactly that.
        if let Some(model) = &self.model {
            args.push("--model".to_string());
            args.push(model.clone());
        }
        // A denied turn the user just approved is retried with everything
        // approved, once; the mode takes over again afterwards.
        if self.approve_next.swap(false, Ordering::SeqCst) {
            args.push("--dangerously-skip-permissions".to_string());
        } else {
            let mode = self.mode.lock().map(|guard| *guard).unwrap_or_default();
            args.extend(mode_args(mode));
        }

        // `agy` has no system-prompt flag, so the project fact travels in the
        // prompt itself on every turn. It has no image flag either: a path
        // mentioned with `@` is how its own prompt attaches a file.
        let mut prompt = crate::wrap_turn_with_project(&self.project_name, &self.cwd, text);
        for image in images {
            prompt.push_str(&format!("\n@{}", image.display()));
        }
        // Attached to the flag, never detached — see the module doc.
        args.push(format!("--print={prompt}"));

        self.turn = TurnAcc {
            started: Some(Instant::now()),
            ..TurnAcc::default()
        };
        self.seen_tools.clear();
        self.requests.clear();
        self.last_tool = None;
        self.texts.clear();
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
                log::debug!("antigravity unparsed line: {line} ({error})");
                return Vec::new();
            }
        };
        match value.get("event").and_then(Value::as_str) {
            Some("init") => self.translate_init(&value),
            Some("step_update") => match value.get("step_update") {
                Some(step) => self.translate_step(step),
                None => Vec::new(),
            },
            Some("result") => self.translate_result(&value),
            _ => Vec::new(),
        }
    }

    fn end_turn(
        &mut self,
        interrupted: bool,
        exit: Option<i32>,
        stderr: Option<&str>,
    ) -> Vec<HarnessEvent> {
        // A turn `result` already settled: the process winding down afterwards
        // is not news — and neither is an interrupt or a shutdown that lands
        // while it does, which has no turn left to interrupt. Only a bad exit
        // still is.
        if self.settled && exit.unwrap_or(0) == 0 {
            return Vec::new();
        }
        let usage = crate::TurnUsage::default();
        if interrupted {
            self.settle(Some("Interrupted.".to_string()), true, None, usage)
        } else if let Some(code) = exit.filter(|code| *code != 0) {
            // stdout says nothing when the CLI fails before the turn starts —
            // a conversation that no longer exists, a login that lapsed.
            // stderr says why.
            let message = crate::runner::exit_message("agy", code, stderr);
            self.settle(Some(message), true, None, usage)
        } else if self.turn.failed {
            // Already surfaced as an error notice mid-turn; settle quietly.
            self.settle(None, true, None, usage)
        } else {
            self.settle(None, false, None, usage)
        }
    }

    fn take_ready(&mut self) -> Option<HarnessEvent> {
        if self.ready_sent {
            return None;
        }
        let session_id = self.conversation.clone()?;
        self.ready_sent = true;
        Some(HarnessEvent::Ready {
            session_id,
            model: self.model.clone().or_else(|| self.init_model.clone()),
            cwd: Some(self.cwd.clone()),
            tools: self.tools.clone(),
        })
    }

    fn session_id(&self) -> Option<SessionId> {
        self.conversation.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn translator() -> AntigravityTranslator {
        AntigravityTranslator {
            program: PathBuf::from("agy"),
            cwd: PathBuf::from("/tmp/Arka"),
            project_name: "Arka".to_string(),
            model: Some("gemini-3.1-pro-high".into()),
            conversation: None,
            mode: Arc::new(Mutex::new(PermissionMode::Auto)),
            approve_next: Arc::new(AtomicBool::new(false)),
            tools: Vec::new(),
            init_model: None,
            ready_sent: false,
            turn: TurnAcc::default(),
            seen_tools: HashSet::new(),
            requests: HashSet::new(),
            last_tool: None,
            texts: HashMap::new(),
            settled: false,
        }
    }

    fn step(index: u64, state: &str, kind: &str, delta: &str) -> String {
        serde_json::json!({
            "event": "step_update",
            "step_update": {
                "step_index": index, "state": state,
                "step_type": kind, "text_delta": delta,
            },
        })
        .to_string()
    }

    fn arg_after<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        let at = args.iter().position(|a| a == flag)?;
        args.get(at + 1).map(String::as_str)
    }

    #[test]
    fn the_prompt_is_attached_to_the_flag() {
        // Detached, the CLI takes the prompt as the flag's value and drops it.
        let mut t = translator();
        let req = t.build("what folder am I in", &[]);
        let prompt = req.args.last().unwrap();
        assert!(prompt.starts_with("--print="), "{prompt}");
        assert!(prompt.contains("what folder am I in"), "{prompt}");
        assert!(!req.args.iter().any(|a| a == "--print"));
        assert_eq!(arg_after(&req.args, "--output-format"), Some("stream-json"));
    }

    #[test]
    fn every_turn_carries_its_project() {
        let mut t = translator();
        let req = t.build("hi", &[]);
        let prompt = req.args.last().unwrap();
        assert!(prompt.contains("Arka"), "{prompt}");
        assert!(prompt.contains("/tmp/Arka"), "{prompt}");
    }

    #[test]
    fn build_starts_fresh_then_resumes_with_the_model_riding_along() {
        let mut t = translator();
        let first = t.build("hi", &[]);
        assert!(!first.args.iter().any(|a| a == "--conversation"));
        assert_eq!(
            arg_after(&first.args, "--model"),
            Some("gemini-3.1-pro-high")
        );

        t.conversation = Some("conv-1".into());
        let second = t.build("again", &[]);
        assert_eq!(arg_after(&second.args, "--conversation"), Some("conv-1"));
        assert_eq!(
            arg_after(&second.args, "--model"),
            Some("gemini-3.1-pro-high")
        );
    }

    #[test]
    fn the_default_model_passes_no_flag() {
        let mut t = translator();
        t.model = None;
        assert!(!t.build("hi", &[]).args.iter().any(|a| a == "--model"));
    }

    #[test]
    fn modes_map_onto_the_clis_own() {
        let flags = |mode| {
            let mut t = translator();
            *t.mode.lock().unwrap() = mode;
            t.build("hi", &[]).args
        };
        assert_eq!(
            arg_after(&flags(PermissionMode::Plan), "--mode"),
            Some("plan")
        );
        assert_eq!(
            arg_after(&flags(PermissionMode::Auto), "--mode"),
            Some("accept-edits")
        );
        assert_eq!(
            arg_after(&flags(PermissionMode::AcceptEdits), "--mode"),
            Some("accept-edits")
        );
        // Manual has nobody to ask: the default mode is the one that denies.
        let manual = flags(PermissionMode::Manual);
        assert!(!manual.iter().any(|a| a == "--mode"));
        assert!(!manual.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(
            flags(PermissionMode::BypassPermissions)
                .iter()
                .any(|a| a == "--dangerously-skip-permissions")
        );
    }

    #[test]
    fn images_are_mentioned_in_the_prompt() {
        let mut t = translator();
        let req = t.build("look", &[PathBuf::from("/tmp/shot.png")]);
        assert!(req.args.last().unwrap().contains("@/tmp/shot.png"));
    }

    #[test]
    fn init_arms_ready_once_with_the_conversation() {
        let mut t = translator();
        assert!(
            t.push_line(
                r#"{"event":"init","conversation_id":"c-9","init":{"cwd":"/tmp","tools":["view_file","run_command"],"permission_mode":"default"}}"#
            )
            .is_empty()
        );
        assert_eq!(t.session_id().as_deref(), Some("c-9"));
        match t.take_ready() {
            Some(HarnessEvent::Ready {
                session_id, tools, ..
            }) => {
                assert_eq!(session_id, "c-9");
                assert_eq!(tools, vec!["view_file", "run_command"]);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(t.take_ready().is_none());
    }

    #[test]
    fn the_echoed_prompt_is_not_a_second_user_message() {
        let mut t = translator();
        assert!(
            t.push_line(&step(0, "DONE", "user_input", "hello"))
                .is_empty()
        );
    }

    #[test]
    fn a_reply_streams_then_settles_as_one_message() {
        let mut t = translator();
        t.build("hi", &[]);
        let mut events = t.push_line(&step(1, "ACTIVE", "agent_response", "Hel"));
        events.extend(t.push_line(&step(1, "ACTIVE", "agent_response", "lo")));
        events.extend(t.push_line(&step(1, "DONE", "agent_response", "")));
        assert!(matches!(&events[0], HarnessEvent::AssistantDelta { text } if text == "Hel"));
        assert!(matches!(&events[1], HarnessEvent::AssistantDelta { text } if text == "lo"));
        assert!(matches!(&events[2], HarnessEvent::AssistantMessage { text } if text == "Hello"));
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn the_result_settles_the_turn_with_its_accounting() {
        let mut t = translator();
        t.build("hi", &[]);
        t.push_line(&step(1, "ACTIVE", "agent_response", "Hello"));
        t.push_line(&step(1, "DONE", "agent_response", ""));
        let events = t.push_line(
            r#"{"event":"result","result":{"status":"success","response":"Hello","duration_seconds":2.5,"num_turns":1,"usage":{"input_tokens":100,"output_tokens":20,"thinking_tokens":30,"cache_read_tokens":400,"total_tokens":550}}}"#,
        );
        // The reply already reached the transcript, so `response` adds nothing.
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, HarnessEvent::AssistantMessage { .. }))
        );
        match events.last() {
            Some(HarnessEvent::TurnEnded {
                is_error,
                duration_ms,
                usage,
                ..
            }) => {
                assert!(!is_error);
                assert_eq!(*duration_ms, 2500);
                assert_eq!(usage.input_tokens, 100);
                assert_eq!(usage.output_tokens, 50);
                assert_eq!(usage.cache_read_tokens, 400);
            }
            other => panic!("unexpected {other:?}"),
        }
        // The process exiting afterwards is not a second turn ending.
        assert!(t.end_turn(false, Some(0), None).is_empty());
    }

    #[test]
    fn a_reply_only_in_the_result_still_reaches_the_transcript() {
        let mut t = translator();
        t.build("hi", &[]);
        let events = t.push_line(
            r#"{"event":"result","result":{"status":"success","response":"Only here"}}"#,
        );
        assert!(
            matches!(&events[0], HarnessEvent::AssistantMessage { text } if text == "Only here")
        );
    }

    #[test]
    fn a_failed_result_is_an_error_turn_saying_why() {
        let mut t = translator();
        t.build("hi", &[]);
        let events = t.push_line(
            r#"{"event":"result","result":{"status":"error","response":"quota exhausted"}}"#,
        );
        match events.last() {
            Some(HarnessEvent::TurnEnded {
                is_error, result, ..
            }) => {
                assert!(is_error);
                assert_eq!(result.as_deref(), Some("quota exhausted"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// Lines captured from `agy 1.x` (see the module doc): a file read.
    const VIEW_ACTIVE: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"view_file","tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/p/note.txt"}}}}"#;
    const VIEW_DONE: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"view_file","duration_seconds":0.007,"tool_info":{"name":"view_file","parameters":{"AbsolutePath":"/tmp/p/note.txt"},"output":"2 lines, 27 bytes"}}}"#;
    /// …and a shell command refused under `--mode accept-edits`.
    const RUN_ACTIVE: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}"#;
    const RUN_DENIED: &str = r#"{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"ERROR","step_type":"tool","tool_name":"run_command","duration_seconds":0.09,"tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"},"error":{"type":"TOOL_ERROR","message":"permission check failed for unsandboxed \"echo hi\": user denied permission to run command:\necho hi\nDo not attempt to circumvent this denial"}}}}"#;
    const RESULT_DENIED: &str = r#"{"event":"result","result":{"conversation_id":"c","status":"SUCCESS","response":"","duration_seconds":3.1,"num_turns":1,"usage":{"input_tokens":11988,"output_tokens":113,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":12101},"denied_actions":[{"action":"command","display_name":"RunCommand"}]}}"#;

    #[test]
    fn a_file_read_is_a_read_call_then_its_result() {
        let mut t = translator();
        t.build("hi", &[]);
        let mut events = t.push_line(VIEW_ACTIVE);
        events.extend(t.push_line(VIEW_DONE));
        assert_eq!(events.len(), 2, "one call, one result: {events:?}");
        match (&events[0], &events[1]) {
            (
                HarnessEvent::ToolUse { id, name, input },
                HarnessEvent::ToolResult {
                    id: result_id,
                    output,
                    is_error,
                },
            ) => {
                assert_eq!(id, "step-2");
                assert_eq!(result_id, id);
                // The cards already know `Read { file_path }`.
                assert_eq!(name, "Read");
                assert_eq!(input["file_path"], "/tmp/p/note.txt");
                assert_eq!(output, "2 lines, 27 bytes");
                assert!(!is_error);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn the_known_tools_speak_the_cards_vocabulary() {
        let (name, input) = normalize_tool_call(
            "run_command",
            serde_json::json!({ "CommandLine": "ls -la" }),
        );
        assert_eq!(
            (name.as_str(), input["command"].as_str()),
            ("Bash", Some("ls -la"))
        );
        let (name, input) = normalize_tool_call(
            "write_to_file",
            serde_json::json!({ "TargetFile": "/tmp/out.txt" }),
        );
        assert_eq!(
            (name.as_str(), input["file_path"].as_str()),
            ("Write", Some("/tmp/out.txt"))
        );
        let (name, _) = normalize_tool_call(
            "replace_file_content",
            serde_json::json!({ "TargetFile": "/tmp/out.txt" }),
        );
        assert_eq!(name, "Edit");
        // One nobody captured keeps its own name and arguments.
        let (name, input) =
            normalize_tool_call("search_web", serde_json::json!({ "query": "rust" }));
        assert_eq!(
            (name.as_str(), input["query"].as_str()),
            ("search_web", Some("rust"))
        );
    }

    #[test]
    fn shell_output_loses_its_terminal_line_endings() {
        let info = serde_json::json!({ "output": "./out.txt\r\n./note.txt\r\n" });
        assert_eq!(tool_output(&info), "./out.txt\n./note.txt\n");
    }

    #[test]
    fn a_refused_command_becomes_a_permission_request_not_a_red_card() {
        let mut t = translator();
        t.build("run it", &[]);
        let mut events = t.push_line(RUN_ACTIVE);
        events.extend(t.push_line(RUN_DENIED));
        // ToolUse, a neutral ToolResult, and the request — in that order.
        assert!(matches!(&events[0], HarnessEvent::ToolUse { name, .. } if name == "Bash"));
        match &events[1] {
            HarnessEvent::ToolResult {
                output, is_error, ..
            } => {
                assert!(!is_error, "a refusal is not a failure");
                assert!(output.contains("Waiting for approval"), "{output}");
            }
            other => panic!("unexpected {other:?}"),
        }
        match &events[2] {
            HarnessEvent::PermissionRequest {
                request_id,
                tool_name,
                input,
                patterns,
                ..
            } => {
                assert_eq!(request_id, "step-2");
                assert_eq!(tool_name, "Bash");
                assert_eq!(input["command"], "echo hi");
                assert_eq!(patterns, &vec!["echo hi".to_string()]);
            }
            other => panic!("unexpected {other:?}"),
        }
        // The result then lists the same refusal: no second request.
        let end = t.push_line(RESULT_DENIED);
        assert!(
            !end.iter()
                .any(|e| matches!(e, HarnessEvent::PermissionRequest { .. }))
        );
        assert!(matches!(
            end.last(),
            Some(HarnessEvent::TurnEnded {
                is_error: false,
                ..
            })
        ));
    }

    #[test]
    fn a_refusal_only_the_result_reports_is_still_raised() {
        // `--sandbox` finished the step quietly (no `ERROR`) and left the
        // refusal to `denied_actions`; the last call is what it was about.
        let mut t = translator();
        t.build("run it", &[]);
        t.push_line(RUN_ACTIVE);
        let done = RUN_ACTIVE.replace("ACTIVE", "DONE");
        t.push_line(&done);
        let end = t.push_line(RESULT_DENIED);
        assert!(
            end.iter().any(|e| matches!(
                e,
                HarnessEvent::PermissionRequest { tool_name, .. } if tool_name == "Bash"
            )),
            "{end:?}"
        );
    }

    #[test]
    fn an_ordinary_tool_failure_is_a_red_card() {
        let mut t = translator();
        t.build("hi", &[]);
        let failed = serde_json::json!({"event":"step_update","step_update":{
            "step_index": 5, "state": "ERROR", "step_type": "tool",
            "tool_info": {"name": "view_file", "parameters": {"AbsolutePath": "/nope"},
                          "error": {"type": "TOOL_ERROR", "message": "no such file"}}
        }})
        .to_string();
        let events = t.push_line(&failed);
        assert_eq!(events.len(), 2, "{events:?}");
        match &events[1] {
            HarnessEvent::ToolResult {
                output, is_error, ..
            } => {
                assert!(is_error);
                assert_eq!(output, "no such file");
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn allow_once_retries_with_everything_approved_for_one_turn_only() {
        let mut t = translator();
        let plain = t.build("hi", &[]).args;
        assert_eq!(arg_after(&plain, "--mode"), Some("accept-edits"));
        assert!(!plain.iter().any(|a| a == "--dangerously-skip-permissions"));

        t.approve_next.store(true, Ordering::SeqCst);
        let retry = t.build("hi", &[]).args;
        assert!(retry.iter().any(|a| a == "--dangerously-skip-permissions"));
        assert!(!retry.iter().any(|a| a == "--mode"));

        // The turn after that is back on the session's own mode.
        let after = t.build("hi", &[]).args;
        assert_eq!(arg_after(&after, "--mode"), Some("accept-edits"));
    }

    #[test]
    fn the_context_reading_is_the_last_call_not_the_turns_sum() {
        // Captured: a tool turn whose two model calls moved 11,907 and 12,259
        // prompt tokens; the result sums them to 24,166.
        let mut t = translator();
        t.build("read it", &[]);
        let first = r#"{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":11907,"output_tokens":103,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":12010}}}"#;
        let second = r#"{"event":"step_update","step_update":{"step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{"input_tokens":12259,"output_tokens":83,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":12342}}}"#;
        let result = r#"{"event":"result","result":{"status":"SUCCESS","response":"x\n","duration_seconds":6.0,"usage":{"input_tokens":24166,"output_tokens":186,"thinking_tokens":0,"cache_read_tokens":0,"total_tokens":24352}}}"#;
        let mut events = t.push_line(first);
        events.extend(t.push_line(second));
        events.extend(t.push_line(result));
        let readings: Vec<u64> = events
            .iter()
            .filter_map(|e| match e {
                HarnessEvent::ContextUpdate { context_tokens, .. } => Some(*context_tokens),
                _ => None,
            })
            .collect();
        assert_eq!(readings, vec![12010, 12342], "never the 24,352 sum");
        // The turn itself still reports what it moved in total.
        match events.last() {
            Some(HarnessEvent::TurnEnded { usage, .. }) => assert_eq!(usage.input_tokens, 24166),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn the_newline_the_cli_closes_a_reply_with_is_dropped() {
        let mut t = translator();
        t.build("hi", &[]);
        t.push_line(&step(3, "ACTIVE", "agent_response", "It is pelican."));
        let events = t.push_line(&step(3, "DONE", "agent_response", "\n"));
        assert!(matches!(
            events.last(),
            Some(HarnessEvent::AssistantMessage { text }) if text == "It is pelican."
        ));
    }

    #[test]
    fn a_reply_with_only_a_newline_adds_nothing() {
        // The empty `agent_response` before a tool call carries usage, no text.
        let mut t = translator();
        t.build("hi", &[]);
        let events = t.push_line(&step(1, "DONE", "agent_response", "\n"));
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, HarnessEvent::AssistantMessage { .. }))
        );
    }

    #[test]
    fn a_bad_exit_says_what_stderr_said() {
        let mut t = translator();
        t.build("hi", &[]);
        let events = t.end_turn(false, Some(1), Some("Print mode: auth error"));
        match events.last() {
            Some(HarnessEvent::TurnEnded {
                is_error, result, ..
            }) => {
                assert!(is_error);
                assert_eq!(
                    result.as_deref(),
                    Some("agy exited with status 1:\nPrint mode: auth error")
                );
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_interrupt_settles_as_interrupted() {
        let mut t = translator();
        t.build("hi", &[]);
        match t.end_turn(true, None, None).last() {
            Some(HarnessEvent::TurnEnded {
                is_error, result, ..
            }) => {
                assert!(is_error);
                assert_eq!(result.as_deref(), Some("Interrupted."));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn an_interrupt_after_the_result_adds_nothing() {
        let mut t = translator();
        t.build("hi", &[]);
        t.push_line(r#"{"event":"result","result":{"status":"SUCCESS","response":"x"}}"#);
        assert!(t.end_turn(true, None, None).is_empty());
    }

    #[test]
    fn unparseable_lines_contribute_nothing() {
        let mut t = translator();
        assert!(t.push_line("not json at all").is_empty());
        assert!(t.push_line(r#"{"event":"something_new"}"#).is_empty());
    }

    /// The whole harness through the runner, against a stand-in CLI that
    /// answers the way `agy` does — plus, `#[ignore]`d, against the real one.
    #[cfg(unix)]
    mod live {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        fn sandbox(name: &str) -> PathBuf {
            let dir = std::env::temp_dir()
                .join(format!("egant-antigravity-{name}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            dir
        }

        /// A CLI that records its argv, one run per line, and prints a short
        /// captured-shape turn.
        fn fake_cli(dir: &Path) -> PathBuf {
            let script = dir.join("fake-agy");
            let log = dir.join("argv.log");
            let body = format!(
                "#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{log}'\n{turn}\n",
                log = log.display(),
                turn = r#"printf '%s\n' '{"event":"init","conversation_id":"conv-7","init":{"model":"m","tools":["view_file"]}}' '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"yo"}}' '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"\n","usage":{"input_tokens":5,"output_tokens":2}}}' '{"event":"result","result":{"status":"SUCCESS","response":"yo\n","duration_seconds":0.5,"usage":{"input_tokens":5,"output_tokens":2}}}'"#,
            );
            std::fs::write(&script, body).unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
            script
        }

        async fn until(
            rx: &Receiver<HarnessEvent>,
            mut f: impl FnMut(&HarnessEvent) -> bool,
        ) -> Vec<String> {
            let mut kinds = Vec::new();
            while let Ok(event) = rx.recv().await {
                kinds.push(
                    match &event {
                        HarnessEvent::Ready { .. } => "ready",
                        HarnessEvent::AssistantDelta { .. } => "delta",
                        HarnessEvent::AssistantMessage { .. } => "msg",
                        HarnessEvent::ContextUpdate { .. } => "ctx",
                        HarnessEvent::TurnEnded { .. } => "end",
                        HarnessEvent::Exited { .. } => "exited",
                        _ => "other",
                    }
                    .to_string(),
                );
                if f(&event) {
                    break;
                }
            }
            kinds
        }

        #[test]
        fn a_turn_settles_and_the_next_one_resumes_the_conversation() {
            let dir = sandbox("turns");
            let script = fake_cli(&dir);
            futures_lite::future::block_on(async {
                let mut h = AntigravityRun::spawn(AntigravityOptions {
                    program: script,
                    cwd: dir.clone(),
                    model: Some("gemini-3.8-flash-low".into()),
                    ..AntigravityOptions::default()
                })
                .unwrap();
                let rx = h.events();

                h.send("hi".into(), vec![]).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["ready", "delta", "delta", "ctx", "msg", "end"]);
                assert_eq!(h.session_id().as_deref(), Some("conv-7"));

                // A second turn continues it: no second Ready.
                h.send("again".into(), vec![]).await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::TurnEnded { .. })).await;
                assert_eq!(kinds, ["delta", "delta", "ctx", "msg", "end"]);

                h.shutdown().await.unwrap();
                let kinds = until(&rx, |e| matches!(e, HarnessEvent::Exited { .. })).await;
                assert_eq!(kinds, ["exited"]);

                let argv = std::fs::read_to_string(dir.join("argv.log")).unwrap();
                // A prompt spans lines, so a run is what starts at its first flag.
                let runs: Vec<&str> = argv
                    .split("--output-format")
                    .filter(|run| !run.trim().is_empty())
                    .collect();
                assert_eq!(runs.len(), 2, "one process per turn: {argv}");
                assert!(!runs[0].contains("--conversation"), "{}", runs[0]);
                assert!(runs[1].contains("--conversation conv-7"), "{}", runs[1]);
                assert!(
                    runs[1].contains("--model gemini-3.8-flash-low"),
                    "{}",
                    runs[1]
                );
                assert!(runs[1].contains("--print="), "{}", runs[1]);
            });
        }

        /// Against the real `agy`: costs two short model calls, so it only
        /// runs when asked (`cargo test -- --ignored real_agy`).
        #[test]
        #[ignore = "spends real model calls"]
        fn real_agy_remembers_across_turns() {
            let dir = sandbox("real");
            futures_lite::future::block_on(async {
                let mut h = AntigravityRun::spawn(AntigravityOptions {
                    cwd: dir,
                    model: Some("gemini-3.8-flash-low".into()),
                    ..AntigravityOptions::default()
                })
                .unwrap();
                let rx = h.events();
                h.send(
                    "Remember the word 'quokka'. Reply with just: ok".into(),
                    vec![],
                )
                .await
                .unwrap();
                let mut first = String::new();
                while let Ok(event) = rx.recv().await {
                    match event {
                        HarnessEvent::AssistantMessage { text } => first = text,
                        HarnessEvent::TurnEnded {
                            is_error, result, ..
                        } => {
                            assert!(!is_error, "{result:?}");
                            break;
                        }
                        _ => {}
                    }
                }
                assert!(!first.is_empty(), "the first turn answered");

                h.send(
                    "What word did I ask you to remember? One word.".into(),
                    vec![],
                )
                .await
                .unwrap();
                let mut second = String::new();
                while let Ok(event) = rx.recv().await {
                    match event {
                        HarnessEvent::AssistantMessage { text } => second = text,
                        HarnessEvent::TurnEnded {
                            is_error, result, ..
                        } => {
                            assert!(!is_error, "{result:?}");
                            break;
                        }
                        _ => {}
                    }
                }
                assert!(second.to_lowercase().contains("quokka"), "{second:?}");
                h.shutdown().await.unwrap();
            });
        }
    }
}
