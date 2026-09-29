# egant

A native desktop workspace for coding agents.

Egant is a Tauri (Rust + React) desktop app that runs coding agents — starting with Claude Code — in real project folders, with a streaming chat transcript, file viewer, git changes, and terminals in one window.

> **Status: early working scaffold.** The shell is real — projects, sessions, streaming transcript, composer, wallpaper, files/changes/terminals panel — but agent end-to-end and worktree isolation are still in progress.

## Features

- **Agent chat, natively** — drives the `claude` CLI as a subprocess, streams tokens into the transcript. Interrupt mid-turn, switch permission modes mid-conversation.
- **Sidebar for everything** — a project dropdown ("All projects" or one folder) over that folder's conversations as cards, grouped by device, by project or not at all. Filter with `⌘K`, new session with `⌘N`.
- **Composer** — glass composer on launch, docked pill once the thread starts. `@path` file mentions, model/permission chip, context-window meter.
- **Workspace panel (`⌘J`)** — optional third column, per-window (not per-chat):
  - **Files** — lazy tree, and a syntax-highlighted editor on stage tabs with autosave, word wrap and editor font size (Settings → Files); saves are refused if the agent changed the file meanwhile
  - **Changes** — git status, stage/unstage/discard, diff (unified/split), Commit & Push
  - **Pull requests** — via your own `gh`, with checks/commits/files/comments
  - **Terminals** — real PTYs (`$SHELL -l`) that survive panel hide / session switch
- **Custom wallpaper** — pick an image, persisted to settings, with dim control.

## The window

```text
┌─────────────┬─────────────────────────┬──────────────┐
│ sidebar     │ stage                   │ panel (⌘J)   │
│ threads     │ chat + file/diff tabs   │ Files /      │
│             │ composer                │ Changes /    │
│             │                         │ Terminal     │
└─────────────┴─────────────────────────┴──────────────┘
```

- **Sidebar:** thread list + project menu + wallpaper settings + `Local only` footer.
- **Stage:** conversation transcript (user bubbles right, agent text left) + composer, or an open file/diff tab.
- **Panel:** files, git changes, PRs, terminals. Closed by default.

On launch you get a centered composer over the wallpaper. Type to pick a folder and start a session — the transcript takes over on the first message.

Shortcuts: `⌘N` / `Ctrl+N` new session · `⌘K` / `Ctrl+K` filter · `⌘L` / `Ctrl+L` focus composer · `⌘B` / `Ctrl+B` sidebar · `⌘J` / `Ctrl+J` panel · `⌘⎋` / `Ctrl+Esc` interrupt · `⏎` send / `⇧⏎` newline.

## Quickstart

### Prerequisites

| Need | Notes |
|------|-------|
| Rust 1.85+ | workspace is edition 2024 |
| Node 20+ + npm | frontend dev server + builds |
| macOS **or** Linux | see platform deps below |
| `claude` on `PATH` + `claude login` | agent driver |
| `gh` (optional) | only for Pull Requests section |

#### macOS

Command Line Tools only (`xcode-select --install`) — no full Xcode needed.

#### Linux (Fedora)

Tauri needs WebKitGTK 4.1 and friends. `dbus-devel` + `pkgconf-pkg-config` are required so `libdbus-sys` can find `dbus-1.pc`:

```bash
sudo dnf group install c-development
sudo dnf install \
  webkit2gtk4.1-devel \
  openssl-devel \
  curl-devel \
  wget \
  file \
  libappindicator-gtk3-devel \
  librsvg2-devel \
  libxdo-devel \
  gtk3-devel \
  dbus-devel \
  pkgconf-pkg-config
```

Check: `pkg-config --exists dbus-1 webkit2gtk-4.1 && echo ok`.

If `cc` on your `PATH` is Zig's clang wrapper (`~/.local/bin/cc` → `zig-cc`), `aws-lc-sys` (via rustls) fails with `UnknownOperatingSystem`. Prefer the system compiler for this project:

```bash
export CC=/usr/bin/gcc CXX=/usr/bin/g++
```

#### Linux (Ubuntu / Debian)

```bash
sudo apt update
sudo apt install \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  libdbus-1-dev \
  pkg-config
```

### Run

```bash
npm install          # once: frontend deps
# If ~/.local/bin/cc is zig-cc, point at system GCC first:
#   export CC=/usr/bin/gcc CXX=/usr/bin/g++
npm run tauri dev    # Vite dev server (:1420) + desktop window
```

### Second dev session (another worktree / port)

Vite reads `VITE_PORT` (default `1420`, `strictPort: true` so a taken port
fails loudly instead of drifting). Point Tauri at the same port via `--config`:

```bash
# terminal 1 (primary)
npm run tauri dev

# terminal 2 (secondary)
VITE_PORT=1421 npm run tauri dev -- --config '{"build":{"devUrl":"http://localhost:1421"}}'
# or the shortcut:
npm run tauri:dev:1421
```

`beforeDevCommand` (`npm run dev`) inherits `VITE_PORT`, so the spawned Vite
server binds `:1421` to match the overridden `devUrl`. Each extra session
takes the next free port (`1422`, …) the same way.

### Build / test

```bash
npm run tauri build   # release bundle (.app / .dmg on macOS; platform package on Linux)
npm run build         # type-check + production frontend build

cargo test -p egant -p egant-harness -p egant-vcs  # Rust tests, no window needed
```

Window chrome: macOS uses an overlay title bar (`tauri.macos.conf.json` — transparent + `Overlay`). Linux uses normal decorations and an opaque window (`tauri.linux.conf.json`) with CSS glass; native vibrancy stays macOS-only.

## How it works

```
React (views only)  ⇄  Tauri IPC (commands + `session-event`)  ⇄  Rust backend (single source of truth)
                                                                             ├─ Harness → `claude` subprocess
                                                                             ├─ vcs crate → git2 (local) + `git` CLI (network/creds)
                                                                             └─ PTY per terminal tab + `gh` for PRs
```

- **Backend owns state, frontend owns pixels.** Rust holds `AppState`, sends flattened `WindowState` snapshots. Frontend sends commands, re-renders from the snapshot.
- **Streaming is events, rest is commands.** Each turn folds `HarnessEvent`s into a backend `Transcript` and emits `session-event`. Frontend mirrors the same fold, so streaming is one small payload per token. Full snapshots only on session switch.
- **Agent behind a trait.** `Harness` = send turn, interrupt, answer permission, stream events. Claude wire format stays in `crates/harness`. Adding another agent = new impl, no frontend change.
- **Git split by need.** `git2` (libgit2, no openssl/ssh) for local status/diff/stage/commit. Your own `git` CLI for push/fetch/pull so keychain, SSH agent, `.gitconfig`, hooks all just work. Network ops run on `spawn_blocking` so UI never stalls.
- **No polling.** Panel re-reads on open, after its own actions, and on `turn_ended` (when the agent stops editing).

## Project layout

```
src-tauri/   Tauri backend — state only, no agent/git logic in the shell
  state.rs / sessions.rs / commands.rs / dto.rs
  project.rs files.rs pty.rs github.rs settings.rs
src/         React frontend — views only
  components/  Sidebar, SessionHeader, TranscriptView, Composer,
               WorkspacePanel, FileTree, ChangesPanel, TerminalPane, DiffTabView…
  lib/ store.ts  IPC wrappers, transcript fold, zustand store
crates/
  harness/   agent backends behind `Harness` trait (protocol.rs, claude.rs, transcript.rs)
  vcs/       git: local ops, remote ops, worktrees, file watching
scripts/vendor-icons.py  regenerates file icons from Antigravity set
```

> `crates/egant` (old GPUI shell) and `crates/webview` are excluded from the workspace but left on disk for reference. Tauri provides the webview natively.

See `src/components/icons/LICENSE.md` for icon rebuild notes.

## Settings & data

- Wallpaper + dim: `~/Library/Application Support/egant/settings.json` on macOS; `~/.config/egant/settings.json` (or `$XDG_CONFIG_HOME/egant`) on Linux.
- Webview gets the wallpaper as a data URL only — no filesystem access.
- Planned: worktree per session at `~/.egant/worktrees/<slug>` on `egant/<slug>` branch (`WorktreeStore` written, not yet wired — sessions currently start in project root).

## Troubleshooting

- **"Could not start the agent"** → `claude` not on `PATH`.
- **"Failed to authenticate: OAuth session expired"** → run `claude login`.
- **Blank window in `tauri dev`** → Vite must be on the port Tauri points at (`1420` by default, or `$VITE_PORT` with `strictPort` in `vite.config.ts`). Kill whatever holds the port, or move the session to a free one (see above).
- **Opaque / black hole in UI** → on macOS the window is `transparent: true` and `body` must stay transparent (alpha colors only). On Linux the window is opaque (`tauri.linux.conf.json`) with a CSS glass fallback — if the UI looks empty, confirm `html[data-platform="linux"]` is set.
- **`Package dbus-1 was not found` / missing `dbus-1.pc`** → install `dbus-devel` and `pkgconf-pkg-config` (Fedora) or `libdbus-1-dev` + `pkg-config` (Ubuntu).

## Roadmap

1. Real turn end-to-end against live `claude` traffic, harden transcript fold
2. Wire `WorktreeStore` into session creation
3. Persist sessions (`session_id` → `--resume`)
4. Per-file diff + stage/unstage/commit UI wiring
5. Live-refresh Changes via `RepoWatcher`

MIT — see `Cargo.toml` (`repository: https://github.com/dielldev/egant`).
