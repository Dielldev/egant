//! Merge/rebase conflict detection and resolution, by way of the user's own
//! `git` — like [`crate::remote`], this shells out rather than going through
//! libgit2: `checkout --ours`/`--theirs`, `rebase --continue` and friends all
//! touch state (the index, `MERGE_HEAD`, the rebase bookkeeping under
//! `.git/rebase-merge`) that libgit2 either can't drive or doesn't agree with
//! the CLI's own idea of, and a conflict is exactly the moment the user's
//! terminal and this app have to be looking at the same thing.
//!
//! Two conflict shapes exist and are handled differently:
//! - A **content conflict** ("both modified") leaves `<<<<<<<`/`=======`/
//!   `>>>>>>>` markers in the file on disk. Resolving it is a text edit —
//!   [`parse_markers`] and [`resolve_text`] do that edit, entirely offline.
//! - A **delete conflict** (one side deleted the path, the other kept or
//!   edited it) leaves no markers — there is nothing to merge, only a side to
//!   pick — so resolving it means `git checkout --ours`/`--theirs` or `git rm`
//!   instead.
//!
//! [`resolve_file`] tells the two apart by whether the working copy actually
//! has markers in it, so callers never need to know which kind of conflict
//! they're looking at.

use crate::VcsError;
use crate::remote::{GitOutput, run};
use std::path::{Path, PathBuf};

/// A merge or rebase stopped mid-flight, waiting on the user.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OperationKind {
    Merge,
    Rebase,
}

impl OperationKind {
    pub fn label(self) -> &'static str {
        match self {
            OperationKind::Merge => "merge",
            OperationKind::Rebase => "rebase",
        }
    }
}

/// The two-letter `git status --porcelain` code for an unmerged path, spelled
/// out. `BothModified` is by far the common case; the rest are what a
/// delete/modify conflict looks like from either side.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnmergedKind {
    BothModified,
    BothAdded,
    BothDeleted,
    AddedByUs,
    AddedByThem,
    DeletedByUs,
    DeletedByThem,
}

impl UnmergedKind {
    fn from_porcelain(code: &str) -> Option<Self> {
        match code {
            "UU" => Some(UnmergedKind::BothModified),
            "AA" => Some(UnmergedKind::BothAdded),
            "DD" => Some(UnmergedKind::BothDeleted),
            "AU" => Some(UnmergedKind::AddedByUs),
            "UA" => Some(UnmergedKind::AddedByThem),
            "DU" => Some(UnmergedKind::DeletedByUs),
            "UD" => Some(UnmergedKind::DeletedByThem),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnmergedFile {
    pub path: PathBuf,
    pub kind: UnmergedKind,
}

/// What `git status` and the on-disk `.git` bookkeeping say about a
/// merge/rebase right now.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConflictState {
    /// The operation that is stopped, if any. Unmerged files can outlive the
    /// operation that made them too — e.g. after `git stash pop` — so this is
    /// independent of `files` being empty.
    pub operation: Option<OperationKind>,
    pub files: Vec<UnmergedFile>,
}

impl ConflictState {
    /// Whether there is anything here for the panel to show: an operation
    /// stalled, or files still carrying conflict markers.
    pub fn is_active(&self) -> bool {
        self.operation.is_some() || !self.files.is_empty()
    }
}

/// Which side to keep when resolving a conflict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Ours,
    Theirs,
    /// Keep both blocks, ours first — only meaningful for a content conflict;
    /// a delete conflict has no "both" to keep.
    Both,
}

/// One `<<<<<<<`/`=======`/`>>>>>>>` region in a file's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConflictBlock {
    /// 0-indexed line of the opening `<<<<<<<` marker.
    pub start_line: usize,
    /// 0-indexed line of the closing `>>>>>>>` marker (inclusive).
    pub end_line: usize,
    /// Whatever trails the `<<<<<<<` marker (usually a ref name), trimmed.
    pub ours_label: String,
    /// Whatever trails the `>>>>>>>` marker, trimmed.
    pub theirs_label: String,
    pub ours: String,
    pub theirs: String,
}

/// The directory git keeps its own state in — `MERGE_HEAD`, `rebase-merge` —
/// found through git itself rather than assumed to be `root/.git`, since a
/// linked worktree's is elsewhere.
fn git_dir(root: &Path) -> Result<PathBuf, VcsError> {
    let out = run(root, &["rev-parse", "--git-dir"])?;
    let raw = PathBuf::from(out.stdout.trim());
    Ok(if raw.is_absolute() { raw } else { root.join(raw) })
}

fn active_operation(root: &Path) -> Option<OperationKind> {
    let dir = git_dir(root).ok()?;
    if dir.join("MERGE_HEAD").is_file() {
        Some(OperationKind::Merge)
    } else if dir.join("rebase-merge").is_dir() || dir.join("rebase-apply").is_dir() {
        Some(OperationKind::Rebase)
    } else {
        None
    }
}

/// Everything the conflict toolbar needs for one render: whether an operation
/// is stalled, and which paths still have unresolved sides.
pub fn detect(root: &Path) -> Result<ConflictState, VcsError> {
    let operation = active_operation(root);
    let out = run(root, &["status", "--porcelain"])?;
    let files = out
        .stdout
        .lines()
        .filter_map(|line| {
            if line.len() < 3 {
                return None;
            }
            let code = &line[..2];
            let kind = UnmergedKind::from_porcelain(code)?;
            let raw = line[3..].trim();
            // A rename shows as `old -> new` in short status; conflicted
            // paths never carry an arrow, but split defensively rather than
            // hand the resolver a path that doesn't exist.
            let path = raw.rsplit_once(" -> ").map_or(raw, |(_, new)| new).to_owned();
            Some(UnmergedFile {
                path: PathBuf::from(path),
                kind,
            })
        })
        .collect();
    Ok(ConflictState { operation, files })
}

/// Whether `text` contains a conflict-start marker at all — the cheap check
/// that decides between the two resolution paths in [`resolve_file`].
pub fn has_markers(text: &str) -> bool {
    text.lines().any(|line| line.starts_with("<<<<<<< "))
}

/// Parses every `<<<<<<<`/`=======`/`>>>>>>>` region out of `text`. A
/// malformed or partial marker (an opener with no matching closer) is left
/// out rather than guessed at — better to report no blocks than a wrong one.
pub fn parse_markers(text: &str) -> Vec<ConflictBlock> {
    let lines: Vec<&str> = text.lines().collect();
    let mut blocks = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        if let Some(ours_label) = lines[i].strip_prefix("<<<<<<< ") {
            let start = i;
            let mut sep = None;
            let mut j = i + 1;
            while j < lines.len() {
                if lines[j] == "=======" {
                    sep = Some(j);
                    break;
                }
                j += 1;
            }
            let Some(sep) = sep else {
                // No `=======` before the file ends: not a real block.
                i += 1;
                continue;
            };
            let mut end = None;
            let mut k = sep + 1;
            while k < lines.len() {
                if let Some(rest) = lines[k].strip_prefix(">>>>>>> ") {
                    end = Some((k, rest));
                    break;
                }
                k += 1;
            }
            let Some((end, theirs_label)) = end else {
                i += 1;
                continue;
            };
            blocks.push(ConflictBlock {
                start_line: start,
                end_line: end,
                ours_label: ours_label.trim().to_owned(),
                theirs_label: theirs_label.trim().to_owned(),
                ours: lines[start + 1..sep].join("\n"),
                theirs: lines[sep + 1..end].join("\n"),
            });
            i = end + 1;
        } else {
            i += 1;
        }
    }
    blocks
}

/// Rewrites `text`, replacing every conflict block's markers with the chosen
/// side's content. `only` restricts this to a single block index (as
/// [`parse_markers`] would number them), leaving every other block's markers
/// untouched — that is what a single quick-action button resolves.
fn resolve_text(text: &str, side: Side, only: Option<usize>) -> String {
    let blocks = parse_markers(text);
    if blocks.is_empty() {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.lines().collect();
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut cursor = 0;
    for (index, block) in blocks.iter().enumerate() {
        out.extend_from_slice(&lines[cursor..block.start_line]);
        if only.is_some_and(|wanted| wanted != index) {
            // Not the block this call is resolving: keep its markers as-is.
            out.extend_from_slice(&lines[block.start_line..=block.end_line]);
        } else {
            match side {
                Side::Ours => out.extend(block.ours.lines()),
                Side::Theirs => out.extend(block.theirs.lines()),
                Side::Both => {
                    out.extend(block.ours.lines());
                    out.extend(block.theirs.lines());
                }
            }
        }
        cursor = block.end_line + 1;
    }
    out.extend_from_slice(&lines[cursor..]);
    let mut result = out.join("\n");
    if text.ends_with('\n') {
        result.push('\n');
    }
    result
}

fn stage(root: &Path, path: &Path) -> Result<(), VcsError> {
    run(root, &["add", "--", &path_arg(path)])?;
    Ok(())
}

fn path_arg(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// Whether stage 2 (ours, for `Side::Ours`) or stage 3 (theirs) of the index
/// still has an entry for `path` — the index keeps one per side of a
/// conflict, and a delete conflict is missing exactly one of them.
fn side_exists(root: &Path, path: &Path, side: Side) -> bool {
    let stage = match side {
        Side::Ours => "2",
        Side::Theirs => "3",
        Side::Both => return true,
    };
    run(root, &["cat-file", "-e", &format!(":{stage}:{}", path_arg(path))]).is_ok()
}

/// Resolves a delete conflict (no markers to edit): keep the side's file via
/// `checkout --ours`/`--theirs`, or remove the path when that side deleted it.
fn resolve_by_checkout(root: &Path, path: &Path, side: Side) -> Result<(), VcsError> {
    let (Side::Ours | Side::Theirs) = side else {
        return Err(VcsError::GitFailed {
            status: -1,
            stderr: format!(
                "{} has no text to merge — pick Ours or Theirs, not Both",
                path.display()
            ),
        });
    };
    if side_exists(root, path, side) {
        let flag = if side == Side::Ours { "--ours" } else { "--theirs" };
        run(root, &["checkout", flag, "--", &path_arg(path)])?;
        stage(root, path)?;
    } else {
        run(root, &["rm", "-f", "--", &path_arg(path)])?;
    }
    Ok(())
}

/// Resolves every marker in `path` to `side`, or falls back to the
/// checkout/rm path for a delete conflict that has no markers to begin with.
/// Stages the result either way — a file with no more markers left in it is a
/// file `git status` should no longer call unmerged.
pub fn resolve_file(root: &Path, path: &Path, side: Side) -> Result<(), VcsError> {
    let full = root.join(path);
    let text = std::fs::read_to_string(&full).ok();
    match text {
        Some(text) if has_markers(&text) => {
            let resolved = resolve_text(&text, side, None);
            std::fs::write(&full, resolved)?;
            stage(root, path)
        }
        _ => resolve_by_checkout(root, path, side),
    }
}

/// Resolves just one conflict block inside `path`, leaving any other blocks
/// in the same file untouched. Auto-stages the file once every marker in it
/// is gone, so a single-conflict file needs no separate "stage" step.
pub fn resolve_block(root: &Path, path: &Path, index: usize, side: Side) -> Result<(), VcsError> {
    let full = root.join(path);
    let text = std::fs::read_to_string(&full)?;
    let blocks = parse_markers(&text);
    if index >= blocks.len() {
        return Err(VcsError::GitFailed {
            status: -1,
            stderr: format!("no conflict block {index} in {}", path.display()),
        });
    }
    let resolved = resolve_text(&text, side, Some(index));
    std::fs::write(&full, &resolved)?;
    if !has_markers(&resolved) {
        stage(root, path)?;
    }
    Ok(())
}

/// Resolves every currently unmerged file to one side. Bulk equivalent of the
/// toolbar's "Keep All Local" / "Accept All Incoming" — `side` is expected to
/// be [`Side::Ours`] or [`Side::Theirs`]; there is no single "both" across a
/// whole tree of files with unrelated conflicts.
pub fn resolve_all(root: &Path, side: Side) -> Result<Vec<PathBuf>, VcsError> {
    let state = detect(root)?;
    let mut resolved = Vec::with_capacity(state.files.len());
    for file in &state.files {
        resolve_file(root, &file.path, side)?;
        resolved.push(file.path.clone());
    }
    Ok(resolved)
}

/// Finishes the stalled operation once every file is resolved: `rebase
/// --continue` for a rebase, or a commit (with git's own merge message, no
/// editor) for a merge. When nothing is in progress but conflicts have just
/// been cleared by hand (e.g. after a bad `stash pop`), there is nothing to
/// continue and that is reported as success rather than an error.
pub fn continue_operation(root: &Path) -> Result<GitOutput, VcsError> {
    let state = detect(root)?;
    if !state.files.is_empty() {
        return Err(VcsError::GitFailed {
            status: -1,
            stderr: format!(
                "{} file{} still unresolved",
                state.files.len(),
                if state.files.len() == 1 { "" } else { "s" }
            ),
        });
    }
    match state.operation {
        Some(OperationKind::Rebase) => run(root, &["rebase", "--continue"]),
        Some(OperationKind::Merge) => run(root, &["commit", "--no-edit"]),
        None => Ok(GitOutput {
            stdout: "No merge or rebase in progress — conflicts already resolved.".to_owned(),
            stderr: String::new(),
        }),
    }
}

/// Backs out of the stalled operation entirely, discarding every attempted
/// resolution. Safe by construction: it only ever runs `merge --abort` or
/// `rebase --abort`, and only when one of the two is actually in progress.
pub fn abort(root: &Path) -> Result<GitOutput, VcsError> {
    match active_operation(root) {
        Some(OperationKind::Rebase) => run(root, &["rebase", "--abort"]),
        Some(OperationKind::Merge) => run(root, &["merge", "--abort"]),
        None => Err(VcsError::GitFailed {
            status: -1,
            stderr: "no merge or rebase in progress to abort".to_owned(),
        }),
    }
}

/// Guard for any command that is about to start a new pull/merge/rebase:
/// refuses to let a second operation stack on top of one that is already
/// stalled on conflicts, which is the "needs merge" state `git` itself would
/// otherwise fail on with a much less helpful message.
pub fn ensure_clear(root: &Path) -> Result<(), VcsError> {
    let state = detect(root)?;
    if state.is_active() {
        let what = state
            .operation
            .map(OperationKind::label)
            .unwrap_or("merge");
        return Err(VcsError::GitFailed {
            status: -1,
            stderr: format!(
                "a {what} is already in progress with {} unresolved file{} — resolve or abort it before continuing",
                state.files.len(),
                if state.files.len() == 1 { "" } else { "s" }
            ),
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::repo::Repo;
    use std::fs;

    /// Two branches edited the same line of the same file, ready to merge
    /// into a real conflict rather than a synthetic string.
    fn conflicted_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let git = |args: &[&str]| run(&root, args).unwrap();
        git(&["init", "--quiet", "-b", "main"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.com"]);

        fs::write(root.join("a.txt"), "base\n").unwrap();
        git(&["add", "a.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);

        git(&["checkout", "--quiet", "-b", "side"]);
        fs::write(root.join("a.txt"), "side change\n").unwrap();
        git(&["commit", "--quiet", "-am", "side"]);

        git(&["checkout", "--quiet", "main"]);
        fs::write(root.join("a.txt"), "main change\n").unwrap();
        git(&["commit", "--quiet", "-am", "main"]);

        // Fails on purpose: this is what leaves the tree conflicted.
        let _ = run(&root, &["merge", "--no-edit", "side"]);
        (dir, root)
    }

    #[test]
    fn detects_an_active_merge_and_its_unmerged_file() {
        let (_dir, root) = conflicted_repo();
        let state = detect(&root).unwrap();
        assert_eq!(state.operation, Some(OperationKind::Merge));
        assert_eq!(state.files.len(), 1);
        assert_eq!(state.files[0].path, PathBuf::from("a.txt"));
        assert_eq!(state.files[0].kind, UnmergedKind::BothModified);
        assert!(state.is_active());
    }

    #[test]
    fn a_clean_repo_has_nothing_active() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "--quiet", "-b", "main"]).unwrap();
        let state = detect(dir.path()).unwrap();
        assert_eq!(state.operation, None);
        assert!(state.files.is_empty());
        assert!(!state.is_active());
    }

    #[test]
    fn parses_one_block_with_both_sides_and_labels() {
        let text = "before\n<<<<<<< HEAD\nours line\n=======\ntheirs line\n>>>>>>> side\nafter\n";
        let blocks = parse_markers(text);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].ours_label, "HEAD");
        assert_eq!(blocks[0].theirs_label, "side");
        assert_eq!(blocks[0].ours, "ours line");
        assert_eq!(blocks[0].theirs, "theirs line");
        assert_eq!(blocks[0].start_line, 1);
        assert_eq!(blocks[0].end_line, 5);
    }

    #[test]
    fn an_unterminated_marker_parses_as_no_block() {
        let text = "before\n<<<<<<< HEAD\nours line\nafter\n";
        assert!(parse_markers(text).is_empty());
    }

    #[test]
    fn resolving_ours_drops_theirs_and_every_marker() {
        let text = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nafter\n";
        let resolved = resolve_text(text, Side::Ours, None);
        assert_eq!(resolved, "before\nours\nafter\n");
    }

    #[test]
    fn resolving_theirs_drops_ours() {
        let text = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nafter\n";
        let resolved = resolve_text(text, Side::Theirs, None);
        assert_eq!(resolved, "before\ntheirs\nafter\n");
    }

    #[test]
    fn resolving_both_keeps_ours_then_theirs() {
        let text = "before\n<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> side\nafter\n";
        let resolved = resolve_text(text, Side::Both, None);
        assert_eq!(resolved, "before\nours\ntheirs\nafter\n");
    }

    #[test]
    fn resolving_one_block_of_two_leaves_the_other_marked() {
        let text = "<<<<<<< HEAD\na1\n=======\nb1\n>>>>>>> side\nmid\n<<<<<<< HEAD\na2\n=======\nb2\n>>>>>>> side\n";
        let resolved = resolve_text(text, Side::Ours, Some(0));
        assert_eq!(
            resolved,
            "a1\nmid\n<<<<<<< HEAD\na2\n=======\nb2\n>>>>>>> side\n"
        );
        // The second block is untouched, so it is still there to resolve.
        assert_eq!(parse_markers(&resolved).len(), 1);
    }

    #[test]
    fn resolve_file_edits_markers_and_stages_the_result() {
        let (_dir, root) = conflicted_repo();
        resolve_file(&root, Path::new("a.txt"), Side::Ours).unwrap();

        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "main change\n");
        let state = detect(&root).unwrap();
        assert!(
            state.files.is_empty(),
            "a resolved and staged file is no longer unmerged"
        );
    }

    #[test]
    fn continuing_a_merge_with_conflicts_left_is_refused() {
        let (_dir, root) = conflicted_repo();
        let error = continue_operation(&root).unwrap_err();
        assert!(matches!(error, VcsError::GitFailed { .. }));
    }

    #[test]
    fn resolving_then_continuing_finishes_the_merge() {
        let (_dir, root) = conflicted_repo();
        resolve_file(&root, Path::new("a.txt"), Side::Theirs).unwrap();
        continue_operation(&root).unwrap();

        let state = detect(&root).unwrap();
        assert_eq!(state.operation, None, "the merge commit landed");
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "side change\n"
        );
    }

    #[test]
    fn abort_restores_the_pre_merge_tree() {
        let (_dir, root) = conflicted_repo();
        abort(&root).unwrap();

        let state = detect(&root).unwrap();
        assert_eq!(state.operation, None);
        assert!(state.files.is_empty());
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "main change\n");
    }

    #[test]
    fn abort_without_an_operation_in_progress_is_an_error_not_a_no_op() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "--quiet", "-b", "main"]).unwrap();
        assert!(abort(dir.path()).is_err());
    }

    #[test]
    fn ensure_clear_blocks_a_second_operation_on_top_of_a_stalled_one() {
        let (_dir, root) = conflicted_repo();
        let error = ensure_clear(&root).unwrap_err();
        let message = error.to_string();
        assert!(message.contains("already in progress"), "{message}");
    }

    #[test]
    fn ensure_clear_allows_a_clean_repo() {
        let dir = tempfile::tempdir().unwrap();
        run(dir.path(), &["init", "--quiet", "-b", "main"]).unwrap();
        ensure_clear(dir.path()).unwrap();
    }

    #[test]
    fn resolve_all_clears_every_file_and_ends_the_operation_once_continued() {
        let (_dir, root) = conflicted_repo();
        let resolved = resolve_all(&root, Side::Ours).unwrap();
        assert_eq!(resolved, vec![PathBuf::from("a.txt")]);
        continue_operation(&root).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("a.txt")).unwrap(),
            "main change\n"
        );
    }

    /// A delete conflict — one side removed the file, the other edited it —
    /// has no markers to parse, so `resolve_file` has to fall back to the
    /// checkout/rm path instead of the text editor.
    fn delete_conflict_repo() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        let git = |args: &[&str]| run(&root, args).unwrap();
        git(&["init", "--quiet", "-b", "main"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.com"]);

        fs::write(root.join("gone.txt"), "base\n").unwrap();
        git(&["add", "gone.txt"]);
        git(&["commit", "--quiet", "-m", "base"]);

        git(&["checkout", "--quiet", "-b", "side"]);
        fs::write(root.join("gone.txt"), "kept and edited\n").unwrap();
        git(&["commit", "--quiet", "-am", "edit on side"]);

        git(&["checkout", "--quiet", "main"]);
        git(&["rm", "--quiet", "gone.txt"]);
        git(&["commit", "--quiet", "-m", "delete on main"]);

        let _ = run(&root, &["merge", "--no-edit", "side"]);
        (dir, root)
    }

    #[test]
    fn delete_conflict_has_no_markers_and_resolves_by_checkout() {
        let (_dir, root) = delete_conflict_repo();
        let state = detect(&root).unwrap();
        assert_eq!(state.files[0].kind, UnmergedKind::DeletedByUs);

        // "Theirs" kept the file — resolving to theirs should restore it.
        resolve_file(&root, Path::new("gone.txt"), Side::Theirs).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("gone.txt")).unwrap(),
            "kept and edited\n"
        );
        assert!(detect(&root).unwrap().files.is_empty());
    }

    #[test]
    fn delete_conflict_resolved_to_ours_removes_the_path() {
        let (_dir, root) = delete_conflict_repo();
        resolve_file(&root, Path::new("gone.txt"), Side::Ours).unwrap();
        assert!(!root.join("gone.txt").exists());
        assert!(detect(&root).unwrap().files.is_empty());
    }

    #[test]
    fn a_repo_untouched_by_conflicts_still_round_trips_through_repo_snapshot() {
        // Sanity check that this module's shelling-out plays nicely with the
        // rest of the crate's libgit2 handle on the same repository.
        let (_dir, root) = conflicted_repo();
        resolve_file(&root, Path::new("a.txt"), Side::Both).unwrap();
        continue_operation(&root).unwrap();

        let repo = Repo::discover(&root).unwrap();
        assert!(repo.snapshot().unwrap().is_clean());
    }
}
