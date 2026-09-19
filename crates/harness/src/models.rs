//! Model catalogs: which models each agent can run.
//!
//! opencode reports its live catalog (`opencode models --verbose`: id,
//! display name, provider, reasoning variants). Codex discovers its live
//! catalog too, over `codex app-server`'s `model/list` — see
//! [`discover_codex_models`]. Claude serves a small curated list: its CLI has
//! no equivalent discovery call, so [`claude_models`] is what the picker and
//! Settings both show, exactly as zeron's own (currently static-only)
//! `claude/catalog.rs` does.

use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::agents::AgentId;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentModel {
    /// What the CLI takes: `provider/model` for opencode, a bare id or alias
    /// otherwise.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Provider id (`opencode`, `openai`, `anthropic`).
    pub provider: String,
    /// Display provider.
    pub provider_name: String,
    /// One-line blurb shown beside the name in the picker. Curated lists
    /// carry hand-written copy; the live opencode catalog synthesizes it
    /// from the provider name.
    pub description: String,
    /// Context window in tokens (e.g. 200000 → "200K" in the composer).
    /// Curated lists hardcode it; the live opencode catalog reads
    /// `limit.context`. Zero means unknown and hides the token badge.
    pub context: u64,
    /// The widest window this model can actually be asked for, which is what
    /// the picker shows and what a session gets unless something explicitly
    /// asks for less. For most agents it's the same as `context`; Claude's
    /// larger models take a million-token window through the `[1m]` suffix on
    /// their id, so theirs is higher than the window they default to.
    pub max_context: u64,
    /// Reasoning/effort variants the model advertises: opencode's live
    /// catalog per model, and a fixed curated list for Claude
    /// (`--effort`) and Codex (`-c model_reasoning_effort=`). Empty hides
    /// the reasoning picker.
    pub variants: Vec<String>,
    /// The effort this model runs at when nothing asks for one — Codex
    /// reports it per model (`defaultReasoningEffort`). Empty where the CLI
    /// doesn't say, which is everywhere else.
    pub default_variant: String,
    /// Whether this is the model the CLI itself would pick, so the picker's
    /// "Default" row can say which model that actually is and offer that
    /// model's efforts. Only Codex reports it (`isDefault` in `model/list`);
    /// Claude and opencode have no equivalent and leave it false.
    pub cli_default: bool,
}

/// How long a discovered catalog is reused before it's looked up again.
/// Discovery costs a CLI spawn each for Codex (`codex app-server`) and
/// opencode (`opencode models --verbose`), and catalogs change on the scale of
/// CLI releases, not seconds — so paying that on every picker open, every tab
/// switch and every Settings visit was buying nothing.
const CATALOG_TTL: Duration = Duration::from_secs(10 * 60);

fn catalog_cache() -> &'static Mutex<HashMap<AgentId, (Instant, Vec<AgentModel>)>> {
    static CACHE: OnceLock<Mutex<HashMap<AgentId, (Instant, Vec<AgentModel>)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The agent's catalog, from this process's cache when it's still fresh.
/// Only successful discoveries are cached: a failure (CLI missing, a wedged
/// spawn) must stay retryable, or one bad moment would freeze an empty list in
/// place for ten minutes.
pub fn list_models(agent: AgentId) -> Result<Vec<AgentModel>, String> {
    if let Some(models) = cached_models(agent) {
        log::debug!(
            "models {} cache hit ({} models)",
            agent.as_str(),
            models.len()
        );
        return Ok(models);
    }
    log::info!("models {} discovery start", agent.as_str());
    let models = discover_models(agent).map_err(|error| {
        log::warn!("models {} discovery failed: {error}", agent.as_str());
        error
    })?;
    log::info!(
        "models {} discovery found {} models",
        agent.as_str(),
        models.len()
    );
    if let Ok(mut cache) = catalog_cache().lock() {
        cache.insert(agent, (Instant::now(), models.clone()));
    }
    Ok(models)
}

/// Drops the cached catalog for one agent, so the next [`list_models`] pays
/// for a live look again — what a deliberate "refresh" means.
pub fn invalidate_models(agent: AgentId) {
    log::debug!("models {} cache invalidated", agent.as_str());
    if let Ok(mut cache) = catalog_cache().lock() {
        cache.remove(&agent);
    }
}

fn cached_models(agent: AgentId) -> Option<Vec<AgentModel>> {
    let cache = catalog_cache().lock().ok()?;
    let (at, models) = cache.get(&agent)?;
    if at.elapsed() > CATALOG_TTL {
        return None;
    }
    Some(models.clone())
}

fn discover_models(agent: AgentId) -> Result<Vec<AgentModel>, String> {
    match agent {
        AgentId::Opencode => opencode_models(),
        AgentId::Codex => Ok(codex_models_or_fallback()),
        AgentId::Claude => Ok(claude_models()),
        other => Err(format!(
            "{} doesn't expose a model list yet",
            other.descriptor().name
        )),
    }
}

/// Whether `model` is still something `agent` can be asked to run, judged
/// from compiled-in knowledge alone — never by spawning a CLI, because the
/// caller is the path that revives a saved session, where a catalog probe
/// would stall the first message behind a subprocess.
///
/// Only Claude can be answered honestly here: its catalog is the constant in
/// [`claude_models`]. Codex and opencode discover theirs from the CLI at
/// runtime, so any compiled-in list is a stale subset of what they really
/// accept, and answering "unknown" would drop models that work. They get a
/// flat `true`; a genuinely dead id there still fails the way it does today,
/// through the turn's own error and [`crate::AgentId`]-keyed bad-model
/// bookkeeping.
pub fn is_known_model(agent: AgentId, model: &str) -> bool {
    match agent {
        AgentId::Claude => {
            // `--model` also takes a bare family alias (always the newest of
            // that family) and an optional `[1m]` suffix asking for the
            // 1M-token window. Neither appears in the catalog; both are valid.
            const ALIASES: &[&str] = &["fable", "opus", "sonnet", "haiku"];
            let id = model.split('[').next().unwrap_or(model).trim();
            ALIASES.contains(&id) || claude_models().iter().any(|model| model.id == id)
        }
        _ => true,
    }
}

pub fn provider_name(provider: &str) -> String {
    match provider {
        "opencode" => "OpenCode Zen".to_string(),
        "anthropic" => "Anthropic".to_string(),
        "openai" => "OpenAI".to_string(),
        "openrouter" => "OpenRouter".to_string(),
        "google" => "Google".to_string(),
        "mistral" => "Mistral".to_string(),
        "deepseek" => "DeepSeek".to_string(),
        "xai" => "xAI".to_string(),
        "groq" => "Groq".to_string(),
        "azure" => "Azure".to_string(),
        "bedrock" => "Bedrock".to_string(),
        "vertex" => "Vertex".to_string(),
        other => {
            let mut name = String::with_capacity(other.len());
            for (i, word) in other.split(['-', '_']).enumerate() {
                if i > 0 {
                    name.push(' ');
                }
                let mut chars = word.chars();
                match chars.next() {
                    Some(first) => {
                        name.push(first.to_ascii_uppercase());
                        name.push_str(chars.as_str());
                    }
                    None => {}
                }
            }
            if name.is_empty() {
                other.to_string()
            } else {
                name
            }
        }
    }
}

/// `provider/model-id` → `Model Id`. Dots stay glued to their version
/// (`gpt-5.6-terra` → `GPT 5.6 Terra`). Fallback when the verbose catalog is
/// unreachable; the verbose `name` field wins whenever it parses.
fn prettify(model_id: &str) -> String {
    let mut name = String::with_capacity(model_id.len());
    for (i, word) in model_id.split(['-', '_']).enumerate() {
        if i > 0 {
            name.push(' ');
        }
        let mut chars = word.chars();
        match chars.next() {
            Some(first) => {
                if first.is_ascii_alphabetic() {
                    name.push(first.to_ascii_uppercase());
                    name.push_str(chars.as_str());
                } else {
                    name.push(first);
                    name.push_str(chars.as_str());
                }
            }
            None => {}
        }
    }
    name
}

/// Reasoning-effort levels the Codex CLI accepts via
/// `-c model_reasoning_effort=<level>`.
fn codex_variants() -> Vec<String> {
    ["minimal", "low", "medium", "high"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

/// Offline/failure fallback only — [`list_models`] tries [`discover_codex_models`]
/// first, since the signed-in account's own `model/list` is authoritative
/// (it already reflects that account's rollout and plan, which a static list
/// never can). Kept newest-first, matching zeron's `codex/catalog.rs`
/// fallback list verbatim: three of these nine (`gpt-5.6-sol`, `gpt-5.4`,
/// `gpt-5.4-mini`) came back `"not supported when using Codex with a ChatGPT
/// account"` when live-tested against this project's own ChatGPT-based
/// login, so they may not run on every account — that is exactly the
/// failure mode live discovery exists to avoid, by asking the account what
/// it can actually run instead of guessing from a fixed list.
fn codex_models() -> Vec<AgentModel> {
    const MODELS: &[(&str, &str)] = &[
        (
            "gpt-6-astra",
            "Our most capable model for complex, demanding work",
        ),
        ("gpt-5.6-sol", "Frontier reasoning flagship"),
        ("gpt-5.6-terra", "Deep multi-step agentic work"),
        ("gpt-5.6-luna", "Fast frontier model"),
        ("gpt-5.5", "Previous generation flagship"),
        ("gpt-5.4", "Reliable general coding"),
        ("gpt-5.4-mini", "Small, fast and capable"),
        ("gpt-5.3-codex-spark", "Ultra-fast lightweight coding"),
    ];
    MODELS
        .iter()
        .map(|(id, desc)| AgentModel {
            id: id.to_string(),
            name: prettify(id).replace("Gpt", "GPT"),
            provider: "openai".to_string(),
            provider_name: provider_name("openai"),
            description: desc.to_string(),
            context: 400_000,
            max_context: 400_000,
            variants: codex_variants(),
            default_variant: String::new(),
            cli_default: false,
        })
        .collect()
}

/// Bound on the whole `codex app-server` discovery round trip (spawn,
/// `initialize`, one or more `model/list` pages). zeron uses the same 10s.
const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(10);

/// Kills and reaps the app-server child on every exit path — including an
/// early `?` return from a timed-out or malformed response — so a failed
/// probe never leaves a `codex app-server` process behind.
struct KillOnDrop(std::process::Child);

impl Drop for KillOnDrop {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

/// The account's real, currently-runnable Codex models, straight from the
/// CLI's own `codex app-server` (JSON-RPC 2.0 over stdio: `initialize` then
/// paginated `model/list`) — ported from zeron's `codex/mod.rs::discover_models`,
/// adapted to this file's blocking-subprocess style instead of introducing
/// an async runtime for one short-lived probe. `model/list` "already applies
/// the signed-in account's rollout/visibility policy, so hidden or
/// unavailable models... never leak into a successful picker response"
/// (zeron's own words for why this beats a static list).
fn discover_codex_models(program: &PathBuf) -> Result<Vec<AgentModel>, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let mut child = Command::new(program)
        .arg("app-server")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| error.to_string())?;
    let stdin = child.stdin.take().ok_or("codex app-server has no stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("codex app-server has no stdout")?;
    let child = KillOnDrop(child);

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });

    let deadline = Instant::now() + DISCOVERY_TIMEOUT;
    let mut stdin = stdin;
    let mut next_id: i64 = 0;
    let mut send =
        |method: &str, params: serde_json::Value, wants_reply: bool| -> Result<i64, String> {
            let mut line =
                serde_json::json!({ "jsonrpc": "2.0", "method": method, "params": params });
            // A notification has no id at all — it isn't just an id nobody reads,
            // it must be absent from the wire, and it doesn't consume one either,
            // so replies to actual requests stay compactly numbered (1, 2, 3…).
            let id = if wants_reply {
                next_id += 1;
                line["id"] = serde_json::json!(next_id);
                next_id
            } else {
                0
            };
            writeln!(stdin, "{line}").map_err(|error| error.to_string())?;
            stdin.flush().map_err(|error| error.to_string())?;
            Ok(id)
        };
    let recv = |want_id: i64| -> Result<serde_json::Value, String> {
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("codex app-server timed out".to_string());
            }
            let line = rx
                .recv_timeout(remaining)
                .map_err(|_| "codex app-server exited before responding".to_string())?;
            let Ok(msg) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue; // non-JSON noise on stdout
            };
            if msg.get("method").is_some() {
                continue; // a notification or a server->client request; not our reply
            }
            if msg.get("id").and_then(serde_json::Value::as_i64) != Some(want_id) {
                continue;
            }
            if let Some(error) = msg.get("error") {
                let message = error
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("codex app-server rejected the request");
                return Err(message.to_string());
            }
            return Ok(msg
                .get("result")
                .cloned()
                .unwrap_or(serde_json::Value::Null));
        }
    };

    let init_id = send(
        "initialize",
        serde_json::json!({
            "clientInfo": { "name": "egant", "title": "egant", "version": env!("CARGO_PKG_VERSION") },
            "capabilities": { "experimentalApi": true },
        }),
        true,
    )?;
    recv(init_id)?;
    send("initialized", serde_json::Value::Null, false)?;

    let mut models = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut default_id: Option<String> = None;
    let mut cursor: Option<String> = None;
    loop {
        let mut params = serde_json::json!({ "limit": 20, "includeHidden": false });
        if let Some(cursor) = &cursor {
            params["cursor"] = serde_json::json!(cursor);
        }
        let list_id = send("model/list", params, true)?;
        let page = recv(list_id)?;
        let (page_models, next_cursor) = parse_codex_model_list_page(&page);
        for (candidate, is_default) in page_models {
            if seen_ids.insert(candidate.id.clone()) {
                if is_default && default_id.is_none() {
                    default_id = Some(candidate.id.clone());
                }
                models.push(candidate);
            }
        }
        match next_cursor.filter(|next| !next.is_empty() && Some(next) != cursor.as_ref()) {
            Some(next) => cursor = Some(next),
            None => break,
        }
    }
    drop(child); // done talking; SIGTERM/SIGKILL the app-server now, not at fn exit

    if let Some(default_id) = default_id
        && let Some(index) = models.iter().position(|model| model.id == default_id)
        && index != 0
    {
        let default_model = models.remove(index);
        models.insert(0, default_model);
    }
    Ok(models)
}

/// The context window for a discovered Codex model. `model/list` carries no
/// window of its own — checked against a live `codex app-server`, whose rows
/// are exactly id / model / displayName / description /
/// supportedReasoningEfforts / defaultReasoningEffort / inputModalities /
/// isDefault and friends, with nothing about limits anywhere — so the number
/// the picker shows has to come from compiled-in knowledge. That is the same
/// 400K the static fallback catalog asserts for this generation; an id from
/// outside it that still looks like one of these models is given the same
/// benefit, and anything else reports unknown rather than inventing a figure.
fn codex_context(id: &str) -> u64 {
    if codex_models().iter().any(|model| model.id == id) || id.starts_with("gpt-") {
        400_000
    } else {
        0
    }
}

/// Parses one `model/list` page: `(model, is_default)` pairs plus the
/// pagination cursor. Hidden models are dropped; an unparseable row is
/// skipped rather than failing the whole page, matching zeron's own
/// tolerance for whatever a future app-server version adds. The context
/// window is not part of this response at all, so it is filled in from
/// [`codex_context`] rather than left at the `0` that means "unknown".
fn parse_codex_model_list_page(
    result: &serde_json::Value,
) -> (Vec<(AgentModel, bool)>, Option<String>) {
    let mut models = Vec::new();
    for item in result
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
    {
        if item.get("hidden").and_then(serde_json::Value::as_bool) == Some(true) {
            continue;
        }
        let Some(id) = item
            .get("model")
            .and_then(serde_json::Value::as_str)
            .or_else(|| item.get("id").and_then(serde_json::Value::as_str))
            .map(str::trim)
            .filter(|id| !id.is_empty())
        else {
            continue;
        };
        let name = item
            .get("displayName")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|label| !label.is_empty())
            .unwrap_or(id)
            .to_string();
        let description = item
            .get("description")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|description| !description.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| provider_name("openai"));
        let variants: Vec<String> = item
            .get("supportedReasoningEfforts")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|effort| {
                effort
                    .get("reasoningEffort")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| effort.as_str())
            })
            .map(str::to_string)
            .collect();
        let default_variant = item
            .get("defaultReasoningEffort")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default()
            .to_string();
        let is_default = item.get("isDefault").and_then(serde_json::Value::as_bool) == Some(true);
        let context = codex_context(id);
        models.push((
            AgentModel {
                id: id.to_string(),
                name,
                provider: "openai".to_string(),
                provider_name: provider_name("openai"),
                description,
                context,
                max_context: context,
                variants,
                default_variant,
                cli_default: is_default,
            },
            is_default,
        ));
    }
    let next_cursor = result
        .get("nextCursor")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string);
    (models, next_cursor)
}

/// Live discovery when it works, the static catalog otherwise — mirrors
/// zeron's `CodexHarness::models`: an empty or errored probe (CLI too old
/// for `app-server`, offline, discovery timed out) falls back rather than
/// showing an empty picker or failing the whole command.
fn codex_models_or_fallback() -> Vec<AgentModel> {
    let desc = AgentId::Codex.descriptor();
    let Some(program) = crate::agents::resolve_executable(desc) else {
        return codex_models();
    };
    match discover_codex_models(&program) {
        Ok(models) if !models.is_empty() => models,
        Ok(_) => codex_models(),
        Err(error) => {
            log::debug!("codex model/list discovery failed; using fallback catalog: {error}");
            codex_models()
        }
    }
}

/// Effort levels the Claude Code CLI accepts via `--effort <level>`.
fn claude_variants() -> Vec<String> {
    ["low", "medium", "high", "xhigh", "max"]
        .iter()
        .map(|s| s.to_string())
        .collect()
}

fn claude_models() -> Vec<AgentModel> {
    // One row per family member — no alias dupes (the picker's Default row
    // already covers the CLI default). Generalised so the list never
    // overlaps itself with near-identical rows.
    //
    // Every id carries the `claude-` prefix on purpose: the CLI's `--model`
    // takes either a bare alias with no version (`sonnet`, `opus`, `fable` —
    // always the newest of that family) or the full name below. A bare,
    // version-suffixed id like the old `"sonnet-5"` here is neither, and the
    // CLI rejects it as `model_not_found` — confirmed by live-testing every
    // id in this list against an installed `claude` CLI (`claude --print
    // --model <id>`), and cross-checked against zeron's own
    // `claude/catalog.rs` static list, which uses this exact prefixed set.
    // Fable's two rows are genuine, CLI-recognized models that this
    // particular account's plan doesn't have usage credits for — a
    // different failure than a bad id, and not something either CLI can be
    // asked about ahead of time.
    //
    // The fourth column is the widest window the model actually runs with,
    // and it is measured, not assumed: each id was asked for its own usage
    // with `claude --print --output-format json --model '<id>[1m]' hi` on
    // 2026-09-17, and the reply's `modelUsage[...].contextWindow` is what is
    // recorded here. Opus 5, Opus 4.8, Opus 4.7 and Sonnet 5 all came back
    // with a literal 1000000. Haiku 4.5 came back `400 This authentication
    // style is incompatible with the long context beta header`, so it is the
    // one row held at the standard window. Fable's two rows can't be measured
    // from this account (they answer "requires usage credits" with or without
    // the suffix); they're listed at a million because every other non-Haiku
    // model here is, and a wrong guess degrades rather than fails — see
    // `deny_wide_context`.
    const MODELS: &[(&str, &str, &str, u64)] = &[
        (
            "claude-fable-5-1",
            "Fable 5.1",
            "Most intelligent model for building agents",
            1_000_000,
        ),
        (
            "claude-fable-5",
            "Fable 5",
            "Previous generation Fable",
            1_000_000,
        ),
        (
            "claude-opus-5",
            "Opus 5",
            "Powerful model for complex work",
            1_000_000,
        ),
        (
            "claude-opus-4-8",
            "Opus 4.8",
            "Previous generation Opus",
            1_000_000,
        ),
        (
            "claude-opus-4-7",
            "Opus 4.7",
            "Older generation Opus",
            1_000_000,
        ),
        (
            "claude-sonnet-5",
            "Sonnet 5",
            "Balanced speed and intelligence",
            1_000_000,
        ),
        (
            "claude-haiku-4-5",
            "Haiku 4.5",
            "Fastest model for everyday tasks",
            200_000,
        ),
    ];
    MODELS
        .iter()
        .map(|(id, name, desc, max_context)| AgentModel {
            id: id.to_string(),
            name: name.to_string(),
            provider: "anthropic".to_string(),
            provider_name: provider_name("anthropic"),
            description: desc.to_string(),
            context: 200_000,
            max_context: if wide_context_denied(id) {
                200_000
            } else {
                *max_context
            },
            variants: claude_variants(),
            default_variant: String::new(),
            cli_default: false,
        })
        .collect()
}

/// Models that asked for the million-token window and were refused, so the
/// rest of this run stops asking. Populated from the turn error the CLI
/// reports (see `sessions::looks_like_a_long_context_rejection`), which is the
/// only authority on what a given account and auth style may actually use —
/// a plan change or a different login makes the answer different, which is
/// why this lives for one run rather than on disk.
fn wide_context_denials() -> &'static Mutex<std::collections::HashSet<String>> {
    static DENIED: OnceLock<Mutex<std::collections::HashSet<String>>> = OnceLock::new();
    DENIED.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

fn wide_context_denied(model: &str) -> bool {
    wide_context_denials()
        .lock()
        .map(|denied| denied.contains(base_model_id(model)))
        .unwrap_or(false)
}

/// Records that this model may not be asked for the wider window again. Takes
/// the id as it was sent (`claude-haiku-4-5[1m]`) and remembers the bare one,
/// since that is what the catalog and the next session will carry.
pub fn deny_wide_context(model: &str) {
    if let Ok(mut denied) = wide_context_denials().lock() {
        denied.insert(base_model_id(model).to_string());
    }
    // The catalog's `max_context` is derived from this, so the copy the picker
    // is holding has to be looked up again.
    invalidate_models(AgentId::Claude);
}

/// `claude-opus-5[1m]` → `claude-opus-5`.
fn base_model_id(model: &str) -> &str {
    model.split('[').next().unwrap_or(model).trim()
}

/// The widest window `model` can be asked for, when that is wider than the
/// window it would otherwise run with — `None` when there is nothing to ask
/// for, which is every agent but Claude and Claude's own Haiku row. Reads the
/// curated list directly, so it never spawns anything: the caller is session
/// startup, where a CLI probe would stall the first message.
pub fn max_context(agent: AgentId, model: &str) -> Option<u64> {
    if agent != AgentId::Claude {
        return None;
    }
    let id = base_model_id(model);
    let row = claude_models().into_iter().find(|m| m.id == id)?;
    (row.max_context > row.context).then_some(row.max_context)
}

/// Bound on `opencode models --verbose`. The catalog is cached by the CLI, so
/// this is normally fast; the timeout only bites on a wedged refresh.
const MODELS_TIMEOUT: Duration = Duration::from_secs(30);

fn opencode_models() -> Result<Vec<AgentModel>, String> {
    let desc = AgentId::Opencode.descriptor();
    let program =
        crate::agents::resolve_executable(desc).ok_or_else(|| desc.install_hint.to_string())?;
    let output = run_with_timeout(&program, &["models", "--verbose"], MODELS_TIMEOUT)
        .ok_or_else(|| "listing opencode models timed out".to_string())?;
    if !output.status.success() {
        // The verbose catalog failed (older CLI?): fall back to plain ids.
        if let Some(plain) = run_with_timeout(&program, &["models"], MODELS_TIMEOUT) {
            if plain.status.success() {
                let models = parse_plain(&plain.stdout);
                if !models.is_empty() {
                    return Ok(models);
                }
            }
        }
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            "opencode models failed".to_string()
        } else {
            stderr
        });
    }
    let models = parse_verbose(&output.stdout);
    if models.is_empty() {
        return Err(
            "opencode advertised no models (`opencode auth login` to configure a provider)"
                .to_string(),
        );
    }
    Ok(models)
}

struct CommandOutput {
    status: std::process::ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn run_with_timeout(program: &PathBuf, args: &[&str], timeout: Duration) -> Option<CommandOutput> {
    use std::io::Read;

    let mut child = std::process::Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        let _ = stderr.read_to_end(&mut err);
        let _ = tx.send((out, err));
    });
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let (stdout, stderr) = rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default();
                return Some(CommandOutput {
                    status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) if start.elapsed() > timeout => {
                child.kill().ok();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => return None,
        }
    }
}

/// A header line names `provider/model`; anything else is JSON detail.
fn is_header(line: &str) -> bool {
    !line.is_empty() && !line.starts_with('{') && !line.contains(' ') && line.contains('/')
}

fn parse_verbose(out: &[u8]) -> Vec<AgentModel> {
    let text = String::from_utf8_lossy(out);
    let mut models = Vec::new();
    let mut header: Option<&str> = None;
    let mut detail = String::new();
    let flush = |header: Option<&str>, detail: &str, models: &mut Vec<AgentModel>| {
        if let Some(header) = header {
            models.push(model_from(header, detail));
        }
    };
    for line in text.lines() {
        if is_header(line) {
            flush(header.take(), &detail, &mut models);
            header = Some(line);
            detail.clear();
        } else {
            detail.push_str(line);
            detail.push('\n');
        }
    }
    flush(header, &detail, &mut models);
    models
}

fn model_from(header: &str, detail: &str) -> AgentModel {
    let (provider, id) = header.split_once('/').unwrap_or(("opencode", header));
    let json: Option<serde_json::Value> = serde_json::from_str(detail).ok();
    let name = json
        .as_ref()
        .and_then(|j| j.get("name"))
        .and_then(|n| n.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| prettify(id));
    let variants = json
        .as_ref()
        .and_then(|j| j.get("variants"))
        .and_then(|v| v.as_object())
        .map(|o| {
            let mut keys: Vec<String> = o.keys().cloned().collect();
            keys.sort();
            keys
        })
        .unwrap_or_default();
    let provider_display = provider_name(provider);
    // The verbose catalog carries no blurb — synthesize one from the provider
    // so the picker can still render `name + description` rows.
    let description = json
        .as_ref()
        .and_then(|j| j.get("description"))
        .and_then(|d| d.as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| provider_display.clone());
    let context = json
        .as_ref()
        .and_then(|j| j.get("limit"))
        .and_then(|l| l.get("context"))
        .and_then(|c| c.as_u64())
        .unwrap_or(0);
    AgentModel {
        id: header.to_string(),
        name,
        provider: provider.to_string(),
        provider_name: provider_display,
        description,
        context,
        // opencode reports one window per model and offers no way to ask for
        // a wider one, so the most it can do is the most it advertises.
        max_context: context,
        variants,
        default_variant: String::new(),
        cli_default: false,
    }
}

fn parse_plain(out: &[u8]) -> Vec<AgentModel> {
    String::from_utf8_lossy(out)
        .lines()
        .filter(|line| is_header(line))
        .map(|header| model_from(header, ""))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn verbose_catalog_parses_names_and_variants() {
        let out = b"opencode/big-pickle\n{\"id\":\"big-pickle\",\"name\":\"Big Pickle\",\"variants\":{}}\nopenai/gpt-x\n{\"id\":\"gpt-x\",\"name\":\"GPT X\",\"variants\":{\"high\":{},\"max\":{}}}\n";
        let models = parse_verbose(out);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "opencode/big-pickle");
        assert_eq!(models[0].name, "Big Pickle");
        assert_eq!(models[0].provider_name, "OpenCode Zen");
        assert!(models[0].variants.is_empty());
        assert_eq!(models[1].variants, vec!["high", "max"]);
    }

    #[test]
    fn unparseable_detail_falls_back_to_pretty_id() {
        let models = parse_verbose(b"acme/super-model-2.0\nnot json\n");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].name, "Super Model 2.0");
        assert_eq!(models[0].provider_name, "Acme");
    }

    #[test]
    fn curated_lists_are_non_empty() {
        assert!(!codex_models().is_empty());
        assert!(!claude_models().is_empty());
        assert!(codex_models().iter().any(|m| m.id == "gpt-5.6-terra"));
        assert!(claude_models().iter().any(|m| m.id == "claude-sonnet-5"));
        // No alias dupes — Default covers the CLI default.
        assert!(claude_models().iter().all(|m| m.id != "sonnet"));
        assert!(claude_models().iter().all(|m| m.id != "opus"));
        // Curated context windows are wired for the composer badge.
        assert!(claude_models().iter().all(|m| m.context == 200_000));
        assert!(codex_models().iter().all(|m| m.context == 400_000));
    }

    #[test]
    fn the_catalog_recognizes_its_own_ids_and_the_cli_aliases() {
        assert!(is_known_model(AgentId::Claude, "claude-sonnet-5"));
        assert!(is_known_model(AgentId::Claude, "claude-fable-5-1"));
        // Bare family aliases and the 1M-window suffix are valid `--model`
        // values that never appear in the catalog.
        assert!(is_known_model(AgentId::Claude, "sonnet"));
        assert!(is_known_model(AgentId::Claude, "opus"));
        assert!(is_known_model(AgentId::Claude, "claude-opus-5[1m]"));
    }

    #[test]
    fn the_ids_that_broke_saved_sessions_are_rejected() {
        // The exact pair found in persisted sessions: unprefixed ids the CLI
        // answers with `unrecognized_model`.
        assert!(!is_known_model(AgentId::Claude, "sonnet-5"));
        assert!(!is_known_model(AgentId::Claude, "fable-5.1"));
    }

    #[test]
    fn discovered_catalogs_are_never_second_guessed() {
        // Codex and opencode learn their catalogs from the CLI, so a
        // compiled-in list cannot prove an id wrong.
        assert!(is_known_model(AgentId::Codex, "gpt-5.6-terra"));
        assert!(is_known_model(
            AgentId::Codex,
            "some-model-shipped-tomorrow"
        ));
        assert!(is_known_model(AgentId::Opencode, "anything/at-all"));
    }

    #[test]
    fn every_claude_id_carries_the_prefix_the_cli_actually_requires() {
        // `claude --model <id>` only accepts a bare, unversioned alias
        // (`sonnet`, `opus`, `fable`) or the full `claude-`-prefixed name.
        // A bare, version-suffixed id (the bug this list used to have) is
        // neither, and the CLI rejects it as `model_not_found`.
        for model in claude_models() {
            assert!(
                model.id.starts_with("claude-"),
                "{} is missing the claude- prefix the CLI requires",
                model.id
            );
        }
    }

    #[test]
    fn codex_model_list_page_parses_and_filters_hidden_rows() {
        let page = serde_json::json!({
            "data": [
                { "model": "gpt-5.6-terra", "displayName": "GPT-5.6-Terra", "isDefault": true,
                  "supportedReasoningEfforts": [{"reasoningEffort": "high"}, {"reasoningEffort": "max"}] },
                { "model": "gpt-hidden", "hidden": true },
                { "id": "gpt-5.5", "displayName": "GPT-5.5" },
            ],
            "nextCursor": "page2",
        });
        let (models, cursor) = parse_codex_model_list_page(&page);
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].0.id, "gpt-5.6-terra");
        assert!(models[0].1, "gpt-5.6-terra should be flagged as default");
        assert_eq!(models[0].0.variants, vec!["high", "max"]);
        assert_eq!(models[1].0.id, "gpt-5.5");
        assert!(!models[1].1);
        assert_eq!(cursor.as_deref(), Some("page2"));
    }

    #[test]
    fn codex_model_list_page_without_a_cursor_ends_pagination() {
        let (_, cursor) = parse_codex_model_list_page(&serde_json::json!({ "data": [] }));
        assert_eq!(cursor, None);
    }

    // Runs the real spawn -> JSON-RPC handshake -> paginated model/list ->
    // default-reorder -> kill path against a fake `codex app-server`: no
    // network, no auth, matching the fake-CLI convention `codex.rs`'s own
    // `live` module uses for the turn-driving side. `discover_codex_models`
    // only ever sees `app-server` as argv[1] and canned stdin echoes back
    // nothing it depends on, so a fixed reply script is representative.
    #[cfg(unix)]
    mod live {
        use super::*;
        use std::os::unix::fs::PermissionsExt;

        #[test]
        fn discovery_paginates_and_promotes_the_default_model() {
            let dir = std::env::temp_dir()
                .join(format!("egant-codex-models-live-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fake-codex");
            // Two `model/list` pages (ids 2 then 3 — id 1 is `initialize`;
            // `initialized` is a notification and consumes no id): page one
            // has gpt-5.6-terra and a cursor, page two has gpt-5.5 flagged
            // default with no cursor, ending pagination.
            // The fake answers each request only after reading it, then holds
            // the pipe open until killed: dumping every reply up front and
            // exiting lets the client's later stdin writes race the dead
            // pipe (flaky "Broken pipe (os error 32)").
            std::fs::write(
                &script,
                r#"#!/bin/sh
read -r _ # initialize
printf '%s\n' '{"jsonrpc":"2.0","id":1,"result":{}}'
read -r _ # initialized notification
read -r _ # model/list (page one)
printf '%s\n' '{"jsonrpc":"2.0","id":2,"result":{"data":[{"model":"gpt-5.6-terra","displayName":"GPT-5.6-Terra","supportedReasoningEfforts":[{"reasoningEffort":"high"}]}],"nextCursor":"page2"}}'
read -r _ # model/list (page two)
printf '%s\n' '{"jsonrpc":"2.0","id":3,"result":{"data":[{"model":"gpt-5.5","displayName":"GPT-5.5","isDefault":true}]}}'
sleep 30
"#,
            )
            .unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

            let models = discover_codex_models(&script).expect("discovery succeeds");
            assert_eq!(models.len(), 2);
            // gpt-5.5 arrived second but is the flagged default, so it is
            // promoted to the front — matching zeron's own reorder.
            assert_eq!(models[0].id, "gpt-5.5");
            assert_eq!(models[1].id, "gpt-5.6-terra");
            assert_eq!(models[1].variants, vec!["high"]);

            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        fn a_cli_too_old_for_app_server_falls_back_cleanly() {
            let dir = std::env::temp_dir()
                .join(format!("egant-codex-models-noapp-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            let script = dir.join("fake-codex-old");
            // Exits immediately with nothing on stdout, as an older CLI
            // would for an `app-server` subcommand it doesn't recognize.
            std::fs::write(&script, "#!/bin/sh\nexit 1\n").unwrap();
            std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

            let error = discover_codex_models(&script).unwrap_err();
            assert!(!error.is_empty());

            let _ = std::fs::remove_dir_all(&dir);
        }

        #[test]
        #[ignore = "hits the real, installed codex CLI — run by hand with -- --ignored"]
        fn discovery_against_the_real_installed_cli() {
            let Some(program) =
                crate::agents::resolve_executable(crate::agents::AgentId::Codex.descriptor())
            else {
                panic!("codex is not installed on this machine");
            };
            let models = discover_codex_models(&program).expect("real discovery succeeds");
            assert!(
                !models.is_empty(),
                "the signed-in account has no visible models"
            );
            for model in &models {
                eprintln!("{}: {} ({:?})", model.id, model.name, model.variants);
            }
        }
    }

    #[test]
    fn verbose_catalog_parses_context_limit() {
        let out = b"opencode/big-pickle\n{\"id\":\"big-pickle\",\"name\":\"Big Pickle\",\"limit\":{\"context\":200000},\"variants\":{}}\n";
        let models = parse_verbose(out);
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].context, 200_000);
    }

    #[test]
    fn unknown_agents_have_no_list() {
        assert!(list_models(AgentId::Cursor).is_err());
    }
}
