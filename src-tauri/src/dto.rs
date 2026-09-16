//! The shapes that cross the IPC boundary.
//!
//! `egant-harness` types are vendor-neutral but not serializable, so every one
//! the frontend renders gets a DTO here. Field names are camelCase to match
//! TypeScript conventions; see `src/lib/types.ts` for the mirror.

use egant_harness::{HarnessEvent, PermissionMode, Transcript, TranscriptEntry, TurnState};
use serde::Serialize;
use serde_json::Value;

use crate::project::Project;
use crate::settings::SettingsDto;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EntryDto {
    User {
        text: String,
    },
    Assistant {
        text: String,
        streaming: bool,
    },
    Thinking {
        text: String,
        streaming: bool,
    },
    Tool {
        id: String,
        name: String,
        input: Value,
        output: Option<String>,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    Notice {
        text: String,
        #[serde(rename = "isError")]
        is_error: bool,
    },
}

impl From<&TranscriptEntry> for EntryDto {
    fn from(entry: &TranscriptEntry) -> Self {
        match entry {
            TranscriptEntry::User { text } => EntryDto::User { text: text.clone() },
            TranscriptEntry::Assistant { text, streaming } => EntryDto::Assistant {
                text: text.clone(),
                streaming: *streaming,
            },
            TranscriptEntry::Thinking { text, streaming } => EntryDto::Thinking {
                text: text.clone(),
                streaming: *streaming,
            },
            TranscriptEntry::Tool(call) => EntryDto::Tool {
                id: call.id.clone(),
                name: call.name.clone(),
                input: call.input.clone(),
                output: call.output.clone(),
                is_error: call.is_error,
            },
            TranscriptEntry::Notice { text, is_error } => EntryDto::Notice {
                text: text.clone(),
                is_error: *is_error,
            },
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingDto {
    pub request_id: String,
    pub tool_name: String,
    pub input: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptDto {
    pub entries: Vec<EntryDto>,
    pub state: &'static str,
    pub session_id: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub pending: Option<PendingDto>,
    pub total_cost_usd: f64,
    pub last_turn_ms: u64,
    pub usage: SessionUsageDto,
}

/// What a session has spent, for the meter under the composer. Mirrors
/// [`egant_harness::SessionUsage`], plus the one total the UI would otherwise
/// recompute on every render.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsageDto {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub total_tokens: u64,
    pub turns: u64,
    pub context_tokens: u64,
    pub context_window: u64,
}

impl From<&egant_harness::SessionUsage> for SessionUsageDto {
    fn from(usage: &egant_harness::SessionUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            total_tokens: usage.total_tokens(),
            turns: usage.turns,
            context_tokens: usage.context_tokens,
            context_window: usage.context_window,
        }
    }
}

/// One turn's accounting, as it rides the event stream. The frontend folds
/// these into its own copy of the session totals exactly as the backend does,
/// so a live transcript and a re-fetched one agree.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnUsageDto {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub context_window: u64,
}

impl From<&egant_harness::TurnUsage> for TurnUsageDto {
    fn from(usage: &egant_harness::TurnUsage) -> Self {
        Self {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            cache_read_tokens: usage.cache_read_tokens,
            context_window: usage.context_window,
        }
    }
}

impl From<&Transcript> for TranscriptDto {
    fn from(transcript: &Transcript) -> Self {
        Self {
            entries: transcript.entries.iter().map(EntryDto::from).collect(),
            state: turn_state_name(transcript.state),
            session_id: transcript.session_id.clone(),
            model: transcript.model.clone(),
            tools: transcript.tools.clone(),
            pending: transcript.pending_permission.as_ref().map(|pending| PendingDto {
                request_id: pending.request_id.clone(),
                tool_name: pending.tool_name.clone(),
                input: pending.input.clone(),
            }),
            total_cost_usd: transcript.total_cost_usd,
            last_turn_ms: transcript.last_turn_ms,
            usage: SessionUsageDto::from(&transcript.usage),
        }
    }
}

pub fn turn_state_name(state: TurnState) -> &'static str {
    match state {
        TurnState::Idle => "idle",
        TurnState::Running => "running",
        TurnState::AwaitingPermission => "awaiting_permission",
    }
}

// ---------------------------------------------------------------------------
// Incremental session events (the streaming path)
// ---------------------------------------------------------------------------

/// One [`HarnessEvent`] as the frontend folds it. Mirrors `HarnessEvent`
/// variant-for-variant so the TypeScript fold (`lib/transcript.ts`) can stay a
/// mechanical port of `Transcript::apply`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EventDto {
    Ready {
        session_id: String,
        model: Option<String>,
        cwd: Option<String>,
        tools: Vec<String>,
    },
    AssistantDelta {
        text: String,
    },
    ThinkingDelta {
        text: String,
    },
    AssistantMessage {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        id: String,
        output: String,
        is_error: bool,
    },
    PermissionRequest {
        request_id: String,
        tool_name: String,
        input: Value,
    },
    TurnEnded {
        result: Option<String>,
        is_error: bool,
        duration_ms: u64,
        cost_usd: f64,
        usage: TurnUsageDto,
    },
    Error {
        message: String,
    },
    Exited {
        code: Option<i32>,
    },
}

impl From<&HarnessEvent> for EventDto {
    fn from(event: &HarnessEvent) -> Self {
        match event {
            HarnessEvent::Ready {
                session_id,
                model,
                cwd,
                tools,
            } => EventDto::Ready {
                session_id: session_id.clone(),
                model: model.clone(),
                cwd: cwd.as_ref().map(|path| path.display().to_string()),
                tools: tools.clone(),
            },
            HarnessEvent::AssistantDelta { text } => EventDto::AssistantDelta { text: text.clone() },
            HarnessEvent::ThinkingDelta { text } => EventDto::ThinkingDelta { text: text.clone() },
            HarnessEvent::AssistantMessage { text } => EventDto::AssistantMessage {
                text: text.clone(),
            },
            HarnessEvent::ToolUse { id, name, input } => EventDto::ToolUse {
                id: id.clone(),
                name: name.clone(),
                input: input.clone(),
            },
            HarnessEvent::ToolResult {
                id,
                output,
                is_error,
            } => EventDto::ToolResult {
                id: id.clone(),
                output: output.clone(),
                is_error: *is_error,
            },
            HarnessEvent::PermissionRequest {
                request_id,
                tool_name,
                input,
            } => EventDto::PermissionRequest {
                request_id: request_id.clone(),
                tool_name: tool_name.clone(),
                input: input.clone(),
            },
            HarnessEvent::TurnEnded {
                result,
                is_error,
                duration_ms,
                cost_usd,
                usage,
            } => EventDto::TurnEnded {
                result: result.clone(),
                is_error: *is_error,
                duration_ms: *duration_ms,
                cost_usd: *cost_usd,
                usage: TurnUsageDto::from(usage),
            },
            HarnessEvent::Error { message } => EventDto::Error {
                message: message.clone(),
            },
            HarnessEvent::Exited { code } => EventDto::Exited { code: *code },
        }
    }
}

/// The payload of the `session-event` window event.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionEventPayload {
    pub session_id: u64,
    pub event: EventDto,
}

// ---------------------------------------------------------------------------
// Sessions, projects, whole-window state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDto {
    pub id: u64,
    pub title: String,
    pub project_id: usize,
    pub cwd: String,
    pub branch: Option<String>,
    pub started_unix_ms: u64,
    /// The CLI flag form (`default`, `plan`, `acceptEdits`, `bypassPermissions`).
    pub permission_mode: &'static str,
    /// The agent running this session (`claude`, `codex`, `opencode`).
    pub agent: String,
    /// Model override requested at creation, if any.
    pub model_override: Option<String>,
    /// Context window override requested at creation, if any.
    pub context: Option<u64>,
    pub ended: bool,
    pub busy: bool,
    pub model: Option<String>,
    pub total_cost_usd: f64,
}

pub fn permission_mode_name(mode: PermissionMode) -> &'static str {
    mode.as_cli_arg()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDto {
    pub projects: Vec<Project>,
    pub active_project: Option<usize>,
    pub sessions: Vec<SessionDto>,
    pub active_session: Option<u64>,
    /// The computer's friendly name. Every label that names a place reads
    /// `project @ machine`, so the window says where it is running.
    pub machine_name: String,
    pub settings: SettingsDto,
    pub sidebar_visible: bool,
    /// `{agent: [modelId, ...]}` — models that have already failed with a
    /// model/catalog-shaped error this run (a bad id, or a real model this
    /// account's plan can't run). The picker flags these rather than letting
    /// the same failure happen twice in one sitting; it resets every launch.
    pub bad_models: std::collections::HashMap<String, Vec<String>>,
}

// ---------------------------------------------------------------------------
// Files / git
// ---------------------------------------------------------------------------

/// Where a repository stands: the branch, and whether it has an upstream to
/// push to. The panel's Changes tab heads its sections with it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoStatusDto {
    /// The repository's own root, which is not always the folder the panel was
    /// pointed at — a project can sit inside a larger repository, and git's
    /// paths are relative to this.
    pub root: String,
    pub branch: Option<String>,
    pub head_summary: Option<String>,
    /// Commits ahead of and behind the upstream, when one is configured.
    pub ahead: Option<usize>,
    pub behind: Option<usize>,
    /// Whether the branch has an upstream at all. A branch that doesn't is
    /// offered "Publish" rather than "Push".
    pub published: bool,
    /// First remote's name (`origin`, usually), or `null` when there is none —
    /// which is what decides whether "Commit & Push" is on offer.
    pub remote: Option<String>,
}

/// One row of the workspace panel's file tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntryDto {
    pub name: String,
    /// Absolute path — what the tree expands and what a stage tab opens.
    pub path: String,
    pub is_dir: bool,
}

/// A file as the stage's viewer tab shows it. `binary` and `truncated` are the
/// two honest answers the viewer can give instead of text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentDto {
    pub path: String,
    pub name: String,
    pub text: String,
    /// Size on disk, which `text` may be only the head of.
    pub bytes: u64,
    pub truncated: bool,
    pub binary: bool,
}

/// One row of the panel's Changed or Staged section.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeDto {
    pub path: String,
    /// `added` | `modified` | `deleted` | `renamed` | `untracked` |
    /// `conflicted` — spelled out rather than sent as the `git status --short`
    /// letter, because the row draws an icon from it, not a letter.
    pub status: String,
    /// The `git status --short` letter, for anywhere a glance is enough.
    pub code: String,
    pub staged: bool,
    pub additions: usize,
    pub deletions: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffLineDto {
    pub origin: String,
    pub content: String,
    /// Line number on each side, `null` where the line doesn't exist there.
    /// The split view reads these to put a line in the right column.
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffHunkDto {
    pub header: String,
    pub lines: Vec<DiffLineDto>,
}
