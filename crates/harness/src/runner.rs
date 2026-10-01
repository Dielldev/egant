//! Short-lived-turn runner shared by CLIs without a persistent session wire.
//!
//! `opencode run` and `codex exec` each execute ONE turn per process: the
//! prompt goes on the command line, JSON-lines events stream on stdout, and
//! the process exits when the turn settles. The runner owns those children on
//! a background thread, translates stdout into [`HarnessEvent`]s, and keeps
//! the session alive across turns — the transcript never sees a process
//! boundary, only turns. `Exited` is emitted exactly once, on shutdown.
//!
//! Interrupt kills the turn's child and settles the turn as interrupted; a
//! send that lands mid-turn queues behind it, matching the persistent CLIs,
//! where a second message waits for the running turn.

use crate::{HarnessEvent, SessionId};
use async_channel::{Receiver, Sender};
use async_process::{Command, Stdio};
use futures_lite::{AsyncBufReadExt as _, StreamExt as _, io::BufReader};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// How the runner starts one turn.
pub struct TurnRequest {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// Translates one CLI's JSON-lines stdout into harness events. Owned by the
/// runner thread; `build` reads whatever session id the previous turn
/// discovered, so resume flags survive across turns.
pub trait TurnTranslator: Send + 'static {
    fn build(&mut self, text: &str, images: &[PathBuf]) -> TurnRequest;
    /// Zero or more events for one stdout line. Never fails the turn — an
    /// unparseable line contributes nothing.
    fn push_line(&mut self, line: &str) -> Vec<HarnessEvent>;
    /// The turn's process ended (or was interrupted): settle the turn.
    /// `exit` is the status when the process exited on its own, and `stderr`
    /// the last of what it wrote there — where both CLIs say why they failed
    /// (a resumed session that no longer exists, a flag they reject) when
    /// stdout says nothing at all.
    fn end_turn(
        &mut self,
        interrupted: bool,
        exit: Option<i32>,
        stderr: Option<&str>,
    ) -> Vec<HarnessEvent>;
    /// A synthetic `Ready` once the backend's session id is known. Called
    /// after every line; returns `Some` exactly once per session.
    fn take_ready(&mut self) -> Option<HarnessEvent>;
    /// The backend's session id, for `Harness::session_id`.
    fn session_id(&self) -> Option<SessionId>;
    /// A turn that never started (spawn failure): one failed turn carrying
    /// the message, which the transcript renders as a single error notice.
    fn turn_failed(&mut self, message: &str) -> Vec<HarnessEvent> {
        vec![HarnessEvent::TurnEnded {
            result: Some(message.to_string()),
            is_error: true,
            duration_ms: 0,
            cost_usd: 0.0,
            usage: crate::TurnUsage::default(),
        }]
    }
}

pub enum RunnerCommand {
    Send(String, Vec<PathBuf>),
    Interrupt,
    Shutdown,
}

pub struct Runner {
    commands: Sender<RunnerCommand>,
    events: Receiver<HarnessEvent>,
    session: Arc<Mutex<Option<SessionId>>>,
}

impl Runner {
    pub fn spawn<T: TurnTranslator>(translator: T) -> Self {
        let (command_tx, command_rx) = async_channel::unbounded::<RunnerCommand>();
        // Bounded so a stalled UI applies backpressure instead of growing the
        // queue without limit during a long tool-heavy turn.
        let (event_tx, event_rx) = async_channel::bounded::<HarnessEvent>(1024);
        let session = Arc::new(Mutex::new(None));
        let session_writer = session.clone();
        std::thread::Builder::new()
            .name("egant-turn-runner".into())
            .spawn(move || {
                futures_lite::future::block_on(run_loop(
                    translator,
                    command_rx,
                    event_tx,
                    session_writer,
                ));
            })
            .expect("turn runner thread spawns");
        Self {
            commands: command_tx,
            events: event_rx,
            session,
        }
    }

    pub fn send(&self, text: String, images: Vec<PathBuf>) {
        let _ = self.commands.try_send(RunnerCommand::Send(text, images));
    }

    pub fn interrupt(&self) {
        let _ = self.commands.try_send(RunnerCommand::Interrupt);
    }

    pub fn shutdown(&self) {
        let _ = self.commands.try_send(RunnerCommand::Shutdown);
    }

    pub fn events(&self) -> Receiver<HarnessEvent> {
        self.events.clone()
    }

    pub fn session_id(&self) -> Option<SessionId> {
        self.session.lock().ok().and_then(|id| id.clone())
    }
}

impl Drop for Runner {
    fn drop(&mut self) {
        // The loop exits when the last sender goes away; `kill_on_drop` on
        // every child is the backstop if a turn is in flight.
        self.shutdown();
    }
}

async fn run_loop<T: TurnTranslator>(
    mut translator: T,
    commands: Receiver<RunnerCommand>,
    events: Sender<HarnessEvent>,
    session: Arc<Mutex<Option<SessionId>>>,
) {
    let mut queue: VecDeque<(String, Vec<PathBuf>)> = VecDeque::new();
    loop {
        let command = match commands.recv().await {
            Ok(command) => command,
            // The harness is gone: no more turns will ever arrive.
            Err(_) => break,
        };
        match command {
            RunnerCommand::Send(text, images) => {
                let mut shutdown = run_turn(
                    &mut translator,
                    &commands,
                    &events,
                    &session,
                    text,
                    images,
                    &mut queue,
                )
                .await;
                while !shutdown {
                    let Some((next, next_images)) = queue.pop_front() else {
                        break;
                    };
                    shutdown = run_turn(
                        &mut translator,
                        &commands,
                        &events,
                        &session,
                        next,
                        next_images,
                        &mut queue,
                    )
                    .await;
                }
                if shutdown {
                    break;
                }
            }
            // Idle: nothing to stop.
            RunnerCommand::Interrupt => {}
            RunnerCommand::Shutdown => {
                let _ = events.send(HarnessEvent::Exited { code: None }).await;
                break;
            }
        }
    }
}

enum Next {
    Line(Option<std::io::Result<String>>),
    Command(Result<RunnerCommand, async_channel::RecvError>),
}

/// Runs one turn to completion. Returns whether the session is shutting down.
async fn run_turn<T: TurnTranslator>(
    translator: &mut T,
    commands: &Receiver<RunnerCommand>,
    events: &Sender<HarnessEvent>,
    session: &Arc<Mutex<Option<SessionId>>>,
    text: String,
    images: Vec<PathBuf>,
    queue: &mut VecDeque<(String, Vec<PathBuf>)>,
) -> bool {
    let request = translator.build(&text, &images);
    let program = request.program.display().to_string();
    log::info!(
        "turn start program={program} cwd={} ({} chars)",
        request.cwd.display(),
        text.len()
    );
    let mut child = match Command::new(&request.program)
        .args(&request.args)
        .current_dir(&request.cwd)
        // The prompt travels on the command line; an open stdin only invites
        // a CLI to wait on it.
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            // A spawn failure is a turn that never started: one error notice
            // via the settled turn, and the session stays usable.
            let message = format!("Could not start `{program}`: {error}");
            log::error!("turn spawn failed: {message}");
            send_all(events, translator.turn_failed(&message)).await;
            return false;
        }
    };

    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        log::error!("turn `{program}` started without stdout");
        send_all(
            events,
            translator.turn_failed(&format!("`{program}` started without stdout")),
        )
        .await;
        return false;
    };
    let stderr = child.stderr.take().map(StderrTail::collect);

    let mut lines = BufReader::new(stdout).lines();
    let mut interrupted = false;
    let mut shutdown = false;
    loop {
        let line = async { Next::Line(lines.next().await) };
        let command = async { Next::Command(commands.recv().await) };
        match futures_lite::future::or(line, command).await {
            Next::Line(None) => break,
            Next::Line(Some(Ok(line))) => {
                if line.trim().is_empty() {
                    continue;
                }
                send_all(events, translator.push_line(&line)).await;
                if let Some(ready) = translator.take_ready() {
                    let _ = events.send(ready).await;
                }
                if let Ok(mut slot) = session.lock() {
                    *slot = translator.session_id();
                }
            }
            Next::Line(Some(Err(error))) => {
                let _ = events
                    .send(HarnessEvent::Error {
                        message: format!("read error: {error}"),
                    })
                    .await;
                break;
            }
            Next::Command(Ok(RunnerCommand::Send(text, images))) => {
                queue.push_back((text, images));
            }
            Next::Command(Ok(RunnerCommand::Interrupt)) => {
                log::info!("turn interrupted: {program}");
                interrupted = true;
                let _ = child.kill();
                let _ = child.status().await;
                break;
            }
            Next::Command(Ok(RunnerCommand::Shutdown)) => {
                log::info!("turn shutdown: {program}");
                interrupted = true;
                shutdown = true;
                let _ = child.kill();
                let _ = child.status().await;
                break;
            }
            // The harness is gone mid-turn: stop the child and end the thread.
            Next::Command(Err(_)) => {
                interrupted = true;
                shutdown = true;
                let _ = child.kill();
                let _ = child.status().await;
                break;
            }
        }
    }

    let exit = if interrupted {
        // Already reaped on the kill path.
        None
    } else {
        child.status().await.ok().and_then(|status| status.code())
    };
    log::info!("turn end program={program} interrupted={interrupted} exit={exit:?}");
    let stderr = stderr.and_then(StderrTail::finish);
    if exit.is_some_and(|code| code != 0) {
        if let Some(tail) = &stderr {
            log::warn!("turn `{program}` failed; stderr ends:\n{tail}");
        }
    }
    send_all(
        events,
        translator.end_turn(interrupted, exit, stderr.as_deref()),
    )
    .await;
    if shutdown {
        let _ = events.send(HarnessEvent::Exited { code: None }).await;
    }
    shutdown
}

/// How much of a turn's stderr is kept: its last lines, and at most this
/// many characters of them. A CLI that fails says why in its closing lines;
/// one that logs as it goes must not grow the buffer for the whole turn.
const STDERR_TAIL_LINES: usize = 12;
const STDERR_TAIL_CHARS: usize = 2_000;

/// The last lines a turn's process wrote to stderr, read on a thread of
/// their own. Read concurrently because an unread pipe fills: a chatty CLI
/// would block on its next write and never finish the turn. A thread rather
/// than another branch of the turn's own loop, because a grandchild that
/// inherited the pipe (a language server, an MCP server) can hold it open
/// long after the turn is over, and the turn must not wait on it.
struct StderrTail {
    lines: Arc<Mutex<VecDeque<String>>>,
    done: std::sync::mpsc::Receiver<()>,
}

impl StderrTail {
    fn collect(stderr: async_process::ChildStderr) -> Self {
        let lines = Arc::new(Mutex::new(VecDeque::new()));
        let (done_tx, done) = std::sync::mpsc::channel();
        let tail = lines.clone();
        let spawned = std::thread::Builder::new()
            .name("egant-turn-stderr".into())
            .spawn(move || {
                futures_lite::future::block_on(async {
                    let mut reader = BufReader::new(stderr).lines();
                    while let Some(Ok(line)) = reader.next().await {
                        let line = strip_ansi(&line);
                        if line.trim().is_empty() {
                            continue;
                        }
                        log::debug!("turn stderr: {line}");
                        if let Ok(mut tail) = tail.lock() {
                            tail.push_back(line);
                            while tail.len() > STDERR_TAIL_LINES {
                                tail.pop_front();
                            }
                        }
                    }
                });
                let _ = done_tx.send(());
            });
        if let Err(error) = spawned {
            log::warn!("couldn't read the turn's stderr: {error}");
        }
        Self { lines, done }
    }

    /// The tail, once the process is gone. Its last lines can still be in
    /// the pipe as it exits, so this waits a moment for the reader to reach
    /// the end — briefly, for the grandchild that never lets it.
    fn finish(self) -> Option<String> {
        let _ = self
            .done
            .recv_timeout(std::time::Duration::from_millis(250));
        let lines = self.lines.lock().ok()?;
        let text = lines.iter().cloned().collect::<Vec<_>>().join("\n");
        let text = text.trim();
        if text.is_empty() {
            return None;
        }
        // Keep the end: that is where a failure is explained.
        let count = text.chars().count();
        Some(if count > STDERR_TAIL_CHARS {
            let tail: String = text.chars().skip(count - STDERR_TAIL_CHARS).collect();
            format!("…{tail}")
        } else {
            text.to_string()
        })
    }
}

/// A line without its terminal colours: opencode prints its errors in red
/// and bold (`\x1b[91m\x1b[1mError: \x1b[0m…`), which a notice would show as
/// escape junk.
fn strip_ansi(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\x1b' {
            out.push(c);
            continue;
        }
        // CSI: ESC [ parameters, then one final byte in `@`..=`~`.
        if chars.peek() == Some(&'[') {
            chars.next();
            for c in chars.by_ref() {
                if ('@'..='~').contains(&c) {
                    break;
                }
            }
        }
    }
    out
}

/// What a failed turn tells the person: the exit status, and under it the
/// tail of what the CLI wrote to stderr, when it wrote anything.
pub(crate) fn exit_message(cli: &str, code: i32, stderr: Option<&str>) -> String {
    match stderr {
        Some(tail) => format!("{cli} exited with status {code}:\n{tail}"),
        None => format!("{cli} exited with status {code}."),
    }
}

async fn send_all(events: &Sender<HarnessEvent>, batch: Vec<HarnessEvent>) {
    for event in batch {
        if events.send(event).await.is_err() {
            return; // receiver dropped: the session's UI is gone.
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `codex exec … resume <id>` writes when the thread is gone —
    /// captured from codex-cli 0.155.0, which printed nothing on stdout and
    /// exited 1.
    const CODEX_RESUME_GONE: &str = "Error: thread/resume: thread/resume failed: no rollout found for thread id 00000000-0000-4000-8000-000000000000 (code -32600)";

    /// What `opencode run -s <id>` writes when the session is gone —
    /// captured from opencode 1.18.31, colours and all, likewise exit 1.
    const OPENCODE_SESSION_GONE: &str = "\x1b[91m\x1b[1mError: \x1b[0mSession not found";

    /// A CLI stand-in: runs `script` under `sh`, and settles the turn with
    /// whatever the runner hands `end_turn`.
    struct Script(String);

    impl TurnTranslator for Script {
        fn build(&mut self, _text: &str, _images: &[PathBuf]) -> TurnRequest {
            TurnRequest {
                program: PathBuf::from("/bin/sh"),
                args: vec!["-c".into(), self.0.clone()],
                cwd: std::env::temp_dir(),
            }
        }
        fn push_line(&mut self, _line: &str) -> Vec<HarnessEvent> {
            Vec::new()
        }
        fn end_turn(
            &mut self,
            _interrupted: bool,
            exit: Option<i32>,
            stderr: Option<&str>,
        ) -> Vec<HarnessEvent> {
            vec![HarnessEvent::TurnEnded {
                result: Some(exit_message("cli", exit.unwrap_or(0), stderr)),
                is_error: true,
                duration_ms: 0,
                cost_usd: 0.0,
                usage: crate::TurnUsage::default(),
            }]
        }
        fn take_ready(&mut self) -> Option<HarnessEvent> {
            None
        }
        fn session_id(&self) -> Option<SessionId> {
            None
        }
    }

    fn turn_result(script: &str) -> String {
        let runner = Runner::spawn(Script(script.to_string()));
        runner.send("hi".into(), Vec::new());
        let events = runner.events();
        loop {
            match futures_lite::future::block_on(events.recv()).expect("the turn settles") {
                HarnessEvent::TurnEnded { result, .. } => return result.unwrap_or_default(),
                _ => continue,
            }
        }
    }

    #[test]
    fn a_failed_turn_says_what_the_cli_wrote_to_stderr() {
        let result = turn_result(&format!("echo '{CODEX_RESUME_GONE}' >&2; exit 1"));
        assert_eq!(
            result,
            format!("cli exited with status 1:\n{CODEX_RESUME_GONE}")
        );
    }

    #[test]
    fn its_colours_are_left_behind() {
        let result = turn_result(&format!("printf '{OPENCODE_SESSION_GONE}\\n' >&2; exit 1"));
        assert_eq!(
            result,
            "cli exited with status 1:\nError: Session not found"
        );
    }

    #[test]
    fn only_the_end_of_a_long_stderr_is_kept() {
        let result = turn_result("for i in $(seq 1 40); do echo \"line $i\" >&2; done; exit 2");
        let tail = result.strip_prefix("cli exited with status 2:\n").unwrap();
        assert_eq!(tail.lines().count(), STDERR_TAIL_LINES);
        assert_eq!(tail.lines().last(), Some("line 40"));
        assert_eq!(tail.lines().next(), Some("line 29"));
    }

    #[test]
    fn a_silent_failure_still_reads_as_one() {
        assert_eq!(turn_result("exit 3"), "cli exited with status 3.");
    }

    #[test]
    fn colours_are_stripped_and_text_is_kept() {
        assert_eq!(
            strip_ansi(OPENCODE_SESSION_GONE),
            "Error: Session not found"
        );
        assert_eq!(strip_ansi("plain"), "plain");
        assert_eq!(strip_ansi("\x1b[2K\x1b[1Gdone"), "done");
    }
}
