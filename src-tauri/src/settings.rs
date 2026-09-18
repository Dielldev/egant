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
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tif", "tiff", "avif", "heic",
    "heif",
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

        // A wallpaper that has since been moved or deleted would render as a
        // blank rectangle with no way to tell why, so forget it instead.
        if settings
            .wallpaper
            .as_deref()
            .is_some_and(|path| !path.is_file())
        {
            settings.wallpaper = None;
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

    pub fn set_wallpaper(&mut self, wallpaper: Option<PathBuf>) {
        self.wallpaper = wallpaper;
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
    let home = std::env::var_os("HOME").map(PathBuf::from);

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
    use super::{DEFAULT_DIM, Settings, clamp_dim, is_supported_image};
    use std::path::Path;

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
}
