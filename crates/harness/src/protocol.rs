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
    /// session id every later message is tagged with. Boxed: it carries a
    /// field for every subtype's payload, which would make every message
    /// as large as the rarest one.
    System(Box<SystemMessage>),
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
    /// `status`: what the CLI is busy with — `requesting` as each API call
    /// goes out, `compacting` while it summarizes the conversation — or
    /// `null` once it has stopped.
    #[serde(default)]
    pub status: Option<String>,
    /// `status`, as a compaction ends: `success` or `failed`, and why it
    /// failed.
    #[serde(default)]
    pub compact_result: Option<String>,
    #[serde(default)]
    pub compact_error: Option<String>,
    /// `compact_boundary`: what the compaction it marks did.
    #[serde(default)]
    pub compact_metadata: Option<CompactMetadata>,
    /// `api_retry`: which retry is coming, of how many, after how long a
    /// wait.
    #[serde(default)]
    pub attempt: Option<u32>,
    #[serde(default)]
    pub max_retries: Option<u32>,
    #[serde(default)]
    pub retry_delay_ms: Option<u64>,
    /// `api_retry`: the HTTP status that failed, or none for a request that
    /// never got one (a refused connection, a timeout).
    #[serde(default)]
    pub error_status: Option<u32>,
    /// `api_retry`: the CLI's word for the failure — `overloaded`,
    /// `rate_limit`, `server_error`, `unknown`… Read loosely, since other
    /// subtypes use the name for other shapes (`api_error` puts an object
    /// here), and one frame of theirs must not fail to parse over it.
    #[serde(default)]
    pub error: Value,
    /// `model_fallback`: why the CLI switched models (`model_not_found`,
    /// `overloaded`…), from which to which, and its own sentence saying so.
    #[serde(default)]
    pub trigger: Option<String>,
    #[serde(default)]
    pub original_model: Option<String>,
    #[serde(default)]
    pub fallback_model: Option<String>,
    #[serde(default)]
    pub content: Option<String>,
}

/// What a `compact_boundary` frame says about the compaction it marks.
///
/// The two token counts are not the same measure. `pre_tokens` is the whole
/// prompt the conversation last sent — system prompt and tools included —
/// while `post_tokens` counts only what is left of the conversation itself:
/// the summary, and anything kept verbatim. (Measured on 2.1.276: a
/// one-exchange session compacted from 21,263 to 2,053, and its next request
/// sent 23,035 — roughly the system prompt it had before, plus the summary.)
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CompactMetadata {
    /// `auto` when the CLI compacted on its own as the window filled up,
    /// `manual` for a `/compact`.
    #[serde(default)]
    pub trigger: String,
    #[serde(default)]
    pub pre_tokens: u64,
    #[serde(default)]
    pub post_tokens: Option<u64>,
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
    /// Set when the delta belongs to a subagent's reply rather than the main
    /// thread's — the same field `assistant` and `user` messages carry.
    #[serde(default)]
    pub parent_tool_use_id: Option<String>,
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
        /// The CLI's own "don't ask again" options for this request, as the
        /// permission updates it would accept back in `updatedPermissions`
        /// (`addRules`, `addDirectories`, `setMode`). Alternatives, not a set:
        /// applying all of them also switches the session's mode — see
        /// [`crate::always_allow_update`].
        #[serde(default)]
        permission_suggestions: Vec<Value>,
        /// What the call does, in the CLI's words (a Bash call's
        /// `description`, say).
        #[serde(default)]
        description: Option<String>,
        /// The path that made the CLI ask, when a path did.
        #[serde(default)]
        blocked_path: Option<String>,
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
    Text {
        text: String,
    },
    /// A pasted or attached image, sent as real vision input rather than a
    /// `@path` mention the model would have to go read itself — the same
    /// `image` block shape the Messages API takes anywhere else.
    Image {
        source: ImageSource,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ImageSource {
    Base64 { media_type: String, data: String },
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
    /// `updated_permissions` are permission updates the CLI applies along
    /// with the approval — a rule it saves to the project, a mode it switches
    /// to — the same shapes it offers in `permission_suggestions`.
    pub fn allow(
        request_id: impl Into<String>,
        updated_input: Option<Value>,
        updated_permissions: Vec<Value>,
    ) -> Self {
        let mut body = BTreeMap::new();
        let mut response = serde_json::Map::new();
        response.insert("behavior".into(), Value::String("allow".into()));
        if let Some(input) = updated_input {
            response.insert("updatedInput".into(), input);
        }
        if !updated_permissions.is_empty() {
            response.insert(
                "updatedPermissions".into(),
                Value::Array(updated_permissions),
            );
        }
        body.insert("response".into(), Value::Object(response));
        Self {
            subtype: "success",
            request_id: request_id.into(),
            body,
        }
    }

    /// Refuses a `can_use_tool` request. The agent reads `message` as the
    /// tool's result. `interrupt` also ends the turn, the way pressing Stop
    /// would — the CLI settles it as `error_during_execution`.
    pub fn deny(
        request_id: impl Into<String>,
        message: impl Into<String>,
        interrupt: bool,
    ) -> Self {
        let mut body = BTreeMap::new();
        let mut response = serde_json::Map::new();
        response.insert("behavior".into(), Value::String("deny".into()));
        response.insert("message".into(), Value::String(message.into()));
        if interrupt {
            response.insert("interrupt".into(), Value::Bool(true));
        }
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

    /// Captured from CLI 2.1.276 run with `--permission-prompt-tool stdio` in
    /// `manual` mode, paths shortened. Three suggestions, one of which is a
    /// mode switch.
    const CAN_USE_BASH: &str = r#"{"type":"control_request","request_id":"a8777116-6c95-435e-97ea-4e4034d856c1","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"touch probe-a.txt","description":"Create file probe-a.txt"},"description":"Create file probe-a.txt","permission_suggestions":[{"type":"addRules","rules":[{"toolName":"Bash","ruleContent":"touch probe-a.txt"}],"behavior":"allow","destination":"localSettings"},{"type":"addDirectories","directories":["/tmp/probe"],"destination":"session"},{"type":"setMode","mode":"acceptEdits","destination":"session"}],"blocked_path":"/tmp/probe/probe-a.txt","tool_use_id":"toolu_01VCr3dec3ExGuJpD2MtR1T4"}}"#;

    #[test]
    fn parses_a_permission_request_with_its_suggestions() {
        let msg: CliMessage = serde_json::from_str(CAN_USE_BASH).unwrap();
        let CliMessage::ControlRequest(envelope) = msg else {
            panic!("expected a control request");
        };
        let ControlRequest::CanUseTool {
            tool_name,
            permission_suggestions,
            description,
            blocked_path,
            ..
        } = envelope.request
        else {
            panic!("expected can_use_tool");
        };
        assert_eq!(tool_name, "Bash");
        assert_eq!(permission_suggestions.len(), 3);
        assert_eq!(description.as_deref(), Some("Create file probe-a.txt"));
        assert_eq!(blocked_path.as_deref(), Some("/tmp/probe/probe-a.txt"));
    }

    #[test]
    fn an_allow_carries_permission_updates_only_when_there_are_some() {
        let with = serde_json::to_value(HostControlResponse::allow(
            "r1",
            Some(serde_json::json!({ "command": "ls" })),
            vec![serde_json::json!({ "type": "addRules" })],
        ))
        .unwrap();
        assert_eq!(
            with["response"]["updatedPermissions"],
            serde_json::json!([{ "type": "addRules" }])
        );
        assert_eq!(with["response"]["updatedInput"]["command"], "ls");

        let without = serde_json::to_value(HostControlResponse::allow("r1", None, vec![])).unwrap();
        assert!(without["response"].get("updatedPermissions").is_none());
    }

    #[test]
    fn a_deny_can_also_stop_the_turn() {
        let stop = serde_json::to_value(HostControlResponse::deny("r1", "no", true)).unwrap();
        assert_eq!(stop["response"]["behavior"], "deny");
        assert_eq!(stop["response"]["interrupt"], true);
        let plain = serde_json::to_value(HostControlResponse::deny("r1", "no", false)).unwrap();
        assert!(plain["response"].get("interrupt").is_none());
    }

    #[test]
    fn a_system_frame_that_reuses_a_name_for_another_shape_still_parses() {
        // `api_error`'s `error` is an object where `api_retry`'s is a word.
        // Shape from the CLI's own schema for it; it was never seen on the
        // wire, but a frame like it must not read as malformed.
        let msg: CliMessage = serde_json::from_str(
            r#"{"type":"system","subtype":"api_error","error":{"message":"overloaded","status":529,"formatted":"Overloaded","connection":null,"is_network_down":false,"rate_limits":null},"session_id":"s"}"#,
        )
        .unwrap();
        let CliMessage::System(system) = msg else {
            panic!("expected a system message");
        };
        assert_eq!(system.subtype, "api_error");
        assert!(system.error.is_object());
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
