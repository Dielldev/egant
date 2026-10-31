//! Preferences that outlive a run.
//!
//! One small JSON file, written whole on every change. There is nothing here
//! worth a database or a migration story, and a settings file a user can open in
//! an editor is a feature rather than an implementation detail.
//!
//! Ported from the GPUI shell; the only change is that image support is a fixed
//! extension list instead of the GPUI image element's.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How far the wallpaper is dimmed before the UI is drawn over it. The chrome is
/// translucent, so an undimmed photograph makes body text unreadable.
const DEFAULT_DIM: f32 = 0.55;

/// The range the dim is clamped to. Fully clear hides the text; fully dark hides
/// the wallpaper, and either one makes the setting pointless.
const DIM_RANGE: std::ops::RangeInclusive<f32> = 0.1..=0.9;

/// How much one press of the dim control moves it.
const DIM_STEP: f32 = 0.1;

/// Extensions the stage can draw as a wallpaper. Mirrors what web browsers
/// decode, which is what renders the wallpaper in the Tauri GUI.
const IMAGE_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic", "heif",
];

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Image drawn behind the session stage. `None` falls back to flat chrome.
    pub wallpaper: Option<PathBuf>,
    /// Scrim strength over the wallpaper, `0.1..=0.9`.
    pub wallpaper_dim: f32,
    /// Agent id new sessions start with (`claude`, `codex`, `opencode`).
    /// Unknown values fall back to `claude` when read.
    pub default_agent: String,
    /// Whether a new session gets its own worktree. Off to begin with: a
    /// session that runs somewhere other than the folder the user opened is a
    /// surprise the first time, so the choice is theirs to make. The launch
    /// screen's toggle writes it, so it is only ever made once.
    pub worktree_default: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            wallpaper: None,
            wallpaper_dim: DEFAULT_DIM,
            default_agent: "claude".to_string(),
            worktree_default: false,
        }
    }
}

/// What the frontend renders: the path plus the file name for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsDto {
    pub wallpaper: Option<String>,
    pub wallpaper_name: Option<String>,
    pub wallpaper_dim: f32,
    pub default_agent: String,
    pub worktree_default: bool,
}

impl Settings {
    /// Reads the settings file, falling back to defaults.
    ///
    /// A missing file is the normal first run. A corrupt one is logged and then
    /// also treated as defaults: losing a wallpaper choice is a far better
    /// outcome than refusing to open the window.
    pub fn load() -> Self {
        let Some(path) = Self::path() else {
            return Self::default();
        };
        let Ok(text) = std::fs::read_to_string(&path) else {
            return Self::default();
        };

        let mut settings: Self = match serde_json::from_str(&text) {
            Ok(settings) => settings,
            Err(error) => {
                log::warn!(
                    "ignoring unreadable settings at {}: {error}",
                    path.display()
                );
                Self::default()
            }
        };

        // If no wallpaper is configured, or if the configured path doesn't exist,
        // check whether egant already preserved a valid wallpaper in its wallpaper directory.
        // This ensures the chosen wallpaper is never lost if settings.json was reset,
        // deserialized with null, or saved without the path.
        let need_recovery = match &settings.wallpaper {
            Some(path) => !path.is_file(),
            None => true,
        };
        if need_recovery
            && let Some(preserved) = find_preserved_wallpaper() {
            settings.wallpaper = Some(preserved);
            settings.save();
        }

        // The wallpaper is kept in egant's own folder (see `keep_wallpaper`), so
        // it can't vanish with the original. One saved before that — a path to
        // a file somewhere else — is moved in now, while the original is still
        // there to copy.
        //
        // A path that is not a readable file is *not* forgotten. It used to be,
        // and that is how a wallpaper disappeared: a drive that was not mounted
        // yet, or a Desktop/Downloads folder macOS had not granted this launch,
        // read as "missing", and the next save wrote the loss to disk for good.
        // The picture just isn't drawn until the file is readable again (see
        // `wallpaper_data_url`), and picking another one replaces the setting.
        if let Some(path) = settings.wallpaper.clone() {
            if path.is_file() {
                if let Some(dir) = wallpaper_dir() {
                    match keep_wallpaper(&path, &dir) {
                        Ok(kept) if kept != path => {
                            settings.wallpaper = Some(kept);
                            settings.save();
                        }
                        Ok(_) => {}
                        Err(error) => log::warn!(
                            "could not copy the wallpaper into {}: {error}",
                            dir.display()
                        ),
                    }
                }
            } else {
                log::warn!(
                    "wallpaper {} is not readable right now; keeping the setting",
                    path.display()
                );
            }
        }
        settings.wallpaper_dim = clamp_dim(settings.wallpaper_dim);
        settings
    }

    /// Writes the settings file, creating its directory.
    ///
    /// Failure is logged rather than surfaced: the app stays usable with the
    /// change applied in memory, and the next save may well succeed.
    pub fn save(&self) {
        let Some(path) = Self::path() else {
            return;
        };
        if let Some(parent) = path.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                log::warn!("could not create {}: {error}", parent.display());
                return;
            }
        }
        match serde_json::to_string_pretty(self) {
            Ok(text) => {
                if let Err(error) = crate::persist::write_atomic(&path, &text) {
                    log::warn!("could not write {}: {error}", path.display());
                }
            }
            Err(error) => log::warn!("could not serialize settings: {error}"),
        }
    }

    /// Sets (or, with `None`, clears) the wallpaper. A picture is copied into
    /// egant's own folder first, so what is drawn no longer depends on the
    /// original staying where it was; if the copy fails the original path is
    /// used as it always was.
    pub fn set_wallpaper(&mut self, wallpaper: Option<PathBuf>) {
        self.wallpaper = match wallpaper {
            Some(source) => match wallpaper_dir().map(|dir| keep_wallpaper(&source, &dir)) {
                Some(Ok(copy)) => Some(copy),
                Some(Err(error)) => {
                    log::warn!("could not copy the wallpaper, using it in place: {error}");
                    Some(source)
                }
                None => Some(source),
            },
            None => {
                if let Some(dir) = wallpaper_dir() {
                    let _ = std::fs::remove_dir_all(dir);
                }
                None
            }
        };
        self.save();
    }

    /// The agent new sessions start with. Unknown ids are kept verbatim and
    /// resolved to `claude` at spawn time, so a typo degrades to the default
    /// rather than bricking session creation.
    pub fn set_default_agent(&mut self, agent: String) {
        self.default_agent = agent;
        self.save();
    }

    /// Whether new sessions get their own worktree. The launch screen's toggle
    /// is both the choice for the session about to start and the default for
    /// the next one, so the user never sets this twice.
    pub fn set_worktree_default(&mut self, on: bool) {
        self.worktree_default = on;
        self.save();
    }

    /// Steps the scrim one notch darker, wrapping to the lightest end so a
    /// single control can walk the whole range.
    pub fn cycle_dim(&mut self) {
        let next = self.wallpaper_dim + DIM_STEP;
        self.wallpaper_dim = if next > *DIM_RANGE.end() + f32::EPSILON {
            *DIM_RANGE.start()
        } else {
            clamp_dim(next)
        };
        self.save();
    }

    pub fn dto(&self) -> SettingsDto {
        SettingsDto {
            wallpaper: self.wallpaper.as_ref().map(|p| p.display().to_string()),
            wallpaper_name: self.wallpaper.as_ref().map(|path| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
                    .unwrap_or_else(|| path.display().to_string())
            }),
            wallpaper_dim: self.wallpaper_dim,
            default_agent: self.default_agent.clone(),
            worktree_default: self.worktree_default,
        }
    }

    /// Where the file lives: `~/Library/Application Support/egant` on macOS,
    /// `$XDG_CONFIG_HOME/egant` (or `~/.config/egant`) elsewhere.
    fn path() -> Option<PathBuf> {
        Some(config_dir()?.join("settings.json"))
    }
}

pub(crate) fn config_dir() -> Option<PathBuf> {
    if cfg!(target_os = "windows") {
        return dirs::config_dir().map(|p| p.join("egant"));
    }
    let home = dirs::home_dir();

    if cfg!(target_os = "macos") {
        return Some(home?.join("Library/Application Support/egant"));
    }
    if let Some(xdg) = std::env::var_os("XDG_CONFIG_HOME") {
        let xdg = PathBuf::from(xdg);
        if xdg.is_absolute() {
            return Some(xdg.join("egant"));
        }
    }
    Some(home?.join(".config/egant"))
}

/// Where the chosen wallpaper is kept: beside `settings.json`.
fn wallpaper_dir() -> Option<PathBuf> {
    Some(config_dir()?.join("wallpaper"))
}

/// Finds the latest preserved wallpaper image in egant's wallpaper directory,
/// if one exists. This is the safety net behind `Settings::load`: the picture
/// is copied here when it is picked (see `keep_wallpaper`), so even a settings
/// file that lost the path can be pointed back at it.
pub(crate) fn find_preserved_wallpaper() -> Option<PathBuf> {
    find_preserved_wallpaper_in(&wallpaper_dir()?)
}

/// The recovery scan itself, over `dir` — one timestamped folder per pick, or
/// a bare image left by an older version. The newest name wins: folder names
/// are pick timestamps in milliseconds, so lexical order is age order.
fn find_preserved_wallpaper_in(dir: &Path) -> Option<PathBuf> {
    if !dir.is_dir() {
        return None;
    }
    let mut entries: Vec<PathBuf> = Vec::new();
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if let Ok(sub) = std::fs::read_dir(&path) {
                entries.extend(
                    sub.flatten()
                        .map(|entry| entry.path())
                        .filter(|path| path.is_file() && is_supported_image(path)),
                );
            }
        } else if path.is_file() && is_supported_image(&path) {
            entries.push(path);
        }
    }
    entries.sort();
    entries.pop()
}

/// Copies `source` into `dir` and returns the copy's path, so the wallpaper
/// survives the original being moved, deleted, on an unmounted drive, or behind
/// a folder permission macOS only grants some launches.
///
/// Each pick gets a folder of its own named for the moment it was made, with
/// the original file name inside. A fresh path per pick is what tells the
/// window to load the new picture even when the name and type are unchanged,
/// and keeping the name is what Settings shows. Earlier picks are removed once
/// the new copy is in place; a source that is already in `dir` is left alone.
fn keep_wallpaper(source: &Path, dir: &Path) -> std::io::Result<PathBuf> {
    if source.starts_with(dir) {
        return Ok(source.to_path_buf());
    }
    let name = source
        .file_name()
        .ok_or_else(|| std::io::Error::other("the wallpaper has no file name"))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    let folder = dir.join(stamp.to_string());
    std::fs::create_dir_all(&folder)?;
    let copy = folder.join(name);
    std::fs::copy(source, &copy)?;

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.path() != folder {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(copy)
}

fn clamp_dim(dim: f32) -> f32 {
    if dim.is_nan() {
        return DEFAULT_DIM;
    }
    dim.clamp(*DIM_RANGE.start(), *DIM_RANGE.end())
}

/// Whether `path` names an image the stage can actually draw.
///
/// The platform picker has no format filter, so a user can hand us a PDF.
pub fn is_supported_image(path: &Path) -> bool {
    let Some(extension) = path.extension().and_then(|extension| extension.to_str()) else {
        return false;
    };
    let extension = extension.to_ascii_lowercase();
    IMAGE_EXTENSIONS.contains(&extension.as_str())
}

#[cfg(test)]
mod tests {
    use super::{
        DEFAULT_DIM, Settings, clamp_dim, find_preserved_wallpaper_in, is_supported_image,
        keep_wallpaper,
    };
    use std::path::{Path, PathBuf};

    /// A scratch folder of its own, so these tests never touch the real
    /// settings directory.
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "egant-wallpaper-test-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn a_kept_wallpaper_outlives_its_original() {
        let root = scratch("outlives");
        let original = root.join("photo.png");
        std::fs::write(&original, b"picture").expect("writes");
        let dir = root.join("kept");

        let copy = keep_wallpaper(&original, &dir).expect("copies");
        assert!(copy.starts_with(&dir));
        assert_eq!(copy.file_name(), original.file_name());

        std::fs::remove_file(&original).expect("removes the original");
        assert_eq!(std::fs::read(&copy).expect("still readable"), b"picture");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn picking_again_replaces_the_earlier_copy_and_a_kept_one_is_left_alone() {
        let root = scratch("replaces");
        let first = root.join("one.png");
        let second = root.join("two.png");
        std::fs::write(&first, b"1").expect("writes");
        std::fs::write(&second, b"2").expect("writes");
        let dir = root.join("kept");

        let one = keep_wallpaper(&first, &dir).expect("copies");
        // Already ours: no second copy.
        assert_eq!(keep_wallpaper(&one, &dir).expect("keeps"), one);

        // Sleep a tick so the two picks can't share a millisecond folder name.
        std::thread::sleep(std::time::Duration::from_millis(3));
        let two = keep_wallpaper(&second, &dir).expect("copies");
        assert_ne!(one, two);
        assert!(!one.exists(), "the earlier pick is cleared out");
        assert!(two.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn the_dim_stays_inside_its_range() {
        assert_eq!(clamp_dim(-3.0), 0.1);
        assert_eq!(clamp_dim(9.0), 0.9);
        assert_eq!(clamp_dim(f32::NAN), DEFAULT_DIM);
    }

    #[test]
    fn cycling_the_dim_walks_the_range_and_wraps() {
        let mut settings = Settings {
            wallpaper_dim: 0.8,
            ..Settings::default()
        };
        settings.cycle_dim();
        assert!((settings.wallpaper_dim - 0.9).abs() < 0.001);
        settings.cycle_dim();
        assert!((settings.wallpaper_dim - 0.1).abs() < 0.001);
    }

    #[test]
    fn only_drawable_images_are_accepted() {
        assert!(is_supported_image(Path::new("/tmp/a.png")));
        assert!(is_supported_image(Path::new("/tmp/a.JPEG")));
        assert!(!is_supported_image(Path::new("/tmp/a.pdf")));
        assert!(!is_supported_image(Path::new("/tmp/noextension")));
    }

    #[test]
    fn settings_round_trip_through_json() {
        let settings = Settings {
            wallpaper: Some("/tmp/wall.png".into()),
            wallpaper_dim: 0.4,
            ..Settings::default()
        };
        let text = serde_json::to_string(&settings).expect("serializes");
        let back: Settings = serde_json::from_str(&text).expect("deserializes");
        assert_eq!(settings, back);
    }

    #[test]
    fn an_empty_object_is_the_default() {
        let settings: Settings = serde_json::from_str("{}").expect("deserializes");
        assert_eq!(settings, Settings::default());
    }

    #[test]
    fn preserved_wallpaper_is_recovered_when_settings_has_none() {
        let root = scratch("recovery");
        let dir = root.join("wallpaper");
        let older = dir.join("1000");
        let newer = dir.join("2000");
        std::fs::create_dir_all(&older).expect("creates");
        std::fs::create_dir_all(&newer).expect("creates");
        std::fs::write(older.join("old.png"), b"png bytes").expect("writes");
        std::fs::write(newer.join("new.jpg"), b"jpeg bytes").expect("writes");
        // A stray non-image beside the picks must not be mistaken for one.
        std::fs::write(newer.join("notes.txt"), b"not a picture").expect("writes");

        assert_eq!(
            find_preserved_wallpaper_in(&dir),
            Some(newer.join("new.jpg"))
        );
        assert_eq!(find_preserved_wallpaper_in(&root.join("missing")), None);
        let _ = std::fs::remove_dir_all(&root);
    }
}
