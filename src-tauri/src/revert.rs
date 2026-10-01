//! "Revert this turn": putting the files one turn changed back the way they
//! were when it began.
//!
//! Every turn starts by writing the whole working tree as a git tree object
//! (`sessions::mark_turn_baseline`, via `Repo::snapshot_worktree`) — new and
//! changed files too, never ignored ones. A turn's changes are then the
//! difference between its own snapshot and the next turn's, or the working
//! tree as it is now for the latest one; reverting writes the first snapshot's
//! version of each of those paths back, and removes what the turn created.
//!
//! This rather than the Claude CLI's own `rewind_files` control request: that
//! one is keyed by a user message id the CLI only reports when it is asked to
//! replay messages, only covers its own edit tools (not a file a `sed` in Bash
//! changed), and keeps its checkpoints in the process — which egant restarts
//! on every model switch. A git tree works the same for all three agents and
//! is still there after a relaunch.
//!
//! Only the files go back. The conversation doesn't: the agent still thinks
//! its edits are there until it is told otherwise.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use egant_vcs::{ChangeKind, Repo, TreeChange};
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::persist::TurnSnapshot;
use crate::state::AppState;

/// How many turns a session keeps a snapshot for — the newest ones. A tree
/// object costs the repository little (unchanged files are shared between
/// snapshots), but a session file shouldn't list a thousand of them.
pub const KEPT_TURNS: usize = 100;

/// Records the tree `turn` began with, replacing an older record of the same
/// turn and dropping the oldest past [`KEPT_TURNS`].
pub fn record(snapshots: &mut Vec<TurnSnapshot>, turn: usize, tree: String) {
    snapshots.retain(|snapshot| snapshot.turn != turn);
    snapshots.push(TurnSnapshot { turn, tree });
    snapshots.sort_by_key(|snapshot| snapshot.turn);
    let excess = snapshots.len().saturating_sub(KEPT_TURNS);
    snapshots.drain(..excess);
}

/// The trees a turn ran between: the one it began with, and the one the
/// next turn began with — `None` when no later turn has one, and the turn's
/// end is the working tree as it is now.
pub fn bounds(snapshots: &[TurnSnapshot], turn: usize) -> Option<(String, Option<String>)> {
    let before = snapshots.iter().find(|snapshot| snapshot.turn == turn)?;
    let after = snapshots
        .iter()
        .filter(|snapshot| snapshot.turn > turn)
        .min_by_key(|snapshot| snapshot.turn)
        .map(|snapshot| snapshot.tree.clone());
    Some((before.tree.clone(), after))
}

/// What reverting a turn will do, path by path, as the confirmation shows it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertPlanDto {
    pub files: Vec<RevertFileDto>,
    /// Files the turn changed that have changed again since — a later turn,
    /// or the user. Reverting puts them back all the same, and loses that.
    pub changed_since: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertFileDto {
    /// From the repository's root.
    pub path: String,
    /// What the turn did to it: `added`, `modified` or `deleted`.
    pub change: &'static str,
}

/// What reverting did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RevertResultDto {
    pub files: usize,
}

/// The payload of the `turn-snapshots` window event: the turns of a session
/// that can be reverted, after one more was recorded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnSnapshotsPayload {
    pub session_id: u64,
    pub turns: Vec<usize>,
}

/// The turns of a session that have a snapshot to revert to.
pub fn revertible_turns(snapshots: &[TurnSnapshot]) -> Vec<usize> {
    snapshots.iter().map(|snapshot| snapshot.turn).collect()
}

struct Plan {
    before: String,
    files: Vec<TreeChange>,
    changed_since: Vec<PathBuf>,
}

fn plan(repo: &Repo, before: String, after: Option<String>) -> Result<Plan, String> {
    let now = repo
        .snapshot_worktree()
        .map_err(|error| error.to_string())?;
    let end = after.as_deref().unwrap_or(&now);
    let files = repo
        .tree_changes(&before, end)
        .map_err(|_| "this turn's snapshot is no longer in the repository".to_string())?;
    let changed_since = match &after {
        Some(after) => {
            let later = repo
                .tree_changes(after, &now)
                .map_err(|error| error.to_string())?;
            files
                .iter()
                .filter(|file| later.iter().any(|change| change.path == file.path))
                .map(|file| file.path.clone())
                .collect()
        }
        None => Vec::new(),
    };
    Ok(Plan {
        before,
        files,
        changed_since,
    })
}

fn plan_dto(plan: &Plan) -> RevertPlanDto {
    RevertPlanDto {
        files: plan
            .files
            .iter()
            .map(|file| RevertFileDto {
                path: file.path.display().to_string(),
                change: match file.kind {
                    ChangeKind::Added => "added",
                    ChangeKind::Modified => "modified",
                    ChangeKind::Deleted => "deleted",
                },
            })
            .collect(),
        changed_since: plan
            .changed_since
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
    }
}

/// Where a turn's session runs and the trees the turn ran between — read
/// under the state lock, briefly. Refuses while a turn is running: the agent
/// could be writing the very files being put back.
fn turn_inputs(
    app: &AppHandle,
    id: u64,
    turn: usize,
) -> Result<(PathBuf, String, Option<String>), String> {
    let state = app.state::<Mutex<AppState>>();
    let guard = state
        .lock()
        .map_err(|_| "the app state is unavailable".to_string())?;
    let session = guard.sessions.get(&id).ok_or("unknown session")?;
    if session.transcript.is_busy() {
        return Err("wait for the agent to finish this turn first".to_string());
    }
    let (before, after) =
        bounds(&session.turn_snapshots, turn).ok_or("this turn has no snapshot to go back to")?;
    Ok((session.meta.cwd.clone(), before, after))
}

fn open_repo(cwd: &Path) -> Result<Repo, String> {
    Repo::discover(cwd)
        .map_err(|_| "this session's folder is no longer a git repository".to_string())
}

/// What reverting `turn` would do, without doing it.
#[tauri::command]
pub async fn preview_turn_revert(
    app: AppHandle,
    id: u64,
    turn: usize,
) -> Result<RevertPlanDto, String> {
    let (cwd, before, after) = turn_inputs(&app, id, turn)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open_repo(&cwd)?;
        Ok(plan_dto(&plan(&repo, before, after)?))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Puts the files `turn` changed back the way they were when it began.
#[tauri::command]
pub async fn revert_turn(app: AppHandle, id: u64, turn: usize) -> Result<RevertResultDto, String> {
    let (cwd, before, after) = turn_inputs(&app, id, turn)?;
    tauri::async_runtime::spawn_blocking(move || {
        let repo = open_repo(&cwd)?;
        let plan = plan(&repo, before, after)?;
        let paths: Vec<PathBuf> = plan.files.iter().map(|file| file.path.clone()).collect();
        repo.restore_paths(&plan.before, &paths)
            .map_err(|error| format!("couldn't put the files back: {error}"))?;
        log::info!("session {id}: reverted turn {turn} ({} files)", paths.len());
        Ok(RevertResultDto { files: paths.len() })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(turn: usize, tree: &str) -> TurnSnapshot {
        TurnSnapshot {
            turn,
            tree: tree.into(),
        }
    }

    #[test]
    fn a_turn_runs_from_its_snapshot_to_the_next_ones() {
        let snapshots = vec![snapshot(0, "a"), snapshot(2, "c"), snapshot(5, "f")];
        assert_eq!(bounds(&snapshots, 0), Some(("a".into(), Some("c".into()))));
        // The latest turn ends at the working tree as it is now.
        assert_eq!(bounds(&snapshots, 5), Some(("f".into(), None)));
        // A turn that never got one (not a repository then) can't be reverted.
        assert_eq!(bounds(&snapshots, 1), None);
    }

    #[test]
    fn only_the_newest_turns_are_kept_and_a_turn_is_kept_once() {
        let mut snapshots = Vec::new();
        for turn in 0..KEPT_TURNS + 5 {
            record(&mut snapshots, turn, format!("t{turn}"));
        }
        record(&mut snapshots, KEPT_TURNS + 4, "again".into());
        assert_eq!(snapshots.len(), KEPT_TURNS);
        assert_eq!(snapshots.first().map(|s| s.turn), Some(5));
        assert_eq!(snapshots.last().map(|s| s.tree.as_str()), Some("again"));
    }
}
