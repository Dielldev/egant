//! Filesystem notifications for the git panel.
//!
//! The agent edits files out from under the UI, so the panel cannot refresh on
//! user interaction alone. This watches the working tree and coalesces bursts —
//! a single `cargo build` or a multi-file edit produces hundreds of events, and
//! re-running `git status` for each one would peg a core for no benefit.

use anyhow::Result;
use notify::{Event, EventKind, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Receiver, RecvTimeoutError, channel};
use std::time::{Duration, Instant};

/// How long to wait for a burst to go quiet before reporting it.
const DEBOUNCE: Duration = Duration::from_millis(150);

#[derive(Debug, Clone)]
pub struct WatchEvent {
    /// Paths touched since the last report, deduplicated.
    pub paths: Vec<PathBuf>,
}

pub struct RepoWatcher {
    _watcher: notify::RecommendedWatcher,
    events: Receiver<Event>,
}

impl RepoWatcher {
    pub fn new(root: impl AsRef<Path>) -> Result<Self> {
        let (tx, rx) = channel();
        let mut watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                // A closed receiver means the panel is gone; dropping is right.
                let _ = tx.send(event);
            }
        })?;
        watcher.watch(root.as_ref(), RecursiveMode::Recursive)?;
        Ok(Self {
            _watcher: watcher,
            events: rx,
        })
    }

    /// Blocks until something changes, then keeps collecting until the tree has
    /// been quiet for [`DEBOUNCE`]. Returns `None` once the watcher is dropped.
    ///
    /// Call this on a background thread or executor — it blocks by design.
    pub fn next_batch(&self) -> Option<WatchEvent> {
        // Loops rather than recurses: a burst that is entirely noise (git's own
        // lock files, a build writing to target/) is common, and recursing per
        // burst would grow the stack for as long as the noise lasts.
        loop {
            let first = self.events.recv().ok()?;
            let mut paths: Vec<PathBuf> = interesting_paths(&first);
            let deadline = Instant::now() + DEBOUNCE;

            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match self.events.recv_timeout(remaining) {
                    Ok(event) => paths.extend(interesting_paths(&event)),
                    Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
                }
            }

            paths.sort();
            paths.dedup();
            if !paths.is_empty() {
                return Some(WatchEvent { paths });
            }
        }
    }
}

/// Filters out churn that would cause a refresh storm without changing what the
/// panel shows: git's internal lock and temp files, and build output.
fn interesting_paths(event: &Event) -> Vec<PathBuf> {
    if matches!(event.kind, EventKind::Access(_)) {
        return Vec::new();
    }
    event
        .paths
        .iter()
        .filter(|path| !is_noise(path))
        .cloned()
        .collect()
}

fn is_noise(path: &Path) -> bool {
    let text = path.to_string_lossy();
    text.contains("/.git/index.lock")
        || text.contains("/.git/objects/")
        || text.ends_with("~")
        || text.ends_with(".swp")
        || text.contains("/target/")
        || text.contains("/node_modules/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn git_internals_and_build_output_are_ignored() {
        assert!(is_noise(Path::new("/repo/.git/index.lock")));
        assert!(is_noise(Path::new("/repo/.git/objects/ab/cdef")));
        assert!(is_noise(Path::new("/repo/target/debug/app")));
        assert!(is_noise(Path::new("/repo/src/main.rs.swp")));
    }

    #[test]
    fn source_files_are_kept() {
        assert!(!is_noise(Path::new("/repo/src/main.rs")));
        assert!(!is_noise(Path::new("/repo/.git/HEAD")));
    }
}
