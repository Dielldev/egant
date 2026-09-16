//! Local git operations through libgit2.

use crate::VcsError;
use git2::{Delta, DiffOptions, IndexAddOption, Repository, Signature, StatusOptions};
use std::collections::HashMap;
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
    /// Lines added and removed by this change, for the `+12 -3` a row carries.
    /// Both are zero for a binary file, which has no lines to count.
    pub additions: usize,
    pub deletions: usize,
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

/// Which stored copy of a file to read: what is staged, or what was last
/// committed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlobSource {
    Index,
    Head,
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
    /// Line number on each side, absent where the line doesn't exist there: a
    /// removed line has no new number, an added line has no old one. This is
    /// what lets the viewer number both gutters and lay the two sides out
    /// side by side.
    pub old_lineno: Option<u32>,
    pub new_lineno: Option<u32>,
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

    /// The subject line of the commit HEAD points at.
    pub fn head_summary(&self) -> Result<Option<String>, VcsError> {
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

        // Line counts come from the same two diffs the panel's staged and
        // unstaged sections stand for, gathered once here rather than per row:
        // a diff per changed file would make a busy working tree cost dozens
        // of walks on every refresh.
        let staged_lines = self.line_counts(true).unwrap_or_default();
        let unstaged_lines = self.line_counts(false).unwrap_or_default();
        let count = |stats: &HashMap<PathBuf, (usize, usize)>, path: &PathBuf| {
            stats.get(path).copied().unwrap_or((0, 0))
        };

        for entry in statuses.iter() {
            let Ok(path) = entry.path() else { continue };
            let path = PathBuf::from(path);
            let status = entry.status();

            if status.is_conflicted() {
                let (additions, deletions) = count(&unstaged_lines, &path);
                changes.push(FileChange {
                    path,
                    status: FileStatus::Conflicted,
                    staged: false,
                    additions,
                    deletions,
                });
                continue;
            }

            if let Some(staged) = index_status(status) {
                let (additions, deletions) = count(&staged_lines, &path);
                changes.push(FileChange {
                    path: path.clone(),
                    status: staged,
                    staged: true,
                    additions,
                    deletions,
                });
            }
            if let Some(unstaged) = worktree_status(status) {
                let (additions, deletions) = count(&unstaged_lines, &path);
                changes.push(FileChange {
                    path,
                    status: unstaged,
                    staged: false,
                    additions,
                    deletions,
                });
            }
        }

        changes.sort_by(|a, b| a.path.cmp(&b.path).then(b.staged.cmp(&a.staged)));
        Ok(changes)
    }

    /// Lines added and removed per path, for one side of the panel: the index
    /// against HEAD (`staged`), or the working tree against the index.
    fn line_counts(&self, staged: bool) -> Result<HashMap<PathBuf, (usize, usize)>, VcsError> {
        let mut options = DiffOptions::new();
        // Counting lines needs no context, and a busy tree is measurably
        // cheaper without it.
        options.context_lines(0);

        let diff = if staged {
            let head_tree = match self.inner.head() {
                Ok(head) => Some(head.peel_to_tree()?),
                Err(_) => None,
            };
            self.inner
                .diff_tree_to_index(head_tree.as_ref(), None, Some(&mut options))?
        } else {
            // Without the content of untracked files a brand-new file would
            // report `+0`, when every one of its lines is an addition.
            options
                .include_untracked(true)
                .recurse_untracked_dirs(true)
                .show_untracked_content(true);
            self.inner.diff_index_to_workdir(None, Some(&mut options))?
        };

        let mut stats: HashMap<PathBuf, (usize, usize)> = HashMap::new();
        diff.foreach(
            &mut |_delta, _progress| true,
            None,
            None,
            Some(&mut |delta, _hunk, line| {
                let path = delta
                    .new_file()
                    .path()
                    .or_else(|| delta.old_file().path())
                    .map(Path::to_path_buf);
                if let Some(path) = path {
                    let entry = stats.entry(path).or_insert((0, 0));
                    match line.origin() {
                        '+' => entry.0 += 1,
                        '-' => entry.1 += 1,
                        _ => {}
                    }
                }
                true
            }),
        )?;
        Ok(stats)
    }

    /// Throws away working-tree changes to `paths`, the way `git checkout --`
    /// and `git clean` between them do.
    ///
    /// Destructive and unrecoverable — there is no reflog for work that was
    /// never committed — so the caller is expected to have asked first.
    pub fn discard(&self, paths: &[PathBuf]) -> Result<(), VcsError> {
        let mut restore: Vec<&PathBuf> = Vec::new();
        for path in paths {
            let status = self
                .inner
                .status_file(path)
                .unwrap_or_else(|_| git2::Status::empty());
            // An untracked file has nothing in the index to be restored from;
            // deleting it is the only thing discarding it can mean.
            if status.contains(git2::Status::WT_NEW) {
                let full = self.root.join(path);
                if full.is_file() {
                    std::fs::remove_file(&full)?;
                }
            } else {
                restore.push(path);
            }
        }

        if !restore.is_empty() {
            let mut checkout = git2::build::CheckoutBuilder::new();
            // Force, or libgit2 declines to overwrite the very modifications
            // being discarded. The index is the source, not HEAD, so a staged
            // change survives discarding the unstaged edits on top of it.
            checkout.force();
            for path in restore {
                checkout.path(path);
            }
            self.inner.checkout_index(None, Some(&mut checkout))?;
        }
        Ok(())
    }

    /// The bytes of `path` as git has them stored, for the sides of a diff
    /// that are not on disk. `None` means the path isn't there at all on that
    /// side — a file that was just added has no HEAD blob to show.
    pub fn blob(&self, path: &Path, source: BlobSource) -> Result<Option<Vec<u8>>, VcsError> {
        let id = match source {
            BlobSource::Index => {
                let index = self.inner.index()?;
                // Stage 0 is the ordinary, unconflicted entry.
                match index.get_path(path, 0) {
                    Some(entry) => entry.id,
                    None => return Ok(None),
                }
            }
            BlobSource::Head => {
                let Ok(head) = self.inner.head() else {
                    return Ok(None);
                };
                let tree = head.peel_to_tree()?;
                match tree.get_path(path) {
                    Ok(entry) => entry.id(),
                    Err(_) => return Ok(None),
                }
            }
        };
        let blob = self.inner.find_blob(id)?;
        Ok(Some(blob.content().to_vec()))
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
                            old_lineno: line.old_lineno(),
                            new_lineno: line.new_lineno(),
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

    /// Whether the current branch tracks anything. False means it has never
    /// been pushed, which is a different offer than "push".
    pub fn has_upstream(&self) -> bool {
        let Ok(head) = self.inner.head() else {
            return false;
        };
        let Ok(name) = head.shorthand() else {
            return false;
        };
        self.inner
            .find_branch(name, git2::BranchType::Local)
            .and_then(|branch| branch.upstream())
            .is_ok()
    }

    /// Commits ahead of and behind the upstream branch, when one is set.
    pub fn ahead_behind(&self) -> Result<(usize, usize), VcsError> {
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
    fn a_fresh_repository_has_nothing_to_push_to() {
        let (_dir, repo) = init_repo();
        assert!(!repo.has_upstream());
    }

    #[test]
    fn blobs_read_what_git_stored_not_what_is_on_disk() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "committed\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        repo.commit("first").unwrap();

        fs::write(dir.path().join("a.txt"), "staged\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        fs::write(dir.path().join("a.txt"), "on disk\n").unwrap();

        let head = repo.blob(Path::new("a.txt"), BlobSource::Head).unwrap();
        let index = repo.blob(Path::new("a.txt"), BlobSource::Index).unwrap();
        assert_eq!(head.as_deref(), Some(&b"committed\n"[..]));
        assert_eq!(index.as_deref(), Some(&b"staged\n"[..]));

        // A path git has never seen is absent, not an error.
        assert!(repo.blob(Path::new("nope.txt"), BlobSource::Head).unwrap().is_none());
    }

    #[test]
    fn a_new_file_counts_every_line_as_an_addition() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();

        let changes = repo.changes().unwrap();
        assert_eq!(changes[0].additions, 3);
        assert_eq!(changes[0].deletions, 0);
    }

    #[test]
    fn an_edit_counts_both_sides_and_keeps_them_on_their_own_section() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "one\ntwo\nthree\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        repo.commit("first").unwrap();

        // Staged: one line swapped for two.
        fs::write(dir.path().join("a.txt"), "one\nTWO\nEXTRA\nthree\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        // Unstaged on top of it: one more line appended.
        fs::write(dir.path().join("a.txt"), "one\nTWO\nEXTRA\nthree\nfour\n").unwrap();

        let changes = repo.changes().unwrap();
        let staged = changes.iter().find(|change| change.staged).unwrap();
        let unstaged = changes.iter().find(|change| !change.staged).unwrap();

        assert_eq!((staged.additions, staged.deletions), (2, 1));
        assert_eq!((unstaged.additions, unstaged.deletions), (1, 0));
    }

    #[test]
    fn discarding_restores_a_tracked_file_and_deletes_an_untracked_one() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("kept.txt"), "original\n").unwrap();
        repo.stage(&[PathBuf::from("kept.txt")]).unwrap();
        repo.commit("first").unwrap();

        fs::write(dir.path().join("kept.txt"), "edited\n").unwrap();
        fs::write(dir.path().join("new.txt"), "brand new\n").unwrap();

        repo.discard(&[PathBuf::from("kept.txt"), PathBuf::from("new.txt")])
            .unwrap();

        assert_eq!(fs::read_to_string(dir.path().join("kept.txt")).unwrap(), "original\n");
        assert!(!dir.path().join("new.txt").exists());
        assert!(repo.snapshot().unwrap().is_clean());
    }

    #[test]
    fn discarding_an_unstaged_edit_leaves_the_staged_one_alone() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "original\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        repo.commit("first").unwrap();

        fs::write(dir.path().join("a.txt"), "staged\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        fs::write(dir.path().join("a.txt"), "staged then edited again\n").unwrap();

        repo.discard(&[PathBuf::from("a.txt")]).unwrap();

        // Back to what was staged, not back to what was committed.
        assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "staged\n");
        let snapshot = repo.snapshot().unwrap();
        assert_eq!(snapshot.staged().count(), 1);
        assert_eq!(snapshot.unstaged().count(), 0);
    }

    #[test]
    fn diff_lines_know_where_they_sit_on_each_side() {
        let (dir, repo) = init_repo();
        fs::write(dir.path().join("a.txt"), "one\ntwo\n").unwrap();
        repo.stage(&[PathBuf::from("a.txt")]).unwrap();
        repo.commit("first").unwrap();
        fs::write(dir.path().join("a.txt"), "one\nTWO\n").unwrap();

        let hunks = repo.diff(Path::new("a.txt"), false).unwrap();
        let lines = &hunks[0].lines;

        let removed = lines.iter().find(|line| line.origin == '-').unwrap();
        assert_eq!(removed.old_lineno, Some(2));
        assert_eq!(removed.new_lineno, None);

        let added = lines.iter().find(|line| line.origin == '+').unwrap();
        assert_eq!(added.old_lineno, None);
        assert_eq!(added.new_lineno, Some(2));
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
