//! Projects — the folders the app has been pointed at.
//!
//! A project is just a directory plus the identity the UI shows for it.
//! Sessions belong to one, which is what lets the sidebar filter and what will
//! later decide where a session's worktree is cut from.
//!
//! Ported from the GPUI shell: the colour is now a plain hue (`0.0..1.0`) and
//! the frontend renders it as `hsl(hue * 360, 62%, 58%)`.

use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProjectId(pub usize);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: usize,
    /// Folder name — what the row reads as.
    pub name: String,
    /// Home-relative parent directory, shown on hover rather than in the row.
    pub location: String,
    pub path: String,
    /// Stable per-path hue, so a project keeps its dot across restarts.
    pub hue: f32,
}

impl Project {
    pub fn new(id: usize, path: PathBuf) -> Self {
        // Store the canonical path so `/tmp/x`, `/private/tmp/x` and a
        // differently-cased spelling of the same folder on macOS all resolve
        // to one identity. A path that cannot be canonicalized (deleted
        // between pick and insert) is stored as given; `verify_project_path`
        // is what rejects it before a session ever starts there.
        let path = canonicalize_path(&path);
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());

        Self {
            id,
            name,
            location: location_label(&path),
            path: path.display().to_string(),
            hue: hue_for(&path),
        }
    }

    pub fn fs_path(&self) -> PathBuf {
        PathBuf::from(&self.path)
    }
}

/// The parent directory, home-relative — enough to tell two folders of the same
/// name apart without spending the width on a full path.
fn location_label(path: &Path) -> String {
    let Some(parent) = path.parent() else {
        return String::new();
    };
    let text = parent.display().to_string();
    let Some(home) = std::env::var_os("HOME") else {
        return text;
    };
    let home = home.to_string_lossy().into_owned();
    match text.strip_prefix(&home) {
        Some(rest) => format!("~{rest}"),
        None => text,
    }
}

/// Hashes the path to a hue. Deterministic, so the colour is a recognisable
/// property of the project rather than of the order it was added in.
fn hue_for(path: &Path) -> f32 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.display().to_string().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    (hash % 360) as f32 / 360.0
}

/// Best-effort canonical path: resolves symlinks (`/tmp` → `/private/tmp`
/// on macOS) so two spellings of the same folder compare equal. Falls back
/// to the path as given when it no longer exists — `verify_project_path` is
/// what rejects that case before a session ever starts there.
pub fn canonicalize_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Whether two project paths name the same folder. Canonicalizes both sides,
/// and on macOS also compares case-insensitively: APFS is usually
/// case-insensitive, so `…/akra` and `…/Arka` open the same directory and
/// must not become two project rows with sessions attached to the wrong one.
pub fn same_project(a: &Path, b: &Path) -> bool {
    let a = canonicalize_path(a);
    let b = canonicalize_path(b);
    if a == b {
        return true;
    }
    #[cfg(target_os = "macos")]
    {
        a.to_string_lossy().to_lowercase() == b.to_string_lossy().to_lowercase()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

/// Verifies a folder the app is about to run an agent in: it must exist and
/// be a directory. Returns the canonical path to store, so every later
/// comparison (`add_project` dedupe, session restore) sees one identity.
pub fn verify_project_path(path: &Path) -> Result<PathBuf, String> {
    if !path.exists() {
        return Err(format!("{} does not exist", path.display()));
    }
    if !path.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    let canonical = std::fs::canonicalize(path)
        .map_err(|error| format!("could not resolve {}: {error}", path.display()))?;
    if !canonical.is_dir() {
        return Err(format!("{} is not a folder", path.display()));
    }
    Ok(canonical)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonicalize_falls_back_when_missing() {
        let missing = PathBuf::from("/definitely/not/here/egant-test-akra");
        assert!(!missing.exists());
        assert_eq!(canonicalize_path(&missing), missing);
    }

    #[test]
    fn verify_rejects_missing_and_files() {
        assert!(verify_project_path(Path::new("/definitely/not/here")).is_err());
        // A file is not a folder.
        let dir = std::env::temp_dir().join(format!("egant-verify-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("f.txt");
        std::fs::write(&file, "x").unwrap();
        assert!(verify_project_path(&file).is_err());
        assert!(verify_project_path(&dir).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn name_and_location_split_the_path() {
        let project = Project::new(0, PathBuf::from("/Users/x/code/egant"));
        assert_eq!(project.name, "egant");
        assert!(project.location.ends_with("code"));
    }

    #[test]
    fn colour_is_stable_for_a_path() {
        let a = hue_for(Path::new("/a/b"));
        let b = hue_for(Path::new("/a/b"));
        let c = hue_for(Path::new("/a/c"));
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn a_root_path_still_names_itself() {
        let project = Project::new(1, PathBuf::from("/"));
        assert!(!project.name.is_empty());
    }
}
