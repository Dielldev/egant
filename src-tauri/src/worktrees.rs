//! The worktree a session runs in, and what happens to it when the session
//! goes away.
//!
//! `egant_vcs::worktree` knows how to cut a checkout and how to give one back;
//! this is the layer that decides *whether* to. The rule is that closing a
//! conversation must never be the thing that loses work: a worktree is only
//! removed once git says there is nothing in it the repository doesn't already
//! have, and its branch is only deleted when it is still the branch egant
//! created. Anything else is left on disk and named, so the user can go and
//! look at it.
//!
//! Every function here shells out to `git` and blocks. Callers run them off the
//! UI thread (`spawn_blocking`) — see [`crate::commands`].

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use egant_vcs::{Worktree, WorktreeState, WorktreeStore};

/// One session's isolated checkout. Persisted with the session, so a relaunch
/// reopens the conversation where it was actually running rather than in the
/// project folder it was started from.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionWorktree {
    /// The repository the worktree was cut from — not necessarily the project
    /// folder, which may be a directory inside it.
    pub repo_root: PathBuf,
    /// Where the agent runs. Also the session's `cwd`.
    pub path: PathBuf,
    /// The branch egant created for it (`egant/quiet-quartz`).
    pub branch: String,
    /// The generated folder name (`quiet-quartz`).
    pub name: String,
    /// The branch it was cut from. Kept so "is there anything in here" has an
    /// answer later, when the repository may be on something else entirely.
    pub base: String,
    /// Whether egant made this worktree for this session. A session started in
    /// a worktree that already existed only borrows it, and closing the
    /// session must leave it exactly where it was.
    ///
    /// Defaults to true so sessions persisted before a worktree could be
    /// borrowed still load as what they were: worktrees egant cut.
    #[serde(default = "yes")]
    pub owned: bool,
}

fn yes() -> bool {
    true
}

/// What the user picked in the composer, resolved into what a starting session
/// should actually run in. Deserialized straight off the command argument, so
/// the frontend's chip states and the backend's outcomes are one shape rather
/// than a handful of loose flags.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CheckoutPlan {
    /// Run in the project folder, on whatever branch it is on.
    CurrentCheckout,
    /// Run in a worktree that already exists — the picked ref was already
    /// materialized in one. No git runs: this is a working directory, borrowed.
    ReuseWorktree { path: String, branch: String },
    /// Cut a fresh worktree off `base` (the repository's own branch when
    /// `None`).
    NewWorktree { base: Option<String> },
}

impl SessionWorktree {
    fn store(&self) -> WorktreeStore {
        WorktreeStore::with_default_base(&self.repo_root)
    }

    fn as_vcs(&self) -> Worktree {
        Worktree {
            path: self.path.clone(),
            branch: self.branch.clone(),
            name: self.name.clone(),
        }
    }
}

/// What [`release`] did, in the words the UI shows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Released {
    /// The checkout is gone. `branch` names the branch that went with it, when
    /// one did.
    Removed { branch: Option<String> },
    /// Left alone, because removing it would have lost something. `why` is a
    /// sentence, not a code — it goes straight on screen.
    Kept { why: String, path: PathBuf },
    /// The session borrowed a worktree it did not create. Nothing happens, and
    /// nothing is said: the user made this checkout before egant met it, and
    /// closing a conversation is not a reason to take it away.
    NotOurs,
}

/// Cuts a worktree for a session about to start in `project_path`.
///
/// Fails rather than falling back to the project folder: a session that was
/// asked to run in isolation and quietly didn't would edit the user's own
/// working tree, which is the one outcome the feature exists to prevent.
pub fn create(project_path: &Path, base: Option<&str>) -> Result<SessionWorktree, String> {
    let repo = egant_vcs::Repo::discover(project_path).map_err(|_| {
        format!(
            "{} is not inside a git repository, so there is nothing to make a worktree from",
            project_path.display()
        )
    })?;
    let repo_root = repo.root().to_path_buf();
    let store = WorktreeStore::with_default_base(&repo_root);

    // An unborn HEAD (a repository with no commits) makes `worktree add` fail
    // with git's own "invalid reference", which says nothing about what to do.
    let base = match base {
        Some(base) => base.to_owned(),
        None => store
            .head_branch()
            .map_err(|error| format!("could not read the branch to fork from: {error}"))?,
    };
    if repo.head_summary().ok().flatten().is_none() {
        return Err(format!(
            "{} has no commits yet — make one before starting a session in a worktree",
            repo_root.display()
        ));
    }

    let worktree = store
        .create(&base)
        .map_err(|error| format!("could not create the worktree: {error}"))?;
    log::info!(
        "worktree {} created at {} off {base}",
        worktree.branch,
        worktree.path.display()
    );
    Ok(SessionWorktree {
        repo_root,
        path: worktree.path,
        branch: worktree.branch,
        name: worktree.name,
        base,
        owned: true,
    })
}

/// Resolves what the composer picked into the worktree a session starts in —
/// `None` meaning the project folder itself.
///
/// Blocking: [`create`] shells out, and borrowing an existing worktree still
/// asks git whether it is one.
pub fn prepare(
    plan: &CheckoutPlan,
    project_path: &Path,
) -> Result<Option<SessionWorktree>, String> {
    match plan {
        CheckoutPlan::CurrentCheckout => Ok(None),
        CheckoutPlan::NewWorktree { base } => create(project_path, base.as_deref()).map(Some),
        CheckoutPlan::ReuseWorktree { path, branch } => {
            adopt(project_path, Path::new(path), branch).map(Some)
        }
    }
}

/// Takes over a worktree that already exists, for a session that picked a ref
/// already checked out in one.
///
/// Verified against git rather than trusted: the picker's list can be a moment
/// stale, and running an agent in a directory that has stopped being a checkout
/// is the failure this is here to prevent.
fn adopt(project_path: &Path, path: &Path, branch: &str) -> Result<SessionWorktree, String> {
    let repo = egant_vcs::Repo::discover(project_path)
        .map_err(|_| format!("{} is not inside a git repository", project_path.display()))?;
    let repo_root = repo.root().to_path_buf();
    let store = WorktreeStore::with_default_base(&repo_root);
    if !store.is_registered(path) {
        return Err(format!(
            "{} is no longer one of this repository's worktrees",
            path.display()
        ));
    }
    // The base is only ever read to ask "is there work in here that nothing
    // else has" — and a borrowed worktree is never removed anyway, so the
    // repository's own branch is a fair reading.
    let base = store.head_branch().unwrap_or_else(|_| branch.to_owned());
    log::info!("session borrowing worktree {} on {branch}", path.display());
    Ok(SessionWorktree {
        repo_root,
        name: path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default(),
        path: path.to_path_buf(),
        branch: branch.to_owned(),
        base,
        owned: false,
    })
}

/// Hands a session's worktree back when the session is closed.
///
/// `force` is the user saying "yes, delete it anyway" and skips every check
/// below. Without it:
///
/// - a worktree sitting on a branch that isn't the one egant created is left
///   alone entirely — the user checked something out in there, and that is
///   theirs;
/// - a worktree with uncommitted changes, or whose branch carries commits its
///   base doesn't have, keeps both its directory and its branch;
/// - anything else is removed, branch included.
pub fn release(worktree: &SessionWorktree, force: bool) -> Released {
    let store = worktree.store();
    let vcs = worktree.as_vcs();

    // Borrowed, not made: the user had this checkout before the session did.
    // `force` overrides it, because that is the user asking for this directory
    // by name.
    if !worktree.owned && !force {
        return Released::NotOurs;
    }

    if force {
        let _ = store.discard(&vcs, true);
        log::info!("worktree {} discarded (forced)", worktree.branch);
        return Released::Removed {
            branch: Some(worktree.branch.clone()),
        };
    }

    let state = store.state(&vcs, &worktree.base);

    if let Some(current) = state.branch.as_deref() {
        if current != worktree.branch {
            return Released::Kept {
                why: format!("it is on {current} now, not the branch egant made for it"),
                path: worktree.path.clone(),
            };
        }
    }

    if state.has_work() {
        return Released::Kept {
            why: describe_work(&state),
            path: worktree.path.clone(),
        };
    }

    let _ = store.discard(&vcs, true);
    log::info!(
        "worktree {} released — nothing in it was unmerged",
        worktree.branch
    );
    Released::Removed {
        branch: Some(worktree.branch.clone()),
    }
}

/// Whether a session's worktree is still there to be reopened in. A worktree
/// removed from a terminal while the app was closed is stale, and the session
/// has to fall back to its project folder rather than spawning the agent in a
/// directory that no longer exists.
pub fn is_live(worktree: &SessionWorktree) -> bool {
    worktree.path.is_dir() && worktree.store().is_registered(&worktree.path)
}

/// The reason a worktree was kept, as a sentence. Counts rather than adjectives:
/// "3 uncommitted files" is something the user can go and check.
fn describe_work(state: &WorktreeState) -> String {
    let mut parts = Vec::new();
    if state.uncommitted > 0 {
        parts.push(format!(
            "{} uncommitted file{}",
            state.uncommitted,
            if state.uncommitted == 1 { "" } else { "s" }
        ));
    }
    match state.unmerged {
        Some(commits) if commits > 0 => parts.push(format!(
            "{commits} commit{} not in its base branch",
            if commits == 1 { "" } else { "s" }
        )),
        None => parts.push("commits git could not account for".to_owned()),
        _ => {}
    }
    if parts.is_empty() {
        // Unreachable through `release`, which only calls this when
        // `has_work()` is true, but a vague sentence beats an empty one.
        return "it still has work in it".to_owned();
    }
    format!("it has {}", parts.join(" and "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "Test")
            .env("GIT_AUTHOR_EMAIL", "test@example.com")
            .env("GIT_COMMITTER_NAME", "Test")
            .env("GIT_COMMITTER_EMAIL", "test@example.com")
            .output()
            .expect("git runs");
        assert!(
            status.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&status.stderr)
        );
    }

    /// A repository with one commit, and a session worktree cut from it into a
    /// temp directory rather than `~/.egant` — `release` only ever reads the
    /// worktree's own path, so the store's base directory is never touched.
    fn session_worktree() -> (tempfile::TempDir, SessionWorktree) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "--quiet"]);
        std::fs::write(root.join("README.md"), "first\n").unwrap();
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "--quiet", "-m", "first"]);

        let store = WorktreeStore::new(&root, dir.path().join("worktrees"));
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();
        let session = SessionWorktree {
            repo_root: root,
            path: worktree.path,
            branch: worktree.branch,
            name: worktree.name,
            base,
            owned: true,
        };
        (dir, session)
    }

    #[test]
    fn an_untouched_worktree_is_removed_with_its_session() {
        let (_dir, worktree) = session_worktree();
        let released = release(&worktree, false);

        assert_eq!(
            released,
            Released::Removed {
                branch: Some(worktree.branch.clone())
            }
        );
        assert!(!worktree.path.exists(), "the checkout is still on disk");
        assert!(!is_live(&worktree));
    }

    #[test]
    fn uncommitted_work_keeps_the_whole_worktree() {
        let (_dir, worktree) = session_worktree();
        std::fs::write(worktree.path.join("draft.md"), "half an idea\n").unwrap();

        let released = release(&worktree, false);
        match released {
            Released::Kept { why, path } => {
                assert_eq!(why, "it has 1 uncommitted file");
                assert_eq!(path, worktree.path);
            }
            other => panic!("closing a session must not delete work: {other:?}"),
        }
        assert!(worktree.path.join("draft.md").is_file());
    }

    #[test]
    fn commits_the_base_branch_never_saw_keep_it_too() {
        let (_dir, worktree) = session_worktree();
        std::fs::write(worktree.path.join("done.md"), "finished\n").unwrap();
        git(&worktree.path, &["add", "done.md"]);
        git(
            &worktree.path,
            &["commit", "--quiet", "-m", "a turn's work"],
        );

        match release(&worktree, false) {
            Released::Kept { why, .. } => {
                assert_eq!(why, "it has 1 commit not in its base branch");
            }
            other => panic!("an unmerged commit must survive its session: {other:?}"),
        }
        assert!(worktree.path.exists());
    }

    #[test]
    fn a_branch_the_user_checked_out_is_left_alone() {
        let (_dir, worktree) = session_worktree();
        git(&worktree.path, &["checkout", "--quiet", "-b", "mine"]);

        match release(&worktree, false) {
            Released::Kept { why, .. } => {
                assert!(
                    why.contains("mine"),
                    "the reason must name the branch: {why}"
                );
            }
            other => panic!("a worktree the user moved is theirs: {other:?}"),
        }
        assert!(worktree.path.exists());
    }

    #[test]
    fn a_borrowed_worktree_is_never_touched() {
        let (_dir, mut worktree) = session_worktree();
        // What `prepare` produces for a ReuseWorktree plan: the checkout
        // existed first, and closing a conversation is not a reason to take it.
        worktree.owned = false;

        assert_eq!(release(&worktree, false), Released::NotOurs);
        assert!(worktree.path.is_dir(), "a borrowed checkout was removed");
        assert!(
            is_live(&worktree),
            "git stopped listing a borrowed worktree"
        );
    }

    #[test]
    fn forcing_deletes_a_worktree_that_would_otherwise_be_kept() {
        let (_dir, worktree) = session_worktree();
        std::fs::write(worktree.path.join("draft.md"), "half an idea\n").unwrap();

        // What "Delete it anyway" answers, once the user has read what is in it.
        let released = release(&worktree, true);
        assert!(matches!(released, Released::Removed { .. }));
        assert!(!worktree.path.exists());
    }

    fn state(uncommitted: usize, unmerged: Option<usize>) -> WorktreeState {
        WorktreeState {
            missing: false,
            uncommitted,
            unmerged,
            branch: Some("egant/quiet-quartz".to_owned()),
        }
    }

    #[test]
    fn kept_worktrees_say_what_is_in_them() {
        assert_eq!(
            describe_work(&state(1, Some(0))),
            "it has 1 uncommitted file"
        );
        assert_eq!(
            describe_work(&state(3, Some(2))),
            "it has 3 uncommitted files and 2 commits not in its base branch"
        );
        assert_eq!(
            describe_work(&state(0, None)),
            "it has commits git could not account for"
        );
    }
}
