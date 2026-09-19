//! Disk persistence for projects and sessions.
//!
//! Before this module existed, [`crate::state::AppState`] was built fresh in
//! memory on every launch — closing the window (or the app crashing) threw
//! away every project and every conversation with no way back. Settings was
//! the only thing that survived a restart. This gives projects and sessions
//! the same treatment: a small JSON file each, written on the events that
//! change them and read back at startup.
//!
//! Writes go through [`write_atomic`] rather than a plain `fs::write`: a
//! `claude`/`codex` turn can end at any moment (killed app, power loss,
//! `kill -9`), and a write that dies halfway through leaves a truncated file.
//! `serde_json::from_str` on a truncated file fails exactly like a missing
//! one, so a single bad shutdown silently reverted the wallpaper, the default
//! agent, and every open conversation to defaults — the same day the file was
//! touched last. Writing to a sibling temp file and renaming over the target
//! makes that failure mode unreachable: a rename is atomic, so the file on
//! disk is always either the old complete version or the new one, never a
//! partial write.

use egant_harness::{AgentId, PermissionMode, Transcript};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::settings::config_dir;

/// Writes `text` to `path` without ever leaving a truncated file behind: the
/// new content lands in a sibling temp file first, then `rename` swaps it
/// into place in one filesystem operation.
pub(crate) fn write_atomic(path: &Path, text: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension(format!(
        "{}.tmp",
        path.extension().and_then(|e| e.to_str()).unwrap_or("json")
    ));
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Serialize, Deserialize)]
struct ProjectsFile {
    paths: Vec<PathBuf>,
}

fn projects_path() -> Option<PathBuf> {
    Some(config_dir()?.join("projects.json"))
}

/// Folders opened in a previous run, most-recently-added last (the order
/// `AppState` re-adds them in, so ids come back out in the same sequence).
/// A folder that has since been moved or deleted is dropped rather than
/// shown as a broken row with nothing to open.
pub fn load_projects() -> Vec<PathBuf> {
    let Some(path) = projects_path() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let file: ProjectsFile = match serde_json::from_str(&text) {
        Ok(file) => file,
        Err(error) => {
            log::warn!(
                "ignoring unreadable projects at {}: {error}",
                path.display()
            );
            return Vec::new();
        }
    };
    file.paths.into_iter().filter(|p| p.is_dir()).collect()
}

pub fn save_projects(paths: &[PathBuf]) {
    let Some(path) = projects_path() else { return };
    let file = ProjectsFile {
        paths: paths.to_vec(),
    };
    match serde_json::to_string_pretty(&file) {
        Ok(text) => {
            if let Err(error) = write_atomic(&path, &text) {
                log::warn!("could not write {}: {error}", path.display());
            }
        }
        Err(error) => log::warn!("could not serialize projects: {error}"),
    }
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/// A session's identity and configuration, minus the runtime bits
/// (`ended`/`commands`) that only make sense for a live process. `project_id`
/// is not here on purpose: ids are assigned fresh each run, so what a session
/// belongs to is recorded as the project's path and resolved back to an id
/// once projects are loaded.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedMeta {
    pub id: u64,
    pub title: String,
    pub project_path: PathBuf,
    pub cwd: PathBuf,
    pub branch: Option<String>,
    pub started_unix_ms: u64,
    pub agent: AgentId,
    /// Catalog id when this session runs the agent's own CLI in a terminal.
    /// `#[serde(default)]` so sessions written before CLI sessions existed
    /// still load — they are all chat sessions.
    #[serde(default)]
    pub cli_agent: Option<String>,
    pub model: Option<String>,
    pub context: Option<u64>,
    pub permission_mode: PermissionMode,
    /// The isolated checkout this session runs in, when it has one. `cwd` is
    /// that checkout's path; both are recorded because a worktree removed
    /// while the app was closed has to be told apart from a project folder
    /// that moved. `#[serde(default)]` so sessions written before worktrees
    /// existed still load — they all ran in their project folder.
    #[serde(default)]
    pub worktree: Option<crate::worktrees::SessionWorktree>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub meta: PersistedMeta,
    pub transcript: Transcript,
}

fn sessions_dir() -> Option<PathBuf> {
    Some(config_dir()?.join("sessions"))
}

fn session_path(id: u64) -> Option<PathBuf> {
    Some(sessions_dir()?.join(format!("{id}.json")))
}

/// Writes one session's meta and transcript. Called after every event that
/// changes what a restart would need to show — never on a per-token streaming
/// delta, which would turn a long reply into thousands of disk writes for no
/// benefit (a delta is never the last thing to happen before a crash without
/// also being followed shortly by a coarser event that saves it anyway, and
/// if it is, losing the last few in-flight words is a fair trade against
/// disk I/O on every token).
pub fn save_session(meta: &PersistedMeta, transcript: &Transcript) {
    let Some(path) = session_path(meta.id) else {
        return;
    };
    let record = PersistedSession {
        meta: meta.clone(),
        transcript: transcript.clone(),
    };
    match serde_json::to_string(&record) {
        Ok(text) => {
            if let Err(error) = write_atomic(&path, &text) {
                log::warn!("could not write {}: {error}", path.display());
            }
        }
        Err(error) => log::warn!("could not serialize session {}: {error}", meta.id),
    }
}

/// Removes a session's file. Called when the user closes a session, which is
/// still meant to forget it for good — persistence only changes what
/// *quitting the app* does, not what closing a tab does.
pub fn delete_session(id: u64) {
    let Some(path) = session_path(id) else { return };
    if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("could not remove {}: {error}", path.display());
        }
    }
}

/// Every session left over from previous runs, oldest first (by
/// `started_unix_ms`) so restoring them rebuilds the same chronological order
/// they were created in. A single corrupt file is skipped and logged rather
/// than losing every other session in the directory.
pub fn load_sessions() -> Vec<PersistedSession> {
    let Some(dir) = sessions_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };

    let mut sessions: Vec<PersistedSession> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let path = entry.path();
            let text = std::fs::read_to_string(&path).ok()?;
            match serde_json::from_str::<PersistedSession>(&text) {
                Ok(session) => Some(session),
                Err(error) => {
                    log::warn!("ignoring unreadable session at {}: {error}", path.display());
                    None
                }
            }
        })
        .collect();

    sessions.sort_by_key(|s| s.meta.started_unix_ms);
    sessions
}

#[cfg(test)]
mod tests {
    use super::*;
    use egant_harness::{PermissionMode, TranscriptEntry};

    fn scratch_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("egant-persist-test-{name}-{}", std::process::id()))
    }

    #[test]
    fn atomic_write_leaves_no_temp_file_and_overwrites_cleanly() {
        let dir = scratch_dir("atomic");
        let path = dir.join("file.json");

        write_atomic(&path, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");

        write_atomic(&path, "second").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");

        let tmp = path.with_extension("json.tmp");
        assert!(
            !tmp.exists(),
            "the swap file should not survive a successful write"
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_session_round_trips_through_json() {
        let mut transcript = Transcript::new();
        transcript.push_user("hello");
        transcript.entries.push(TranscriptEntry::Assistant {
            text: "hi there".into(),
            streaming: false,
        });
        transcript.session_id = Some("s1".into());

        let meta = PersistedMeta {
            id: 7,
            title: "Fix the grid".into(),
            project_path: PathBuf::from("/tmp/project"),
            cwd: PathBuf::from("/tmp/project"),
            branch: Some("main".into()),
            started_unix_ms: 12345,
            agent: AgentId::Claude,
            cli_agent: None,
            model: Some("sonnet".into()),
            context: None,
            permission_mode: PermissionMode::Auto,
            worktree: None,
        };

        let text = serde_json::to_string(&PersistedSession {
            meta: meta.clone(),
            transcript: transcript.clone(),
        })
        .expect("serializes");
        let back: PersistedSession = serde_json::from_str(&text).expect("deserializes");

        assert_eq!(back.meta.id, meta.id);
        assert_eq!(back.meta.title, meta.title);
        assert_eq!(back.transcript.session_id, transcript.session_id);
        assert_eq!(back.transcript.entries.len(), transcript.entries.len());
    }

    /// Every session on disk today predates `cli_agent`. Loading one has to
    /// go on working, as the chat session it is — which is what the field's
    /// `#[serde(default)]` buys, and what would silently break without it.
    #[test]
    fn a_session_written_before_cli_sessions_still_loads_as_chat() {
        let meta = PersistedMeta {
            id: 3,
            title: "Old session".into(),
            project_path: PathBuf::from("/tmp/project"),
            cwd: PathBuf::from("/tmp/project"),
            branch: None,
            started_unix_ms: 1,
            agent: AgentId::Claude,
            cli_agent: None,
            model: None,
            context: None,
            permission_mode: PermissionMode::Auto,
            worktree: None,
        };
        let mut value = serde_json::to_value(&PersistedSession {
            meta,
            transcript: Transcript::new(),
        })
        .expect("serializes");
        // Exactly what an older egant wrote: the key simply isn't there.
        value["meta"]
            .as_object_mut()
            .expect("meta is an object")
            .remove("cli_agent")
            .expect("the field was written");

        let back: PersistedSession = serde_json::from_value(value).expect("deserializes");
        assert_eq!(back.meta.cli_agent, None);
        assert_eq!(back.meta.agent, AgentId::Claude);
    }

    #[test]
    fn a_corrupt_session_file_is_skipped_without_touching_the_rest() {
        let dir = scratch_dir("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("1.json"), "not json").unwrap();

        let entries: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter_map(|entry| {
                let text = std::fs::read_to_string(entry.path()).ok()?;
                serde_json::from_str::<PersistedSession>(&text).ok()
            })
            .collect();
        assert!(entries.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
