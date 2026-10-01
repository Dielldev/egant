//! Everything the frontend can ask for, as Tauri commands.
//!
//! Conventions: state-changing commands return the fresh [`StateDto`] snapshot
//! so the frontend never has to refetch after acting; errors are plain strings
//! for `invoke` rejection messages. Locks are never held across an `await`.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

use crate::dto::{
    ArchivedSessionDto, ChangeDto, ClaudeUsageDto, CloseResultDto, CommitDto, CommitRefDto,
    ConflictBlockDto, ConflictStatusDto, DiffHunkDto, DiffLineDto, HistoryPageDto, RepoRefDto,
    RepoStatusDto, SendResultDto, StateDto, TranscriptDto, UnmergedFileDto, WorktreeDto,
};
use crate::service::{self, DecisionOutcome};
use crate::sessions;
use crate::settings::{SettingsDto, is_supported_image};
use crate::state::AppState;
use crate::sync::{self, Origin};
use crate::worktrees::{self, CheckoutPlan, Released, SessionWorktree};
use egant_harness::{AgentId, AgentModel, AgentStatus, CatalogStatus, InstallOutcome, UpdateInfo};

type BackendState<'a> = State<'a, Mutex<AppState>>;

// ---------------------------------------------------------------------------
// Whole-window state
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_state(state: BackendState<'_>) -> StateDto {
    log::debug!("get_state");
    state.lock().unwrap().snapshot()
}

#[tauri::command]
async fn add_project(
    app: AppHandle,
    state: BackendState<'_>,
    path: String,
    agent: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
    checkout: Option<CheckoutPlan>,
) -> Result<StateDto, String> {
    log::info!("add_project path={path} agent={agent:?}");
    // Two locked stretches with the (blocking) worktree call between them, so
    // `git worktree add` never runs with the state lock held. See
    // [`cut_worktree`].
    let project_id = {
        let mut guard = state.lock().unwrap();
        // Re-opening a folder that is already open must select it, not stack a
        // duplicate empty session beside it. The path is verified and
        // canonicalized inside `add_project`, so `/tmp/x`, `/private/tmp/x`
        // and a differently cased spelling of the same folder on macOS all
        // land on one row — but that check lives here too so a re-open returns
        // without spawning a second session.
        let incoming = PathBuf::from(&path);
        if let Some(existing) = guard
            .projects
            .iter()
            .find(|p| crate::project::same_project(&p.fs_path(), &incoming))
        {
            let id = existing.id;
            guard.select_project(id);
            return Ok(guard.snapshot());
        }
        guard.add_project(incoming)?
    };

    let worktree = resolve_checkout(&state, project_id, checkout).await?;

    let mut guard = state.lock().unwrap();
    let requested = agent
        .as_deref()
        .and_then(AgentId::from_str)
        .unwrap_or_else(|| default_agent(&guard));
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    let id = sessions::spawn_session(
        &app, &mut guard, project_id, requested, model, variant, context, worktree,
    )
    .map_err(|error| {
        log::error!("add_project spawn failed: {error}");
        error
    })?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(guard.snapshot())
}

#[tauri::command]
fn select_project(state: BackendState<'_>, id: usize) -> Result<StateDto, String> {
    let mut guard = state.lock().unwrap();
    if !guard.select_project(id) {
        log::warn!("select_project unknown project {id}");
        return Err("unknown project".to_string());
    }
    Ok(guard.snapshot())
}

#[tauri::command]
fn toggle_sidebar(state: BackendState<'_>) -> StateDto {
    let mut guard = state.lock().unwrap();
    guard.toggle_sidebar();
    guard.snapshot()
}

#[tauri::command]
fn clear_active_project(state: BackendState<'_>) -> StateDto {
    let mut guard = state.lock().unwrap();
    guard.clear_active_project();
    guard.snapshot()
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

#[tauri::command]
async fn create_session(
    app: AppHandle,
    state: BackendState<'_>,
    agent: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
    checkout: Option<CheckoutPlan>,
) -> Result<StateDto, String> {
    log::info!("create_session agent={agent:?} model={model:?} checkout={checkout:?}");
    let project = {
        let guard = state.lock().unwrap();
        let Some(project) = guard.active_project else {
            log::warn!("create_session with no folder open");
            return Err("open a folder first".to_string());
        };
        project
    };

    let worktree = resolve_checkout(&state, project, checkout).await?;

    let mut guard = state.lock().unwrap();
    let requested = agent
        .as_deref()
        .and_then(AgentId::from_str)
        .unwrap_or_else(|| default_agent(&guard));
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    let id = sessions::spawn_session(
        &app, &mut guard, project, requested, model, variant, context, worktree,
    )
    .map_err(|error| {
        log::error!("create_session spawn failed: {error}");
        error
    })?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(guard.snapshot())
}

/// Resolves the composer's checkout pick into the worktree a session starts in.
///
/// `plan` is what the chips resolved to; `None` falls back to the saved default
/// (the chip's own remembered state), so a caller that never showed the chips —
/// opening a folder from the sidebar, say — still does what the user last
/// picked. The git work runs on the blocking pool with no lock held: on a large
/// repository `worktree add` writes a whole checkout, and the window has to
/// keep drawing while it does.
async fn resolve_checkout(
    state: &BackendState<'_>,
    project_id: usize,
    plan: Option<CheckoutPlan>,
) -> Result<Option<SessionWorktree>, String> {
    let (plan, project_path) = {
        let guard = state.lock().unwrap();
        let plan = plan.unwrap_or(if guard.settings.worktree_default {
            CheckoutPlan::NewWorktree { base: None }
        } else {
            CheckoutPlan::CurrentCheckout
        });
        if matches!(plan, CheckoutPlan::CurrentCheckout) {
            return Ok(None);
        }
        let Some(project) = guard.project(project_id) else {
            return Err("unknown project".to_string());
        };
        (plan, project.fs_path())
    };
    tauri::async_runtime::spawn_blocking(move || worktrees::prepare(&plan, &project_path))
        .await
        .map_err(|error| error.to_string())?
}

/// Which comparison the Diffs tab is showing. Mirrors the frontend's own
/// `DiffScope`, so the panel's dropdown and the git call behind it are one
/// shape.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum DiffScopeArg {
    /// Uncommitted work: the index against HEAD, and the disk against the
    /// index. `staged` picks the side when one file is being diffed.
    WorkingTree {
        #[serde(default)]
        staged: bool,
    },
    /// Everything this branch adds over the branch it was cut from, the
    /// working tree included.
    Branch { base: Option<String> },
    /// What has changed since the session's current turn began.
    Turn { session: u64 },
    /// One commit, against its first parent.
    Commit { sha: String },
}

/// The point in history a scope measures from. `None` is the working tree
/// itself, which is the one scope that isn't measured from a tree at all.
enum ScopeBase {
    /// A tree id, as `egant-vcs` hands them out.
    Tree(String),
    Commit(String),
}

/// Turns the panel's scope into something git can be asked about.
///
/// Both fallbacks here are deliberate. A branch scope with no base named falls
/// back to the repository's integration branch, because "what does this branch
/// add" has an answer even when nobody said what it was cut from. A turn scope
/// with no baseline yet — no turn has run in this session since the app
/// started — falls back to HEAD, which reads as "everything uncommitted": more
/// than the turn did, never less, and it stops the tab from being empty for a
/// reason the user can't see.
fn resolve_scope(
    state: &BackendState<'_>,
    repo: &egant_vcs::Repo,
    scope: &DiffScopeArg,
) -> Result<Option<ScopeBase>, String> {
    match scope {
        DiffScopeArg::WorkingTree { .. } => Ok(None),
        DiffScopeArg::Commit { sha } => Ok(Some(ScopeBase::Commit(sha.clone()))),
        DiffScopeArg::Branch { base } => {
            let base = base.clone().or_else(|| default_base(repo));
            let Some(base) = base else {
                return Err("nothing to compare this branch against".to_string());
            };
            let tree = repo.merge_base_tree(&base).map_err(|error| {
                format!("could not find where this branch left {base}: {error}")
            })?;
            Ok(Some(ScopeBase::Tree(tree)))
        }
        DiffScopeArg::Turn { session } => {
            let baseline = {
                let guard = state.lock().unwrap();
                guard
                    .sessions
                    .get(session)
                    .and_then(|session| session.turn_baseline.clone())
            };
            match baseline {
                Some(tree) => Ok(Some(ScopeBase::Tree(tree))),
                None => {
                    let head = repo
                        .head_tree()
                        .map_err(|error| error.to_string())?
                        .ok_or_else(|| "this repository has no commits yet".to_string())?;
                    Ok(Some(ScopeBase::Tree(head)))
                }
            }
        }
    }
}

/// The branch a repository integrates into, for a branch scope nobody named a
/// base for: what `origin/HEAD` points at, else the usual two names, else
/// nothing.
fn default_base(repo: &egant_vcs::Repo) -> Option<String> {
    for candidate in ["origin/HEAD", "main", "master"] {
        if repo.has_ref(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// A page of the repository's commit graph, for the panel's History tab.
#[tauri::command]
async fn git_history(
    root: String,
    cursor: Option<usize>,
    limit: Option<usize>,
) -> Result<HistoryPageDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
        let page = repo
            .history(None, cursor.unwrap_or(0), limit.unwrap_or(60).clamp(1, 200))
            .map_err(|error| error.to_string())?;
        Ok(HistoryPageDto {
            commits: page
                .commits
                .into_iter()
                .map(|commit| CommitDto {
                    sha: commit.sha,
                    parents: commit.parents,
                    subject: commit.subject,
                    author_name: commit.author_name,
                    author_email: commit.author_email,
                    authored_unix: commit.authored_unix,
                    refs: commit
                        .refs
                        .into_iter()
                        .map(|reference| CommitRefDto {
                            kind: match reference.kind {
                                egant_vcs::RefKind::Branch => "branch",
                                egant_vcs::RefKind::Remote => "remote",
                                egant_vcs::RefKind::Tag => "tag",
                            },
                            label: reference.label,
                        })
                        .collect(),
                })
                .collect(),
            head_sha: page.head_sha,
            next_cursor: page.next_cursor,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Local branches, most recently committed to first, each saying where it is
/// checked out — the composer's ref picker.
#[tauri::command]
async fn repo_refs(root: String) -> Result<Vec<RepoRefDto>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
        let store = egant_vcs::WorktreeStore::with_default_base(repo.root());
        let refs = store.refs().map_err(|error| error.to_string())?;
        Ok(refs
            .into_iter()
            .map(|row| RepoRefDto {
                name: row.name,
                current: row.current,
                worktree_path: row.worktree_path.map(|path| path.display().to_string()),
            })
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Opens a session that runs `agent`'s own CLI in a terminal instead of
/// driving it through a harness — the only way to reach the agents egant has
/// no harness for, and the opt-out for the three it does.
///
/// Errors when the CLI isn't installed, so the picker can say which agent
/// and why rather than opening a terminal onto "command not found".
#[tauri::command]
async fn create_cli_session(
    app: AppHandle,
    state: BackendState<'_>,
    agent: String,
    checkout: Option<CheckoutPlan>,
) -> Result<StateDto, String> {
    log::info!("create_cli_session agent={agent} checkout={checkout:?}");
    let project = {
        let guard = state.lock().unwrap();
        let Some(project) = guard.active_project else {
            log::warn!("create_cli_session with no folder open");
            return Err("open a folder first".to_string());
        };
        project
    };

    let worktree = resolve_checkout(&state, project, checkout).await?;

    let mut guard = state.lock().unwrap();
    let id =
        sessions::spawn_cli_session(&mut guard, project, &agent, worktree).map_err(|error| {
            log::error!("create_cli_session failed: {error}");
            error
        })?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(guard.snapshot())
}

/// The agent new sessions start with: the explicit pick, else the saved
/// default, else Claude. Unknown ids degrade to Claude rather than bricking
/// session creation.
fn default_agent(state: &AppState) -> AgentId {
    AgentId::from_str(&state.settings.default_agent).unwrap_or(AgentId::Claude)
}

#[tauri::command]
fn select_session(state: BackendState<'_>, id: u64) -> Result<StateDto, String> {
    let mut guard = state.lock().unwrap();
    if !guard.sessions.contains_key(&id) {
        log::warn!("select_session unknown session {id}");
        return Err("unknown session".to_string());
    }
    guard.active_session = Some(id);
    // Selecting a session also moves the project selection to its owner, so
    // the sidebar header names the project the transcript belongs to.
    if let Some(session) = guard.sessions.get(&id) {
        let project = session.meta.project_id;
        guard.active_project = Some(project);
    }
    Ok(guard.snapshot())
}

/// Closes a session and gives its worktree back, when it had one.
///
/// `force` is the user answering "delete it anyway" to a worktree that was
/// kept; without it the decision is [`worktrees::release`]'s, and a checkout
/// holding work is left on disk with a notice saying where.
#[tauri::command]
async fn close_session(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    force: Option<bool>,
) -> Result<CloseResultDto, String> {
    let worktree = {
        let mut guard = state.lock().unwrap();
        let worktree = sessions::close_session(&mut guard, id);
        sync::session_removed(&app, id, &Origin::Desktop);
        worktree
    };

    let (notice, kept) = release_closed_worktree(worktree, force.unwrap_or(false)).await?;

    let snapshot = state.lock().unwrap().snapshot();
    Ok(CloseResultDto {
        state: snapshot,
        notice,
        kept,
    })
}

/// Archives a session: out of the window and its agent stopped, but kept on
/// disk to be restored or deleted from Settings → Archived. What the sidebar's
/// corner button does, with an Undo right after.
#[tauri::command]
fn archive_session(app: AppHandle, state: BackendState<'_>, id: u64) -> Result<StateDto, String> {
    let mut guard = state.lock().unwrap();
    sessions::archive_session(&mut guard, id).map_err(|error| {
        log::error!("archive_session {id} failed: {error}");
        error
    })?;
    // For a phone listing it, an archived session is simply gone.
    sync::session_removed(&app, id, &Origin::Desktop);
    Ok(guard.snapshot())
}

/// Renames a session to what the user typed; nothing generated replaces it
/// afterwards. Answers with the title as saved (whitespace collapsed).
#[tauri::command]
fn rename_session(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    title: String,
) -> Result<String, String> {
    let mut guard = state.lock().unwrap();
    let title = sessions::rename_session(&mut guard, id, &title)?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(title)
}

/// Brings an archived session back and selects it (Undo, or Restore in
/// Settings → Archived).
#[tauri::command]
fn unarchive_session(app: AppHandle, state: BackendState<'_>, id: u64) -> Result<StateDto, String> {
    let mut guard = state.lock().unwrap();
    sessions::unarchive_session(&mut guard, id).map_err(|error| {
        log::error!("unarchive_session {id} failed: {error}");
        error
    })?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(guard.snapshot())
}

/// Every archived session, most recently archived first. Read off the main
/// thread: it opens one file per session.
#[tauri::command]
async fn list_archived_sessions() -> Result<Vec<ArchivedSessionDto>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        crate::persist::list_archived()
            .into_iter()
            .map(|meta| ArchivedSessionDto {
                id: meta.id,
                title: meta.title,
                project_name: egant_harness::project_display_name(&meta.project_path),
                project_path: meta.project_path.display().to_string(),
                kind: if meta.cli_agent.is_some() {
                    "cli"
                } else {
                    "chat"
                },
                agent: meta
                    .cli_agent
                    .unwrap_or_else(|| meta.agent.as_str().to_string()),
                started_unix_ms: meta.started_unix_ms,
                archived_at_ms: meta.archived_at_ms.unwrap_or_default(),
                branch: meta
                    .worktree
                    .as_ref()
                    .map(|worktree| worktree.branch.clone())
                    .or(meta.branch),
                worktree: meta.worktree.as_ref().map(worktree_dto),
                device: meta.device,
            })
            .collect()
    })
    .await
    .map_err(|error| error.to_string())
}

/// Deletes an archived session for good, giving its worktree back the way
/// closing did: a checkout holding work is kept, with a notice saying where,
/// unless `force` — the notice's "Delete it anyway".
#[tauri::command]
async fn delete_archived_session(
    state: BackendState<'_>,
    id: u64,
    force: Option<bool>,
) -> Result<CloseResultDto, String> {
    let worktree =
        tauri::async_runtime::spawn_blocking(move || sessions::delete_archived_session(id))
            .await
            .map_err(|error| error.to_string())??;
    let (notice, kept) = release_closed_worktree(worktree, force.unwrap_or(false)).await?;
    let snapshot = state.lock().unwrap().snapshot();
    Ok(CloseResultDto {
        state: snapshot,
        notice,
        kept,
    })
}

/// Gives back the worktree of a session that was just forgotten, off the UI
/// thread. Answers with what the user should hear: nothing when the checkout
/// went with the conversation (or was never egant's), or where it was kept
/// and why.
async fn release_closed_worktree(
    worktree: Option<SessionWorktree>,
    force: bool,
) -> Result<(Option<String>, Option<WorktreeDto>), String> {
    let Some(worktree) = worktree else {
        return Ok((None, None));
    };
    let dto = worktree_dto(&worktree);
    let released =
        tauri::async_runtime::spawn_blocking(move || worktrees::release(&worktree, force))
            .await
            .map_err(|error| error.to_string())?;
    Ok(match released {
        // The expected outcomes, neither worth a line on screen: the
        // checkout went with the conversation, or it was never egant's.
        Released::Removed { .. } | Released::NotOurs => (None, None),
        Released::Kept { why, path } => (
            Some(format!("Kept the worktree at {} — {why}.", path.display())),
            Some(dto),
        ),
    })
}

/// Removes a worktree that closing its session decided to keep — the
/// "Delete it anyway" the notice offers, once the user has seen what is in it.
///
/// Takes the worktree's own fields rather than a session id because by the
/// time this can be called the session that owned it is gone.
#[tauri::command]
async fn discard_worktree(
    repo_root: String,
    path: String,
    branch: String,
    base: String,
) -> Result<(), String> {
    log::info!("discard_worktree {branch} at {path}");
    let worktree = SessionWorktree {
        name: Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        repo_root: PathBuf::from(repo_root),
        path: PathBuf::from(path),
        branch,
        base,
        // Only a worktree egant made can end up here: a borrowed one is never
        // kept back, so the notice that offers this never names one.
        owned: true,
    };
    tauri::async_runtime::spawn_blocking(move || worktrees::release(&worktree, true))
        .await
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn worktree_dto(worktree: &SessionWorktree) -> WorktreeDto {
    WorktreeDto {
        path: worktree.path.display().to_string(),
        branch: worktree.branch.clone(),
        name: worktree.name.clone(),
        base: worktree.base.clone(),
        repo_root: worktree.repo_root.display().to_string(),
    }
}

/// Sends a turn, returning the session's new title when the turn renamed it
/// (see [`sessions::send_text`]) so the sidebar can pick it up right away.
/// Takes `app` because a session with no live process — ended, or just
/// restored from disk on launch — is revived here rather than dropping the
/// message.
#[tauri::command]
fn send_message(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    text: String,
    images: Option<Vec<String>>,
) -> Result<SendResultDto, String> {
    let images: Vec<PathBuf> = images
        .unwrap_or_default()
        .into_iter()
        .map(PathBuf::from)
        .collect();
    log::info!(
        "send_message session {id} ({} chars, {} image(s))",
        text.len(),
        images.len()
    );
    let mut guard = state.lock().unwrap();
    let outcome = service::send_message(&app, &mut guard, id, text, images, &Origin::Desktop)
        .map_err(|error| {
            log::error!("send_message session {id} failed: {error}");
            error
        })?;
    Ok(SendResultDto {
        title: outcome.title,
        queued: outcome.queued,
        queue: guard
            .sessions
            .get(&id)
            .map(sessions::queue_dto)
            .unwrap_or_default(),
    })
}

/// Takes a queued message back out — to edit it, or to drop it. Answers with
/// its text (for the composer), or `null` when it already went out.
#[tauri::command]
fn unqueue_message(
    state: BackendState<'_>,
    id: u64,
    queued_id: u64,
) -> Result<Option<String>, String> {
    let mut guard = state.lock().unwrap();
    sessions::unqueue_message(&mut guard, id, queued_id)
}

/// Sends a queued message now: straight away when nothing is running, or by
/// stopping the turn that is and sending it the moment that turn ends.
#[tauri::command]
fn send_queued_now(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    queued_id: u64,
) -> Result<SendResultDto, String> {
    let mut guard = state.lock().unwrap();
    let before = guard
        .sessions
        .get(&id)
        .map_or(0, |session| session.transcript.entries.len());
    let outcome = sessions::send_queued_now(&app, &mut guard, id, queued_id)?;
    if outcome.queued {
        sync::interrupted(&app, id, &Origin::Desktop);
    } else {
        sync::transcript_grew(&app, &guard, id, before, &Origin::Desktop);
    }
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(SendResultDto {
        title: outcome.title,
        queued: outcome.queued,
        queue: guard
            .sessions
            .get(&id)
            .map(sessions::queue_dto)
            .unwrap_or_default(),
    })
}

#[tauri::command]
fn interrupt_session(app: AppHandle, state: BackendState<'_>, id: u64) -> Result<(), String> {
    log::info!("interrupt_session {id}");
    let mut guard = state.lock().unwrap();
    service::interrupt(&app, &mut guard, id, &Origin::Desktop).map_err(|error| {
        log::error!("interrupt_session {id} failed: {error}");
        error
    })
}

/// Answers one outstanding request. `decision` is `allow`, `allow-always` or
/// `deny` for an ordinary tool — a deny may carry `feedback` for the agent
/// and `stop` to end the turn — `answer` with `answers` (and `notes`) for a
/// question, or `approve-plan` with the `mode` to carry on in for a plan.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn answer_permission(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    request_id: Option<String>,
    decision: Option<String>,
    // Back-compat with frontends calling `answer_permission(id, allow)`.
    allow: Option<bool>,
    answers: Option<serde_json::Map<String, serde_json::Value>>,
    notes: Option<serde_json::Map<String, serde_json::Value>>,
    feedback: Option<String>,
    stop: Option<bool>,
    mode: Option<String>,
) -> Result<Option<String>, String> {
    let mut guard = state.lock().unwrap();
    if let (Some(request_id), Some(decision)) = (request_id, decision) {
        log::info!("answer_permission session {id} {request_id} {decision}");
        let known = sessions::PermissionAnswer::from_str_name(&decision).is_some()
            || matches!(decision.as_str(), "answer" | "approve-plan");
        if !known {
            // No-op, not an error: an unknown decision string (e.g. a newer
            // frontend than this backend) must not flash the red bar — the
            // row stays and the user can click again.
            log::warn!("answer_permission unknown decision `{decision}`; ignoring");
            return Ok(None);
        }
        let answer = sessions::PermissionAnswer::from_parts(
            &decision,
            answers,
            notes,
            feedback,
            stop,
            mode.as_deref(),
        )?;
        service::answer_permission(&app, &mut guard, id, &request_id, answer, &Origin::Desktop)
            .map(|mode| mode.map(str::to_owned))
    } else if let Some(allow) = allow {
        let answered = sessions::answer_permission_legacy(&mut guard, id, allow)
            .map(|mode| mode.map(str::to_owned));
        sync::permissions(&app, &guard, id, &Origin::Desktop);
        sync::session_touched(&app, &guard, id, &Origin::Desktop);
        answered
    } else {
        // No-op, not an error: a stale or double-clicked row can arrive with
        // nothing to answer (already resolved, session gone). Returning an
        // error here is what flashed the red bar under the composer on every
        // Allow always click — the click had already done its job.
        log::warn!("answer_permission called with no decision; ignoring");
        Ok(None)
    }
}

#[tauri::command]
fn cycle_permission_mode(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
) -> Result<String, String> {
    let mut guard = state.lock().unwrap();
    let mode = sessions::cycle_permission_mode(&mut guard, id)
        .map(str::to_owned)
        .map_err(|error| {
            log::error!("cycle_permission_mode session {id} failed: {error}");
            error
        })?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(mode)
}

/// Jumps straight to a named mode — the composer's mode-info popover uses
/// this so picking a row takes effect immediately, rather than stepping
/// through `cycle_permission_mode` one click at a time.
#[tauri::command]
fn set_permission_mode(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    mode: String,
) -> Result<String, String> {
    let parsed = egant_harness::PermissionMode::from_cli_arg(&mode).ok_or_else(|| {
        log::warn!("set_permission_mode unknown mode `{mode}`");
        format!("unknown permission mode `{mode}`")
    })?;
    let mut guard = state.lock().unwrap();
    let applied = sessions::set_permission_mode(&mut guard, id, parsed).map(str::to_owned)?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(applied)
}

/// Moves a chat session onto another model and effort mid-conversation — the
/// composer's model badge. See [`sessions::set_model`].
#[tauri::command]
fn set_session_model(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
) -> Result<(), String> {
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    let mut guard = state.lock().unwrap();
    sessions::set_model(&app, &mut guard, id, model, variant, context).map_err(|error| {
        log::error!("set_session_model session {id} failed: {error}");
        error
    })?;
    sync::session_touched(&app, &guard, id, &Origin::Desktop);
    Ok(())
}

#[tauri::command]
fn get_transcript(state: BackendState<'_>, id: u64) -> Result<TranscriptDto, String> {
    let guard = state.lock().unwrap();
    let Some(session) = guard.sessions.get(&id) else {
        log::warn!("get_transcript unknown session {id}");
        return Err("unknown session".to_string());
    };
    let mut dto = TranscriptDto::from(&session.transcript);
    dto.decision_responses = session.decisions.clone();
    dto.queued = sessions::queue_dto(session);
    dto.revertible_turns = crate::revert::revertible_turns(&session.turn_snapshots);
    Ok(dto)
}

/// Answers a decision prompt from the window: records the answer and sends
/// `text` as the turn the agent reads. Returns the session's new title when
/// the reply named it, like `send_message`. An answer another device already
/// gave wins — this one is dropped, not sent a second time.
#[tauri::command]
fn answer_decision(
    app: AppHandle,
    state: BackendState<'_>,
    id: u64,
    decision_id: String,
    response: serde_json::Value,
    text: String,
) -> Result<Option<String>, String> {
    if !service::is_decision_response(&response) {
        return Err("not a decision answer".to_string());
    }
    log::info!("answer_decision session {id} {decision_id}");
    let mut guard = state.lock().unwrap();
    match service::answer_decision(
        &app,
        &mut guard,
        id,
        &decision_id,
        response,
        text,
        &Origin::Desktop,
    )? {
        DecisionOutcome::Sent(title) => Ok(title),
        DecisionOutcome::AlreadyAnswered => {
            log::info!("answer_decision session {id} {decision_id}: already answered elsewhere");
            Ok(None)
        }
    }
}

/// One decision answer the window kept in its own storage before the backend
/// kept them.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportedDecision {
    session_id: u64,
    decision_id: String,
    response: serde_json::Value,
}

/// Hands the backend the decision answers an older build kept only in the
/// window, so a phone sees those prompts as answered too. Nothing is sent.
#[tauri::command]
fn import_decision_responses(
    app: AppHandle,
    state: BackendState<'_>,
    answers: Vec<ImportedDecision>,
) -> usize {
    let answers: Vec<_> = answers
        .into_iter()
        .filter(|answer| service::is_decision_response(&answer.response))
        .map(|answer| (answer.session_id, answer.decision_id, answer.response))
        .collect();
    let mut guard = state.lock().unwrap();
    let imported = service::import_decisions(&app, &mut guard, answers);
    if imported > 0 {
        log::info!("imported decision answers for {imported} session(s)");
    }
    imported
}

// ---------------------------------------------------------------------------
// Settings + wallpaper
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_settings(state: BackendState<'_>) -> SettingsDto {
    state.lock().unwrap().settings.dto()
}

#[tauri::command]
fn set_wallpaper(state: BackendState<'_>, path: Option<String>) -> Result<SettingsDto, String> {
    let mut guard = state.lock().unwrap();
    if let Some(path) = &path {
        if !is_supported_image(Path::new(path)) {
            return Err(format!("{path} is not an image this window can draw"));
        }
    }
    guard.settings.set_wallpaper(path.map(PathBuf::from));
    Ok(guard.settings.dto())
}

#[tauri::command]
fn cycle_dim(state: BackendState<'_>) -> SettingsDto {
    let mut guard = state.lock().unwrap();
    guard.settings.cycle_dim();
    guard.settings.dto()
}

#[tauri::command]
fn set_default_agent(state: BackendState<'_>, agent: String) -> Result<SettingsDto, String> {
    if AgentId::from_str(&agent).is_none() {
        log::warn!("set_default_agent unknown agent `{agent}`");
        return Err(format!("unknown agent `{agent}`"));
    }
    let mut guard = state.lock().unwrap();
    guard.settings.set_default_agent(agent);
    Ok(guard.settings.dto())
}

/// Every known agent with its CLI presence and login state. Detection is a
/// filesystem probe, never a spawn, so this stays cheap enough to call on
/// every settings open.
/// The launch screen's worktree toggle: applies to the session about to start
/// and stays as the default for the next one.
#[tauri::command]
fn set_worktree_default(state: BackendState<'_>, on: bool) -> SettingsDto {
    let mut guard = state.lock().unwrap();
    guard.settings.set_worktree_default(on);
    guard.settings.dto()
}

#[tauri::command]
fn list_agents() -> Vec<AgentStatus> {
    let agents = egant_harness::detect_agents();
    log::debug!(
        "list_agents ({} installed)",
        agents.iter().filter(|a| a.installed).count()
    );
    agents
}

/// A live recheck of one agent's login, via the CLI's own status command
/// where one exists fast enough to wait on (Claude, Codex). Settings >
/// Accounts calls this on open, on "Refresh", and while polling after
/// "Add account" — never the composer's hot paths, which stay on the cheap
/// presence-based `list_agents`.
/// Spawns the CLI's own status command, so it runs off the command thread —
/// a plain `fn` command is executed on the main thread, where a slow CLI
/// freezes the whole window until it answers.
#[tauri::command]
async fn check_agent_login(agent: String) -> Result<AgentStatus, String> {
    log::info!("check_agent_login {agent}");
    let id = AgentId::from_str(&agent).ok_or_else(|| format!("unknown agent `{agent}`"))?;
    tauri::async_runtime::spawn_blocking(move || egant_harness::agents::verify_agent(id))
        .await
        .map_err(|error| error.to_string())
        .map(|status| {
            log::info!("check_agent_login {agent} connected={}", status.connected);
            status
        })
}

/// Starts an agent's sign-in flow (a browser OAuth tab, or a Terminal window
/// for CLIs whose login needs real keyboard interaction) and returns once
/// it's under way. The frontend polls `check_agent_login` afterward.
#[tauri::command]
fn connect_agent(agent: String) -> Result<(), String> {
    log::info!("connect_agent {agent}");
    let id = AgentId::from_str(&agent).ok_or_else(|| format!("unknown agent `{agent}`"))?;
    // A new login can change what the account is allowed to run (Codex asks
    // the signed-in account for its catalog), so the cached one is dropped
    // rather than served to the picker for the rest of its lifetime.
    egant_harness::models::invalidate_models(id);
    egant_harness::agents::connect(id).map_err(|error| {
        log::error!("connect_agent {agent} failed: {error}");
        error
    })
}

/// Every coding-agent CLI the Agents tab lists, with whether this machine
/// already has it. A filesystem probe like `list_agents`, just over the wider
/// install catalog rather than only the agents egant can drive.
///
/// Async despite being "just" a filesystem probe: resolving a CLI can fall
/// through to the login-shell `PATH` snapshot, which spawns a shell and
/// waits up to six seconds the first time. On the command thread that is a
/// frozen window.
#[tauri::command]
async fn list_agent_catalog() -> Result<Vec<CatalogStatus>, String> {
    log::debug!("list_agent_catalog");
    tauri::async_runtime::spawn_blocking(egant_harness::catalog::list)
        .await
        .map_err(|error| error.to_string())
}

/// Run one catalog entry's own install command. The command comes from the
/// backend's table, never from the caller — the frontend sends an agent id
/// and nothing else. Slow (a network install), so it runs off the command
/// thread; the outcome carries the re-probed row, so the tab can flip the
/// badge without a second round trip.
#[tauri::command]
async fn install_agent(agent: String, method: Option<String>) -> Result<InstallOutcome, String> {
    log::info!("install_agent {agent} method={method:?}");
    let name = agent.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        egant_harness::catalog::install(&agent, method.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("install_agent {name} failed: {error}");
        error
    })?;
    log::info!("install_agent {name} success={}", outcome.success);
    Ok(outcome)
}

/// "Install latest": the same source's update command for an agent that is
/// already here but behind its published release. Separate from
/// `install_agent` because for a package manager the two differ — re-running
/// a bare `npm install -g <pkg>` on a machine that already has it is a
/// no-op.
#[tauri::command]
async fn update_agent(agent: String, method: Option<String>) -> Result<InstallOutcome, String> {
    log::info!("update_agent {agent} method={method:?}");
    let name = agent.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        egant_harness::catalog::update(&agent, method.as_deref())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("update_agent {name} failed: {error}");
        error
    })?;
    log::info!("update_agent {name} success={}", outcome.success);
    Ok(outcome)
}

/// Whether an installed agent's CLI is behind its published release. Two
/// spawns and a network lookup, so the tab calls it per installed agent in
/// the background rather than as part of `list_agent_catalog`.
#[tauri::command]
async fn check_agent_update(agent: String) -> Result<UpdateInfo, String> {
    log::debug!("check_agent_update {agent}");
    let name = agent.clone();
    tauri::async_runtime::spawn_blocking(move || egant_harness::catalog::check_update(&agent))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| {
            log::warn!("check_agent_update {name} failed: {error}");
            error
        })
}

/// The models one agent can run. opencode answers live from its own catalog
/// and Codex asks the signed-in account for its; both cost a CLI spawn, which
/// is why this is `async` + `spawn_blocking` rather than a plain `fn`: a
/// synchronous Tauri command runs on the main thread, so the old version
/// stalled the entire window — every paint, every keystroke — for as long as
/// `opencode models --verbose` or `codex app-server` took to answer. The
/// catalog itself is cached in-process for ten minutes (see
/// `models::list_models`), so repeat calls don't spawn anything at all.
#[tauri::command]
async fn list_models(agent: String) -> Result<Vec<AgentModel>, String> {
    log::debug!("list_models {agent}");
    let id = AgentId::from_str(&agent).ok_or_else(|| format!("unknown agent `{agent}`"))?;
    tauri::async_runtime::spawn_blocking(move || egant_harness::models::list_models(id))
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| {
            log::warn!("list_models {agent} failed: {error}");
            error
        })
}

/// Claude's 5-hour and weekly usage, for the composer's limit pill. `Ok(None)`
/// means Claude isn't logged in on this device — the composer just hides the
/// pill rather than treating it as an error. A network call, so it runs off
/// the command thread the same way the git remote ops do.
#[tauri::command]
async fn claude_usage_limits() -> Result<Option<ClaudeUsageDto>, String> {
    log::debug!("claude_usage_limits");
    tauri::async_runtime::spawn_blocking(|| {
        egant_harness::usage_limits::fetch().map(|usage| usage.map(ClaudeUsageDto::from))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::warn!("claude_usage_limits failed: {error}");
        error
    })
}

/// The wallpaper as a data URL for an `<img>` tag. Reading it here (rather
/// than exposing the filesystem to the webview) keeps the security surface to
/// the one image the user picked.
#[tauri::command]
fn wallpaper_data_url(state: BackendState<'_>) -> Result<Option<String>, String> {
    let guard = state.lock().unwrap();
    let Some(path) = guard.settings.wallpaper.clone() else {
        return Ok(None);
    };
    drop(guard);

    if !path.is_file() {
        return Ok(None);
    }
    let bytes = std::fs::read(&path).map_err(|error| error.to_string())?;
    Ok(Some(format!(
        "data:{};base64,{}",
        mime_for(&path),
        base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
    )))
}

pub(crate) fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| extension.to_ascii_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("svg") => "image/svg+xml",
        Some("bmp") => "image/bmp",
        Some("ico" | "cur") => "image/x-icon",
        Some("tif" | "tiff") => "image/tiff",
        Some("avif") => "image/avif",
        Some("heic" | "heif") => "image/heic",
        _ => "image/jpeg",
    }
}

// ---------------------------------------------------------------------------
// Window appearance
// ---------------------------------------------------------------------------

/// Keeps the native window in step with the Appearance settings: which
/// palette (light/dark) the titlebar and window chrome should render in, and
/// whether the transparent stage is a real macOS frosted-glass blur (Glass:
/// Default/Frosted) or a flat fill (Glass: Opaque). Called once on load and
/// again on every appearance change, so both effects always agree with what
/// the CSS is currently painting.
#[tauri::command]
fn sync_window_appearance(app: AppHandle, dark: bool, glass: bool) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "no main window".to_string())?;
    window
        .set_theme(Some(if dark {
            tauri::Theme::Dark
        } else {
            tauri::Theme::Light
        }))
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    {
        if glass {
            window_vibrancy::apply_vibrancy(
                &window,
                window_vibrancy::NSVisualEffectMaterial::UnderWindowBackground,
                None,
                None,
            )
            .map_err(|error| error.to_string())?;
        } else {
            let _ = window_vibrancy::clear_vibrancy(&window);
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = glass;

    Ok(())
}

// ---------------------------------------------------------------------------
// Git (local ops through libgit2, remotes through the user's own `git`)
// ---------------------------------------------------------------------------

/// What git reports as changed in the project, staged rows first.
#[tauri::command]
fn changes_list(
    state: BackendState<'_>,
    path: String,
    scope: Option<DiffScopeArg>,
) -> Result<Vec<ChangeDto>, String> {
    let repo = egant_vcs::Repo::discover(&path).map_err(|error| {
        log::warn!("changes_list {path} discover failed: {error}");
        error.to_string()
    })?;
    let scope = scope.unwrap_or(DiffScopeArg::WorkingTree { staged: false });
    let changes = match resolve_scope(&state, &repo, &scope)? {
        // The working tree is the only scope with two sides to it — the index
        // and the disk — and the only one the panel can act on.
        None => repo.changes().map_err(|error| {
            log::warn!("changes_list {path} failed: {error}");
            error.to_string()
        })?,
        Some(ScopeBase::Tree(tree)) => repo.changes_since(&tree).map_err(|error| {
            log::warn!("changes_list {path} scope failed: {error}");
            error.to_string()
        })?,
        Some(ScopeBase::Commit(sha)) => repo.commit_changes(&sha).map_err(|error| {
            log::warn!("changes_list {path} commit {sha} failed: {error}");
            error.to_string()
        })?,
    };

    let mut rows: Vec<ChangeDto> = changes
        .into_iter()
        .map(|change| ChangeDto {
            path: change.path.display().to_string(),
            status: status_name(change.status).to_string(),
            code: change.status.code().to_string(),
            staged: change.staged,
            additions: change.additions,
            deletions: change.deletions,
        })
        .collect();

    rows.sort_by(|a, b| b.staged.cmp(&a.staged).then_with(|| a.path.cmp(&b.path)));
    Ok(rows)
}

#[tauri::command]
fn diff_file(
    state: BackendState<'_>,
    root: String,
    path: String,
    scope: Option<DiffScopeArg>,
) -> Result<Vec<DiffHunkDto>, String> {
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    let scope = scope.unwrap_or(DiffScopeArg::WorkingTree { staged: false });
    let staged = matches!(scope, DiffScopeArg::WorkingTree { staged: true });
    let file = Path::new(&path);
    let hunks = match resolve_scope(&state, &repo, &scope)? {
        None => repo.diff(file, staged),
        Some(ScopeBase::Tree(tree)) => repo.diff_since(&tree, file),
        Some(ScopeBase::Commit(sha)) => repo.commit_diff(&sha, file),
    }
    .map_err(|error| error.to_string())?;
    Ok(hunks
        .into_iter()
        .map(|hunk| DiffHunkDto {
            header: hunk.header,
            lines: hunk
                .lines
                .into_iter()
                .map(|line| DiffLineDto {
                    origin: line.origin.to_string(),
                    content: line.content,
                    old_lineno: line.old_lineno,
                    new_lineno: line.new_lineno,
                })
                .collect(),
        })
        .collect())
}

/// The name the panel's row draws its icon from.
fn status_name(status: egant_vcs::FileStatus) -> &'static str {
    use egant_vcs::FileStatus;
    match status {
        FileStatus::Added => "added",
        FileStatus::Modified => "modified",
        FileStatus::Deleted => "deleted",
        FileStatus::Renamed => "renamed",
        FileStatus::Untracked => "untracked",
        FileStatus::Conflicted => "conflicted",
    }
}

/// Branch, upstream distance and first remote, for the Changes tab's header
/// and for deciding whether pushing is even possible.
#[tauri::command]
fn repo_status(path: String) -> Result<RepoStatusDto, String> {
    let repo = egant_vcs::Repo::discover(&path).map_err(|error| error.to_string())?;
    // Deliberately not `snapshot()`: that walks the whole status to collect
    // changes, which `changes_list` is already doing alongside this call.
    let branch = repo.head_branch().map_err(|error| error.to_string())?;
    let head_summary = repo.head_summary().map_err(|error| error.to_string())?;
    let ahead_behind = repo.ahead_behind().ok();
    let published = repo.has_upstream();
    let remote = egant_vcs::remote::remotes(repo.root())
        .ok()
        .and_then(|remotes| {
            // `origin` if it exists, else whatever the repository does have.
            remotes
                .iter()
                .find(|name| *name == "origin")
                .or_else(|| remotes.first())
                .cloned()
        });
    Ok(RepoStatusDto {
        default_base: default_base(&repo),
        root: repo.root().display().to_string(),
        branch,
        head_summary,
        ahead: ahead_behind.map(|(ahead, _)| ahead),
        behind: ahead_behind.map(|(_, behind)| behind),
        published,
        upstream: repo.upstream_branch(),
        last_fetched_unix: repo.last_fetch_unix(),
        remote,
    })
}

/// Throws away working-tree changes. Destructive and unrecoverable, so the
/// panel confirms before calling it.
#[tauri::command]
fn discard_files(root: String, paths: Vec<String>) -> Result<(), String> {
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    repo.discard(&paths).map_err(|error| error.to_string())
}

/// One side of a file as git has it. `source` is `workdir`, `index` or `head`;
/// `None` means that side has no such file, which is what one end of an added
/// or deleted file looks like.
fn blob_bytes(root: &str, path: &Path, source: &str) -> Result<Option<Vec<u8>>, String> {
    if source == "workdir" {
        // The working tree is just the filesystem: a project with no
        // repository at all still has files to show, so this side never asks
        // git for permission. An absolute path (what a file tab carries)
        // replaces the base on `join`, which is exactly right.
        let full = match egant_vcs::Repo::discover(root) {
            Ok(repo) => repo.root().join(path),
            Err(_) => Path::new(root).join(path),
        };
        if !full.is_file() {
            return Ok(None);
        }
        return Ok(Some(
            std::fs::read(full).map_err(|error| error.to_string())?,
        ));
    }

    let repo = egant_vcs::Repo::discover(root).map_err(|error| error.to_string())?;
    let stored = if source == "head" {
        egant_vcs::BlobSource::Head
    } else {
        egant_vcs::BlobSource::Index
    };
    repo.blob(path, stored).map_err(|error| error.to_string())
}

/// One side of a file as a data URL, for the diffs the viewer draws rather
/// than reads: images.
#[tauri::command]
fn blob_data_url(root: String, path: String, source: String) -> Result<Option<String>, String> {
    let file = Path::new(&path);
    Ok(blob_bytes(&root, file, &source)?.map(|bytes| {
        format!(
            "data:{};base64,{}",
            mime_for(file),
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &bytes)
        )
    }))
}

/// One side of a file as text, for the preview a renderable file can offer
/// instead of its diff.
#[tauri::command]
fn blob_text(root: String, path: String, source: String) -> Result<Option<String>, String> {
    Ok(blob_bytes(&root, Path::new(&path), &source)?
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned()))
}

#[tauri::command]
fn stage_files(root: String, paths: Vec<String>) -> Result<(), String> {
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    repo.stage(&paths).map_err(|error| error.to_string())
}

#[tauri::command]
fn unstage_files(root: String, paths: Vec<String>) -> Result<(), String> {
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    let paths: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    repo.unstage(&paths).map_err(|error| error.to_string())
}

#[tauri::command]
fn stage_all(root: String) -> Result<(), String> {
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    repo.stage_all().map_err(|error| error.to_string())
}

#[tauri::command]
fn commit_changes(root: String, message: String) -> Result<String, String> {
    log::info!("commit in {root}");
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    repo.commit(&message)
        .map(|oid| oid.to_string())
        .map_err(|error| {
            log::error!("commit in {root} failed: {error}");
            error.to_string()
        })
}

#[tauri::command]
fn repo_branch(path: String) -> Result<Option<String>, String> {
    let repo = egant_vcs::Repo::discover(&path).map_err(|error| error.to_string())?;
    repo.head_branch().map_err(|error| error.to_string())
}

/// `git pull --ff-only`. Fast-forward only on purpose: a merge commit the user
/// didn't ask for is not something a button should be able to make.
#[tauri::command]
async fn git_pull(root: String, remote: String, branch: String) -> Result<String, String> {
    log::info!("git_pull {remote}/{branch} in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::ensure_clear(Path::new(&root)).map_err(|error| error.to_string())?;
        egant_vcs::remote::pull_ff_only(Path::new(&root), &remote, &branch)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("git_pull failed: {error}");
        error
    })
}

/// Merges the upstream (e.g. `origin/main`) into the current branch.
///
/// Explicit-only companion to `git_pull`: fast-forward pull refuses diverged
/// branches on purpose, so this is the button that says "yes, merge them".
/// Creates a merge commit; conflicts fail with git's own output and leave the
/// tree conflicted for the panel to show.
#[tauri::command]
async fn git_merge(root: String, upstream: String) -> Result<String, String> {
    log::info!("git_merge {upstream} in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::ensure_clear(Path::new(&root)).map_err(|error| error.to_string())?;
        egant_vcs::remote::merge_no_edit(Path::new(&root), &upstream)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("git_merge failed: {error}");
        error
    })
}

/// Rebases the current branch onto its upstream.
///
/// Rewrites local commits — the banner confirms before calling this. A
/// conflict stops mid-rebase for terminal resolution; the error says so.
#[tauri::command]
async fn git_rebase(root: String, upstream: String) -> Result<String, String> {
    log::info!("git_rebase {upstream} in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::ensure_clear(Path::new(&root)).map_err(|error| error.to_string())?;
        egant_vcs::remote::rebase_onto(Path::new(&root), &upstream)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("git_rebase failed: {error}");
        error
    })
}

// ---------------------------------------------------------------------------
// Conflict resolution
// ---------------------------------------------------------------------------

fn operation_name(operation: Option<egant_vcs::OperationKind>) -> &'static str {
    match operation {
        Some(egant_vcs::OperationKind::Merge) => "merge",
        Some(egant_vcs::OperationKind::Rebase) => "rebase",
        None => "none",
    }
}

fn unmerged_kind_name(kind: egant_vcs::UnmergedKind) -> &'static str {
    use egant_vcs::UnmergedKind;
    match kind {
        UnmergedKind::BothModified => "bothModified",
        UnmergedKind::BothAdded => "bothAdded",
        UnmergedKind::BothDeleted => "bothDeleted",
        UnmergedKind::AddedByUs => "addedByUs",
        UnmergedKind::AddedByThem => "addedByThem",
        UnmergedKind::DeletedByUs => "deletedByUs",
        UnmergedKind::DeletedByThem => "deletedByThem",
    }
}

fn parse_side(side: &str) -> Result<egant_vcs::ConflictSide, String> {
    match side {
        "ours" => Ok(egant_vcs::ConflictSide::Ours),
        "theirs" => Ok(egant_vcs::ConflictSide::Theirs),
        "both" => Ok(egant_vcs::ConflictSide::Both),
        other => Err(format!("unknown conflict side {other:?}")),
    }
}

/// Whether a merge/rebase is stalled, and which files it left unmerged — what
/// the conflict toolbar renders itself from.
#[tauri::command]
async fn conflict_status(root: String) -> Result<ConflictStatusDto, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state =
            egant_vcs::conflict::detect(Path::new(&root)).map_err(|error| error.to_string())?;
        Ok(ConflictStatusDto {
            operation: operation_name(state.operation).to_owned(),
            files: state
                .files
                .into_iter()
                .map(|file| UnmergedFileDto {
                    path: file.path.display().to_string(),
                    kind: unmerged_kind_name(file.kind).to_owned(),
                })
                .collect(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

/// The `<<<<<<<`/`=======`/`>>>>>>>` regions in one conflicted file, for the
/// quick-action buttons the inline viewer draws over each one. Empty for a
/// delete conflict, which has no markers to show.
#[tauri::command]
fn conflict_blocks(root: String, path: String) -> Result<Vec<ConflictBlockDto>, String> {
    let full = Path::new(&root).join(&path);
    let text = std::fs::read_to_string(&full).map_err(|error| error.to_string())?;
    Ok(egant_vcs::conflict::parse_markers(&text)
        .into_iter()
        .enumerate()
        .map(|(index, block)| ConflictBlockDto {
            index,
            start_line: block.start_line,
            end_line: block.end_line,
            ours_label: block.ours_label,
            theirs_label: block.theirs_label,
            ours: block.ours,
            theirs: block.theirs,
        })
        .collect())
}

/// Resolves one file entirely to `side` — `resolveWithOurs`/`resolveWithTheirs`
/// from the toolbar's per-file actions, plus `both` for a content conflict.
#[tauri::command]
async fn resolve_conflict_file(root: String, path: String, side: String) -> Result<(), String> {
    log::info!("resolve_conflict_file {path} side={side} in {root}");
    let side = parse_side(&side)?;
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::resolve_file(Path::new(&root), Path::new(&path), side)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Resolves one `<<<<<<<`/`>>>>>>>` block inside a file — the inline viewer's
/// per-conflict quick action, leaving any other block in the same file alone.
#[tauri::command]
async fn resolve_conflict_block(
    root: String,
    path: String,
    index: usize,
    side: String,
) -> Result<(), String> {
    log::info!("resolve_conflict_block {path}#{index} side={side} in {root}");
    let side = parse_side(&side)?;
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::resolve_block(Path::new(&root), Path::new(&path), index, side)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

/// "Keep All Local Changes" / "Accept All Incoming Changes": resolves every
/// currently unmerged file to one side, then finishes the operation the same
/// way `continue_conflict_operation` does.
#[tauri::command]
async fn resolve_all_conflicts(root: String, side: String) -> Result<String, String> {
    log::info!("resolve_all_conflicts side={side} in {root}");
    let side = parse_side(&side)?;
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        egant_vcs::conflict::resolve_all(root, side).map_err(|error| error.to_string())?;
        egant_vcs::conflict::continue_operation(root)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("resolve_all_conflicts failed: {error}");
        error
    })
}

/// `git rebase --continue` / a no-edit merge commit, once every file is clean.
#[tauri::command]
async fn continue_conflict_operation(root: String) -> Result<String, String> {
    log::info!("continue_conflict_operation in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::continue_operation(Path::new(&root))
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("continue_conflict_operation failed: {error}");
        error
    })
}

/// "Abort & Reset": `git merge --abort` or `git rebase --abort`, whichever is
/// actually in progress.
#[tauri::command]
async fn abort_conflict_operation(root: String) -> Result<String, String> {
    log::info!("abort_conflict_operation in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::conflict::abort(Path::new(&root))
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("abort_conflict_operation failed: {error}");
        error
    })
}

/// The first push of a branch that has no upstream yet — `git push -u`.
#[tauri::command]
async fn git_publish(root: String, remote: String, branch: String) -> Result<String, String> {
    log::info!("git_publish {remote}/{branch} in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::remote::push_set_upstream(Path::new(&root), &remote, &branch)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("git_publish failed: {error}");
        error
    })
}

/// Distinguishes two pastes landing in the same millisecond, so the second
/// never silently overwrites the first's file.
static PASTE_SEQ: AtomicU64 = AtomicU64::new(0);

/// Where a pasted image lands so the composer can hand the agent a real
/// `@path` mention: the CLIs read files, not inline clipboard bytes, so a
/// paste needs a file on disk exactly like a dragged-in attachment does.
#[tauri::command]
fn save_pasted_image(data: String, extension: String) -> Result<String, String> {
    let bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &data)
        .map_err(|error| error.to_string())?;
    let dir = std::env::temp_dir().join("egant-pastes");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    let seq = PASTE_SEQ.fetch_add(1, Ordering::Relaxed);
    // The extension crossed the IPC boundary from a clipboard MIME type, so
    // it's untrusted: keep only what a real image extension ever contains,
    // which also rules out it smuggling a path separator or `..`.
    let ext: String = extension
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .take(8)
        .collect();
    let ext = if ext.is_empty() {
        "png".to_string()
    } else {
        ext
    };
    let path = dir.join(format!("pasted-image-{stamp}-{seq}.{ext}"));
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
fn git_remotes(root: String) -> Result<Vec<String>, String> {
    egant_vcs::remote::remotes(Path::new(&root)).map_err(|error| error.to_string())
}

/// Network operations run on a blocking thread: unlike the GPUI shell (where
/// push blocked the UI — a recorded next step), here they never stall input.
#[tauri::command]
async fn git_push(root: String, remote: String, branch: String) -> Result<String, String> {
    log::info!("git_push {remote}/{branch} in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::remote::push(Path::new(&root), &remote, &branch)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("git_push failed: {error}");
        error
    })
}

#[tauri::command]
async fn git_fetch(root: String, remote: String) -> Result<String, String> {
    log::info!("git_fetch {remote} in {root}");
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::remote::fetch(Path::new(&root), &remote)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| {
        log::error!("git_fetch failed: {error}");
        error
    })
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        get_state,
        add_project,
        select_project,
        toggle_sidebar,
        clear_active_project,
        create_session,
        create_cli_session,
        select_session,
        close_session,
        archive_session,
        unarchive_session,
        rename_session,
        list_archived_sessions,
        delete_archived_session,
        discard_worktree,
        send_message,
        unqueue_message,
        send_queued_now,
        interrupt_session,
        answer_permission,
        cycle_permission_mode,
        set_permission_mode,
        set_session_model,
        get_transcript,
        answer_decision,
        import_decision_responses,
        crate::mobile::mobile_status,
        crate::mobile::mobile_set_enabled,
        crate::mobile::mobile_setup_tailscale,
        crate::mobile::mobile_set_public,
        crate::mobile::mobile_create_pairing,
        crate::mobile::mobile_revoke_device,
        get_settings,
        set_wallpaper,
        cycle_dim,
        set_default_agent,
        set_worktree_default,
        list_agents,
        list_agent_catalog,
        install_agent,
        update_agent,
        check_agent_update,
        check_agent_login,
        connect_agent,
        list_models,
        claude_usage_limits,
        wallpaper_data_url,
        sync_window_appearance,
        crate::files::list_dir,
        crate::files::list_files,
        crate::revert::preview_turn_revert,
        crate::revert::revert_turn,
        crate::search::search_transcripts,
        crate::github::gh_status,
        crate::github::pr_list,
        crate::github::pr_detail,
        crate::github::pr_create,
        crate::github::pr_merge,
        crate::github::open_url,
        crate::notifications::open_notification_settings,
        crate::files::read_file,
        crate::files::write_file,
        crate::pty::pty_spawn,
        crate::pty::pty_spawn_agent,
        crate::pty::pty_write,
        crate::pty::pty_resize,
        crate::pty::pty_kill,
        crate::browser::browser_open,
        crate::browser::browser_navigate,
        crate::browser::browser_reload,
        crate::browser::browser_go_back,
        crate::browser::browser_go_forward,
        crate::browser::browser_set_bounds,
        crate::browser::browser_set_visible,
        crate::browser::browser_close,
        changes_list,
        repo_status,
        repo_refs,
        git_history,
        discard_files,
        blob_data_url,
        blob_text,
        save_pasted_image,
        diff_file,
        stage_files,
        unstage_files,
        stage_all,
        commit_changes,
        repo_branch,
        git_remotes,
        git_push,
        git_pull,
        git_merge,
        git_rebase,
        git_publish,
        git_fetch,
        conflict_status,
        conflict_blocks,
        resolve_conflict_file,
        resolve_conflict_block,
        resolve_all_conflicts,
        continue_conflict_operation,
        abort_conflict_operation,
    ]
}
