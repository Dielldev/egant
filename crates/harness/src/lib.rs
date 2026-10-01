//! The agent-backend abstraction.
//!
//! Everything the UI knows about a running agent goes through [`Harness`]. One
//! implementation ships today — [`claude::ClaudeCode`], which drives the
//! `claude` CLI as a subprocess over its `stream-json` protocol. A second
//! backend (Codex over JSON-RPC, say) should need no UI changes: it emits the
//! same [`HarnessEvent`] stream.
//!
//! The split is deliberate. [`protocol`] holds vendor-specific wire types;
//! [`HarnessEvent`] is the vendor-neutral vocabulary the app renders.

pub mod agents;
pub mod catalog;
pub mod claude;
pub mod codex;
pub mod models;
pub mod opencode;
pub mod protocol;
pub mod runner;
pub mod titles;
pub mod transcript;
pub mod usage_limits;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

pub use agents::{AgentId, AgentStatus, detect_agents};
pub use catalog::{CatalogStatus, InstallOutcome, UpdateInfo};
pub use claude::{ClaudeCode, ClaudeOptions};
pub use codex::{CodexExec, CodexOptions};
pub use models::{AgentModel, is_known_model, list_models};
pub use opencode::{OpencodeOptions, OpencodeRun};
pub use transcript::{
    PendingPermission, SessionUsage, ToolCall, Transcript, TranscriptEntry, TurnState,
};

/// Now, in milliseconds since the Unix epoch — the clock a retry's countdown
/// is measured on.
pub(crate) fn unix_now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as u64)
        .unwrap_or(0)
}

/// What one turn put through the model, as the agent itself accounts for it.
///
/// Every backend that reports tokens at all reports these four. A backend that
/// reports none leaves the struct at its default, which the session's running
/// totals then skip rather than recording as a turn that cost nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct TurnUsage {
    /// Prompt tokens sent fresh, neither cached nor serving from cache.
    pub input_tokens: u64,
    pub output_tokens: u64,
    /// Prompt tokens this turn wrote into the cache.
    pub cache_creation_tokens: u64,
    /// Prompt tokens served from the cache instead of re-sent.
    pub cache_read_tokens: u64,
    /// The window this turn's model ran with, or `0` when the backend does not
    /// report one. Per-model, not a constant.
    pub context_window: u64,
}

impl TurnUsage {
    /// Every token the turn moved: the whole prompt — fresh, cache-filling and
    /// cache-served alike — plus the reply.
    ///
    /// This doubles as the conversation's occupancy of the window afterwards,
    /// because the prompt a turn sends *is* the conversation so far. Counting
    /// only `input + output` is what made the old meter read twelve tokens on
    /// a turn that had just put 25k into the window.
    pub fn total_tokens(self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_creation_tokens)
            .saturating_add(self.cache_read_tokens)
    }

    /// Whether the backend accounted for this turn at all.
    pub fn is_reported(self) -> bool {
        self.total_tokens() > 0
    }
}

/// The agent's own id for a conversation. Persisting it is what lets a session
/// be resumed later, or picked up on another device.
pub type SessionId = String;

/// What the app reacts to. Backend-neutral by design: no Claude-specific
/// wording leaks past this enum.
#[derive(Debug, Clone)]
pub enum HarnessEvent {
    /// Handshake completed; the session is live.
    Ready {
        session_id: SessionId,
        model: Option<String>,
        cwd: Option<PathBuf>,
        tools: Vec<String>,
    },
    /// A chunk of assistant text. Arrives token-by-token when the backend is
    /// configured to stream partial messages.
    AssistantDelta { text: String },
    /// A chunk of the model's reasoning, when the backend exposes it.
    ThinkingDelta { text: String },
    /// The assistant finished a message. `text` is the settled full text, which
    /// supersedes any deltas already shown.
    AssistantMessage { text: String },
    /// The agent decided to call a tool.
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    /// A tool finished.
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
    },
    /// The agent wants permission to act. The app must answer with
    /// [`Harness::respond_permission`] or the turn stalls.
    ///
    /// `patterns` names the specific resource (file path, command prefix,
    /// URL) the request is about; `always_patterns` are the wider patterns
    /// an "allow always" answer would approve for the rest of the session
    /// (what opencode's own UI offers). Wires without suggestions leave both
    /// empty — the UI then falls back to the tool name and input summary.
    ///
    /// `suggestions` are the wire's own "don't ask again" options (Claude's
    /// `permission_suggestions`), which an "always" answer hands back instead
    /// of remembering patterns — see [`always_allow_update`]. `description`
    /// and `blocked_path` say what the call does and which path made the
    /// agent ask, when the wire says either.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        input: Value,
        patterns: Vec<String>,
        always_patterns: Vec<String>,
        suggestions: Vec<Value>,
        description: Option<String>,
        blocked_path: Option<String>,
    },
    /// The agent now runs under another permission mode: it switched itself
    /// (Claude entering plan mode) or applied one that came with an answer
    /// (an approved plan switching to accept-edits). The agent's word, so it
    /// replaces whatever the host last asked for.
    ModeChanged { mode: PermissionMode },
    /// The turn ended. Carries the accounting the status bar shows.
    TurnEnded {
        result: Option<String>,
        is_error: bool,
        duration_ms: u64,
        cost_usd: f64,
        usage: TurnUsage,
    },
    /// A live reading of how full the context window is right now, in
    /// tokens, with the window it is measured against (or `0` while the
    /// backend hasn't named one). Replaces the previous reading; never
    /// accumulates. Claude emits one per main-thread assistant step, because
    /// the turn-end `usage` sums every API call in a multi-step turn and
    /// would read as several windows' worth after a single prompt. Wires
    /// that only account per turn emit one alongside `TurnEnded` instead.
    ContextUpdate {
        context_tokens: u64,
        context_window: u64,
    },
    /// What the running turn is busy with besides thinking and replying —
    /// or, with `None`, that whatever it was is over. The status line names
    /// it instead of cycling words. Transient: it is never part of the
    /// conversation, and the fold drops it as soon as the agent moves on.
    Progress { progress: Option<TurnProgress> },
    /// The agent summarized the conversation to make room in its context
    /// window: everything before this point now reaches the model only as
    /// that summary. `auto` when it did so on its own as the window filled
    /// up, rather than because it was asked to.
    ///
    /// `tokens_before` is the whole prompt the conversation last sent, and
    /// `tokens_after` what is left of the conversation itself — not the same
    /// measure, see [`protocol::CompactMetadata`].
    Compacted {
        auto: bool,
        tokens_before: u64,
        tokens_after: Option<u64>,
    },
    /// The agent answered this turn with another model than the one asked
    /// for, because that one failed (retired, overloaded, not on this plan).
    /// `message` says so in the agent's own words.
    ModelFallback {
        from: String,
        to: String,
        message: String,
    },
    /// The slash commands the agent accepts now — the whole list, replacing
    /// the last one. What the composer's `/` menu offers besides egant's own.
    Commands { commands: Vec<SlashCommand> },
    /// Something a subagent did — a tool call, its result, a settled reply —
    /// inside the tool call that launched it (Claude's `Task`). `parent` is
    /// that call's id. Folded under the call, not into the conversation:
    /// shown flat, a subagent's steps read as the main agent's own.
    Subagent {
        parent: String,
        event: Box<HarnessEvent>,
    },
    /// The backend reported a problem that did not kill the process.
    Error { message: String },
    /// The process is gone. No further events will arrive.
    Exited { code: Option<i32> },
}

/// A slash command the agent accepts (`/review`, a skill's `/pdf`), without
/// its slash. Claude names them all at the start of every turn; it describes
/// them only when the list changes mid-session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// What it takes after its name (`<file>`), when it takes anything.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argument_hint: Option<String>,
}

/// Something a running turn spends time on that isn't the model thinking or
/// replying — what the status line says instead of a rotating verb, because
/// "Pondering…" over a rate-limit wait reads as a hang.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum TurnProgress {
    /// Summarizing the conversation to make room in the context window.
    Compacting,
    /// A request failed in a way worth retrying, and the agent is waiting
    /// before it tries again. `retry_at_ms` is when the next attempt goes
    /// out (Unix time) — absolute, so every client counts down to the same
    /// moment however late it hears about it. `reason` is readable: "the API
    /// is overloaded", "connection failed".
    Retrying {
        attempt: u32,
        max_retries: u32,
        retry_at_ms: u64,
        reason: String,
    },
}

#[derive(Debug, Clone)]
pub enum PermissionDecision {
    /// Run the tool. `updated_input` rewrites the call first, if set.
    /// Must carry the original input when approving as-is: Claude Code
    /// rejects an `allow` without `updatedInput` (pre-v2.1.207 as a
    /// validation error that surfaces as a deny) and the docs still require
    /// passing the original input through. An answered question rides here
    /// too: its answers are part of the input the tool runs with.
    ///
    /// `updated_permissions` are applied along with the approval — the rule
    /// an "always allow" saves, the mode an approved plan switches to.
    Allow {
        updated_input: Option<Value>,
        updated_permissions: Vec<Value>,
    },
    /// Refuse. The agent sees `reason` and can try something else — unless
    /// `interrupt` also ends the turn.
    Deny { reason: String, interrupt: bool },
}

/// Claude's built-in tool for putting questions to the person. Its
/// "permission request" is the question itself: answering it means
/// approving with the answers added to its input.
pub const ASK_USER_QUESTION: &str = "AskUserQuestion";

/// Claude's built-in tool for handing a finished plan back for approval.
pub const EXIT_PLAN_MODE: &str = "ExitPlanMode";

/// Whether a tool's permission request is really a question for the person —
/// something only they can answer, never a remembered approval.
pub fn is_interactive_tool(tool_name: &str) -> bool {
    tool_name == ASK_USER_QUESTION || tool_name == EXIT_PLAN_MODE
}

/// The one suggestion an "always allow" answer applies: the rule the CLI
/// proposed (`Bash(git status:*)` saved to the project), else access to the
/// directory it named. Never a `setMode` — handing all of the CLI's
/// suggestions back also switches the session to accept-edits, which is a
/// decision for the mode picker, not a side effect of one approval.
pub fn always_allow_update(suggestions: &[Value]) -> Option<Value> {
    let of_type = |kind: &str| {
        suggestions
            .iter()
            .find(|s| s.get("type").and_then(Value::as_str) == Some(kind))
            .cloned()
    };
    of_type("addRules").or_else(|| of_type("addDirectories"))
}

/// How much freedom the agent has before it must ask. Names and CLI values
/// mirror `claude --permission-mode`'s own choices (`auto`, `manual`, `plan`,
/// `acceptEdits`, `bypassPermissions`) rather than an invented subset — this
/// app's mode picker is a deliberate copy of Claude Code Desktop's, so it
/// needs to offer the CLI's real modes, "Auto" and "Manual" included.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum PermissionMode {
    /// Claude judges each action itself; asks only when it decides to.
    #[default]
    Auto,
    /// Always asks before anything that writes or executes.
    Manual,
    /// Read freely, ask to write.
    Plan,
    /// Edits are pre-approved for this session.
    AcceptEdits,
    /// Ask for nothing. Only safe inside a throwaway worktree or container.
    BypassPermissions,
}

impl PermissionMode {
    pub fn as_cli_arg(self) -> &'static str {
        match self {
            PermissionMode::Auto => "auto",
            PermissionMode::Manual => "manual",
            PermissionMode::Plan => "plan",
            PermissionMode::AcceptEdits => "acceptEdits",
            PermissionMode::BypassPermissions => "bypassPermissions",
        }
    }

    /// The inverse of [`Self::as_cli_arg`], for a mode name arriving over IPC
    /// (the frontend's mode picker) rather than one this process produced.
    ///
    /// Also reads the CLI's own reports of its mode, which name `manual`
    /// by its internal name, `default`.
    pub fn from_cli_arg(name: &str) -> Option<Self> {
        match name {
            "auto" => Some(PermissionMode::Auto),
            "manual" | "default" => Some(PermissionMode::Manual),
            "plan" => Some(PermissionMode::Plan),
            "acceptEdits" => Some(PermissionMode::AcceptEdits),
            "bypassPermissions" => Some(PermissionMode::BypassPermissions),
            _ => None,
        }
    }
}

/// A live agent session.
///
/// Implementations own a subprocess and a reader task. Dropping one should stop
/// the child; [`Harness::shutdown`] does it deliberately and waits.
#[async_trait]
pub trait Harness: Send {
    /// Which backend this is, for display ("Claude Code", "Codex").
    fn backend_name(&self) -> &'static str;

    /// Which registered agent this is, for settings and session rows.
    fn agent_id(&self) -> AgentId;

    /// The agent's session id, once the handshake has landed. Persisting it is
    /// what makes a conversation resumable.
    fn session_id(&self) -> Option<SessionId>;

    /// Events from the agent. Cloneable and multi-consumer, so a session can be
    /// rendered in one pane and logged in another.
    fn events(&self) -> async_channel::Receiver<HarnessEvent>;

    /// Send a turn. `images` are paths to files already on disk (a pasted
    /// screenshot, say) — each wire attaches them the way it actually
    /// supports: a real vision content block for Claude, `-i` for Codex,
    /// `-f` for opencode. None of them get by on a bare `@path` mention.
    async fn send(&mut self, text: String, images: Vec<PathBuf>) -> anyhow::Result<()>;

    /// Stop the current turn without ending the session.
    async fn interrupt(&mut self) -> anyhow::Result<()>;

    /// Answer a [`HarnessEvent::PermissionRequest`].
    async fn respond_permission(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> anyhow::Result<()>;

    /// End the session and reap the child process.
    async fn shutdown(&mut self) -> anyhow::Result<()>;

    /// Changes how much the agent may do unattended, mid-session. Only wires
    /// that accept it implement this; the rest keep a no-op so the driver
    /// stays generic.
    async fn set_permission_mode(&mut self, _mode: PermissionMode) -> anyhow::Result<()> {
        Ok(())
    }

    /// Approves the next turn's permissions without asking (opencode's
    /// `--auto` on the next `run`). Wires with a live approval channel
    /// (Claude) ignore this: they answer per request instead.
    async fn approve_next_turn(&mut self) -> anyhow::Result<()> {
        Ok(())
    }

    /// Approves every future turn without asking (opencode's `--auto` from
    /// here on). Wires with a live approval channel ignore this.
    async fn approve_always(&mut self) -> anyhow::Result<()> {
        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum HarnessError {
    #[error("agent backend is not running")]
    NotRunning,
    #[error("could not start `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("protocol error: {0}")]
    Protocol(String),
}

// ---------------------------------------------------------------------------
// Permission patterns: what the approval table shows per request.
// ---------------------------------------------------------------------------

/// Specific + always-approve patterns for a tool call, for the permission
/// table. Mirrors what opencode's own UI suggests: the exact resource plus
/// the wider prefix an "allow always" answer would cover.
///
/// Falls back to the tool name when the input names nothing (an empty
/// object, say) so the table never renders a blank row.
pub fn permission_patterns(tool_name: &str, input: &Value) -> (Vec<String>, Vec<String>) {
    let specific = first_meaningful_arg(tool_name, input);
    let Some(specific) = specific else {
        return (vec![tool_name.to_string()], vec![format!("{tool_name} *")]);
    };
    let always = always_pattern(&specific);
    (vec![specific.clone()], vec![always])
}

/// The argument that identifies a call: the command for Bash, the path for
/// file tools, the URL/query for web tools — the same choice the tool cards
/// and `ToolCall::summary` make.
fn first_meaningful_arg(tool_name: &str, input: &Value) -> Option<String> {
    let obj = input.as_object()?;
    // Bash-like tools name it `command`; file tools `file_path`/`path`.
    for key in [
        "command",
        "file_path",
        "path",
        "pattern",
        "url",
        "query",
        "prompt",
        "filePath",
    ] {
        if let Some(value) = obj.get(key).and_then(Value::as_str) {
            let first_line = value.lines().next().unwrap_or(value).trim().to_string();
            if !first_line.is_empty() {
                return Some(first_line);
            }
        }
    }
    // opencode's edit/write shape nests the path under `filePath` already
    // covered above; anything else falls back to the tool name.
    let _ = tool_name;
    None
}

/// The wider pattern "allow always" approves: the parent directory for a
/// path (`/a/b/c.rs` → `/a/b/*`), the command prefix for shell
/// (`git status --porcelain` → `git status *`), the host for a URL.
fn always_pattern(specific: &str) -> String {
    let trimmed = specific.trim();
    // A path: cover its directory.
    if trimmed.starts_with('/') || trimmed.starts_with('~') {
        if let Some(slash) = trimmed.rfind('/') {
            let dir = &trimmed[..slash];
            if dir.is_empty() {
                return "/*".to_string();
            }
            return format!("{dir}/*");
        }
        return format!("{trimmed}*");
    }
    // A URL: cover its host.
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        let without_scheme = trimmed
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(trimmed);
        let host = without_scheme.split('/').next().unwrap_or(without_scheme);
        return format!("*{host}*");
    }
    // A shell command: cover its first two words (`git status ...`).
    let mut words = trimmed.split_whitespace();
    match (words.next(), words.next()) {
        (Some(first), Some(second)) => format!("{first} {second} *"),
        (Some(first), None) => format!("{first} *"),
        _ => format!("{specific}*"),
    }
}

// ---------------------------------------------------------------------------
// Project grounding: the model must know which folder it runs in.
// ---------------------------------------------------------------------------

/// Display name for a working directory: the folder name, or the full path
/// when there is none (filesystem root).
pub fn project_display_name(cwd: &std::path::Path) -> String {
    cwd.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| cwd.display().to_string())
}

/// System prompt pinning the agent to one project. Passed as
/// `--append-system-prompt` on wires that have one (Claude) and folded into
/// the turn text on wires that don't (Codex, opencode) — see
/// [`wrap_turn_with_project`].
///
/// The wording is deliberately an authoritative statement of fact, not a
/// suggestion and not a request to verify: the app spawns the agent process
/// in this directory and keeps the header pinned to the session behind it,
/// so asking "what folder am I in" must answer from here rather than from
/// conversation history or from whichever open project the model saw most
/// recently (e.g. an `egant` thread answering while the user looks at
/// `Arka`). The agent trusts this location and never runs `pwd` or any
/// other tool to determine it.
pub fn project_system_prompt(project_name: &str, cwd: &std::path::Path) -> String {
    format!(
        "You are working in project \"{project_name}\" at {path}. \
         Your working directory is {path}. \
         When asked what folder, directory, or project you are in, answer with this project name and path. \
         Trust this location; do not run `pwd` or any other tool to determine where you are, and do not answer with another open project.",
        path = cwd.display()
    )
}

/// Per-turn envelope carrying the same fact as [`project_system_prompt`].
/// The transcript stores the user's original text; only what crosses the
/// wire is wrapped, so the UI stays clean while the agent is grounded on
/// every turn — including turns in sessions created before the system prompt
/// existed, and resumes where the CLI reuses the recorded prompt verbatim.
pub fn wrap_turn_with_project(project_name: &str, cwd: &std::path::Path, text: &str) -> String {
    format!(
        "[Project: {project_name} | Path: {path} — this is where you are. When asked where you are, answer with this project; do not run `pwd`, trust this location.]\n{text}",
        path = cwd.display()
    )
}

#[cfg(test)]
mod project_context_tests {
    use super::*;

    #[test]
    fn prompt_names_project_and_path() {
        let prompt = project_system_prompt("Arka", std::path::Path::new("/tmp/Arka"));
        assert!(prompt.contains("Arka"));
        assert!(prompt.contains("/tmp/Arka"));
        // The app guarantees the directory; the model must answer directly
        // rather than spending a tool call verifying it.
        assert!(!prompt.to_lowercase().contains("verify with `pwd`"));
        assert!(prompt.contains("do not run `pwd`"));
    }

    #[test]
    fn envelope_preserves_user_text() {
        let wrapped = wrap_turn_with_project("Arka", std::path::Path::new("/tmp/Arka"), "hi");
        assert!(wrapped.contains("Arka"));
        assert!(wrapped.ends_with("hi"));
        assert!(!wrapped.contains("Verify with `pwd`"));
    }

    #[test]
    fn display_name_falls_back_to_path() {
        assert_eq!(
            project_display_name(std::path::Path::new("/tmp/Arka")),
            "Arka"
        );
        assert!(!project_display_name(std::path::Path::new("/")).is_empty());
    }
}

#[cfg(test)]
mod permission_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn always_allow_takes_the_rule_never_the_mode_switch() {
        // The CLI's own offer for a `touch` in manual mode, captured from
        // 2.1.276: a rule, a directory and a switch to accept-edits.
        let suggestions = vec![
            json!({"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": "touch a.txt"}],
                   "behavior": "allow", "destination": "localSettings"}),
            json!({"type": "addDirectories", "directories": ["/tmp/p"], "destination": "session"}),
            json!({"type": "setMode", "mode": "acceptEdits", "destination": "session"}),
        ];
        let update = always_allow_update(&suggestions).unwrap();
        assert_eq!(update["type"], "addRules");

        // Without a rule, the directory is the narrowest thing on offer.
        let update = always_allow_update(&suggestions[1..]).unwrap();
        assert_eq!(update["type"], "addDirectories");

        // A mode switch alone is never taken for "always allow".
        assert!(always_allow_update(&suggestions[2..]).is_none());
        assert!(always_allow_update(&[]).is_none());
    }

    #[test]
    fn the_clis_own_name_for_manual_reads_as_manual() {
        assert_eq!(
            PermissionMode::from_cli_arg("default"),
            Some(PermissionMode::Manual)
        );
        assert_eq!(PermissionMode::Manual.as_cli_arg(), "manual");
    }

    #[test]
    fn questions_and_plans_are_interactive() {
        assert!(is_interactive_tool(ASK_USER_QUESTION));
        assert!(is_interactive_tool(EXIT_PLAN_MODE));
        assert!(!is_interactive_tool("Bash"));
    }
}
