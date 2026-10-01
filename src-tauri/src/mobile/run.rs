//! What the phone's "Run website" pill needs from the Mac: the command a
//! session's project runs with, and whether a site of that session is
//! answering right now.
//!
//! Both come from things the Mac already knows — the project's own manifests,
//! and what is listening on this machine — so the phone never names a path or
//! a port, and nothing here starts a process. Tapping the pill sends the agent
//! a message like any other; it runs the command with its own tools, under
//! the session's own permission mode.
//!
//! [`detect_run_command`] is `src/lib/runCommand.ts` in Rust, so the two
//! screens offer the same command for the same folder.

use serde::Serialize;
use serde_json::Value;
use std::borrow::Cow;
use std::collections::HashSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::timeout;

use egant_harness::TranscriptEntry;

use super::tailscale;

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// What the pill offers: enough to label it and to ask the agent for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunCommand {
    /// What the pill says: "Run website", "Run project".
    pub label: &'static str,
    /// The exact shell line. Always one of a fixed set of shapes with only
    /// the script name filled in from `package.json` — never text a file
    /// wrote — so it is safe to put in a message.
    pub command: String,
    /// Which manifest it came from (`package.json`, `Cargo.toml`, …).
    pub source: &'static str,
}

/// Manifests are read whole; nothing that is not a small regular file is.
const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;

/// The script a person reaches for first: `dev` for a website in progress,
/// `start` for something already runnable, then the rest.
const PACKAGE_SCRIPTS: [&str; 4] = ["dev", "start", "serve", "preview"];

const WEBSITE_DEPS: [&str; 15] = [
    "next",
    "vite",
    "@vitejs/plugin-react",
    "astro",
    "@remix-run/react",
    "@remix-run/node",
    "nuxt",
    "gatsby",
    "@sveltejs/kit",
    "webpack-dev-server",
    "parcel",
    "expo",
    "@angular/cli",
    "vue-cli-service",
    "solid-start",
];

/// The command to offer for the folder `cwd` (a worktree's path, when the
/// session has one), or `None` when nothing on disk says how it runs. Cheap:
/// one directory listing and at most a few small reads.
pub fn detect_run_command(cwd: &Path) -> Option<RunCommand> {
    let names: HashSet<String> = std::fs::read_dir(cwd)
        .ok()?
        .filter_map(|entry| entry.ok()?.file_name().into_string().ok())
        .collect();

    if names.contains("package.json") {
        if let Some(found) = from_package_json(cwd, &names) {
            return Some(found);
        }
    }
    from_cargo(cwd)
        .or_else(|| from_go(&names))
        .or_else(|| from_python(cwd, &names))
        .or_else(|| from_makefile(cwd))
        .or_else(|| from_static_site(&names))
}

/// A small regular file's text — never a pipe, a device or a huge file a
/// symlink happens to point at.
fn read_small(path: &Path) -> Option<String> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_MANIFEST_BYTES {
        return None;
    }
    std::fs::read_to_string(path).ok()
}

/// The package manager, from the lockfiles on disk — the command differs
/// per tool.
fn package_manager(names: &HashSet<String>) -> &'static str {
    let has = |name: &str| names.contains(name);
    if has("bun.lockb") || has("bun.lock") {
        "bun"
    } else if has("pnpm-lock.yaml") {
        "pnpm"
    } else if has("yarn.lock") {
        "yarn"
    } else {
        "npm"
    }
}

fn node_command(manager: &str, script: &str) -> String {
    match manager {
        "bun" => format!("bun run {script}"),
        "pnpm" => format!("pnpm {script}"),
        "yarn" => format!("yarn {script}"),
        _ => format!("npm run {script}"),
    }
}

fn is_website(package: &Value) -> bool {
    ["dependencies", "devDependencies", "peerDependencies"]
        .iter()
        .filter_map(|field| package.get(field)?.as_object())
        .any(|deps| WEBSITE_DEPS.iter().any(|name| deps.contains_key(*name)))
}

fn from_package_json(cwd: &Path, names: &HashSet<String>) -> Option<RunCommand> {
    let package: Value = serde_json::from_str(&read_small(&cwd.join("package.json"))?).ok()?;
    let scripts = package.get("scripts")?.as_object()?;
    let script = PACKAGE_SCRIPTS
        .iter()
        .find(|name| scripts.get(**name).is_some_and(Value::is_string))?;
    Some(RunCommand {
        label: if is_website(&package) {
            "Run website"
        } else {
            "Run project"
        },
        command: node_command(package_manager(names), script),
        source: "package.json",
    })
}

fn from_cargo(cwd: &Path) -> Option<RunCommand> {
    read_small(&cwd.join("Cargo.toml"))?
        .contains("[package]")
        .then(|| RunCommand {
            label: "Run project",
            command: "cargo run".into(),
            source: "Cargo.toml",
        })
}

fn from_go(names: &HashSet<String>) -> Option<RunCommand> {
    names.contains("go.mod").then(|| RunCommand {
        label: "Run project",
        command: "go run .".into(),
        source: "go.mod",
    })
}

fn from_python(cwd: &Path, names: &HashSet<String>) -> Option<RunCommand> {
    // Django first: `manage.py runserver` is the website answer, and a Django
    // tree also tends to carry an `app.py`-looking file that would misfire.
    if names.contains("manage.py") {
        return Some(RunCommand {
            label: "Run website",
            command: "python3 manage.py runserver".into(),
            source: "manage.py",
        });
    }
    if names.contains("main.py") {
        return Some(RunCommand {
            label: "Run project",
            command: "python3 main.py".into(),
            source: "main.py",
        });
    }
    if names.contains("app.py") {
        let source = read_small(&cwd.join("app.py")).unwrap_or_default();
        let source = source.to_ascii_lowercase();
        let website = ["flask", "fastapi", "django", "streamlit"]
            .iter()
            .any(|framework| source.contains(framework));
        return Some(RunCommand {
            label: if website {
                "Run website"
            } else {
                "Run project"
            },
            command: "python3 app.py".into(),
            source: "app.py",
        });
    }
    None
}

fn from_makefile(cwd: &Path) -> Option<RunCommand> {
    // A `run` target: a line that starts with `run`, then a space or colon
    // (or ends there).
    read_small(&cwd.join("Makefile"))?
        .lines()
        .any(|line| {
            line.strip_prefix("run")
                .is_some_and(|rest| rest.is_empty() || rest.starts_with([' ', '\t', ':']))
        })
        .then(|| RunCommand {
            label: "Run project",
            command: "make run".into(),
            source: "Makefile",
        })
}

fn from_static_site(names: &HashSet<String>) -> Option<RunCommand> {
    names.contains("index.html").then(|| RunCommand {
        label: "Run website",
        command: "npx serve .".into(),
        source: "index.html",
    })
}

// ---------------------------------------------------------------------------
// The site
// ---------------------------------------------------------------------------

/// Dev servers listen at or above this; below it is the machine's own
/// services (ssh, a web server, a database) and never what a session started.
const MIN_PORT: u16 = 1024;

/// How many of a transcript's newest entries are read for announcements.
const SCAN_ENTRIES: usize = 60;
/// How much of one tool output is read: where a dev server prints its
/// banner, and the end of it.
const SCAN_HEAD_BYTES: usize = 32 * 1024;
const SCAN_TAIL_BYTES: usize = 8 * 1024;
/// The most ports probed for one session.
const MAX_CANDIDATES: usize = 6;

/// A site that answered: the port, and which loopback address it is on. Vite,
/// for one, listens on `localhost` — which on a current Mac is `::1` alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Site {
    pub port: u16,
    pub addr: IpAddr,
}

impl Site {
    pub fn socket_addr(self) -> SocketAddr {
        SocketAddr::new(self.addr, self.port)
    }

    /// The same port on the other loopback family.
    pub fn other_addr(self) -> SocketAddr {
        SocketAddr::new(other_loopback(self.addr), self.port)
    }
}

pub const LOOPBACKS: [IpAddr; 2] = [
    IpAddr::V4(Ipv4Addr::LOCALHOST),
    IpAddr::V6(Ipv6Addr::LOCALHOST),
];

fn other_loopback(addr: IpAddr) -> IpAddr {
    if addr.is_ipv4() {
        LOOPBACKS[1]
    } else {
        LOOPBACKS[0]
    }
}

/// Ports a session's own words say something is serving on, the newest
/// mention first: URLs the agent wrote in a reply, and the banner a dev
/// server printed into a tool's output (`Local: http://localhost:5173/`).
///
/// Only a hint — what is really up is [`find_site`]'s question — but it is
/// what finds a server that lives somewhere `lsof` cannot tie to the session,
/// and what breaks a tie between two.
pub fn announced_ports(entries: &[TranscriptEntry]) -> Vec<u16> {
    let mut ports = Vec::new();
    for entry in entries.iter().rev().take(SCAN_ENTRIES) {
        let mut found = Vec::new();
        match entry {
            TranscriptEntry::Assistant { text, .. } => mentions(text, &mut found),
            TranscriptEntry::Tool(call) => {
                for part in call.output.iter().flat_map(|output| clips(output)) {
                    mentions(part, &mut found);
                }
            }
            _ => {}
        }
        for port in found.into_iter().rev() {
            if !ports.contains(&port) {
                ports.push(port);
            }
        }
    }
    ports
}

/// The parts of a tool output worth reading.
fn clips(output: &str) -> Vec<&str> {
    if output.len() <= SCAN_HEAD_BYTES + SCAN_TAIL_BYTES {
        return vec![output];
    }
    let mut tail = output.len() - SCAN_TAIL_BYTES;
    while !output.is_char_boundary(tail) {
        tail += 1;
    }
    vec![
        crate::sync::utf8_prefix(output, SCAN_HEAD_BYTES),
        &output[tail..],
    ]
}

const LOCAL_HOSTS: [&str; 5] = ["localhost:", "127.0.0.1:", "0.0.0.0:", "[::1]:", "[::]:"];

/// Every `localhost:PORT`-shaped mention in `text`, in the order written.
fn mentions(text: &str, out: &mut Vec<u16>) {
    // A dev server run with colour puts an escape sequence between the colon
    // and the number: `http://localhost:\x1b[1m5173\x1b[22m/`.
    let text = strip_ansi(text);
    let mut hits: Vec<(usize, u16)> = Vec::new();
    for host in LOCAL_HOSTS {
        for (at, _) in text.match_indices(host) {
            let digits: String = text[at + host.len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if digits.is_empty() || digits.len() > 5 {
                continue;
            }
            if let Ok(port) = digits.parse::<u16>() {
                if port >= MIN_PORT {
                    hits.push((at, port));
                }
            }
        }
    }
    hits.sort_by_key(|(at, _)| *at);
    out.extend(hits.into_iter().map(|(_, port)| port));
}

fn strip_ansi(text: &str) -> Cow<'_, str> {
    if !text.contains('\u{1b}') {
        return Cow::Borrowed(text);
    }
    let mut plain = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            plain.push(c);
        } else if chars.peek() == Some(&'[') {
            chars.next();
            // Parameters and intermediates, then one final byte in `@`..=`~`.
            for next in chars.by_ref() {
                if ('@'..='~').contains(&next) {
                    break;
                }
            }
        }
    }
    Cow::Owned(plain)
}

// -- lsof --------------------------------------------------------------------

const LSOF_TIMEOUT: Duration = Duration::from_secs(4);

/// The TCP ports something under `dir` is listening on.
///
/// `lsof` names every listener on the machine and the directory its process
/// was started in, which is the one thing a dev server reliably says about
/// which checkout it belongs to: two worktrees of one project each run Vite,
/// on 5173 and 5174, and each session finds its own. It also finds a server
/// started from the desktop's terminal, which the transcript knows nothing
/// about. Without `lsof` (or off a Unix) it finds nothing, and the announced
/// ports have to do.
pub fn listening_in(dir: &Path) -> Vec<u16> {
    let Some(lsof) = find_lsof() else {
        return Vec::new();
    };
    let Some(listing) = tailscale::capture(
        &lsof,
        &["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"],
        LSOF_TIMEOUT,
    ) else {
        return Vec::new();
    };
    let listeners = parse_listeners(&listing);
    if listeners.is_empty() {
        return Vec::new();
    }
    let mut pids: Vec<u32> = listeners.iter().map(|(pid, _)| *pid).collect();
    pids.sort_unstable();
    pids.dedup();
    let pids = pids
        .iter()
        .map(u32::to_string)
        .collect::<Vec<_>>()
        .join(",");
    let Some(cwds) = tailscale::capture(
        &lsof,
        &["-nP", "-a", "-d", "cwd", "-Fpn", "-p", pids.as_str()],
        LSOF_TIMEOUT,
    ) else {
        return Vec::new();
    };
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let inside: HashSet<u32> = parse_cwds(&cwds)
        .into_iter()
        .filter(|(_, cwd)| cwd.starts_with(&dir))
        .map(|(pid, _)| pid)
        .collect();
    let mut ports = Vec::new();
    for (pid, port) in listeners {
        if inside.contains(&pid) && !ports.contains(&port) {
            ports.push(port);
        }
    }
    ports
}

fn find_lsof() -> Option<PathBuf> {
    ["/usr/sbin/lsof", "/usr/bin/lsof"]
        .iter()
        .map(PathBuf::from)
        .find(|path| path.is_file())
        .or_else(|| egant_harness::agents::resolve_cli("lsof", None, &[]))
}

/// `(pid, port)` for every listener `lsof -Fpn` names on an address a
/// browser on this machine would reach.
fn parse_listeners(output: &str) -> Vec<(u32, u16)> {
    let mut pid = None;
    let mut found = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse().ok();
        } else if let Some(name) = line.strip_prefix('n') {
            let (Some(pid), Some(port)) = (pid, listener_port(name)) else {
                continue;
            };
            if !found.contains(&(pid, port)) {
                found.push((pid, port));
            }
        }
    }
    found
}

/// The port of an `lsof` address that is loopback or a wildcard — `*:5173`,
/// `127.0.0.1:5173`, `[::1]:5173`, `[::]:5173` — and not a LAN address,
/// which loopback would not reach.
fn listener_port(name: &str) -> Option<u16> {
    let (host, port) = name.rsplit_once(':')?;
    let reachable =
        matches!(host, "*" | "[::1]" | "[::]" | "localhost") || host.starts_with("127.");
    if !reachable {
        return None;
    }
    port.parse().ok().filter(|port| *port >= MIN_PORT)
}

/// `(pid, working directory)` from `lsof -d cwd -Fpn`.
fn parse_cwds(output: &str) -> Vec<(u32, PathBuf)> {
    let mut pid = None;
    let mut found = Vec::new();
    for line in output.lines() {
        if let Some(rest) = line.strip_prefix('p') {
            pid = rest.parse().ok();
        } else if let Some(path) = line.strip_prefix('n') {
            if let Some(pid) = pid {
                found.push((pid, PathBuf::from(path)));
            }
        }
    }
    found
}

// -- probing -----------------------------------------------------------------

const PROBE_CONNECT: Duration = Duration::from_millis(500);
/// A dev server compiles the page it is first asked for, which can take a
/// while. Long enough to read a reply that is on its way; short enough that
/// asking is never slow.
const PROBE_REPLY: Duration = if cfg!(test) {
    // Short enough that the test of a server that never answers is quick,
    // long enough that a busy CI runner can't make a real answer late.
    Duration::from_millis(400)
} else {
    Duration::from_millis(1200)
};
const MAX_HEAD_BYTES: usize = 8 * 1024;

/// How a listener answered `GET /`, best first.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Reply {
    /// A page: 2xx/3xx, HTML.
    Page,
    /// Took the connection and is still thinking — a dev server on its first
    /// compile. Not something that speaks another protocol.
    Slow,
    /// HTTP, but not a page (an API's JSON).
    Data,
    /// HTTP, and an error.
    Failure,
}

impl Reply {
    fn rank(self) -> u8 {
        self as u8
    }
}

/// Asks `port` for its front page on each loopback family, the way a browser
/// resolving `localhost` would. Something that answers in another protocol
/// (a database, a cache) is not a site.
async fn probe(port: u16) -> Option<(Site, Reply)> {
    for addr in LOOPBACKS {
        let connecting = TcpStream::connect(SocketAddr::new(addr, port));
        let Ok(Ok(mut stream)) = timeout(PROBE_CONNECT, connecting).await else {
            continue;
        };
        let request = format!(
            "GET / HTTP/1.1\r\nHost: localhost:{port}\r\nAccept: text/html\r\n\
             User-Agent: egant\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(request.as_bytes()).await.is_err() {
            continue;
        }
        let (head, waited_out) = read_head(&mut stream).await;
        if let Some(reply) = classify(&head, waited_out) {
            return Some((Site { port, addr }, reply));
        }
        // It answered, in something that isn't HTTP: not this family's
        // problem, and not a site on the other either.
        return None;
    }
    None
}

/// The start of a reply: up to the end of its headers, and whether the wait
/// ran out first.
async fn read_head(stream: &mut TcpStream) -> (Vec<u8>, bool) {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 1024];
    let read = timeout(PROBE_REPLY, async {
        while head.len() < MAX_HEAD_BYTES {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    head.extend_from_slice(&chunk[..read]);
                    if head.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
            }
        }
    })
    .await;
    (head, read.is_err())
}

fn classify(head: &[u8], waited_out: bool) -> Option<Reply> {
    if head.is_empty() {
        // Nothing yet, and still open, is a server busy compiling; nothing
        // and closed is a listener that wants no part of this.
        return waited_out.then_some(Reply::Slow);
    }
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let status_line = lines.next()?;
    if !status_line.starts_with("HTTP/1.") {
        return None;
    }
    let status: u16 = status_line.split(' ').nth(1)?.parse().ok()?;
    if status >= 400 {
        return Some(Reply::Failure);
    }
    let html = lines
        .take_while(|line| !line.is_empty())
        .filter_map(|line| line.split_once(':'))
        .any(|(name, value)| {
            name.eq_ignore_ascii_case("content-type")
                && value.to_ascii_lowercase().contains("text/html")
        });
    Some(if html { Reply::Page } else { Reply::Data })
}

/// Every port this session could be serving on, best hunch first: what it
/// announced *and* something started in its folder is listening on; then what
/// is listening there; then what it announced.
fn ordered_candidates(announced: &[u16], listening: &[u16], skip: &[u16]) -> Vec<u16> {
    let mut ordered: Vec<u16> = Vec::new();
    let both = announced.iter().filter(|port| listening.contains(port));
    for port in both.chain(listening).chain(announced) {
        if !skip.contains(port) && !ordered.contains(port) {
            ordered.push(*port);
        }
    }
    ordered
}

/// The ports to probe: the best few, or — when one was asked for — that one,
/// and only if it is among the ports this session could be serving on. A
/// phone picks from what the Mac found; it never names a port of its own.
fn to_probe(announced: &[u16], listening: &[u16], skip: &[u16], wanted: Option<u16>) -> Vec<u16> {
    let mut ordered = ordered_candidates(announced, listening, skip);
    match wanted {
        Some(port) => ordered.retain(|candidate| *candidate == port),
        None => ordered.truncate(MAX_CANDIDATES),
    }
    ordered
}

/// The site `session_dir`'s session is serving right now, if any. `skip` is
/// egant's own ports: never a site, and proxying to them would loop.
///
/// `wanted` asks for one port in particular — a link the agent's own reply
/// held, tapped on the phone — and gets it only if it answers *and* is one of
/// this session's candidates.
pub async fn find_site(
    session_dir: PathBuf,
    announced: Vec<u16>,
    skip: Vec<u16>,
    wanted: Option<u16>,
) -> Option<Site> {
    let listening = tokio::task::spawn_blocking(move || listening_in(&session_dir))
        .await
        .unwrap_or_default();
    find_among(to_probe(&announced, &listening, &skip, wanted)).await
}

/// Probes `ports` together and takes the best answer: a page over a slow
/// starter over an API over an error, then the earlier hunch.
pub(super) async fn find_among(ports: Vec<u16>) -> Option<Site> {
    futures_util::future::join_all(ports.into_iter().map(probe))
        .await
        .into_iter()
        .flatten()
        .enumerate()
        .min_by_key(|(order, (_, reply))| (reply.rank(), *order))
        .map(|(_, (site, _))| site)
}

#[cfg(test)]
mod tests {
    use super::*;
    use egant_harness::ToolCall;
    use serde_json::json;
    use tokio::net::TcpListener;

    fn folder(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for (name, text) in files {
            std::fs::write(dir.path().join(name), text).unwrap();
        }
        dir
    }

    fn detect(files: &[(&str, &str)]) -> Option<(&'static str, String, &'static str)> {
        let dir = folder(files);
        detect_run_command(dir.path()).map(|run| (run.label, run.command, run.source))
    }

    // -- the command ---------------------------------------------------------

    #[test]
    fn a_vite_project_runs_its_dev_script() {
        let package =
            r#"{"scripts":{"dev":"vite","build":"vite build"},"devDependencies":{"vite":"^8"}}"#;
        assert_eq!(
            detect(&[("package.json", package)]),
            Some(("Run website", "npm run dev".into(), "package.json"))
        );
    }

    #[test]
    fn the_lockfile_picks_the_package_manager() {
        let package = r#"{"scripts":{"dev":"next dev"},"dependencies":{"next":"15"}}"#;
        let with = |lock: &str| detect(&[("package.json", package), (lock, "")]).unwrap().1;
        assert_eq!(with("pnpm-lock.yaml"), "pnpm dev");
        assert_eq!(with("yarn.lock"), "yarn dev");
        assert_eq!(with("bun.lockb"), "bun run dev");
        assert_eq!(with("bun.lock"), "bun run dev");
        assert_eq!(with("package-lock.json"), "npm run dev");
    }

    #[test]
    fn dev_wins_over_start_and_a_plain_package_is_a_project() {
        let both = r#"{"scripts":{"start":"node .","dev":"node --watch ."}}"#;
        assert_eq!(
            detect(&[("package.json", both)]),
            Some(("Run project", "npm run dev".into(), "package.json"))
        );
        let start = r#"{"scripts":{"start":"node ."}}"#;
        assert_eq!(
            detect(&[("package.json", start)]).unwrap().1,
            "npm run start"
        );
    }

    #[test]
    fn a_package_with_nothing_to_run_falls_through_to_the_next_manifest() {
        let no_scripts = r#"{"scripts":{"build":"tsc","test":"vitest"}}"#;
        assert_eq!(detect(&[("package.json", no_scripts)]), None);
        assert_eq!(
            detect(&[
                ("package.json", no_scripts),
                ("Cargo.toml", "[package]\nname = \"x\"\n"),
            ]),
            Some(("Run project", "cargo run".into(), "Cargo.toml"))
        );
        // Not JSON at all: skipped, not an error.
        assert_eq!(
            detect(&[("package.json", "{ nope"), ("go.mod", "module x\n")]),
            Some(("Run project", "go run .".into(), "go.mod"))
        );
    }

    #[test]
    fn the_other_ecosystems_have_their_own_command() {
        // A workspace manifest is not a runnable package.
        assert_eq!(
            detect(&[("Cargo.toml", "[workspace]\nmembers = []\n")]),
            None
        );
        assert_eq!(
            detect(&[("manage.py", ""), ("main.py", "")]),
            Some((
                "Run website",
                "python3 manage.py runserver".into(),
                "manage.py"
            ))
        );
        assert_eq!(
            detect(&[("main.py", "print('hi')")]),
            Some(("Run project", "python3 main.py".into(), "main.py"))
        );
        assert_eq!(
            detect(&[("app.py", "from Flask import Flask")]),
            Some(("Run website", "python3 app.py".into(), "app.py"))
        );
        assert_eq!(
            detect(&[("app.py", "print('hi')")]),
            Some(("Run project", "python3 app.py".into(), "app.py"))
        );
        assert_eq!(
            detect(&[("Makefile", "build:\n\tcc x.c\nrun: build\n\t./a.out\n")]),
            Some(("Run project", "make run".into(), "Makefile"))
        );
        assert_eq!(detect(&[("Makefile", "build:\n\tcc x.c\nrunner:\n")]), None);
        assert_eq!(
            detect(&[("index.html", "<html></html>")]),
            Some(("Run website", "npx serve .".into(), "index.html"))
        );
        assert_eq!(detect(&[("notes.txt", "hello")]), None);
    }

    #[test]
    fn a_folder_that_isnt_one_offers_nothing() {
        assert_eq!(detect_run_command(Path::new("/definitely/not/here")), None);
    }

    #[test]
    fn an_oversized_manifest_is_left_unread() {
        let dir = folder(&[]);
        let big = format!(
            r#"{{"scripts":{{"dev":"vite"}},"pad":"{}"}}"#,
            "x".repeat(MAX_MANIFEST_BYTES as usize)
        );
        std::fs::write(dir.path().join("package.json"), big).unwrap();
        assert_eq!(detect_run_command(dir.path()), None);
    }

    // -- announced ports -----------------------------------------------------

    fn said(text: &str) -> TranscriptEntry {
        TranscriptEntry::Assistant {
            text: text.into(),
            streaming: false,
        }
    }

    fn printed(output: &str) -> TranscriptEntry {
        TranscriptEntry::Tool(ToolCall {
            id: "t".into(),
            name: "Bash".into(),
            input: json!({"command": "npm run dev"}),
            output: Some(output.into()),
            is_error: false,
            children: Vec::new(),
        })
    }

    #[test]
    fn a_dev_servers_banner_and_the_agents_reply_both_announce_a_port() {
        let entries = vec![
            printed("  VITE v8.3.0  ready in 196 ms\n\n  ➜  Local:   http://localhost:5173/\n"),
            said("It's up at http://localhost:5173 — the API is on 127.0.0.1:3001."),
        ];
        // Newest mention first, and the later mention in a text first.
        assert_eq!(announced_ports(&entries), vec![3001, 5173]);
    }

    #[test]
    fn colour_codes_inside_the_url_do_not_hide_the_port() {
        let bold = "  \u{1b}[32m➜\u{1b}[39m  Local:   http://localhost:\u{1b}[1m5174\u{1b}[22m/";
        assert_eq!(announced_ports(&[printed(bold)]), vec![5174]);
        assert_eq!(
            announced_ports(&[printed("Listening on 0.0.0.0:8000 and [::1]:8001")]),
            vec![8001, 8000]
        );
    }

    #[test]
    fn what_isnt_a_dev_port_or_a_local_address_is_ignored() {
        let entries = vec![
            said("Postgres is on localhost:5432? No — https://example.com:8443 and localhost:80."),
            said("ssh -p 22 localhost:22, or localhost:99999, or localhost:"),
            TranscriptEntry::User {
                text: "check localhost:4000".into(),
            },
        ];
        // 5432 is a valid port and gets probed later (a database is not a
        // website and drops out there); the rest never make it that far.
        assert_eq!(announced_ports(&entries), vec![5432]);
    }

    #[test]
    fn only_the_newest_entries_are_read_and_repeats_count_once() {
        let mut entries = vec![said("old: localhost:4444")];
        entries.extend((0..SCAN_ENTRIES).map(|_| said("nothing to see")));
        entries.push(said("localhost:5000, again localhost:5000"));
        assert_eq!(announced_ports(&entries), vec![5000]);
    }

    #[test]
    fn a_long_outputs_banner_is_read_though_it_scrolled_out_of_the_tail() {
        let long = format!(
            "Local: http://localhost:5173/\n{}\nrequest handled",
            "log line\n".repeat(20_000)
        );
        assert_eq!(announced_ports(&[printed(&long)]), vec![5173]);
    }

    // -- lsof ----------------------------------------------------------------

    #[test]
    fn listeners_come_out_of_lsofs_field_output_by_pid() {
        let listing = "p3662\nn[::1]:5999\np4001\nn*:5173\nn*:5173\np4002\nn192.168.1.5:3000\n\
                       p4003\nn127.0.0.1:8080\nn*:80\np4004\nn[::]:6006\n";
        assert_eq!(
            parse_listeners(listing),
            vec![(3662, 5999), (4001, 5173), (4003, 8080), (4004, 6006)]
        );
        assert_eq!(parse_listeners(""), vec![]);
    }

    #[test]
    fn working_directories_come_out_of_lsofs_field_output_by_pid() {
        let cwds = "p3662\nfcwd\nn/Users/me/egant-mobile\np4001\nfcwd\nn/Users/me/other project\n";
        assert_eq!(
            parse_cwds(cwds),
            vec![
                (3662, PathBuf::from("/Users/me/egant-mobile")),
                (4001, PathBuf::from("/Users/me/other project")),
            ]
        );
    }

    // -- which port to try ---------------------------------------------------

    #[test]
    fn a_port_both_announced_and_listening_in_the_folder_goes_first() {
        assert_eq!(
            to_probe(&[3001, 5173], &[5174, 5173], &[], None),
            vec![5173, 5174, 3001]
        );
        assert_eq!(to_probe(&[3001], &[], &[], None), vec![3001]);
        assert_eq!(to_probe(&[], &[5174], &[], None), vec![5174]);
    }

    #[test]
    fn egants_own_ports_are_never_candidates_and_the_list_is_bounded() {
        assert_eq!(
            to_probe(&[47247, 5173], &[47248], &[47247, 47248], None),
            vec![5173]
        );
        let many: Vec<u16> = (4000..4100).collect();
        assert_eq!(to_probe(&many, &[], &[], None).len(), MAX_CANDIDATES);
    }

    #[test]
    fn a_port_asked_for_is_probed_only_if_the_session_could_be_serving_on_it() {
        // A link the agent wrote, or a listener in the session's folder.
        assert_eq!(to_probe(&[3001, 5173], &[], &[], Some(3001)), vec![3001]);
        assert_eq!(to_probe(&[], &[5174], &[], Some(5174)), vec![5174]);
        // A port nothing about this session points at is never reached for.
        assert_eq!(
            to_probe(&[5173], &[5174], &[], Some(6379)),
            Vec::<u16>::new()
        );
        assert_eq!(to_probe(&[], &[], &[], Some(5173)), Vec::<u16>::new());
        // Not egant's own, whoever asks.
        assert_eq!(
            to_probe(&[47247], &[47248], &[47247, 47248], Some(47247)),
            Vec::<u16>::new()
        );
        // The bound on the plain list is not a bound on what can be asked for.
        let many: Vec<u16> = (4000..4100).collect();
        assert_eq!(to_probe(&many, &[], &[], Some(4099)), vec![4099]);
    }

    // -- probing -------------------------------------------------------------

    /// A listener on `addr` answering every connection with `reply`, then
    /// closing (or, for `None`, holding it open and silent).
    async fn serve(addr: &str, reply: Option<&'static str>) -> Option<u16> {
        let listener = TcpListener::bind(addr).await.ok()?;
        let port = listener.local_addr().ok()?.port();
        tokio::spawn(async move {
            loop {
                let Ok((mut stream, _)) = listener.accept().await else {
                    return;
                };
                tokio::spawn(async move {
                    let mut request = [0u8; 512];
                    let _ = stream.read(&mut request).await;
                    match reply {
                        Some(reply) => {
                            let _ = stream.write_all(reply.as_bytes()).await;
                        }
                        None => tokio::time::sleep(Duration::from_secs(5)).await,
                    }
                });
            }
        });
        Some(port)
    }

    const HTML: &str = "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 2\r\n\r\nhi";
    const JSON: &str =
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}";
    const MISSING: &str =
        "HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 0\r\n\r\n";

    #[tokio::test]
    async fn a_page_is_found_on_whichever_loopback_it_listens() {
        let v4 = serve("127.0.0.1:0", Some(HTML)).await.unwrap();
        let (site, reply) = probe(v4).await.unwrap();
        assert_eq!((site.addr, reply), (LOOPBACKS[0], Reply::Page));

        // Vite on a current Mac: `localhost` is `::1` and nothing else.
        if let Some(v6) = serve("[::1]:0", Some(HTML)).await {
            let (site, reply) = probe(v6).await.unwrap();
            assert_eq!((site.addr, reply), (LOOPBACKS[1], Reply::Page));
            assert_eq!(site.socket_addr().to_string(), format!("[::1]:{v6}"));
            assert_eq!(site.other_addr().to_string(), format!("127.0.0.1:{v6}"));
        }
    }

    #[tokio::test]
    async fn what_answers_in_another_protocol_or_not_at_all_is_not_a_site() {
        let redis = serve("127.0.0.1:0", Some("-ERR unknown command\r\n"))
            .await
            .unwrap();
        assert!(probe(redis).await.is_none());
        let hangs_up = serve("127.0.0.1:0", Some("")).await.unwrap();
        assert!(probe(hangs_up).await.is_none());
        // Nothing listening: port 1, which no test can be handed by the OS (it
        // is below the range `bind(0)` draws from). A port bound and let go is
        // not safe — a test running at the same moment may be given it.
        assert!(probe(1).await.is_none());
    }

    #[tokio::test]
    async fn a_server_still_compiling_counts_as_up() {
        let slow = serve("127.0.0.1:0", None).await.unwrap();
        let (_, reply) = probe(slow).await.unwrap();
        assert_eq!(reply, Reply::Slow);
    }

    #[tokio::test]
    async fn a_page_beats_an_api_beats_an_error_and_ties_go_to_the_earlier_hunch() {
        let api = serve("127.0.0.1:0", Some(JSON)).await.unwrap();
        let missing = serve("127.0.0.1:0", Some(MISSING)).await.unwrap();
        let page = serve("127.0.0.1:0", Some(HTML)).await.unwrap();
        let other_page = serve("127.0.0.1:0", Some(HTML)).await.unwrap();

        let best = |ports: Vec<u16>| async move { find_among(ports).await.map(|site| site.port) };
        assert_eq!(best(vec![missing, api, page]).await, Some(page));
        assert_eq!(best(vec![missing, api]).await, Some(api));
        assert_eq!(best(vec![missing]).await, Some(missing));
        assert_eq!(best(vec![other_page, page]).await, Some(other_page));
        assert_eq!(best(vec![]).await, None);
    }
}
