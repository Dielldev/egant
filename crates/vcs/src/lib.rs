//! Git, split by what each job actually needs.
//!
//! - [`repo`] — everything local (status, diffs, staging, commits) through
//!   `libgit2`, because it is fast enough to run on every filesystem event.
//! - [`remote`] — everything that touches a network or a credential (fetch,
//!   push) by shelling out to the user's own `git`. See that module for why.
//! - [`worktree`] — isolated checkouts, so an agent session can edit files
//!   without disturbing the working tree the user is looking at.
//! - [`watcher`] — filesystem notifications, so the git panel reflects what the
//!   agent is doing as it does it.

pub mod remote;
pub mod repo;
pub mod watcher;
pub mod worktree;

pub use repo::{DiffHunk, FileChange, FileStatus, Repo, RepoSnapshot};
pub use watcher::{RepoWatcher, WatchEvent};
pub use worktree::{Worktree, WorktreeStore};

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
