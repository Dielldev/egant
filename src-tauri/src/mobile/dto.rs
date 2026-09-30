//! What the phone is sent. Narrower than the window's DTOs on purpose: a
//! phone draws a session list and a conversation, so it gets names, states
//! and the transcript — never a folder path, a settings file or anything
//! else it would have no use for.

use serde::Serialize;
use serde_json::Value;

use crate::dto::{EntryDto, PendingDto, SessionUsageDto, pending_list, turn_state_name};
use crate::state::{AppState, ManagedSession};
use egant_harness::TranscriptEntry;

/// Tool output in a transcript snapshot is capped like it is on the stream:
/// at what the desktop's tool cards show of it (see
/// `crate::sync::STREAM_OUTPUT_LIMIT`).
const SNAPSHOT_OUTPUT_LIMIT: usize = crate::sync::STREAM_OUTPUT_LIMIT;

/// One row of the phone's session list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRowDto {
    pub id: u64,
    pub title: String,
    pub project_id: usize,
    pub project_name: String,
    /// The project's colour, as the window draws it: `hsl(hue * 360, 62%, 58%)`.
    pub project_hue: f32,
    /// `claude`, `codex`, `opencode` — or, for a CLI session, the catalog id.
    pub agent: String,
    /// `chat`, or `cli` for an agent running in a terminal on the desktop,
    /// which the phone can list but not drive.
    pub kind: &'static str,
    pub branch: Option<String>,
    pub worktree: Option<WorktreeRowDto>,
    /// The model the agent last reported, else the one it was started on.
    pub model: Option<String>,
    /// The model this session asked for — a catalog id, or `None` for the
    /// CLI's default — which is what a model picker marks as chosen.
    pub requested_model: Option<String>,
    /// The effort it asked for, `None` for the model's default.
    pub variant: Option<String>,
    pub permission_mode: &'static str,
    /// `idle`, `running` or `awaiting_permission`.
    pub state: &'static str,
    pub busy: bool,
    /// Permission requests waiting on an answer — what puts a session in
    /// the list's "Needs you" group.
    pub pending_count: usize,
    pub ended: bool,
    /// An ended session the agent can pick back up on the next message.
    pub resumable: bool,
    pub started_unix_ms: u64,
    pub last_activity_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRowDto {
    pub branch: String,
    pub name: String,
}

pub fn session_row(state: &AppState, id: u64) -> Option<SessionRowDto> {
    let session = state.sessions.get(&id)?;
    let meta = &session.meta;
    let project = state.project(meta.project_id);
    let transcript = &session.transcript;
    Some(SessionRowDto {
        id: meta.id,
        title: meta.title.clone(),
        project_id: meta.project_id,
        project_name: project.map(|p| p.name.clone()).unwrap_or_default(),
        project_hue: project.map_or(0.0, |p| p.hue),
        agent: meta
            .cli_agent
            .clone()
            .unwrap_or_else(|| meta.agent.as_str().to_string()),
        kind: if meta.cli_agent.is_some() {
            "cli"
        } else {
            "chat"
        },
        branch: meta.branch.clone(),
        worktree: meta.worktree.as_ref().map(|worktree| WorktreeRowDto {
            branch: worktree.branch.clone(),
            name: worktree.name.clone(),
        }),
        model: transcript.model.clone().or_else(|| meta.model.clone()),
        requested_model: meta.model.clone(),
        variant: meta.variant.clone(),
        permission_mode: meta.permission_mode.as_cli_arg(),
        state: turn_state_name(transcript.state),
        busy: transcript.is_busy(),
        pending_count: transcript.pending_permissions.len(),
        ended: meta.ended,
        resumable: meta.ended && transcript.session_id.is_some(),
        started_unix_ms: meta.started_unix_ms,
        last_activity_ms: session.last_activity_ms,
    })
}

/// A project the phone can start a chat in: its name and colour, never its
/// folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRowDto {
    pub id: usize,
    pub name: String,
    pub hue: f32,
}

pub fn project_rows(state: &AppState) -> Vec<ProjectRowDto> {
    state
        .projects
        .iter()
        .map(|project| ProjectRowDto {
            id: project.id,
            name: project.name.clone(),
            hue: project.hue,
        })
        .collect()
}

/// Every session, newest activity first.
pub fn session_rows(state: &AppState) -> Vec<SessionRowDto> {
    let mut rows: Vec<SessionRowDto> = state
        .order
        .iter()
        .filter_map(|id| session_row(state, *id))
        .collect();
    rows.sort_by_key(|row| std::cmp::Reverse(row.last_activity_ms));
    rows
}

/// A window of a session's transcript: the `limit` entries before `before`
/// (the newest `limit` without it), with the turn state around them.
///
/// Shaped like the window's `TranscriptDto`, so the phone runs the very same
/// fold over it, plus where the window sits (`start`, `total`), the stream
/// position it is consistent with (`epoch`, `seq`), and the session's
/// decision answers.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptWindowDto {
    pub epoch: String,
    pub seq: u64,
    pub start: usize,
    pub total: usize,
    pub entries: Vec<Value>,
    pub state: &'static str,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub pending: Option<PendingDto>,
    pub pending_list: Vec<PendingDto>,
    pub total_cost_usd: f64,
    pub last_turn_ms: u64,
    pub usage: SessionUsageDto,
    pub decision_responses: std::collections::BTreeMap<String, Value>,
}

pub fn transcript_window(
    session: &ManagedSession,
    limit: usize,
    before: Option<usize>,
    epoch: String,
    seq: u64,
) -> TranscriptWindowDto {
    let transcript = &session.transcript;
    let total = transcript.entries.len();
    let end = before.unwrap_or(total).min(total);
    let start = end.saturating_sub(limit);
    let pending_list = pending_list(transcript);
    TranscriptWindowDto {
        epoch,
        seq,
        start,
        total,
        entries: transcript.entries[start..end]
            .iter()
            .map(entry_value)
            .collect(),
        state: turn_state_name(transcript.state),
        session_id: transcript.session_id.clone(),
        model: transcript.model.clone(),
        tools: Vec::new(),
        pending: pending_list.first().cloned(),
        pending_list,
        total_cost_usd: transcript.total_cost_usd,
        last_turn_ms: transcript.last_turn_ms,
        usage: SessionUsageDto::from(&transcript.usage),
        decision_responses: session.decisions.clone(),
    }
}

/// One entry, with a long tool output cut down to what a card shows and its
/// real size alongside (`outputBytes`).
fn entry_value(entry: &TranscriptEntry) -> Value {
    let mut value = serde_json::to_value(EntryDto::from(entry)).unwrap_or(Value::Null);
    if let TranscriptEntry::Tool(call) = entry {
        if let Some(output) = call.output.as_deref() {
            if output.len() > SNAPSHOT_OUTPUT_LIMIT {
                value["output"] = Value::String(
                    crate::sync::utf8_prefix(output, SNAPSHOT_OUTPUT_LIMIT).to_string(),
                );
                value["outputBytes"] = Value::from(output.len());
            }
        }
    }
    value
}

#[cfg(test)]
mod tests {
    use super::*;
    use egant_harness::ToolCall;
    use serde_json::json;

    fn session_with(entries: Vec<TranscriptEntry>) -> ManagedSession {
        let mut transcript = egant_harness::Transcript::new();
        transcript.entries = entries;
        ManagedSession {
            meta: crate::state::SessionMeta {
                id: 1,
                title: "t".into(),
                title_source: crate::state::TitleSource::User,
                project_id: 0,
                cwd: "/tmp".into(),
                branch: None,
                started_unix_ms: 1,
                agent: egant_harness::AgentId::Claude,
                cli_agent: None,
                model: None,
                variant: None,
                context: None,
                permission_mode: egant_harness::PermissionMode::Auto,
                worktree: None,
                device: None,
                ended: false,
            },
            transcript,
            commands: None,
            allowed_patterns: Vec::new(),
            last_user_text: None,
            last_user_images: Vec::new(),
            turn_baseline: None,
            decisions: Default::default(),
            last_activity_ms: 1,
            queued: Default::default(),
            flush_next_end: false,
        }
    }

    fn user(n: usize) -> TranscriptEntry {
        TranscriptEntry::User {
            text: format!("message {n}"),
        }
    }

    #[test]
    fn the_window_is_the_newest_entries_and_says_where_it_sits() {
        let session = session_with((0..10).map(user).collect());
        let window = transcript_window(&session, 4, None, "e".into(), 7);
        assert_eq!((window.start, window.total, window.seq), (6, 10, 7));
        assert_eq!(window.entries.len(), 4);
        assert_eq!(window.entries[0]["text"], "message 6");

        let earlier = transcript_window(&session, 4, Some(6), "e".into(), 7);
        assert_eq!(earlier.start, 2);
        assert_eq!(earlier.entries[3]["text"], "message 5");

        let first = transcript_window(&session, 4, Some(2), "e".into(), 7);
        assert_eq!((first.start, first.entries.len()), (0, 2));
    }

    #[test]
    fn a_long_tool_output_is_capped_with_its_real_size_alongside() {
        let big = "x".repeat(SNAPSHOT_OUTPUT_LIMIT * 3);
        let session = session_with(vec![
            TranscriptEntry::Tool(ToolCall {
                id: "t1".into(),
                name: "Read".into(),
                input: json!({"file_path": "/tmp/a"}),
                output: Some(big.clone()),
                is_error: false,
            }),
            TranscriptEntry::Tool(ToolCall {
                id: "t2".into(),
                name: "Bash".into(),
                input: json!({"command": "ls"}),
                output: Some("a\nb".into()),
                is_error: false,
            }),
        ]);
        let window = transcript_window(&session, 10, None, "e".into(), 0);
        let capped = &window.entries[0];
        assert_eq!(capped["kind"], "tool");
        assert_eq!(capped["outputBytes"], big.len());
        assert_eq!(
            capped["output"].as_str().unwrap().len(),
            SNAPSHOT_OUTPUT_LIMIT
        );
        let small = &window.entries[1];
        assert_eq!(small["output"], "a\nb");
        assert!(small.get("outputBytes").is_none());
    }
}
