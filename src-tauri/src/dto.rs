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
        /// What a subagent this call launched did; left out when nothing.
        #[serde(skip_serializing_if = "Vec::is_empty")]
        children: Vec<EntryDto>,
    },
    Notice {
        text: String,
        #[serde(rename = "isError")]
        is_error: bool,
    },
    /// The divider a compaction leaves: everything above it now reaches the
    /// model only as a summary.
    Compaction {
        auto: bool,
        #[serde(rename = "tokensBefore")]
        tokens_before: u64,
        #[serde(rename = "tokensAfter")]
        tokens_after: Option<u64>,
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
                children: call.children.iter().map(EntryDto::from).collect(),
            },
            TranscriptEntry::Notice { text, is_error } => EntryDto::Notice {
                text: text.clone(),
                is_error: *is_error,
            },
            TranscriptEntry::Compaction {
                auto,
                tokens_before,
                tokens_after,
            } => EntryDto::Compaction {
                auto: *auto,
                tokens_before: *tokens_before,
                tokens_after: *tokens_after,
            },
        }
    }
}

/// What a running turn is busy with, for the status line. Mirrors
/// [`egant_harness::TurnProgress`]; `retryAtMs` is Unix time, so every
/// client counts down to the same moment.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ProgressDto {
    Compacting,
    Retrying {
        attempt: u32,
        #[serde(rename = "maxRetries")]
        max_retries: u32,
        #[serde(rename = "retryAtMs")]
        retry_at_ms: u64,
        reason: String,
    },
}

impl From<&egant_harness::TurnProgress> for ProgressDto {
    fn from(progress: &egant_harness::TurnProgress) -> Self {
        match progress {
            egant_harness::TurnProgress::Compacting => ProgressDto::Compacting,
            egant_harness::TurnProgress::Retrying {
                attempt,
                max_retries,
                retry_at_ms,
                reason,
            } => ProgressDto::Retrying {
                attempt: *attempt,
                max_retries: *max_retries,
                retry_at_ms: *retry_at_ms,
                reason: reason.clone(),
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
    pub patterns: Vec<String>,
    pub always_patterns: Vec<String>,
    /// The CLI's own "don't ask again" options, which an "always" answer
    /// hands back (see `egant_harness::always_allow_update`).
    pub suggestions: Vec<Value>,
    /// What the call does, in the agent's words.
    pub description: Option<String>,
    /// The path that made the agent ask, when one did.
    pub blocked_path: Option<String>,
}

impl From<&egant_harness::PendingPermission> for PendingDto {
    fn from(pending: &egant_harness::PendingPermission) -> Self {
        Self {
            request_id: pending.request_id.clone(),
            tool_name: pending.tool_name.clone(),
            input: pending.input.clone(),
            patterns: pending.patterns.clone(),
            always_patterns: pending.always_patterns.clone(),
            suggestions: pending.suggestions.clone(),
            description: pending.description.clone(),
            blocked_path: pending.blocked_path.clone(),
        }
    }
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
    /// Every outstanding request, in arrival order. `pending` mirrors the
    /// first entry for clients written before the table existed.
    #[serde(default)]
    pub pending_list: Vec<PendingDto>,
    pub total_cost_usd: f64,
    pub last_turn_ms: u64,
    pub usage: SessionUsageDto,
    /// Answers to the decision prompts in this transcript, keyed by the
    /// prompt's id. Kept by the backend rather than one window, so every
    /// device sees a prompt answered wherever it was answered.
    pub decision_responses: std::collections::BTreeMap<String, Value>,
    /// Messages waiting for the running turn to end, oldest first.
    pub queued: Vec<QueuedDto>,
    /// What the running turn is busy with, when the agent says.
    pub progress: Option<ProgressDto>,
}

/// One message waiting its turn, as the composer shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueuedDto {
    pub id: u64,
    pub text: String,
    pub image_count: usize,
}

/// The payload of the `session-queue` window event: a session's queue after
/// the app sent the next message in it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionQueuePayload {
    pub session_id: u64,
    pub queued: Vec<QueuedDto>,
}

/// What sending a message did, for the window: the session's new title when
/// it named the session, and its queue when the message joined it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendResultDto {
    pub title: Option<String>,
    pub queued: bool,
    pub queue: Vec<QueuedDto>,
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

/// Every outstanding permission request, in arrival order.
pub fn pending_list(transcript: &Transcript) -> Vec<PendingDto> {
    let pending_list: Vec<PendingDto> = transcript
        .pending_permissions
        .iter()
        .map(PendingDto::from)
        .collect();
    // Backfill from the legacy single slot when the list is empty (a
    // transcript restored from disk written before the table existed
    // can't have one, but a live one always keeps both in step).
    if pending_list.is_empty() {
        transcript
            .pending_permission
            .as_ref()
            .map(PendingDto::from)
            .into_iter()
            .collect()
    } else {
        pending_list
    }
}

impl From<&Transcript> for TranscriptDto {
    fn from(transcript: &Transcript) -> Self {
        let pending_list = pending_list(transcript);
        Self {
            entries: transcript.entries.iter().map(EntryDto::from).collect(),
            state: turn_state_name(transcript.state),
            session_id: transcript.session_id.clone(),
            model: transcript.model.clone(),
            tools: transcript.tools.clone(),
            pending: pending_list.first().cloned(),
            pending_list,
            total_cost_usd: transcript.total_cost_usd,
            last_turn_ms: transcript.last_turn_ms,
            usage: SessionUsageDto::from(&transcript.usage),
            decision_responses: Default::default(),
            queued: Vec::new(),
            progress: transcript.progress.as_ref().map(ProgressDto::from),
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
        #[serde(default)]
        patterns: Vec<String>,
        #[serde(default)]
        always_patterns: Vec<String>,
        suggestions: Vec<Value>,
        description: Option<String>,
        blocked_path: Option<String>,
    },
    /// The mode the agent now runs under, by its CLI flag name.
    ModeChanged {
        mode: &'static str,
    },
    TurnEnded {
        result: Option<String>,
        is_error: bool,
        duration_ms: u64,
        cost_usd: f64,
        usage: TurnUsageDto,
    },
    ContextUpdate {
        context_tokens: u64,
        context_window: u64,
    },
    /// A subagent's step, to fold under the call `parent` names.
    Subagent {
        parent: String,
        event: Box<EventDto>,
    },
    /// What the running turn is busy with, or `null` once that is over.
    Progress {
        progress: Option<ProgressDto>,
    },
    Compacted {
        auto: bool,
        tokens_before: u64,
        tokens_after: Option<u64>,
    },
    ModelFallback {
        from: String,
        to: String,
        message: String,
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
            HarnessEvent::AssistantDelta { text } => {
                EventDto::AssistantDelta { text: text.clone() }
            }
            HarnessEvent::ThinkingDelta { text } => EventDto::ThinkingDelta { text: text.clone() },
            HarnessEvent::AssistantMessage { text } => {
                EventDto::AssistantMessage { text: text.clone() }
            }
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
                patterns,
                always_patterns,
                suggestions,
                description,
                blocked_path,
            } => EventDto::PermissionRequest {
                request_id: request_id.clone(),
                tool_name: tool_name.clone(),
                input: input.clone(),
                patterns: patterns.clone(),
                always_patterns: always_patterns.clone(),
                suggestions: suggestions.clone(),
                description: description.clone(),
                blocked_path: blocked_path.clone(),
            },
            HarnessEvent::ModeChanged { mode } => EventDto::ModeChanged {
                mode: mode.as_cli_arg(),
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
            HarnessEvent::ContextUpdate {
                context_tokens,
                context_window,
            } => EventDto::ContextUpdate {
                context_tokens: *context_tokens,
                context_window: *context_window,
            },
            HarnessEvent::Subagent { parent, event } => EventDto::Subagent {
                parent: parent.clone(),
                event: Box::new(EventDto::from(event.as_ref())),
            },
            HarnessEvent::Progress { progress } => EventDto::Progress {
                progress: progress.as_ref().map(ProgressDto::from),
            },
            HarnessEvent::Compacted {
                auto,
                tokens_before,
                tokens_after,
            } => EventDto::Compacted {
                auto: *auto,
                tokens_before: *tokens_before,
                tokens_after: *tokens_after,
            },
            HarnessEvent::ModelFallback { from, to, message } => EventDto::ModelFallback {
                from: from.clone(),
                to: to.clone(),
                message: message.clone(),
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

/// The payload of the `session-titled` window event: a session's first turn
/// was titled by a small model, replacing the first message's opening line.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTitledPayload {
    pub session_id: u64,
    pub title: String,
}

/// The payload of the `worktree-renamed` window event: a session's first turn
/// said what it is about, and the worktree at `path` moved off its
/// placeholder branch. Every session running there carries the new name.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRenamedPayload {
    pub path: String,
    pub branch: String,
    pub name: String,
    pub previous_branch: String,
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
    /// `chat` — egant renders the turns — or `cli`, where the stage is a
    /// terminal running the agent's own CLI and there is no transcript to
    /// render at all.
    pub kind: &'static str,
    /// The agent running this session. A chat session names one of the
    /// harnesses (`claude`, `codex`, `opencode`); a CLI session names any
    /// agent in the install catalog (`pi`, `goose`, …).
    pub agent: String,
    /// Model the session was started on, or last switched to, if any.
    pub model_override: Option<String>,
    /// Reasoning effort the session runs at, if one was picked.
    pub variant: Option<String>,
    /// Context window override requested at creation, if any.
    pub context: Option<u64>,
    /// The isolated checkout this session runs in, when it has one. `cwd`
    /// already names the same directory; this is what lets the window say
    /// *why* the session is somewhere other than its project folder.
    pub worktree: Option<WorktreeDto>,
    /// The paired phone that started this session, or `None` when it was
    /// started on this machine.
    pub device: Option<String>,
    pub ended: bool,
    /// A turn is in flight or blocked on the user — the composer's stop
    /// button. `state` says which.
    pub busy: bool,
    /// `idle`, `running` or `awaiting_permission`: what the sidebar row says
    /// — "Working" only while the agent really is, "Needs you" while it
    /// waits on an answer.
    pub state: &'static str,
    /// Requests waiting on the user (permissions, questions, plans).
    pub pending_count: usize,
    pub model: Option<String>,
    pub total_cost_usd: f64,
}

/// A session's worktree, as the window draws it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeDto {
    pub path: String,
    /// `egant/quiet-quartz` until the first turn renames it after the
    /// session's subject (`egant/fix-login-flow`).
    pub branch: String,
    /// The branch without its prefix — what the sidebar shows. Not
    /// necessarily the folder's name, which never changes.
    pub name: String,
    /// The branch it was cut from.
    pub base: String,
    /// The repository it belongs to, which is the project folder or a parent
    /// of it.
    pub repo_root: String,
}

/// One row of the repository's commit graph.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDto {
    pub sha: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the epoch, UTC. The window formats it in local time.
    pub authored_unix: i64,
    pub refs: Vec<CommitRefDto>,
}

/// A branch or tag pointing at a commit, as the chip on its row.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRefDto {
    /// `branch` | `remote` | `tag`.
    pub kind: &'static str,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPageDto {
    pub commits: Vec<CommitDto>,
    /// The commit the repository is on, so the list can mark it.
    pub head_sha: Option<String>,
    /// Pass back as `cursor` for the next page; `null` at the end.
    pub next_cursor: Option<usize>,
}

/// One local branch in the composer's ref picker, and where it is checked out.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoRefDto {
    pub name: String,
    /// On the project folder itself right now.
    pub current: bool,
    /// The worktree this branch is checked out in, if any — which is what
    /// makes it startable without any git running at all.
    pub worktree_path: Option<String>,
}

/// One archived session, as Settings → Archived lists it. Read from disk: an
/// archived session has no row in the window's state.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivedSessionDto {
    pub id: u64,
    pub title: String,
    /// The folder it belongs to — restoring needs that project open.
    pub project_path: String,
    pub project_name: String,
    /// As on a session row: a harness, or a catalog agent for a CLI session.
    pub agent: String,
    pub kind: &'static str,
    pub started_unix_ms: u64,
    pub archived_at_ms: u64,
    pub branch: Option<String>,
    /// The worktree kept for it, when it ran in one.
    pub worktree: Option<WorktreeDto>,
    pub device: Option<String>,
}

/// Closing a session answers with the fresh snapshot and, when there was a
/// worktree whose fate the user should know about, a sentence saying so.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseResultDto {
    pub state: StateDto,
    /// `None` when there is nothing worth interrupting the user for — no
    /// worktree, or one that was removed exactly as expected.
    pub notice: Option<String>,
    /// The worktree that was kept, when one was. The session that owned it no
    /// longer exists, so this is what "Delete it anyway" acts on.
    pub kept: Option<WorktreeDto>,
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
// Claude usage limits
// ---------------------------------------------------------------------------

/// One rolling or weekly window's usage, for the composer's limit pill.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowDto {
    pub used_percent: f64,
    /// ISO 8601, or `null` when the endpoint didn't report one.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaudeUsageDto {
    pub five_hour: Option<UsageWindowDto>,
    pub seven_day: Option<UsageWindowDto>,
    pub seven_day_sonnet: Option<UsageWindowDto>,
}

impl From<egant_harness::usage_limits::UsageWindow> for UsageWindowDto {
    fn from(window: egant_harness::usage_limits::UsageWindow) -> Self {
        Self {
            used_percent: window.used_percent,
            resets_at: window.resets_at,
        }
    }
}

impl From<egant_harness::usage_limits::ClaudeUsage> for ClaudeUsageDto {
    fn from(usage: egant_harness::usage_limits::ClaudeUsage) -> Self {
        Self {
            five_hour: usage.five_hour.map(UsageWindowDto::from),
            seven_day: usage.seven_day.map(UsageWindowDto::from),
            seven_day_sonnet: usage.seven_day_sonnet.map(UsageWindowDto::from),
        }
    }
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
    /// What the current branch tracks, e.g. `origin/main`. `None` when it
    /// tracks nothing — which is the same condition `published` reports, but
    /// this names the other end so the panel can say what "Pull" would read.
    pub upstream: Option<String>,
    /// When this repository last fetched from any remote, as seconds since
    /// the epoch. `None` when it never has — the panel reads that as "your
    /// behind count may be stale, fetch to check".
    pub last_fetched_unix: Option<i64>,
    /// First remote's name (`origin`, usually), or `null` when there is none —
    /// which is what decides whether "Commit & Push" is on offer.
    pub remote: Option<String>,
    /// The branch this repository integrates into — what a branch-scope diff
    /// measures against when nothing else names a base. `None` in a repository
    /// with no such branch at all.
    pub default_base: Option<String>,
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
    /// Whether the text survives a round trip through the editor: whole, and
    /// genuinely UTF-8. Anything else opens read-only.
    pub editable: bool,
    /// The file's modification time when it was read — what a save is checked
    /// against so it cannot clobber a newer version.
    pub modified_ms: u64,
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

/// Where a stalled merge/rebase stands, for the conflict toolbar.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictStatusDto {
    /// `merge` | `rebase` | `none`.
    pub operation: String,
    pub files: Vec<UnmergedFileDto>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnmergedFileDto {
    pub path: String,
    /// `bothModified` | `bothAdded` | `bothDeleted` | `addedByUs` |
    /// `addedByThem` | `deletedByUs` | `deletedByThem`.
    pub kind: String,
}

/// One `<<<<<<<`/`=======`/`>>>>>>>` region in a conflicted file, for the
/// inline quick-action buttons over it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConflictBlockDto {
    pub index: usize,
    pub start_line: usize,
    pub end_line: usize,
    pub ours_label: String,
    pub theirs_label: String,
    pub ours: String,
    pub theirs: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // The TypeScript mirror (`src/lib/types.ts`) reads these names as they
    // are: a rename here that it doesn't share would leave the status line
    // and the divider silently blank, not fail to compile.

    #[test]
    fn a_retry_reaches_the_window_in_the_shape_it_reads() {
        let event = HarnessEvent::Progress {
            progress: Some(egant_harness::TurnProgress::Retrying {
                attempt: 2,
                max_retries: 10,
                retry_at_ms: 1_700_000_000_000,
                reason: "rate limited".into(),
            }),
        };
        assert_eq!(
            serde_json::to_value(EventDto::from(&event)).unwrap(),
            json!({"type": "progress", "progress": {"kind": "retrying", "attempt": 2,
                   "maxRetries": 10, "retryAtMs": 1_700_000_000_000u64, "reason": "rate limited"}})
        );
        let done = HarnessEvent::Progress { progress: None };
        assert_eq!(
            serde_json::to_value(EventDto::from(&done)).unwrap(),
            json!({"type": "progress", "progress": null})
        );
    }

    #[test]
    fn a_compaction_reaches_the_window_in_the_shape_it_reads() {
        let event = HarnessEvent::Compacted {
            auto: true,
            tokens_before: 170_000,
            tokens_after: Some(6_000),
        };
        assert_eq!(
            serde_json::to_value(EventDto::from(&event)).unwrap(),
            json!({"type": "compacted", "auto": true, "tokens_before": 170_000, "tokens_after": 6_000})
        );
        let entry = TranscriptEntry::Compaction {
            auto: true,
            tokens_before: 170_000,
            tokens_after: None,
        };
        assert_eq!(
            serde_json::to_value(EntryDto::from(&entry)).unwrap(),
            json!({"kind": "compaction", "auto": true, "tokensBefore": 170_000, "tokensAfter": null})
        );
    }
}
