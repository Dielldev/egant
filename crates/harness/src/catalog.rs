//! The install catalog: every coding-agent CLI the Agents tab lists, whether
//! this machine already has it, and the commands that install or update it.
//!
//! Distinct from [`crate::agents`], which is the *drivable* registry — the
//! CLIs egant can actually run a session against. The catalog is wider and
//! shallower: it exists so the Agents tab can show an agent nobody has
//! installed yet and hand over its vendor's own install line. Presence is
//! the same filesystem probe [`crate::agents::resolve_cli`] does, never a
//! spawn, so listing the whole catalog stays cheap.
//!
//! The shape follows emdash's `hostDependency` descriptor, which solves the
//! same problem: an agent has *several* install sources (npm, Homebrew, the
//! vendor's curl script), one of them recommended, and each knows how to
//! move an existing install to the newest release. An entry with no install
//! options is an agent whose vendor publishes no unattended install — the
//! tab links out to the site instead of inventing a command.
//!
//! `binaries` is the other lesson from emdash: the product name and the
//! installed binary are routinely different (Antigravity installs `agy`,
//! Continue installs `cn`), and probing the product name reports "not
//! installed" however many times the install succeeded.

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/// Where an install comes from. Serialized as the label the tab prints next
/// to the command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallMethod {
    Npm,
    Curl,
    Brew,
    Pip,
    Uv,
}

impl InstallMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            InstallMethod::Npm => "npm",
            InstallMethod::Curl => "curl",
            InstallMethod::Brew => "brew",
            InstallMethod::Pip => "pip",
            InstallMethod::Uv => "uv",
        }
    }

    fn from_str(s: &str) -> Option<InstallMethod> {
        match s {
            "npm" => Some(InstallMethod::Npm),
            "curl" => Some(InstallMethod::Curl),
            "brew" => Some(InstallMethod::Brew),
            "pip" => Some(InstallMethod::Pip),
            "uv" => Some(InstallMethod::Uv),
            _ => None,
        }
    }
}

pub struct InstallOption {
    pub method: InstallMethod,
    pub command: &'static str,
    /// What moves an existing install to the newest release, when it differs
    /// from the install command. `None` means re-running `command` is the
    /// update — true of every curl bootstrapper here, which always fetches
    /// the latest build.
    pub update_command: Option<&'static str>,
    pub recommended: bool,
}

pub struct CatalogEntry {
    pub id: &'static str,
    pub name: &'static str,
    /// Binary names this CLI is known to install under, most canonical
    /// first. The product name is often not among them.
    pub binaries: &'static [&'static str],
    /// Env var that overrides the resolved path, where the drivable registry
    /// already defines one.
    pub env_override: Option<&'static str>,
    pub extra_paths: &'static [&'static str],
    /// Brand key for the UI's logo table; falls back to a letter tile.
    pub vendor: &'static str,
    pub website: &'static str,
    /// What egant can drive this agent for, shown as "Supports: …".
    pub supports: &'static [&'static str],
    /// Whether egant renders this agent's turns in the chat UI (as opposed
    /// to it being a terminal-only CLI you'd run yourself).
    pub chat_ui: bool,
    pub recommended: bool,
    pub install_options: &'static [InstallOption],
    /// npm package, when the CLI ships as one — what the update check reads
    /// `latest` from, and what the derived `npm …@latest` update command
    /// targets.
    pub npm_package: Option<&'static str>,
}

const PROMPTS: &[&str] = &["Prompts"];
const PROMPTS_SESSIONS: &[&str] = &["Prompts", "Sessions"];
const FULL: &[&str] = &["Prompts", "Sessions", "Tools"];

const HOME_BINS: &[&str] = &["~/.local/bin", "/opt/homebrew/bin", "/usr/local/bin"];

/// One npm install source, with the `@latest` update command derived from it.
const fn npm(command: &'static str, recommended: bool) -> InstallOption {
    InstallOption {
        method: InstallMethod::Npm,
        command,
        update_command: None,
        recommended,
    }
}

/// A curl bootstrapper, for the common case where re-running one installs
/// the newest build. Not universal: Antigravity's bootstrapper `exit 0`s
/// when the binary is already there, so it carries an explicit
/// `update_command` instead — check the script before assuming.
const fn curl(command: &'static str, recommended: bool) -> InstallOption {
    InstallOption {
        method: InstallMethod::Curl,
        command,
        update_command: None,
        recommended,
    }
}

pub const CATALOG: &[CatalogEntry] = &[
    CatalogEntry {
        id: "claude",
        name: "Claude Code",
        binaries: &["claude"],
        env_override: Some("CLAUDE_CODE_EXECUTABLE"),
        extra_paths: &["~/.claude/local/claude"],
        vendor: "claude",
        website: "https://docs.claude.com/en/docs/claude-code/overview",
        supports: FULL,
        chat_ui: true,
        recommended: true,
        install_options: &[
            curl("curl -fsSL https://claude.ai/install.sh | bash", true),
            npm("npm install -g @anthropic-ai/claude-code", false),
        ],
        npm_package: Some("@anthropic-ai/claude-code"),
    },
    CatalogEntry {
        id: "codex",
        name: "Codex",
        binaries: &["codex"],
        env_override: Some("CODEX_EXECUTABLE"),
        extra_paths: &["~/.codex/bin/codex", "~/.npm-global/bin/codex"],
        vendor: "openai",
        website: "https://developers.openai.com/codex/cli",
        supports: FULL,
        chat_ui: true,
        recommended: true,
        install_options: &[
            npm("npm install -g @openai/codex", true),
            InstallOption {
                method: InstallMethod::Brew,
                command: "brew install codex",
                update_command: Some("brew upgrade codex"),
                recommended: false,
            },
        ],
        npm_package: Some("@openai/codex"),
    },
    CatalogEntry {
        id: "opencode",
        name: "OpenCode",
        binaries: &["opencode"],
        env_override: Some("OPENCODE_EXECUTABLE"),
        extra_paths: &["~/.opencode/bin/opencode", "~/.npm-global/bin/opencode"],
        vendor: "opencode",
        website: "https://opencode.ai",
        supports: FULL,
        chat_ui: true,
        recommended: true,
        install_options: &[
            curl("curl -fsSL https://opencode.ai/install | bash", true),
            npm("npm install -g opencode-ai", false),
        ],
        npm_package: Some("opencode-ai"),
    },
    CatalogEntry {
        id: "aider",
        name: "Aider",
        binaries: &["aider"],
        env_override: None,
        extra_paths: &["~/.aider/bin/aider"],
        vendor: "aider",
        website: "https://aider.chat",
        supports: PROMPTS,
        chat_ui: false,
        recommended: false,
        install_options: &[InstallOption {
            method: InstallMethod::Pip,
            command: "python3 -m pip install -U aider-chat",
            update_command: None,
            recommended: true,
        }],
        npm_package: None,
    },
    CatalogEntry {
        id: "amp",
        name: "Amp",
        binaries: &["amp"],
        env_override: None,
        extra_paths: &[],
        vendor: "amp",
        website: "https://ampcode.com",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g @sourcegraph/amp", true)],
        npm_package: Some("@sourcegraph/amp"),
    },
    CatalogEntry {
        id: "antigravity",
        name: "Antigravity",
        // The bootstrapper installs `agy`; `antigravity` is the alternate
        // name emdash also probes. `antigravity-ide` in the app bundle is the
        // editor's `code`-style launcher — a different product that can't run
        // a turn — so it is deliberately not probed.
        binaries: &["agy", "antigravity"],
        env_override: None,
        extra_paths: &[],
        vendor: "antigravity",
        website: "https://antigravity.google/docs/cli-overview",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[InstallOption {
            method: InstallMethod::Curl,
            command: "curl -fsSL https://antigravity.google/cli/install.sh | bash",
            // The bootstrapper prints "already installed" and `exit 0`s when
            // `agy` is present, so re-running it as the update would be a
            // silent no-op that still reported success. `agy update` is the
            // CLI's own documented update path.
            update_command: Some("agy update"),
            recommended: true,
        }],
        npm_package: None,
    },
    CatalogEntry {
        id: "auggie",
        name: "Auggie",
        binaries: &["auggie"],
        env_override: None,
        extra_paths: &[],
        vendor: "augment",
        website: "https://docs.augmentcode.com/cli/overview",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g @augmentcode/auggie", true)],
        npm_package: Some("@augmentcode/auggie"),
    },
    CatalogEntry {
        id: "cline",
        name: "Cline",
        binaries: &["cline"],
        env_override: None,
        extra_paths: &[],
        vendor: "cline",
        website: "https://cline.bot",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[],
        npm_package: None,
    },
    CatalogEntry {
        id: "codebuff",
        name: "Codebuff",
        binaries: &["codebuff"],
        env_override: None,
        extra_paths: &[],
        vendor: "codebuff",
        website: "https://codebuff.com",
        supports: PROMPTS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g codebuff", true)],
        npm_package: Some("codebuff"),
    },
    CatalogEntry {
        id: "continue",
        name: "Continue",
        binaries: &["cn"],
        env_override: None,
        extra_paths: &[],
        vendor: "continue",
        website: "https://continue.dev",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g @continuedev/cli", true)],
        npm_package: Some("@continuedev/cli"),
    },
    CatalogEntry {
        id: "copilot",
        name: "GitHub Copilot",
        binaries: &["copilot"],
        env_override: None,
        extra_paths: &[],
        vendor: "copilot",
        website: "https://github.com/github/copilot-cli",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g @github/copilot", true)],
        npm_package: Some("@github/copilot"),
    },
    CatalogEntry {
        id: "crush",
        name: "Crush",
        binaries: &["crush"],
        env_override: None,
        extra_paths: &[],
        vendor: "charm",
        website: "https://github.com/charmbracelet/crush",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[
            npm("npm install -g @charmland/crush", true),
            InstallOption {
                method: InstallMethod::Brew,
                command: "brew install charmbracelet/tap/crush",
                update_command: Some("brew upgrade crush"),
                recommended: false,
            },
        ],
        npm_package: Some("@charmland/crush"),
    },
    CatalogEntry {
        id: "cursor",
        name: "Cursor Agent",
        binaries: &["cursor-agent"],
        env_override: Some("CURSOR_AGENT_EXECUTABLE"),
        extra_paths: &["~/.cursor/bin/cursor-agent"],
        vendor: "cursor",
        website: "https://cursor.com/cli",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[curl("curl https://cursor.com/install -fsS | bash", true)],
        npm_package: None,
    },
    CatalogEntry {
        id: "devin",
        name: "Devin",
        binaries: &["devin"],
        env_override: Some("DEVIN_EXECUTABLE"),
        extra_paths: &[],
        vendor: "devin",
        website: "https://devin.ai",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[],
        npm_package: None,
    },
    CatalogEntry {
        id: "droid",
        name: "Factory Droid",
        binaries: &["droid"],
        env_override: None,
        extra_paths: &["~/.factory/bin/droid"],
        vendor: "factory",
        website: "https://factory.ai",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[curl("curl -fsSL https://app.factory.ai/cli | sh", true)],
        npm_package: None,
    },
    CatalogEntry {
        id: "gemini",
        name: "Gemini CLI",
        binaries: &["gemini"],
        env_override: None,
        extra_paths: &[],
        vendor: "google",
        website: "https://github.com/google-gemini/gemini-cli",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g @google/gemini-cli", true)],
        npm_package: Some("@google/gemini-cli"),
    },
    CatalogEntry {
        id: "goose",
        name: "Goose",
        binaries: &["goose"],
        env_override: None,
        extra_paths: &["~/.local/share/goose/bin/goose"],
        vendor: "goose",
        website: "https://block.github.io/goose",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[curl(
            "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
            true,
        )],
        npm_package: None,
    },
    CatalogEntry {
        id: "grok",
        name: "Grok",
        binaries: &["grok"],
        env_override: Some("GROK_EXECUTABLE"),
        extra_paths: &[],
        vendor: "xai",
        website: "https://x.ai",
        supports: PROMPTS,
        chat_ui: false,
        recommended: false,
        install_options: &[],
        npm_package: None,
    },
    CatalogEntry {
        id: "hermes",
        name: "Hermes",
        binaries: &["hermes"],
        env_override: Some("HERMES_EXECUTABLE"),
        extra_paths: &[],
        vendor: "nous",
        website: "https://nousresearch.com",
        supports: PROMPTS,
        chat_ui: false,
        recommended: false,
        install_options: &[],
        npm_package: None,
    },
    CatalogEntry {
        id: "openhands",
        name: "OpenHands",
        binaries: &["openhands"],
        env_override: None,
        extra_paths: &[],
        vendor: "openhands",
        website: "https://docs.all-hands.dev",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[InstallOption {
            method: InstallMethod::Uv,
            command: "uv tool install openhands-ai",
            update_command: Some("uv tool upgrade openhands-ai"),
            recommended: true,
        }],
        npm_package: None,
    },
    CatalogEntry {
        id: "pi",
        name: "Pi",
        binaries: &["pi"],
        env_override: Some("PI_EXECUTABLE"),
        extra_paths: &[],
        vendor: "pi",
        website: "https://withpi.ai",
        supports: PROMPTS,
        chat_ui: false,
        recommended: false,
        install_options: &[],
        npm_package: None,
    },
    CatalogEntry {
        id: "plandex",
        name: "Plandex",
        binaries: &["plandex", "pdx"],
        env_override: None,
        extra_paths: &[],
        vendor: "plandex",
        website: "https://plandex.ai",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[curl("curl -sL https://plandex.ai/install.sh | bash", true)],
        npm_package: None,
    },
    CatalogEntry {
        id: "qwen",
        name: "Qwen Code",
        binaries: &["qwen"],
        env_override: None,
        extra_paths: &[],
        vendor: "qwen",
        website: "https://github.com/QwenLM/qwen-code",
        supports: PROMPTS_SESSIONS,
        chat_ui: false,
        recommended: false,
        install_options: &[npm("npm install -g @qwen-code/qwen-code", true)],
        npm_package: Some("@qwen-code/qwen-code"),
    },
];

pub fn entry(id: &str) -> Option<&'static CatalogEntry> {
    CATALOG.iter().find(|e| e.id == id)
}

// ---------------------------------------------------------------------------
// Opening an agent's own CLI
// ---------------------------------------------------------------------------

/// Argv that opens this CLI's own interactive session, for the few where a
/// bare invocation doesn't. `goose` alone prints its help — `goose session`
/// is the REPL (emdash's plugin drives it the same way). Everything else
/// here opens its TUI with no arguments at all, which is why this is a
/// lookup rather than a column on every catalog row.
fn interactive_args(id: &str) -> &'static [&'static str] {
    match id {
        "goose" => &["session"],
        _ => &[],
    }
}

/// What a terminal has to run to hand the user this agent's own CLI.
#[derive(Debug, Clone)]
pub struct CliLaunch {
    pub id: &'static str,
    pub name: &'static str,
    /// The resolved binary — never a bare name, so the spawn does not depend
    /// on whatever `PATH` a Finder-launched app happened to inherit.
    pub program: PathBuf,
    pub args: Vec<String>,
}

impl CliLaunch {
    /// The command line as a person would type it — what the launch dialog
    /// shows so there is no mystery about what is about to run.
    pub fn display(&self) -> String {
        let name = self
            .program
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(self.id);
        if self.args.is_empty() {
            name.to_string()
        } else {
            format!("{name} {}", self.args.join(" "))
        }
    }
}

/// Resolves one catalog agent to the command that opens it. `Err` when the
/// id is unknown or the CLI isn't on this machine — the caller shows that
/// string, so it names the agent rather than saying "not found".
pub fn launch(id: &str) -> Result<CliLaunch, String> {
    let entry = entry(id).ok_or_else(|| format!("unknown agent `{id}`"))?;
    let program = locate(entry)
        .ok_or_else(|| format!("{} isn't installed on this machine.", entry.name))?;
    Ok(CliLaunch {
        id: entry.id,
        name: entry.name,
        program,
        args: interactive_args(entry.id)
            .iter()
            .map(|arg| (*arg).to_string())
            .collect(),
    })
}

/// One install source as the tab renders it: the command to run, and the
/// command that moves an existing install to the newest release.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptionDto {
    pub method: &'static str,
    pub command: &'static str,
    /// Never empty: an explicit `update_command`, else `npm … @latest` for
    /// an npm source, else the install command itself.
    pub update_command: String,
    pub recommended: bool,
}

/// One catalog row as the Agents tab renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogStatus {
    pub id: &'static str,
    pub name: &'static str,
    /// The binary actually probed for, which is often not the product name.
    pub cli: &'static str,
    pub vendor: &'static str,
    pub website: &'static str,
    pub supports: &'static [&'static str],
    pub chat_ui: bool,
    pub recommended: bool,
    pub install_options: Vec<InstallOptionDto>,
    pub installed: bool,
    pub executable: Option<String>,
    /// The command line that opens this agent's own CLI, as a person would
    /// type it (`pi`, `goose session`). The launch dialog prints it, so it
    /// is derived here rather than reconstructed in the frontend — there is
    /// only one place that knows `goose` needs an argument.
    pub launch_command: String,
}

/// Probe every catalog entry. Filesystem only — the same cost as
/// [`crate::detect_agents`], so the tab can call it on open and on Refresh.
pub fn list() -> Vec<CatalogStatus> {
    CATALOG.iter().map(status_of).collect()
}

fn status_of(entry: &'static CatalogEntry) -> CatalogStatus {
    let executable = locate(entry);
    CatalogStatus {
        id: entry.id,
        name: entry.name,
        cli: entry.binaries.first().copied().unwrap_or(entry.id),
        vendor: entry.vendor,
        website: entry.website,
        supports: entry.supports,
        chat_ui: entry.chat_ui,
        recommended: entry.recommended,
        install_options: entry.install_options.iter().map(|o| option_dto(entry, o)).collect(),
        installed: executable.is_some(),
        executable: executable.map(|p| p.display().to_string()),
        launch_command: launch_command(entry),
    }
}

/// [`CatalogStatus::launch_command`], built from the binary the tab probes
/// for rather than the resolved path — a full `/opt/homebrew/bin/...` is not
/// what anyone would type.
fn launch_command(entry: &'static CatalogEntry) -> String {
    let cli = entry.binaries.first().copied().unwrap_or(entry.id);
    let args = interactive_args(entry.id);
    if args.is_empty() {
        cli.to_string()
    } else {
        format!("{cli} {}", args.join(" "))
    }
}

fn option_dto(entry: &CatalogEntry, option: &'static InstallOption) -> InstallOptionDto {
    InstallOptionDto {
        method: option.method.as_str(),
        command: option.command,
        update_command: update_command(entry, option),
        recommended: option.recommended,
    }
}

/// What "install latest" runs for one source. An npm source gets the
/// `@latest` form derived from the package name, because re-running a bare
/// `npm install -g <pkg>` on a machine that already has it is a no-op often
/// enough to look broken.
fn update_command(entry: &CatalogEntry, option: &InstallOption) -> String {
    if let Some(explicit) = option.update_command {
        return explicit.to_string();
    }
    if option.method == InstallMethod::Npm {
        if let Some(package) = entry.npm_package {
            return format!("npm install -g {package}@latest");
        }
    }
    option.command.to_string()
}

/// The entry's recommended source, else its first.
fn preferred(entry: &CatalogEntry) -> Option<&'static InstallOption> {
    entry
        .install_options
        .iter()
        .find(|o| o.recommended)
        .or_else(|| entry.install_options.first())
}

fn option_for(entry: &CatalogEntry, method: Option<&str>) -> Result<&'static InstallOption, String> {
    match method {
        Some(name) => {
            let method = InstallMethod::from_str(name)
                .ok_or_else(|| format!("unknown install method `{name}`"))?;
            entry
                .install_options
                .iter()
                .find(|o| o.method == method)
                .ok_or_else(|| format!("{} has no {name} install", entry.name))
        }
        None => preferred(entry).ok_or_else(|| {
            format!(
                "{} publishes no unattended install — see {}",
                entry.name, entry.website
            )
        }),
    }
}

/// Every binary name this CLI is known by, in every place we look. Probing
/// the product name alone is what made Antigravity read "not installed"
/// after a successful install — it ships as `agy`.
fn locate(entry: &CatalogEntry) -> Option<PathBuf> {
    entry.binaries.iter().find_map(|binary| {
        let common: Vec<String> = HOME_BINS.iter().map(|dir| format!("{dir}/{binary}")).collect();
        let mut paths: Vec<&str> = entry.extra_paths.to_vec();
        paths.extend(common.iter().map(String::as_str));
        crate::agents::resolve_cli(binary, entry.env_override, &paths)
    })
}

// ---------------------------------------------------------------------------
// Installing and updating
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOutcome {
    pub success: bool,
    /// Combined stdout + stderr, tail-truncated — what the sheet shows when
    /// an install fails, so the reason is on screen rather than swallowed.
    pub output: String,
    /// The catalog row re-probed after the command finished.
    pub status: CatalogStatus,
}

/// Run one catalog entry's own install command and re-probe afterward.
///
/// The command is never taken from the caller — only this module's table —
/// so the frontend can't hand us a shell line to run. `method` picks which
/// published source to use; `None` takes the recommended one.
pub fn install(id: &str, method: Option<&str>) -> Result<InstallOutcome, String> {
    let entry = entry(id).ok_or_else(|| format!("unknown agent `{id}`"))?;
    let option = option_for(entry, method)?;
    run_install(entry, option.command)
}

/// The "Install latest" action: the same source's update command, for an
/// agent that is already here but behind its published release.
pub fn update(id: &str, method: Option<&str>) -> Result<InstallOutcome, String> {
    let entry = entry(id).ok_or_else(|| format!("unknown agent `{id}`"))?;
    let option = option_for(entry, method)?;
    run_install(entry, &update_command(entry, option))
}

fn run_install(entry: &'static CatalogEntry, command: &str) -> Result<InstallOutcome, String> {
    let (success, output) = run_in_login_shell(command, Duration::from_secs(600))?;
    Ok(InstallOutcome {
        success,
        output,
        status: status_of(entry),
    })
}

// ---------------------------------------------------------------------------
// Update check
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub id: &'static str,
    /// What `<cli> --version` reports, when it reports a version at all.
    pub current: Option<String>,
    /// The registry's newest published version. `None` when the CLI isn't an
    /// npm package, or the lookup failed (offline, no npm) — the caller then
    /// shows no badge rather than a wrong one.
    pub latest: Option<String>,
    pub update_available: bool,
    /// The install source "Install latest" runs, or `None` for an agent with
    /// no unattended install.
    pub method: Option<&'static str>,
}

/// Compare the installed CLI against its npm registry version. Two spawns
/// and a network round trip, so this is called per installed agent in the
/// background — never as part of [`list`].
pub fn check_update(id: &str) -> Result<UpdateInfo, String> {
    let entry = entry(id).ok_or_else(|| format!("unknown agent `{id}`"))?;
    let current = locate(entry).and_then(|program| local_version(&program));
    let latest = entry.npm_package.and_then(latest_npm_version);
    let update_available = match (&current, &latest) {
        (Some(current), Some(latest)) => current != latest,
        _ => false,
    };
    Ok(UpdateInfo {
        id: entry.id,
        current,
        latest,
        update_available,
        // Which source "Install latest" should run. Only ever the preferred
        // one: we don't detect how an existing binary was installed, so
        // offering to update it through a package manager that never put it
        // there would be a guess.
        method: preferred(entry).map(|o| o.method.as_str()),
    })
}

/// A CLI that hangs on `--version` must not wedge the blocking task this
/// runs on, so the probe gets the same bounded wait an install does.
fn local_version(program: &PathBuf) -> Option<String> {
    let mut command = std::process::Command::new(program);
    command.arg("--version");
    let (_, text) = run_bounded(command, Duration::from_secs(10)).ok()?;
    first_version(&text)
}

fn latest_npm_version(package: &str) -> Option<String> {
    let (success, output) =
        run_in_login_shell(&format!("npm view {package} version"), Duration::from_secs(30)).ok()?;
    success.then(|| first_version(&output)).flatten()
}

/// The first `1.2.3`-shaped token in a CLI's version banner — enough to
/// compare two releases without pulling in a semver crate for a string the
/// UI only ever displays.
fn first_version(text: &str) -> Option<String> {
    text.split(|c: char| c.is_whitespace() || c == '(' || c == ')' || c == ',')
        .map(|token| token.trim_start_matches('v').trim_end_matches('.'))
        .find(|token| {
            let mut parts = token.split('.');
            let major = parts.next().unwrap_or("");
            !major.is_empty()
                && major.chars().all(|c| c.is_ascii_digit())
                && parts.next().is_some_and(|p| !p.is_empty())
        })
        .map(str::to_owned)
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/// Run one command through the user's login shell, capturing both streams
/// and killing it if it outlives `deadline`. Returns `(exit success, output)`.
fn run_in_login_shell(command: &str, deadline: Duration) -> Result<(bool, String), String> {
    let shell = login_shell();
    let mut spawn = std::process::Command::new(&shell);
    spawn.args(["-lc", command]);
    run_bounded(spawn, deadline)
}

/// Spawn, drain both pipes, and kill the child if it outlives `deadline`.
/// Returns `(exit success, combined output)`; a timeout reads as a failure
/// whose output says so.
fn run_bounded(
    mut command: std::process::Command,
    deadline: Duration,
) -> Result<(bool, String), String> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;

    // Both pipes are drained on their own threads: an installer that fills
    // one buffer while we wait on the other would otherwise deadlock.
    let rx = drain(child.stdout.take());
    let err_rx = drain(child.stderr.take());

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if start.elapsed() > deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error.to_string()),
        }
    };

    let mut output = recv(rx);
    let err = recv(err_rx);
    if !err.is_empty() {
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&err);
    }
    match status {
        Some(status) => Ok((status.success(), tail(&output))),
        None => Ok((
            false,
            tail(&format!("{output}\n\nTimed out after {}s.", deadline.as_secs())),
        )),
    }
}

fn drain<R: Read + Send + 'static>(stream: Option<R>) -> Option<mpsc::Receiver<String>> {
    let mut stream = stream?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stream.read_to_end(&mut buf);
        let _ = tx.send(String::from_utf8_lossy(&buf).into_owned());
    });
    Some(rx)
}

/// A killed child can leave a grandchild holding the pipe open, so the
/// reader gets a bounded wait rather than blocking the command thread.
fn recv(rx: Option<mpsc::Receiver<String>>) -> String {
    rx.and_then(|rx| rx.recv_timeout(Duration::from_secs(2)).ok())
        .unwrap_or_default()
}

fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/bin/sh".to_string())
}

/// Installers are chatty; the sheet only needs the end of the log, which is
/// where the failure is.
fn tail(text: &str) -> String {
    const MAX: usize = 8000;
    let text = text.trim();
    if text.len() <= MAX {
        return text.to_string();
    }
    let cut = text.len() - MAX;
    let start = text
        .char_indices()
        .map(|(i, _)| i)
        .find(|i| *i >= cut)
        .unwrap_or(0);
    format!("…\n{}", &text[start..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_entry_is_unique_and_named() {
        let mut seen = std::collections::HashSet::new();
        for entry in CATALOG {
            assert!(seen.insert(entry.id), "duplicate catalog id `{}`", entry.id);
            assert!(!entry.name.is_empty());
            assert!(entry.website.starts_with("https://"));
        }
    }

    /// The three agents egant can actually drive must all be listed, since
    /// the tab is the only place they can be installed from.
    #[test]
    fn drivable_agents_are_catalogued() {
        for id in ["claude", "codex", "opencode"] {
            let entry = entry(id).expect("drivable agent is in the catalog");
            assert!(entry.chat_ui);
            assert!(entry.recommended);
            assert!(preferred(entry).is_some());
        }
    }

    /// Every catalog row must be openable as a terminal session, so the
    /// launch dialog always has a command to print — including for the
    /// agents that carry no install source at all.
    #[test]
    fn every_entry_has_a_launch_command() {
        for entry in CATALOG {
            let command = launch_command(entry);
            assert!(!command.is_empty(), "{} has no launch command", entry.id);
            // It must start with a binary the presence probe actually looks
            // for, or the dialog would print a command nothing can run.
            let binary = command.split(' ').next().unwrap();
            assert!(
                entry.binaries.contains(&binary),
                "{} launches `{binary}`, which is not one of its binaries",
                entry.id
            );
        }
    }

    /// `goose` alone prints its help — the session subcommand is what opens
    /// the REPL, and getting this wrong is a terminal that immediately exits.
    #[test]
    fn goose_launches_its_session_rather_than_its_help() {
        assert_eq!(interactive_args("goose"), &["session"]);
        assert_eq!(launch_command(entry("goose").unwrap()), "goose session");
        assert_eq!(launch_command(entry("pi").unwrap()), "pi");
    }

    #[test]
    fn launching_an_unknown_agent_names_it() {
        let error = launch("nope").unwrap_err();
        assert!(error.contains("nope"), "unhelpful error: {error}");
    }

    /// At most one source may be the recommended one, or `preferred` would
    /// pick by declaration order and the tab would highlight the wrong row.
    #[test]
    fn each_entry_recommends_at_most_one_source() {
        for entry in CATALOG {
            let count = entry.install_options.iter().filter(|o| o.recommended).count();
            assert!(count <= 1, "{} recommends {count} sources", entry.id);
            if !entry.install_options.is_empty() {
                assert_eq!(count, 1, "{} recommends none of its sources", entry.id);
            }
        }
    }

    /// "Install latest" must not be a no-op. A bare `npm install -g <pkg>`
    /// on a machine that already has the package does nothing, so npm
    /// sources update through the derived `@latest` form.
    #[test]
    fn npm_sources_update_through_at_latest() {
        let codex = entry("codex").unwrap();
        let npm = codex
            .install_options
            .iter()
            .find(|o| o.method == InstallMethod::Npm)
            .unwrap();
        assert_eq!(
            update_command(codex, npm),
            "npm install -g @openai/codex@latest"
        );
        // An explicit update command wins over the derivation.
        let brew = codex
            .install_options
            .iter()
            .find(|o| o.method == InstallMethod::Brew)
            .unwrap();
        assert_eq!(update_command(codex, brew), "brew upgrade codex");
        // Antigravity's bootstrapper refuses to run over an existing
        // install, so its update must not be the install command.
        let ag = entry("antigravity").unwrap();
        let option = preferred(ag).unwrap();
        assert_eq!(update_command(ag, option), "agy update");
        assert_ne!(update_command(ag, option), option.command);
        // A plain curl bootstrapper is still its own update.
        let cursor = entry("cursor").unwrap();
        let option = preferred(cursor).unwrap();
        assert_eq!(update_command(cursor, option), option.command);
    }

    /// Resolution is checked through `option_for`, never `install`, so the
    /// test suite can never run a real install command.
    #[test]
    fn an_unknown_install_method_is_refused() {
        let codex = entry("codex").unwrap();
        assert!(option_for(codex, Some("apt")).is_err());
        assert!(option_for(codex, Some("pip")).is_err(), "codex has no pip source");
        assert_eq!(
            option_for(codex, Some("brew")).unwrap().command,
            "brew install codex"
        );
        assert_eq!(
            option_for(codex, None).unwrap().method,
            InstallMethod::Npm,
            "None takes the recommended source"
        );
    }

    /// The name on the row and the name of the binary are not the same
    /// thing. Probing the product name instead of the installed binary is
    /// what made Antigravity report "not installed" after a successful
    /// install, so the two that differ are pinned here.
    #[test]
    fn entries_probe_the_installed_binary_not_the_product_name() {
        assert_eq!(entry("antigravity").unwrap().binaries, &["agy", "antigravity"]);
        assert_eq!(entry("continue").unwrap().binaries, &["cn"]);
        assert_eq!(entry("cursor").unwrap().binaries, &["cursor-agent"]);
        for entry in CATALOG {
            assert!(!entry.binaries.is_empty(), "{} probes nothing", entry.id);
        }
    }

    #[test]
    fn versions_parse_out_of_cli_banners() {
        assert_eq!(first_version("1.2.4 (Claude Code)").as_deref(), Some("1.2.4"));
        assert_eq!(first_version("codex-cli 0.48.0").as_deref(), Some("0.48.0"));
        assert_eq!(first_version("v2.0.1\n").as_deref(), Some("2.0.1"));
        assert_eq!(first_version("no version here"), None);
    }

    #[test]
    fn install_rejects_agents_outside_the_catalog() {
        assert!(install("definitely-not-an-agent", None).is_err());
        assert!(
            install("devin", None).is_err(),
            "no install source means no command to run"
        );
        assert!(update("devin", None).is_err());
    }

    #[test]
    fn the_shell_runner_captures_both_streams() {
        let (ok, out) =
            run_in_login_shell("echo out; echo err >&2", Duration::from_secs(30)).unwrap();
        assert!(ok);
        assert!(out.contains("out"), "stdout missing from `{out}`");
        assert!(out.contains("err"), "stderr missing from `{out}`");
    }

    /// An installer that wedges must be killed rather than holding the
    /// command thread forever.
    #[test]
    fn a_command_that_overruns_its_deadline_is_killed() {
        let (ok, out) = run_in_login_shell("sleep 30", Duration::from_secs(1)).unwrap();
        assert!(!ok);
        assert!(out.contains("Timed out"), "no timeout note in `{out}`");
    }

    #[test]
    fn tail_keeps_the_end_of_a_long_log() {
        let long = "x".repeat(9000) + "END";
        let cut = tail(&long);
        assert!(cut.ends_with("END"));
        assert!(cut.len() < 8200);
    }
}
