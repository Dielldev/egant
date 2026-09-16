import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { PtyExit, PtyOutput } from "../lib/types";
import { useEgant } from "../store";

/** Every terminal tab's live xterm instance, kept outside React.
 *
 * A terminal is not re-creatable state: unmounting the pane — because the
 * panel closed, or another tab took the view — must not lose the scrollback
 * or, worse, leave a second shell running. So the xterm and its PTY live in
 * this registry keyed by panel-tab id, drawn into a detached host element the
 * pane adopts on mount and hands back on unmount. Closing the tab is the only
 * thing that ends a shell (see `disposeTerminalsExcept`). */
interface LiveTerminal {
  host: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** `null` before the PTY opens, and again once its shell exits. */
  ptyId: number | null;
  /** Output that arrived before `ptyId` was known — the shell's first prompt
   * is written before `pty_spawn` has even returned its id. */
  pending: PtyOutput[];
  unlisten: UnlistenFn[];
}

const live = new Map<string, LiveTerminal>();

/** Tears down the terminals whose tabs are gone. The store has already killed
 * their shells; this is the frontend half — the xterm instances themselves. */
export function disposeTerminalsExcept(ids: string[]): void {
  const keep = new Set(ids);
  for (const [id, entry] of live) {
    if (keep.has(id)) continue;
    for (const off of entry.unlisten) off();
    entry.term.dispose();
    entry.host.remove();
    live.delete(id);
  }
}

/** xterm's palette, read from the app's own CSS variables so the shell sits in
 * the current theme instead of shipping one of its own. The background stays
 * transparent: the stage's glass is what should show through. */
function themeFor() {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    css.getPropertyValue(name).trim() || fallback;
  return {
    background: "rgba(0, 0, 0, 0)",
    foreground: read("--ink", "#e0e0e0"),
    cursor: read("--cursor", "#ffffff"),
    cursorAccent: read("--stage", "#0d0d0d"),
    selectionBackground: read("--selected", "rgba(255, 255, 255, 0.22)"),
  };
}

const MONO =
  'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, "Cascadia Mono", monospace';

/** Fitting an element with no size throws; that happens routinely here (a
 * hidden tab, a pane mid-layout) and the resize observer re-fits the moment it
 * has a width. */
function refit(entry: LiveTerminal): void {
  try {
    entry.fit.fit();
  } catch {
    // Nothing to fit yet.
  }
}

/** One terminal tab's shell. `active` is how the panel hides a tab without
 * unmounting it. */
export function TerminalPane({
  tabId,
  cwd,
  active,
}: {
  tabId: string;
  cwd: string;
  active: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const attachPty = useEgant((s) => s.attachPty);
  const markPtyExited = useEgant((s) => s.markPtyExited);
  const appearance = useEgant((s) => s.appearance);
  const [exited, setExited] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Opens a PTY for an already-wired terminal and flushes whatever its shell
   * said before the id came back. Safe to call again on restart: the terminal
   * itself is wired once, at creation. */
  async function spawn(entry: LiveTerminal): Promise<void> {
    try {
      const ptyId = await api.ptySpawn(cwd, entry.term.cols, entry.term.rows);
      entry.ptyId = ptyId;
      attachPty(tabId, ptyId);
      for (const payload of entry.pending) {
        if (payload.id === ptyId) entry.term.write(payload.data);
      }
      entry.pending = [];
      setExited(false);
      setError(null);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  }

  useEffect(() => {
    const parent = mount.current;
    if (!parent) return;

    let entry = live.get(tabId);
    if (!entry) {
      const host = document.createElement("div");
      host.style.width = "100%";
      host.style.height = "100%";

      const term = new Terminal({
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.25,
        cursorBlink: true,
        // The glass stage shows through the shell rather than the shell
        // painting a black rectangle over it.
        allowTransparency: true,
        theme: themeFor(),
        scrollback: 10_000,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);

      const created: LiveTerminal = { host, term, fit, ptyId: null, pending: [], unlisten: [] };
      live.set(tabId, created);
      entry = created;

      // Wired once, for the life of the tab. Both handlers read `ptyId` at the
      // moment they fire, so a restarted shell needs no re-wiring — and gets
      // no second copy of every keystroke.
      term.onData((data) => {
        if (created.ptyId != null) void api.ptyWrite(created.ptyId, data).catch(() => {});
      });
      term.onResize(({ cols, rows }) => {
        if (created.ptyId != null) {
          void api.ptyResize(created.ptyId, cols, rows).catch(() => {});
        }
      });

      // Listening before spawning — and queueing what lands in between — is
      // what keeps the shell's first prompt from being lost to the round trip.
      void (async () => {
        created.unlisten.push(
          await listen<PtyOutput>("pty-output", ({ payload }) => {
            if (created.ptyId == null) created.pending.push(payload);
            else if (payload.id === created.ptyId) created.term.write(payload.data);
          }),
        );
        created.unlisten.push(
          await listen<PtyExit>("pty-exit", ({ payload }) => {
            if (payload.id !== created.ptyId) return;
            created.term.write("\r\n\x1b[2m[shell exited]\x1b[0m\r\n");
            created.ptyId = null;
            markPtyExited(payload.id);
            setExited(true);
          }),
        );
        await spawn(created);
      })();
    }

    const adopted = entry;
    parent.appendChild(adopted.host);
    setExited(adopted.ptyId == null && adopted.unlisten.length > 0);
    // The pane may be mounting into a width this terminal has never seen.
    requestAnimationFrame(() => {
      if (active) refit(adopted);
    });

    return () => {
      // The host goes back to the registry intact — scrollback, shell and all.
      if (adopted.host.parentElement === parent) parent.removeChild(adopted.host);
    };
    // `cwd` is read when the shell spawns and never again: by then the shell
    // has its own idea of where it is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  // Re-fit on every size change, including the tab being shown again.
  useEffect(() => {
    const parent = mount.current;
    const entry = live.get(tabId);
    if (!parent || !entry || !active) return;
    refit(entry);
    const observer = new ResizeObserver(() => refit(entry));
    observer.observe(parent);
    return () => observer.disconnect();
  }, [tabId, active]);

  // Follow the app's theme, so switching palettes doesn't leave one terminal
  // in the old one.
  useEffect(() => {
    const entry = live.get(tabId);
    if (entry) entry.term.options.theme = themeFor();
  }, [tabId, appearance]);

  const restart = () => {
    const entry = live.get(tabId);
    if (!entry) return;
    entry.term.clear();
    void spawn(entry);
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div ref={mount} className="min-h-0 flex-1 overflow-hidden px-1.5 py-1" />
      {error && (
        <div className="mx-2 mb-2 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[11px] text-[var(--danger)]">
          {error}
        </div>
      )}
      {exited && !error && (
        <div className="flex shrink-0 items-center gap-2 px-2.5 pb-2 text-[11px] text-[var(--faint)]">
          <span className="min-w-0 flex-1 truncate">Shell exited</span>
          <button
            type="button"
            onClick={restart}
            className="shrink-0 cursor-pointer rounded-full bg-[rgba(255,255,255,0.1)] px-2.5 py-0.5 text-[var(--ink)] hover:opacity-85"
          >
            Restart
          </button>
        </div>
      )}
    </div>
  );
}
