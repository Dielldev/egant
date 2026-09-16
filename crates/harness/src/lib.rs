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
pub mod claude;
pub mod codex;
pub mod models;
pub mod opencode;
pub mod protocol;
pub mod runner;
pub mod transcript;

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::PathBuf;

pub use agents::{AgentId, AgentStatus, detect_agents};
pub use claude::{ClaudeCode, ClaudeOptions};
pub use codex::{CodexExec, CodexOptions};
pub use models::{AgentModel, is_known_model, list_models};
pub use opencode::{OpencodeRun, OpencodeOptions};
pub use transcript::{
    PendingPermission, SessionUsage, ToolCall, Transcript, TranscriptEntry, TurnState,
};

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
    PermissionRequest {
        request_id: String,
        tool_name: String,
        input: Value,
    },
    /// The turn ended. Carries the accounting the status bar shows.
    TurnEnded {
        result: Option<String>,
        is_error: bool,
        duration_ms: u64,
        cost_usd: f64,
        usage: TurnUsage,
    },
    /// The backend reported a problem that did not kill the process.
    Error { message: String },
    /// The process is gone. No further events will arrive.
    Exited { code: Option<i32> },
}

#[derive(Debug, Clone)]
pub enum PermissionDecision {
    /// Run the tool. `updated_input` rewrites the call first, if set.
    Allow { updated_input: Option<Value> },
    /// Refuse. The agent sees `reason` and can try something else.
    Deny { reason: String },
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
    pub fn from_cli_arg(name: &str) -> Option<Self> {
        match name {
            "auto" => Some(PermissionMode::Auto),
            "manual" => Some(PermissionMode::Manual),
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

    /// Send a turn.
    async fn send(&mut self, text: String) -> anyhow::Result<()>;

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
