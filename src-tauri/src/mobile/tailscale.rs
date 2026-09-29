//! Tailscale, as far as the phone needs it: is it installed, is it up, what is
//! this Mac called on the tailnet, and can `tailscale serve` put egant's port
//! behind a real HTTPS certificate there — or Funnel put it on the internet.
//!
//! egant never listens on anything but 127.0.0.1. Tailscale is what reaches
//! it: it terminates HTTPS on this Mac with a certificate for
//! `<machine>.<tailnet>.ts.net` and proxies to the local port. `serve` answers
//! the tailnet only; Funnel answers anyone, relaying the still-encrypted
//! connection from Tailscale's edge to this Mac — the public link, for a phone
//! with nothing installed. Either way the phone gets a secure context (a real
//! PWA, with a service worker) and egant is never reachable from the café
//! Wi-Fi it happens to sit on.
//!
//! Everything here shells out to the `tailscale` CLI, so every call is
//! blocking and bounded by a timeout — callers run it off the UI thread.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};

/// The only ports Funnel opens to the internet, most readable URL first.
pub const FUNNEL_PORTS: [u16; 3] = [443, 8443, 10000];

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
    /// The Funnel port that opens egant to the internet: the public link is
    /// live.
    pub funnel_port: Option<u16>,
    /// Every Funnel port already serves something else.
    pub funnel_blocked: bool,
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
/// points `https_port` at `local_port`, and whether Funnel opens it publicly.
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
        if let Some(json) = serve_status(&cli) {
            let ports = serve_ports(&json);
            let (serving, conflict) = port_state(&ports, https_port, local_port);
            status.serving = serving;
            status.port_conflict = conflict;
            let (live, free) = funnel_state(&ports, local_port);
            status.funnel_port = live;
            status.funnel_blocked = live.is_none() && free.is_none();
        }
    }
    status
}

fn serve_status(cli: &Path) -> Option<String> {
    run(cli, &["serve", "status", "--json"], Duration::from_secs(6))
        .ok()
        .map(|output| output.stdout)
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
    publish(&cli, "serve", https_port, local_port)
}

/// `tailscale funnel --bg --https=<port> http://127.0.0.1:<local_port>` on the
/// first Funnel port that is free (or already serves egant on the tailnet
/// only), returning that port. Like `serve --bg`, it stays until turned off,
/// across restarts of this Mac.
pub fn enable_funnel(local_port: u16) -> Result<u16, String> {
    let cli = find_cli().ok_or("Tailscale isn't installed")?;
    enable_funnel_with(&cli, local_port)
}

fn enable_funnel_with(cli: &Path, local_port: u16) -> Result<u16, String> {
    let ports = serve_status(cli)
        .map(|json| serve_ports(&json))
        .unwrap_or_default();
    let (live, free) = funnel_state(&ports, local_port);
    if let Some(port) = live {
        return Ok(port);
    }
    let port = free.ok_or(
        "Funnel's ports (443, 8443 and 10000) are all used by other `tailscale serve` entries on this Mac",
    )?;
    publish(cli, "funnel", port, local_port).map(|()| port)
}

/// Runs `tailscale <verb> --bg --yes --https=<port> <egant>`, `serve` or
/// `funnel`.
fn publish(cli: &Path, verb: &str, https_port: u16, local_port: u16) -> Result<(), String> {
    let https = format!("--https={https_port}");
    let target = local_target(local_port);
    let mut args = vec![verb, "--bg", "--yes", https.as_str(), target.as_str()];
    let mut outcome = run_until(cli, &args, Duration::from_secs(30), Some(&names_admin_link));
    // Older CLIs predate `--yes`; they never prompted anyway.
    if matches!(&outcome, Err(RunError::Failed { stderr, .. }) if stderr.contains("-yes")) {
        args.retain(|arg| *arg != "--yes");
        outcome = run_until(cli, &args, Duration::from_secs(30), Some(&names_admin_link));
    }
    match outcome {
        Ok(_) => Ok(()),
        Err(
            RunError::Failed { stdout, stderr }
            | RunError::TimedOut { stdout, stderr }
            | RunError::Stopped { stdout, stderr },
        ) => Err(serve_failure(&stdout, &stderr)),
        Err(error) => Err(error.to_string()),
    }
}

/// `tailscale serve --https=<https_port> off` — only ever called for an entry
/// egant put there itself.
pub fn disable_serve(https_port: u16) -> Result<(), String> {
    unpublish("serve", https_port)
}

/// `tailscale funnel --https=<port> off` — only ever called for a port the
/// probe saw proxying to egant.
pub fn disable_funnel(port: u16) -> Result<(), String> {
    unpublish("funnel", port)
}

fn unpublish(verb: &str, https_port: u16) -> Result<(), String> {
    let cli = find_cli().ok_or("Tailscale isn't installed")?;
    let https = format!("--https={https_port}");
    run(
        &cli,
        &[verb, https.as_str(), "off"],
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

/// The same for the public link, on Funnel's first port.
pub fn funnel_command(local_port: u16) -> String {
    format!(
        "tailscale funnel --bg --https={} {}",
        FUNNEL_PORTS[0],
        local_target(local_port)
    )
}

fn local_target(local_port: u16) -> String {
    format!("http://127.0.0.1:{local_port}")
}

/// The Tailscale admin page a refusal names — `…/f/serve?node=…` or
/// `…/f/funnel?node=…` — the page that turns on what was missing.
fn admin_link(text: &str) -> Option<&str> {
    text.split_whitespace()
        .find(|word| word.starts_with("https://login.tailscale.com/"))
}

/// Whether the CLI has printed a whole admin link: it then waits, forever,
/// for someone to click it.
fn names_admin_link(text: &str) -> bool {
    text.find("https://login.tailscale.com/")
        .is_some_and(|at| text[at..].contains('\n'))
}

/// Why `serve` or `funnel` refused, in a sentence the panel can show. When
/// the tailnet has not enabled Serve, HTTPS or Funnel yet, the CLI prints the
/// admin link that fixes it — that link is the useful part.
fn serve_failure(stdout: &str, stderr: &str) -> String {
    let text = format!("{stdout}\n{stderr}");
    if let Some(url) = admin_link(&text) {
        let feature = if url.contains("/f/funnel") {
            "Funnel"
        } else {
            "Serve and HTTPS"
        };
        return format!("Tailscale needs {feature} turned on for this Mac: {url}");
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

/// What one port in `tailscale serve status --json` does.
#[derive(Debug, Default, Clone, PartialEq)]
struct PortUse {
    /// Where `/` proxies to, when the port serves a site.
    proxy: Option<String>,
    /// Funnel opens it to the internet.
    funnel: bool,
}

/// Every port the serve config uses. Read leniently, like the status: a
/// config this can't read uses no ports, and the CLI refuses whatever
/// collides when egant then asks for one.
fn serve_ports(json: &str) -> BTreeMap<u16, PortUse> {
    let mut ports = BTreeMap::new();
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return ports;
    };
    // A `serve` or `funnel` running in someone's terminal keeps its entries
    // under `Foreground`, one config per session, beside the persisted one.
    let foreground = value
        .get("Foreground")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|sessions| sessions.values());
    for config in std::iter::once(&value).chain(foreground) {
        let tcp = config.get("TCP").and_then(Value::as_object);
        for port in tcp.into_iter().flat_map(|tcp| tcp.keys()) {
            if let Ok(port) = port.parse() {
                ports.entry(port).or_default();
            }
        }
        let funnel = config.get("AllowFunnel").and_then(Value::as_object);
        let web = config.get("Web").and_then(Value::as_object);
        for (host_port, site) in web.into_iter().flatten() {
            let Some(port) = host_port
                .rsplit_once(':')
                .and_then(|(_, port)| port.parse().ok())
            else {
                continue;
            };
            let entry: &mut PortUse = ports.entry(port).or_default();
            if let Some(proxy) = site.pointer("/Handlers/~1/Proxy").and_then(Value::as_str) {
                entry.proxy = Some(proxy.to_string());
            }
            if funnel
                .and_then(|allowed| allowed.get(host_port))
                .and_then(Value::as_bool)
                == Some(true)
            {
                entry.funnel = true;
            }
        }
    }
    ports
}

fn proxies_to_egant(entry: &PortUse, local_port: u16) -> bool {
    entry.proxy.as_deref().is_some_and(|proxy| {
        let proxy = proxy.trim_end_matches('/');
        proxy == local_target(local_port) || proxy == format!("http://localhost:{local_port}")
    })
}

/// `(serving, conflict)`: whether the HTTPS port already proxies to egant,
/// or is taken by something else.
fn port_state(ports: &BTreeMap<u16, PortUse>, https_port: u16, local_port: u16) -> (bool, bool) {
    match ports.get(&https_port) {
        None => (false, false),
        Some(entry) => {
            let ours = proxies_to_egant(entry, local_port);
            (ours, !ours)
        }
    }
}

/// `(live, free)`: the Funnel port already opening egant to the internet,
/// and the one to open it on otherwise — the first that serves nothing, or
/// serves egant to the tailnet only.
fn funnel_state(ports: &BTreeMap<u16, PortUse>, local_port: u16) -> (Option<u16>, Option<u16>) {
    let live = FUNNEL_PORTS.into_iter().find(|port| {
        ports
            .get(port)
            .is_some_and(|entry| entry.funnel && proxies_to_egant(entry, local_port))
    });
    let free = FUNNEL_PORTS.into_iter().find(|port| {
        ports
            .get(port)
            .is_none_or(|entry| proxies_to_egant(entry, local_port))
    });
    (live, free)
}

#[derive(Debug)]
enum RunError {
    Spawn(std::io::Error),
    Failed {
        stdout: String,
        stderr: String,
    },
    TimedOut {
        stdout: String,
        stderr: String,
    },
    /// Stopped once its output said all it was going to: an admin link to
    /// click, which it would otherwise wait on indefinitely.
    Stopped {
        stdout: String,
        stderr: String,
    },
}

impl std::fmt::Display for RunError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RunError::Spawn(error) => write!(f, "couldn't run tailscale: {error}"),
            RunError::Failed { stdout, stderr } | RunError::Stopped { stdout, stderr } => f
                .write_str(
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

/// Runs the CLI with a deadline.
fn run(cli: &Path, args: &[&str], timeout: Duration) -> Result<Output, RunError> {
    run_until(cli, args, timeout, None)
}

/// [`run`], stopping the CLI early once its output so far satisfies
/// `settled`. Both pipes are drained on their own threads as the CLI writes,
/// so a large answer (`status` lists every peer) can never fill a pipe and
/// stall the child while this waits for it to exit.
fn run_until(
    cli: &Path,
    args: &[&str],
    timeout: Duration,
    settled: Option<&dyn Fn(&str) -> bool>,
) -> Result<Output, RunError> {
    let mut child = Command::new(cli)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(RunError::Spawn)?;
    let drain = |pipe: Option<Box<dyn Read + Send>>| {
        let sink = Arc::new(Mutex::new(Vec::new()));
        let filled = sink.clone();
        let reader = std::thread::spawn(move || {
            let Some(mut pipe) = pipe else { return };
            let mut chunk = [0u8; 8192];
            while let Ok(read) = pipe.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                filled
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .extend_from_slice(&chunk[..read]);
            }
        });
        (sink, reader)
    };
    let (stdout, stdout_reader) = drain(
        child
            .stdout
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let (stderr, stderr_reader) = drain(
        child
            .stderr
            .take()
            .map(|p| Box::new(p) as Box<dyn Read + Send>),
    );
    let text = |sink: &Arc<Mutex<Vec<u8>>>| {
        String::from_utf8_lossy(&sink.lock().unwrap_or_else(PoisonError::into_inner)).into_owned()
    };

    let deadline = Instant::now() + timeout;
    let mut stopped = false;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) if Instant::now() < deadline => {
                if settled.is_some_and(|settled| settled(&text(&stdout)) || settled(&text(&stderr)))
                {
                    stopped = true;
                    let _ = child.kill();
                    let _ = child.wait();
                    break None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break None;
            }
        }
    };
    // A CLI that exited has closed its pipes: read them to the end. One that
    // was killed may have left them open in a child of its own, so what has
    // arrived by now is what there is.
    if status.is_some() {
        let _ = stdout_reader.join();
        let _ = stderr_reader.join();
    }
    let (stdout, stderr) = (text(&stdout), text(&stderr));
    match status {
        Some(status) if status.success() => Ok(Output { stdout }),
        Some(_) => Err(RunError::Failed { stdout, stderr }),
        None if stopped => Err(RunError::Stopped { stdout, stderr }),
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

    fn serve_state(json: &str, https_port: u16, local_port: u16) -> (bool, bool) {
        port_state(&serve_ports(json), https_port, local_port)
    }

    fn funnel(json: &str) -> (Option<u16>, Option<u16>) {
        funnel_state(&serve_ports(json), 47247)
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
        assert_eq!(serve_state("not json", 47247, 47247), (false, false));
    }

    /// Both of egant's entries: the tailnet port, and Funnel on 443.
    const FUNNELED: &str = r#"{
        "TCP": {"443": {"HTTPS": true}, "47247": {"HTTPS": true}},
        "Web": {
            "mac.tail1234.ts.net:443": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:47247"}}},
            "mac.tail1234.ts.net:47247": {"Handlers": {"/": {"Proxy": "http://127.0.0.1:47247"}}}
        },
        "AllowFunnel": {"mac.tail1234.ts.net:443": true}
    }"#;

    #[test]
    fn a_funnel_to_egant_reads_as_the_live_public_link() {
        assert_eq!(funnel(FUNNELED), (Some(443), Some(443)));
        assert_eq!(serve_state(FUNNELED, 47247, 47247), (true, false));
    }

    #[test]
    fn the_funnel_port_is_not_mistaken_for_the_tailnet_port() {
        // Only the Funnel entry: its target names egant's port, but the
        // tailnet port itself serves nothing.
        let json = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47247"}}}},"AllowFunnel":{"mac.tail1234.ts.net:443":true}}"#;
        assert_eq!(serve_state(json, 47247, 47247), (false, false));
        assert_eq!(funnel(json), (Some(443), Some(443)));
    }

    #[test]
    fn funnel_takes_the_next_port_when_443_serves_something_else() {
        let json = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}},"AllowFunnel":{"mac.tail1234.ts.net:443":true}}"#;
        assert_eq!(funnel(json), (None, Some(8443)));
        // Someone else's raw TCP forward holds a port just the same.
        let json =
            r#"{"TCP":{"443":{"TCPForward":"127.0.0.1:22"},"8443":{"TCPForward":"127.0.0.1:22"}}}"#;
        assert_eq!(funnel(json), (None, Some(10000)));
    }

    #[test]
    fn funnel_is_blocked_when_every_port_serves_something_else() {
        let json = r#"{"TCP":{"443":{"HTTPS":true},"8443":{"HTTPS":true},"10000":{"HTTPS":true}},"Web":{
            "mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}},
            "mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3001"}}},
            "mac.tail1234.ts.net:10000":{"Handlers":{"/":{"Path":"/srv/site"}}}}}"#;
        assert_eq!(funnel(json), (None, None));
    }

    #[test]
    fn a_tailnet_only_entry_for_egant_is_opened_rather_than_skipped() {
        let json = r#"{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47247/"}}}}}"#;
        assert_eq!(funnel(json), (None, Some(443)));
    }

    #[test]
    fn a_funnel_held_open_in_a_terminal_counts_too() {
        let json = r#"{"Foreground":{"session-1":{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}},"AllowFunnel":{"mac.tail1234.ts.net:443":true}}}}"#;
        assert_eq!(funnel(json), (None, Some(8443)));
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
        let message = serve_failure(
            "\nFunnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=abc123\n",
            "",
        );
        assert_eq!(
            message,
            "Tailscale needs Funnel turned on for this Mac: https://login.tailscale.com/f/funnel?node=abc123"
        );
        assert_eq!(serve_failure("", "error: boom\nmore"), "error: boom");
    }

    #[test]
    fn a_link_counts_as_printed_once_its_line_is_done() {
        assert!(!names_admin_link(
            "To enable, visit:\n\n   https://login.tailscale.com/f/fun"
        ));
        assert!(names_admin_link(
            "To enable, visit:\n\n   https://login.tailscale.com/f/funnel?node=n1\n"
        ));
        assert!(!names_admin_link(
            "Available on the internet:\nhttps://mac.ts.net/\n"
        ));
    }

    #[test]
    fn the_manual_commands_match_what_egant_runs() {
        assert_eq!(
            serve_command(47247, 47247),
            "tailscale serve --bg --https=47247 http://127.0.0.1:47247"
        );
        assert_eq!(
            funnel_command(47247),
            "tailscale funnel --bg --https=443 http://127.0.0.1:47247"
        );
    }

    /// A stand-in `tailscale` in a scratch folder: a shell script that logs
    /// its arguments beside itself and answers with `body`.
    #[cfg(unix)]
    fn fake_cli(name: &str, body: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let dir =
            std::env::temp_dir().join(format!("egant-tailscale-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("args.log");
        let script = dir.join("tailscale");
        std::fs::write(
            &script,
            format!("#!/bin/sh\necho \"$*\" >> '{}'\n{body}", log.display()),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        (script, log)
    }

    #[cfg(unix)]
    #[test]
    fn funnel_opens_on_the_first_free_port_pointed_at_egant() {
        let (cli, log) = fake_cli(
            "funnel-ok",
            r#"case "$1" in
  serve) echo '{"TCP":{"443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:3000"}}}}}' ;;
  funnel) echo "Available on the internet:"; echo "https://mac.tail1234.ts.net:8443/" ;;
esac
"#,
        );
        assert_eq!(enable_funnel_with(&cli, 47247), Ok(8443));
        let calls = std::fs::read_to_string(&log).unwrap();
        assert_eq!(
            calls.lines().collect::<Vec<_>>(),
            [
                "serve status --json",
                "funnel --bg --yes --https=8443 http://127.0.0.1:47247"
            ]
        );
        let _ = std::fs::remove_dir_all(cli.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn an_open_funnel_to_egant_is_left_as_it_is() {
        let (cli, log) = fake_cli(
            "funnel-live",
            &format!("[ \"$1\" = serve ] && cat <<'JSON'\n{FUNNELED}\nJSON\n"),
        );
        assert_eq!(enable_funnel_with(&cli, 47247), Ok(443));
        assert_eq!(
            std::fs::read_to_string(&log).unwrap(),
            "serve status --json\n"
        );
        let _ = std::fs::remove_dir_all(cli.parent().unwrap());
    }

    #[cfg(unix)]
    #[test]
    fn a_tailnet_without_funnel_answers_with_its_link_at_once() {
        // The real CLI prints the admin link, then waits for it to be
        // clicked for as long as it takes; egant stops it as soon as the
        // link is out.
        let (cli, _log) = fake_cli(
            "funnel-off",
            r#"case "$1" in
  serve) echo '{}' ;;
  funnel) printf '\nFunnel is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/funnel?node=nTEST\n\n'; exec sleep 30 ;;
esac
"#,
        );
        let started = Instant::now();
        let error = enable_funnel_with(&cli, 47247).unwrap_err();
        assert!(
            started.elapsed() < Duration::from_secs(10),
            "took {:?}",
            started.elapsed()
        );
        assert_eq!(
            error,
            "Tailscale needs Funnel turned on for this Mac: https://login.tailscale.com/f/funnel?node=nTEST"
        );
        let _ = std::fs::remove_dir_all(cli.parent().unwrap());
    }
}
