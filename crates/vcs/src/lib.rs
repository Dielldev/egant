//! Git, split by what each job actually needs.
//!
//! - [`repo`] — everything local (status, diffs, staging, commits) through
//!   `libgit2`, because it is fast enough to run on every filesystem event.
//! - [`remote`] — everything that touches a network or a credential (fetch,
//!   push) by shelling out to the user's own `git`. See that module for why.
//! - [`history`] — the commit graph, for the panel's History tab.
//! - [`worktree`] — isolated checkouts, so an agent session can edit files
//!   without disturbing the working tree the user is looking at.
//! - [`watcher`] — filesystem notifications, so the git panel reflects what the
//!   agent is doing as it does it.
//! - [`conflict`] — detecting and resolving a stalled merge/rebase, for the
//!   panel's conflict toolbar.

pub mod conflict;
pub mod history;
pub mod remote;
pub mod repo;
pub mod watcher;
pub mod worktree;

pub use conflict::{
    ConflictBlock, ConflictState, OperationKind, Side as ConflictSide, UnmergedFile, UnmergedKind,
};
pub use history::{Commit, CommitRef, HistoryPage, RefKind};
pub use repo::{BlobSource, DiffHunk, FileChange, FileStatus, Repo, RepoSnapshot};
pub use watcher::{RepoWatcher, WatchEvent};
pub use worktree::{RepoRef, Worktree, WorktreeState, WorktreeStore};

#[derive(Debug, thiserror::Error)]
pub enum VcsError {
    #[error("no git repository at or above {}", .0.display())]
    NotARepository(std::path::PathBuf),
    #[error("git exited with status {status}: {stderr}")]
    GitFailed { status: i32, stderr: String },
    #[error(transparent)]
    Git(#[from] git2::Error),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}
