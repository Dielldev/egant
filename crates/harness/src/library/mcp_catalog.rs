//! The "Recommended" MCP servers: emdash's curated catalog, read live from
//! its repository so a server they add shows up here without an egant
//! release, with the copy built into egant (`mcp_catalog.json`) as the
//! fallback when GitHub can't be reached or the file stops parsing.
//!
//! emdash keeps the catalog as a TypeScript object literal
//! (`apps/emdash-desktop/src/core/primitives/mcp/api/catalog.ts`,
//! Apache-2.0). It is plain data — quoted strings, arrays, nested objects —
//! so [`js_object_to_json`] turns the literal into JSON rather than this
//! module evaluating anything. Anything it doesn't understand (a spread, a
//! function call) fails the parse, and the built-in copy is used instead.

use super::mcp::{CatalogMcp, CredentialKey, Transport};
use serde::Serialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const REMOTE_URL: &str = "https://raw.githubusercontent.com/generalaction/emdash/HEAD/apps/emdash-desktop/src/core/primitives/mcp/api/catalog.ts";

/// How long a fetched catalog is trusted before the next tab open refetches.
const FRESH_FOR: Duration = Duration::from_secs(6 * 3600);

/// Fewer entries than this means the file changed shape, not that emdash
/// dropped most of its catalog — use the built-in copy.
const MIN_ENTRIES: usize = 10;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCatalog {
    pub entries: Vec<CatalogMcp>,
    /// `true` when `entries` came from emdash's repository just now (or
    /// within [`FRESH_FOR`]); `false` for the copy built into egant.
    pub live: bool,
}

static LIVE: Mutex<Option<(Instant, Vec<CatalogMcp>)>> = Mutex::new(None);

fn bundled() -> &'static [CatalogMcp] {
    static BUNDLED: OnceLock<Vec<CatalogMcp>> = OnceLock::new();
    BUNDLED.get_or_init(|| {
        serde_json::from_str(include_str!("mcp_catalog.json")).unwrap_or_else(|error| {
            log::error!("built-in mcp catalog doesn't parse: {error}");
            Vec::new()
        })
    })
}

/// The newest catalog this process has, without touching the network —
/// what matching an installed server to its catalog entry uses.
pub fn current() -> Vec<CatalogMcp> {
    LIVE.lock()
        .ok()
        .and_then(|live| live.as_ref().map(|(_, entries)| entries.clone()))
        .unwrap_or_else(|| bundled().to_vec())
}

/// The catalog for the Recommended grid: the live one, fetched when the
/// cached copy is older than [`FRESH_FOR`] (or `refresh` asks), else the
/// built-in one.
pub fn load(refresh: bool) -> McpCatalog {
    if !refresh {
        if let Some((at, entries)) = LIVE.lock().ok().and_then(|live| live.clone()) {
            if at.elapsed() < FRESH_FOR {
                return McpCatalog {
                    entries,
                    live: true,
                };
            }
        }
    }
    match fetch() {
        Ok(entries) => {
            if let Ok(mut live) = LIVE.lock() {
                *live = Some((Instant::now(), entries.clone()));
            }
            McpCatalog {
                entries,
                live: true,
            }
        }
        Err(error) => {
            log::warn!("live mcp catalog unavailable, using the built-in one: {error}");
            // A catalog fetched earlier beats the built-in one even stale.
            match LIVE.lock().ok().and_then(|live| live.clone()) {
                Some((_, entries)) => McpCatalog {
                    entries,
                    live: true,
                },
                None => McpCatalog {
                    entries: bundled().to_vec(),
                    live: false,
                },
            }
        }
    }
}

fn fetch() -> Result<Vec<CatalogMcp>, String> {
    let text = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("egant")
        .build()
        .map_err(|e| e.to_string())?
        .get(REMOTE_URL)
        .send()
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.text())
        .map_err(|e| e.to_string())?;
    let entries = parse_emdash_catalog(&text)?;
    if entries.len() < MIN_ENTRIES {
        return Err(format!("only {} entries parsed", entries.len()));
    }
    Ok(entries)
}

/// emdash's `catalogData` object → catalog entries, in emdash's order.
fn parse_emdash_catalog(source: &str) -> Result<Vec<CatalogMcp>, String> {
    let start = source
        .find("catalogData")
        .ok_or("no `catalogData` in the file")?;
    let open = source[start..]
        .find('=')
        .and_then(|eq| source[start + eq..].find('{').map(|b| start + eq + b))
        .ok_or("no object after `catalogData`")?;
    let literal = balanced_object(&source[open..]).ok_or("unbalanced `catalogData` object")?;
    let json = js_object_to_json(literal)?;
    let root: Map<String, Value> =
        serde_json::from_str(&json).map_err(|e| format!("not data: {e}"))?;
    Ok(root
        .into_iter()
        .filter_map(|(id, entry)| entry_from(&id, &entry))
        .collect())
}

fn entry_from(id: &str, entry: &Value) -> Option<CatalogMcp> {
    let config = entry.get("config")?.as_object()?;
    let text = |v: Option<&Value>| v.and_then(Value::as_str).map(str::to_string);
    let map = |v: Option<&Value>| -> BTreeMap<String, String> {
        v.and_then(Value::as_object)
            .map(|m| {
                m.iter()
                    .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                    .collect()
            })
            .unwrap_or_default()
    };
    let url = text(config.get("url")).unwrap_or_default();
    let command = text(config.get("command")).unwrap_or_default();
    let http = text(config.get("type")).as_deref() == Some("http")
        || (command.is_empty() && !url.is_empty());
    if (http && !url.starts_with("http")) || (!http && command.is_empty()) {
        return None;
    }
    Some(CatalogMcp {
        id: id.to_string(),
        name: text(entry.get("name")).unwrap_or_else(|| id.to_string()),
        description: text(entry.get("description")).unwrap_or_default(),
        docs_url: text(entry.get("docsUrl")).unwrap_or_default(),
        transport: if http {
            Transport::Http
        } else {
            Transport::Stdio
        },
        command: if http { String::new() } else { command },
        args: config
            .get("args")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
        env: map(config.get("env")),
        url: if http { url } else { String::new() },
        headers: map(config.get("headers")),
        credential_keys: entry
            .get("credentialKeys")
            .and_then(Value::as_array)
            .map(|keys| {
                keys.iter()
                    .filter_map(|k| {
                        Some(CredentialKey {
                            key: k.get("key")?.as_str()?.to_string(),
                            required: k.get("required").and_then(Value::as_bool).unwrap_or(false),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    })
}

/// The `{ … }` starting at `text[0]`, matched past strings and comments.
fn balanced_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' | b'"' | b'`' => i = skip_string(bytes, i)?,
            b'/' if bytes.get(i + 1) == Some(&b'/') => {
                while i < bytes.len() && bytes[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i + 1 < bytes.len() && !(bytes[i] == b'*' && bytes[i + 1] == b'/') {
                    i += 1;
                }
                i += 1;
            }
            b'{' => depth += 1,
            b'}' => {
                depth = depth.checked_sub(1)?;
                if depth == 0 {
                    return Some(&text[..=i]);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}

/// Index of the closing quote of the string opening at `start`.
fn skip_string(bytes: &[u8], start: usize) -> Option<usize> {
    let quote = bytes[start];
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b if b == quote => return Some(i),
            _ => i += 1,
        }
    }
    None
}

/// A JavaScript object literal made only of data → JSON: unquoted keys get
/// quotes, `'…'` and plain `` `…` `` strings become `"…"`, comments and
/// trailing commas go. Anything else — an identifier that isn't a key or a
/// literal, a `${}` interpolation, a spread — is an error, never guessed at.
fn js_object_to_json(src: &str) -> Result<String, String> {
    let chars: Vec<char> = src.chars().collect();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    let next_significant = |from: usize| -> Option<char> {
        let mut j = from;
        while j < chars.len() {
            let c = chars[j];
            if c.is_whitespace() {
                j += 1;
            } else if c == '/' && chars.get(j + 1) == Some(&'/') {
                while j < chars.len() && chars[j] != '\n' {
                    j += 1;
                }
            } else if c == '/' && chars.get(j + 1) == Some(&'*') {
                j += 2;
                while j + 1 < chars.len() && !(chars[j] == '*' && chars[j + 1] == '/') {
                    j += 1;
                }
                j += 2;
            } else {
                return Some(c);
            }
        }
        None
    };
    while i < chars.len() {
        let c = chars[i];
        match c {
            c if c.is_whitespace() => i += 1,
            '/' if chars.get(i + 1) == Some(&'/') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                i += 2;
                while i + 1 < chars.len() && !(chars[i] == '*' && chars[i + 1] == '/') {
                    i += 1;
                }
                i += 2;
            }
            '\'' | '"' | '`' => {
                let quote = c;
                let mut value = String::new();
                i += 1;
                loop {
                    let ch = *chars.get(i).ok_or("unterminated string")?;
                    if ch == quote {
                        break;
                    }
                    if ch == '\\' {
                        let escaped = *chars.get(i + 1).ok_or("unterminated string")?;
                        match escaped {
                            'n' => value.push('\n'),
                            't' => value.push('\t'),
                            'r' => value.push('\r'),
                            other => value.push(other),
                        }
                        i += 2;
                        continue;
                    }
                    if quote == '`' && ch == '$' && chars.get(i + 1) == Some(&'{') {
                        return Err("template interpolation".into());
                    }
                    value.push(ch);
                    i += 1;
                }
                i += 1;
                out.push_str(&serde_json::to_string(&value).map_err(|e| e.to_string())?);
            }
            ',' => {
                i += 1;
                if !matches!(next_significant(i), Some('}') | Some(']')) {
                    out.push(',');
                }
            }
            '{' | '}' | '[' | ']' | ':' => {
                out.push(c);
                i += 1;
            }
            c if c.is_ascii_digit() || c == '-' => {
                while i < chars.len()
                    && (chars[i].is_ascii_alphanumeric() || ".-+_".contains(chars[i]))
                {
                    if chars[i] != '_' {
                        out.push(chars[i]);
                    }
                    i += 1;
                }
            }
            c if c.is_alphabetic() || c == '_' || c == '$' => {
                let mut word = String::new();
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || chars[i] == '_' || chars[i] == '$')
                {
                    word.push(chars[i]);
                    i += 1;
                }
                if next_significant(i) == Some(':') {
                    out.push_str(&serde_json::to_string(&word).map_err(|e| e.to_string())?);
                } else if matches!(word.as_str(), "true" | "false" | "null") {
                    out.push_str(&word);
                } else {
                    return Err(format!("`{word}` isn't plain data"));
                }
            }
            other => return Err(format!("unexpected `{other}`")),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
import type { RawServerEntry } from '@emdash/core/primitives/mcp/api';

export interface CredentialKeyDef { key: string; required: boolean; }

export const catalogData: Record<string, CatalogEntryDef> = {
  // Browser automation
  playwright: {
    config: { command: 'npx', args: ['@playwright/mcp@latest'] },
    name: 'Playwright',
    description: 'Browser automation, with "quotes" and it\'s escaped',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    credentialKeys: [],
  },
  'context-7': {
    config: {
      type: 'http',
      url: `https://mcp.context7.com/mcp`,
      headers: { CONTEXT7_API_KEY: 'YOUR_API_KEY', },
    },
    name: 'Context7', /* inline comment */
    description: 'Docs { with braces }',
    docsUrl: 'https://github.com/upstash/context7',
    credentialKeys: [{ key: 'CONTEXT7_API_KEY', required: false }],
  },
};

export const other = { x: 1 };
"#;

    #[test]
    fn parses_emdash_shaped_catalogs() {
        let entries = parse_emdash_catalog(SAMPLE).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].id, "playwright");
        assert_eq!(entries[0].args, vec!["@playwright/mcp@latest"]);
        assert_eq!(
            entries[0].description,
            "Browser automation, with \"quotes\" and it's escaped"
        );
        assert_eq!(entries[1].id, "context-7");
        assert_eq!(entries[1].transport, Transport::Http);
        assert_eq!(entries[1].headers["CONTEXT7_API_KEY"], "YOUR_API_KEY");
        assert_eq!(entries[1].credential_keys[0].key, "CONTEXT7_API_KEY");
    }

    #[test]
    fn refuses_anything_that_isnt_data() {
        for bad in [
            "{ a: someVariable }",
            "{ a: `x${y}` }",
            "{ ...spread }",
            "{ a: fn() }",
        ] {
            assert!(js_object_to_json(bad).is_err(), "{bad}");
        }
    }

    /// Network: emdash's live file still parses. `cargo test -- --ignored`.
    #[test]
    #[ignore]
    fn live_catalog_parses() {
        let entries = fetch().unwrap();
        let bundled_ids: Vec<_> = bundled().iter().map(|c| c.id.as_str()).collect();
        let new: Vec<_> = entries
            .iter()
            .filter(|e| !bundled_ids.contains(&e.id.as_str()))
            .map(|e| e.id.as_str())
            .collect();
        println!(
            "{} live entries, new since the built-in copy: {new:?}",
            entries.len()
        );
    }

    #[test]
    fn built_in_copy_parses() {
        assert!(bundled().len() >= MIN_ENTRIES);
        assert!(bundled().iter().all(|c| match c.transport {
            Transport::Stdio => !c.command.is_empty(),
            Transport::Http => c.url.starts_with("http"),
        }));
    }
}
