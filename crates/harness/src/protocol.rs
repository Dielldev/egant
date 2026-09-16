//! Wire types for Claude Code's `stream-json` protocol.
//!
//! These mirror what `claude --print --output-format stream-json --verbose`
//! actually writes on stdout, and what it accepts on stdin under
//! `--input-format stream-json`. The same protocol is what the official Claude
//! Agent SDK (TypeScript/Python) wraps, so its docs are the reference for
//! message shapes this file does not yet cover.
//!
//! Everything here is deliberately permissive: unknown message types and
//! unknown fields are preserved or ignored rather than rejected, because the
//! CLI adds fields between releases and a desktop app should not die on one.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::PathBuf;

// ---------------------------------------------------------------------------
// Outbound: messages the CLI writes to stdout.
// ---------------------------------------------------------------------------

/// One newline-delimited JSON object from the CLI's stdout.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum CliMessage {
    /// Session lifecycle. `subtype: "init"` is the handshake: it carries the
    /// session id every later message is tagged with.
    System(SystemMessage),
    /// A complete assistant turn (or one step of a multi-step turn).
    Assistant(TurnMessage),
    /// Tool results and user input echoed back into the transcript.
    User(TurnMessage),
    /// Incremental deltas, only present with `--include-partial-messages`.
    StreamEvent(StreamEvent),
    /// End of a turn: cost, duration, and the final text.
    Result(ResultMessage),
    /// The CLI asking the host something — e.g. permission to run a tool.
    ControlRequest(ControlRequestEnvelope),
    /// The CLI's answer to a control request we sent (e.g. an interrupt).
    ControlResponse(ControlResponseEnvelope),
    /// Anything this version of the protocol does not know about.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SystemMessage {
    pub subtype: String,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub cwd: Option<PathBuf>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub tools: Vec<String>,
    #[serde(default, rename = "permissionMode")]
    pub permission_mode: Option<String>,
    #[serde(default, rename = "claude_code_version")]
    pub version: Option<String>,
}

/// Wrapper the CLI puts around an Anthropic API message, for both the
/// `assistant` and `user` message types.
#[derive(Debug, Clone, Deserialize)]
pub struct TurnMessage {
    pub message: ApiMessage,
    #[serde(default)]
    pub session_id: String,
    /// Set when this turn belongs to a subagent rather than the main thread.
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
    /// Present instead of content when the CLI itself failed (auth, network).
    #[serde(default)]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiMessage {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub role: String,
    /// The API allows a bare string here as well as a block list; the CLI emits
    /// blocks, but tool results inside `user` messages can be either.
    #[serde(default)]
    pub content: Content,
    #[serde(default)]
    pub stop_reason: Option<String>,
    #[serde(default)]
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(untagged)]
pub enum Content {
    Text(String),
    Blocks(Vec<ContentBlock>),
    /// Matches an explicit `null`; also the value used when the field is absent.
    #[default]
    Empty,
}

impl Content {
    /// Flattens to the plain text a transcript would show.
    pub fn as_text(&self) -> String {
        match self {
            Content::Text(text) => text.clone(),
            Content::Blocks(blocks) => blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => Some(text.as_str()),
                    _ => None,
                })
                .collect::<Vec<_>>()
                .join(""),
            Content::Empty => String::new(),
        }
    }

    pub fn blocks(&self) -> &[ContentBlock] {
        match self {
            Content::Blocks(blocks) => blocks,
            _ => &[],
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ContentBlock {
    Text {
        text: String,
    },
    Thinking {
        #[serde(default)]
        thinking: String,
    },
    ToolUse {
        id: String,
        name: String,
        #[serde(default)]
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        #[serde(default)]
        content: Value,
        #[serde(default)]
        is_error: bool,
    },
    #[serde(other)]
    Unknown,
}

/// A raw server-sent event from the model stream, forwarded verbatim by the CLI
/// when `--include-partial-messages` is on. This is what makes the transcript
/// type out token by token instead of appearing all at once.
#[derive(Debug, Clone, Deserialize)]
pub struct StreamEvent {
    #[serde(default)]
    pub session_id: String,
    pub event: StreamEventKind,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StreamEventKind {
    MessageStart {
        #[serde(default)]
        message: Value,
    },
    ContentBlockStart {
        index: usize,
        #[serde(default)]
        content_block: Value,
    },
    ContentBlockDelta {
        index: usize,
        delta: BlockDelta,
    },
    ContentBlockStop {
        index: usize,
    },
    MessageDelta {
        #[serde(default)]
        delta: Value,
        #[serde(default)]
        usage: Option<Usage>,
    },
    MessageStop,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum BlockDelta {
    TextDelta {
        text: String,
    },
    ThinkingDelta {
        thinking: String,
    },
    InputJsonDelta {
        partial_json: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ResultMessage {
    #[serde(default)]
    pub subtype: String,
    #[serde(default)]
    pub is_error: bool,
    /// The assistant's final text for the turn.
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub session_id: String,
    #[serde(default)]
    pub duration_ms: u64,
    #[serde(default)]
    pub num_turns: u32,
    #[serde(default)]
    pub total_cost_usd: f64,
    #[serde(default)]
    pub usage: Option<Usage>,
    /// Per-model accounting for the turn, keyed by the fully-resolved model id
    /// (`claude-opus-5[1m]`). The one thing worth reading out of it is the
    /// context window: the flat `usage` object never carries it, and it is not
    /// a constant — the `[1m]` variant of a model has five times the window of
    /// the same model without it.
    #[serde(default, rename = "modelUsage")]
    pub model_usage: std::collections::HashMap<String, ModelUsage>,
}

impl ResultMessage {
    /// The context window this turn ran under, or `0` when the CLI did not
    /// say. A turn that spanned models (a subagent on a smaller one) reports
    /// several; the largest is the closest thing to the conversation's own
    /// window, since a subagent's transcript is not what fills it.
    pub fn context_window(&self) -> u64 {
        self.model_usage
            .values()
            .map(|usage| usage.context_window)
            .max()
            .unwrap_or(0)
    }
}

/// One model's slice of a turn. Only the window is read here; the token counts
/// duplicate the flat `usage` object, which is already the source for those.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ModelUsage {
    #[serde(default, rename = "contextWindow")]
    pub context_window: u64,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub input_tokens: u64,
    #[serde(default)]
    pub output_tokens: u64,
    #[serde(default)]
    pub cache_creation_input_tokens: u64,
    #[serde(default)]
    pub cache_read_input_tokens: u64,
}

// ---------------------------------------------------------------------------
// Control channel: the handshake that makes this two-way rather than a pipe.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
pub struct ControlRequestEnvelope {
    pub request_id: String,
    pub request: ControlRequest,
}

/// Requests the CLI makes of us. `can_use_tool` is the important one: it is how
/// a permission prompt reaches the UI instead of blocking on a terminal.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum ControlRequest {
    CanUseTool {
        tool_name: String,
        #[serde(default)]
        input: Value,
        #[serde(default)]
        tool_use_id: Option<String>,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ControlResponseEnvelope {
    #[serde(default)]
    pub response: Value,
}

// ---------------------------------------------------------------------------
// Inbound: messages we write to the CLI's stdin.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostMessage {
    /// A turn from the person using the app.
    User {
        message: HostUserMessage,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<String>,
    },
    /// Out-of-band control: interrupt, permission-mode change.
    ControlRequest {
        request_id: String,
        request: HostControlRequest,
    },
    /// Our answer to a `can_use_tool` request.
    ControlResponse { response: HostControlResponse },
}

#[derive(Debug, Clone, Serialize)]
pub struct HostUserMessage {
    pub role: &'static str,
    pub content: Vec<HostContentBlock>,
}

impl HostUserMessage {
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            role: "user",
            content: vec![HostContentBlock::Text { text: text.into() }],
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum HostContentBlock {
    Text { text: String },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "subtype", rename_all = "snake_case")]
pub enum HostControlRequest {
    /// Stop the current turn. The CLI keeps the session; the next user message
    /// continues it.
    Interrupt,
    SetPermissionMode {
        mode: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct HostControlResponse {
    pub subtype: &'static str,
    pub request_id: String,
    #[serde(flatten)]
    pub body: BTreeMap<String, Value>,
}

impl HostControlResponse {
    /// Answers a `can_use_tool` request. `updated_input` lets the host rewrite
    /// the tool call before it runs; `None` approves it as proposed.
    pub fn allow(request_id: impl Into<String>, updated_input: Option<Value>) -> Self {
        let mut body = BTreeMap::new();
        let mut response = serde_json::Map::new();
        response.insert("behavior".into(), Value::String("allow".into()));
        if let Some(input) = updated_input {
            response.insert("updatedInput".into(), input);
        }
        body.insert("response".into(), Value::Object(response));
        Self {
            subtype: "success",
            request_id: request_id.into(),
            body,
        }
    }

    pub fn deny(request_id: impl Into<String>, message: impl Into<String>) -> Self {
        let mut body = BTreeMap::new();
        let mut response = serde_json::Map::new();
        response.insert("behavior".into(), Value::String("deny".into()));
        response.insert("message".into(), Value::String(message.into()));
        body.insert("response".into(), Value::Object(response));
        Self {
            subtype: "success",
            request_id: request_id.into(),
            body,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Captured from `claude -p --output-format stream-json --verbose` so the
    /// parser is pinned to a real frame, not an assumed one.
    const INIT: &str = r#"{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"cd9cb67d","tools":["Read","Bash"],"mcp_servers":[],"model":"claude-opus-5","permissionMode":"default","claude_code_version":"2.1.265"}"#;

    const ASSISTANT: &str = r#"{"type":"assistant","message":{"id":"f2f3","model":"claude-opus-5","role":"assistant","type":"message","content":[{"type":"text","text":"hello"}],"stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":3}},"parent_tool_use_id":null,"session_id":"cd9cb67d"}"#;

    const RESULT: &str = r#"{"type":"result","subtype":"success","is_error":false,"duration_ms":73,"num_turns":1,"result":"hello","session_id":"cd9cb67d","total_cost_usd":0.01,"usage":{"input_tokens":12,"output_tokens":3}}"#;

    #[test]
    fn parses_init() {
        let msg: CliMessage = serde_json::from_str(INIT).unwrap();
        let CliMessage::System(system) = msg else {
            panic!("expected system message");
        };
        assert_eq!(system.subtype, "init");
        assert_eq!(system.session_id, "cd9cb67d");
        assert_eq!(system.model.as_deref(), Some("claude-opus-5"));
        assert_eq!(system.tools.len(), 2);
    }

    #[test]
    fn parses_assistant_text() {
        let msg: CliMessage = serde_json::from_str(ASSISTANT).unwrap();
        let CliMessage::Assistant(turn) = msg else {
            panic!("expected assistant message");
        };
        assert_eq!(turn.message.content.as_text(), "hello");
        assert_eq!(turn.message.usage.unwrap().output_tokens, 3);
    }

    #[test]
    fn parses_result() {
        let msg: CliMessage = serde_json::from_str(RESULT).unwrap();
        let CliMessage::Result(result) = msg else {
            panic!("expected result message");
        };
        assert!(!result.is_error);
        assert_eq!(result.result.as_deref(), Some("hello"));
    }

    #[test]
    fn unknown_message_types_do_not_fail() {
        let msg: CliMessage =
            serde_json::from_str(r#"{"type":"something_new","payload":1}"#).unwrap();
        assert!(matches!(msg, CliMessage::Unknown));
    }

    #[test]
    fn serializes_user_turn() {
        let msg = HostMessage::User {
            message: HostUserMessage::text("hi"),
            session_id: None,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert_eq!(
            json,
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#
        );
    }
}
