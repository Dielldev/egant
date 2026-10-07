//! Agent registry: which coding agents this machine can run, and which of
//! them are logged in.
//!
//! Detection mirrors zeron's `Harness::installed`: a filesystem probe, never
//! a spawn. Each CLI resolves through `$<ENV_OVERRIDE>` → our `PATH` → the
//! login shell's `PATH` snapshot (a GUI launch never sees shell-init `PATH`,
//! so Homebrew/fnm/nvm shims would otherwise be invisible) → known install
//! dirs → Node version-manager bins.
//!
//! Login state follows zeron's `AgentAccounts` credential locations: Claude
//! (`~/.claude/.credentials.json`, else the macOS Keychain entry the CLI
//! itself uses), Codex (`$CODEX_HOME/auth.json`), Cursor
//! (`~/.cursor/sdk/auth.json`), opencode (`~/.local/share/opencode/auth.json`).
//! Only presence is probed — file contents are never read except for the
//! display email, and never logged.

use serde::{Deserialize, Serialize};
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentId {
    Claude,
    Codex,
    Opencode,
    Cursor,
    Devin,
    Grok,
    Hermes,
    Pi,
    Antigravity,
}

impl AgentId {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentId::Claude => "claude",
            AgentId::Codex => "codex",
            AgentId::Opencode => "opencode",
            AgentId::Cursor => "cursor",
            AgentId::Devin => "devin",
            AgentId::Grok => "grok",
            AgentId::Hermes => "hermes",
            AgentId::Pi => "pi",
            AgentId::Antigravity => "antigravity",
        }
    }

    pub fn from_str(s: &str) -> Option<AgentId> {
        match s {
            "claude" => Some(AgentId::Claude),
            "codex" => Some(AgentId::Codex),
            "opencode" => Some(AgentId::Opencode),
            "cursor" => Some(AgentId::Cursor),
            "devin" => Some(AgentId::Devin),
            "grok" => Some(AgentId::Grok),
            "hermes" => Some(AgentId::Hermes),
            "pi" => Some(AgentId::Pi),
            "antigravity" => Some(AgentId::Antigravity),
            _ => None,
        }
    }

    pub fn all() -> [AgentId; 9] {
        [
            AgentId::Claude,
            AgentId::Codex,
            AgentId::Opencode,
            AgentId::Cursor,
            AgentId::Devin,
            AgentId::Grok,
            AgentId::Hermes,
            AgentId::Pi,
            AgentId::Antigravity,
        ]
    }

    pub fn descriptor(self) -> &'static AgentDescriptor {
        DESCRIPTORS
            .iter()
            .find(|d| d.id == self)
            .expect("every agent has a descriptor")
    }
}

pub struct AgentDescriptor {
    pub id: AgentId,
    pub name: &'static str,
    pub cli: &'static str,
    pub env_override: &'static str,
    /// Install locations probed after `PATH`. `~` expands to `$HOME`.
    pub extra_paths: &'static [&'static str],
    pub install_hint: &'static str,
}

const DESCRIPTORS: &[AgentDescriptor] = &[
    AgentDescriptor {
        id: AgentId::Claude,
        name: "Claude Code",
        cli: "claude",
        env_override: "CLAUDE_CODE_EXECUTABLE",
        extra_paths: &[
            "~/.claude/local/claude",
            "~/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
        ],
        install_hint: "Install the Claude Code CLI to enable (https://docs.anthropic.com/en/docs/claude-code/setup), then run `claude login`",
    },
    AgentDescriptor {
        id: AgentId::Codex,
        name: "Codex",
        cli: "codex",
        env_override: "CODEX_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/codex",
            "~/.codex/bin/codex",
            "~/.npm-global/bin/codex",
            "/opt/homebrew/bin/codex",
            "/usr/local/bin/codex",
        ],
        install_hint: "Install the Codex CLI to enable (`npm install -g @openai/codex`), then run `codex` once to log in",
    },
    AgentDescriptor {
        id: AgentId::Opencode,
        name: "OpenCode",
        cli: "opencode",
        env_override: "OPENCODE_EXECUTABLE",
        extra_paths: &[
            "~/.opencode/bin/opencode",
            "~/.local/bin/opencode",
            "~/.npm-global/bin/opencode",
            "/opt/homebrew/bin/opencode",
            "/usr/local/bin/opencode",
        ],
        install_hint: "Install the opencode CLI to enable (`curl -fsSL https://opencode.ai/install | bash`), then run `opencode auth login`",
    },
    AgentDescriptor {
        id: AgentId::Cursor,
        name: "Cursor",
        cli: "cursor-agent",
        env_override: "CURSOR_AGENT_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/cursor-agent",
            "~/.cursor/bin/cursor-agent",
            "/opt/homebrew/bin/cursor-agent",
            "/usr/local/bin/cursor-agent",
        ],
        install_hint: "Install the cursor-agent CLI to enable",
    },
    AgentDescriptor {
        id: AgentId::Devin,
        name: "Devin",
        cli: "devin",
        env_override: "DEVIN_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/devin",
            "/opt/homebrew/bin/devin",
            "/usr/local/bin/devin",
        ],
        install_hint: "Install the devin CLI to enable",
    },
    AgentDescriptor {
        id: AgentId::Grok,
        name: "Grok",
        cli: "grok",
        env_override: "GROK_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/grok",
            "/opt/homebrew/bin/grok",
            "/usr/local/bin/grok",
        ],
        install_hint: "Install the grok CLI to enable",
    },
    AgentDescriptor {
        id: AgentId::Hermes,
        name: "Hermes",
        cli: "hermes",
        env_override: "HERMES_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/hermes",
            "/opt/homebrew/bin/hermes",
            "/usr/local/bin/hermes",
        ],
        install_hint: "Install the hermes CLI to enable",
    },
    AgentDescriptor {
        id: AgentId::Pi,
        name: "Pi",
        cli: "pi",
        env_override: "PI_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/pi",
            "/opt/homebrew/bin/pi",
            "/usr/local/bin/pi",
        ],
        install_hint: "Install the pi CLI to enable",
    },
    AgentDescriptor {
        id: AgentId::Antigravity,
        name: "Antigravity",
        cli: "agy",
        env_override: "AGY_EXECUTABLE",
        extra_paths: &[
            "~/.local/bin/agy",
            "/opt/homebrew/bin/agy",
            "/usr/local/bin/agy",
        ],
        install_hint: "Install the Antigravity CLI to enable (`curl -fsSL https://antigravity.google/cli/install.sh | bash`), then run `agy` once to sign in",
    },
];

/// What the settings and composer render: presence, login, and how to fix it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    pub id: AgentId,
    pub name: &'static str,
    pub cli: &'static str,
    pub executable: Option<String>,
    pub installed: bool,
    pub install_hint: &'static str,
    pub connected: bool,
    pub email: Option<String>,
}

/// Probe every known agent. One login-shell snapshot is shared across the
/// whole pass (cached per process).
pub fn detect_agents() -> Vec<AgentStatus> {
    let agents: Vec<AgentStatus> = AgentId::all().iter().map(|id| build_status(*id)).collect();
    log::debug!(
        "detect_agents: {} installed, {} connected",
        agents.iter().filter(|a| a.installed).count(),
        agents.iter().filter(|a| a.connected).count(),
    );
    agents
}

fn build_status(id: AgentId) -> AgentStatus {
    let desc = id.descriptor();
    let executable = resolve_executable(desc);
    let installed = executable.is_some();
    // opencode has no single "logged in" state the way Claude/Codex/Cursor
    // do — confirmed live: `opencode run` answers real turns against
    // OpenCode Zen's free-tier models with no auth.json on disk at all, so
    // gating it on that file's presence reported "not connected" for an
    // agent that was already fully usable. zeron's own account system
    // (`agent_accounts.rs`) draws the same line: Claude/Codex/Cursor are
    // "one live login" CLIs it manages; opencode isn't in that system at
    // all. `opencode_auth_file` still matters — it's what a specific
    // provider login (`opencode auth login`) writes — but its absence no
    // longer means "can't be used."
    //
    // Antigravity is the same case from the other side: `agy` keeps its
    // sign-in in the OS keyring under a name this probe has no business
    // guessing at, and prints no status. Installed is the most that can be
    // known without a spawn; a lapsed login surfaces on the first turn, as
    // the CLI's own error.
    let (connected, email) = if matches!(id, AgentId::Opencode | AgentId::Antigravity) {
        (installed, None)
    } else {
        login_status(id)
    };
    AgentStatus {
        id,
        name: desc.name,
        cli: desc.cli,
        executable: executable.map(|p| p.display().to_string()),
        installed,
        install_hint: desc.install_hint,
        connected,
        email,
    }
}

/// The same row `detect_agents` builds for one agent, but with a live,
/// spawn-based login check laid over it where the CLI answers one fast
/// (Claude, Codex) rather than trusting a credentials file or Keychain entry
/// that can outlive the session it names — that mismatch is exactly why a
/// Settings row could read "connected" while every turn was failing to
/// authenticate. Never called from the composer's hot paths, only Settings >
/// Accounts (open, "Refresh", and after "Add account"), matching how
/// `list_models` already accepts one spawn's cost on picker open.
pub fn verify_agent(id: AgentId) -> AgentStatus {
    log::debug!("verify_agent {}", id.as_str());
    let mut status = build_status(id);
    if let Some((connected, email)) = verify_login(id) {
        log::info!("verify_agent {} connected={connected}", id.as_str());
        status.connected = connected;
        if email.is_some() {
            status.email = email;
        } else if !connected {
            status.email = None;
        }
    }
    status
}

/// `Some` when a fast, reliable, non-interactive status check exists for this
/// CLI; `None` leaves the caller's presence-based result alone rather than
/// guessing. A spawn failure (binary moved mid-race, unexpected output) also
/// falls back to `None` instead of reporting a false disconnect.
fn verify_login(id: AgentId) -> Option<(bool, Option<String>)> {
    match id {
        AgentId::Claude => verify_claude_login(),
        AgentId::Codex => verify_codex_login(),
        _ => None,
    }
}

fn verify_claude_login() -> Option<(bool, Option<String>)> {
    let program = resolve_executable(AgentId::Claude.descriptor())?;
    let output = std::process::Command::new(program)
        .args(["auth", "status", "--json"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let value: serde_json::Value = serde_json::from_slice(&output.stdout).ok()?;
    let logged_in = value.get("loggedIn").and_then(serde_json::Value::as_bool)?;
    Some((logged_in, logged_in.then(claude_email).flatten()))
}

/// `codex login status` has no `--json` and, somewhat surprisingly, writes
/// its "Logged in using ..." line to stderr rather than stdout — checking
/// only stdout here would misreport a real login as disconnected, so both
/// streams are read. Exit success is the primary signal; the text match is
/// a safety net against that ever changing.
fn verify_codex_login() -> Option<(bool, Option<String>)> {
    let program = resolve_executable(AgentId::Codex.descriptor())?;
    let output = std::process::Command::new(program)
        .args(["login", "status"])
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let mut text = String::from_utf8_lossy(&output.stdout).to_lowercase();
    text.push_str(&String::from_utf8_lossy(&output.stderr).to_lowercase());
    Some((output.status.success() && text.contains("logged in"), None))
}

// ---------------------------------------------------------------------------
// Connecting an account
// ---------------------------------------------------------------------------

/// Starts this agent's own sign-in flow and returns as soon as it is under
/// way — never once it succeeds, since a browser OAuth round trip and an
/// interactive terminal prompt both run on the user's own clock. The caller
/// (Settings > Accounts) polls [`verify_agent`] afterward instead of waiting
/// here.
pub fn connect(id: AgentId) -> Result<(), String> {
    log::info!("connect {}", id.as_str());
    let desc = id.descriptor();
    let program = resolve_executable(desc).ok_or_else(|| desc.install_hint.to_string())?;
    match id {
        // Browser-based OAuth: no TTY needed, and holding stdin open only
        // invites the CLI to wait on it.
        AgentId::Claude => spawn_detached(&program, &["auth", "login"]),
        AgentId::Codex => spawn_detached(&program, &["login"]),
        // An arrow-key provider picker: needs a real terminal to draw into.
        AgentId::Opencode => open_in_terminal(&program, &["auth", "login"]),
        // Bare `agy` starts its TUI, which signs in through the browser on
        // first run and needs a terminal to draw into while it does.
        AgentId::Antigravity => open_in_terminal(&program, &[]),
        other => Err(format!(
            "{} sign-in isn't wired up yet.",
            other.descriptor().name
        )),
    }
}

fn spawn_detached(program: &Path, args: &[&str]) -> Result<(), String> {
    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("could not start `{}`: {error}", program.display()))?;
    // Reaped off-thread so a browser-paced login never leaves a zombie
    // behind; nothing here needs to see the exit status.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "macos")]
fn open_in_terminal(program: &Path, args: &[&str]) -> Result<(), String> {
    let mut command_line = shell_quote(&program.display().to_string());
    for arg in args {
        command_line.push(' ');
        command_line.push_str(&shell_quote(arg));
    }
    let script = format!(
        "tell application \"Terminal\" to do script \"{}\"",
        applescript_quote(&command_line)
    );
    std::process::Command::new("osascript")
        .args(["-e", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("could not open Terminal: {error}"))
}

#[cfg(target_os = "macos")]
fn applescript_quote(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Open `program args…` in a real terminal so interactive CLIs (opencode's
/// provider picker) can draw. Tries xdg-terminal-exec, `$TERMINAL`, then a
/// short list of common emulators. Falls back to a copy-paste hint when
/// nothing launches.
#[cfg(target_os = "linux")]
fn open_in_terminal(program: &Path, args: &[&str]) -> Result<(), String> {
    let mut command_line = shell_quote(&program.display().to_string());
    for arg in args {
        command_line.push(' ');
        command_line.push_str(&shell_quote(arg));
    }
    // Keep the window open after the CLI exits so login errors stay readable.
    command_line.push_str("; exec \"${SHELL:-bash}\"");

    let copy_hint = format!(
        "Run `{} {}` in a terminal to sign in — egant couldn't open a terminal automatically.",
        program.display(),
        args.join(" ")
    );

    let try_sh_c = |bin: &str, prefix: &[&str]| -> bool {
        let mut cmd = std::process::Command::new(bin);
        cmd.args(prefix);
        cmd.args(["sh", "-c", &command_line]);
        cmd.stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .is_ok()
    };

    if which_bin("xdg-terminal-exec").is_some() && try_sh_c("xdg-terminal-exec", &["--"]) {
        return Ok(());
    }

    if let Ok(term) = std::env::var("TERMINAL") {
        let term = term.trim();
        if !term.is_empty() {
            // Common conventions: `-e`, `--`, or the command as argv directly.
            if try_sh_c(term, &["-e"]) || try_sh_c(term, &["--"]) || try_sh_c(term, &[]) {
                return Ok(());
            }
        }
    }

    // (binary, args before `sh -c …`)
    const CANDIDATES: &[(&str, &[&str])] = &[
        ("gnome-terminal", &["--"]),
        ("kgx", &["--"]),
        ("konsole", &["-e"]),
        ("xfce4-terminal", &["-e"]),
        ("mate-terminal", &["-e"]),
        ("tilix", &["-e"]),
        ("alacritty", &["-e"]),
        ("kitty", &[]),
        ("wezterm", &["start", "--"]),
        ("foot", &[]),
        ("xterm", &["-e"]),
    ];
    for &(bin, prefix) in CANDIDATES {
        if which_bin(bin).is_some() && try_sh_c(bin, prefix) {
            return Ok(());
        }
    }

    Err(copy_hint)
}

#[cfg(target_os = "linux")]
fn which_bin(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn open_in_terminal(program: &Path, args: &[&str]) -> Result<(), String> {
    Err(format!(
        "Run `{} {}` in a terminal to sign in — egant can't open one automatically on this OS yet.",
        program.display(),
        args.join(" ")
    ))
}

/// Resolve one CLI without spawning anything. Order: `$ENV_OVERRIDE` →
/// `PATH` → login-shell `PATH` → known install dirs → version-manager bins.
pub fn resolve_executable(desc: &AgentDescriptor) -> Option<PathBuf> {
    resolve_cli(desc.cli, Some(desc.env_override), desc.extra_paths)
}

/// [`resolve_executable`] for callers that hold the pieces rather than a
/// descriptor — the install catalog, whose entries cover CLIs with no
/// harness behind them.
pub fn resolve_cli(cli: &str, env_override: Option<&str>, extra_paths: &[&str]) -> Option<PathBuf> {
    let exe = exe_name(cli);
    if let Some(path) = env_override
        .and_then(std::env::var_os)
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
    {
        // An explicit override wins when it points somewhere real; a stale
        // one falls through to the normal search instead of bricking the agent.
        if path.exists() {
            return Some(path);
        }
    }
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let extra: Vec<PathBuf> = extra_paths
        .iter()
        .map(|p| expand_home(p, home.as_deref()))
        .collect();
    search_dirs(&exe, extra).into_iter().find(|p| p.exists())
}

fn exe_name(cli: &str) -> String {
    if cfg!(windows) {
        format!("{cli}.exe")
    } else {
        cli.to_string()
    }
}

fn expand_home(path: &str, home: Option<&Path>) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = home {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

/// Join a binary onto every candidate dir: `PATH`, then the login-shell
/// snapshot, then extras, then version-manager bins.
fn search_dirs(exe: &str, extra: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .filter(|d| !d.as_os_str().is_empty())
                .map(|d| d.join(exe)),
        );
    }
    if let Some(shell_path) = login_shell_path() {
        candidates.extend(
            std::env::split_paths(shell_path)
                .filter(|d| !d.as_os_str().is_empty())
                .map(|d| d.join(exe)),
        );
    }
    candidates.extend(extra);
    candidates.extend(node_version_manager_bins().into_iter().map(|d| d.join(exe)));
    candidates
}

/// Bin dirs where npm-installed CLIs land under Node version managers. GUI
/// launches never see these on `PATH` — the managers shape `PATH` in shell
/// init (fnm's per-shell multishells, nvm's shell function), which a
/// Dock/Finder-launched app never runs.
fn node_version_manager_bins() -> Vec<PathBuf> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut dirs = Vec::new();
    let mut fnm_roots: Vec<PathBuf> = std::env::var_os("FNM_DIR")
        .map(PathBuf::from)
        .into_iter()
        .collect();
    if let Some(home) = &home {
        fnm_roots.push(home.join(".local/share/fnm"));
        fnm_roots.push(home.join("Library/Application Support/fnm"));
        fnm_roots.push(home.join(".fnm"));
    }
    for root in fnm_roots {
        dirs.push(root.join("aliases/default/bin"));
    }
    if let Some(home) = &home {
        dirs.push(home.join(".volta/bin"));
        dirs.push(home.join(".bun/bin"));
        dirs.push(home.join("Library/pnpm"));
        dirs.push(home.join(".local/share/pnpm"));
        dirs.push(home.join(".npm-global/bin"));
        let nvm = home.join(".nvm/versions/node");
        if let Ok(entries) = std::fs::read_dir(&nvm) {
            let mut versions: Vec<PathBuf> =
                entries.flatten().map(|e| e.path().join("bin")).collect();
            versions.sort();
            versions.reverse();
            dirs.append(&mut versions);
        }
    }
    dirs
}

/// The `PATH` the user's login shell reports, captured once per process.
/// `None` when disabled (`EGANT_NO_LOGIN_SHELL`), non-unix, or the shell
/// never produced a parseable snapshot.
pub fn login_shell_path() -> Option<&'static OsStr> {
    static CACHE: OnceLock<Option<OsString>> = OnceLock::new();
    CACHE.get_or_init(capture_login_shell_path).as_deref()
}

#[cfg(unix)]
fn capture_login_shell_path() -> Option<OsString> {
    let buf = run_in_login_shell("printf '__EGANT_PATH_BEGIN__%s__EGANT_PATH_END__' \"$PATH\"")?;
    let text = String::from_utf8_lossy(&buf);
    let (_, rest) = text.split_once("__EGANT_PATH_BEGIN__")?;
    let (path, _) = rest.split_once("__EGANT_PATH_END__")?;
    let path = path.trim();
    (!path.is_empty()).then(|| OsString::from(path))
}

#[cfg(not(unix))]
fn capture_login_shell_path() -> Option<OsString> {
    None
}

/// The whole environment the user's login shell exports, captured once per
/// process — not just `PATH`.
///
/// [`login_shell_path`] is enough to *find* a CLI; it is not enough to *run*
/// one the way the user's own terminal would. Plenty of these agents read
/// their key from the environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
/// `OPENROUTER_API_KEY`), and an app launched from the Dock inherits none of
/// the exports in `.zshrc`/`.zprofile` that put them there. Handing a
/// terminal session a CLI that reports "no API key" for an agent that works
/// perfectly in Terminal.app is the whole failure this avoids.
///
/// Empty on Windows, when `EGANT_NO_LOGIN_SHELL` is set, or when the shell
/// produced nothing parseable — the caller then keeps the process's own
/// environment, which is the pre-existing behaviour.
pub fn login_shell_env() -> &'static [(String, String)] {
    static CACHE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    CACHE.get_or_init(capture_login_shell_env)
}

#[cfg(unix)]
fn capture_login_shell_env() -> Vec<(String, String)> {
    // NUL-separated, so a value with newlines in it (a multi-line key, a
    // shell function exported into the environment) cannot be mistaken for
    // the start of the next variable.
    let Some(buf) = run_in_login_shell("env -0") else {
        return Vec::new();
    };
    buf.split(|byte| *byte == 0)
        .filter_map(|entry| std::str::from_utf8(entry).ok())
        .filter_map(|entry| entry.split_once('='))
        // An rc file that chats on stdout puts its noise in front of the
        // first variable; anything that isn't a well-formed name is that
        // noise rather than an export, so it is dropped instead of being
        // passed to a child process as a bogus variable.
        .filter(|(name, _)| is_env_name(name))
        .map(|(name, value)| (name.to_string(), value.to_string()))
        .collect()
}

#[cfg(not(unix))]
fn capture_login_shell_env() -> Vec<(String, String)> {
    Vec::new()
}

#[cfg(unix)]
fn is_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Runs one script through the user's login shell and returns its stdout.
///
/// `-lic`: interactive login, so nvm/fnm and rc-file exports load. Both the
/// child and the reader are on bounded waits — a grandchild inheriting the
/// pipe must not be able to wedge startup — and every caller caches its
/// result, so at most one stray thread per process survives a timeout.
#[cfg(unix)]
fn run_in_login_shell(script: &str) -> Option<Vec<u8>> {
    use std::io::Read;

    if std::env::var_os("EGANT_NO_LOGIN_SHELL").is_some_and(|v| !v.is_empty()) {
        return None;
    }
    let shell = std::env::var_os("SHELL")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_absolute() && p.exists())
        .or_else(|| {
            ["/bin/zsh", "/bin/bash"]
                .into_iter()
                .map(PathBuf::from)
                .find(|p| p.exists())
        })?;
    let mut child = std::process::Command::new(&shell)
        .args(["-lic", script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    let deadline = Duration::from_secs(6);
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if start.elapsed() > deadline => {
                child.kill().ok();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
    Some(rx.recv_timeout(Duration::from_secs(1)).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Login status
// ---------------------------------------------------------------------------

pub(crate) fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn login_status(id: AgentId) -> (bool, Option<String>) {
    match id {
        AgentId::Claude => claude_login(),
        AgentId::Codex => (codex_auth_file().is_some(), None),
        AgentId::Opencode => (opencode_auth_file().is_some(), None),
        AgentId::Cursor => (cursor_auth_file().is_some(), None),
        // Never reached for Antigravity (see `build_status`), but the match
        // stays exhaustive so a new agent can't forget to decide.
        AgentId::Antigravity | AgentId::Devin | AgentId::Grok | AgentId::Hermes | AgentId::Pi => {
            (false, None)
        }
    }
}

fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    home_dir().map(|h| h.join(".claude"))
}

fn claude_login() -> (bool, Option<String>) {
    let email = claude_email();
    if claude_config_dir()
        .map(|d| d.join(".credentials.json").is_file())
        .unwrap_or(false)
    {
        return (true, email);
    }
    // macOS keeps the OAuth token in the Keychain under this service; the
    // CLI reads it from there when the file is absent.
    if keychain_has("Claude Code-credentials") {
        return (true, email);
    }
    (false, None)
}

/// Display identity only (`oauthAccount.emailAddress` in `~/.claude.json`,
/// or `$CLAUDE_CONFIG_DIR/.claude.json` when relocated). Contents are never
/// logged.
fn claude_email() -> Option<String> {
    claude_email_at(&claude_identity_file()?)
}

fn claude_identity_file() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir).join(".claude.json"));
    }
    home_dir().map(|h| h.join(".claude.json"))
}

fn claude_email_at(path: &Path) -> Option<String> {
    let text = std::fs::read_to_string(path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("oauthAccount")?
        .get("emailAddress")?
        .as_str()
        .map(str::to_owned)
}

fn codex_auth_file() -> Option<PathBuf> {
    let home = std::env::var_os("CODEX_HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
        .or_else(home_dir)?;
    let dir = if home.ends_with(".codex") || home.ends_with("codex") {
        home
    } else {
        home.join(".codex")
    };
    let file = dir.join("auth.json");
    file.is_file().then_some(file)
}

fn opencode_auth_file() -> Option<PathBuf> {
    let file = home_dir()?.join(".local/share/opencode/auth.json");
    file.is_file().then_some(file)
}

fn cursor_auth_file() -> Option<PathBuf> {
    let file = home_dir()?.join(".cursor/sdk/auth.json");
    file.is_file().then_some(file)
}

/// Whether the macOS Keychain holds an entry under `service`. Exit status
/// only — the secret itself is never read.
#[cfg(target_os = "macos")]
fn keychain_has(service: &str) -> bool {
    std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", service])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

#[cfg(not(target_os = "macos"))]
fn keychain_has(_service: &str) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor_for(cli: &'static str) -> AgentDescriptor {
        AgentDescriptor {
            id: AgentId::Pi,
            name: "Test",
            cli,
            env_override: "EGANT_TEST_EXECUTABLE",
            extra_paths: &[],
            install_hint: "test",
        }
    }

    #[test]
    fn agent_ids_round_trip_through_strings() {
        for id in AgentId::all() {
            assert_eq!(AgentId::from_str(id.as_str()), Some(id));
        }
        assert_eq!(AgentId::from_str("nope"), None);
    }

    #[test]
    fn search_dirs_joins_every_source() {
        let extra = vec![PathBuf::from("/extra/mycli")];
        let dirs = search_dirs("mycli", extra);
        assert!(dirs.contains(&PathBuf::from("/extra/mycli")));
        // Our own PATH always contributes.
        assert!(dirs.iter().any(|p| p.ends_with("mycli")));
    }

    /// The login shell's stdout is not guaranteed to be only `env -0`'s
    /// output: an rc file that prints a banner puts its noise in front of the
    /// first variable, and that noise must not reach a child process as a
    /// bogus name. Anything that isn't a well-formed variable name is that.
    #[cfg(unix)]
    #[test]
    fn env_names_are_told_apart_from_rc_file_noise() {
        assert!(is_env_name("PATH"));
        assert!(is_env_name("_hidden"));
        assert!(is_env_name("ANTHROPIC_API_KEY"));
        assert!(is_env_name("X1"));
        assert!(!is_env_name(""));
        assert!(!is_env_name("1PATH"));
        assert!(!is_env_name("has space"));
        assert!(!is_env_name("Welcome back! PATH"));
        assert!(!is_env_name("BASH_FUNC_foo%%"));
    }

    #[test]
    fn home_prefix_expands() {
        let home = Path::new("/Users/test");
        assert_eq!(
            expand_home("~/.local/bin/claude", Some(home)),
            PathBuf::from("/Users/test/.local/bin/claude")
        );
        assert_eq!(
            expand_home("/opt/homebrew/bin/claude", Some(home)),
            PathBuf::from("/opt/homebrew/bin/claude")
        );
    }

    #[test]
    fn claude_email_parses_identity_only() {
        let dir = std::env::temp_dir().join(format!("egant-agent-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join(".claude.json");
        std::fs::write(
            &file,
            r#"{"oauthAccount":{"accountUuid":"u","emailAddress":"a@b.c"},"numStartups":3}"#,
        )
        .unwrap();
        assert_eq!(claude_email_at(&file).as_deref(), Some("a@b.c"));
        std::fs::write(&file, r#"{"numStartups":3}"#).unwrap();
        assert_eq!(claude_email_at(&file), None);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
