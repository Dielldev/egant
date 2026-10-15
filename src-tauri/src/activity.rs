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

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ActivityDto {
    /// Oldest first; days with nothing in them are left out.
    pub days: Vec<DayActivity>,
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
        _ => PathBuf::from(std::env::var_os("HOME")?).join(".local/share"),
    };
    let db = base.join("opencode/opencode.db");
    db.is_file().then_some(db)
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
    let output = std::process::Command::new("sqlite3")
        .args(["-readonly", "-cmd", ".timeout 3000", "-separator", "\t"])
        .arg(&db)
        .arg(QUERY)
        .output();
    let Ok(output) = output else {
        log::debug!("activity: no sqlite3, skipping OpenCode");
        return Vec::new();
    };
    if !output.status.success() {
        log::warn!(
            "activity: reading {} failed: {}",
            db.display(),
            String::from_utf8_lossy(&output.stderr).trim()
        );
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
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

// ---------------------------------------------------------------------------
// Putting it together
// ---------------------------------------------------------------------------

fn cache_path() -> Option<PathBuf> {
    Some(config_dir()?.join("activity-cache.json"))
}

fn home_dir(var: &str, fallback: &str) -> Option<PathBuf> {
    match std::env::var_os(var).map(PathBuf::from) {
        Some(dir) if dir.is_absolute() => Some(dir),
        _ => Some(PathBuf::from(std::env::var_os("HOME")?).join(fallback)),
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

    let claude = read_files(
        claude_files,
        parse_claude,
        &mut cache,
        &mut seen,
        &mut dirty,
    );
    let codex = read_files(codex_files, parse_codex, &mut cache, &mut seen, &mut dirty);
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
        vec![("claude", claude), ("codex", codex), ("opencode", opencode)],
        tz_offset_minutes,
    )
}

/// Folds records into the figures the panel draws. `tz_offset_minutes` is
/// JavaScript's `getTimezoneOffset()` (UTC minus local), so a message sent at
/// 23:30 local lands on the day the viewer lived it, not on UTC's.
fn aggregate(sources: Vec<(&str, Vec<Rec>)>, tz_offset_minutes: i32) -> ActivityDto {
    type Key<'a> = (i64, &'a str, &'a str);
    let mut spent: HashMap<Key<'_>, [u64; 3]> = HashMap::new();

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
            let local = rec.t - i64::from(tz_offset_minutes) * 60;
            let model = if rec.m.is_empty() { "unknown" } else { &rec.m };
            let slot = spent
                .entry((local.div_euclid(86_400), agent, model))
                .or_default();
            slot[0] = slot[0].saturating_add(rec.i);
            slot[1] = slot[1].saturating_add(rec.o);
            slot[2] = slot[2].saturating_add(rec.c);
        }
    }

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
    ActivityDto { days }
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
}
