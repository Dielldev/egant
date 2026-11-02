//! The Library: MCP servers and agent skills, shared across every coding
//! agent on this machine.
//!
//! Modeled on emdash's Library (<https://emdash.com/docs/library>). Neither
//! half keeps a registry of its own — the agents' own files are the record:
//!
//! - [`mcp`] reads and writes each agent's native MCP config (`~/.claude.json`,
//!   `~/.codex/config.toml`, …), so a server added by hand or by another tool
//!   shows up here too, and nothing drifts between egant's idea of what is
//!   installed and what the agent will actually load.
//! - [`skills`] installs through the open `skills` CLI from skills.sh, which
//!   puts one canonical copy under `~/.agents/skills` and links it into each
//!   agent's skills folder, and lists what is installed by reading those
//!   folders.
//!
//! Everything here is user-level (home directory). Project-scoped installs
//! are a later step.

pub mod mcp;
pub mod mcp_catalog;
pub mod skills;

use serde::{Serialize, de::DeserializeOwned};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, SystemTime};

pub(crate) fn home_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .filter(|p| p.is_absolute())
        .ok_or_else(|| "could not determine user home directory".to_string())
}

/// A list fetched from the network that survives a restart. The Library's
/// catalogs cost dozens of HTTP requests to build; without this every launch
/// starts from nothing and the tab sits empty until the last one lands.
///
/// Stale-while-revalidate: [`get`](Self::get) answers from memory or the copy
/// on disk at once, however old, and says whether it has aged out — in which
/// case the caller kicks [`revalidate`](Self::revalidate) to refetch on a
/// background thread, and the next open sees the fresh one.
pub(crate) struct DiskCache<T> {
    name: &'static str,
    ttl: Duration,
    slot: Mutex<Option<(Instant, T)>>,
    seeded: AtomicBool,
    refreshing: AtomicBool,
}

impl<T: Clone + Send + Serialize + DeserializeOwned + 'static> DiskCache<T> {
    pub(crate) const fn new(name: &'static str, ttl: Duration) -> Self {
        Self {
            name,
            ttl,
            slot: Mutex::new(None),
            seeded: AtomicBool::new(false),
            refreshing: AtomicBool::new(false),
        }
    }

    fn file(&self) -> Option<PathBuf> {
        dirs::cache_dir().map(|dir| dir.join("egant").join(format!("{}.json", self.name)))
    }

    /// Loads the on-disk copy into memory, once per process, dated by the
    /// file's own age so a week-old file counts as a week old.
    fn seed(&self) {
        if self.seeded.swap(true, Ordering::SeqCst) {
            return;
        }
        let Some(path) = self.file() else { return };
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        let Ok(value) = serde_json::from_str::<T>(&text) else {
            return;
        };
        let age = std::fs::metadata(&path)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .unwrap_or(self.ttl);
        let at = Instant::now().checked_sub(age).unwrap_or_else(Instant::now);
        if let Ok(mut slot) = self.slot.lock() {
            slot.get_or_insert((at, value));
        }
    }

    /// The newest copy this machine has and whether it is past its `ttl`.
    pub(crate) fn get(&self) -> Option<(T, bool)> {
        self.seed();
        let slot = self.slot.lock().ok()?;
        slot.as_ref()
            .map(|(at, value)| (value.clone(), at.elapsed() >= self.ttl))
    }

    pub(crate) fn put(&self, value: &T) {
        if let Ok(mut slot) = self.slot.lock() {
            *slot = Some((Instant::now(), value.clone()));
        }
        let Some(path) = self.file() else { return };
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string(value) {
            let _ = std::fs::write(&path, text);
        }
    }

    /// Refetches on a background thread, one at a time, and stores the result
    /// when it works. A failure leaves the old copy in place.
    pub(crate) fn revalidate(&'static self, fetch: fn() -> Result<T, String>) {
        if self.refreshing.swap(true, Ordering::SeqCst) {
            return;
        }
        std::thread::spawn(move || {
            match fetch() {
                Ok(value) => self.put(&value),
                Err(error) => log::warn!("refreshing {} failed: {error}", self.name),
            }
            self.refreshing.store(false, Ordering::SeqCst);
        });
    }
}

/// Replace `path` with `contents` in one step: write a sibling temp file and
/// rename it over the original, so an agent reading the file mid-write sees
/// either the old config or the new one, never half of each. The original's
/// permissions carry over — `~/.claude.json` is `0600` and holds tokens.
///
/// The first time egant rewrites a file it keeps the untouched original as
/// `<name>.egant-bak`, so a bad edit is always one copy away from undone.
pub(crate) fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("couldn't create {}: {e}", parent.display()))?;
    }
    let existing = std::fs::metadata(path).ok();
    if existing.is_some() {
        let backup = sibling(path, ".egant-bak");
        if !backup.exists() {
            std::fs::copy(path, &backup)
                .map_err(|e| format!("couldn't back up {}: {e}", path.display()))?;
        }
    }
    let temp = sibling(path, &format!(".egant-tmp-{}", std::process::id()));
    std::fs::write(&temp, contents)
        .map_err(|e| format!("couldn't write {}: {e}", temp.display()))?;
    if let Some(meta) = existing {
        let _ = std::fs::set_permissions(&temp, meta.permissions());
    }
    std::fs::rename(&temp, path).map_err(|e| {
        let _ = std::fs::remove_file(&temp);
        format!("couldn't replace {}: {e}", path.display())
    })
}

fn sibling(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

/// Quote one argument for `sh -c`. Every value the Library hands a shell —
/// a skill source, a skill name — goes through this, never raw.
pub(crate) fn shell_quote(arg: &str) -> String {
    if !arg.is_empty()
        && arg
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "-_./@:=+".contains(c))
    {
        return arg.to_string();
    }
    format!("'{}'", arg.replace('\'', r"'\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_only_what_needs_it() {
        assert_eq!(
            shell_quote("vercel-labs/agent-skills"),
            "vercel-labs/agent-skills"
        );
        assert_eq!(
            shell_quote("Convex Best Practices"),
            "'Convex Best Practices'"
        );
        assert_eq!(shell_quote("a'b"), r"'a'\''b'");
        assert_eq!(shell_quote("$(rm -rf ~)"), "'$(rm -rf ~)'");
        assert_eq!(shell_quote(""), "''");
    }

    #[test]
    fn atomic_write_keeps_one_backup_of_the_original() {
        let dir = std::env::temp_dir().join(format!("egant-lib-{}", uuid::Uuid::new_v4()));
        let file = dir.join("config.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&file, "original").unwrap();

        write_atomic(&file, "first").unwrap();
        write_atomic(&file, "second").unwrap();

        assert_eq!(std::fs::read_to_string(&file).unwrap(), "second");
        assert_eq!(
            std::fs::read_to_string(dir.join("config.json.egant-bak")).unwrap(),
            "original"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
