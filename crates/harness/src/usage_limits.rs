//! Claude's 5-hour and weekly usage limits.
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
//! Reference: the same two-step lookup (credentials file, else Keychain) and
//! the same endpoint are what community status-line tools for Claude Code
//! use — there is no documented, official API for this.

use serde_json::Value;
use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

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

/// Fetches the current usage. `Ok(None)` means Claude isn't logged in on this
/// device — nothing to show, not an error the composer should surface.
pub fn fetch() -> Result<Option<ClaudeUsage>, String> {
    let Some(token) = access_token() else {
        return Ok(None);
    };

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|error| error.to_string())?;

    let response = client
        .get("https://api.anthropic.com/api/oauth/usage")
        .bearer_auth(&token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("content-type", "application/json")
        .send()
        .map_err(|error| error.to_string())?;

    let status = response.status();
    if !status.is_success() {
        return Err(format!("usage endpoint returned {status}"));
    }

    let body: Value = response.json().map_err(|error| error.to_string())?;
    Ok(Some(ClaudeUsage {
        five_hour: window(&body, "five_hour"),
        seven_day: window(&body, "seven_day"),
        seven_day_sonnet: window(&body, "seven_day_sonnet"),
    }))
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
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude"))
}

fn access_token_from_file() -> Option<String> {
    let path = claude_config_dir()?.join(".credentials.json");
    let text = std::fs::read_to_string(path).ok()?;
    token_from_json(&text)
}

#[cfg(target_os = "macos")]
fn access_token_from_keychain() -> Option<String> {
    let output = std::process::Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
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
}
