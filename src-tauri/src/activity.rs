//! How many tokens you have moved through each agent, and on which days — the
//! numbers behind the launch screen's activity panel.
//!
//! Egant's own sessions only keep one running total each (no dates, no model),
//! and say nothing about the work done in a plain terminal. The CLIs themselves
//! log every message with its model, time and usage, so this reads those logs
//! instead: Claude Code's `~/.claude/projects/**.jsonl`, Codex's
//! `~/.codex/sessions/**.jsonl` and OpenCode's `opencode.db`. Everything is
//! read-only.
//!
//! Claude's logs are about a gigabyte, so each file's records are kept in
//! `activity-cache.json` beside the saved sessions, keyed by the file's size
//! and modification time; a launch only re-reads the files that changed.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;

use crate::persist::write_atomic;
use crate::settings::config_dir;

/// One message's worth of tokens. `i` is fresh input, `o` output (reasoning
/// included), `c` everything served from or written to a cache — which, for a
/// long agent session, is nearly all of it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
struct Rec {
    /// Seconds since the epoch.
    t: i64,
    /// What identifies this message across files, or empty when nothing does.
    /// A resumed Claude session copies its history into a new file.
    k: String,
    m: String,
    i: u64,
    o: u64,
    c: u64,
}

impl Rec {
    fn total(&self) -> u64 {
        self.i.saturating_add(self.o).saturating_add(self.c)
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CachedFile {
    mtime: u64,
    size: u64,
    recs: Vec<Rec>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct CacheFile {
    files: HashMap<String, CachedFile>,
}

// ---------------------------------------------------------------------------
// What the window gets
// ---------------------------------------------------------------------------

/// What one model spent on one day. The window sums these itself, so any
/// range it offers (a week, a month, all of it) is a filter over the same list.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelDay {
    /// `claude`, `codex` or `opencode` — the ids the rest of the app uses.
    pub agent: String,
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache: u64,
}

impl ModelDay {
    fn total(&self) -> u64 {
        self.input
            .saturating_add(self.output)
            .saturating_add(self.cache)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayActivity {
    /// `YYYY-MM-DD`, in the viewer's time zone.
    pub date: String,
    /// Busiest first.
    pub models: Vec<ModelDay>,
}

/// Rolling 5-hour, weekly (7-day), and all-time token usage for one model.
#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelUsageStat {
    pub agent: String,
    pub model: String,
    pub five_hour_tokens: u64,
    pub five_hour_input: u64,
    pub five_hour_output: u64,
    pub five_hour_cache: u64,
    pub five_hour_turns: u64,
    pub weekly_tokens: u64,
    pub weekly_input: u64,
    pub weekly_output: u64,
    pub weekly_cache: u64,
    pub weekly_turns: u64,
    pub all_time_tokens: u64,
    pub all_time_input: u64,
    pub all_time_output: u64,
    pub all_time_cache: u64,
    pub all_time_turns: u64,
    pub last_used_at: Option<i64>,
    pub five_hour_resets_at: Option<i64>,
    pub five_hour_earliest_at: Option<i64>,
    pub one_hour_tokens: u64,
    pub one_hour_turns: u64,
    pub one_hour_resets_at: Option<i64>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    /// Oldest first; days with nothing in them are left out.
    pub days: Vec<DayActivity>,
    /// Usage totals per model across rolling 5-hour and 7-day windows.
    pub model_stats: Vec<ModelUsageStat>,
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/// Days since 1970-01-01 of a civil date (Hinnant's algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `2026-08-16T14:06:09.736Z` as epoch seconds. The CLIs all log UTC.
fn parse_iso(text: &str) -> Option<i64> {
    let b = text.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let days = days_from_civil(num(0, 4)?, num(5, 7)?, num(8, 10)?);
    Some(days * 86_400 + num(11, 13)? * 3600 + num(14, 16)? * 60 + num(17, 19)?)
}

// ---------------------------------------------------------------------------
// Reading the logs
// ---------------------------------------------------------------------------

fn for_each_line(path: &Path, mut each: impl FnMut(&str)) {
    let Ok(file) = File::open(path) else { return };
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if let Ok(line) = std::str::from_utf8(&buf) {
                    each(line);
                }
            }
        }
    }
}

fn collect_jsonl(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        match entry.file_type() {
            Ok(kind) if kind.is_dir() => collect_jsonl(&path, out),
            Ok(kind) if kind.is_file() && path.extension().is_some_and(|e| e == "jsonl") => {
                out.push(path)
            }
            _ => {}
        }
    }
}

#[derive(Deserialize)]
struct ClaudeLine {
    timestamp: Option<String>,
    message: Option<ClaudeMessage>,
}

#[derive(Deserialize)]
struct ClaudeMessage {
    id: Option<String>,
    model: Option<String>,
    usage: Option<ClaudeUsage>,
}

#[derive(Deserialize, Default)]
struct ClaudeUsage {
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_creation_input_tokens: Option<u64>,
    cache_read_input_tokens: Option<u64>,
}

/// A streamed Claude message is logged once per content block, all carrying
/// the same id and usage; the last line holds the final output count.
fn parse_claude(path: &Path) -> Vec<Rec> {
    let mut by_id: HashMap<String, Rec> = HashMap::new();
    let mut loose = Vec::new();
    for_each_line(path, |line| {
        if !line.contains("\"usage\"") {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<ClaudeLine>(line) else {
            return;
        };
        let (Some(message), Some(stamp)) = (parsed.message, parsed.timestamp) else {
            return;
        };
        let (Some(usage), Some(model), Some(t)) = (message.usage, message.model, parse_iso(&stamp))
        else {
            return;
        };
        if model.starts_with('<') {
            // `<synthetic>`: Claude Code's own local replies, never billed.
            return;
        }
        let rec = Rec {
            t,
            k: message.id.clone().unwrap_or_default(),
            m: model,
            i: usage.input_tokens.unwrap_or(0),
            o: usage.output_tokens.unwrap_or(0),
            c: usage
                .cache_creation_input_tokens
                .unwrap_or(0)
                .saturating_add(usage.cache_read_input_tokens.unwrap_or(0)),
        };
        if rec.total() == 0 {
            return;
        }
        match message.id {
            Some(id) => {
                let keep = by_id.get(&id).is_none_or(|old| rec.total() >= old.total());
                if keep {
                    by_id.insert(id, rec);
                }
            }
            None => loose.push(rec),
        }
    });
    let mut recs: Vec<Rec> = by_id.into_values().collect();
    recs.extend(loose);
    recs
}

#[derive(Deserialize)]
struct CodexLine {
    timestamp: Option<String>,
    payload: Option<CodexPayload>,
}

#[derive(Deserialize)]
struct CodexPayload {
    #[serde(rename = "type")]
    kind: Option<String>,
    model: Option<String>,
    info: Option<CodexInfo>,
}

#[derive(Deserialize)]
struct CodexInfo {
    total_token_usage: Option<CodexTotals>,
}

#[derive(Deserialize)]
struct CodexTotals {
    input_tokens: Option<u64>,
    cached_input_tokens: Option<u64>,
    output_tokens: Option<u64>,
}

/// Codex logs the thread's running total after each API call, so the spend of
/// a call is the step up from the one before. OpenAI counts cached tokens
/// inside `input_tokens`, so they are taken back out of it here.
fn parse_codex(path: &Path) -> Vec<Rec> {
    let mut recs = Vec::new();
    let mut model = String::from("codex");
    let (mut prev_i, mut prev_o, mut prev_c) = (0u64, 0u64, 0u64);
    for_each_line(path, |line| {
        let is_context = line.contains("\"turn_context\"");
        if !is_context && !line.contains("\"token_count\"") {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<CodexLine>(line) else {
            return;
        };
        let Some(payload) = parsed.payload else {
            return;
        };
        if is_context {
            if let Some(name) = payload.model.filter(|name| !name.is_empty()) {
                model = name;
            }
            return;
        }
        if payload.kind.as_deref() != Some("token_count") {
            return;
        }
        let Some(totals) = payload.info.and_then(|info| info.total_token_usage) else {
            return;
        };
        let cached = totals.cached_input_tokens.unwrap_or(0);
        let cur_i = totals.input_tokens.unwrap_or(0).saturating_sub(cached);
        let cur_o = totals.output_tokens.unwrap_or(0);
        let cur_c = cached;
        // A total that went down means the count restarted.
        let restarted = cur_i + cur_o + cur_c < prev_i + prev_o + prev_c;
        if restarted {
            (prev_i, prev_o, prev_c) = (0, 0, 0);
        }
        let rec = Rec {
            t: parsed.timestamp.as_deref().and_then(parse_iso).unwrap_or(0),
            k: String::new(),
            m: model.clone(),
            i: cur_i.saturating_sub(prev_i),
            o: cur_o.saturating_sub(prev_o),
            c: cur_c.saturating_sub(prev_c),
        };
        (prev_i, prev_o, prev_c) = (cur_i, cur_o, cur_c);
        if rec.total() > 0 && rec.t > 0 {
            recs.push(rec);
        }
    });
    recs
}

fn opencode_db() -> Option<PathBuf> {
    let base = match std::env::var_os("XDG_DATA_HOME").map(PathBuf::from) {
        Some(xdg) if xdg.is_absolute() => xdg,
        _ => {
            #[cfg(target_os = "windows")]
            {
                dirs::data_local_dir().or_else(dirs::home_dir)?
            }
            #[cfg(not(target_os = "windows"))]
            {
                dirs::home_dir()?.join(".local/share")
            }
        }
    };
    let db = base.join("opencode/opencode.db");
    if db.is_file() {
        return Some(db);
    }
    if let Some(home) = dirs::home_dir() {
        let alt = home.join(".local/share/opencode/opencode.db");
        if alt.is_file() {
            return Some(alt);
        }
    }
    None
}

/// OpenCode keeps its history in SQLite, one JSON document per message. The
/// `sqlite3` that ships with macOS and most Linux installs reads it, which
/// saves linking a database engine for one query.
fn read_opencode() -> Vec<Rec> {
    let Some(db) = opencode_db() else {
        return Vec::new();
    };
    const QUERY: &str = "select time_created / 1000, \
        coalesce(json_extract(data, '$.modelID'), ''), \
        coalesce(json_extract(data, '$.tokens.input'), 0), \
        coalesce(json_extract(data, '$.tokens.output'), 0) \
          + coalesce(json_extract(data, '$.tokens.reasoning'), 0), \
        coalesce(json_extract(data, '$.tokens.cache.read'), 0) \
          + coalesce(json_extract(data, '$.tokens.cache.write'), 0) \
        from message \
        where json_extract(data, '$.role') = 'assistant' \
          and json_extract(data, '$.tokens') is not null";
    let mut cmd = std::process::Command::new("sqlite3");
    cmd.args(["-readonly", "-cmd", ".timeout 3000", "-separator", "\t"])
        .arg(&db)
        .arg(QUERY);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let output = cmd.output().ok().filter(|o| o.status.success());
    let stdout = match output {
        Some(o) => String::from_utf8_lossy(&o.stdout).into_owned(),
        None => {
            #[cfg(windows)]
            {
                // Windows doesn't bundle sqlite3.exe. Fallback to Python's built-in sqlite3 if available.
                let py_script = "import sqlite3, sys\nconn = sqlite3.connect(sys.argv[1])\nfor row in conn.execute(sys.argv[2]):\n    print('\\t'.join('' if v is None else str(v) for v in row))\n";
                let mut py = std::process::Command::new("python");
                py.args(["-c", py_script]).arg(&db).arg(QUERY);
                use std::os::windows::process::CommandExt;
                py.creation_flags(0x08000000);
                if let Ok(py_out) = py.output() {
                    if py_out.status.success() {
                        String::from_utf8_lossy(&py_out.stdout).into_owned()
                    } else {
                        return Vec::new();
                    }
                } else {
                    log::debug!("activity: neither sqlite3 nor python found, skipping OpenCode");
                    return Vec::new();
                }
            }
            #[cfg(not(windows))]
            {
                log::debug!("activity: no sqlite3, skipping OpenCode");
                return Vec::new();
            }
        }
    };
    stdout
        .lines()
        .filter_map(|row| {
            let mut cells = row.split('\t');
            let t = cells.next()?.parse::<i64>().ok()?;
            let m = cells.next()?.to_string();
            let mut count = || cells.next()?.parse::<f64>().ok().map(|n| n.max(0.0) as u64);
            let rec = Rec {
                t,
                k: String::new(),
                m,
                i: count()?,
                o: count()?,
                c: count()?,
            };
            (rec.total() > 0 && rec.t > 0).then_some(rec)
        })
        .collect()
}

pub fn fetch_opencode_usage() -> Result<crate::dto::OpencodeUsageDto, String> {
    let installed = egant_harness::agents::resolve_executable(
        egant_harness::agents::AgentId::Opencode.descriptor(),
    )
    .is_some();

    let auth_file = dirs::home_dir().map(|h| h.join(".local/share/opencode/auth.json"));
    let has_auth = auth_file.as_ref().map(|f| f.is_file()).unwrap_or(false) && {
        if let Some(f) = &auth_file {
            std::fs::read_to_string(f)
                .ok()
                .and_then(|content| serde_json::from_str::<serde_json::Value>(&content).ok())
                .map(|val| {
                    if let Some(obj) = val.as_object() {
                        !obj.is_empty()
                    } else if let Some(arr) = val.as_array() {
                        !arr.is_empty()
                    } else {
                        false
                    }
                })
                .unwrap_or(false)
        } else {
            false
        }
    };
    let is_free_tier = !has_auth;

    // Check if free limit was reached in log recently
    let mut free_limit_reached = false;
    if let Some(home) = dirs::home_dir() {
        let log_file = home.join(".local/share/opencode/log/opencode.log");
        if let Ok(metadata) = std::fs::metadata(&log_file) {
            let mtime_recent = metadata
                .modified()
                .ok()
                .and_then(|t| t.elapsed().ok())
                .map(|d| d.as_secs() < 86_400)
                .unwrap_or(false);
            if mtime_recent {
                if let Ok(mut file) = std::fs::File::open(&log_file) {
                    use std::io::{Read, Seek, SeekFrom};
                    let file_size = metadata.len();
                    let read_len = file_size.min(65536);
                    if file.seek(SeekFrom::End(-(read_len as i64))).is_ok() {
                        let mut buf = vec![0u8; read_len as usize];
                        if file.read_exact(&mut buf).is_ok() {
                            let text = String::from_utf8_lossy(&buf);
                            if text.contains("Free usage limit reached") {
                                free_limit_reached = true;
                            }
                        }
                    }
                }
            }
        }
    }

    let Some(db) = opencode_db() else {
        return Ok(crate::dto::OpencodeUsageDto {
            installed,
            has_auth,
            is_free_tier,
            free_limit_reached,
            ..Default::default()
        });
    };

    const QUERY: &str = "select \
      (select count(*) from session), \
      (select count(*) from message), \
      coalesce(sum(tokens_input), 0), \
      coalesce(sum(tokens_output), 0) + coalesce(sum(tokens_reasoning), 0), \
      coalesce(sum(tokens_cache_read), 0), \
      coalesce(sum(tokens_cache_write), 0), \
      coalesce(sum(cost), 0.0), \
      coalesce(cast((max(time_created) - min(time_created)) / 86400000 + 1 as integer), 0), \
      max(time_updated) / 1000 \
    from session; \
    select json_extract(data, '$.tool'), count(*) as c \
    from part \
    where json_extract(data, '$.type') = 'tool' \
    group by json_extract(data, '$.tool') \
    order by c desc \
    limit 10;";

    let mut cmd = std::process::Command::new("sqlite3");
    cmd.args(["-readonly", "-cmd", ".timeout 3000", "-separator", "\t"])
        .arg(&db)
        .arg(QUERY);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Ok(crate::dto::OpencodeUsageDto {
            installed,
            has_auth,
            is_free_tier,
            free_limit_reached,
            ..Default::default()
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut lines = stdout.lines();

    let mut total_sessions = 0;
    let mut total_messages = 0;
    let mut tokens_input = 0;
    let mut tokens_output = 0;
    let mut tokens_cache_read = 0;
    let mut tokens_cache_write = 0;
    let mut total_cost = 0.0;
    let mut days_span = 0;
    let mut last_active_epoch = None;

    if let Some(first_line) = lines.next() {
        let parts: Vec<&str> = first_line.split('\t').collect();
        if parts.len() >= 8 {
            total_sessions = parts[0].parse().unwrap_or(0);
            total_messages = parts[1].parse().unwrap_or(0);
            tokens_input = parts[2].parse().unwrap_or(0);
            tokens_output = parts[3].parse().unwrap_or(0);
            tokens_cache_read = parts[4].parse().unwrap_or(0);
            tokens_cache_write = parts[5].parse().unwrap_or(0);
            total_cost = parts[6].parse().unwrap_or(0.0);
            days_span = parts[7].parse().unwrap_or(0);
            if parts.len() >= 9 {
                last_active_epoch = parts[8].parse().ok();
            }
        }
    }

    let total_tokens = tokens_input + tokens_output + tokens_cache_read + tokens_cache_write;

    let mut raw_tools: Vec<(String, u64)> = Vec::new();
    let mut tool_sum = 0u64;
    for line in lines {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() >= 2 {
            let name = parts[0].trim().to_string();
            let count: u64 = parts[1].parse().unwrap_or(0);
            if !name.is_empty() && count > 0 {
                tool_sum += count;
                raw_tools.push((name, count));
            }
        }
    }

    let top_tools: Vec<crate::dto::OpencodeToolUsageDto> = raw_tools
        .into_iter()
        .map(|(name, count)| {
            let percentage = if tool_sum > 0 {
                (count as f64 / tool_sum as f64) * 100.0
            } else {
                0.0
            };
            crate::dto::OpencodeToolUsageDto {
                name,
                count,
                percentage,
            }
        })
        .collect();

    Ok(crate::dto::OpencodeUsageDto {
        installed,
        has_auth,
        is_free_tier,
        free_limit_reached,
        total_sessions,
        total_messages,
        days_span,
        total_cost,
        tokens_input,
        tokens_output,
        tokens_cache_read,
        tokens_cache_write,
        total_tokens,
        top_tools,
        last_active_epoch,
    })
}

#[derive(Deserialize)]
struct AntigravityLine {
    step_index: Option<u64>,
    created_at: Option<String>,
    input_tokens: Option<u64>,
    output_tokens: Option<u64>,
    cache_read_tokens: Option<u64>,
}

fn is_valid_antigravity_model(candidate: &str) -> bool {
    if candidate.is_empty() || candidate.len() > 40 {
        return false;
    }
    if !candidate
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '.')
    {
        return false;
    }
    candidate.to_ascii_lowercase().starts_with("gemini")
}

fn parse_antigravity(path: &Path) -> Vec<Rec> {
    if path.file_name().and_then(|n| n.to_str()) != Some("transcript.jsonl") {
        return Vec::new();
    }
    let mut recs = Vec::new();
    let mut model = String::from("gemini-3.8-flash");
    for_each_line(path, |line| {
        if line.contains("<USER_SETTINGS_CHANGE>") && line.contains("Model Selection") {
            let candidate = if let Some(pos) = line.find("from None to ") {
                let rest = &line[pos + 13..];
                let end = rest
                    .find('(')
                    .or_else(|| rest.find('.'))
                    .or_else(|| rest.find('\\'))
                    .or_else(|| rest.find('"'))
                    .unwrap_or(rest.len());
                Some(rest[..end].trim())
            } else if let Some(pos) = line.find("setting `Model Selection` to `") {
                let rest = &line[pos + 30..];
                let end = rest.find('`').unwrap_or(rest.len());
                Some(rest[..end].trim())
            } else if let Some(pos) = line.find("setting `Model Selection` to ") {
                let rest = &line[pos + 29..];
                let end = rest
                    .find('(')
                    .or_else(|| rest.find('.'))
                    .or_else(|| rest.find('\\'))
                    .or_else(|| rest.find('"'))
                    .unwrap_or(rest.len());
                Some(rest[..end].trim())
            } else {
                None
            };

            if let Some(cand) = candidate
                && is_valid_antigravity_model(cand)
            {
                model = cand.to_ascii_lowercase().replace(' ', "-");
            }
        }
        if !line.contains("\"input_tokens\"") {
            return;
        }
        let Ok(parsed) = serde_json::from_str::<AntigravityLine>(line) else {
            return;
        };
        let Some(t) = parsed.created_at.as_deref().and_then(parse_iso) else {
            return;
        };
        let i = parsed.input_tokens.unwrap_or(0);
        let o = parsed.output_tokens.unwrap_or(0);
        let c = parsed.cache_read_tokens.unwrap_or(0);
        let rec = Rec {
            t,
            k: parsed
                .step_index
                .map(|idx| idx.to_string())
                .unwrap_or_default(),
            m: model.clone(),
            i,
            o,
            c,
        };
        if rec.total() > 0 && rec.t > 0 {
            recs.push(rec);
        }
    });
    recs
}

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

fn cache_path() -> Option<PathBuf> {
    Some(config_dir()?.join("activity-cache.json"))
}

fn home_dir(var: &str, fallback: &str) -> Option<PathBuf> {
    match std::env::var_os(var).map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Some(dir),
        _ => Some(dirs::home_dir()?.join(fallback)),
    }
}

/// Every record from `files`, re-reading only those whose size or
/// modification time differs from what `cache` remembers.
fn read_files(
    files: Vec<PathBuf>,
    parse: fn(&Path) -> Vec<Rec>,
    cache: &mut CacheFile,
    seen: &mut Vec<String>,
    dirty: &mut bool,
) -> Vec<Rec> {
    let mut all = Vec::new();
    for path in files {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        let mtime = meta
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map_or(0, |since| since.as_millis() as u64);
        let key = path.to_string_lossy().into_owned();
        seen.push(key.clone());
        match cache.files.get(&key) {
            Some(hit) if hit.mtime == mtime && hit.size == meta.len() => {
                all.extend(hit.recs.iter().cloned());
            }
            _ => {
                *dirty = true;
                let recs = parse(&path);
                all.extend(recs.iter().cloned());
                cache.files.insert(
                    key,
                    CachedFile {
                        mtime,
                        size: meta.len(),
                        recs,
                    },
                );
            }
        }
    }
    all
}

static SCAN: Mutex<()> = Mutex::new(());

fn scan(tz_offset_minutes: i32) -> ActivityDto {
    // One scan at a time: a second window asking while the first is still
    // reading a gigabyte would only do the same work twice.
    let _scan = SCAN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    let path = cache_path();
    let mut cache: CacheFile = path
        .as_ref()
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let mut seen = Vec::new();
    let mut dirty = false;

    let mut claude_files = Vec::new();
    if let Some(dir) = home_dir("CLAUDE_CONFIG_DIR", ".claude") {
        collect_jsonl(&dir.join("projects"), &mut claude_files);
    }
    let mut codex_files = Vec::new();
    if let Some(dir) = home_dir("CODEX_HOME", ".codex") {
        collect_jsonl(&dir.join("sessions"), &mut codex_files);
        collect_jsonl(&dir.join("archived_sessions"), &mut codex_files);
    }
    let mut antigravity_files = Vec::new();
    if let Some(home) = dirs::home_dir() {
        let brain = home.join(".gemini/antigravity-cli/brain");
        if brain.is_dir() {
            collect_jsonl(&brain, &mut antigravity_files);
        }
    }

    let claude = read_files(
        claude_files,
        parse_claude,
        &mut cache,
        &mut seen,
        &mut dirty,
    );
    let codex = read_files(codex_files, parse_codex, &mut cache, &mut seen, &mut dirty);
    let antigravity = read_files(
        antigravity_files,
        parse_antigravity,
        &mut cache,
        &mut seen,
        &mut dirty,
    );
    let opencode = read_opencode();

    // Forget files that are gone, and write the cache back only if it moved.
    let seen: std::collections::HashSet<_> = seen.into_iter().collect();
    let remembered = cache.files.len();
    cache.files.retain(|key, _| seen.contains(key));
    if (dirty || cache.files.len() != remembered)
        && let Some(path) = path
        && let Ok(text) = serde_json::to_string(&cache)
        && let Err(error) = write_atomic(&path, &text)
    {
        log::warn!("activity: could not save {}: {error}", path.display());
    }

    aggregate(
        vec![
            ("claude", claude),
            ("codex", codex),
            ("antigravity", antigravity),
            ("opencode", opencode),
        ],
        tz_offset_minutes,
    )
}

/// Folds records into the figures the panel draws. `tz_offset_minutes` is
/// JavaScript's `getTimezoneOffset()` (UTC minus local), so a message sent at
/// 23:30 local lands on the day the viewer lived it, not on UTC's.
fn aggregate(sources: Vec<(&str, Vec<Rec>)>, tz_offset_minutes: i32) -> ActivityDto {
    type Key<'a> = (i64, &'a str, &'a str);
    let mut spent: HashMap<Key<'_>, [u64; 3]> = HashMap::new();

    let now = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let one_hour_ago = now.saturating_sub(3600);
    let five_hours_ago = now.saturating_sub(5 * 3600);
    let seven_days_ago = now.saturating_sub(7 * 86_400);

    let mut stats_map: HashMap<(String, String), ModelUsageStat> = HashMap::new();

    for (agent, recs) in &sources {
        // The same message in two files (a resumed session) counts once.
        let mut unique: HashMap<&str, &Rec> = HashMap::new();
        let mut kept: Vec<&Rec> = Vec::new();
        for rec in recs {
            if rec.k.is_empty() {
                kept.push(rec);
            } else {
                let slot = unique.entry(rec.k.as_str()).or_insert(rec);
                if rec.total() > slot.total() {
                    *slot = rec;
                }
            }
        }
        kept.extend(unique.into_values());

        for rec in kept {
            let raw_model = if rec.m.is_empty() { "unknown" } else { &rec.m };
            let is_malformed = raw_model.len() > 50
                || raw_model.contains('\n')
                || raw_model.contains('\r')
                || raw_model.contains('{')
                || raw_model.contains('}')
                || raw_model.contains(';')
                || raw_model.contains('&')
                || raw_model.contains('=');
            let model: &str = if is_malformed {
                if *agent == "antigravity" {
                    "gemini-3.8-flash"
                } else {
                    "unknown"
                }
            } else {
                raw_model
            };
            let local = rec.t - i64::from(tz_offset_minutes) * 60;
            let slot = spent
                .entry((local.div_euclid(86_400), agent, model))
                .or_default();
            slot[0] = slot[0].saturating_add(rec.i);
            slot[1] = slot[1].saturating_add(rec.o);
            slot[2] = slot[2].saturating_add(rec.c);

            let key = (agent.to_string(), model.to_string());
            let stat = stats_map.entry(key).or_insert_with(|| ModelUsageStat {
                agent: agent.to_string(),
                model: model.to_string(),
                ..Default::default()
            });

            let total = rec.total();
            if rec.t >= one_hour_ago && rec.t <= now + 3600 {
                stat.one_hour_tokens = stat.one_hour_tokens.saturating_add(total);
                stat.one_hour_turns = stat.one_hour_turns.saturating_add(1);
                stat.one_hour_resets_at = Some(
                    stat.one_hour_resets_at
                        .unwrap_or(0)
                        .max(rec.t.saturating_add(3600)),
                );
            }
            if rec.t >= five_hours_ago && rec.t <= now + 3600 {
                stat.five_hour_tokens = stat.five_hour_tokens.saturating_add(total);
                stat.five_hour_input = stat.five_hour_input.saturating_add(rec.i);
                stat.five_hour_output = stat.five_hour_output.saturating_add(rec.o);
                stat.five_hour_cache = stat.five_hour_cache.saturating_add(rec.c);
                stat.five_hour_turns = stat.five_hour_turns.saturating_add(1);
                stat.five_hour_resets_at = Some(
                    stat.five_hour_resets_at
                        .unwrap_or(0)
                        .max(rec.t.saturating_add(5 * 3600)),
                );
                stat.five_hour_earliest_at = Some(
                    stat.five_hour_earliest_at
                        .map_or(rec.t.saturating_add(5 * 3600), |prev| {
                            prev.min(rec.t.saturating_add(5 * 3600))
                        }),
                );
            }
            if rec.t >= seven_days_ago && rec.t <= now + 3600 {
                stat.weekly_tokens = stat.weekly_tokens.saturating_add(total);
                stat.weekly_input = stat.weekly_input.saturating_add(rec.i);
                stat.weekly_output = stat.weekly_output.saturating_add(rec.o);
                stat.weekly_cache = stat.weekly_cache.saturating_add(rec.c);
                stat.weekly_turns = stat.weekly_turns.saturating_add(1);
            }
            stat.all_time_tokens = stat.all_time_tokens.saturating_add(total);
            stat.all_time_input = stat.all_time_input.saturating_add(rec.i);
            stat.all_time_output = stat.all_time_output.saturating_add(rec.o);
            stat.all_time_cache = stat.all_time_cache.saturating_add(rec.c);
            stat.all_time_turns = stat.all_time_turns.saturating_add(1);
            if rec.t > 0 {
                stat.last_used_at = Some(stat.last_used_at.unwrap_or(0).max(rec.t));
            }
        }
    }

    let mut model_stats: Vec<ModelUsageStat> = stats_map.into_values().collect();
    model_stats.sort_by(|a, b| {
        b.weekly_tokens
            .cmp(&a.weekly_tokens)
            .then_with(|| b.five_hour_tokens.cmp(&a.five_hour_tokens))
            .then_with(|| b.all_time_tokens.cmp(&a.all_time_tokens))
            .then_with(|| a.model.cmp(&b.model))
    });

    let mut by_day: std::collections::BTreeMap<i64, Vec<ModelDay>> = Default::default();
    for ((day, agent, model), [input, output, cache]) in spent {
        by_day.entry(day).or_default().push(ModelDay {
            agent: agent.to_string(),
            model: model.to_string(),
            input,
            output,
            cache,
        });
    }
    let days = by_day
        .into_iter()
        .map(|(day, mut models)| {
            models.sort_by(|a, b| {
                b.total()
                    .cmp(&a.total())
                    .then_with(|| a.model.cmp(&b.model))
            });
            let (y, m, d) = civil_from_days(day);
            DayActivity {
                date: format!("{y:04}-{m:02}-{d:02}"),
                models,
            }
        })
        .collect();
    ActivityDto { days, model_stats }
}

/// Reading a gigabyte of logs is no work for the command thread (see
/// `claude_usage_limits` for why anything slow goes through `spawn_blocking`).
#[tauri::command]
pub async fn token_activity(tz_offset_minutes: i32) -> Result<ActivityDto, String> {
    tauri::async_runtime::spawn_blocking(move || scan(tz_offset_minutes))
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn temp_log(name: &str, lines: &[&str]) -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(name);
        let mut file = File::create(&path).unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
        (dir, path)
    }

    #[test]
    fn dates_round_trip() {
        assert_eq!(parse_iso("1970-01-02T00:00:01.5Z"), Some(86_401));
        let t = parse_iso("2026-08-16T14:06:09.736Z").unwrap();
        assert_eq!(civil_from_days(t.div_euclid(86_400)), (2026, 8, 16));
        assert_eq!(parse_iso("not a time"), None);
    }

    #[test]
    fn claude_keeps_the_last_line_of_a_streamed_message() {
        let (_dir, path) = temp_log(
            "a.jsonl",
            &[
                r#"{"timestamp":"2026-08-16T14:06:09.000Z","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":10,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}}"#,
                r#"{"timestamp":"2026-08-16T14:06:10.000Z","message":{"id":"m1","model":"claude-opus-5","usage":{"input_tokens":2,"output_tokens":40,"cache_creation_input_tokens":100,"cache_read_input_tokens":50}}}"#,
                r#"{"timestamp":"2026-08-16T14:07:00.000Z","message":{"id":"s","model":"<synthetic>","usage":{"input_tokens":0,"output_tokens":0}}}"#,
                r#"{"type":"user","message":{"role":"user","content":"usage"}}"#,
            ],
        );
        let recs = parse_claude(&path);
        assert_eq!(recs.len(), 1);
        assert_eq!((recs[0].i, recs[0].o, recs[0].c), (2, 40, 150));
        assert_eq!(recs[0].m, "claude-opus-5");
    }

    #[test]
    fn antigravity_parses_model_changes_and_ignores_code_mentions() {
        let (_dir, path) = temp_log(
            "transcript.jsonl",
            &[
                // Code reading snippet that contains 'Model Selection' and 'from None to '
                r#"{"step_index":0,"type":"PLANNER_RESPONSE","created_at":"2026-10-25T17:50:00Z","content":"if line.contains(\"Model Selection\") { if let Some(pos) = line.find(\"from None to \") { let rest = &line[pos + 13..]; }}"}"#,
                // Token turn right after reading code: should still be default model (gemini-3.8-flash)
                r#"{"step_index":1,"created_at":"2026-10-25T17:51:00Z","input_tokens":100,"output_tokens":20,"cache_read_tokens":500}"#,
                // Legitimate user settings change
                r#"{"step_index":2,"type":"USER_INPUT","created_at":"2026-10-25T17:52:00Z","content":"<USER_SETTINGS_CHANGE>\nThe user changed setting `Model Selection` from None to Gemini 3.8 Flash (High).\n</USER_SETTINGS_CHANGE>"}"#,
                // Token turn after legitimate change: should be gemini-3.8-flash
                r#"{"step_index":3,"created_at":"2026-10-25T17:53:00Z","input_tokens":200,"output_tokens":40,"cache_read_tokens":600}"#,
            ],
        );
        let recs = parse_antigravity(&path);
        assert_eq!(recs.len(), 2);
        assert_eq!(recs[0].m, "gemini-3.8-flash");
        assert_eq!(recs[1].m, "gemini-3.8-flash");
    }

    #[test]
    fn codex_spends_the_step_between_running_totals() {
        let (_dir, path) = temp_log(
            "rollout.jsonl",
            &[
                r#"{"timestamp":"2026-09-16T22:09:45.000Z","type":"turn_context","payload":{"model":"gpt-5.6-luna"}}"#,
                r#"{"timestamp":"2026-09-16T22:09:51.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}"#,
                r#"{"timestamp":"2026-09-16T22:09:52.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1000,"cached_input_tokens":400,"output_tokens":50}}}}"#,
                r#"{"timestamp":"2026-09-16T22:09:55.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":2500,"cached_input_tokens":1600,"output_tokens":80}}}}"#,
                r#"{"timestamp":"2026-09-16T22:09:56.000Z","type":"event_msg","payload":{"type":"token_count","info":null}}"#,
            ],
        );
        let recs = parse_codex(&path);
        assert_eq!(recs.len(), 2);
        assert_eq!((recs[0].i, recs[0].o, recs[0].c), (600, 50, 400));
        assert_eq!((recs[1].i, recs[1].o, recs[1].c), (300, 30, 1200));
        assert!(recs.iter().all(|rec| rec.m == "gpt-5.6-luna"));
    }

    #[test]
    fn aggregate_counts_a_copied_message_once_and_buckets_by_local_day() {
        let at = |iso: &str, key: &str, tokens: u64| Rec {
            t: parse_iso(iso).unwrap(),
            k: key.to_string(),
            m: "claude-opus-5".to_string(),
            i: 0,
            o: tokens,
            c: 0,
        };
        let claude = vec![
            at("2026-08-16T23:30:00Z", "m1", 100),
            at("2026-08-16T23:30:00Z", "m1", 100),
            at("2026-08-17T10:00:00Z", "", 50),
        ];
        // UTC+2 is -120 in `getTimezoneOffset` terms: 23:30Z is already the 17th.
        let dto = aggregate(vec![("claude", claude)], -120);
        assert_eq!(dto.days.len(), 1);
        assert_eq!(dto.days[0].date, "2026-08-17");
        assert_eq!(dto.days[0].models.len(), 1);
        assert_eq!(dto.days[0].models[0].total(), 150);
    }

    /// Reads this machine's real logs and prints the totals, for checking the
    /// readers against the files by hand: `cargo test -p egant real_logs --
    /// --ignored --nocapture`.
    #[test]
    #[ignore]
    fn real_logs() {
        let started = std::time::Instant::now();
        let dto = scan(0);
        println!("took {:?}", started.elapsed());
        let mut by_model: HashMap<(String, String), u64> = HashMap::new();
        for day in &dto.days {
            for model in &day.models {
                *by_model
                    .entry((model.agent.clone(), model.model.clone()))
                    .or_default() += model.total();
            }
        }
        let mut rows: Vec<_> = by_model.into_iter().collect();
        rows.sort_by_key(|(_, tokens)| std::cmp::Reverse(*tokens));
        println!(
            "total {}",
            rows.iter().map(|(_, tokens)| tokens).sum::<u64>()
        );
        for ((agent, model), tokens) in rows {
            println!("{agent:9} {model} {tokens}");
        }
        println!("{} active days", dto.days.len());
    }

    // Reads the opencode data on this machine, so it only means something
    // where opencode has been used: run it with `--ignored`.
    #[test]
    #[ignore]
    fn real_opencode_usage() {
        let stats = fetch_opencode_usage().expect("fetch_opencode_usage succeeds");
        println!("OpenCode usage stats: {stats:?}");
        assert!(stats.installed);
        assert!(stats.total_sessions > 0);
        assert!(stats.total_messages > 0);
        assert!(stats.top_tools.len() > 0);
    }
}
