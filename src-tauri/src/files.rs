//! The workspace panel's Files tab, and the file tabs it opens on the stage.
//!
//! Deliberately three narrow commands rather than filesystem access for the
//! webview: [`list_dir`] answers one directory at a time (the tree expands
//! lazily, so a `node_modules` nobody opened is never walked), [`read_file`]
//! hands back text for the viewer, and [`write_file`] saves the viewer's edits
//! back to a file that already exists. The agent edits the same files, so a
//! write states which version of the file it was made against and is refused
//! when the file has moved on since.

use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::dto::{FileContentDto, FileEntryDto};

/// How many entries one directory lists before it stops. Well past what a real
/// source directory holds, and short of a `node_modules` listing costing the
/// panel a visible pause.
const ENTRY_LIMIT: usize = 5_000;

/// How much of a file the viewer will take. Past this it shows the head and
/// says so — a 200 MB log should not become a 200 MB IPC message.
const READ_LIMIT: usize = 2 * 1024 * 1024;

/// How far in to look for a NUL before calling a file binary. Long enough to
/// clear any plausible text header, short enough to stay free.
const SNIFF: usize = 8192;

/// How many files the composer's `@` menu is given to search. Past any
/// source tree a person types `@` in; a home folder opened as a project stops
/// here rather than costing a long walk.
const MENTION_LIMIT: usize = 20_000;

/// Directories the walk for a folder that isn't a repository never enters:
/// what `.gitignore` would have kept out of the `@` menu in one that is.
const WALK_SKIP: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    "vendor",
    "__pycache__",
];

/// Every file under `root` the composer can mention with `@`, as paths
/// relative to it. In a repository that is what git lists — tracked files
/// and new ones, never what `.gitignore` leaves out. Anywhere else it is a
/// walk that skips hidden folders and the usual build output. Either way it
/// stops at [`MENTION_LIMIT`].
#[tauri::command]
pub async fn list_files(root: String) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&root);
        if !root.is_dir() {
            return Err(format!("{} is not a folder", root.display()));
        }
        Ok(git_files(root).unwrap_or_else(|| walk_files(root)))
    })
    .await
    .map_err(|error| error.to_string())?
}

/// What git lists under `root`, relative to it: `None` when it isn't in a
/// repository (or git isn't there to ask).
fn git_files(root: &Path) -> Option<Vec<String>> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let mut files: Vec<String> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| String::from_utf8_lossy(path).into_owned())
        .collect();
    // A file deleted but not yet staged is still "cached"; only what is there
    // can be mentioned.
    files.retain(|path| root.join(path).is_file());
    files.truncate(MENTION_LIMIT);
    Some(files)
}

/// The files under a folder that isn't a repository, breadth first so the
/// limit cuts off the deepest ones.
fn walk_files(root: &Path) -> Vec<String> {
    let mut files = Vec::new();
    let mut queue = std::collections::VecDeque::from([root.to_path_buf()]);
    while let Some(dir) = queue.pop_front() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('.') {
                continue;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if !WALK_SKIP.contains(&name.as_ref()) {
                    queue.push_back(path);
                }
            } else if kind.is_file() {
                if let Ok(relative) = path.strip_prefix(root) {
                    files.push(relative.to_string_lossy().into_owned());
                }
                if files.len() >= MENTION_LIMIT {
                    return files;
                }
            }
        }
    }
    files
}

/// One directory, directories first then case-insensitive by name — the order
/// every file tree uses, and the one that makes a project legible at a glance.
///
/// Dotfiles stay in: `.gitignore` and friends are part of the project. `.git`
/// and `.DS_Store` do not — they are machinery, and nothing in the panel can
/// usefully do anything with them.
///
/// `show_all` is Settings > Files > Show all files (on unless told otherwise).
/// Off, hidden entries and anything git ignores are left out too. The ignore
/// check shells out to git, so the whole listing runs off the UI thread.
#[tauri::command]
pub async fn list_dir(path: String, show_all: Option<bool>) -> Result<Vec<FileEntryDto>, String> {
    let show_all = show_all.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || list_dir_blocking(&path, show_all))
        .await
        .map_err(|error| error.to_string())?
}

fn list_dir_blocking(path: &str, show_all: bool) -> Result<Vec<FileEntryDto>, String> {
    let entries = std::fs::read_dir(path).map_err(|error| {
        log::warn!("list_dir {path} failed: {error}");
        error.to_string()
    })?;

    let mut rows: Vec<FileEntryDto> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == ".git" || name == ".DS_Store" {
                return None;
            }
            if !show_all && name.starts_with('.') {
                return None;
            }
            // A symlink is followed for the "is it a directory" question, so a
            // linked folder opens like the real one it points at.
            let is_dir = entry
                .file_type()
                .ok()
                .map(|kind| kind.is_dir() || (kind.is_symlink() && entry.path().is_dir()))
                .unwrap_or(false);
            Some(FileEntryDto {
                path: entry.path().display().to_string(),
                name,
                is_dir,
            })
        })
        .take(ENTRY_LIMIT)
        .collect();

    if !show_all {
        let ignored = git_ignored(path, &rows);
        rows.retain(|row| !ignored.contains(&row.name));
    }

    rows.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(rows)
}

/// Which of `rows` git ignores. Asked of git itself, since ignore rules come
/// from `.gitignore` files at every level, `.git/info/exclude` and the user's
/// global excludes, and reimplementing that is how a tree ends up disagreeing
/// with `git status`. Outside a repository (or without git) nothing is ignored.
fn git_ignored(dir: &str, rows: &[FileEntryDto]) -> std::collections::HashSet<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut ignored = std::collections::HashSet::new();
    if rows.is_empty() {
        return ignored;
    }
    let Ok(mut child) = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["check-ignore", "-z", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return ignored;
    };
    // Written from its own thread: a directory of thousands of names would
    // otherwise fill git's stdout pipe while we are still filling its stdin.
    if let Some(mut stdin) = child.stdin.take() {
        let mut input = Vec::new();
        for row in rows {
            input.extend_from_slice(row.name.as_bytes());
            input.push(0);
        }
        std::thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let Ok(output) = child.wait_with_output() else {
        return ignored;
    };
    // Exit 1 means "none of these are ignored", 128 "not a repository" — in
    // both, stdout is empty and so is the set.
    for name in output.stdout.split(|byte| *byte == 0) {
        if !name.is_empty() {
            ignored.insert(String::from_utf8_lossy(name).into_owned());
        }
    }
    ignored
}

/// A file's text for the stage's viewer tab.
///
/// Binary files come back flagged rather than as an error: the tab still opens
/// and says what it is, which is a better answer than a red toast for clicking
/// a PNG.
#[tauri::command]
pub fn read_file(path: String) -> Result<FileContentDto, String> {
    let file = Path::new(&path);
    let name = file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.clone());

    let bytes = std::fs::read(file).map_err(|error| {
        log::warn!("read_file {path} failed: {error}");
        error.to_string()
    })?;
    let size = bytes.len() as u64;
    let modified_ms = modified_ms(file).unwrap_or(0);

    if bytes.iter().take(SNIFF).any(|byte| *byte == 0) {
        return Ok(FileContentDto {
            path,
            name,
            text: String::new(),
            bytes: size,
            truncated: false,
            binary: true,
            editable: false,
            modified_ms,
        });
    }

    let truncated = bytes.len() > READ_LIMIT;
    let slice = if truncated {
        &bytes[..READ_LIMIT]
    } else {
        &bytes[..]
    };
    // Lossy rather than strict: a stray invalid byte in an otherwise readable
    // file should not cost the user the whole view of it.
    let mut text = String::from_utf8_lossy(slice).into_owned();
    if truncated {
        // A cut can land mid-character; the replacement it produces at the
        // very end is noise, not content.
        while text.ends_with('\u{fffd}') {
            text.pop();
        }
    }

    // Editing round-trips the text, so only a file that survives the trip
    // unchanged may be edited: whole (not a 2 MB head of it) and genuinely
    // UTF-8. The lossy text above would otherwise be written back with every
    // stray byte replaced by U+FFFD.
    let editable = !truncated && std::str::from_utf8(&bytes).is_ok();

    Ok(FileContentDto {
        path,
        name,
        text,
        bytes: size,
        truncated,
        binary: false,
        editable,
        modified_ms,
    })
}

/// A file's modification time in whole milliseconds since the epoch — the
/// version [`write_file`] checks a save against.
fn modified_ms(path: &Path) -> Option<u64> {
    let modified = std::fs::metadata(path).ok()?.modified().ok()?;
    let since = modified.duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_millis()).ok()
}

/// What a refused save starts with, so the viewer can tell "the file changed
/// under you" — which has a remedy — from an ordinary IO failure.
pub const CONFLICT: &str = "conflict:";

/// Saves the viewer's text over a file that already exists, returning the
/// file's new modification time for the next save to be checked against.
///
/// `expected_modified_ms` is the version the text was edited from. If the file
/// has been touched since — the agent is editing the same tree — the save is
/// refused with a [`CONFLICT`] error rather than silently discarding whatever
/// landed in between; `None` skips the check, which is what "Overwrite" means.
///
/// Written to a sibling file and renamed into place, so a crash mid-save
/// leaves the old file rather than half of the new one. A symlink is resolved
/// first, so the link survives and its target is what changes.
#[tauri::command]
pub fn write_file(
    path: String,
    text: String,
    expected_modified_ms: Option<u64>,
) -> Result<u64, String> {
    let target = std::fs::canonicalize(&path).map_err(|error| {
        log::warn!("write_file {path} failed: {error}");
        error.to_string()
    })?;
    let metadata = std::fs::metadata(&target).map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("not a file".to_string());
    }
    if let Some(expected) = expected_modified_ms {
        if modified_ms(&target) != Some(expected) {
            return Err(format!("{CONFLICT} the file changed on disk"));
        }
    }

    let name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let staging = target.with_file_name(format!(".{name}.egant-save"));
    let written = std::fs::write(&staging, text.as_bytes())
        .and_then(|()| std::fs::set_permissions(&staging, metadata.permissions()))
        .and_then(|()| std::fs::rename(&staging, &target));
    if let Err(error) = written {
        let _ = std::fs::remove_file(&staging);
        log::warn!("write_file {path} failed: {error}");
        return Err(error.to_string());
    }
    modified_ms(&target).ok_or_else(|| "saved, but the new version could not be read".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("egant-files-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn directories_lead_and_machinery_is_hidden() {
        let dir = scratch("listing");
        fs::create_dir(dir.join("src")).unwrap();
        fs::create_dir(dir.join(".git")).unwrap();
        fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        fs::write(dir.join(".gitignore"), "target").unwrap();

        let rows = list_dir_blocking(&dir.display().to_string(), true).unwrap();
        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();

        assert_eq!(names, vec!["src", ".gitignore", "Cargo.toml"]);
        assert!(rows[0].is_dir);
        assert!(rows[0].path.ends_with("src"));
    }

    #[test]
    fn hiding_leaves_out_dotfiles_and_what_git_ignores() {
        let dir = scratch("hiding");
        fs::create_dir(dir.join("src")).unwrap();
        fs::create_dir(dir.join("target")).unwrap();
        fs::write(dir.join(".env"), "KEY=1").unwrap();
        fs::write(dir.join(".gitignore"), "target\n*.log\n").unwrap();
        fs::write(dir.join("debug.log"), "noise").unwrap();
        fs::write(dir.join("Cargo.toml"), "[package]").unwrap();
        let repo = std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .arg("init")
            .arg("-q")
            .status();
        if !repo.map(|status| status.success()).unwrap_or(false) {
            return; // no git on this machine: nothing to ignore against
        }

        let shown = list_dir_blocking(&dir.display().to_string(), true).unwrap();
        assert!(shown.iter().any(|row| row.name == "target"));
        assert!(shown.iter().any(|row| row.name == ".env"));

        let hidden = list_dir_blocking(&dir.display().to_string(), false).unwrap();
        let names: Vec<&str> = hidden.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, vec!["src", "Cargo.toml"]);
    }

    #[test]
    fn hiding_outside_a_repository_still_drops_dotfiles() {
        let dir = scratch("no-repo");
        fs::write(dir.join(".env"), "KEY=1").unwrap();
        fs::write(dir.join("notes.txt"), "hi").unwrap();

        let rows = list_dir_blocking(&dir.display().to_string(), false).unwrap();
        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();
        assert_eq!(names, vec!["notes.txt"]);
    }

    #[test]
    fn a_save_replaces_the_text_and_hands_back_the_new_version() {
        let dir = scratch("save");
        let file = dir.join("note.md");
        fs::write(&file, "old\n").unwrap();
        let path = file.display().to_string();

        let version = read_file(path.clone()).unwrap().modified_ms;
        let next = write_file(path.clone(), "new\n".to_string(), Some(version)).unwrap();

        assert_eq!(fs::read_to_string(&file).unwrap(), "new\n");
        assert_eq!(next, modified_ms(&file).unwrap());
        assert!(!dir.join(".note.md.egant-save").exists());
    }

    #[test]
    fn a_save_over_a_file_that_moved_on_is_refused() {
        let dir = scratch("conflict");
        let file = dir.join("note.md");
        fs::write(&file, "old\n").unwrap();
        let path = file.display().to_string();
        let version = read_file(path.clone()).unwrap().modified_ms;

        // The agent gets there first. The clock is set by hand: two writes in
        // a row can land in the same millisecond, and the check compares
        // timestamps, so a test that leaned on real timing would pass or fail
        // by luck.
        fs::write(&file, "agent's edit\n").unwrap();
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(std::time::SystemTime::now() + std::time::Duration::from_secs(5))
            .unwrap();
        assert_ne!(modified_ms(&file).unwrap(), version);

        let refused = write_file(path.clone(), "mine\n".to_string(), Some(version)).unwrap_err();
        assert!(refused.starts_with(CONFLICT));
        assert_eq!(fs::read_to_string(&file).unwrap(), "agent's edit\n");

        // "Overwrite" skips the check.
        write_file(path, "mine\n".to_string(), None).unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "mine\n");
    }

    #[test]
    fn a_save_never_creates_a_file() {
        let dir = scratch("no-create");
        let missing = dir.join("ghost.txt");
        assert!(write_file(missing.display().to_string(), "x".to_string(), None).is_err());
        assert!(!missing.exists());
    }

    #[test]
    fn only_whole_utf8_text_is_editable() {
        let dir = scratch("editable");
        let good = dir.join("good.txt");
        fs::write(&good, "héllo\n").unwrap();
        assert!(read_file(good.display().to_string()).unwrap().editable);

        let latin1 = dir.join("latin1.txt");
        fs::write(&latin1, [b'c', b'a', b'f', 0xe9]).unwrap();
        assert!(!read_file(latin1.display().to_string()).unwrap().editable);

        let big = dir.join("big.log");
        fs::write(&big, "x".repeat(READ_LIMIT + 512)).unwrap();
        assert!(!read_file(big.display().to_string()).unwrap().editable);
    }

    #[test]
    fn text_comes_back_whole() {
        let dir = scratch("text");
        let file = dir.join("hello.rs");
        fs::write(&file, "fn main() {}\n").unwrap();

        let content = read_file(file.display().to_string()).unwrap();
        assert_eq!(content.name, "hello.rs");
        assert_eq!(content.text, "fn main() {}\n");
        assert!(!content.binary);
        assert!(!content.truncated);
    }

    #[test]
    fn a_binary_file_is_flagged_rather_than_rendered() {
        let dir = scratch("binary");
        let file = dir.join("logo.png");
        fs::write(&file, [0x89, b'P', b'N', b'G', 0x00, 0x1a]).unwrap();

        let content = read_file(file.display().to_string()).unwrap();
        assert!(content.binary);
        assert!(content.text.is_empty());
        assert_eq!(content.bytes, 6);
    }

    #[test]
    fn a_huge_file_is_cut_and_says_so() {
        let dir = scratch("huge");
        let file = dir.join("big.log");
        fs::write(&file, "x".repeat(READ_LIMIT + 512)).unwrap();

        let content = read_file(file.display().to_string()).unwrap();
        assert!(content.truncated);
        assert_eq!(content.text.len(), READ_LIMIT);
        assert_eq!(content.bytes as usize, READ_LIMIT + 512);
    }

    #[test]
    fn a_missing_file_is_an_error_not_a_panic() {
        assert!(read_file("/nope/nothing-here.txt".to_string()).is_err());
    }
}

#[cfg(test)]
mod mention_tests {
    use super::*;

    #[test]
    fn a_folder_outside_git_is_walked_without_its_machinery() {
        let root = std::env::temp_dir().join(format!("egant-mention-walk-{}", std::process::id()));
        for dir in ["src/deep", "node_modules/pkg", ".hidden"] {
            std::fs::create_dir_all(root.join(dir)).unwrap();
        }
        for file in [
            "a.txt",
            "src/deep/b.rs",
            "node_modules/pkg/c.js",
            ".hidden/d",
            ".env",
        ] {
            std::fs::write(root.join(file), "x").unwrap();
        }
        let mut files = walk_files(&root);
        files.sort();
        assert_eq!(files, ["a.txt", "src/deep/b.rs"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
