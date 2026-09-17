//! The window's root state.
//!
//! The Tauri equivalent of the GPUI `Workspace`: it is the only thing that
//! knows what is selected. The frontend is handed flattened DTOs and reports
//! clicks back as commands, so there is never a second answer to "which
//! session is open".

use async_channel::Sender;
use egant_harness::{AgentId, PermissionMode, Transcript, TurnState};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use crate::dto::{SessionDto, StateDto, permission_mode_name};
use crate::persist;
use crate::project::{Project, ProjectId};
use crate::sessions::SessionCommand;
use crate::settings::Settings;

pub struct SessionMeta {
    pub id: u64,
    pub title: String,
    pub project_id: usize,
    pub cwd: PathBuf,
    /// Branch the working directory was on at startup, read through
    /// `egant-vcs` rather than a `git` subprocess so opening a session never
    /// waits on a process spawn.
    pub branch: Option<String>,
    pub     started_unix_ms: u64,
    /// Which agent runs this session. Fixed at creation: switching mid-stream
    /// would orphan the backend's own session on the other CLI.
    pub agent: AgentId,
    /// Set when this session is the agent's *own* CLI running in a terminal
    /// rather than a harness feeding the chat UI, holding the install
    /// catalog's id for it (`pi`, `goose`, `claude`, …).
    ///
    /// A separate field rather than a flag on `agent` because the catalog is
    /// wider than [`AgentId`]: egant can open a terminal onto any CLI it
    /// knows how to find, including the two dozen it has no harness for. For
    /// those, `agent` is only a placeholder — nothing reads it, because
    /// nothing drives a CLI session's turns.
    pub cli_agent: Option<String>,
    /// Model override requested at creation (`--model`/`-m`). `None` keeps
    /// the CLI default.
    pub model: Option<String>,
    /// Context window override requested at creation (Codex:
    /// `-c model_context_window=N`). `None` keeps the CLI default.
    pub context: Option<u64>,
    /// How much freedom the agent has. Mirrors what the driver last sent, so
    /// the composer's mode chip reads the same value the agent runs under.
    pub permission_mode: PermissionMode,
    pub ended: bool,
}

pub struct ManagedSession {
    pub meta: SessionMeta,
    pub transcript: Transcript,
    pub commands: Option<Sender<SessionCommand>>,
}

pub struct AppState {
    pub(crate) projects: Vec<Project>,
    pub(crate) active_project: Option<usize>,
    pub(crate) next_project_id: usize,
    pub(crate) sessions: HashMap<u64, ManagedSession>,
    pub(crate) order: Vec<u64>,
    pub(crate) active_session: Option<u64>,
    pub(crate) next_session_id: u64,
    pub(crate) settings: Settings,
    pub(crate) sidebar_visible: bool,
    /// `(agent, model id)` pairs that have already failed with a
    /// model/catalog-shaped error this run — see [`Self::mark_model_bad`].
    /// Deliberately in-memory only: a model this account can't run today
    /// may well work again after a plan change or a CLI update, so this
    /// resets with every launch rather than persisting the judgment forever.
    pub(crate) bad_models: std::collections::HashSet<(AgentId, String)>,
}

impl AppState {
    /// Rebuilds projects and sessions from what the last run left on disk, so
    /// closing the window (or the app crashing) does not throw away every
    /// open folder and every conversation the way it used to when this state
    /// only ever lived in memory.
    ///
    /// Restored sessions come back `ended`: nothing here reconnects a live
    /// `claude`/`codex` process. [`crate::sessions::send_text`] is what
    /// revives one, on the first message sent to it, using the agent's own
    /// `--resume`/`resume <thread>` support and the session id the transcript
    /// already recorded.
    pub fn new() -> Self {
        let mut projects = Vec::new();
        let mut next_project_id = 0;
        for path in persist::load_projects() {
            projects.push(Project::new(next_project_id, path));
            next_project_id += 1;
        }

        let mut sessions = HashMap::new();
        let mut order = Vec::new();
        let mut next_session_id = 1;
        for persisted in persist::load_sessions() {
            let Some(project) = projects.iter().find(|p| p.fs_path() == persisted.meta.project_path)
            else {
                // The project this session belonged to is gone (moved,
                // deleted, or dropped from projects.json by hand) — nothing
                // sensible to reopen it into, so the history is skipped
                // rather than shown with no project to attach to.
                log::warn!(
                    "skipping session {} — project {} no longer open",
                    persisted.meta.id,
                    persisted.meta.project_path.display()
                );
                continue;
            };
            let meta = SessionMeta {
                id: persisted.meta.id,
                title: persisted.meta.title,
                project_id: project.id,
                cwd: persisted.meta.cwd,
                branch: persisted.meta.branch,
                started_unix_ms: persisted.meta.started_unix_ms,
                agent: persisted.meta.agent,
                cli_agent: persisted.meta.cli_agent,
                model: persisted.meta.model,
                context: persisted.meta.context,
                permission_mode: persisted.meta.permission_mode,
                ended: true,
            };
            next_session_id = next_session_id.max(meta.id + 1);
            order.push(meta.id);
            let mut transcript = persisted.transcript;
            // A turn in flight when the app last closed (crash, force-quit)
            // has nothing running behind it any more; left as `Running` or
            // `AwaitingPermission`, the composer would show a spinner or a
            // permission prompt with no process left to answer either one.
            transcript.state = TurnState::Idle;
            transcript.pending_permission = None;
            sessions.insert(
                meta.id,
                ManagedSession {
                    meta,
                    transcript,
                    commands: None,
                },
            );
        }
        // Restored in `started_unix_ms` order; picking up on the most recent
        // conversation (rather than none at all) is what "reopen the app"
        // should feel like.
        let active_session = order.last().copied();
        let active_project = active_session
            .and_then(|id| sessions.get(&id))
            .map(|session| session.meta.project_id)
            .or(projects.first().map(|p| p.id));

        Self {
            projects,
            active_project,
            next_project_id,
            sessions,
            order,
            active_session,
            next_session_id,
            settings: Settings::load(),
            sidebar_visible: true,
            bad_models: std::collections::HashSet::new(),
        }
    }

    /// Records that `model` (as run under `agent`) just failed with a
    /// model/catalog-shaped error — a bad id, or a real model this
    /// account's plan can't run — so the picker can flag it for the rest of
    /// this run instead of the user hitting the exact same wall twice in one
    /// sitting. Never called for errors that aren't about the model itself
    /// (a network blip, an interrupted turn): see the call sites.
    pub(crate) fn mark_model_bad(&mut self, agent: AgentId, model: String) {
        self.bad_models.insert((agent, model));
    }

    /// Writes the current project list to disk. Call after any change to
    /// `projects` — a project opened and never saved is a project the next
    /// launch cannot find its sessions' folder for.
    pub(crate) fn persist_projects(&self) {
        let paths: Vec<_> = self.projects.iter().map(Project::fs_path).collect();
        persist::save_projects(&paths);
    }

    /// Writes one session's meta and transcript to disk, keyed by its
    /// project's path rather than the in-memory project id (ids are
    /// reassigned every launch).
    pub(crate) fn persist_session(&self, id: u64) {
        let Some(session) = self.sessions.get(&id) else { return };
        let Some(project) = self.project(session.meta.project_id) else {
            return;
        };
        let meta = persist::PersistedMeta {
            id: session.meta.id,
            title: session.meta.title.clone(),
            project_path: project.fs_path(),
            cwd: session.meta.cwd.clone(),
            branch: session.meta.branch.clone(),
            started_unix_ms: session.meta.started_unix_ms,
            agent: session.meta.agent,
            cli_agent: session.meta.cli_agent.clone(),
            model: session.meta.model.clone(),
            context: session.meta.context,
            permission_mode: session.meta.permission_mode,
        };
        persist::save_session(&meta, &session.transcript);
    }

    /// Everything the window draws, gathered in one pass.
    pub fn snapshot(&self) -> StateDto {
        StateDto {
            projects: self.projects.clone(),
            active_project: self.active_project,
            sessions: self
                .order
                .iter()
                .filter_map(|id| self.sessions.get(id))
                .map(session_dto)
                .collect(),
            active_session: self.active_session,
            machine_name: machine_name(),
            settings: self.settings.dto(),
            sidebar_visible: self.sidebar_visible,
            bad_models: bad_models_dto(&self.bad_models),
        }
    }

    /// Adds a folder as a project and selects it. Re-opening a folder selects
    /// the one already there rather than stacking a duplicate row.
    pub fn add_project(&mut self, path: PathBuf) -> Result<usize, String> {
        if !path.is_dir() {
            return Err(format!("{} is not a folder", path.display()));
        }
        if let Some(existing) = self.projects.iter().find(|p| p.fs_path() == path) {
            self.active_project = Some(existing.id);
            return Ok(existing.id);
        }

        let id = self.next_project_id;
        self.next_project_id += 1;
        self.projects.push(Project::new(id, path));
        self.active_project = Some(id);
        self.persist_projects();
        Ok(id)
    }

    pub fn select_project(&mut self, id: usize) -> bool {
        if self.projects.iter().all(|p| p.id != id) {
            return false;
        }
        self.active_project = Some(id);

        // Follow the project to its most recent session, if it has one, so
        // switching projects does not leave an unrelated transcript on screen.
        let project = ProjectId(id);
        let _ = project;
        if let Some(session) = self
            .order
            .iter()
            .rposition(|sid| self.sessions.get(sid).is_some_and(|s| s.meta.project_id == id))
            .and_then(|position| self.order.get(position).copied())
        {
            self.active_session = Some(session);
        }
        true
    }

    pub fn project(&self, id: usize) -> Option<&Project> {
        self.projects.iter().find(|p| p.id == id)
    }

    pub fn toggle_sidebar(&mut self) -> bool {
        self.sidebar_visible = !self.sidebar_visible;
        self.sidebar_visible
    }

    /// Unpins the project selection ("All projects" in the sidebar switcher).
    /// The sidebar already lists sessions across every project regardless, so
    /// this only affects the header's label and which project the next
    /// session — via `create_session` — would need a folder picker for.
    pub fn clear_active_project(&mut self) {
        self.active_project = None;
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

/// The computer's friendly name, the way the sidebar writes it
/// (`clean-mac @ Diell's MacBook Air`). macOS keeps that name separate from
/// the network hostname and `scutil` is the only way to read it. Resolved
/// once: renaming the machine mid-session is not worth a subprocess on every
/// snapshot.
fn machine_name() -> String {
    static NAME: OnceLock<String> = OnceLock::new();
    NAME.get_or_init(|| {
        #[cfg(target_os = "macos")]
        if let Some(name) = run("/usr/sbin/scutil", &["--get", "ComputerName"]) {
            return name;
        }
        // `hostname` gives `diells-macbook-air.local`; the suffix is noise in a
        // one-line label.
        run("hostname", &[])
            .map(|host| host.trim_end_matches(".local").to_owned())
            .unwrap_or_else(|| "this machine".to_string())
    })
    .clone()
}

fn run(program: &str, args: &[&str]) -> Option<String> {
    let output = std::process::Command::new(program).args(args).output().ok()?;
    let name = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    (!name.is_empty()).then_some(name)
}

/// `{agent: [modelId, ...]}` — the shape the picker looks up by agent id
/// without needing to know `AgentId` is a Rust enum underneath.
fn bad_models_dto(bad_models: &std::collections::HashSet<(AgentId, String)>) -> HashMap<String, Vec<String>> {
    let mut by_agent: HashMap<String, Vec<String>> = HashMap::new();
    for (agent, model) in bad_models {
        by_agent.entry(agent.as_str().to_string()).or_default().push(model.clone());
    }
    by_agent
}

fn session_dto(session: &ManagedSession) -> SessionDto {
    let meta = &session.meta;
    SessionDto {
        id: meta.id,
        title: meta.title.clone(),
        project_id: meta.project_id,
        cwd: meta.cwd.display().to_string(),
        branch: meta.branch.clone(),
        started_unix_ms: meta.started_unix_ms,
        permission_mode: permission_mode_name(meta.permission_mode),
        // A CLI session names the catalog agent it opened, which is often
        // one `AgentId` has no variant for; everything downstream (the
        // sidebar glyph, the header's label) keys off this string, so it is
        // the one place the two registries have to agree.
        kind: if meta.cli_agent.is_some() { "cli" } else { "chat" },
        agent: meta
            .cli_agent
            .clone()
            .unwrap_or_else(|| meta.agent.as_str().to_string()),
        model_override: meta.model.clone(),
        context: meta.context,
        ended: meta.ended,
        busy: session.transcript.is_busy(),
        model: session.transcript.model.clone(),
        total_cost_usd: session.transcript.total_cost_usd,
    }
}
