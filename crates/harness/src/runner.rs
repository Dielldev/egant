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
    /// `exit` is the status when the process exited on its own.
    fn end_turn(&mut self, interrupted: bool, exit: Option<i32>) -> Vec<HarnessEvent>;
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
        .stderr(Stdio::null())
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
    send_all(events, translator.end_turn(interrupted, exit)).await;
    if shutdown {
        let _ = events.send(HarnessEvent::Exited { code: None }).await;
    }
    shutdown
}

async fn send_all(events: &Sender<HarnessEvent>, batch: Vec<HarnessEvent>) {
    for event in batch {
        if events.send(event).await.is_err() {
            return; // receiver dropped: the session's UI is gone.
        }
    }
}
