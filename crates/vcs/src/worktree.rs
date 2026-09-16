//! Isolated checkouts, one per agent session.
//!
//! An agent that edits files in the user's working tree makes two things
//! impossible: reviewing what it did (the diff moves while you read it), and
//! running two sessions at once. A worktree per session fixes both — each
//! session gets a real checkout on its own branch, and the user's tree is never
//! touched until they merge.
//!
//! Worktrees live under `~/.egant/worktrees/<session>` by default. As with
//! [`crate::remote`], these shell out to `git`: worktree creation writes
//! `.git/worktrees` bookkeeping that the user's own `git` must agree with.

use crate::VcsError;
use crate::remote::run;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Worktree {
    /// Directory the agent runs in.
    pub path: PathBuf,
    /// Branch checked out there.
    pub branch: String,
}

/// Creates and tracks session worktrees for one repository.
pub struct WorktreeStore {
    repo_root: PathBuf,
    base_dir: PathBuf,
}

impl WorktreeStore {
    /// `base_dir` is where new worktrees are created; use [`default_base_dir`]
    /// unless a test needs somewhere else.
    pub fn new(repo_root: impl Into<PathBuf>, base_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            base_dir: base_dir.into(),
        }
    }

    pub fn with_default_base(repo_root: impl Into<PathBuf>) -> Self {
        Self::new(repo_root, default_base_dir())
    }

    /// Creates a worktree on a new branch off `start_point` (defaults to HEAD).
    pub fn create(
        &self,
        session_name: &str,
        start_point: Option<&str>,
    ) -> Result<Worktree, VcsError> {
        let slug = slugify(session_name);
        let path = self.base_dir.join(&slug);
        let branch = format!("egant/{slug}");

        std::fs::create_dir_all(&self.base_dir)?;

        let path_arg = path.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "add", "-b", &branch, &path_arg];
        if let Some(start) = start_point {
            args.push(start);
        }
        run(&self.repo_root, &args)?;

        Ok(Worktree { path, branch })
    }

    /// Removes a worktree and its bookkeeping. `force` discards uncommitted
    /// changes inside it — the caller is responsible for asking first.
    pub fn remove(&self, worktree: &Worktree, force: bool) -> Result<(), VcsError> {
        let path_arg = worktree.path.to_string_lossy().into_owned();
        let mut args = vec!["worktree", "remove", &path_arg];
        if force {
            args.push("--force");
        }
        run(&self.repo_root, &args)?;
        Ok(())
    }

    /// Worktrees git knows about, parsed from `git worktree list --porcelain`.
    pub fn list(&self) -> Result<Vec<Worktree>, VcsError> {
        let output = run(&self.repo_root, &["worktree", "list", "--porcelain"])?;
        let mut worktrees = Vec::new();
        let mut path: Option<PathBuf> = None;

        for line in output.stdout.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = Some(PathBuf::from(rest));
            } else if let Some(rest) = line.strip_prefix("branch ") {
                if let Some(path) = path.take() {
                    worktrees.push(Worktree {
                        path,
                        branch: rest.trim_start_matches("refs/heads/").to_owned(),
                    });
                }
            }
        }
        Ok(worktrees)
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }
}

/// `~/.egant/worktrees`, matching where the app keeps the rest of its state.
pub fn default_base_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".egant").join("worktrees")
}

/// Turns a session title into something safe for a path and a branch name.
fn slugify(name: &str) -> String {
    let mut slug: String = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();

    while slug.contains("--") {
        slug = slug.replace("--", "-");
    }
    let slug = slug.trim_matches('-').to_owned();
    if slug.is_empty() {
        "session".to_owned()
    } else {
        slug.chars().take(48).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_are_path_and_branch_safe() {
        assert_eq!(slugify("Fix the CI build!"), "fix-the-ci-build");
        assert_eq!(slugify("  "), "session");
        assert_eq!(slugify("a//b"), "a-b");
    }

    #[test]
    fn slugs_are_bounded() {
        assert!(slugify(&"x".repeat(200)).len() <= 48);
    }

    #[test]
    fn default_base_lives_under_the_app_directory() {
        let base = default_base_dir();
        assert!(base.ends_with("worktrees"));
        assert!(base.to_string_lossy().contains(".egant"));
    }
}
