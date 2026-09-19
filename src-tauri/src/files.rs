//! The workspace panel's Files tab, and the file tabs it opens on the stage.
//!
//! Deliberately two narrow commands rather than filesystem access for the
//! webview: [`list_dir`] answers one directory at a time (the tree expands
//! lazily, so a `node_modules` nobody opened is never walked), and
//! [`read_file`] hands back text for the read-only viewer. Neither writes —
//! editing a file is the agent's job, not the panel's.

use std::path::Path;

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

/// One directory, directories first then case-insensitive by name — the order
/// every file tree uses, and the one that makes a project legible at a glance.
///
/// Dotfiles stay in: `.gitignore` and friends are part of the project. `.git`
/// and `.DS_Store` do not — they are machinery, and nothing in the panel can
/// usefully do anything with them.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FileEntryDto>, String> {
    let entries = std::fs::read_dir(&path).map_err(|error| {
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

    rows.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(rows)
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

    if bytes.iter().take(SNIFF).any(|byte| *byte == 0) {
        return Ok(FileContentDto {
            path,
            name,
            text: String::new(),
            bytes: size,
            truncated: false,
            binary: true,
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

    Ok(FileContentDto {
        path,
        name,
        text,
        bytes: size,
        truncated,
        binary: false,
    })
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

        let rows = list_dir(dir.display().to_string()).unwrap();
        let names: Vec<&str> = rows.iter().map(|row| row.name.as_str()).collect();

        assert_eq!(names, vec!["src", ".gitignore", "Cargo.toml"]);
        assert!(rows[0].is_dir);
        assert!(rows[0].path.ends_with("src"));
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
