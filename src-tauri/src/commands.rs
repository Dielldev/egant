//! Everything the frontend can ask for, as Tauri commands.
//!
//! Conventions: state-changing commands return the fresh [`StateDto`] snapshot
//! so the frontend never has to refetch after acting; errors are plain strings
//! for `invoke` rejection messages. Locks are never held across an `await`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

use crate::dto::{
    ChangeDto, DiffHunkDto, DiffLineDto, ExplorerEntryDto, StateDto, TranscriptDto,
};
use crate::sessions;
use crate::settings::{SettingsDto, is_supported_image};
use crate::state::AppState;
use egant_harness::{AgentId, AgentModel, AgentStatus};

type BackendState<'a> = State<'a, Mutex<AppState>>;

// ---------------------------------------------------------------------------
// Whole-window state
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_state(state: BackendState<'_>) -> StateDto {
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
    let mut guard = state.lock().unwrap();
    let id = guard.add_project(PathBuf::from(path))?;
    let requested = agent
        .as_deref()
        .and_then(AgentId::from_str)
        .unwrap_or_else(|| default_agent(&guard));
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    sessions::spawn_session(&app, &mut guard, id, requested, model, variant, context)?;
    Ok(guard.snapshot())
}

#[tauri::command]
fn select_project(state: BackendState<'_>, id: usize) -> Result<StateDto, String> {
    let mut guard = state.lock().unwrap();
    if !guard.select_project(id) {
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
    let mut guard = state.lock().unwrap();
    let Some(project) = guard.active_project else {
        return Err("open a folder first".to_string());
    };
    let requested = agent
        .as_deref()
        .and_then(AgentId::from_str)
        .unwrap_or_else(|| default_agent(&guard));
    let model = model.filter(|model| !model.trim().is_empty());
    let variant = variant.filter(|variant| !variant.trim().is_empty());
    let context = context.filter(|n| *n > 0);
    sessions::spawn_session(&app, &mut guard, project, requested, model, variant, context)?;
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
) -> Result<Option<String>, String> {
    let mut guard = state.lock().unwrap();
    sessions::send_text(&app, &mut guard, id, text)
}

#[tauri::command]
fn interrupt_session(state: BackendState<'_>, id: u64) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    sessions::interrupt(&mut guard, id)
}

#[tauri::command]
fn answer_permission(state: BackendState<'_>, id: u64, allow: bool) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    sessions::answer_permission(&mut guard, id, allow)
}

#[tauri::command]
fn cycle_permission_mode(state: BackendState<'_>, id: u64) -> Result<String, String> {
    let mut guard = state.lock().unwrap();
    sessions::cycle_permission_mode(&mut guard, id).map(str::to_owned)
}

/// Jumps straight to a named mode — the composer's mode-info popover uses
/// this so picking a row takes effect immediately, rather than stepping
/// through `cycle_permission_mode` one click at a time.
#[tauri::command]
fn set_permission_mode(state: BackendState<'_>, id: u64, mode: String) -> Result<String, String> {
    let parsed = egant_harness::PermissionMode::from_cli_arg(&mode)
        .ok_or_else(|| format!("unknown permission mode `{mode}`"))?;
    let mut guard = state.lock().unwrap();
    sessions::set_permission_mode(&mut guard, id, parsed).map(str::to_owned)
}

#[tauri::command]
fn get_transcript(state: BackendState<'_>, id: u64) -> Result<TranscriptDto, String> {
    let guard = state.lock().unwrap();
    let Some(session) = guard.sessions.get(&id) else {
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
    egant_harness::detect_agents()
}

/// A live recheck of one agent's login, via the CLI's own status command
/// where one exists fast enough to wait on (Claude, Codex). Settings >
/// Accounts calls this on open, on "Refresh", and while polling after
/// "Add account" — never the composer's hot paths, which stay on the cheap
/// presence-based `list_agents`.
#[tauri::command]
fn check_agent_login(agent: String) -> Result<AgentStatus, String> {
    let id = AgentId::from_str(&agent).ok_or_else(|| format!("unknown agent `{agent}`"))?;
    Ok(egant_harness::agents::verify_agent(id))
}

/// Starts an agent's sign-in flow (a browser OAuth tab, or a Terminal window
/// for CLIs whose login needs real keyboard interaction) and returns once
/// it's under way. The frontend polls `check_agent_login` afterward.
#[tauri::command]
fn connect_agent(agent: String) -> Result<(), String> {
    let id = AgentId::from_str(&agent).ok_or_else(|| format!("unknown agent `{agent}`"))?;
    egant_harness::agents::connect(id)
}

/// The models one agent can run. opencode answers live from its own
/// catalog; Codex and Claude serve curated lists. Slow enough (one CLI
/// spawn) to call on picker open rather than on snapshot.
#[tauri::command]
fn list_models(agent: String) -> Result<Vec<AgentModel>, String> {
    let id = AgentId::from_str(&agent).ok_or_else(|| format!("unknown agent `{agent}`"))?;
    egant_harness::models::list_models(id)
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
// Explorer
// ---------------------------------------------------------------------------

/// How many entries the explorer lists before it stops. The column is a glance
/// at the project, not a file manager, and a node_modules directory would
/// otherwise cost a full directory walk on every call.
const EXPLORER_LIMIT: usize = 500;

#[tauri::command]
fn explorer_list(path: String) -> Result<Vec<ExplorerEntryDto>, String> {
    let entries = std::fs::read_dir(&path).map_err(|error| error.to_string())?;
    let mut rows: Vec<ExplorerEntryDto> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            // Dotfiles are noise at this size; the agent can still see them.
            if name.starts_with('.') {
                return None;
            }
            Some(ExplorerEntryDto {
                is_dir: entry.file_type().is_ok_and(|kind| kind.is_dir()),
                name,
            })
        })
        .take(EXPLORER_LIMIT)
        .collect();

    rows.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then_with(|| a.name.cmp(&b.name)));
    Ok(rows)
}

// ---------------------------------------------------------------------------
// Git (local ops through libgit2, remotes through the user's own `git`)
// ---------------------------------------------------------------------------

/// What git reports as changed in the project, staged rows first.
#[tauri::command]
fn changes_list(path: String) -> Result<Vec<ChangeDto>, String> {
    let repo = egant_vcs::Repo::discover(&path).map_err(|error| error.to_string())?;
    let changes = repo.changes().map_err(|error| error.to_string())?;

    let mut rows: Vec<ChangeDto> = changes
        .into_iter()
        .map(|change| ChangeDto {
            path: change.path.display().to_string(),
            code: change.status.code().to_string(),
            staged: change.staged,
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
                })
                .collect(),
        })
        .collect())
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
    let repo = egant_vcs::Repo::discover(&root).map_err(|error| error.to_string())?;
    repo.commit(&message)
        .map(|oid| oid.to_string())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn repo_branch(path: String) -> Result<Option<String>, String> {
    let repo = egant_vcs::Repo::discover(&path).map_err(|error| error.to_string())?;
    repo.head_branch().map_err(|error| error.to_string())
}

#[tauri::command]
fn git_remotes(root: String) -> Result<Vec<String>, String> {
    egant_vcs::remote::remotes(Path::new(&root)).map_err(|error| error.to_string())
}

/// Network operations run on a blocking thread: unlike the GPUI shell (where
/// push blocked the UI — a recorded next step), here they never stall input.
#[tauri::command]
async fn git_push(root: String, remote: String, branch: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::remote::push(Path::new(&root), &remote, &branch)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn git_fetch(root: String, remote: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        egant_vcs::remote::fetch(Path::new(&root), &remote)
            .map(|output| output.summary().to_owned())
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

pub fn handlers() -> impl Fn(tauri::ipc::Invoke<tauri::Wry>) -> bool + Send + Sync + 'static {
    tauri::generate_handler![
        get_state,
        add_project,
        select_project,
        toggle_sidebar,
        clear_active_project,
        create_session,
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
        check_agent_login,
        connect_agent,
        list_models,
        wallpaper_data_url,
        sync_window_appearance,
        explorer_list,
        changes_list,
        diff_file,
        stage_files,
        unstage_files,
        stage_all,
        commit_changes,
        repo_branch,
        git_remotes,
        git_push,
        git_fetch,
    ]
}
