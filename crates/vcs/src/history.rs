//! The repository's commit graph, a page at a time.
//!
//! Read through libgit2 rather than `git log`, for the same reason
//! [`crate::repo`] reads status that way: this runs whenever the History tab
//! is open, and a subprocess per scroll is a subprocess too many.
//!
//! A page is deliberately shallow. A repository with a hundred thousand
//! commits should cost the same to open as one with ten, so the walk is
//! `skip`ped and `take`n rather than collected and sliced.

use crate::VcsError;
use crate::repo::Repo;
use git2::{Oid, Sort};
use std::collections::HashMap;

/// What a ref pointing at a commit is, for the chips a row carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefKind {
    Branch,
    Remote,
    Tag,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitRef {
    pub kind: RefKind,
    pub label: String,
}

/// One row of the graph.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Commit {
    pub sha: String,
    /// Full ids, so a merge row can say how many sides it has without a second
    /// lookup.
    pub parents: Vec<String>,
    pub subject: String,
    pub author_name: String,
    pub author_email: String,
    /// Seconds since the epoch, in UTC. Formatting belongs to whoever draws it.
    pub authored_unix: i64,
    /// Branches and tags that point at this commit.
    pub refs: Vec<CommitRef>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct HistoryPage {
    pub commits: Vec<Commit>,
    /// Where the commit the repository is on sits, so the list can mark it.
    pub head_sha: Option<String>,
    /// Pass back as `skip` for the next page; `None` at the end of the walk.
    pub next_cursor: Option<usize>,
}

impl Repo {
    /// A page of history starting at `start` (HEAD when `None`), skipping
    /// `skip` commits.
    ///
    /// An unborn HEAD — a repository with no commits — is an empty page rather
    /// than an error: a fresh project opens the tab and sees nothing, which is
    /// the truth.
    pub fn history(
        &self,
        start: Option<&str>,
        skip: usize,
        limit: usize,
    ) -> Result<HistoryPage, VcsError> {
        let head = match self.inner.head() {
            Ok(head) => head.peel_to_commit().ok(),
            Err(_) => None,
        };
        let tip = match start {
            Some(name) => self
                .inner
                .revparse_single(name)
                .and_then(|object| object.peel_to_commit())
                .ok(),
            None => head.clone(),
        };
        let Some(tip) = tip else {
            return Ok(HistoryPage::default());
        };

        let decorations = self.decorations();
        let mut walk = self.inner.revwalk()?;
        // Topological as well as by date: a branch merged long after it was
        // written must not interleave its commits with the trunk's.
        walk.set_sorting(Sort::TOPOLOGICAL | Sort::TIME)?;
        walk.push(tip.id())?;

        let mut commits = Vec::with_capacity(limit);
        let mut seen = 0usize;
        let mut more = false;
        for oid in walk {
            let Ok(oid) = oid else { continue };
            seen += 1;
            if seen <= skip {
                continue;
            }
            if commits.len() == limit {
                // One past the page: enough to know there is a next one
                // without walking the rest of the repository to count it.
                more = true;
                break;
            }
            let Ok(commit) = self.inner.find_commit(oid) else {
                continue;
            };
            let author = commit.author();
            commits.push(Commit {
                sha: oid.to_string(),
                parents: commit.parent_ids().map(|id| id.to_string()).collect(),
                subject: commit
                    .summary()
                    .ok()
                    .flatten()
                    .unwrap_or("(no message)")
                    .to_owned(),
                author_name: author.name().unwrap_or("unknown").to_owned(),
                author_email: author.email().unwrap_or_default().to_owned(),
                authored_unix: author.when().seconds(),
                refs: decorations.get(&oid).cloned().unwrap_or_default(),
            });
        }

        Ok(HistoryPage {
            commits,
            head_sha: head.map(|commit| commit.id().to_string()),
            next_cursor: more.then_some(skip + limit),
        })
    }

    /// Every branch and tag, grouped by the commit it points at. Gathered once
    /// per page: asking per row would walk the ref store for every commit on
    /// screen.
    fn decorations(&self) -> HashMap<Oid, Vec<CommitRef>> {
        let mut map: HashMap<Oid, Vec<CommitRef>> = HashMap::new();
        let Ok(references) = self.inner.references() else {
            return map;
        };
        for reference in references.flatten() {
            let kind = if reference.is_branch() {
                RefKind::Branch
            } else if reference.is_remote() {
                RefKind::Remote
            } else if reference.is_tag() {
                RefKind::Tag
            } else {
                continue;
            };
            // A non-UTF-8 ref name has nothing to draw; skip it rather than
            // fail the page over one.
            let Ok(label) = reference.shorthand().map(str::to_owned) else {
                continue;
            };
            // A tag is an object of its own; peeling gets to the commit it
            // names, which is the row it belongs on.
            let Ok(commit) = reference.peel_to_commit() else {
                continue;
            };
            map.entry(commit.id()).or_default().push(CommitRef { kind, label });
        }
        for refs in map.values_mut() {
            // Branches before remotes before tags, alphabetical within each,
            // so a row's chips don't reshuffle between renders.
            refs.sort_by(|a, b| order(a.kind).cmp(&order(b.kind)).then(a.label.cmp(&b.label)));
        }
        map
    }
}

fn order(kind: RefKind) -> u8 {
    match kind {
        RefKind::Branch => 0,
        RefKind::Remote => 1,
        RefKind::Tag => 2,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A repository with three commits on a branch of its own.
    fn repo_with_commits() -> (tempfile::TempDir, Repo) {
        let dir = tempfile::tempdir().unwrap();
        let repository = git2::Repository::init(dir.path()).unwrap();
        let mut config = repository.config().unwrap();
        config.set_str("user.name", "Test").unwrap();
        config.set_str("user.email", "test@example.com").unwrap();
        drop(config);
        let repo = Repo::discover(dir.path()).unwrap();
        for n in 1..=3 {
            std::fs::write(dir.path().join(format!("{n}.txt")), format!("file {n}\n")).unwrap();
            repo.stage(&[PathBuf::from(format!("{n}.txt"))]).unwrap();
            repo.commit(&format!("commit {n}")).unwrap();
        }
        (dir, repo)
    }

    #[test]
    fn history_is_newest_first() {
        let (_dir, repo) = repo_with_commits();
        let page = repo.history(None, 0, 10).unwrap();

        let subjects: Vec<&str> = page.commits.iter().map(|c| c.subject.as_str()).collect();
        assert_eq!(subjects, ["commit 3", "commit 2", "commit 1"]);
        assert_eq!(page.head_sha.as_deref(), Some(page.commits[0].sha.as_str()));
        assert_eq!(page.next_cursor, None, "three commits is not a full page");
    }

    #[test]
    fn pages_pick_up_where_the_last_one_stopped() {
        let (_dir, repo) = repo_with_commits();
        let first = repo.history(None, 0, 2).unwrap();
        assert_eq!(first.commits.len(), 2);
        let cursor = first.next_cursor.expect("a third commit is waiting");

        let second = repo.history(None, cursor, 2).unwrap();
        assert_eq!(second.commits.len(), 1);
        assert_eq!(second.commits[0].subject, "commit 1");
        assert_eq!(second.next_cursor, None);
    }

    #[test]
    fn the_branch_pointing_at_a_commit_rides_on_its_row() {
        let (_dir, repo) = repo_with_commits();
        let page = repo.history(None, 0, 10).unwrap();

        let tip = &page.commits[0];
        assert!(
            tip.refs.iter().any(|r| r.kind == RefKind::Branch),
            "the checked-out branch names its own tip"
        );
        assert!(page.commits[1].refs.is_empty(), "nothing points at the middle");
    }

    #[test]
    fn a_repository_with_no_commits_has_no_history() {
        let dir = tempfile::tempdir().unwrap();
        git2::Repository::init(dir.path()).unwrap();
        let repo = Repo::discover(dir.path()).unwrap();

        let page = repo.history(None, 0, 10).unwrap();
        assert!(page.commits.is_empty());
        assert_eq!(page.head_sha, None);
    }
}
