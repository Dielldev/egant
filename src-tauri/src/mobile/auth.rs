//! Who may use the phone API, and how a phone becomes one of them.
//!
//! A phone pairs once, by redeeming a short-lived code the Devices panel shows
//! (inside the QR code, and spelled out beside it for typing). Redeeming it
//! mints a device token: 256 random bits the phone keeps in an HttpOnly cookie
//! and presents on every request after. The desktop stores only the token's
//! SHA-256, so the file on disk cannot be replayed as a login, and revoking a
//! device is deleting its row.
//!
//! Everything else about a device is bookkeeping for the panel: its name,
//! when it paired, when it was last seen.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// The port egant's phone server listens on, on 127.0.0.1 only. The same
/// number is used for the HTTPS port `tailscale serve` opens on the tailnet,
/// so there is one number to recognise.
pub const DEFAULT_PORT: u16 = 47247;

/// How long a pairing code stays redeemable.
pub const PAIRING_TTL_MS: u64 = 5 * 60 * 1000;

/// Wrong codes tolerated before every outstanding code is thrown away. With
/// ten 32-symbol characters (50 bits) this leaves a guesser nothing to work
/// with; the cap is there so a flood of guesses cannot even try.
const MAX_PAIRING_FAILURES: u32 = 10;

const CODE_LEN: usize = 10;

/// No 0/O or 1/I: a code is read off one screen and typed into another.
const CODE_ALPHABET: &[u8; 32] = b"23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MobileConfig {
    /// Whether the phone server runs. Off until the user turns it on.
    pub enabled: bool,
    pub port: u16,
    /// Whether egant itself put the `tailscale serve` entry in place — only
    /// then is it egant's to take down again.
    pub serve_configured: bool,
    pub devices: Vec<DeviceRecord>,
}

impl Default for MobileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: DEFAULT_PORT,
            serve_configured: false,
            devices: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    /// SHA-256 of the device's token, hex. Never the token itself.
    pub token_hash: String,
    pub created_ms: u64,
    pub last_seen_ms: u64,
}

impl MobileConfig {
    /// The device a token belongs to, if any.
    pub fn authenticate(&self, token: &str) -> Option<&DeviceRecord> {
        if token.is_empty() || token.len() > 128 {
            return None;
        }
        let hash = hash_token(token);
        self.devices
            .iter()
            .find(|device| constant_time_eq(device.token_hash.as_bytes(), hash.as_bytes()))
    }

    /// Adds a device and returns it with its token — the only time the token
    /// exists outside the phone.
    pub fn add_device(&mut self, name: String, now_ms: u64) -> (DeviceRecord, String) {
        let token = new_token();
        let device = DeviceRecord {
            id: hex(&random_bytes::<8>()),
            name,
            token_hash: hash_token(&token),
            created_ms: now_ms,
            last_seen_ms: now_ms,
        };
        self.devices.push(device.clone());
        (device, token)
    }

    pub fn remove_device(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|device| device.id != id);
        self.devices.len() != before
    }
}

/// Pairing codes waiting to be redeemed. In memory only: a code that outlives
/// the app has outlived its purpose.
#[derive(Debug, Default)]
pub struct Pairings {
    pending: Vec<(String, u64)>,
    failures: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum PairError {
    /// Not a code that is waiting — wrong, used already, or expired.
    Invalid,
    /// Too many wrong codes: every outstanding one was thrown away.
    TooManyAttempts,
}

impl Pairings {
    /// A fresh code, and when it stops working.
    pub fn issue(&mut self, now_ms: u64) -> (String, u64) {
        let code = new_pairing_code();
        let expires = now_ms + PAIRING_TTL_MS;
        self.prune(now_ms);
        self.pending.push((code.clone(), expires));
        self.failures = 0;
        (code, expires)
    }

    /// Accepts a code issued elsewhere (the debug-build test hook).
    #[cfg_attr(not(debug_assertions), allow(dead_code))]
    pub fn insert(&mut self, code: String, expires_ms: u64) {
        self.pending.push((code, expires_ms));
    }

    /// Spends a code. Each code works once.
    pub fn redeem(&mut self, input: &str, now_ms: u64) -> Result<(), PairError> {
        self.prune(now_ms);
        let found = normalize_code(input).and_then(|code| {
            self.pending
                .iter()
                .position(|(pending, _)| constant_time_eq(pending.as_bytes(), code.as_bytes()))
        });
        match found {
            Some(index) => {
                self.pending.remove(index);
                self.failures = 0;
                Ok(())
            }
            None => {
                self.failures += 1;
                if self.failures >= MAX_PAIRING_FAILURES {
                    log::warn!("mobile: too many wrong pairing codes — discarding every open code");
                    self.pending.clear();
                    self.failures = 0;
                    return Err(PairError::TooManyAttempts);
                }
                Err(PairError::Invalid)
            }
        }
    }

    fn prune(&mut self, now_ms: u64) {
        self.pending.retain(|(_, expires)| *expires > now_ms);
    }
}

/// Uppercases, drops separators and whitespace, and checks the result is a
/// code this app could have issued.
pub fn normalize_code(input: &str) -> Option<String> {
    let code: String = input
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| c.to_ascii_uppercase())
        .collect();
    (code.len() == CODE_LEN && code.bytes().all(|b| CODE_ALPHABET.contains(&b))).then_some(code)
}

/// `ABCDE-FGHJK`: two halves, easier to read off and type.
pub fn format_code(code: &str) -> String {
    let (head, tail) = code.split_at(code.len() / 2);
    format!("{head}-{tail}")
}

fn new_pairing_code() -> String {
    random_bytes::<CODE_LEN>()
        .iter()
        .map(|byte| CODE_ALPHABET[(byte & 31) as usize] as char)
        .collect()
}

fn new_token() -> String {
    base64::Engine::encode(
        &base64::engine::general_purpose::URL_SAFE_NO_PAD,
        random_bytes::<32>(),
    )
}

pub fn hash_token(token: &str) -> String {
    hex(&Sha256::digest(token.as_bytes()))
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut bytes = [0u8; N];
    // The OS random source failing is not something to limp on from: a
    // predictable token would be worse than no phone access at all.
    getrandom::fill(&mut bytes).expect("the operating system's random source failed");
    bytes
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Compares without an early exit, so a guess learns nothing from timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// A device name from what the phone offered, or from its user agent: short,
/// printable, and never empty.
pub fn device_name(offered: Option<&str>, user_agent: &str) -> String {
    let offered: String = offered
        .unwrap_or_default()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let offered = offered.trim();
    if !offered.is_empty() {
        return offered.to_string();
    }
    let ua = user_agent.to_ascii_lowercase();
    if ua.contains("iphone") {
        "iPhone"
    } else if ua.contains("ipad") {
        "iPad"
    } else if ua.contains("android") {
        "Android phone"
    } else if ua.contains("macintosh") || ua.contains("mac os") {
        "Mac browser"
    } else {
        "Phone"
    }
    .to_string()
}

/// `mobile.json`, beside the rest of egant's settings.
pub fn config_path() -> Option<PathBuf> {
    Some(crate::settings::config_dir()?.join("mobile.json"))
}

/// Reads the config at `path`, falling back to defaults (phone access off).
pub fn load(path: Option<&Path>) -> MobileConfig {
    let Some(path) = path else {
        return MobileConfig::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return MobileConfig::default();
    };
    serde_json::from_str(&text).unwrap_or_else(|error| {
        log::warn!("ignoring unreadable {}: {error}", path.display());
        MobileConfig::default()
    })
}

/// Writes the config to `path` (nowhere, given none), readable by this user
/// only — it lists every device allowed in, even if only by hash.
pub fn save(path: Option<&Path>, config: &MobileConfig) {
    let Some(path) = path else { return };
    let text = match serde_json::to_string_pretty(config) {
        Ok(text) => text,
        Err(error) => {
            log::warn!("could not serialize mobile config: {error}");
            return;
        }
    };
    if let Err(error) = crate::persist::write_atomic(path, &text) {
        log::warn!("could not write {}: {error}", path.display());
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_device_is_found_by_its_token_and_only_by_it() {
        let mut config = MobileConfig::default();
        let (device, token) = config.add_device("iPhone".into(), 1);
        assert_eq!(config.authenticate(&token).map(|d| &d.id), Some(&device.id));
        assert!(config.authenticate("not-the-token").is_none());
        assert!(config.authenticate("").is_none());
        // What is stored is not the token.
        assert_ne!(config.devices[0].token_hash, token);
        assert_eq!(config.devices[0].token_hash, hash_token(&token));
    }

    #[test]
    fn tokens_and_device_ids_are_unique_and_long() {
        let mut config = MobileConfig::default();
        let (a, token_a) = config.add_device("a".into(), 1);
        let (b, token_b) = config.add_device("b".into(), 1);
        assert_ne!(token_a, token_b);
        assert_ne!(a.id, b.id);
        assert!(token_a.len() >= 43, "{token_a}"); // 32 bytes of base64
    }

    #[test]
    fn a_revoked_device_is_locked_out() {
        let mut config = MobileConfig::default();
        let (device, token) = config.add_device("iPhone".into(), 1);
        assert!(config.remove_device(&device.id));
        assert!(config.authenticate(&token).is_none());
        assert!(!config.remove_device(&device.id));
    }

    #[test]
    fn a_pairing_code_works_once() {
        let mut pairings = Pairings::default();
        let (code, _) = pairings.issue(1_000);
        assert_eq!(pairings.redeem(&code, 2_000), Ok(()));
        assert_eq!(pairings.redeem(&code, 2_000), Err(PairError::Invalid));
    }

    #[test]
    fn a_pairing_code_expires() {
        let mut pairings = Pairings::default();
        let (code, expires) = pairings.issue(1_000);
        assert_eq!(expires, 1_000 + PAIRING_TTL_MS);
        assert_eq!(pairings.redeem(&code, expires), Err(PairError::Invalid));
    }

    #[test]
    fn a_code_is_accepted_however_it_was_typed() {
        let mut pairings = Pairings::default();
        let (code, _) = pairings.issue(0);
        let typed = format!(" {} ", format_code(&code).to_lowercase());
        assert_eq!(pairings.redeem(&typed, 1), Ok(()));
    }

    #[test]
    fn too_many_wrong_codes_burn_the_real_one() {
        let mut pairings = Pairings::default();
        let (code, _) = pairings.issue(0);
        for _ in 0..MAX_PAIRING_FAILURES - 1 {
            assert_eq!(pairings.redeem("22222-22222", 1), Err(PairError::Invalid));
        }
        assert_eq!(
            pairings.redeem("22222-22223", 1),
            Err(PairError::TooManyAttempts)
        );
        assert_eq!(pairings.redeem(&code, 1), Err(PairError::Invalid));
    }

    #[test]
    fn codes_use_only_the_unambiguous_alphabet() {
        for _ in 0..50 {
            let code = new_pairing_code();
            assert_eq!(normalize_code(&code).as_deref(), Some(code.as_str()));
            assert!(!code.contains(['0', 'O', '1', 'I']));
        }
        assert_eq!(normalize_code("ABCDE-FGHJ0"), None);
        assert_eq!(normalize_code("too-short"), None);
    }

    #[test]
    fn device_names_are_short_printable_and_never_empty() {
        assert_eq!(device_name(Some("  Diell's phone "), ""), "Diell's phone");
        assert_eq!(device_name(Some("x\u{7}y"), ""), "xy");
        assert_eq!(device_name(Some(&"a".repeat(100)), "").len(), 40);
        assert_eq!(
            device_name(
                None,
                "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"
            ),
            "iPhone"
        );
        assert_eq!(
            device_name(Some(""), "Mozilla/5.0 (Linux; Android 15)"),
            "Android phone"
        );
        assert_eq!(device_name(None, ""), "Phone");
    }

    #[test]
    fn an_older_or_empty_config_file_loads_with_defaults() {
        let config: MobileConfig = serde_json::from_str("{}").unwrap();
        assert_eq!(config, MobileConfig::default());
        let config: MobileConfig = serde_json::from_str(r#"{"enabled": true}"#).unwrap();
        assert!(config.enabled);
        assert_eq!(config.port, DEFAULT_PORT);
    }
}
