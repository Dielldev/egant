//! The renderable shape of a conversation.
//!
//! The UI does not fold [`HarnessEvent`]s itself. It owns a [`Transcript`],
//! calls [`Transcript::apply`] for each event, and re-renders. Keeping the fold
//! here means the same logic backs the UI, a headless log, and tests.

use crate::HarnessEvent;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind")]
pub enum TranscriptEntry {
    User {
        text: String,
    },
    /// `streaming` stays true while deltas are still arriving, which is what the
    /// view uses to decide whether to draw a cursor.
    Assistant {
        text: String,
        streaming: bool,
    },
    Thinking {
        text: String,
        streaming: bool,
    },
    Tool(ToolCall),
    Notice {
        text: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: Value,
    pub output: Option<String>,
    pub is_error: bool,
}

impl ToolCall {
    /// A one-line summary for the collapsed row: the argument that identifies
    /// the call, falling back to the tool name.
    pub fn summary(&self) -> String {
        for key in ["command", "file_path", "path", "pattern", "url", "prompt"] {
            if let Some(value) = self.input.get(key).and_then(Value::as_str) {
                return value.lines().next().unwrap_or(value).to_string();
            }
        }
        self.name.clone()
    }

    pub fn is_running(&self) -> bool {
        self.output.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub enum TurnState {
    #[default]
    Idle,
    /// A turn is in flight: the composer shows a stop button.
    Running,
    /// Blocked on the user answering a permission request.
    AwaitingPermission,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Transcript {
    pub entries: Vec<TranscriptEntry>,
    pub state: TurnState,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub pending_permission: Option<PendingPermission>,
    /// Every outstanding request, in arrival order. `pending_permission`
    /// mirrors the first entry for snapshots written before the table
    /// existed; new code should read this list. Empty on old transcripts.
    #[serde(default)]
    pub pending_permissions: Vec<PendingPermission>,
    pub total_cost_usd: f64,
    pub last_turn_ms: u64,
    /// What this session has spent, turn by turn. See [`SessionUsage`].
    #[serde(default)]
    pub usage: SessionUsage,
    /// Index of each tool call in `entries`, so a result can find its call
    /// without scanning the whole transcript. Rebuildable from `entries`, so
    /// it is never written to disk — a persisted transcript restores with an
    /// empty index and no in-flight tool calls to look up anyway.
    #[serde(skip)]
    tool_index: HashMap<String, usize>,
}

/// Everything one session has spent.
///
/// Two different kinds of number live here, and the difference is the whole
/// reason this is a struct rather than a running total:
///
/// - the token counts and `turns` **accumulate** — they answer "what has this
///   conversation cost me so far";
/// - `context_tokens` and `context_window` **describe only the newest turn** —
///   they answer "how much room is left". The window holds one conversation,
///   not the sum of every turn that has passed through it, so summing them
///   would climb past 100% on any session of a few turns.
///
/// Persisted with the transcript, so a session restored from disk still knows
/// what it spent instead of starting the count over.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SessionUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    /// Turns that reported usage — the denominator for any "per turn" reading,
    /// and deliberately not the number of messages sent: an interrupted turn
    /// accounts for nothing and is not counted.
    pub turns: u64,
    /// The newest turn's occupancy of the context window.
    pub context_tokens: u64,
    /// The window that occupancy is measured against, or `0` while unknown —
    /// the caller supplies its own default rather than being handed a guess.
    pub context_window: u64,
}

impl SessionUsage {
    /// Every token this session has moved, across every turn.
    pub fn total_tokens(&self) -> u64 {
        self.input_tokens
            .saturating_add(self.output_tokens)
            .saturating_add(self.cache_creation_tokens)
            .saturating_add(self.cache_read_tokens)
    }

    /// Folds one turn's accounting in.
    ///
    /// Only the spend accumulates here. `context_tokens` is owned by
    /// [`HarnessEvent::ContextUpdate`]: a turn's `usage` sums every API call
    /// in a multi-step turn, so deriving occupancy from it reads as several
    /// windows' worth after a single prompt. The window itself still updates
    /// here — it arrives once per turn, on the only message that carries it.
    ///
    /// A turn the backend did not account for — interrupted before it
    /// settled, or run on a wire that reports no tokens — leaves every number
    /// untouched. Recording it would inflate `turns` for nothing.
    pub fn record(&mut self, turn: crate::TurnUsage) {
        if !turn.is_reported() {
            return;
        }
        self.input_tokens = self.input_tokens.saturating_add(turn.input_tokens);
        self.output_tokens = self.output_tokens.saturating_add(turn.output_tokens);
        self.cache_creation_tokens = self
            .cache_creation_tokens
            .saturating_add(turn.cache_creation_tokens);
        self.cache_read_tokens = self
            .cache_read_tokens
            .saturating_add(turn.cache_read_tokens);
        self.turns = self.turns.saturating_add(1);
        // Keep the last window we were told about: a turn that omits it says
        // nothing about the model having changed.
        if turn.context_window > 0 {
            self.context_window = turn.context_window;
        }
    }

    /// Folds in a live occupancy reading. Replaces, never accumulates: the
    /// window holds one conversation, so the newest reading supersedes.
    pub fn record_context(&mut self, context_tokens: u64, context_window: u64) {
        self.context_tokens = context_tokens;
        if context_window > 0 {
            self.context_window = context_window;
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingPermission {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
    /// Specific resource patterns (file path, command). Empty on transcripts
    /// written before patterns existed.
    #[serde(default)]
    pub patterns: Vec<String>,
    /// Wider patterns an "allow always" answer would approve.
    #[serde(default)]
    pub always_patterns: Vec<String>,
}

impl Transcript {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a turn the user just sent, before the agent has replied.
    pub fn push_user(&mut self, text: impl Into<String>) {
        self.entries
            .push(TranscriptEntry::User { text: text.into() });
        self.state = TurnState::Running;
    }

    /// Clears one answered prompt. When the table empties the turn goes back
    /// to running (Claude continues); a turn-based wire (opencode) already
    /// settled, so its caller decides whether to retry.
    pub fn resolve_permission(&mut self, request_id: &str) {
        self.pending_permissions
            .retain(|p| p.request_id != request_id);
        self.pending_permission = self.pending_permissions.first().cloned();
        if self.pending_permissions.is_empty() && self.state == TurnState::AwaitingPermission {
            self.state = TurnState::Running;
        }
    }

    /// Clears every outstanding prompt (deny-all / session end).
    pub fn clear_permissions(&mut self) {
        self.pending_permissions.clear();
        self.pending_permission = None;
        if self.state == TurnState::AwaitingPermission {
            self.state = TurnState::Running;
        }
    }

    pub fn apply(&mut self, event: HarnessEvent) {
        match event {
            HarnessEvent::Ready {
                session_id,
                model,
                tools,
                ..
            } => {
                self.session_id = Some(session_id);
                self.model = model;
                self.tools = tools;
            }

            HarnessEvent::AssistantDelta { text } => self.append_streaming(text, false),
            HarnessEvent::ThinkingDelta { text } => self.append_streaming(text, true),

            // The settled message supersedes whatever the deltas built: same
            // content, but canonical. Replacing avoids doubled text when a
            // backend sends both.
            HarnessEvent::AssistantMessage { text } => {
                match self.last_streaming_assistant() {
                    Some(entry) => {
                        *entry = TranscriptEntry::Assistant {
                            text,
                            streaming: false,
                        }
                    }
                    None => self.entries.push(TranscriptEntry::Assistant {
                        text,
                        streaming: false,
                    }),
                }
                self.settle_streaming();
            }

            HarnessEvent::ToolUse { id, name, input } => {
                self.settle_streaming();
                self.tool_index.insert(id.clone(), self.entries.len());
                self.entries.push(TranscriptEntry::Tool(ToolCall {
                    id,
                    name,
                    input,
                    output: None,
                    is_error: false,
                }));
            }

            HarnessEvent::ToolResult {
                id,
                output,
                is_error,
            } => {
                if let Some(&index) = self.tool_index.get(&id) {
                    if let Some(TranscriptEntry::Tool(call)) = self.entries.get_mut(index) {
                        call.output = Some(output);
                        call.is_error = is_error;
                    }
                }
            }

            HarnessEvent::PermissionRequest {
                request_id,
                tool_name,
                input,
                patterns,
                always_patterns,
            } => {
                self.state = TurnState::AwaitingPermission;
                let pending = PendingPermission {
                    request_id,
                    tool_name,
                    input,
                    patterns,
                    always_patterns,
                };
                // Replace a re-ask for the same request; otherwise append so
                // the UI can table several outstanding prompts at once (an
                // opencode turn denied on three reads, say).
                if let Some(existing) = self
                    .pending_permissions
                    .iter_mut()
                    .find(|p| p.request_id == pending.request_id)
                {
                    *existing = pending.clone();
                } else {
                    self.pending_permissions.push(pending.clone());
                }
                self.pending_permission = Some(pending);
            }

            HarnessEvent::TurnEnded {
                is_error,
                duration_ms,
                cost_usd,
                result,
                usage,
            } => {
                self.settle_streaming();
                self.state = TurnState::Idle;
                self.total_cost_usd += cost_usd;
                self.last_turn_ms = duration_ms;
                self.usage.record(usage);
                if is_error {
                    if let Some(message) = result {
                        self.entries.push(TranscriptEntry::Notice {
                            text: message,
                            is_error: true,
                        });
                    }
                }
            }

            HarnessEvent::ContextUpdate {
                context_tokens,
                context_window,
            } => {
                self.usage.record_context(context_tokens, context_window);
            }

            HarnessEvent::Error { message } => {
                self.entries.push(TranscriptEntry::Notice {
                    text: message,
                    is_error: true,
                });
            }

            HarnessEvent::Exited { code } => {
                self.settle_streaming();
                self.state = TurnState::Idle;
                self.entries.push(TranscriptEntry::Notice {
                    text: match code {
                        Some(code) => format!("Agent exited with status {code}."),
                        None => "Agent exited.".into(),
                    },
                    is_error: code.is_some_and(|code| code != 0),
                });
            }
        }
    }

    /// Appends a delta to the open entry of the matching kind, opening one if
    /// the last entry is something else (a tool call, say).
    fn append_streaming(&mut self, delta: String, thinking: bool) {
        self.state = TurnState::Running;
        match self.entries.last_mut() {
            Some(TranscriptEntry::Assistant { text, streaming }) if *streaming && !thinking => {
                text.push_str(&delta);
                return;
            }
            Some(TranscriptEntry::Thinking { text, streaming }) if *streaming && thinking => {
                text.push_str(&delta);
                return;
            }
            _ => {}
        }
        self.entries.push(if thinking {
            TranscriptEntry::Thinking {
                text: delta,
                streaming: true,
            }
        } else {
            TranscriptEntry::Assistant {
                text: delta,
                streaming: true,
            }
        });
    }

    fn last_streaming_assistant(&mut self) -> Option<&mut TranscriptEntry> {
        let entry = self.entries.last_mut()?;
        matches!(
            entry,
            TranscriptEntry::Assistant {
                streaming: true,
                ..
            }
        )
        .then_some(entry)
    }

    /// Closes every still-open entry at the tail. Stops at the first settled
    /// one: anything older was closed by an earlier call.
    fn settle_streaming(&mut self) {
        for entry in self.entries.iter_mut().rev() {
            match entry {
                TranscriptEntry::Assistant { streaming, .. }
                | TranscriptEntry::Thinking { streaming, .. } => {
                    if !*streaming {
                        break;
                    }
                    *streaming = false;
                }
                _ => break,
            }
        }
    }

    pub fn is_busy(&self) -> bool {
        self.state != TurnState::Idle
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn deltas_accumulate_into_one_entry() {
        let mut transcript = Transcript::new();
        transcript.apply(HarnessEvent::AssistantDelta { text: "Hel".into() });
        transcript.apply(HarnessEvent::AssistantDelta { text: "lo".into() });
        assert_eq!(transcript.entries.len(), 1);
        match &transcript.entries[0] {
            TranscriptEntry::Assistant { text, streaming } => {
                assert_eq!(text, "Hello");
                assert!(streaming);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn settled_message_replaces_streamed_text_rather_than_doubling_it() {
        let mut transcript = Transcript::new();
        transcript.apply(HarnessEvent::AssistantDelta { text: "Hel".into() });
        transcript.apply(HarnessEvent::AssistantMessage {
            text: "Hello".into(),
        });
        assert_eq!(transcript.entries.len(), 1);
        match &transcript.entries[0] {
            TranscriptEntry::Assistant { text, streaming } => {
                assert_eq!(text, "Hello");
                assert!(!streaming);
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn tool_result_attaches_to_its_call() {
        let mut transcript = Transcript::new();
        transcript.apply(HarnessEvent::ToolUse {
            id: "t1".into(),
            name: "Bash".into(),
            input: json!({ "command": "ls -la" }),
        });
        transcript.apply(HarnessEvent::AssistantDelta {
            text: "after".into(),
        });
        transcript.apply(HarnessEvent::ToolResult {
            id: "t1".into(),
            output: "a\nb".into(),
            is_error: false,
        });

        match &transcript.entries[0] {
            TranscriptEntry::Tool(call) => {
                assert_eq!(call.summary(), "ls -la");
                assert_eq!(call.output.as_deref(), Some("a\nb"));
                assert!(!call.is_running());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn permission_request_blocks_the_turn() {
        let mut transcript = Transcript::new();
        transcript.push_user("do it");
        transcript.apply(HarnessEvent::PermissionRequest {
            request_id: "r1".into(),
            tool_name: "Bash".into(),
            input: json!({ "command": "rm -rf /" }),
            patterns: vec!["rm -rf /".to_string()],
            always_patterns: vec!["rm *".to_string()],
        });
        assert_eq!(transcript.state, TurnState::AwaitingPermission);
        assert!(transcript.is_busy());
        assert_eq!(
            transcript.pending_permission.as_ref().unwrap().tool_name,
            "Bash"
        );
        assert_eq!(transcript.pending_permissions.len(), 1);
    }

    #[test]
    fn several_permission_requests_table_up_and_resolve_one_by_one() {
        let mut transcript = Transcript::new();
        transcript.push_user("read things");
        for (id, path) in [("r1", "/tmp/a"), ("r2", "/tmp/b")] {
            transcript.apply(HarnessEvent::PermissionRequest {
                request_id: id.into(),
                tool_name: "Read".into(),
                input: json!({ "file_path": path }),
                patterns: vec![path.to_string()],
                always_patterns: vec!["/tmp/*".to_string()],
            });
        }
        assert_eq!(transcript.pending_permissions.len(), 2);
        assert_eq!(transcript.state, TurnState::AwaitingPermission);
        transcript.resolve_permission("r1");
        assert_eq!(transcript.pending_permissions.len(), 1);
        // One row left: still blocked.
        assert_eq!(transcript.state, TurnState::AwaitingPermission);
        assert_eq!(
            transcript.pending_permission.as_ref().unwrap().request_id,
            "r2"
        );
        transcript.resolve_permission("r2");
        assert!(transcript.pending_permissions.is_empty());
        assert!(transcript.pending_permission.is_none());
        assert_eq!(transcript.state, TurnState::Running);
    }

    fn turn(input: u64, output: u64, cache_read: u64, window: u64) -> HarnessEvent {
        HarnessEvent::TurnEnded {
            result: None,
            is_error: false,
            duration_ms: 1,
            cost_usd: 0.01,
            usage: crate::TurnUsage {
                input_tokens: input,
                output_tokens: output,
                cache_read_tokens: cache_read,
                cache_creation_tokens: 0,
                context_window: window,
            },
        }
    }

    fn ctx(tokens: u64, window: u64) -> HarnessEvent {
        HarnessEvent::ContextUpdate {
            context_tokens: tokens,
            context_window: window,
        }
    }

    #[test]
    fn tokens_accumulate_while_context_occupancy_replaces() {
        let mut transcript = Transcript::new();
        transcript.apply(turn(2, 10, 25_000, 200_000));
        transcript.apply(ctx(25_012, 200_000));
        transcript.apply(turn(3, 20, 40_000, 200_000));
        transcript.apply(ctx(40_023, 200_000));

        // Spend is cumulative across the session.
        assert_eq!(transcript.usage.input_tokens, 5);
        assert_eq!(transcript.usage.output_tokens, 30);
        assert_eq!(transcript.usage.cache_read_tokens, 65_000);
        assert_eq!(transcript.usage.turns, 2);
        assert_eq!(transcript.usage.total_tokens(), 65_035);

        // Occupancy is not: the window holds one conversation, so the newest
        // reading replaces the previous one rather than summing.
        assert_eq!(transcript.usage.context_tokens, 40_023);
        assert_eq!(transcript.usage.context_window, 200_000);
    }

    #[test]
    fn a_summed_turn_total_never_becomes_the_context_reading() {
        // The regression this exists to prevent: a turn's `usage` sums every
        // API call in a multi-step turn, so one prompt with a few tool steps
        // settled the meter at several windows' worth of tokens.
        let mut transcript = Transcript::new();
        transcript.apply(ctx(25_204, 200_000));
        transcript.apply(turn(2, 10, 1_400_000, 200_000));
        assert_eq!(transcript.usage.context_tokens, 25_204);
        assert_eq!(transcript.usage.turns, 1);
    }

    #[test]
    fn an_unaccounted_turn_leaves_the_numbers_alone() {
        let mut transcript = Transcript::new();
        transcript.apply(ctx(25_012, 200_000));
        transcript.apply(turn(2, 10, 25_000, 200_000));
        // An interrupted turn, or a wire that reports no tokens: recording it
        // would inflate the turn count for nothing.
        transcript.apply(turn(0, 0, 0, 0));
        assert_eq!(transcript.usage.turns, 1);
        assert_eq!(transcript.usage.context_tokens, 25_012);
        assert_eq!(transcript.usage.context_window, 200_000);
    }

    #[test]
    fn a_window_is_remembered_when_a_later_turn_omits_it() {
        let mut transcript = Transcript::new();
        transcript.apply(turn(2, 10, 25_000, 1_000_000));
        transcript.apply(turn(2, 10, 30_000, 0));
        assert_eq!(transcript.usage.context_window, 1_000_000);
    }

    #[test]
    fn turn_end_accumulates_cost_and_clears_busy() {
        let mut transcript = Transcript::new();
        transcript.push_user("hi");
        transcript.apply(HarnessEvent::TurnEnded {
            result: Some("done".into()),
            is_error: false,
            duration_ms: 120,
            cost_usd: 0.25,
            usage: crate::TurnUsage {
                input_tokens: 10,
                output_tokens: 5,
                ..Default::default()
            },
        });
        assert_eq!(transcript.state, TurnState::Idle);
        assert!((transcript.total_cost_usd - 0.25).abs() < f64::EPSILON);
        assert_eq!(transcript.last_turn_ms, 120);
    }
}
