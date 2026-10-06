//! MCP servers, synced into every agent's own config file.
//!
//! One normalized shape ([`McpServer`]: a stdio command or an http URL) is
//! translated into each agent's dialect on write and back on read. The
//! dialects and file locations follow emdash's per-agent adapters
//! (`packages/core/src/services/agent-plugins/api/plugins/helpers/mcp.ts`),
//! plus Antigravity, whose CLI documents `~/.gemini/config/mcp_config.json`.
//!
//! Edits are surgical: only the one server entry is touched, every other key
//! in the file is handed back as it was (key order included), and fields we
//! don't manage on an existing entry — Codex's `startup_timeout_sec`, a
//! Claude `sse` type — survive an edit. The catalog of popular servers is in
//! [`super::mcp_catalog`].

use super::{home_dir, write_atomic};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// How a server is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Transport {
    /// A local process egant's agents spawn and talk to over stdin/stdout.
    #[default]
    Stdio,
    /// A remote endpoint (streamable HTTP or SSE).
    Http,
}

/// One server in the agent-neutral shape the Library edits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct McpServer {
    pub name: String,
    pub transport: Transport,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
}

/// An agent the Library can sync servers into.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpTarget {
    /// The install catalog's id (`claude`, `codex`, …).
    pub id: &'static str,
    pub name: String,
    /// The agent's CLI is on this machine, or its config file already
    /// exists — either way, writing to it is meaningful.
    pub available: bool,
    pub config_path: String,
    /// Set when the config exists but egant can't safely rewrite it — a
    /// JSONC file with comments, or one that doesn't parse at all.
    pub error: Option<String>,
}

/// A server as it stands across agents.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledMcp {
    #[serde(flatten)]
    pub server: McpServer,
    /// The agents whose config has an entry by this name.
    pub agents: Vec<&'static str>,
    /// The entries by this name don't all agree — the shape shown is the
    /// first agent's, in [`TARGETS`] order.
    pub differs: bool,
    /// The catalog entry this server came from, matched by name.
    pub catalog_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpLibrary {
    pub targets: Vec<McpTarget>,
    pub servers: Vec<InstalledMcp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialKey {
    pub key: String,
    pub required: bool,
}

/// One "Recommended" card.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogMcp {
    pub id: String,
    pub name: String,
    pub description: String,
    pub docs_url: String,
    pub transport: Transport,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// Values are templates: `YOUR_API_KEY` (or `Bearer YOUR_PAT`) marks the
    /// part the user's credential replaces.
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    /// Which `env`/`headers` keys are credentials the add sheet asks for.
    #[serde(default)]
    pub credential_keys: Vec<CredentialKey>,
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Dialect {
    /// `mcpServers` with `type: stdio|http` — Claude Code, Amp.
    Claude,
    /// Claude's shape plus `tools: ["*"]`.
    Copilot,
    /// `mcpServers` with no `type` field.
    Cursor,
    /// `mcpServers`, http as `httpUrl` with an `Accept` header.
    Qwen,
    /// `mcpServers`, http as `serverUrl`.
    Antigravity,
    /// `mcp`, `type: local` with a command array / `type: remote`.
    Opencode,
    /// TOML `[mcp_servers.<name>]`, http headers as `http_headers`.
    Codex,
    /// TOML `[mcp_servers.<name>]`, `headers`, `enabled = true`.
    Grok,
}

struct Target {
    id: &'static str,
    dialect: Dialect,
    /// Relative to home. The first that exists is written; every one that
    /// exists is read and has a removed server taken out of it. None
    /// existing, the first is created.
    files: &'static [&'static str],
    /// The key holding the servers (a literal key — Amp's is `amp.mcpServers`).
    key: &'static str,
}

/// Every agent with a known MCP config, in the order the Library lists them.
/// Agents not here (Devin, Hermes, Pi, …) have no MCP config format we can
/// verify, so the Library doesn't guess at one.
const TARGETS: &[Target] = &[
    Target {
        id: "claude",
        dialect: Dialect::Claude,
        files: &[".claude.json"],
        key: "mcpServers",
    },
    Target {
        id: "codex",
        dialect: Dialect::Codex,
        files: &[".codex/config.toml"],
        key: "mcp_servers",
    },
    Target {
        id: "opencode",
        dialect: Dialect::Opencode,
        files: &[
            ".config/opencode/opencode.json",
            ".config/opencode/opencode.jsonc",
            ".config/opencode/config.json",
        ],
        key: "mcp",
    },
    Target {
        id: "antigravity",
        dialect: Dialect::Antigravity,
        files: &[".gemini/config/mcp_config.json"],
        key: "mcpServers",
    },
    Target {
        id: "cursor",
        dialect: Dialect::Cursor,
        files: &[".cursor/mcp.json"],
        key: "mcpServers",
    },
    Target {
        id: "copilot",
        dialect: Dialect::Copilot,
        files: &[".copilot/mcp-config.json"],
        key: "mcpServers",
    },
    Target {
        id: "amp",
        dialect: Dialect::Claude,
        files: &[".config/amp/settings.json"],
        key: "amp.mcpServers",
    },
    Target {
        id: "grok",
        dialect: Dialect::Grok,
        files: &[".grok/config.toml"],
        key: "mcp_servers",
    },
    Target {
        id: "qwen",
        dialect: Dialect::Qwen,
        files: &[".qwen/settings.json"],
        key: "mcpServers",
    },
];

/// What emdash injects on http servers for the agents that need it, and
/// strips again on read so it never shows up as a user header.
const INJECTED_ACCEPT: &str = "application/json, text/event-stream";

impl Target {
    fn is_toml(&self) -> bool {
        matches!(self.dialect, Dialect::Codex | Dialect::Grok)
    }

    fn existing(&self, home: &Path) -> Vec<PathBuf> {
        self.files
            .iter()
            .map(|f| home.join(f))
            .filter(|p| p.is_file())
            .collect()
    }

    fn write_path(&self, home: &Path) -> PathBuf {
        self.existing(home)
            .into_iter()
            .next()
            .unwrap_or_else(|| home.join(self.files[0]))
    }
}

fn target(id: &str) -> Option<&'static Target> {
    TARGETS.iter().find(|t| t.id == id)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Every target and every server they hold.
pub fn library() -> Result<McpLibrary, String> {
    library_at(&home_dir()?, crate::catalog::is_installed)
}

/// Add or update `server` in exactly the `agents` listed, and take it out of
/// every other agent that has it. `previous_name` is the server's name before
/// a rename, so the old entry goes too. Every target is attempted; failures
/// are collected and returned together.
pub fn save(
    server: McpServer,
    agents: &[String],
    previous_name: Option<&str>,
) -> Result<McpLibrary, String> {
    let home = home_dir()?;
    save_at(&home, &normalize(server)?, agents, previous_name)?;
    library()
}

/// Remove a server from every agent that has it.
pub fn remove(name: &str) -> Result<McpLibrary, String> {
    let home = home_dir()?;
    let mut errors = Vec::new();
    for target in TARGETS {
        if let Err(error) = remove_from(&home, target, name) {
            errors.push(error);
        }
    }
    finish(errors)?;
    library()
}

fn finish(errors: Vec<String>) -> Result<(), String> {
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("\n"))
    }
}

fn library_at(home: &Path, installed: impl Fn(&str) -> bool) -> Result<McpLibrary, String> {
    let mut targets = Vec::new();
    let mut servers: Vec<InstalledMcp> = Vec::new();
    for target in TARGETS {
        let existing = target.existing(home);
        let mut error = None;
        for path in &existing {
            match read_servers(target, path) {
                Ok(found) => {
                    for server in found {
                        merge_into(&mut servers, server, target.id);
                    }
                }
                Err(e) => error = Some(e),
            }
        }
        // A file we can read but not write back (comments) is an error too:
        // the card must not offer a sync that is going to fail.
        if error.is_none() {
            if let Some(path) = existing.first() {
                error = writable(target, path).err();
            }
        }
        targets.push(McpTarget {
            id: target.id,
            name: crate::catalog::display_name(target.id).to_string(),
            available: installed(target.id) || !existing.is_empty(),
            config_path: format!(
                "~/{}",
                target
                    .write_path(home)
                    .strip_prefix(home)
                    .unwrap_or(Path::new(""))
                    .display()
            ),
            error,
        });
    }
    let catalog = super::mcp_catalog::current();
    for installed in &mut servers {
        installed.catalog_id = catalog
            .iter()
            .find(|c| c.id.eq_ignore_ascii_case(&installed.server.name))
            .map(|c| c.id.clone());
    }
    servers.sort_by(|a, b| {
        a.server
            .name
            .to_lowercase()
            .cmp(&b.server.name.to_lowercase())
    });
    Ok(McpLibrary { targets, servers })
}

fn merge_into(servers: &mut Vec<InstalledMcp>, server: McpServer, agent: &'static str) {
    match servers.iter_mut().find(|s| s.server.name == server.name) {
        Some(existing) => {
            if !existing.agents.contains(&agent) {
                existing.agents.push(agent);
            }
            if existing.server != server {
                existing.differs = true;
            }
        }
        None => servers.push(InstalledMcp {
            server,
            agents: vec![agent],
            differs: false,
            catalog_id: None,
        }),
    }
}

fn save_at(
    home: &Path,
    server: &McpServer,
    agents: &[String],
    previous_name: Option<&str>,
) -> Result<(), String> {
    if let Some(unknown) = agents.iter().find(|a| target(a).is_none()) {
        return Err(format!(
            "{unknown} has no MCP config egant knows how to write"
        ));
    }
    let renamed = previous_name.filter(|p| *p != server.name);
    let mut errors = Vec::new();
    for target in TARGETS {
        // A config egant won't rewrite (JSONC with comments) is left exactly
        // as it is — the sheet shows it locked, so nothing asked to change it.
        if let Some(path) = target.existing(home).first() {
            if writable(target, path).is_err() {
                continue;
            }
        }
        let result = if agents.iter().any(|a| a == target.id) {
            let mut result = upsert(home, target, server);
            if result.is_ok() {
                if let Some(old) = renamed {
                    result = remove_from(home, target, old);
                }
            }
            result
        } else {
            remove_from(home, target, &server.name)
                .and_then(|()| renamed.map_or(Ok(()), |old| remove_from(home, target, old)))
        };
        if let Err(error) = result {
            errors.push(error);
        }
    }
    finish(errors)
}

/// Trim, drop blank env/header rows, and check the server can be written.
fn normalize(mut server: McpServer) -> Result<McpServer, String> {
    server.name = server.name.trim().to_string();
    if server.name.is_empty()
        || !server
            .name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("A server name can only use letters, numbers, - and _.".into());
    }
    let clean = |map: BTreeMap<String, String>| {
        map.into_iter()
            .map(|(k, v)| (k.trim().to_string(), v))
            .filter(|(k, _)| !k.is_empty())
            .collect::<BTreeMap<_, _>>()
    };
    server.env = clean(server.env);
    server.headers = clean(server.headers);
    server.args.retain(|a| !a.is_empty());
    match server.transport {
        Transport::Stdio => {
            server.command = server.command.trim().to_string();
            if server.command.is_empty() {
                return Err("A stdio server needs a command.".into());
            }
            server.url.clear();
            server.headers.clear();
        }
        Transport::Http => {
            server.url = server.url.trim().to_string();
            if !(server.url.starts_with("http://") || server.url.starts_with("https://")) {
                return Err("An http server needs an http(s):// URL.".into());
            }
            server.command.clear();
            server.args.clear();
        }
    }
    Ok(server)
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

fn read_servers(target: &Target, path: &Path) -> Result<Vec<McpServer>, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if target.is_toml() {
        let doc: toml_edit::DocumentMut = text
            .parse()
            .map_err(|e| format!("{} doesn't parse: {e}", path.display()))?;
        let Some(table) = doc.get(target.key).and_then(|i| i.as_table_like()) else {
            return Ok(Vec::new());
        };
        Ok(table
            .iter()
            .filter_map(|(name, item)| from_toml(target.dialect, name, item))
            .collect())
    } else {
        let root =
            parse_json(&text).map_err(|e| format!("{} doesn't parse: {e}", path.display()))?;
        let Some(Value::Object(map)) = root.get(target.key) else {
            return Ok(Vec::new());
        };
        Ok(map
            .iter()
            .filter_map(|(name, value)| from_json(target.dialect, name, value))
            .collect())
    }
}

/// Whether the file can be rewritten without losing anything: TOML always
/// (toml_edit keeps comments), JSON only when it's plain JSON.
fn writable(target: &Target, path: &Path) -> Result<(), String> {
    if target.is_toml() {
        return Ok(());
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_str::<Value>(&text).map(|_| ()).map_err(|_| {
        format!(
            "{} has comments, which egant won't strip by rewriting it — add servers there by hand.",
            path.display()
        )
    })
}

fn upsert(home: &Path, target: &Target, server: &McpServer) -> Result<(), String> {
    let path = target.write_path(home);
    let text = match std::fs::read_to_string(&path) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    let updated = if target.is_toml() {
        let mut doc: toml_edit::DocumentMut = text
            .as_deref()
            .unwrap_or("")
            .parse()
            .map_err(|e| format!("{} doesn't parse: {e}", path.display()))?;
        let servers = doc
            .entry(target.key)
            .or_insert_with(|| {
                let mut table = toml_edit::Table::new();
                table.set_implicit(true);
                toml_edit::Item::Table(table)
            })
            .as_table_like_mut()
            .ok_or_else(|| format!("{}: `{}` isn't a table", path.display(), target.key))?;
        let entry = servers
            .entry(&server.name)
            .or_insert(toml_edit::Item::Table(toml_edit::Table::new()));
        let table = entry
            .as_table_like_mut()
            .ok_or_else(|| format!("{}: `{}` isn't a table", path.display(), server.name))?;
        to_toml(target.dialect, server, table);
        doc.to_string()
    } else {
        if text.is_some() {
            writable(target, &path)?;
        }
        let mut root: Value = match text.as_deref().map(str::trim) {
            None | Some("") => json!({}),
            Some(t) => serde_json::from_str(t).map_err(|e| format!("{}: {e}", path.display()))?,
        };
        let root_map = root
            .as_object_mut()
            .ok_or_else(|| format!("{} isn't a JSON object", path.display()))?;
        let servers = root_map
            .entry(target.key)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .ok_or_else(|| format!("{}: `{}` isn't an object", path.display(), target.key))?;
        let existing = servers
            .get(&server.name)
            .and_then(Value::as_object)
            .cloned();
        servers.insert(
            server.name.clone(),
            to_json(target.dialect, server, existing),
        );
        serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n"
    };
    write_atomic(&path, &updated)
}

/// Take `name` out of every file this target reads. Nothing to remove is
/// not an error, and an untouched file is never rewritten.
fn remove_from(home: &Path, target: &Target, name: &str) -> Result<(), String> {
    for path in target.existing(home) {
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if target.is_toml() {
            let mut doc: toml_edit::DocumentMut = text
                .parse()
                .map_err(|e| format!("{} doesn't parse: {e}", path.display()))?;
            let removed = doc
                .get_mut(target.key)
                .and_then(|i| i.as_table_like_mut())
                .and_then(|t| t.remove(name))
                .is_some();
            if removed {
                write_atomic(&path, &doc.to_string())?;
            }
        } else {
            let Ok(root) = parse_json(&text) else {
                continue;
            };
            let present = root.get(target.key).and_then(|s| s.get(name)).is_some();
            if !present {
                continue;
            }
            writable(target, &path)?;
            let mut root: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
            if let Some(servers) = root.get_mut(target.key).and_then(Value::as_object_mut) {
                servers.shift_remove(name);
            }
            let out = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())? + "\n";
            write_atomic(&path, &out)?;
        }
    }
    Ok(())
}

/// Plain JSON, else JSON with comments and trailing commas (`.jsonc`).
fn parse_json(text: &str) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    serde_json::from_str(text)
        .or_else(|first| serde_json::from_str(&strip_jsonc(text)).map_err(|_| first.to_string()))
}

/// Drop `//` and `/* */` comments outside strings, and trailing commas.
fn strip_jsonc(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    let mut in_string = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if c == '\\' {
                if let Some(next) = chars.next() {
                    out.push(next);
                }
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match (c, chars.peek()) {
            ('"', _) => {
                in_string = true;
                out.push(c);
            }
            ('/', Some('/')) => {
                for next in chars.by_ref() {
                    if next == '\n' {
                        out.push('\n');
                        break;
                    }
                }
            }
            ('/', Some('*')) => {
                chars.next();
                let mut last = ' ';
                for next in chars.by_ref() {
                    if last == '*' && next == '/' {
                        break;
                    }
                    last = next;
                }
            }
            _ => out.push(c),
        }
    }
    // Trailing commas: a comma whose next non-space character closes.
    let bytes: Vec<char> = out.chars().collect();
    let mut cleaned = String::with_capacity(out.len());
    let mut in_string = false;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i];
        if in_string {
            if c == '\\' && i + 1 < bytes.len() {
                cleaned.push(c);
                cleaned.push(bytes[i + 1]);
                i += 2;
                continue;
            }
            if c == '"' {
                in_string = false;
            }
        } else if c == '"' {
            in_string = true;
        } else if c == ',' {
            let next = bytes[i + 1..].iter().find(|c| !c.is_whitespace());
            if matches!(next, Some('}') | Some(']')) {
                i += 1;
                continue;
            }
        }
        cleaned.push(c);
        i += 1;
    }
    cleaned
}

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

fn string_map(value: Option<&Value>) -> BTreeMap<String, String> {
    value
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn without_injected_accept(mut headers: BTreeMap<String, String>) -> BTreeMap<String, String> {
    headers.retain(|k, v| !(k.eq_ignore_ascii_case("accept") && v == INJECTED_ACCEPT));
    headers
}

fn from_json(dialect: Dialect, name: &str, value: &Value) -> Option<McpServer> {
    let entry = value.as_object()?;
    let str_of = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
    let mut server = McpServer {
        name: name.to_string(),
        ..Default::default()
    };

    if dialect == Dialect::Opencode {
        match str_of("type").as_deref() {
            Some("remote") => {
                server.transport = Transport::Http;
                server.url = str_of("url")?;
                server.headers = without_injected_accept(string_map(entry.get("headers")));
            }
            _ => {
                let mut command = strings(entry.get("command")).into_iter();
                server.command = command.next()?;
                server.args = command.collect();
                server.env = string_map(entry.get("environment").or_else(|| entry.get("env")));
            }
        }
        return Some(server);
    }

    let url = match dialect {
        Dialect::Qwen => str_of("httpUrl").or_else(|| str_of("url")),
        Dialect::Antigravity => str_of("serverUrl").or_else(|| str_of("url")),
        _ => str_of("url"),
    };
    match (str_of("command"), url) {
        (Some(command), _) => {
            server.command = command;
            server.args = strings(entry.get("args"));
            server.env = string_map(entry.get("env"));
        }
        (None, Some(url)) => {
            server.transport = Transport::Http;
            server.url = url;
            server.headers = without_injected_accept(string_map(entry.get("headers")));
        }
        (None, None) => return None,
    }
    Some(server)
}

/// The native entry for `server`, built on top of `existing` so fields we
/// don't manage survive the edit.
fn to_json(dialect: Dialect, server: &McpServer, existing: Option<Map<String, Value>>) -> Value {
    const MANAGED: &[&str] = &[
        "type",
        "command",
        "args",
        "env",
        "environment",
        "url",
        "httpUrl",
        "serverUrl",
        "headers",
    ];
    let mut entry = existing.unwrap_or_default();
    let previous_type = entry
        .get("type")
        .and_then(Value::as_str)
        .map(str::to_string);
    for key in MANAGED {
        entry.shift_remove(*key);
    }
    let env = || json!(server.env);
    let headers = |inject: bool| {
        let mut headers = server.headers.clone();
        if inject && !headers.keys().any(|k| k.eq_ignore_ascii_case("accept")) {
            headers.insert("Accept".into(), INJECTED_ACCEPT.into());
        }
        json!(headers)
    };
    let http = server.transport == Transport::Http;

    match dialect {
        Dialect::Opencode => {
            if http {
                entry.insert("type".into(), json!("remote"));
                entry.insert("url".into(), json!(server.url));
                entry.insert("headers".into(), headers(true));
            } else {
                let mut command = vec![server.command.clone()];
                command.extend(server.args.iter().cloned());
                entry.insert("type".into(), json!("local"));
                entry.insert("command".into(), json!(command));
                if !server.env.is_empty() {
                    entry.insert("environment".into(), env());
                }
            }
            entry.entry("enabled").or_insert(json!(true));
        }
        _ => {
            if matches!(dialect, Dialect::Claude | Dialect::Copilot) {
                // Claude also speaks `sse`; an existing SSE server edited
                // here stays one rather than being silently re-typed.
                let kind = match (http, previous_type.as_deref()) {
                    (true, Some("sse")) => "sse",
                    (true, _) => "http",
                    (false, _) => "stdio",
                };
                entry.insert("type".into(), json!(kind));
            }
            if http {
                let key = match dialect {
                    Dialect::Qwen => "httpUrl",
                    Dialect::Antigravity => "serverUrl",
                    _ => "url",
                };
                entry.insert(key.into(), json!(server.url));
                let inject = dialect == Dialect::Qwen;
                if inject || !server.headers.is_empty() {
                    entry.insert("headers".into(), headers(inject));
                }
            } else {
                entry.insert("command".into(), json!(server.command));
                if !server.args.is_empty() {
                    entry.insert("args".into(), json!(server.args));
                }
                if !server.env.is_empty() {
                    entry.insert("env".into(), env());
                }
            }
            if dialect == Dialect::Copilot {
                entry.entry("tools").or_insert(json!(["*"]));
            }
        }
    }
    Value::Object(entry)
}

fn toml_strings(item: Option<&toml_edit::Item>) -> Vec<String> {
    item.and_then(|i| i.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn toml_map(item: Option<&toml_edit::Item>) -> BTreeMap<String, String> {
    item.and_then(|i| i.as_table_like())
        .map(|t| {
            t.iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.to_string(), v.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn from_toml(dialect: Dialect, name: &str, item: &toml_edit::Item) -> Option<McpServer> {
    let table = item.as_table_like()?;
    let str_of = |key: &str| table.get(key).and_then(|i| i.as_str()).map(str::to_string);
    let mut server = McpServer {
        name: name.to_string(),
        ..Default::default()
    };
    match (str_of("command"), str_of("url")) {
        (Some(command), _) => {
            server.command = command;
            server.args = toml_strings(table.get("args"));
            server.env = toml_map(table.get("env"));
        }
        (None, Some(url)) => {
            server.transport = Transport::Http;
            server.url = url;
            let headers_key = if dialect == Dialect::Codex {
                "http_headers"
            } else {
                "headers"
            };
            server.headers = toml_map(table.get(headers_key).or_else(|| table.get("headers")));
        }
        (None, None) => return None,
    }
    Some(server)
}

fn to_toml(dialect: Dialect, server: &McpServer, table: &mut dyn toml_edit::TableLike) {
    for key in ["command", "args", "env", "url", "http_headers", "headers"] {
        table.remove(key);
    }
    let inline = |map: &BTreeMap<String, String>| {
        let mut t = toml_edit::InlineTable::new();
        for (k, v) in map {
            t.insert(k, v.as_str().into());
        }
        toml_edit::value(t)
    };
    match server.transport {
        Transport::Stdio => {
            table.insert("command", toml_edit::value(server.command.as_str()));
            if !server.args.is_empty() {
                let args: toml_edit::Array = server.args.iter().map(String::as_str).collect();
                table.insert("args", toml_edit::value(args));
            }
            if !server.env.is_empty() {
                table.insert("env", inline(&server.env));
            }
        }
        Transport::Http => {
            table.insert("url", toml_edit::value(server.url.as_str()));
            if !server.headers.is_empty() {
                let key = if dialect == Dialect::Codex {
                    "http_headers"
                } else {
                    "headers"
                };
                table.insert(key, inline(&server.headers));
            }
        }
    }
    if dialect == Dialect::Grok && table.get("enabled").is_none() {
        table.insert("enabled", toml_edit::value(true));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_home() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("egant-mcp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn stdio() -> McpServer {
        McpServer {
            name: "resend".into(),
            transport: Transport::Stdio,
            command: "npx".into(),
            args: vec!["-y".into(), "resend-mcp".into()],
            env: BTreeMap::from([("RESEND_API_KEY".into(), "re_123".into())]),
            ..Default::default()
        }
    }

    fn http() -> McpServer {
        McpServer {
            name: "exa".into(),
            transport: Transport::Http,
            url: "https://mcp.exa.ai/mcp".into(),
            headers: BTreeMap::from([("x-api-key".into(), "k".into())]),
            ..Default::default()
        }
    }

    #[test]
    fn every_dialect_round_trips_both_transports() {
        let home = scratch_home();
        let all: Vec<String> = TARGETS.iter().map(|t| t.id.to_string()).collect();
        save_at(&home, &stdio(), &all, None).unwrap();
        save_at(&home, &http(), &all, None).unwrap();

        let lib = library_at(&home, |_| false).unwrap();
        for expected in [stdio(), http()] {
            let found = lib
                .servers
                .iter()
                .find(|s| s.server.name == expected.name)
                .unwrap();
            assert_eq!(found.server, expected);
            assert_eq!(found.agents.len(), TARGETS.len(), "{:?}", found.agents);
            assert!(!found.differs);
        }
        assert!(lib.targets.iter().all(|t| t.available && t.error.is_none()));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn edits_keep_the_rest_of_the_file() {
        let home = scratch_home();
        let codex = home.join(".codex/config.toml");
        std::fs::create_dir_all(codex.parent().unwrap()).unwrap();
        std::fs::write(
            &codex,
            "# my settings\nmodel = \"gpt-5\"\n\n[mcp_servers.resend]\ncommand = \"old\"\nstartup_timeout_sec = 30\n",
        )
        .unwrap();
        let claude = home.join(".claude.json");
        std::fs::write(&claude, r#"{"zeta":1,"alpha":{"b":2},"mcpServers":{"resend":{"type":"stdio","command":"old","timeout":5}}}"#).unwrap();

        save_at(&home, &stdio(), &["codex".into(), "claude".into()], None).unwrap();

        let toml = std::fs::read_to_string(&codex).unwrap();
        assert!(toml.starts_with("# my settings\nmodel = \"gpt-5\""));
        assert!(toml.contains("startup_timeout_sec = 30"));
        assert!(toml.contains("command = \"npx\""));
        let json = std::fs::read_to_string(&claude).unwrap();
        assert!(
            json.find("zeta").unwrap() < json.find("alpha").unwrap(),
            "key order kept"
        );
        assert!(json.contains("\"timeout\": 5"));
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn unticking_an_agent_and_renaming_remove_old_entries() {
        let home = scratch_home();
        save_at(&home, &stdio(), &["claude".into(), "cursor".into()], None).unwrap();
        let mut renamed = stdio();
        renamed.name = "resend-mail".into();
        save_at(&home, &renamed, &["claude".into()], Some("resend")).unwrap();

        let lib = library_at(&home, |_| false).unwrap();
        let names: Vec<_> = lib
            .servers
            .iter()
            .map(|s| (s.server.name.as_str(), s.agents.clone()))
            .collect();
        assert_eq!(names, vec![("resend-mail", vec!["claude"])]);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn jsonc_with_comments_is_read_but_never_rewritten() {
        let home = scratch_home();
        let path = home.join(".config/opencode/opencode.jsonc");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let original =
            "{\n  // mine\n  \"mcp\": {\"x\": {\"type\": \"local\", \"command\": [\"x\"],},},\n}\n";
        std::fs::write(&path, original).unwrap();

        let lib = library_at(&home, |_| false).unwrap();
        assert!(lib.servers.iter().any(|s| s.server.name == "x"));
        let opencode = lib.targets.iter().find(|t| t.id == "opencode").unwrap();
        assert!(opencode.error.is_some());
        // Saving skips it rather than failing the whole save; removing says so.
        save_at(&home, &stdio(), &["opencode".into(), "claude".into()], None).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        assert!(
            remove_from(
                &home,
                TARGETS.iter().find(|t| t.id == "opencode").unwrap(),
                "x"
            )
            .is_err()
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), original);
        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn rejects_bad_names_and_missing_fields() {
        assert!(
            normalize(McpServer {
                name: "a b".into(),
                command: "x".into(),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            normalize(McpServer {
                name: "a".into(),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            normalize(McpServer {
                name: "a".into(),
                transport: Transport::Http,
                url: "ftp://x".into(),
                ..Default::default()
            })
            .is_err()
        );
    }
}
