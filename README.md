# egant

A native desktop workspace for coding agents: a Tauri window with a vibrant
background and an embedded Claude Code session driven as a subprocess with a
streaming transcript.

> **Status: working scaffold.** It builds clean (`npx tauri build --debug`
> produces `egant.app`), the window opens, and 31 Rust tests pass. The shell
> is real — projects, sessions, streaming transcript, composer, wallpaper —
> but the agent has not yet been driven end-to-end through the UI
> (the CLI on this machine needs `claude login`), and worktrees are written
> but not wired in.

## The window

```text
┌──────────────────────┬──────────────────────────────────────┐
│ ●●●  ◫ ‹ › +         │ ▣ hello tehre   clean-mac @ this-mac │
│ 📁 clean-mac @ mac ⌄≡│ ╌╌╌╌╌╌╌╌╌╌ wallpaper glow ╌╌╌╌╌╌╌╌╌╌ │
│                      │                       ┌────────────┐ │
│ clean-mac @ mac   1m │                       │ hello tehre│ │
│ ▣ hello tehre        │                       └────────────┘ │
│                      │  Hello! How can I help you today?    │
│                      │  Sep 15, 4:09 PM ⧉                   │
│                      │                                      │
│                      │ ╭──────────────────────────────────╮ │
│                      │ │ Do anything…   ▤ Model Mode ⧉ ↑  │ │
│ Ⓛ Local only         │ ╰──────────────────────────────────╯ │
│                      │                               ◔ 5%   │
└──────────────────────┴──────────────────────────────────────┘
```

Two columns. The **sidebar** is every conversation on this machine, newest
last, under a header naming the project they run in (`project @ machine`) and
above a footer saying where they run (`Local only`). Rows read as merged
thread units: where and how long ago, then the title. Its header menu also
holds the open projects and the wallpaper settings. The filter field stays
hidden until the header's filter button or ⌘K asks for it.

The **stage** is the conversation: a title line naming it, the transcript, and
the composer. The user's turns are right-aligned bubbles, the agent's are
plain text on the ground with the moment they landed and a copy button; the
ring under the composer's right edge is how full the context window is.

The window is transparent with an overlay title bar, so the sidebar runs to
the top and the traffic lights sit over it. The button row beside them —
sidebar toggle, back/forward through conversations, new conversation — rides
at the top of whichever column is leftmost, and moves to the stage when the
sidebar is hidden. It carries `data-tauri-drag-region`, which is what keeps
the window draggable by it while it holds real controls.

On launch — before the first message lands — the stage holds one centred glass
composer with its context row (machine + project) riding above it, over a
wallpaper that still reads as a photograph and dissolves into black
mid-screen. The sidebar does not move or change. Typing there opens a folder
and starts a session if needed, then delivers the message; the transcript
takes the stage with the first turn.

It is the same composer in both places — same glass, same chips, same keys —
tall with its chips beneath on launch, a single-line pill with them inline
once the conversation starts. Once a conversation is open the wallpaper drops
back to a heavy blur over near-black: a glow rather than a photograph, because
from there on the stage is text on a ground.

### Wallpaper

Open the sidebar header's menu (the `⌄` beside the project name) and pick
**Choose image…**. The choice is written to `~/Library/Application Support/egant/settings.json`
and survives restarts; **Dim** steps the scrim over the image, because the chrome
is translucent and an undimmed photograph makes body text unreadable. A wallpaper
that has since been moved or deleted is forgotten rather than drawn as a blank
rectangle.

### Keys

| | |
|---|---|
| ⌘N | new session |
| ⌘K | reveal and focus the filter field |
| ⌘L | focus the composer |
| ⌘B | hide the sidebar |
| ⌘⎋ | interrupt the running turn |
| ⏎ / ⇧⏎ | send / newline |

**Open folder…** in the header menu runs the platform folder picker and starts
a session in whatever folder comes back. The paperclip attaches files as
`@path` mentions. The composer's model chip cycles the agent's permission mode
on the running session — the agent accepts that mid-conversation, so nothing
restarts.

## Requirements

| | |
|---|---|
| Rust | stable, 1.85+ (the workspace is edition 2024) |
| Node | 20+ with npm (frontend dev server and builds) |
| macOS | Command Line Tools are enough; no full Xcode needed |
| `claude` | on `PATH`, logged in (`claude login`) |

## Running

```bash
npm install          # once: frontend dependencies
npm run tauri dev    # Vite dev server + desktop window
```

A release bundle:

```bash
npm run tauri build
```

Rust logic tests need no window:

```bash
cargo test -p egant -p egant-harness -p egant-vcs
```

Type-check and production frontend build:

```bash
npm run build
```

## Layout

```
src-tauri/   the Tauri backend — state only, no agent or git logic
  state.rs      window root state: projects, sessions, selection
  sessions.rs   bridges one agent to one transcript, streams `session-event`s
  commands.rs   everything the frontend can invoke
  dto.rs        the shapes that cross the IPC boundary
  project.rs    the folders the app has been pointed at
  settings.rs   preferences that outlive a run
src/         the React frontend — views only
  components/  Sidebar · WindowBar · ProjectMenu · SessionHeader ·
               TranscriptView · Composer · ContextMeter · Wallpaper
  lib/         IPC wrappers, dialog pickers, the transcript fold
  store.ts     zustand store: snapshot + live transcripts + lists
crates/
  harness/    agent backends behind a `Harness` trait
    protocol.rs   Claude Code's stream-json wire types
    claude.rs     the subprocess driver
    transcript.rs the renderable fold of an event stream
  vcs/        git: local ops, remote ops, worktrees, file watching
```

`crates/egant` (the previous GPUI shell) and `crates/webview` are excluded
from the workspace but left on disk for reference; Tauri provides the webview
natively, so the custom webview crate has no role anymore.

## Decisions worth knowing

### The backend owns state, the frontend owns pixels

The Tauri backend holds the only copy of window truth (`AppState`) and hands
the frontend flattened snapshots (`WindowState`). The frontend reports clicks
back as commands and re-renders from the snapshot each command returns, so
there is never a second answer to "which session is open".

### Streaming is events, everything else is commands

Each agent session folds `HarnessEvent`s into its backend `Transcript` and
emits them on `session-event`. The frontend folds the same events into its own
mirror (`lib/transcript.ts`, a mechanical port of `Transcript::apply`), which
keeps streaming to one small payload per token instead of a full snapshot per
token. Snapshots (`get_transcript`) are only fetched when switching sessions.

The send path echoes on both sides: the backend's `push_user` and the
frontend's optimistic echo are the same deterministic fold, so the message
appears on keypress and both sides agree.

### Each session runs three tasks, and the split is the point

- the **pump** reads the agent's stdout in the background,
- the **driver** owns the harness and serializes writes to it — also background,
  because every write is `async`,
- the **listener** folds events into the transcript and emits them to the window.

Commands reach the driver through a channel rather than a shared lock. A lock
would have to be held across `await` points, and a command handler must never
block on that. Tauri command handlers never hold the state lock across an
`await` either — they clone what they need and drop the guard first.

### The agent sits behind a trait

`Harness` is the whole surface the backend knows: send a turn, interrupt,
answer a permission request, and read a stream of `HarnessEvent`.
Claude-specific wire types stay in `protocol.rs` and never escape `claude.rs`.
Adding Codex over JSON-RPC means writing one more implementation that emits
the same events — no frontend changes.

### Git is split by what each job needs

`libgit2` (via `git2`) for everything local — status, diffs, staging, commits.
It is fast enough to run synchronously, and `git2` is built with
`default-features = false` so libgit2's ssh/https transports and the
`openssl-sys` build dependency are out of the tree entirely.

The user's own `git` for anything touching a network or a credential. Pushing
needs credentials, and those already live where only `git` can reach them: the
macOS keychain helper, an SSH agent, a `credential.helper`, a hardware key.
Reimplementing that lookup would mean a second, worse credential path. Shelling
out inherits all of it — along with their `.gitconfig`, hooks and proxy settings.

Unlike the GPUI shell (where push blocked the UI), network operations run on a
blocking thread via `spawn_blocking`, so slow remotes never stall input.

### Worktrees per session

Sessions get an isolated checkout under `~/.egant/worktrees/<slug>` on their own
`egant/<slug>` branch. An agent editing the user's working tree makes two things
impossible: reviewing what it did (the diff moves while you read it) and running
two sessions at once.

`WorktreeStore` is written but **not yet wired into the UI** — sessions currently
start in the project root. Wiring it is the first real feature to add.

### The wallpaper travels as a data URL

The webview never gets filesystem access. The one image the user picked is read
by the backend and served to an `<img>` tag as a data URL (`wallpaper_data_url`),
which keeps the security surface to exactly that file. The dim setting is a
plain black overlay at `wallpaper_dim` opacity.

### Icons are generated, not checked in by hand

`src-tauri/icons/` comes from a stdlib-only Python script plus `sips` and
`iconutil` — a dark tile with a composer bar and the violet busy dot. Replace
`icon-1024.png` with real artwork and re-derive the set.

## Troubleshooting

**"Could not start the agent"** in a new session — `claude` is not on `PATH`.

**"Failed to authenticate: OAuth session expired"** in the transcript — run
`claude login`. (This was the state of the CLI on this machine when the scaffold
was written.)

**Blank window in `tauri dev`** — the Vite dev server must be on port 1420
(`strictPort`); another process on that port fails the boot.

## Next steps

1. Drive a real turn end-to-end (`claude login` first) and see where the
   transcript's event fold needs adjusting against live traffic.
2. Wire `WorktreeStore` into session creation.
3. Persist sessions — `session_id` from the handshake is all `--resume` needs.
4. Per-file diff view in the Changes tab (`diff_file` already returns hunks;
   `stage_files` / `unstage_files` / `commit_changes` are waiting for UI).
5. Wire the `RepoWatcher` to live-refresh the Changes tab while the agent works.

## Frontend notes

Things that cost time to find, recorded so they do not have to be found twice:

- The window is `transparent: true`, so `body` must stay transparent and every
  surface uses an alpha colour — an opaque background anywhere punches a hole
  in the design (or rather, fills one).
- No `StrictMode`: its dev-only double-mount subscribes `session-event` twice
  and folds every delta twofold.
- `data-tauri-drag-region` on the title-bar row makes the window draggable;
  buttons inside it still receive clicks.
- `git2::Repository` is neither `Send` nor `Sync`; all git commands use it
  synchronously inside the handler and never hold it across an `await`.
- An `Option<String>` command argument arrives as `null` vs string — `undefined`
  is not sent by `invoke`, so optional params must be passed explicitly.
