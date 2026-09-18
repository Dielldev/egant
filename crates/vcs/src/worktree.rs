//! Isolated checkouts, one per agent session.
//!
//! An agent that edits files in the user's working tree makes two things
//! impossible: reviewing what it did (the diff moves while you read it), and
//! running two sessions at once. A worktree per session fixes both — each
//! session gets a real checkout on its own branch, and the user's tree is never
//! touched until they merge.
//!
//! Worktrees live under `~/.egant/worktrees/<repo>/<name>` by default. As with
//! [`crate::remote`], these shell out to `git`: worktree creation writes
//! `.git/worktrees` bookkeeping that the user's own `git` must agree with.
//!
//! Names are generated (`quiet-quartz`) rather than taken from the session's
//! title. A title is renamed the moment the agent has understood the task; a
//! path cannot be, so naming the folder after the title would mean either a
//! rename the user's open terminals don't follow, or a folder called
//! `new-session-3` forever.

use crate::VcsError;
use crate::remote::run;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Branch prefix for every worktree egant cuts. Deleting is keyed off it: a
/// branch that no longer carries the prefix is one the user checked out
/// themselves, and is never removed on their behalf.
pub const BRANCH_PREFIX: &str = "egant/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Worktree {
    /// Directory the agent runs in.
    pub path: PathBuf,
    /// Branch checked out there when it was created.
    pub branch: String,
    /// The generated folder name (`quiet-quartz`); `egant/<name>` is its branch.
    pub name: String,
}

/// A local branch, and where — if anywhere — it is currently checked out.
///
/// The two flags are what let a picker say what starting a session on this ref
/// would actually mean: `current` is the folder the user opened, and
/// `worktree_path` is a checkout that already exists and can simply be run in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoRef {
    pub name: String,
    /// Checked out in the repository's main folder right now.
    pub current: bool,
    /// The linked worktree this branch is checked out in, if any. Git allows
    /// one checkout per branch, so this is at most one path.
    pub worktree_path: Option<PathBuf>,
}

/// What removing a worktree would throw away. Every field degrades to "assume
/// there is something here" when git can't answer, so an unreadable checkout is
/// kept rather than deleted on a guess.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeState {
    /// The directory is gone — nothing to remove but the bookkeeping.
    pub missing: bool,
    /// Files with uncommitted changes, `git status --porcelain` rows.
    pub uncommitted: usize,
    /// Commits on the branch that its base doesn't have. `None` when git could
    /// not answer (the base branch was deleted, the branch was rewritten).
    pub unmerged: Option<usize>,
    /// Branch checked out there *now* — not necessarily the one egant created,
    /// since nothing stops the user checking out something else inside it.
    pub branch: Option<String>,
}

impl WorktreeState {
    /// Whether anything would be lost. An unanswerable `unmerged` counts as
    /// work: the point of the check is to not delete what we can't account for.
    pub fn has_work(&self) -> bool {
        self.uncommitted > 0 || self.unmerged.is_none_or(|commits| commits > 0)
    }
}

/// Creates and tracks session worktrees for one repository.
pub struct WorktreeStore {
    repo_root: PathBuf,
    base_dir: PathBuf,
}

impl WorktreeStore {
    /// `base_dir` is where new worktrees are created; use
    /// [`WorktreeStore::with_default_base`] unless a test needs somewhere else.
    pub fn new(repo_root: impl Into<PathBuf>, base_dir: impl Into<PathBuf>) -> Self {
        Self {
            repo_root: repo_root.into(),
            base_dir: base_dir.into(),
        }
    }

    /// Worktrees for this repository under the app's own directory, in a folder
    /// named after the repository — so `~/.egant/worktrees` stays legible when
    /// half a dozen projects are open.
    pub fn with_default_base(repo_root: impl Into<PathBuf>) -> Self {
        let repo_root = repo_root.into();
        let folder = repo_root
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "repo".to_owned());
        let base = default_base_dir().join(folder);
        Self::new(repo_root, base)
    }

    /// The repository these worktrees are cut from.
    pub fn repo_root(&self) -> &Path {
        &self.repo_root
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// The branch the repository itself is on — what a worktree is cut from
    /// unless the caller names something else, and what its work is measured
    /// against afterwards.
    pub fn head_branch(&self) -> Result<String, VcsError> {
        let out = run(&self.repo_root, &["branch", "--show-current"])?;
        let branch = out.stdout.trim();
        if branch.is_empty() {
            // Detached HEAD: name the commit, which is still a valid base.
            let head = run(&self.repo_root, &["rev-parse", "HEAD"])?;
            return Ok(head.stdout.trim().to_owned());
        }
        Ok(branch.to_owned())
    }

    /// Creates a worktree on a fresh `egant/<name>` branch off `start_point`.
    ///
    /// The name is generated and checked against both the directories already
    /// under `base_dir` and the branches the repository already has, so two
    /// sessions started in the same second cannot land on the same one.
    pub fn create(&self, start_point: &str) -> Result<Worktree, VcsError> {
        std::fs::create_dir_all(&self.base_dir)?;
        let taken = self.branch_names().unwrap_or_default();
        let name = self.allocate_name(&taken)?;
        let path = self.base_dir.join(&name);
        let branch = format!("{BRANCH_PREFIX}{name}");

        let path_arg = path.to_string_lossy().into_owned();
        run(
            &self.repo_root,
            &["worktree", "add", "-b", &branch, &path_arg, start_point],
        )?;

        Ok(Worktree { path, branch, name })
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

    /// Gives a worktree back: remove the checkout, then drop its branch when
    /// `delete_branch` says the work in it is accounted for.
    ///
    /// Best-effort by design — this runs when a session is closed, and a
    /// half-removed directory must not leave the repository carrying
    /// bookkeeping for a worktree that no longer exists. If `git` refuses the
    /// removal the folder goes directly and `prune` reconciles the rest.
    ///
    /// The branch is only ever deleted when it is still one of ours: the user
    /// may have checked out their own branch inside the worktree, and that
    /// branch is not egant's to remove.
    pub fn discard(&self, worktree: &Worktree, delete_branch: bool) -> Result<(), VcsError> {
        if worktree.path.exists() && self.remove(worktree, true).is_err() {
            // git refused (or the directory is half-gone) — take the folder
            // directly and let `prune` clean up after it.
            let _ = std::fs::remove_dir_all(&worktree.path);
        }
        let _ = run(&self.repo_root, &["worktree", "prune"]);

        if delete_branch && worktree.branch.starts_with(BRANCH_PREFIX) {
            let _ = run(&self.repo_root, &["branch", "-D", &worktree.branch]);
        }
        Ok(())
    }

    /// What is in a worktree that its base branch doesn't already have.
    ///
    /// Never fails: a worktree that can't be read answers "there is work here",
    /// because the only thing this is used for is deciding whether deleting it
    /// would lose something.
    pub fn state(&self, worktree: &Worktree, base: &str) -> WorktreeState {
        // Asked of the repository, not the worktree, so a checkout that has
        // already been deleted still reports whether its branch carries
        // commits nothing else has.
        let unmerged = run(
            &self.repo_root,
            &[
                "rev-list",
                "--count",
                &format!("{base}..{}", worktree.branch),
            ],
        )
        .ok()
        .and_then(|out| out.stdout.trim().parse::<usize>().ok());

        if !worktree.path.is_dir() {
            return WorktreeState {
                missing: true,
                uncommitted: 0,
                unmerged,
                branch: None,
            };
        }
        let uncommitted = run(&worktree.path, &["status", "--porcelain"])
            .map(|out| {
                out.stdout
                    .lines()
                    .filter(|line| !line.trim().is_empty())
                    .count()
            })
            // Unreadable: see `has_work` — an unanswerable worktree is kept.
            .unwrap_or(1);
        let branch = run(&worktree.path, &["branch", "--show-current"])
            .ok()
            .map(|out| out.stdout.trim().to_owned())
            .filter(|branch| !branch.is_empty());

        WorktreeState {
            missing: false,
            uncommitted,
            unmerged,
            branch,
        }
    }

    /// Whether git still knows this path as one of the repository's worktrees.
    /// A worktree removed from a terminal (or pruned) is stale here, and the
    /// session holding it has to fall back to its project folder.
    pub fn is_registered(&self, path: &Path) -> bool {
        let Ok(worktrees) = self.list() else {
            return false;
        };
        worktrees
            .iter()
            .any(|worktree| same_path(&worktree.path, path))
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
                    let name = path
                        .file_name()
                        .map(|name| name.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    worktrees.push(Worktree {
                        path,
                        branch: rest.trim_start_matches("refs/heads/").to_owned(),
                        name,
                    });
                }
            }
        }
        Ok(worktrees)
    }

    /// Every local branch, most recently committed to first, each carrying
    /// where it is checked out.
    ///
    /// Ordered by commit date rather than alphabetically because a branch
    /// picker is nearly always reaching for something recent, and a repository
    /// with two hundred branches makes that the difference between a list and
    /// a search.
    pub fn refs(&self) -> Result<Vec<RepoRef>, VcsError> {
        let mut current: Option<String> = None;
        let mut in_worktree: HashMap<String, PathBuf> = HashMap::new();
        for worktree in self.list()? {
            // git lists the main working tree first, but match on the path
            // rather than the order — the repository's own folder is the one
            // thing here that is not a linked worktree.
            if same_path(&worktree.path, &self.repo_root) {
                current = Some(worktree.branch);
            } else {
                in_worktree.insert(worktree.branch, worktree.path);
            }
        }

        let output = run(
            &self.repo_root,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)",
                "refs/heads",
            ],
        )?;
        Ok(output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(|name| RepoRef {
                current: current.as_deref() == Some(name),
                worktree_path: in_worktree.get(name).cloned(),
                name: name.to_owned(),
            })
            .collect())
    }

    /// Every local branch name, for collision checks.
    fn branch_names(&self) -> Result<HashSet<String>, VcsError> {
        let output = run(
            &self.repo_root,
            &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        )?;
        Ok(output
            .stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(str::to_owned)
            .collect())
    }

    /// A name that is neither a directory already under `base_dir` nor an
    /// existing branch. The clock is the only entropy here: a `rand` dependency
    /// for two array indices is not worth it, and the collision checks are what
    /// actually make the name unique.
    fn allocate_name(&self, taken: &HashSet<String>) -> Result<String, VcsError> {
        for attempt in 0..64u64 {
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|since| u64::from(since.subsec_nanos()))
                .unwrap_or(attempt)
                // Golden-ratio step, so consecutive attempts inside one
                // nanosecond still land on different pairs.
                .wrapping_add(attempt.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let candidate = format!(
                "{}-{}",
                ADJECTIVES[(seed % ADJECTIVES.len() as u64) as usize],
                NOUNS[((seed / 31) % NOUNS.len() as u64) as usize],
            );
            if !self.base_dir.join(&candidate).exists()
                && !taken.contains(&format!("{BRANCH_PREFIX}{candidate}"))
            {
                return Ok(candidate);
            }
        }
        Err(VcsError::GitFailed {
            status: -1,
            stderr: "could not find an unused worktree name".to_owned(),
        })
    }
}

/// `~/.egant/worktrees`, matching where the app keeps the rest of its state.
pub fn default_base_dir() -> PathBuf {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    home.join(".egant").join("worktrees")
}

/// Compares two paths the way the rest of the app does — through
/// `canonicalize` where possible, since git prints the resolved path
/// (`/private/tmp/...`) for a directory the app recorded as `/tmp/...`.
fn same_path(a: &Path, b: &Path) -> bool {
    let left = a.canonicalize().unwrap_or_else(|_| a.to_path_buf());
    let right = b.canonicalize().unwrap_or_else(|_| b.to_path_buf());
    left == right
}

/// Deliberately bland and short: these end up in a path, a branch name and the
/// sidebar, and a name that tries to be funny stops being funny by the fortieth
/// session.
const ADJECTIVES: &[&str] = &[
    "amber", "brisk", "calm", "clear", "copper", "dry", "even", "fair", "fresh", "gentle", "ivory",
    "jade", "keen", "level", "mellow", "north", "olive", "plain", "quiet", "rapid", "slate",
    "still", "swift", "warm",
];

const NOUNS: &[&str] = &[
    "anchor", "basin", "cedar", "delta", "ember", "field", "grove", "harbor", "inlet", "jetty",
    "kiln", "ledge", "meadow", "notch", "orchard", "pebble", "quartz", "ridge", "summit",
    "thicket", "vale", "willow", "yard", "zenith",
];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::Repo;

    fn store() -> WorktreeStore {
        WorktreeStore::new("/tmp/egant-test/repo", "/tmp/egant-test/worktrees-empty")
    }

    /// A real repository with one commit, and a store that cuts worktrees into
    /// a sibling directory of it. `git worktree add` refuses an unborn HEAD, so
    /// the commit is not optional.
    fn repo_with_store() -> (tempfile::TempDir, Repo, WorktreeStore) {
        let dir = tempfile::tempdir().expect("a temp dir");
        let root = dir.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let repository = git2::Repository::init(&root).unwrap();
        let mut config = repository.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        drop(config);

        let repo = Repo::discover(&root).unwrap();
        std::fs::write(root.join("README.md"), "first\n").unwrap();
        repo.stage(&[PathBuf::from("README.md")]).unwrap();
        repo.commit("first").unwrap();

        let store = WorktreeStore::new(&root, dir.path().join("worktrees"));
        (dir, repo, store)
    }

    #[test]
    fn generated_names_are_path_and_branch_safe() {
        let name = store().allocate_name(&HashSet::new()).expect("a name");
        assert!(name.contains('-'));
        assert!(
            name.chars().all(|c| c.is_ascii_lowercase() || c == '-'),
            "{name} is not safe for a path or a ref"
        );
    }

    #[test]
    fn taken_branches_are_skipped() {
        // Every name this store could generate is already a branch, so there is
        // nothing left to allocate and the caller is told so rather than handed
        // a name that `git worktree add` would reject.
        let taken: HashSet<String> = ADJECTIVES
            .iter()
            .flat_map(|adjective| {
                NOUNS
                    .iter()
                    .map(move |noun| format!("{BRANCH_PREFIX}{adjective}-{noun}"))
            })
            .collect();
        assert!(store().allocate_name(&taken).is_err());
    }

    #[test]
    fn default_base_lives_under_the_app_directory() {
        let base = default_base_dir();
        assert!(base.ends_with("worktrees"));
        assert!(base.to_string_lossy().contains(".egant"));
    }

    #[test]
    fn worktrees_are_grouped_by_repository() {
        let store = WorktreeStore::with_default_base("/Users/someone/projects/egant");
        assert!(store.base_dir().ends_with("worktrees/egant"));
    }

    #[test]
    fn a_created_worktree_is_a_checkout_on_its_own_branch() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();

        assert!(worktree.path.join("README.md").is_file(), "not a checkout");
        assert_eq!(worktree.branch, format!("{BRANCH_PREFIX}{}", worktree.name));
        assert!(store.is_registered(&worktree.path));
        assert!(
            store
                .list()
                .unwrap()
                .iter()
                .any(|listed| listed.branch == worktree.branch)
        );
    }

    #[test]
    fn refs_say_where_each_branch_is_checked_out() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();

        let refs = store.refs().unwrap();
        let current = refs
            .iter()
            .find(|row| row.name == base)
            .expect("the repository's own branch is a ref");
        assert!(current.current, "{base} is what the project folder is on");
        assert!(current.worktree_path.is_none());

        let cut = refs
            .iter()
            .find(|row| row.name == worktree.branch)
            .expect("the worktree's branch is a ref");
        assert!(!cut.current, "a worktree's branch is not the main checkout");
        // git answers with the resolved path (`/private/var/…` for a `/var/…`
        // temp dir on macOS), which is why every path comparison in this
        // module goes through `same_path` rather than `==`.
        let path = cut.worktree_path.as_deref().expect("a materialized branch");
        assert!(
            same_path(path, &worktree.path),
            "{} is not {}",
            path.display(),
            worktree.path.display()
        );
    }

    #[test]
    fn two_worktrees_of_one_repo_do_not_collide() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let first = store.create(&base).unwrap();
        let second = store.create(&base).unwrap();

        assert_ne!(first.name, second.name);
        assert_ne!(first.branch, second.branch);
        assert!(first.path.is_dir() && second.path.is_dir());
    }

    #[test]
    fn a_fresh_worktree_holds_nothing_the_repository_does_not() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();

        let state = store.state(&worktree, &base);
        assert!(!state.missing);
        assert_eq!(state.uncommitted, 0);
        assert_eq!(state.unmerged, Some(0));
        assert_eq!(state.branch.as_deref(), Some(worktree.branch.as_str()));
        assert!(!state.has_work(), "an untouched worktree is safe to remove");
    }

    #[test]
    fn edits_and_commits_inside_a_worktree_both_count_as_work() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();

        std::fs::write(worktree.path.join("notes.md"), "in progress\n").unwrap();
        let dirty = store.state(&worktree, &base);
        assert_eq!(dirty.uncommitted, 1);
        assert!(dirty.has_work());

        // Committing settles the working tree but not the branch: the commit
        // is still something the base branch has never seen.
        let inner = Repo::discover(&worktree.path).unwrap();
        inner.stage(&[PathBuf::from("notes.md")]).unwrap();
        inner.commit("a turn's work").unwrap();

        let committed = store.state(&worktree, &base);
        assert_eq!(committed.uncommitted, 0);
        assert_eq!(committed.unmerged, Some(1));
        assert!(committed.has_work(), "unmerged commits must not be deleted");
    }

    #[test]
    fn discarding_takes_the_checkout_and_the_branch_with_it() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();

        store.discard(&worktree, true).unwrap();
        assert!(!worktree.path.exists(), "the checkout is still on disk");
        assert!(!store.is_registered(&worktree.path), "git still lists it");
        assert!(
            !store.branch_names().unwrap().contains(&worktree.branch),
            "the branch outlived its worktree"
        );
    }

    #[test]
    fn a_branch_worth_keeping_survives_its_checkout() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();

        // What the caller does when the worktree holds commits: the directory
        // goes, the work stays reachable by branch name.
        store.discard(&worktree, false).unwrap();
        assert!(!worktree.path.exists());
        assert!(store.branch_names().unwrap().contains(&worktree.branch));
    }

    #[test]
    fn a_checkout_deleted_behind_our_back_still_answers_for_its_branch() {
        let (_dir, _repo, store) = repo_with_store();
        let base = store.head_branch().unwrap();
        let worktree = store.create(&base).unwrap();
        std::fs::remove_dir_all(&worktree.path).unwrap();

        let state = store.state(&worktree, &base);
        assert!(state.missing);
        assert_eq!(state.unmerged, Some(0), "the branch is still readable");
        assert!(!state.has_work());
        // And removing it is still what reconciles git's own bookkeeping.
        store.discard(&worktree, true).unwrap();
        assert!(!store.is_registered(&worktree.path));
    }

    #[test]
    fn unreadable_work_counts_as_work() {
        let state = WorktreeState {
            missing: false,
            uncommitted: 0,
            unmerged: None,
            branch: None,
        };
        assert!(
            state.has_work(),
            "an unanswerable branch must never be deleted"
        );

        let settled = WorktreeState {
            missing: false,
            uncommitted: 0,
            unmerged: Some(0),
            branch: Some("egant/quiet-quartz".to_owned()),
        };
        assert!(!settled.has_work());
    }
}
