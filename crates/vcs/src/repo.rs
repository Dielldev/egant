//! Local git operations through libgit2.

use crate::VcsError;
use git2::{Delta, DiffOptions, IndexAddOption, Repository, Signature, StatusOptions};
use std::path::{Path, PathBuf};

pub struct Repo {
    inner: Repository,
    root: PathBuf,
}

/// One changed path as the git panel lists it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileChange {
    pub path: PathBuf,
    pub status: FileStatus,
    /// True when the change is in the index, i.e. it would be part of a commit.
    pub staged: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FileStatus {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

impl FileStatus {
    /// The single letter the panel shows, matching `git status --short`.
    pub fn code(self) -> char {
        match self {
            FileStatus::Added => 'A',
            FileStatus::Modified => 'M',
            FileStatus::Deleted => 'D',
            FileStatus::Renamed => 'R',
            FileStatus::Untracked => '?',
            FileStatus::Conflicted => 'U',
        }
    }
}

/// Everything the panel needs for one render, gathered in one pass so the UI
/// never holds a `Repository` (which is not `Send`) across an await point.
#[derive(Debug, Clone, Default)]
pub struct RepoSnapshot {
    pub root: PathBuf,
    pub branch: Option<String>,
    pub head_summary: Option<String>,
    pub changes: Vec<FileChange>,
    /// Commits ahead of / behind the upstream branch, when one is configured.
    pub ahead_behind: Option<(usize, usize)>,
}

impl RepoSnapshot {
    pub fn staged(&self) -> impl Iterator<Item = &FileChange> {
        self.changes.iter().filter(|change| change.staged)
    }

    pub fn unstaged(&self) -> impl Iterator<Item = &FileChange> {
        self.changes.iter().filter(|change| !change.staged)
    }

    pub fn is_clean(&self) -> bool {
        self.changes.is_empty()
    }
}

#[derive(Debug, Clone)]
pub struct DiffHunk {
    pub header: String,
    pub lines: Vec<DiffLine>,
}

#[derive(Debug, Clone)]
pub struct DiffLine {
    pub origin: char,
    pub content: String,
}

impl Repo {
    /// Opens the repository containing `path`, walking upwards like git does.
    pub fn discover(path: impl AsRef<Path>) -> Result<Self, VcsError> {
        let path = path.as_ref();
        let inner =
            Repository::discover(path).map_err(|_| VcsError::NotARepository(path.to_path_buf()))?;
        let root = inner
            .workdir()
            .unwrap_or_else(|| inner.path())
            .to_path_buf();
        Ok(Self { inner, root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn snapshot(&self) -> Result<RepoSnapshot, VcsError> {
        Ok(RepoSnapshot {
            root: self.root.clone(),
            branch: self.head_branch()?,
            head_summary: self.head_summary()?,
            changes: self.changes()?,
            ahead_behind: self.ahead_behind().ok(),
        })
    }

    pub fn head_branch(&self) -> Result<Option<String>, VcsError> {
        match self.inner.head() {
            // `shorthand` fails on a non-UTF-8 ref name, which reads as
            // "no branch to show" rather than an error worth surfacing.
            Ok(head) => Ok(head.shorthand().ok().map(str::to_owned)),
            // An unborn HEAD is a fresh repo with no commits, not an error.
            Err(error) if error.code() == git2::ErrorCode::UnbornBranch => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    fn head_summary(&self) -> Result<Option<String>, VcsError> {
        match self.inner.head() {
            Ok(head) => {
                let commit = head.peel_to_commit()?;
                Ok(commit.summary().ok().flatten().map(str::to_owned))
            }
            Err(_) => Ok(None),
        }
    }

    /// Working-tree and index changes, one entry per path per side. A file
    /// modified and partially staged appears twice — once staged, once not —
    /// which is what lets the panel show both halves.
    pub fn changes(&self) -> Result<Vec<FileChange>, VcsError> {
        let mut options = StatusOptions::new();
        options
            .include_untracked(true)
            .recurse_untracked_dirs(true)
            .renames_head_to_index(true)
            .renames_index_to_workdir(true);

        let statuses = self.inner.statuses(Some(&mut options))?;
        let mut changes = Vec::with_capacity(statuses.len());

        for entry in statuses.iter() {
            let Ok(path) = entry.path() else { continue };
            let path = PathBuf::from(path);
            let status = entry.status();

            if status.is_conflicted() {
                changes.push(FileChange {
                    path,
                    status: FileStatus::Conflicted,
                    staged: false,
                });
                continue;
            }

            if let Some(staged) = index_status(status) {
                changes.push(FileChange {
                    path: path.clone(),
                    status: staged,
                    staged: true,
                });
            }
            if let Some(unstaged) = worktree_status(status) {
                changes.push(FileChange {
                    path,
                    status: unstaged,
                    staged: false,
                });
            }
        }

        changes.sort_by(|a, b| a.path.cmp(&b.path).then(b.staged.cmp(&a.staged)));
        Ok(changes)
    }

    /// A unified diff for one path, as hunks the panel can render line by line.
    pub fn diff(&self, path: &Path, staged: bool) -> Result<Vec<DiffHunk>, VcsError> {
        let mut options = DiffOptions::new();
        options.pathspec(path).context_lines(3);

        let diff = if staged {
            let head_tree = match self.inner.head() {
                Ok(head) => Some(head.peel_to_tree()?),
                Err(_) => None,
            };
            self.inner
                .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))?
        } else {
            // include_untracked makes a brand-new file show its contents rather
            // than an empty diff.
            options.include_untracked(true).recurse_untracked_dirs(true);
            self.inner.diff_index_to_workdir(None, Some(&mut options))?
        };

        let mut hunks: Vec<DiffHunk> = Vec::new();
        diff.print(git2::DiffFormat::Patch, |_delta, hunk, line| {
            let content = String::from_utf8_lossy(line.content()).into_owned();
            match line.origin() {
                'H' | 'F' => {}
                _ => {
                    if let Some(hunk) = hunk {
                        let header = String::from_utf8_lossy(hunk.header()).trim_end().to_owned();
                        if hunks.last().map(|last| &last.header) != Some(&header) {
                            hunks.push(DiffHunk {
                                header,
                                lines: Vec::new(),
                            });
                        }
                    }
                    if let Some(current) = hunks.last_mut() {
                        current.lines.push(DiffLine {
                            origin: line.origin(),
                            content,
                        });
                    }
                }
            }
            true
        })?;

        Ok(hunks)
    }

    pub fn stage(&self, paths: &[PathBuf]) -> Result<(), VcsError> {
        let mut index = self.inner.index()?;
        index.add_all(paths, IndexAddOption::DEFAULT, None)?;
        index.write()?;
        Ok(())
    }

    pub fn stage_all(&self) -> Result<(), VcsError> {
        self.stage(&[PathBuf::from("*")])
    }

    pub fn unstage(&self, paths: &[PathBuf]) -> Result<(), VcsError> {
        match self.inner.head() {
            Ok(head) => {
                let commit = head.peel_to_commit()?;
                let specs: Vec<&Path> = paths.iter().map(PathBuf::as_path).collect();
                self.inner.reset_default(Some(commit.as_object()), specs)?;
            }
            // Before the first commit there is nothing to reset to, so removing
            // the entries from the index is the equivalent of unstaging.
            Err(_) => {
                let mut index = self.inner.index()?;
                for path in paths {
                    index.remove_path(path).ok();
                }
                index.write()?;
            }
        }
        Ok(())
    }

    /// Commits whatever is staged. Uses the repository's configured identity,
    /// so commits look the same as ones made from the terminal.
    pub fn commit(&self, message: &str) -> Result<git2::Oid, VcsError> {
        let signature = self.signature()?;
        let mut index = self.inner.index()?;
        let tree_id = index.write_tree()?;
        let tree = self.inner.find_tree(tree_id)?;

        let parents = match self.inner.head() {
            Ok(head) => vec![head.peel_to_commit()?],
            Err(_) => Vec::new(),
        };
        let parent_refs: Vec<&git2::Commit> = parents.iter().collect();

        let oid = self.inner.commit(
            Some("HEAD"),
            &signature,
            &signature,
            message,
            &tree,
            &parent_refs,
        )?;
        Ok(oid)
    }

    fn signature(&self) -> Result<Signature<'_>, VcsError> {
        Ok(self.inner.signature()?)
    }

    fn ahead_behind(&self) -> Result<(usize, usize), VcsError> {
        let head = self.inner.head()?;
        let local = head.peel_to_commit()?.id();
        let branch = git2::Branch::wrap(head);
        let upstream = branch.upstream()?;
        let remote = upstream.get().peel_to_commit()?.id();
        Ok(self.inner.graph_ahead_behind(local, remote)?)
    }
}

fn index_status(status: git2::Status) -> Option<FileStatus> {
    if status.is_index_new() {
        Some(FileStatus::Added)
    } else if status.is_index_modified() {
        Some(FileStatus::Modified)
    } else if status.is_index_deleted() {
        Some(FileStatus::Deleted)
    } else if status.is_index_renamed() {
        Some(FileStatus::Renamed)
    } else {
        None
    }
}

fn worktree_status(status: git2::Status) -> Option<FileStatus> {
    if status.is_wt_new() {
        Some(FileStatus::Untracked)
    } else if status.is_wt_modified() {
        Some(FileStatus::Modified)
    } else if status.is_wt_deleted() {
        Some(FileStatus::Deleted)
    } else if status.is_wt_renamed() {
        Some(FileStatus::Renamed)
    } else {
        None
    }
}

/// `Delta` is re-exported so callers can map libgit2 deltas without depending
/// on git2 directly.
pub type RawDelta = Delta;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn init_repo() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let repository = Repository::init(dir.path()).unwrap();
        let mut config = repository.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        drop(config);
        let repo = Repo::discover(dir.path()).unwrap();
        (dir, repo)
    }

    #[test]
    fn untracked_file_shows_as_unstaged() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "hello").unwrap();

        let snapshot = repo.snapshot().unwrap();
        assert_eq!(snapshot.changes.len(), 1);
        assert_eq!(snapshot.changes[0].status, FileStatus::Untracked);
        assert!(!snapshot.changes[0].staged);
        assert!(!snapshot.is_clean());
    }

    #[test]
    fn staging_moves_a_change_to_the_index() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "hello").unwrap();

        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        let snapshot = repo.snapshot().unwrap();
        assert_eq!(snapshot.staged().count(), 1);
        assert_eq!(snapshot.unstaged().count(), 0);
    }

    #[test]
    fn commit_clears_the_worktree_and_sets_head() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "hello").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();

        repo.commit("first commit").unwrap();

        let snapshot = repo.snapshot().unwrap();
        assert!(snapshot.is_clean());
        assert_eq!(snapshot.head_summary.as_deref(), Some("first commit"));
    }

    #[test]
    fn diff_reports_changed_lines() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "one\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        repo.commit("add a").unwrap();
        fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();

        let hunks = repo.diff(Path::new("a.txt"), false).unwrap();
        assert!(!hunks.is_empty());
        let added: Vec<_> = hunks[0]
            .lines
            .iter()
            .filter(|line| line.origin == '+')
            .collect();
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].content.trim_end(), "two");
    }
}
