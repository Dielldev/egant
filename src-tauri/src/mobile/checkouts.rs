//! Where a chat started from the phone can run: the project's own folder, or
//! a worktree that already exists inside it — never a new one. Worktrees
//! elsewhere on the disk (another tool's, an unrelated checkout of the same
//! repository) are not the project's and are left out.
//!
//! Everything here is read from git on the Mac; the phone names a worktree by
//! its branch (git allows a branch to be checked out in one place only) and
//! never sends a path. The one thing that writes is [`pull`], and it is
//! deliberately small: fast-forward only, on the project folder, and only when
//! nothing there would be touched.
//!
//! All of it shells out to `git` and blocks; callers run it in
//! `spawn_blocking`.

use egant_vcs::remote::{self, run};
use egant_vcs::{Repo, WorktreeStore};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// A fetch younger than this is as good as a new one.
const FETCH_FRESH_SECS: i64 = 120;

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Files with uncommitted changes in a checkout (`git status --porcelain`
/// rows). An unreadable checkout counts as changed, not clean.
fn dirty_count(path: &Path) -> usize {
    run(path, &["status", "--porcelain"])
        .map(|out| out.stdout.lines().filter(|l| !l.trim().is_empty()).count())
        .unwrap_or(1)
}

/// Whether `path` is the project's folder or inside it. Compared resolved, so
/// a symlinked home or `/private/var` doesn't hide a worktree that is there.
fn inside(project: &Path, path: &Path) -> bool {
    let project = project.canonicalize().unwrap_or_else(|_| project.to_path_buf());
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    path.starts_with(project)
}

/// The remote a fetch goes to: the upstream's own, else `origin`, else the
/// first one the repository has.
fn remote_name(root: &Path, upstream: Option<&str>) -> Option<String> {
    if let Some((remote, _)) = upstream.and_then(|u| u.split_once('/')) {
        return Some(remote.to_owned());
    }
    let remotes = remote::remotes(root).ok()?;
    remotes
        .iter()
        .find(|name| *name == "origin")
        .or_else(|| remotes.first())
        .cloned()
}

/// The project folder, and the worktrees inside it, with their branches and
/// uncommitted files. The folder also says how far it is behind its remote
/// branch — `fetch` first brings the remote up to date when the last fetch is
/// stale, the only way "behind" can mean anything.
pub fn list(project_path: &Path, fetch: bool) -> Value {
    let Ok(mut repo) = Repo::discover(project_path) else {
        return json!({ "isRepo": false, "checkouts": [] });
    };
    let root = repo.root().to_path_buf();

    let mut fetch_error: Option<String> = None;
    if fetch {
        let stale = repo
            .last_fetch_unix()
            .is_none_or(|at| now_unix() - at > FETCH_FRESH_SECS);
        if stale && let Some(name) = remote_name(&root, repo.upstream_branch().as_deref()) {
            if let Err(error) = remote::fetch(&root, &name) {
                log::warn!("phone: fetch {name} failed: {error}");
                fetch_error = Some("Couldn't reach the remote.".to_owned());
            }
            // Read the refs the fetch just moved.
            if let Ok(fresh) = Repo::discover(project_path) {
                repo = fresh;
            }
        }
    }

    let branch = repo.head_branch().ok().flatten();
    let upstream = repo.upstream_branch();
    let (ahead, behind) = repo
        .ahead_behind()
        .map(|(a, b)| (Some(a), Some(b)))
        .unwrap_or((None, None));

    let mut checkouts = vec![json!({
        "kind": "project",
        "branch": branch,
        "dirty": dirty_count(&root),
        "ahead": ahead,
        "behind": behind,
        "upstream": upstream,
    })];

    if let Ok(worktrees) = WorktreeStore::with_default_base(&root).list() {
        for worktree in worktrees {
            if worktree.path == root
                || !worktree.path.is_dir()
                || !inside(project_path, &worktree.path)
            {
                continue;
            }
            checkouts.push(json!({
                "kind": "worktree",
                "branch": worktree.branch,
                "name": worktree
                    .branch
                    .strip_prefix(egant_vcs::worktree::BRANCH_PREFIX)
                    .unwrap_or(&worktree.name),
                "dirty": dirty_count(&worktree.path),
            }));
        }
    }

    json!({
        "isRepo": true,
        "lastFetchedUnix": repo.last_fetch_unix(),
        "fetchError": fetch_error,
        "checkouts": checkouts,
    })
}

/// The path of the existing worktree on `branch` inside the project, for a
/// chat to run in.
pub fn worktree_path(project_path: &Path, branch: &str) -> Result<PathBuf, String> {
    let repo = Repo::discover(project_path)
        .map_err(|_| "That project isn't a git repository.".to_owned())?;
    let root = repo.root().to_path_buf();
    WorktreeStore::with_default_base(&root)
        .list()
        .map_err(|error| error.to_string())?
        .into_iter()
        .find(|worktree| {
            worktree.branch == branch
                && worktree.path != root
                && worktree.path.is_dir()
                && inside(project_path, &worktree.path)
        })
        .map(|worktree| worktree.path)
        .ok_or_else(|| "That worktree isn't on your Mac any more.".to_owned())
}

/// `git pull --ff-only` on the project folder's own branch. Refuses — saying
/// why, touching nothing — when the folder has uncommitted changes, is in the
/// middle of a merge or rebase, or has no remote branch to pull from; git
/// itself refuses a branch that has diverged.
pub fn pull(project_path: &Path) -> Result<Value, String> {
    let repo = Repo::discover(project_path)
        .map_err(|_| "That project isn't a git repository.".to_owned())?;
    let root = repo.root().to_path_buf();
    egant_vcs::conflict::ensure_clear(&root).map_err(|error| error.to_string())?;
    let dirty = dirty_count(&root);
    if dirty > 0 {
        return Err(format!(
            "Your Mac's checkout has {dirty} uncommitted {}. Commit or stash {} first.",
            if dirty == 1 { "file" } else { "files" },
            if dirty == 1 { "it" } else { "them" },
        ));
    }
    let upstream = repo
        .upstream_branch()
        .ok_or_else(|| "This branch has no remote branch to pull from.".to_owned())?;
    let (name, branch) = upstream
        .split_once('/')
        .ok_or_else(|| "This branch has no remote branch to pull from.".to_owned())?;
    let output = remote::pull_ff_only(&root, name, branch).map_err(|error| {
        log::warn!("phone: pull {upstream} failed: {error}");
        let text = error.to_string();
        if text.contains("fast-forward") || text.contains("diverg") {
            "The branch has diverged from the remote, so it can't be fast-forwarded. Sort that out on your Mac.".to_owned()
        } else {
            "The pull didn't go through. Check the remote on your Mac.".to_owned()
        }
    })?;
    log::info!("phone: pulled {upstream}: {}", output.summary());
    Ok(list(project_path, false))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn git(dir: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(["-c", "user.name=t", "-c", "user.email=t@t"])
            .args(args)
            .current_dir(dir)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("egant-checkouts-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn lists_only_worktrees_inside_the_project_and_makes_none() {
        let root = scratch("list");
        let repo = root.join("app");
        std::fs::create_dir_all(&repo).unwrap();
        git(&repo, &["init", "-b", "main"]);
        std::fs::write(repo.join("a.txt"), "a").unwrap();
        std::fs::write(repo.join(".git/info/exclude"), ".wt/\n").unwrap();
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-m", "one"]);
        let inside_tree = repo.join(".wt/feature");
        git(&repo, &["worktree", "add", "-b", "egant/feature", inside_tree.to_str().unwrap()]);
        let elsewhere = root.join("other");
        git(&repo, &["worktree", "add", "-b", "other-tool/x", elsewhere.to_str().unwrap()]);
        std::fs::write(inside_tree.join("b.txt"), "b").unwrap();

        let listed = list(&repo, false);
        assert_eq!(listed["isRepo"], true);
        let checkouts = listed["checkouts"].as_array().unwrap();
        assert_eq!(checkouts.len(), 2, "{checkouts:?}");
        assert_eq!(checkouts[0]["kind"], "project");
        assert_eq!(checkouts[0]["branch"], "main");
        assert_eq!(checkouts[0]["dirty"], 0);
        assert_eq!(checkouts[1]["kind"], "worktree");
        assert_eq!(checkouts[1]["branch"], "egant/feature");
        assert_eq!(checkouts[1]["name"], "feature");
        assert_eq!(checkouts[1]["dirty"], 1);

        let found = worktree_path(&repo, "egant/feature").unwrap();
        assert_eq!(found.canonicalize().unwrap(), inside_tree.canonicalize().unwrap());
        // Another tool's worktree is not the project's to run in, even by name.
        assert!(worktree_path(&repo, "other-tool/x").is_err());
        assert!(worktree_path(&repo, "main").is_err());
        assert!(worktree_path(&repo, "nope").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn pull_refuses_dirty_folders_and_branches_with_no_remote() {
        let root = scratch("pull");
        git(&root, &["init", "-b", "main"]);
        std::fs::write(root.join("a.txt"), "a").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-m", "one"]);
        let error = pull(&root).unwrap_err();
        assert!(error.contains("no remote branch"), "{error}");
        std::fs::write(root.join("a.txt"), "changed").unwrap();
        let error = pull(&root).unwrap_err();
        assert!(error.contains("uncommitted"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn not_a_repository_is_said_plainly() {
        let dir = scratch("plain");
        assert_eq!(list(&dir, false)["isRepo"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
