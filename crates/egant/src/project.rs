//! Projects — the folders the app has been pointed at.
//!
//! A project is just a directory plus the identity the sidebar shows for it.
//! Sessions belong to one, which is what lets the sidebar filter and what will
//! later decide where a session's worktree is cut from.

// Imported by name rather than with a glob: `gpui_kit::*` re-exports GPUI's own
// `test` attribute macro, which shadows the built-in one and makes `#[test]`
// below expand into itself.
use gpui_kit::{Hsla, SharedString, hsla};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ProjectId(pub usize);

#[derive(Debug, Clone)]
pub struct Project {
    pub id: ProjectId,
    /// Folder name — what the row reads as.
    pub name: SharedString,
    /// Where it sits, shortened for the right-hand side of the row.
    pub location: SharedString,
    pub path: PathBuf,
    /// Stable per-path colour, so a project keeps its dot across restarts.
    pub color: Hsla,
}

impl Project {
    pub fn new(id: ProjectId, path: PathBuf) -> Self {
        let name = path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());

        Self {
            id,
            name: name.into(),
            location: location_label(&path).into(),
            color: color_for(&path),
            path,
        }
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
fn color_for(path: &Path) -> Hsla {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.display().to_string().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hsla((hash % 360) as f32 / 360.0, 0.62, 0.58, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_and_location_split_the_path() {
        let project = Project::new(ProjectId(0), PathBuf::from("/Users/x/code/egant"));
        assert_eq!(project.name, "egant");
        assert!(project.location.ends_with("code"));
    }

    #[test]
    fn colour_is_stable_for_a_path() {
        let a = color_for(Path::new("/a/b"));
        let b = color_for(Path::new("/a/b"));
        let c = color_for(Path::new("/a/c"));
        assert_eq!(a.h, b.h);
        assert_ne!(a.h, c.h);
    }

    #[test]
    fn a_root_path_still_names_itself() {
        let project = Project::new(ProjectId(1), PathBuf::from("/"));
        assert!(!project.name.is_empty());
    }
}
