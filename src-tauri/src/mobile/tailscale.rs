//! Tailscale, as far as the phone needs it: is it installed, is it up, what is
//! this Mac called on the tailnet, and can `tailscale serve` put egant's port
//! behind a real HTTPS certificate there.
//!
//! egant never listens on anything but 127.0.0.1. `tailscale serve` is what
//! reaches it from the tailnet: Tailscale terminates HTTPS with a certificate
//! for `<machine>.<tailnet>.ts.net` and proxies to the local port. That gives
//! the phone a secure context (a real PWA, with a service worker) without
//! egant ever being reachable from the café Wi-Fi it happens to sit on.
//!
//! Everything here shells out to the `tailscale` CLI, so every call is
//! blocking and bounded by a timeout — callers run it off the UI thread.

use serde::Serialize;
use serde_json::Value;
use std::io::Read;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// What the Devices panel shows about Tailscale.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TailscaleStatus {
    pub installed: bool,
    /// The daemon's own word for its state: `Running`, `Stopped`,
    /// `NeedsLogin`, `Starting`, …
    pub backend_state: Option<String>,
    pub running: bool,
    /// `diells-macbook-air.tail1234.ts.net`, without the trailing dot.
    pub dns_name: Option<String>,
    /// Whether this tailnet issues HTTPS certificates (its `CertDomains`).
    pub https_enabled: bool,
    /// `tailscale serve` already sends the HTTPS port to egant.
    pub serving: bool,
    /// Something else's `tailscale serve` entry holds the port.
    pub port_conflict: bool,
    pub error: Option<String>,
}

/// Where the CLI lives: the app bundle on macOS (which doubles as the CLI when
/// given arguments), the usual package locations, then `PATH`.
pub fn find_cli() -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/bin/tailscale",
        "/usr/sbin/tailscale",
        "C:\\Program Files\\Tailscale\\tailscale.exe",
    ];
    CANDIDATES
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .or_else(|| egant_harness::agents::resolve_cli("tailscale", None, &[]))
}

/// The daemon's state and this machine's name, then whether `serve` already
/// points `https_port` at `local_port`.
pub fn probe(https_port: u16, local_port: u16) -> TailscaleStatus {
    let Some(cli) = find_cli() else {
        return TailscaleStatus::default();
    };
    let mut status = match run(&cli, &["status", "--json"], Duration::from_secs(6)) {
        Ok(output) => parse_status(&output.stdout),
        // `status` exits non-zero when the daemon is stopped or logged out,
        // and still prints the JSON that says which.
        Err(RunError::Failed { stdout, stderr }) => {
            let mut parsed = parse_status(&stdout);
            if parsed.backend_state.is_none() {
                parsed.error = Some(
                    first_line(&stderr)
                        .unwrap_or("Tailscale isn't running")
                        .to_string(),
                );
            }
            parsed
        }
        Err(error) => TailscaleStatus {
            error: Some(error.to_string()),
            ..TailscaleStatus::default()
        },
    };
    status.installed = true;
    if status.running {
        if let Ok(output) = run(&cli, &["serve", "status", "--json"], Duration::from_secs(6)) {
            let (serving, conflict) = serve_state(&output.stdout, https_port, local_port);
            status.serving = serving;
            status.port_conflict = conflict;
        }
    }
    status
}

/// `tailscale serve --bg --https=<https_port> http://127.0.0.1:<local_port>`.
///
/// Leaves the config alone when another `serve` entry already owns the port:
/// replacing someone else's proxy is not a side effect a toggle should have.
pub fn enable_serve(https_port: u16, local_port: u16) -> Result<(), String> {
    let cli = find_cli().ok_or("Tailscale isn't installed")?;
    let status = probe(https_port, local_port);
    if status.serving {
        return Ok(());
    }
    if status.port_conflict {
        return Err(format!(
            "port {https_port} is already used by another `tailscale serve` entry"
        ));
    }
    let https = format!("--https={https_port}");
    let target = local_target(local_port);
    let mut args = vec!["serve", "--bg", "--yes", https.as_str(), target.as_str()];
    let mut outcome = run(&cli, &args, Duration::from_secs(30));
    // Older CLIs predate `--yes`; they never prompted anyway.
    if matches!(&outcome, Err(RunError::Failed { stderr, .. }) if stderr.contains("-yes")) {
        args.retain(|arg| *arg != "--yes");
        outcome = run(&cli, &args, Duration::from_secs(30));
    }
    match outcome {
        Ok(_) => Ok(()),
        Err(RunError::Failed { stdout, stderr }) | Err(RunError::TimedOut { stdout, stderr }) => {
            Err(serve_failure(&stdout, &stderr))
        }
        Err(error) => Err(error.to_string()),
    }
}

/// `tailscale serve --https=<https_port> off` — only ever called for an entry
/// egant put there itself.
pub fn disable_serve(https_port: u16) -> Result<(), String> {
    let cli = find_cli().ok_or("Tailscale isn't installed")?;
    let https = format!("--https={https_port}");
    run(
        &cli,
        &["serve", https.as_str(), "off"],
        Duration::from_secs(15),
    )
    .map(|_| ())
    .map_err(|error| error.to_string())
}

/// The command a user can run by hand when egant can't do it for them.
pub fn serve_command(https_port: u16, local_port: u16) -> String {
    format!(
        "tailscale serve --bg --https={https_port} {}",
        local_target(local_port)
    )
}

fn local_target(local_port: u16) -> String {
    format!("http://127.0.0.1:{local_port}")
}

/// Why `serve` refused, in a sentence the panel can show. When the tailnet
/// has not enabled Serve or HTTPS yet, the CLI prints the admin link that
/// fixes it — that link is the useful part.
fn serve_failure(stdout: &str, stderr: &str) -> String {
    let text = format!("{stdout}\n{stderr}");
    if let Some(url) = text
        .split_whitespace()
        .find(|word| word.starts_with("https://login.tailscale.com/"))
    {
        return format!("Tailscale needs Serve/HTTPS enabled for this tailnet: {url}");
    }
    first_line(stderr)
        .or_else(|| first_line(stdout))
        .unwrap_or("tailscale serve failed")
        .to_string()
}

fn first_line(text: &str) -> Option<&str> {
    text.lines().map(str::trim).find(|line| !line.is_empty())
}

/// Reads what the panel needs out of `tailscale status --json`. Lenient on
/// purpose: any field missing reads as "not known", never as an error.
pub fn parse_status(json: &str) -> TailscaleStatus {
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return TailscaleStatus::default();
    };
    let backend_state = value
        .get("BackendState")
        .and_then(Value::as_str)
        .map(str::to_string);
    let dns_name = value
        .pointer("/Self/DNSName")
        .and_then(Value::as_str)
        .map(|name| name.trim_end_matches('.').to_string())
        .filter(|name| !name.is_empty());
    let https_enabled = value
        .get("CertDomains")
        .and_then(Value::as_array)
        .is_some_and(|domains| !domains.is_empty());
    TailscaleStatus {
        running: backend_state.as_deref() == Some("Running"),
        backend_state,
        dns_name,
        https_enabled,
        ..TailscaleStatus::default()
    }
}

/// `(serving, conflict)` from `tailscale serve status --json`: whether the
/// HTTPS port already proxies to egant, or is taken by something else.
///
/// Matched on the text rather than a schema: the port has to appear in it and
/// so does egant's target, or it does not. That holds across CLI versions
/// that have moved the config's shape around.
pub fn serve_state(json: &str, https_port: u16, local_port: u16) -> (bool, bool) {
    let port_used =
        json.contains(&format!(":{https_port}\"")) || json.contains(&format!("\"{https_port}\""));
    if !port_used {
        return (false, false);
    }
    let ours = json.contains(&format!("\"{}\"", local_target(local_port)))
        || json.contains(&format!("\"{}/\"", local_target(local_port)));
    (ours, !ours)
}

#[derive(Debug)]
enum RunError {
    Spawn(std::io::Error),
    Failed { stdout: String, stderr: String },
    TimedOut { stdout: String, stderr: String },
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Spawn(error) => write!(f, "couldn't run tailscale: {error}"),
            RunError::Failed { stdout, stderr } => f.write_str(
                first_line(stderr)
                    .or_else(|| first_line(stdout))
                    .unwrap_or("tailscale failed"),
            ),
            RunError::TimedOut { .. } => f.write_str("tailscale didn't answer in time"),
        }
    }
}

struct Output {
    stdout: String,
}

/// Runs the CLI with a deadline. Both pipes are drained on their own threads
/// so a large answer (`status` lists every peer) can never fill a pipe and
/// stall the child while this waits for it to exit.
fn run(cli: &PathBuf, args: &[&str], timeout: Duration) -> Result<Output, RunError> {
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunError::Spawn)?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        std::thread::spawn(move || {
            let mut text = String::new();
            if let Some(mut pipe) = pipe {
                let _ = pipe.read_to_string(&mut text);
            }
            text
        })
    };
    let stdout = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let stderr = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(40)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    let stdout = stdout.join().unwrap_or_default();
    let stderr = stderr.join().unwrap_or_default();
    match status {
        Some(status) if status.success() => Ok(Output { stdout }),
        Some(_) => Err(RunError::Failed { stdout, stderr }),
        None => Err(RunError::TimedOut { stdout, stderr }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The fields this reads, in the shape `tailscale status --json` prints
    /// them (trimmed: the real output also lists every peer).
    const RUNNING: &str = r#"{
        "Version": "1.88.1-t1234",
        "BackendState": "Running",
        "TailscaleIPs": ["100.101.102.103", "fd7a:115c:a1e0::1"],
        "Self": {
            "HostName": "Diells-MacBook-Air",
            "DNSName": "diells-macbook-air.tail1234.ts.net.",
            "TailscaleIPs": ["100.101.102.103"],
            "Online": true
        },
        "MagicDNSSuffix": "tail1234.ts.net",
        "CertDomains": ["diells-macbook-air.tail1234.ts.net"],
        "Peer": {}
    }"#;

    #[test]
    fn a_running_node_with_https_reads_as_ready() {
        let status = parse_status(RUNNING);
        assert!(status.running);
        assert_eq!(status.backend_state.as_deref(), Some("Running"));
        assert_eq!(
            status.dns_name.as_deref(),
            Some("diells-macbook-air.tail1234.ts.net")
        );
        assert!(status.https_enabled);
    }

    #[test]
    fn https_is_off_until_the_tailnet_issues_certificates() {
        let json = RUNNING.replace(
            r#""CertDomains": ["diells-macbook-air.tail1234.ts.net"],"#,
            r#""CertDomains": null,"#,
        );
        assert!(!parse_status(&json).https_enabled);
    }

    #[test]
    fn a_logged_out_or_stopped_node_is_not_running() {
        let status = parse_status(r#"{"BackendState": "NeedsLogin", "Self": {"DNSName": ""}}"#);
        assert!(!status.running);
        assert_eq!(status.backend_state.as_deref(), Some("NeedsLogin"));
        assert_eq!(status.dns_name, None);
        assert!(!parse_status("not json").running);
    }

    #[test]
    fn serve_status_tells_ours_from_someone_elses() {
        let ours = r#"{"TCP":{"47247":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:47247":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47247"}}}}}"#;
        assert_eq!(serve_state(ours, 47247, 47247), (true, false));

        let theirs = r#"{"TCP":{"47247":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:47247":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(serve_state(theirs, 47247, 47247), (false, true));

        let elsewhere = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}"#;
        assert_eq!(serve_state(elsewhere, 47247, 47247), (false, false));
        assert_eq!(serve_state("{}", 47247, 47247), (false, false));
    }

    #[test]
    fn a_refusal_surfaces_the_link_that_fixes_it() {
        let message = serve_failure(
            "Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc123\n",
            "",
        );
        assert!(
            message.contains("https://login.tailscale.com/f/serve?node=abc123"),
            "{message}"
        );
        assert_eq!(serve_failure("", "error: boom\nmore"), "error: boom");
    }

    #[test]
    fn the_manual_command_matches_what_egant_runs() {
        assert_eq!(
            serve_command(47247, 47247),
            "tailscale serve --bg --https=47247 http://127.0.0.1:47247"
        );
    }
}
