//! Network git operations, by way of the user's own `git`.
//!
//! These deliberately do *not* go through libgit2. Pushing needs credentials,
//! and the user's credentials already live in places only `git` knows how to
//! reach: the macOS keychain helper, an SSH agent, a `credential.helper` in
//! their config, a hardware key. Reimplementing that lookup inside the app
//! means a second, worse credential path and a prompt the user has to answer
//! twice. Shelling out inherits all of it for free — and inherits their
//! `.gitconfig`, hooks and proxy settings along with it.
//!
//! The cost is that output is text rather than structured, so callers get
//! stdout/stderr and an exit status instead of typed progress.

use crate::VcsError;
use std::path::Path;
use std::process::{Command, Output};

#[derive(Debug, Clone)]
pub struct GitOutput {
    pub stdout: String,
    pub stderr: String,
}

impl GitOutput {
    /// What to show in the panel: git puts progress on stderr, so a successful
    /// push has its interesting output there, not on stdout.
    pub fn summary(&self) -> &str {
        if self.stdout.trim().is_empty() {
            self.stderr.trim()
        } else {
            self.stdout.trim()
        }
    }
}

/// Runs `git` in `root`, returning an error for any non-zero exit.
pub fn run(root: &Path, args: &[&str]) -> Result<GitOutput, VcsError> {
    let output: Output = Command::new("git")
        .args(args)
        .current_dir(root)
        // Never let git open an interactive prompt behind the app's back: with
        // no terminal attached it would hang forever. Failing loudly lets the
        // UI tell the user to authenticate instead.
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();

    if output.status.success() {
        Ok(GitOutput { stdout, stderr })
    } else {
        Err(VcsError::GitFailed {
            status: output.status.code().unwrap_or(-1),
            stderr: if stderr.trim().is_empty() {
                stdout
            } else {
                stderr
            },
        })
    }
}

pub fn push(root: &Path, remote: &str, branch: &str) -> Result<GitOutput, VcsError> {
    run(root, &["push", remote, branch])
}

/// First push of a new branch: sets the upstream so later pushes need no args.
pub fn push_set_upstream(root: &Path, remote: &str, branch: &str) -> Result<GitOutput, VcsError> {
    run(root, &["push", "--set-upstream", remote, branch])
}

pub fn fetch(root: &Path, remote: &str) -> Result<GitOutput, VcsError> {
    run(root, &["fetch", remote])
}

pub fn pull_ff_only(root: &Path, remote: &str, branch: &str) -> Result<GitOutput, VcsError> {
    run(root, &["pull", "--ff-only", remote, branch])
}

/// Remote names, in config order.
pub fn remotes(root: &Path) -> Result<Vec<String>, VcsError> {
    Ok(run(root, &["remote"])?
        .stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect())
}
