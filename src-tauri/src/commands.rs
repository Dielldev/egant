//! Everything the frontend can ask for, as Tauri commands.
//!
//! Conventions: state-changing commands return the fresh [`StateDto`] snapshot
//! so the frontend never has to refetch after acting; errors are plain strings
//! for `invoke` rejection messages. Locks are never held across an `await`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, State};

use crate::dto::{
    ChangeDto, ClaudeUsageDto, DiffHunkDto, DiffLineDto, RepoStatusDto, StateDto, TranscriptDto,
};
use crate::sessions;
use crate::settings::{SettingsDto, is_supported_image};
use crate::state::AppState;
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
fn add_project(
    app: AppHandle,
    state: BackendState<'_>,
    path: String,
    agent: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
) -> Result<StateDto, String> {
    log::info!("add_project path={path} agent={agent:?}");
    let mut guard = state.lock().unwrap();
    // Re-opening a folder that is already open must select it, not stack a
    // duplicate empty session beside it. The path is verified and
    // canonicalized inside `add_project`, so `/tmp/x`, `/private/tmp/x` and
    // a differently cased spelling of the same folder on macOS all land on
    // one row — but that check lives here too so a re-open returns without
    // spawning a second session.
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
    let id = guard.add_project(incoming)?;
    let requested = agent
        .as_deref()
        .and_then(AgentId::from_str)
        .unwrap_or_else(|| default_agent(&guard));
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    sessions::spawn_session(&app, &mut guard, id, requested, model, variant, context).map_err(
        |error| {
            log::error!("add_project spawn failed: {error}");
            error
        },
    )?;
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
fn create_session(
    app: AppHandle,
    state: BackendState<'_>,
    agent: Option<String>,
    model: Option<String>,
    variant: Option<String>,
    context: Option<u64>,
) -> Result<StateDto, String> {
    log::info!("create_session agent={agent:?} model={model:?}");
    let mut guard = state.lock().unwrap();
    let Some(project) = guard.active_project else {
        log::warn!("create_session with no folder open");
        return Err("open a folder first".to_string());
    };
    let requested = agent
        .as_deref()
        .and_then(AgentId::from_str)
        .unwrap_or_else(|| default_agent(&guard));
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    sessions::spawn_session(&app, &mut guard, project, requested, model, variant, context).map_err(
        |error| {
            log::error!("create_session spawn failed: {error}");
            error
        },
    )?;
    Ok(guard.snapshot())
}

/// Opens a session that runs `agent`'s own CLI in a terminal instead of
/// driving it through a harness — the only way to reach the agents egant has
/// no harness for, and the opt-out for the three it does.
///
/// Errors when the CLI isn't installed, so the picker can say which agent
/// and why rather than opening a terminal onto "command not found".
#[tauri::command]
fn create_cli_session(state: BackendState<'_>, agent: String) -> Result<StateDto, String> {
    log::info!("create_cli_session agent={agent}");
    let mut guard = state.lock().unwrap();
    let Some(project) = guard.active_project else {
        log::warn!("create_cli_session with no folder open");
        return Err("open a folder first".to_string());
    };
    sessions::spawn_cli_session(&mut guard, project, &agent).map_err(|error| {
        log::error!("create_cli_session failed: {error}");
        error
    })?;
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

#[tauri::command]
fn close_session(state: BackendState<'_>, id: u64) -> Result<StateDto, String> {
    let mut guard = state.lock().unwrap();
    sessions::close_session(&mut guard, id);
    Ok(guard.snapshot())
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
) -> Result<Option<String>, String> {
    let images: Vec<PathBuf> = images.unwrap_or_default().into_iter().map(PathBuf::from).collect();
    log::info!(
        "send_message session {id} ({} chars, {} image(s))",
        text.len(),
        images.len()
    );
    let mut guard = state.lock().unwrap();
    sessions::send_text(&app, &mut guard, id, text, images).map_err(|error| {
        log::error!("send_message session {id} failed: {error}");
        error
    })
}

#[tauri::command]
fn interrupt_session(state: BackendState<'_>, id: u64) -> Result<(), String> {
    log::info!("interrupt_session {id}");
    let mut guard = state.lock().unwrap();
    sessions::interrupt(&mut guard, id).map_err(|error| {
        log::error!("interrupt_session {id} failed: {error}");
        error
    })
}

#[tauri::command]
fn answer_permission(
    state: BackendState<'_>,
    id: u64,
    request_id: Option<String>,
    decision: Option<String>,
    // Back-compat with frontends calling `answer_permission(id, allow)`.
    allow: Option<bool>,
) -> Result<Option<String>, String> {
    let mut guard = state.lock().unwrap();
    if let (Some(request_id), Some(decision)) = (request_id, decision) {
        log::info!("answer_permission session {id} {request_id} {decision}");
        let Some(answer) = sessions::PermissionAnswer::from_str_name(&decision) else {
            // No-op, not an error: an unknown decision string (e.g. a newer
            // frontend than this backend) must not flash the red bar — the
            // row stays and the user can click again.
            log::warn!("answer_permission unknown decision `{decision}`; ignoring");
            return Ok(None);
        };
        sessions::answer_permission(&mut guard, id, &request_id, answer)
            .map(|mode| mode.map(str::to_owned))
    } else if let Some(allow) = allow {
        sessions::answer_permission_legacy(&mut guard, id, allow)
            .map(|mode| mode.map(str::to_owned))
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
fn cycle_permission_mode(state: BackendState<'_>, id: u64) -> Result<String, String> {
    let mut guard = state.lock().unwrap();
    sessions::cycle_permission_mode(&mut guard, id)
        .map(str::to_owned)
        .map_err(|error| {
            log::error!("cycle_permission_mode session {id} failed: {error}");
            error
        })
}

/// Jumps straight to a named mode — the composer's mode-info popover uses
/// this so picking a row takes effect immediately, rather than stepping
/// through `cycle_permission_mode` one click at a time.
#[tauri::command]
fn set_permission_mode(state: BackendState<'_>, id: u64, mode: String) -> Result<String, String> {
    let parsed = egant_harness::PermissionMode::from_cli_arg(&mode).ok_or_else(|| {
        log::warn!("set_permission_mode unknown mode `{mode}`");
        format!("unknown permission mode `{mode}`")
    })?;
    let mut guard = state.lock().unwrap();
    sessions::set_permission_mode(&mut guard, id, parsed).map(str::to_owned)
}

#[tauri::command]
fn get_transcript(state: BackendState<'_>, id: u64) -> Result<TranscriptDto, String> {
    let guard = state.lock().unwrap();
    let Some(session) = guard.sessions.get(&id) else {
        log::warn!("get_transcript unknown session {id}");
        return Err("unknown session".to_string());
    };
    Ok(TranscriptDto::from(&session.transcript))
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
    guard
        .settings
        .set_wallpaper(path.map(PathBuf::from));
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

fn mime_for(path: &Path) -> &'static str {
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
fn changes_list(path: String) -> Result<Vec<ChangeDto>, String> {
    let repo = egant_vcs::Repo::discover(&path).map_err(|error| {
        log::warn!("changes_list {path} discover failed: {error}");
        error.to_string()
    })?;
    let changes = repo.changes().map_err(|error| {
        log::warn!("changes_list {path} failed: {error}");
        error.to_string()
    })?;

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
fn diff_file(root: String, path: String, staged: bool) -> Result<Vec<DiffHunkDto>, String> {
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    let hunks = repo
        .diff(Path::new(&path), staged)
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
        root: repo.root().display().to_string(),
        branch,
        head_summary,
        ahead: ahead_behind.map(|(ahead, _)| ahead),
        behind: ahead_behind.map(|(_, behind)| behind),
        published,
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
        return Ok(Some(std::fs::read(full).map_err(|error| error.to_string())?));
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
    let ext = if ext.is_empty() { "png".to_string() } else { ext };
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
        send_message,
        interrupt_session,
        answer_permission,
        cycle_permission_mode,
        set_permission_mode,
        get_transcript,
        get_settings,
        set_wallpaper,
        cycle_dim,
        set_default_agent,
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
        crate::github::gh_status,
        crate::github::pr_list,
        crate::github::pr_detail,
        crate::github::pr_create,
        crate::github::pr_merge,
        crate::github::open_url,
        crate::files::read_file,
        crate::pty::pty_spawn,
        crate::pty::pty_spawn_agent,
        crate::pty::pty_write,
        crate::pty::pty_resize,
        crate::pty::pty_kill,
        changes_list,
        repo_status,
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
        git_publish,
        git_fetch,
    ]
}
