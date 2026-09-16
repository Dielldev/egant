//! Terminals — one real PTY per terminal tab in the workspace panel.
//!
//! The panel's terminal is a shell, not a command runner: `portable-pty` opens
//! a pseudo-terminal, the user's login shell is spawned into it with the
//! session's working directory, and the bytes it writes are pushed at the
//! webview as `pty-output` events for xterm.js to render. Keystrokes come back
//! the other way through [`pty_write`].
//!
//! Ownership is split deliberately. The registry here holds only what the
//! frontend needs to reach into a live terminal — the writer, the master (for
//! resize) and the child (to kill it). Reading happens on a thread of its own
//! that owns a cloned reader and never takes the registry lock, so a shell
//! spewing output can't block a keystroke going the other way.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::Mutex;

use portable_pty::{Child, CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// What one terminal tab holds open. Dropping it kills the shell, which is
/// what closing a tab does.
struct Terminal {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for Terminal {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub struct Terminals {
    next_id: u64,
    live: HashMap<u64, Terminal>,
}

pub type PtyState<'a> = tauri::State<'a, Mutex<Terminals>>;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutput {
    id: u64,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    id: u64,
}

/// Opens a shell in `cwd` and returns the id the frontend addresses it by.
///
/// The shell is started as a login shell (`-l`): launched from Finder the app
/// inherits a bare `PATH`, so without reading the user's own profile the
/// terminal would be missing every tool they actually have installed.
#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: PtyState<'_>,
    cwd: String,
    cols: u16,
    rows: u16,
) -> Result<u64, String> {
    let pair = NativePtySystem::default()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;

    let mut command = CommandBuilder::new(shell());
    #[cfg(unix)]
    command.arg("-l");
    command.cwd(start_dir(&cwd));
    // xterm.js speaks full 256-colour/truecolor; say so, or the shell and
    // everything it runs will assume a dumb terminal and drop the colour.
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    // The slave has to go once the child holds it, or the master never sees
    // EOF and the reader thread below would hang forever on a dead shell.
    drop(pair.slave);

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;

    let mut guard = state.lock().unwrap();
    guard.next_id += 1;
    let id = guard.next_id;
    guard.live.insert(
        id,
        Terminal {
            master: pair.master,
            writer,
            child,
        },
    );
    drop(guard);

    std::thread::spawn(move || pump(app, id, reader));
    Ok(id)
}

/// Reads the shell's output and forwards it to the webview until the shell
/// exits. Owns its reader outright — no lock is taken on this path.
fn pump(app: AppHandle, id: u64, mut reader: Box<dyn Read + Send>) {
    let mut chunk = [0u8; 8192];
    let mut pending: Vec<u8> = Vec::new();
    loop {
        match reader.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                pending.extend_from_slice(&chunk[..read]);
                let text = drain_utf8(&mut pending);
                if !text.is_empty() {
                    let _ = app.emit("pty-output", PtyOutput { id, data: text });
                }
            }
        }
    }
    let _ = app.emit("pty-exit", PtyExit { id });
}

/// Takes everything decodable off the front of `buf`, leaving a multi-byte
/// sequence that a read split in half for the next chunk to complete. Without
/// this, a UTF-8 character landing on an 8 KB boundary would come out as two
/// replacement characters.
fn drain_utf8(buf: &mut Vec<u8>) -> String {
    let mut out = String::new();
    loop {
        match std::str::from_utf8(buf) {
            Ok(text) => {
                out.push_str(text);
                buf.clear();
                return out;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                out.push_str(&String::from_utf8_lossy(&buf[..valid]));
                match error.error_len() {
                    // A byte that can never begin a sequence: mark it and
                    // carry on with whatever follows.
                    Some(len) => {
                        out.push('\u{fffd}');
                        buf.drain(..valid + len);
                    }
                    // Cut off mid-character by the chunk boundary: keep the
                    // tail for the next read.
                    None => {
                        buf.drain(..valid);
                        return out;
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub fn pty_write(state: PtyState<'_>, id: u64, data: String) -> Result<(), String> {
    let mut guard = state.lock().unwrap();
    let terminal = guard
        .live
        .get_mut(&id)
        .ok_or_else(|| format!("terminal {id} is closed"))?;
    terminal
        .writer
        .write_all(data.as_bytes())
        .and_then(|()| terminal.writer.flush())
        .map_err(|error| error.to_string())
}

/// Tells the shell its new size. Programs like `vim` and `top` only redraw
/// correctly if the kernel's window size matches what xterm.js is showing.
#[tauri::command]
pub fn pty_resize(state: PtyState<'_>, id: u64, cols: u16, rows: u16) -> Result<(), String> {
    let guard = state.lock().unwrap();
    let Some(terminal) = guard.live.get(&id) else {
        // A resize racing a closed tab is not worth an error in the UI.
        return Ok(());
    };
    terminal
        .master
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())
}

/// Closing a terminal tab. Idempotent: the reader thread may already have seen
/// the shell exit and dropped it.
#[tauri::command]
pub fn pty_kill(state: PtyState<'_>, id: u64) -> Result<(), String> {
    state.lock().unwrap().live.remove(&id);
    Ok(())
}

/// Where the shell opens. A window with no project yet has no directory to
/// offer, and a project that moved since the session was saved no longer has
/// one — either way, home is a better answer than a failed spawn.
fn start_dir(cwd: &str) -> std::path::PathBuf {
    let path = std::path::Path::new(cwd);
    if !cwd.is_empty() && path.is_dir() {
        return path.to_path_buf();
    }
    std::env::var_os("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
}

/// The user's own shell, falling back to a sensible default per platform.
fn shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_directory_is_kept_and_anything_else_falls_home() {
        let temp = std::env::temp_dir();
        assert_eq!(start_dir(&temp.display().to_string()), temp);

        let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
        if let Some(home) = home {
            assert_eq!(start_dir(""), home);
            assert_eq!(start_dir("/nope/not/a/directory"), home);
        }
    }

    #[test]
    fn whole_characters_come_through_intact() {
        let mut buf = "héllo →".as_bytes().to_vec();
        assert_eq!(drain_utf8(&mut buf), "héllo →");
        assert!(buf.is_empty());
    }

    #[test]
    fn a_character_split_across_chunks_waits_for_its_tail() {
        let full = "ab→".as_bytes().to_vec();
        let (head, tail) = full.split_at(full.len() - 1);

        let mut buf = head.to_vec();
        assert_eq!(drain_utf8(&mut buf), "ab");
        // The two bytes of the unfinished arrow stay put.
        assert_eq!(buf.len(), 2);

        buf.extend_from_slice(tail);
        assert_eq!(drain_utf8(&mut buf), "→");
        assert!(buf.is_empty());
    }

    #[test]
    fn an_impossible_byte_is_replaced_rather_than_stalling_the_stream() {
        let mut buf = vec![b'a', 0xff, b'b'];
        assert_eq!(drain_utf8(&mut buf), "a\u{fffd}b");
        assert!(buf.is_empty());
    }
}
