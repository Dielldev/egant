//! Claude's 5-hour and weekly usage limits, and Codex's rate-limit windows.
//!
//! [`agents::claude_login`](crate::agents) only probes whether the OAuth
//! credential *exists* — it never reads it, by design. Showing the actual
//! percentage used needs the real number, though, and the only source for
//! that is Anthropic's own usage endpoint: the same one the CLI's `/usage`
//! command and its interactive status-line hook read from. So this module is
//! the one deliberate exception: it reads the access token, attaches it to a
//! single GET, and drops it. The token is never written to disk, cached, or
//! logged.
//!
//! Both endpoints are strict about how often they are called: Anthropic
//! answers 429 with a `retry-after` once it has seen too many requests, so
//! every caller in the app (composer, Usage page, accounts page, mobile)
//! funnels through this module, which serves a short-lived cache instead of
//! letting each surface hit the endpoint on its own.
//!
//! Reference: the same two-step lookup (credentials file, else Keychain) and
//! the same endpoint are what community status-line tools for Claude Code
//! use — there is no documented, official API for this. The Codex windows
//! come from the ChatGPT backend the CLI itself talks to when signed in with
//! a ChatGPT account (`~/.codex/auth.json`); there is no documented API for
//! that either.

use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// One rolling or weekly window's usage, as Anthropic's usage endpoint
/// reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct UsageWindow {
    /// 0-100.
    pub used_percent: f64,
    /// ISO 8601, passed through verbatim — the frontend parses it with
    /// `Date`, which already understands the format the endpoint sends.
    pub resets_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ClaudeUsage {
    pub five_hour: Option<UsageWindow>,
    pub seven_day: Option<UsageWindow>,
    /// Sonnet-specific weekly quota, on plans that split it out.
    pub seven_day_sonnet: Option<UsageWindow>,
}

/// One Codex rate-limit window. The ChatGPT backend reports its windows in
/// seconds (`limit_window_seconds` — a five-hour window on paid plans, a
/// month-long one on free) and its reset as a Unix timestamp, so the frontend
/// gets both raw.
#[derive(Debug, Clone, PartialEq)]
pub struct CodexWindow {
    /// 0-100.
    pub used_percent: f64,
    /// Unix seconds, or `None` when not reported.
    pub resets_at_epoch: Option<i64>,
    /// How long the window is, in seconds, when reported.
    pub window_seconds: Option<u64>,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexUsage {
    /// The plan's main rate-limit window ("primary" in the backend's reply).
    pub primary: Option<CodexWindow>,
    /// The weekly window, when the plan splits it out (`secondary`).
    pub secondary: Option<CodexWindow>,
    /// The plan window is spent ("limit_reached" in the reply).
    pub limit_reached: bool,
    /// `free`, `plus`, `pro`, … as the reply's `plan_type`.
    pub plan: Option<String>,
}

/// Cache rows served between the endpoint calls. Anthropic's endpoint stays
/// quiet for a couple of minutes after a 429, so the cache answers for the
/// both of us: fresh for the TTL, then still the last *real* reading while
/// we're locked out — silence from the endpoint never invents a number.
struct Cache<T> {
    last: Option<(Instant, T)>,
    /// Until when we shouldn't ask the endpoint again (from `retry-after`).
    retry_until: Option<Instant>,
    /// Last time the endpoint answered successfully — locked-out 429s don't
    /// move this, so an old reading is called old, not fresh.
    last_success: Option<Instant>,
}

const CACHE_TTL: Duration = Duration::from_secs(60);
/// Without a `retry-after` header, wait this long before the next attempt.
const BACKOFF: Duration = Duration::from_secs(120);
/// `retry-after` is trusted only this far — longer values are clamped to it.
const MAX_RETRY: Duration = Duration::from_secs(300);

impl<T> Cache<T> {
    fn new() -> Self {
        Cache {
            last: None,
            retry_until: None,
            last_success: None,
        }
    }

    fn fresh(&self, now: Instant) -> Option<&T> {
        self.last
            .iter()
            .flat_map(|(at, usage)| (*at + CACHE_TTL >= now).then_some(usage))
            .next()
    }

    fn latest(&self) -> Option<&T> {
        self.last.as_ref().map(|(_, usage)| usage)
    }

    fn record(&mut self, usage: T, now: Instant) {
        self.last = Some((now, usage));
        self.last_success = Some(now);
        self.retry_until = None;
    }
}

fn claude_cache() -> &'static Mutex<Cache<ClaudeUsage>> {
    static CACHE: OnceLock<Mutex<Cache<ClaudeUsage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::new()))
}

fn codex_cache() -> &'static Mutex<Cache<CodexUsage>> {
    static CACHE: OnceLock<Mutex<Cache<CodexUsage>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(Cache::new()))
}

/// Serves the cache while it's fresh or while we're locked out, and only
/// then reaches the endpoint — one request per TTL across the whole app.
///
/// The inner expression returns `Ok(None)` for "nothing to fetch" (signed
/// out), which is answered without touching the cache: it's decided by a
/// local file read, costs no network, and an empty reading sitting in `last`
/// would replace "signed out" with "signed in, no limits" once a lockout
/// started serving stale rows.
macro_rules! cached_usage {
    ($cache:expr, $fetch_expr:expr) => {{
        let cache = $cache;
        let guard = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        // The endpoint's lockout window: one attempt every retry-after.
        if guard.retry_until.is_some_and(|until| now < until) {
            return Ok(guard.latest().cloned());
        }
        if let Some(usage) = guard.fresh(now).cloned() {
            return Ok(Some(usage));
        }
        drop(guard);

        let outcome = $fetch_expr;
        let mut guard = cache
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let now = Instant::now();
        match outcome {
            Ok(None) => Ok(None),
            Ok(Some(usage)) => {
                guard.record(usage.clone(), now);
                Ok(Some(usage))
            }
            Err(error) => {
                guard.retry_until = Some(now + error.1.unwrap_or(BACKOFF));
                // The last real reading stands, even past its TTL — a stale
                // truth beats a fresh fabrication, and the UI shows it
                // without pretending the endpoint just answered.
                if guard.last.is_some() {
                    log::warn!(
                        "usage locked out: {}; serving the last reading for a while",
                        error.0
                    );
                    return Ok(guard.latest().cloned());
                }
                log::warn!("usage fetch failed: {}", error.0);
                Err(error.0)
            }
        }
    }};
}

/// Fetches the current Claude usage. `Ok(None)` means Claude isn't logged in
/// on this device — nothing to show, not an error the composer should surface.
/// A cached reading is served instead of a fresh one when the endpoint is
/// rate-limiting, so the UI keeps its real numbers rather than falling back
/// to nothing.
pub fn fetch() -> Result<Option<ClaudeUsage>, String> {
    cached_usage!(claude_cache(), fetch_uncached())
}

fn fetch_uncached() -> Result<Option<ClaudeUsage>, (String, Option<Duration>)> {
    let Some(token) = access_token() else {
        log::debug!("usage fetch: not logged in");
        return Ok(None);
    };
    // The token itself is never logged.

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| (error.to_string(), None))?;

    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .send()
        .map_err(|error| (error.to_string(), None))?;

    let status = response.status();
    if !status.is_success() {
        if status.as_u16() == 429 {
            if let Some(seconds) = retry_after(&response) {
                return Err((format!("usage endpoint returned {status}"), Some(seconds)));
            }
        }
        return Err((format!("usage endpoint returned {status}"), None));
    }

    let body: Value = response.json().map_err(|error| (error.to_string(), None))?;
    Ok(Some(ClaudeUsage {
        five_hour: window(&body, "five_hour"),
        seven_day: window(&body, "seven_day"),
        seven_day_sonnet: window(&body, "seven_day_sonnet"),
    }))
}

/// The `Retry-After` header in seconds, clamped to a sane maximum — the
/// macro's lockout lasts this long at most.
fn retry_after(response: &reqwest::blocking::Response) -> Option<Duration> {
    let seconds: u64 = response
        .headers()
        .get(reqwest::header::RETRY_AFTER)?
        .to_str()
        .ok()?
        .parse()
        .ok()?;
    Some(Duration::from_secs(seconds.min(MAX_RETRY.as_secs())))
}

fn window(body: &Value, key: &str) -> Option<UsageWindow> {
    let node = body.get(key)?;
    let used_percent = node.get("utilization").and_then(Value::as_f64)?;
    let resets_at = node
        .get("resets_at")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Some(UsageWindow {
        used_percent,
        resets_at,
    })
}

/// Fetches Codex's rate-limit windows from the ChatGPT backend, the way the
/// CLI itself does with the ChatGPT access token in `~/.codex/auth.json`.
/// `Ok(None)` means Codex isn't signed in with a ChatGPT account (or runs on
/// an API key, which has no plan rate limit) — nothing to show, not an error.
/// Cached exactly like the Claude call: one request per TTL app-wide, the
/// last real reading holding steady through any lockout.
pub fn fetch_codex() -> Result<Option<CodexUsage>, String> {
    cached_usage!(codex_cache(), codex_usage_uncached())
}

fn codex_usage_uncached() -> Result<Option<CodexUsage>, (String, Option<Duration>)> {
    let Some(path) = crate::agents::codex_auth_file() else {
        log::debug!("codex usage fetch: not signed in");
        return Ok(None);
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Ok(None);
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return Ok(None);
    };
    // API-key sign-ins have no ChatGPT plan rate limit to read.
    let Some(tokens) = value.get("tokens") else {
        return Ok(None);
    };
    let Some(access_token) = tokens.get("access_token").and_then(Value::as_str) else {
        return Ok(None);
    };
    let account_id = tokens.get("account_id").and_then(Value::as_str);

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| (error.to_string(), None))?;

    let mut request = client
        .get("https://chatgpt.com/backend-api/wham/usage")
        .bearer_auth(access_token)
        .header("accept", "application/json");
    if let Some(account_id) = account_id {
        request = request.header("chatgpt-account-id", account_id);
    }
    let response = request.send().map_err(|error| (error.to_string(), None))?;

    let status = response.status();
    if !status.is_success() {
        if status.as_u16() == 429 {
            if let Some(seconds) = retry_after(&response) {
                return Err((
                    format!("codex usage endpoint returned {status}"),
                    Some(seconds),
                ));
            }
        }
        return Err((format!("codex usage endpoint returned {status}"), None));
    }

    let body: Value = response.json().map_err(|error| (error.to_string(), None))?;
    Ok(codex_usage_from(&body))
}

/// Parses the windows out of a `wham/usage` reply. Split out for tests.
fn codex_usage_from(body: &Value) -> Option<CodexUsage> {
    let rate_limit = body.get("rate_limit")?;
    Some(CodexUsage {
        primary: codex_window(rate_limit, "primary_window"),
        secondary: codex_window(rate_limit, "secondary_window"),
        limit_reached: rate_limit
            .get("limit_reached")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        plan: body
            .get("plan_type")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn codex_window(rate_limit: &Value, key: &str) -> Option<CodexWindow> {
    let node = rate_limit.get(key)?;
    let node = node.as_object()?; // `null` means "window doesn't apply this plan"
    let used_percent = node.get("used_percent").and_then(Value::as_f64)?;
    Some(CodexWindow {
        used_percent,
        resets_at_epoch: node.get("reset_at").and_then(Value::as_i64),
        window_seconds: node.get("limit_window_seconds").and_then(Value::as_u64),
    })
}

// ---------------------------------------------------------------------------
// Token lookup — mirrors `agents::claude_login`'s two locations, but reads
// instead of just probing.
// ---------------------------------------------------------------------------

fn access_token() -> Option<String> {
    access_token_from_file().or_else(access_token_from_keychain)
}

fn claude_config_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR").filter(|d| !d.is_empty()) {
        return Some(PathBuf::from(dir));
    }
    dirs::home_dir().map(|home| home.join(".claude"))
}

fn access_token_from_file() -> Option<String> {
    let path = claude_config_dir()?.join(".credentials.json");
    let text = std::fs::read_to_string(path).ok()?;
    token_from_json(&text)
}

#[cfg(target_os = "macos")]
fn access_token_from_keychain() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args([
            "find-generic-password",
            "-s",
            "Claude Code-credentials",
            "-w",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    token_from_json(String::from_utf8(output.stdout).ok()?.trim())
}

#[cfg(not(target_os = "macos"))]
fn access_token_from_keychain() -> Option<String> {
    None
}

fn token_from_json(text: &str) -> Option<String> {
    let value: Value = serde_json::from_str(text).ok()?;
    value
        .get("claudeAiOauth")?
        .get("accessToken")?
        .as_str()
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_usage_window() {
        let body: Value = serde_json::from_str(
            r#"{"five_hour":{"utilization":42.5,"resets_at":"2026-09-16T22:00:00Z"},
                "seven_day":{"utilization":18.0,"resets_at":"2026-09-20T00:00:00Z"}}"#,
        )
        .unwrap();
        let five_hour = window(&body, "five_hour").unwrap();
        assert_eq!(five_hour.used_percent, 42.5);
        assert_eq!(five_hour.resets_at.unwrap(), "2026-09-16T22:00:00Z");
        assert!(window(&body, "seven_day_sonnet").is_none());
    }

    #[test]
    fn extracts_the_token_from_the_credentials_shape() {
        let text = r#"{"claudeAiOauth":{"accessToken":"sk-ant-oat-abc","expiresAt":1}}"#;
        assert_eq!(token_from_json(text).unwrap(), "sk-ant-oat-abc");
        assert!(token_from_json("{}").is_none());
        assert!(token_from_json("not json").is_none());
    }

    #[test]
    fn parses_a_codex_usage_reply() {
        let body: Value = serde_json::from_str(
            r#"{"plan_type":"free",
                "rate_limit":{"allowed":true,"limit_reached":false,
                    "primary_window":{"used_percent":7.0,"limit_window_seconds":18000,"reset_at":1793300000},
                    "secondary_window":null}}"#,
        )
        .unwrap();
        let usage = codex_usage_from(&body).unwrap();
        let primary = usage.primary.unwrap();
        assert_eq!(primary.used_percent, 7.0);
        assert_eq!(primary.window_seconds, Some(18_000));
        assert_eq!(primary.resets_at_epoch, Some(1_793_300_000));
        assert!(usage.secondary.is_none());
        assert!(!usage.limit_reached);
        assert_eq!(usage.plan.as_deref(), Some("free"));
    }

    #[test]
    fn codex_windows_can_omit_or_nullify() {
        let body: Value = serde_json::from_str(r#"{"rate_limit":{}}"#).unwrap();
        let usage = codex_usage_from(&body).unwrap();
        assert!(usage.primary.is_none());
        assert!(usage.secondary.is_none());
    }
}
