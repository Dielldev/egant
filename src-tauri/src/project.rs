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

#[cfg(test)]
mod tests {
    use super::*;

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
