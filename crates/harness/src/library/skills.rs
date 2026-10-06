//! Agent skills: folders holding a `SKILL.md`, which every supported agent
//! loads from its own skills directory.
//!
//! Installing and uninstalling go through the open `skills` CLI from
//! skills.sh (`npx skills add …`), the same tool people use by hand: it
//! fetches the source, keeps one canonical copy under `~/.agents/skills`,
//! links it into each chosen agent's folder, and records the source in
//! `~/.agents/.skill-lock.json` for `skills update`. What is installed is read
//! straight from those folders, so skills added by hand or by another tool
//! show up too.
//!
//! The catalog is skills.sh's public search (`/api/search`, what `skills
//! find` calls — the documented `/api/v1` needs a Vercel OIDC token a desktop
//! app can't hold), plus the official Anthropic and OpenAI skill repos listed
//! from GitHub for browsing with no query.

use super::{home_dir, shell_quote, write_atomic};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// An agent and where it loads user-level skills from. Directories and
/// `--agent` names are the skills CLI's own table (its README, "Supported
/// Agents"), keyed by egant's install catalog ids.
struct SkillTarget {
    id: &'static str,
    /// The skills CLI's `--agent` value.
    cli_agent: &'static str,
    /// Relative to home.
    dir: &'static str,
}

const TARGETS: &[SkillTarget] = &[
    SkillTarget {
        id: "claude",
        cli_agent: "claude-code",
        dir: ".claude/skills",
    },
    SkillTarget {
        id: "codex",
        cli_agent: "codex",
        dir: ".codex/skills",
    },
    SkillTarget {
        id: "opencode",
        cli_agent: "opencode",
        dir: ".config/opencode/skills",
    },
    SkillTarget {
        id: "antigravity",
        cli_agent: "antigravity-cli",
        dir: ".gemini/antigravity-cli/skills",
    },
    SkillTarget {
        id: "cursor",
        cli_agent: "cursor",
        dir: ".cursor/skills",
    },
    SkillTarget {
        id: "copilot",
        cli_agent: "github-copilot",
        dir: ".copilot/skills",
    },
    SkillTarget {
        id: "amp",
        cli_agent: "amp",
        dir: ".config/agents/skills",
    },
    SkillTarget {
        id: "cline",
        cli_agent: "cline",
        dir: ".agents/skills",
    },
    SkillTarget {
        id: "pi",
        cli_agent: "pi",
        dir: ".agents/skills",
    },
    SkillTarget {
        id: "devin",
        cli_agent: "devin",
        dir: ".config/devin/skills",
    },
    SkillTarget {
        id: "goose",
        cli_agent: "goose",
        dir: ".config/goose/skills",
    },
    SkillTarget {
        id: "grok",
        cli_agent: "grok",
        dir: ".grok/skills",
    },
    SkillTarget {
        id: "hermes",
        cli_agent: "hermes-agent",
        dir: ".hermes/skills",
    },
    SkillTarget {
        id: "openhands",
        cli_agent: "openhands",
        dir: ".openhands/skills",
    },
    SkillTarget {
        id: "qwen",
        cli_agent: "qwen-code",
        dir: ".qwen/skills",
    },
];

/// Where the skills CLI keeps the one real copy every agent links to. Some
/// agents (Cline, Pi) read this folder directly, so for them "installed"
/// and "the canonical copy exists" are the same thing.
const CANONICAL_DIR: &str = ".agents/skills";

fn target(id: &str) -> Option<&'static SkillTarget> {
    TARGETS.iter().find(|t| t.id == id)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgent {
    pub id: &'static str,
    pub name: String,
    pub available: bool,
    pub dir: String,
    /// Reads the canonical folder itself, so it can't be unticked on its own
    /// while other agents still use the skill.
    pub shared: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkill {
    /// The folder name — what every command addresses it by.
    pub id: String,
    /// `name` from the frontmatter, else the folder name.
    pub name: String,
    pub description: String,
    pub agents: Vec<&'static str>,
    /// `owner/repo` from the skills CLI's lock file; `None` for a skill
    /// written locally (or copied in by hand).
    pub source: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsLibrary {
    pub agents: Vec<SkillAgent>,
    pub installed: Vec<InstalledSkill>,
}

/// One catalog card.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogSkill {
    /// `owner/repo/skill`.
    pub id: String,
    /// `owner/repo` — what `skills add` takes.
    pub source: String,
    /// The skill's name within the source — what `--skill` takes.
    pub skill_id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub installs: Option<u64>,
    /// The repo path of its SKILL.md, when known (the official repos).
    #[serde(default)]
    pub path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeaturedSource {
    pub source: &'static str,
    pub label: &'static str,
    pub skills: Vec<CatalogSkill>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillCommandOutcome {
    pub success: bool,
    /// The command as a person would type it, then its output.
    pub output: String,
    pub library: SkillsLibrary,
}

// ---------------------------------------------------------------------------
// Installed
// ---------------------------------------------------------------------------

pub fn library() -> Result<SkillsLibrary, String> {
    Ok(library_at(&home_dir()?, crate::catalog::is_installed))
}

fn library_at(home: &Path, installed: impl Fn(&str) -> bool) -> SkillsLibrary {
    let canonical = home.join(CANONICAL_DIR);
    let agents = TARGETS
        .iter()
        .map(|t| {
            let dir = home.join(t.dir);
            SkillAgent {
                id: t.id,
                name: crate::catalog::display_name(t.id).to_string(),
                available: installed(t.id) || dir.is_dir(),
                dir: format!("~/{}", t.dir),
                shared: dir == canonical,
            }
        })
        .collect();

    let lock = read_lock(home);
    let mut skills: BTreeMap<String, InstalledSkill> = BTreeMap::new();
    for t in TARGETS {
        for (id, path) in skill_dirs(&home.join(t.dir)) {
            let skill = skills.entry(id.clone()).or_insert_with(|| {
                let (name, description) = read_frontmatter(&path.join("SKILL.md"));
                InstalledSkill {
                    name: name.unwrap_or_else(|| id.clone()),
                    description: description.unwrap_or_default(),
                    agents: Vec::new(),
                    source: lock.get(&id).map(|e| e.source.clone()),
                    path: path.display().to_string(),
                    id: id.clone(),
                }
            });
            skill.agents.push(t.id);
        }
    }
    let mut installed: Vec<_> = skills.into_values().collect();
    installed.sort_by_key(|s| s.name.to_lowercase());
    SkillsLibrary { agents, installed }
}

/// `(folder name, path)` for every entry of `dir` that holds a SKILL.md —
/// symlinks included, since that is how the skills CLI installs.
fn skill_dirs(dir: &Path) -> Vec<(String, PathBuf)> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_string();
            if name.starts_with('.') {
                return None;
            }
            let path = e.path();
            path.join("SKILL.md").is_file().then_some((name, path))
        })
        .collect()
}

/// One skill as the skills CLI's lock file records it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LockEntry {
    /// `owner/repo`, or a domain for a well-known source.
    source: String,
    #[serde(default)]
    source_type: String,
    #[serde(rename = "ref", default)]
    git_ref: Option<String>,
    /// The SKILL.md's path inside the repo.
    #[serde(default)]
    skill_path: Option<String>,
    /// The GitHub tree SHA of the skill's folder when it was installed —
    /// what `skills update` compares against to decide it's outdated.
    #[serde(default)]
    skill_folder_hash: Option<String>,
}

/// Skill name → its lock entry, from the skills CLI's global lock file.
fn read_lock(home: &Path) -> BTreeMap<String, LockEntry> {
    let path = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("skills/.skill-lock.json"))
        .unwrap_or_else(|| home.join(".agents/.skill-lock.json"));
    let Ok(text) = std::fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(lock) = serde_json::from_str::<serde_json::Value>(&text) else {
        return BTreeMap::new();
    };
    lock.get("skills")
        .and_then(|s| s.as_object())
        .map(|skills| {
            skills
                .iter()
                .filter_map(|(name, entry)| {
                    let entry = serde_json::from_value(entry.clone()).ok()?;
                    Some((name.clone(), entry))
                })
                .collect()
        })
        .unwrap_or_default()
}

fn read_frontmatter(path: &Path) -> (Option<String>, Option<String>) {
    std::fs::read_to_string(path)
        .map(|text| parse_frontmatter(&text))
        .unwrap_or_default()
}

/// `name` and `description` from a SKILL.md's YAML frontmatter. Handles
/// quoted values and `>`/`|` block scalars — what skill authors actually
/// write — without pulling in a YAML parser for two keys.
pub(crate) fn parse_frontmatter(text: &str) -> (Option<String>, Option<String>) {
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return (None, None);
    }
    let block: Vec<&str> = lines.take_while(|l| l.trim() != "---").collect();
    let value_of = |key: &str| -> Option<String> {
        let prefix = format!("{key}:");
        let index = block.iter().position(|l| l.starts_with(&prefix))?;
        let raw = block[index][prefix.len()..].trim();
        if raw.is_empty() || raw.starts_with('>') || raw.starts_with('|') {
            let folded = !raw.starts_with('|');
            let continuation: Vec<&str> = block[index + 1..]
                .iter()
                .take_while(|l| l.starts_with(' ') || l.starts_with('\t') || l.trim().is_empty())
                .map(|l| l.trim())
                .collect();
            let joined = continuation.join(if folded { " " } else { "\n" });
            let joined = joined.trim().to_string();
            return (!joined.is_empty()).then_some(joined);
        }
        let unquoted = if raw.len() >= 2
            && ((raw.starts_with('"') && raw.ends_with('"'))
                || (raw.starts_with('\'') && raw.ends_with('\'')))
        {
            if raw.starts_with('"') {
                serde_json::from_str::<String>(raw)
                    .unwrap_or_else(|_| raw[1..raw.len() - 1].to_string())
            } else {
                raw[1..raw.len() - 1].replace("''", "'")
            }
        } else {
            raw.to_string()
        };
        Some(unquoted)
    };
    (value_of("name"), value_of("description"))
}

/// The installed copy's SKILL.md, for the detail sheet.
pub fn read_installed(id: &str) -> Result<String, String> {
    check_id(id)?;
    let home = home_dir()?;
    let path = std::iter::once(home.join(CANONICAL_DIR))
        .chain(TARGETS.iter().map(|t| home.join(t.dir)))
        .map(|dir| dir.join(id).join("SKILL.md"))
        .find(|p| p.is_file())
        .ok_or_else(|| format!("{id} isn't installed"))?;
    std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))
}

// ---------------------------------------------------------------------------
// Install, uninstall, re-target
// ---------------------------------------------------------------------------

/// `skills add <source> --skill <skill> -g -a … -y`.
pub fn install(
    source: &str,
    skill: &str,
    agents: &[String],
) -> Result<SkillCommandOutcome, String> {
    let source = Source::parse(source)?;
    if skill.trim().is_empty() {
        return Err("No skill named".into());
    }
    let flags = agent_flags(agents)?;
    let outcome = run_cli(&format!(
        "add {} --skill {} -g {flags} -y",
        shell_quote(&source.install_arg()),
        shell_quote(skill)
    ));
    forget_update_check();
    outcome
}

/// `skills remove <id> -g --agent '*' -y`, then a sweep of anything the CLI
/// left behind (a skill it never installed — written here, or copied in by
/// hand — isn't in its lock file).
pub fn uninstall(id: &str) -> Result<SkillCommandOutcome, String> {
    check_id(id)?;
    let mut outcome = run_cli(&format!("remove {} -g --agent '*' -y", shell_quote(id)))?;
    forget_update_check();
    let home = home_dir()?;
    let mut leftovers = Vec::new();
    for dir in TARGETS.iter().map(|t| t.dir).chain([CANONICAL_DIR]) {
        let path = home.join(dir).join(id);
        if path.symlink_metadata().is_ok() {
            remove_entry(&path)?;
            leftovers.push(format!("~/{dir}/{id}"));
        }
    }
    if !leftovers.is_empty() {
        leftovers.dedup();
        outcome
            .output
            .push_str(&format!("\n\nAlso removed: {}", leftovers.join(", ")));
        outcome.success = true;
    }
    outcome.library = library()?;
    Ok(outcome)
}

/// Make an installed skill present in exactly `agents`: link it into each
/// newly ticked agent's folder from its canonical copy, and take it out of
/// each unticked one. An agent that reads the canonical folder itself is
/// left alone either way — removing its copy would remove everyone's.
pub fn set_agents(id: &str, agents: &[String]) -> Result<SkillsLibrary, String> {
    check_id(id)?;
    agent_flags(agents)?;
    set_agents_at(&home_dir()?, id, agents)?;
    library()
}

fn set_agents_at(home: &Path, id: &str, agents: &[String]) -> Result<(), String> {
    let canonical = home.join(CANONICAL_DIR).join(id);
    // The copy everyone links to: the canonical one, else whichever agent
    // holds a real folder (a skill copied into one agent by hand).
    let source = if canonical.join("SKILL.md").is_file() {
        canonical.clone()
    } else {
        TARGETS
            .iter()
            .map(|t| home.join(t.dir).join(id))
            .find(|p| p.join("SKILL.md").is_file())
            .ok_or_else(|| format!("{id} isn't installed"))?
    };
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let mut errors = Vec::new();
    for t in TARGETS {
        let dir = home.join(t.dir);
        if dir.join(id) == canonical {
            continue;
        }
        let path = dir.join(id);
        let wanted = agents.iter().any(|a| a == t.id);
        let present = path.symlink_metadata().is_ok();
        let result = if wanted && !present {
            std::fs::create_dir_all(&dir)
                .map_err(|e| e.to_string())
                .and_then(|()| symlink_dir(&source, &path))
        } else if !wanted && present {
            // Never delete the one real copy out from under the links.
            if path.canonicalize().ok().as_deref() == Some(source.as_path()) && !is_symlink(&path) {
                Err(format!(
                    "{} holds the only copy of {id}; uninstall it instead",
                    crate::catalog::display_name(t.id)
                ))
            } else {
                remove_entry(&path)
            }
        } else {
            Ok(())
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

/// Write a new skill to the canonical folder and link it into `agents`.
pub fn create(
    name: &str,
    description: &str,
    body: &str,
    agents: &[String],
) -> Result<SkillsLibrary, String> {
    check_id(name)?;
    agent_flags(agents)?;
    let description = description.trim();
    if description.is_empty() {
        return Err("A skill needs a description — it's how agents decide to use it.".into());
    }
    let home = home_dir()?;
    let dir = home.join(CANONICAL_DIR).join(name);
    if dir.exists()
        || TARGETS
            .iter()
            .any(|t| home.join(t.dir).join(name).symlink_metadata().is_ok())
    {
        return Err(format!("A skill named {name} is already installed."));
    }
    write_atomic(&dir.join("SKILL.md"), &skill_md(name, description, body))?;
    set_agents_at(&home, name, agents)?;
    library()
}

fn skill_md(name: &str, description: &str, body: &str) -> String {
    let description = serde_json::to_string(&description.replace('\n', " ")).unwrap_or_default();
    let body = body.trim();
    let body = if body.is_empty() {
        format!("# {name}\n\nDescribe when to use this skill and the steps to follow.")
    } else {
        body.to_string()
    };
    format!("---\nname: {name}\ndescription: {description}\n---\n\n{body}\n")
}

/// Skill folder names: lowercase letters, digits and single hyphens — the
/// Agent Skills spec's rule, and what keeps an id safe to join onto a path.
fn check_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !id.starts_with('-')
        && !id.ends_with('-')
        && !id.contains("--");
    if ok {
        Ok(())
    } else {
        Err("Skill names use lowercase letters, numbers and single hyphens.".into())
    }
}

/// Where a skill comes from, as skills.sh names it.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Source {
    /// `owner/repo` on GitHub.
    Repo(String),
    /// A site publishing skills under `/.well-known/` (`open.feishu.cn`).
    Site(String),
}

impl Source {
    fn parse(source: &str) -> Result<Source, String> {
        let part = |p: &str| {
            !p.is_empty()
                && !p.starts_with('.')
                && !p.starts_with('-')
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
        };
        match source.split_once('/') {
            Some((owner, repo)) if part(owner) && part(repo) && !repo.contains('/') => {
                Ok(Source::Repo(source.to_string()))
            }
            None if part(source) && source.contains('.') && !source.ends_with('.') => {
                Ok(Source::Site(source.to_string()))
            }
            _ => Err(format!(
                "`{source}` isn't a source egant knows how to install from"
            )),
        }
    }

    /// What `skills add` takes: the shorthand for a repo, a URL for a site.
    fn install_arg(&self) -> String {
        match self {
            Source::Repo(repo) => repo.clone(),
            Source::Site(domain) => format!("https://{domain}"),
        }
    }
}

fn agent_flags(agents: &[String]) -> Result<String, String> {
    if agents.is_empty() {
        return Err("Pick at least one agent.".into());
    }
    let mut flags = Vec::new();
    for agent in agents {
        let t = target(agent).ok_or_else(|| format!("{agent} has no skills folder egant knows"))?;
        flags.push(format!("-a {}", t.cli_agent));
    }
    flags.dedup();
    Ok(flags.join(" "))
}

fn run_cli(args: &str) -> Result<SkillCommandOutcome, String> {
    let command = format!("npx -y skills@latest {args}");
    log::info!("skills: {command}");
    let (success, output) = crate::catalog::run_in_login_shell(&command, Duration::from_secs(300))?;
    let output = strip_ansi(&output);
    let hint = if !success
        && (output.contains("npx: command not found") || output.contains("npx: not found"))
    {
        "\n\nThe skills CLI runs on Node.js — install Node (https://nodejs.org) and try again."
    } else {
        ""
    };
    log::info!("skills: done success={success}");
    Ok(SkillCommandOutcome {
        success,
        output: format!("$ {command}\n{output}{hint}"),
        library: library()?,
    })
}

/// The CLI draws spinners and colors even without a TTY.
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if next.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        if c != '\r' {
            out.push(c);
        }
    }
    out
}

fn is_symlink(path: &Path) -> bool {
    path.symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let result = if is_symlink(path) || path.is_file() {
        std::fs::remove_file(path)
    } else {
        std::fs::remove_dir_all(path)
    };
    result.map_err(|e| format!("couldn't remove {}: {e}", path.display()))
}

#[cfg(unix)]
fn symlink_dir(source: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, link)
        .map_err(|e| format!("couldn't link {}: {e}", link.display()))
}

#[cfg(windows)]
fn symlink_dir(source: &Path, link: &Path) -> Result<(), String> {
    std::os::windows::fs::symlink_dir(source, link)
        .map_err(|e| format!("couldn't link {}: {e}", link.display()))
}

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

/// The skills a newer version exists for, by the name the lock file keys
/// them under (the installed folder name).
static UPDATE_CHECK: Mutex<Option<(Instant, Vec<String>)>> = Mutex::new(None);

fn forget_update_check() {
    if let Ok(mut cache) = UPDATE_CHECK.lock() {
        *cache = None;
    }
}

/// Which installed skills have changed upstream, decided the way `skills
/// update` decides it: each GitHub-installed skill's lock entry holds the
/// tree SHA of its folder at install time, and a different SHA in the
/// repo's current tree means a newer version. One GitHub call per source
/// repo, cached for half an hour.
///
/// The CLI has no dry run (`skills check` is an alias of `update`), so this
/// is egant's own check; installing still goes through the CLI. Skills from
/// a well-known site aren't checked — `update_all` still covers them.
pub fn check_updates(refresh: bool) -> Result<Vec<String>, String> {
    if !refresh {
        if let Some((at, names)) = UPDATE_CHECK.lock().ok().and_then(|c| c.clone()) {
            if at.elapsed() < Duration::from_secs(1800) {
                return Ok(names);
            }
        }
    }
    let lock = read_lock(&home_dir()?);
    let client = http()?;
    // Keyed by repo *and* ref: skills pinned to different refs of one repo
    // are each checked against their own ref's tree, as the CLI does.
    type RepoAtRef = (String, Option<String>);
    let mut by_repo: BTreeMap<RepoAtRef, Vec<(&String, &LockEntry)>> = BTreeMap::new();
    for (name, entry) in &lock {
        let checkable = entry.source_type == "github"
            && entry.skill_path.is_some()
            && entry
                .skill_folder_hash
                .as_deref()
                .is_some_and(|h| h.len() == 40 && h.chars().all(|c| c.is_ascii_hexdigit()));
        if checkable && matches!(Source::parse(&entry.source), Ok(Source::Repo(_))) {
            by_repo
                .entry((entry.source.clone(), entry.git_ref.clone()))
                .or_default()
                .push((name, entry));
        }
    }
    let mut outdated = Vec::new();
    let mut errors = Vec::new();
    for ((repo, git_ref), skills) in by_repo {
        match repo_tree(&client, &repo, git_ref.as_deref()) {
            Ok(tree) => {
                for (name, entry) in skills {
                    let latest = folder_hash(&tree, entry.skill_path.as_deref().unwrap_or(""));
                    if latest.is_some_and(|sha| Some(sha) != entry.skill_folder_hash.as_deref()) {
                        outdated.push(name.clone());
                    }
                }
            }
            Err(error) => errors.push(format!("{repo}: {error}")),
        }
    }
    // Partial answers are still answers; only a check that learned nothing
    // at all is an error.
    if outdated.is_empty() && !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    if let Ok(mut cache) = UPDATE_CHECK.lock() {
        *cache = Some((Instant::now(), outdated.clone()));
    }
    Ok(outdated)
}

/// The tree SHA of the folder holding `skill_path` (a path to a SKILL.md),
/// as the skills CLI computes it.
fn folder_hash<'a>(tree: &'a [TreeNode], skill_path: &str) -> Option<&'a str> {
    let path = skill_path.replace('\\', "/");
    let folder = path
        .strip_suffix("SKILL.md")
        .or_else(|| path.strip_suffix("skill.md"))
        .unwrap_or(&path)
        .trim_end_matches('/');
    if folder.is_empty() {
        return None;
    }
    tree.iter()
        .find(|node| node.kind == "tree" && node.path == folder)
        .map(|node| node.sha.as_str())
}

/// `skills update <names…> -g -y`; with no names, every global skill the
/// CLI installed.
pub fn update(names: &[String]) -> Result<SkillCommandOutcome, String> {
    let home = home_dir()?;
    let lock = read_lock(&home);
    if let Some(unknown) = names.iter().find(|n| !lock.contains_key(*n)) {
        return Err(format!(
            "{unknown} wasn't installed by the skills CLI, so it can't be updated"
        ));
    }
    let mut args = String::from("update");
    for name in names {
        args.push(' ');
        args.push_str(&shell_quote(name));
    }
    let outcome = run_cli(&format!("{args} -g -y"));
    forget_update_check();
    outcome
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

fn http() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("egant")
        .build()
        .map_err(|e| e.to_string())
}

/// skills.sh's search — the endpoint `skills find` uses.
pub fn search(query: &str) -> Result<Vec<CatalogSkill>, String> {
    let query = query.trim();
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    search_hits(&http()?, query, 60)
}

fn search_hits(
    client: &reqwest::blocking::Client,
    query: &str,
    limit: u32,
) -> Result<Vec<CatalogSkill>, String> {
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Hit {
        id: String,
        source: String,
        skill_id: String,
        name: String,
        #[serde(default)]
        installs: Option<u64>,
        /// skills.sh's flag for a copy of a skill published elsewhere.
        #[serde(default)]
        is_duplicate: bool,
    }
    #[derive(Deserialize)]
    struct Response {
        skills: Vec<Hit>,
    }
    let response: Response = client
        .get(format!(
            "https://skills.sh/api/search?q={}&limit={limit}",
            url_encode(query)
        ))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("skills.sh search failed: {e}"))?
        .json()
        .map_err(|e| format!("skills.sh answered in a shape egant doesn't know: {e}"))?;
    Ok(response
        .skills
        .into_iter()
        .filter(|hit| !hit.is_duplicate)
        .map(|hit| CatalogSkill {
            id: hit.id,
            source: hit.source,
            skill_id: hit.skill_id,
            name: hit.name,
            description: None,
            installs: hit.installs,
            path: None,
        })
        .collect())
}

/// "Popular on skills.sh", approximated. Its real leaderboard is only
/// served to callers holding a Vercel OIDC token, so this runs a spread of
/// broad searches and keeps the most-installed results — close to the
/// leaderboard's top, not identical to it. A few sources publish dozens of
/// near-identical skills, so each source gets at most [`PER_SOURCE`] places
/// to keep the list varied. Cached for the hour.
pub fn popular(refresh: bool) -> Result<Vec<CatalogSkill>, String> {
    const QUERIES: &[&str] = &[
        "skill", "react", "design", "test", "git", "docs", "python", "api", "deploy", "code",
        "web", "agent", "data", "pdf", "review", "debug",
    ];
    const PER_SOURCE: usize = 3;
    const TOP: usize = 24;
    static CACHE: Mutex<Option<(Instant, Vec<CatalogSkill>)>> = Mutex::new(None);
    if !refresh {
        if let Some((at, skills)) = CACHE.lock().ok().and_then(|c| c.clone()) {
            if at.elapsed() < Duration::from_secs(3600) {
                return Ok(skills);
            }
        }
    }
    let client = http()?;
    let results: Vec<Result<Vec<CatalogSkill>, String>> = std::thread::scope(|scope| {
        let handles: Vec<_> = QUERIES
            .iter()
            .map(|q| {
                let client = &client;
                scope.spawn(move || search_hits(client, q, 60))
            })
            .collect();
        handles
            .into_iter()
            .map(|h| {
                h.join()
                    .unwrap_or_else(|_| Err("search thread panicked".into()))
            })
            .collect()
    });
    let mut errors = Vec::new();
    let mut seen: BTreeMap<String, CatalogSkill> = BTreeMap::new();
    for result in results {
        match result {
            Ok(hits) => {
                for hit in hits {
                    seen.entry(hit.id.clone()).or_insert(hit);
                }
            }
            Err(error) => errors.push(error),
        }
    }
    if seen.is_empty() {
        return Err(errors
            .into_iter()
            .next()
            .unwrap_or_else(|| "skills.sh returned nothing".into()));
    }
    let skills = rank_popular(seen.into_values().collect(), PER_SOURCE, TOP);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), skills.clone()));
    }
    Ok(skills)
}

fn rank_popular(mut skills: Vec<CatalogSkill>, per_source: usize, top: usize) -> Vec<CatalogSkill> {
    skills.sort_by_key(|s| std::cmp::Reverse(s.installs.unwrap_or(0)));
    let mut per: BTreeMap<String, usize> = BTreeMap::new();
    skills
        .into_iter()
        .filter(|s| {
            let count = per.entry(s.source.clone()).or_default();
            *count += 1;
            *count <= per_source
        })
        .take(top)
        .collect()
}

/// The official repos, browsed with no query. Each is one GitHub tree
/// listing plus a raw SKILL.md fetch per skill for its description, cached
/// for the hour — GitHub allows an unauthenticated caller 60 API calls an
/// hour, and this spends two.
pub fn featured(refresh: bool) -> Result<Vec<FeaturedSource>, String> {
    static CACHE: Mutex<Option<(Instant, Vec<FeaturedSource>)>> = Mutex::new(None);
    if !refresh {
        if let Some((at, sources)) = CACHE.lock().ok().and_then(|c| c.clone()) {
            if at.elapsed() < Duration::from_secs(3600) {
                return Ok(sources);
            }
        }
    }
    const SOURCES: &[(&str, &str, &str)] = &[
        ("anthropics/skills", "Anthropic", "skills/"),
        ("openai/skills", "OpenAI", "skills/.curated/"),
    ];
    let client = http()?;
    let mut out = Vec::new();
    let mut errors = Vec::new();
    for (source, label, prefix) in SOURCES {
        match list_repo_skills(&client, source, prefix) {
            Ok(skills) => out.push(FeaturedSource {
                source,
                label,
                skills,
            }),
            Err(error) => errors.push(format!("{label}: {error}")),
        }
    }
    if out.is_empty() && !errors.is_empty() {
        return Err(errors.join("\n"));
    }
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((Instant::now(), out.clone()));
    }
    Ok(out)
}

fn list_repo_skills(
    client: &reqwest::blocking::Client,
    source: &str,
    prefix: &str,
) -> Result<Vec<CatalogSkill>, String> {
    let tree = repo_tree(client, source, None)?;
    // `<prefix><skill>/SKILL.md`, exactly one level down.
    let paths: Vec<(String, String)> = tree
        .into_iter()
        .filter_map(|node| {
            let rest = node.path.strip_prefix(prefix)?;
            let skill = rest.strip_suffix("/SKILL.md")?.to_string();
            (!skill.contains('/')).then(|| (skill, node.path.clone()))
        })
        .collect();

    // Descriptions in parallel, a handful of fetches at a time.
    let mut skills: Vec<CatalogSkill> = Vec::with_capacity(paths.len());
    for chunk in paths.chunks(8) {
        let fetched: Vec<CatalogSkill> = std::thread::scope(|scope| {
            let handles: Vec<_> = chunk
                .iter()
                .map(|(skill, path)| {
                    scope.spawn(move || {
                        let text = raw_file(client, source, path).unwrap_or_default();
                        let (name, description) = parse_frontmatter(&text);
                        CatalogSkill {
                            id: format!("{source}/{skill}"),
                            source: source.to_string(),
                            skill_id: skill.clone(),
                            name: name.unwrap_or_else(|| skill.clone()),
                            description,
                            installs: None,
                            path: Some(path.clone()),
                        }
                    })
                })
                .collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        skills.extend(fetched);
    }
    skills.sort_by_key(|s| s.name.to_lowercase());
    Ok(skills)
}

fn url_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct TreeNode {
    path: String,
    #[serde(rename = "type")]
    kind: String,
    sha: String,
}

/// Every path in a repo at `git_ref` (default branch when `None`): one
/// GitHub API call, which an unauthenticated caller gets 60 of an hour.
fn repo_tree(
    client: &reqwest::blocking::Client,
    repo: &str,
    git_ref: Option<&str>,
) -> Result<Vec<TreeNode>, String> {
    #[derive(Deserialize)]
    struct Tree {
        tree: Vec<TreeNode>,
    }
    let git_ref = git_ref.filter(|r| !r.is_empty()).unwrap_or("HEAD");
    let response = client
        .get(format!(
            "https://api.github.com/repos/{repo}/git/trees/{}?recursive=1",
            url_encode(git_ref)
        ))
        .header("Accept", "application/vnd.github+json")
        .send()
        .map_err(|e| e.to_string())?;
    if response.status() == reqwest::StatusCode::FORBIDDEN
        || response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS
    {
        return Err(
            "GitHub's hourly limit for anonymous requests is used up — try again later.".into(),
        );
    }
    let tree: Tree = response
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .map_err(|e| e.to_string())?;
    Ok(tree.tree)
}

fn fetch_text(client: &reqwest::blocking::Client, url: &str) -> Result<String, String> {
    client
        .get(url)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())
}

fn raw_file(client: &reqwest::blocking::Client, repo: &str, path: &str) -> Result<String, String> {
    fetch_text(
        client,
        &format!("https://raw.githubusercontent.com/{repo}/HEAD/{path}"),
    )
}

/// A catalog skill's SKILL.md, for the detail sheet. With no known path,
/// the usual layouts are tried before giving up — skills.sh's search
/// doesn't say where in the repo a skill lives.
pub fn read_remote(source: &str, skill_id: &str, path: Option<&str>) -> Result<String, String> {
    let source = Source::parse(source)?;
    if skill_id.is_empty() || skill_id.contains("..") || skill_id.contains('/') {
        return Err("bad skill id".into());
    }
    let client = http()?;
    let repo = match source {
        Source::Repo(repo) => repo,
        Source::Site(domain) => {
            // The well-known layout: `<site>/.well-known/agent-skills/<skill>/`
            // (current) or `/.well-known/skills/<skill>/` (legacy).
            for root in [".well-known/agent-skills", ".well-known/skills"] {
                let url = format!("https://{domain}/{root}/{}/SKILL.md", url_encode(skill_id));
                if let Ok(text) = fetch_text(&client, &url) {
                    return Ok(text);
                }
            }
            return Err(format!(
                "{domain} doesn't publish a SKILL.md for {skill_id}."
            ));
        }
    };
    let guesses: Vec<String> = match path {
        Some(path) if !path.contains("..") => vec![path.to_string()],
        _ => [
            "skills/{}/SKILL.md",
            "{}/SKILL.md",
            "skills/.curated/{}/SKILL.md",
            ".claude/skills/{}/SKILL.md",
            ".agents/skills/{}/SKILL.md",
            "SKILL.md",
        ]
        .iter()
        .map(|p| p.replace("{}", skill_id))
        .collect(),
    };
    for guess in &guesses {
        if let Ok(text) = raw_file(&client, &repo, guess) {
            // A repo-root SKILL.md only counts when it's this skill.
            if guess == "SKILL.md" && parse_frontmatter(&text).0.as_deref() != Some(skill_id) {
                continue;
            }
            return Ok(text);
        }
    }
    Err("Couldn't find this skill's SKILL.md in its repository.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontmatter_handles_quotes_and_block_scalars() {
        let (name, description) =
            parse_frontmatter("---\nname: pdf\ndescription: \"Read \\\"PDFs\\\"\"\n---\nbody");
        assert_eq!(name.as_deref(), Some("pdf"));
        assert_eq!(description.as_deref(), Some("Read \"PDFs\""));

        let (_, description) = parse_frontmatter(
            "---\nname: x\ndescription: >\n  Folded across\n  two lines\nlicense: MIT\n---\n",
        );
        assert_eq!(description.as_deref(), Some("Folded across two lines"));

        assert_eq!(parse_frontmatter("# no frontmatter"), (None, None));
    }

    #[test]
    fn generated_skill_md_reads_back() {
        let text = skill_md("my-skill", "Use it: when \"asked\"", "");
        let (name, description) = parse_frontmatter(&text);
        assert_eq!(name.as_deref(), Some("my-skill"));
        assert_eq!(description.as_deref(), Some("Use it: when \"asked\""));
    }

    #[test]
    fn ids_and_sources_are_checked() {
        assert!(check_id("web-design").is_ok());
        for bad in ["", "Web", "a b", "../x", "-a", "a--b", "a/b"] {
            assert!(check_id(bad).is_err(), "{bad}");
        }
        assert_eq!(
            Source::parse("vercel-labs/agent-skills")
                .unwrap()
                .install_arg(),
            "vercel-labs/agent-skills"
        );
        assert_eq!(
            Source::parse("open.feishu.cn").unwrap().install_arg(),
            "https://open.feishu.cn"
        );
        for bad in ["a/b/c", "../b", "a;rm/b", "localhost", ".x.com", "-x/y", ""] {
            assert!(Source::parse(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn retargeting_links_from_the_canonical_copy() {
        let home = std::env::temp_dir().join(format!("egant-skills-{}", uuid::Uuid::new_v4()));
        let canonical = home.join(CANONICAL_DIR).join("demo");
        std::fs::create_dir_all(&canonical).unwrap();
        std::fs::write(canonical.join("SKILL.md"), skill_md("demo", "d", "")).unwrap();

        set_agents_at(&home, "demo", &["claude".into(), "codex".into()]).unwrap();
        let lib = library_at(&home, |_| false);
        let demo = lib.installed.iter().find(|s| s.id == "demo").unwrap();
        // Cline and Pi read the canonical folder itself.
        assert_eq!(demo.agents, vec!["claude", "codex", "cline", "pi"]);
        assert!(is_symlink(&home.join(".claude/skills/demo")));

        set_agents_at(&home, "demo", &["codex".into()]).unwrap();
        assert!(home.join(".claude/skills/demo").symlink_metadata().is_err());
        assert!(
            canonical.join("SKILL.md").is_file(),
            "the real copy survives"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn popular_ranks_by_installs_and_spreads_sources() {
        let skill = |source: &str, id: &str, installs: u64| CatalogSkill {
            id: format!("{source}/{id}"),
            source: source.into(),
            skill_id: id.into(),
            name: id.into(),
            description: None,
            installs: Some(installs),
            path: None,
        };
        let ranked = rank_popular(
            vec![
                skill("big/org", "a", 90),
                skill("big/org", "b", 80),
                skill("small/one", "c", 10),
                skill("big/org", "d", 70),
                skill("other/repo", "e", 50),
            ],
            2,
            3,
        );
        let ids: Vec<_> = ranked.iter().map(|s| s.skill_id.as_str()).collect();
        assert_eq!(ids, vec!["a", "b", "e"]);
    }

    #[test]
    fn folder_hash_matches_the_cli() {
        let node = |path: &str, kind: &str, sha: &str| TreeNode {
            path: path.into(),
            kind: kind.into(),
            sha: sha.into(),
        };
        let tree = vec![
            node("skills/pdf", "tree", "aaa"),
            node("skills/pdf/SKILL.md", "blob", "bbb"),
        ];
        assert_eq!(folder_hash(&tree, "skills/pdf/SKILL.md"), Some("aaa"));
        assert_eq!(folder_hash(&tree, "skills/gone/SKILL.md"), None);
    }

    #[test]
    fn strips_terminal_colors() {
        assert_eq!(strip_ansi("\u{1b}[32m✓\u{1b}[0m done\r\n"), "✓ done\n");
    }
}
