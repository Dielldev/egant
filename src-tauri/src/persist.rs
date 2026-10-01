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
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Condvar, Mutex, OnceLock};

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
    /// Where the title came from (see `TitleSource`). `#[serde(default)]`:
    /// sessions saved before it was recorded read as settled, never retitled.
    #[serde(default)]
    pub title_source: crate::state::TitleSource,
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
    /// Reasoning effort the session runs at. `#[serde(default)]` so sessions
    /// written before it was recorded still load, at the model's default.
    #[serde(default)]
    pub variant: Option<String>,
    pub context: Option<u64>,
    pub permission_mode: PermissionMode,
    /// The isolated checkout this session runs in, when it has one. `cwd` is
    /// that checkout's path; both are recorded because a worktree removed
    /// while the app was closed has to be told apart from a project folder
    /// that moved. `#[serde(default)]` so sessions written before worktrees
    /// existed still load — they all ran in their project folder.
    #[serde(default)]
    pub worktree: Option<crate::worktrees::SessionWorktree>,
    /// The paired phone that started the session. `#[serde(default)]` so
    /// sessions written before it was recorded still load, as the Mac's own.
    #[serde(default)]
    pub device: Option<String>,
    /// When the session was archived: it stays on disk, out of the window,
    /// until it is restored or deleted (Settings → Archived). Never written
    /// for a live session, so a file only carries the key while archived.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub archived_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedSession {
    pub meta: PersistedMeta,
    pub transcript: Transcript,
    /// Answers to the transcript's decision prompts, keyed by prompt id.
    /// `#[serde(default)]` so sessions written before the backend kept them
    /// still load — with none, which is what they had.
    #[serde(default)]
    pub decisions: BTreeMap<String, serde_json::Value>,
    /// When the file was last written, read back from the filesystem at
    /// load: the closest thing a restored session has to a last-activity
    /// time. Never written into the file itself.
    #[serde(skip)]
    pub modified_ms: u64,
}

fn sessions_dir() -> Option<PathBuf> {
    Some(config_dir()?.join("sessions"))
}

fn session_path(id: u64) -> Option<PathBuf> {
    Some(sessions_dir()?.join(format!("{id}.json")))
}

// ---------------------------------------------------------------------------
// Saving sessions, off the state lock
// ---------------------------------------------------------------------------
//
// Saving used to happen inside `AppState::persist_session`, under the lock the
// whole app shares: every tool call, tool result and context reading cloned
// the session, serialized it (hundreds of KB, on a long one) and wrote it to
// disk while the window waited to draw and every other session waited to
// fold its next event. Now `persist_session` only marks the session, and a
// writer thread saves it shortly after: it lets a burst of changes run on for
// a moment, takes each marked session's snapshot under the lock — a clone,
// once per burst rather than once per event — and serializes and writes it
// outside. Quitting saves whatever is still marked, so the last change before
// a quit still makes it to disk.
//
// Never on a per-token streaming delta either way, which would be thousands
// of writes a reply for nothing: a delta is always followed shortly by a
// coarser event that saves it, and a crash in between loses a few words.

/// How long the writer lets a burst of changes run on before saving it — a
/// tool call, its result and the context reading after it are one write,
/// not three.
const SAVE_DELAY: std::time::Duration = std::time::Duration::from_millis(300);

/// One session as it stood at one moment: its record, and the moment's place
/// among every other snapshot taken, of any session (see [`next_snapshot_seq`]).
pub struct Snapshot {
    pub seq: u64,
    pub record: PersistedSession,
}

/// Snapshots are numbered as they are taken, under the state lock, so the
/// numbers run in the order the state changed. A snapshot is only written
/// over an older one of the same session (see [`supersedes`]): the writer can
/// be holding a snapshot taken a moment before an archive writes its own, or
/// before closing deletes the file, and must not undo either.
pub fn next_snapshot_seq() -> u64 {
    static SEQ: AtomicU64 = AtomicU64::new(1);
    SEQ.fetch_add(1, Ordering::Relaxed)
}

/// What `written` records for a session whose file was deleted: newer than
/// any snapshot, so a late write can never bring the file back.
const DELETED: u64 = u64::MAX;

type Snapshotter = Box<dyn Fn(u64) -> Option<Snapshot> + Send + Sync>;

struct Saver {
    /// Sessions changed since they were last saved.
    dirty: Mutex<BTreeSet<u64>>,
    wake: Condvar,
    /// Held while a batch is saved, so a flush at quit waits for one the
    /// writer has already taken off `dirty` rather than finding it empty.
    batch: Mutex<()>,
    /// Per session, the snapshot on disk now — or [`DELETED`].
    written: Mutex<BTreeMap<u64, u64>>,
    /// How to take a session's snapshot: set once the app exists to take
    /// it from (`start_saver`). Until then — and in tests, which never set
    /// it — marks pile up and nothing is written.
    snapshot: OnceLock<Snapshotter>,
}

static SAVER: Saver = Saver {
    dirty: Mutex::new(BTreeSet::new()),
    wake: Condvar::new(),
    batch: Mutex::new(()),
    written: Mutex::new(BTreeMap::new()),
    snapshot: OnceLock::new(),
};

/// Marks a session as changed: the writer saves it shortly. Cheap enough to
/// call under the state lock on every event.
pub fn mark_dirty(id: u64) {
    if let Ok(mut dirty) = SAVER.dirty.lock() {
        dirty.insert(id);
    }
    SAVER.wake.notify_one();
}

/// Starts the writer. `snapshot` takes one session's snapshot — it locks the
/// state itself, briefly, and must return `None` for a session that is no
/// longer there (closed, archived) or has nowhere to be saved.
pub fn start_saver(snapshot: impl Fn(u64) -> Option<Snapshot> + Send + Sync + 'static) {
    if SAVER.snapshot.set(Box::new(snapshot)).is_err() {
        return; // already running
    }
    let spawned = std::thread::Builder::new()
        .name("egant-session-saver".into())
        .spawn(|| {
            loop {
                {
                    let Ok(mut dirty) = SAVER.dirty.lock() else {
                        return;
                    };
                    while dirty.is_empty() {
                        dirty = match SAVER.wake.wait(dirty) {
                            Ok(dirty) => dirty,
                            Err(_) => return,
                        };
                    }
                }
                std::thread::sleep(SAVE_DELAY);
                save_dirty();
            }
        });
    if let Err(error) = spawned {
        log::error!("couldn't start the session saver: {error}");
    }
}

/// Saves every marked session now, on this thread. Quitting calls it, so
/// the changes of the last moment aren't lost with the process.
pub fn flush() {
    save_dirty();
}

fn save_dirty() {
    let Some(snapshot) = SAVER.snapshot.get() else {
        return;
    };
    let _batch = SAVER.batch.lock();
    let ids = match SAVER.dirty.lock() {
        Ok(mut dirty) => std::mem::take(&mut *dirty),
        Err(_) => return,
    };
    for id in ids {
        if let Some(Snapshot { seq, record }) = snapshot(id) {
            write_snapshot(seq, &record);
        }
    }
}

/// Writes one session's snapshot now — what the writer does, and what
/// archiving does directly, since it needs to know the file says "archived"
/// before it takes the session out of the window. Returns whether the file
/// now holds this snapshot: not when it failed, and not when a newer one is
/// already there or the file was deleted since.
pub fn write_snapshot(seq: u64, record: &PersistedSession) -> bool {
    let Some(dir) = sessions_dir() else {
        return false;
    };
    write_snapshot_in(&dir, &SAVER.written, seq, record)
}

fn write_snapshot_in(
    dir: &Path,
    written: &Mutex<BTreeMap<u64, u64>>,
    seq: u64,
    record: &PersistedSession,
) -> bool {
    let id = record.meta.id;
    // Serialized before the order is checked, outside any lock that matters.
    let text = match serde_json::to_string(record) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("could not serialize session {id}: {error}");
            return false;
        }
    };
    let Ok(mut written) = written.lock() else {
        return false;
    };
    if !supersedes(written.get(&id).copied(), seq) {
        log::debug!("session {id}: snapshot {seq} is older than the file, skipped");
        return false;
    }
    let path = dir.join(format!("{id}.json"));
    match write_atomic(&path, &text) {
        Ok(()) => {
            written.insert(id, seq);
            true
        }
        Err(error) => {
            log::warn!("could not write {}: {error}", path.display());
            false
        }
    }
}

/// Whether a snapshot may replace what is on disk: only a newer one, and
/// never once the file was deleted.
fn supersedes(on_disk: Option<u64>, seq: u64) -> bool {
    on_disk.is_none_or(|on_disk| seq > on_disk)
}

/// Removes a session's file. Called when the user closes a session, which is
/// still meant to forget it for good — persistence only changes what
/// *quitting the app* does, not what closing a tab does.
///
/// A snapshot the writer is still holding can't bring it back: deleting
/// counts as newer than any of them.
pub fn delete_session(id: u64) {
    let Some(path) = session_path(id) else { return };
    let Ok(mut written) = SAVER.written.lock() else {
        return;
    };
    if let Err(error) = std::fs::remove_file(&path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            log::warn!("could not remove {}: {error}", path.display());
        }
    }
    written.insert(id, DELETED);
}

/// Every session left over from previous runs, archived ones included, oldest
/// first (by `started_unix_ms`) so restoring them rebuilds the same
/// chronological order they were created in. A single corrupt file is
/// skipped and logged rather than losing every other session in the
/// directory.
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
        .filter_map(|entry| read_session(&entry.path()))
        .collect();

    sessions.sort_by_key(|s| s.meta.started_unix_ms);
    sessions
}

/// One session's file, with `modified_ms` read back from the filesystem.
fn read_session(path: &Path) -> Option<PersistedSession> {
    let text = std::fs::read_to_string(path).ok()?;
    match serde_json::from_str::<PersistedSession>(&text) {
        Ok(mut session) => {
            session.modified_ms = std::fs::metadata(path)
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |since| since.as_millis() as u64);
            Some(session)
        }
        Err(error) => {
            log::warn!("ignoring unreadable session at {}: {error}", path.display());
            None
        }
    }
}

/// One saved session, by id — what restoring an archived one reads.
pub fn load_session(id: u64) -> Option<PersistedSession> {
    read_session(&session_path(id)?)
}

/// The archived sessions' metadata, most recently archived first. Only the
/// `meta` object is materialized — the transcripts behind them can be long,
/// and the list shows none of them.
pub fn list_archived() -> Vec<PersistedMeta> {
    #[derive(Deserialize)]
    struct MetaOnly {
        meta: PersistedMeta,
    }
    let Some(dir) = sessions_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut archived: Vec<PersistedMeta> = entries
        .flatten()
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .filter_map(|entry| {
            let text = std::fs::read_to_string(entry.path()).ok()?;
            serde_json::from_str::<MetaOnly>(&text).ok()
        })
        .map(|file| file.meta)
        .filter(|meta| meta.archived_at_ms.is_some())
        .collect();
    archived.sort_by_key(|meta| std::cmp::Reverse(meta.archived_at_ms));
    archived
}

#[cfg(test)]
mod tests {
    use super::*;
    use egant_harness::{PermissionMode, TranscriptEntry};

    fn scratch_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("egant-persist-test-{name}-{}", std::process::id()))
    }

    fn record(id: u64, title: &str, archived_at_ms: Option<u64>) -> PersistedSession {
        PersistedSession {
            meta: PersistedMeta {
                id,
                title: title.into(),
                title_source: crate::state::TitleSource::User,
                project_path: PathBuf::from("/tmp/project"),
                cwd: PathBuf::from("/tmp/project"),
                branch: None,
                started_unix_ms: 1,
                agent: AgentId::Claude,
                cli_agent: None,
                model: None,
                variant: None,
                context: None,
                permission_mode: PermissionMode::Auto,
                worktree: None,
                device: None,
                archived_at_ms,
            },
            transcript: Transcript::new(),
            decisions: BTreeMap::new(),
            modified_ms: 0,
        }
    }

    fn title_on_disk(dir: &Path, id: u64) -> Option<String> {
        let text = std::fs::read_to_string(dir.join(format!("{id}.json"))).ok()?;
        let back: PersistedSession = serde_json::from_str(&text).ok()?;
        Some(back.meta.title)
    }

    #[test]
    fn a_snapshot_never_overwrites_a_newer_one() {
        // A scratch folder and its own record of what was written: the
        // writer's ordering, without the real sessions folder.
        let dir = scratch_dir("snapshots");
        let written = Mutex::new(BTreeMap::new());

        // The writer took snapshot 5 just before archiving took and wrote 6;
        // its write, arriving last, is the stale one.
        assert!(write_snapshot_in(
            &dir,
            &written,
            6,
            &record(1, "archived", Some(9))
        ));
        assert!(!write_snapshot_in(
            &dir,
            &written,
            5,
            &record(1, "stale", None)
        ));
        assert_eq!(title_on_disk(&dir, 1).as_deref(), Some("archived"));

        // In order, each newer snapshot replaces the last.
        assert!(write_snapshot_in(
            &dir,
            &written,
            7,
            &record(2, "first", None)
        ));
        assert!(write_snapshot_in(
            &dir,
            &written,
            8,
            &record(2, "second", None)
        ));
        assert_eq!(title_on_disk(&dir, 2).as_deref(), Some("second"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn nothing_written_late_brings_a_deleted_session_back() {
        assert!(supersedes(None, 1));
        assert!(supersedes(Some(4), 5));
        assert!(!supersedes(Some(5), 5));
        assert!(!supersedes(Some(6), 5));
        // A closed session's file is gone for good, whatever was in flight.
        assert!(!supersedes(Some(DELETED), next_snapshot_seq()));
    }

    #[test]
    fn snapshots_are_numbered_in_the_order_they_are_taken() {
        let first = next_snapshot_seq();
        let second = next_snapshot_seq();
        assert!(second > first);
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
            title_source: crate::state::TitleSource::Generated,
            project_path: PathBuf::from("/tmp/project"),
            cwd: PathBuf::from("/tmp/project"),
            branch: Some("main".into()),
            started_unix_ms: 12345,
            agent: AgentId::Claude,
            cli_agent: None,
            model: Some("sonnet".into()),
            variant: None,
            context: None,
            permission_mode: PermissionMode::Auto,
            worktree: None,
            device: None,
            archived_at_ms: None,
        };

        let text = serde_json::to_string(&PersistedSession {
            meta: meta.clone(),
            transcript: transcript.clone(),
            decisions: BTreeMap::new(),
            modified_ms: 0,
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
            title_source: crate::state::TitleSource::Generated,
            project_path: PathBuf::from("/tmp/project"),
            cwd: PathBuf::from("/tmp/project"),
            branch: None,
            started_unix_ms: 1,
            agent: AgentId::Claude,
            cli_agent: None,
            model: None,
            variant: None,
            context: None,
            permission_mode: PermissionMode::Auto,
            worktree: None,
            device: None,
            archived_at_ms: None,
        };
        let mut value = serde_json::to_value(&PersistedSession {
            meta,
            transcript: Transcript::new(),
            decisions: BTreeMap::new(),
            modified_ms: 0,
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

    /// A live session's file never names the archive at all — older builds
    /// read it exactly as before — and an archived one says when.
    #[test]
    fn the_archive_mark_is_only_written_while_archived() {
        let meta = PersistedMeta {
            id: 4,
            title: "Tidy the sidebar".into(),
            title_source: crate::state::TitleSource::Generated,
            project_path: PathBuf::from("/tmp/project"),
            cwd: PathBuf::from("/tmp/project"),
            branch: None,
            started_unix_ms: 1,
            agent: AgentId::Claude,
            cli_agent: None,
            model: None,
            variant: None,
            context: None,
            permission_mode: PermissionMode::Auto,
            worktree: None,
            device: None,
            archived_at_ms: None,
        };
        let live = serde_json::to_value(&meta).unwrap();
        assert!(live.get("archived_at_ms").is_none());

        let archived = serde_json::to_value(PersistedMeta {
            archived_at_ms: Some(99),
            ..meta
        })
        .unwrap();
        assert_eq!(archived["archived_at_ms"], 99);
        let back: PersistedMeta = serde_json::from_value(archived).unwrap();
        assert_eq!(back.archived_at_ms, Some(99));
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
