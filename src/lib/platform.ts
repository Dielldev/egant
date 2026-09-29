import { getCurrentWindow } from "@tauri-apps/api/window";

/** Platform helpers for chrome insets and shortcut labels.
 *
 * Detection is sync (UA / platform) so tooltips and first paint stay correct
 * without waiting on a Tauri plugin. Keybindings themselves already accept
 * both meta and ctrl — this only changes what the UI prints.
 */

export function isMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const platform = navigator.platform || "";
  if (/Mac|iPhone|iPad|iPod/i.test(platform)) return true;
  return /Mac OS X|Macintosh/i.test(navigator.userAgent || "");
}

export function isLinux(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  return /Linux/i.test(ua) && !/Android/i.test(ua);
}

/** Left padding for the window-bar row: clears overlay traffic lights on
 * macOS; a small inset elsewhere (normal decorations own the chrome). */
export function windowBarPadClass(): string {
  return isMac() ? "pl-[76px]" : "pl-2";
}

/** Makes every `data-tauri-drag-region` element in the app actually drag the
 * window on macOS. The attribute alone is supposed to be enough (WRY hit-
 * tests it natively), but that hit-test region only gets (re)computed on
 * layout changes WRY happens to observe — content that changes size after
 * first paint (a session title loading in, a worktree chip appearing) can
 * end up sitting on a stale region that no longer matches what's on screen,
 * so some drag strips work and others silently don't depending on what's
 * rendered in them. A single capture-phase listener sidesteps that: it reads
 * the *current* DOM on every mousedown, so it's never stale. Call once, at
 * startup.
 *
 * Needs `core:window:allow-start-dragging` (and `allow-toggle-maximize` for
 * the double-click zoom) in `src-tauri/capabilities/default.json` — without
 * them the IPC calls are denied and only the statically-laid-out strips
 * (the top WindowBar) keep dragging via the native hit-test.
 *
 * A double-click zooms (the OS default for a titlebar) instead of dragging;
 * a mousedown on an interactive child (a button, a link, an input) is left
 * alone so those keep working normally. */
export function installTitlebarDragHandler(): void {
  // Guarded: `main.tsx` runs once, but HMR / remounts must never stack a
  // second identical capture listener (two `startDragging` calls per click).
  if ((window as unknown as { __egantDragInstalled?: boolean }).__egantDragInstalled)
    return;
  (window as unknown as { __egantDragInstalled?: boolean }).__egantDragInstalled = true;
  window.addEventListener(
    "mousedown",
    (e) => {
      if (e.button !== 0) return;
      // `e.target` is an SVGElement inside inline glyphs (ProviderGlyph) —
      // still an Element, so `closest` works — but be defensive anyway.
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      if (target.closest("button, a, input, textarea, select, [contenteditable]")) return;
      if (target.closest("[data-tauri-no-drag]")) return;
      if (!target.closest("[data-tauri-drag-region]")) return;
      const win = getCurrentWindow();
      if (e.detail === 2) {
        e.preventDefault();
        win.toggleMaximize().catch(() => {});
        return;
      }
      // Must stay synchronous in the mousedown tick: yielding first (await)
      // would lose the user-gesture window Tauri/WRY needs to grab the move.
      // `preventDefault` stops WebKit's text/image drag gesture from racing
      // the window move we just asked for.
      e.preventDefault();
      win.startDragging().catch(() => {});
    },
    { capture: true },
  );
}

/**
 * Format a primary-modifier shortcut for UI copy.
 * `chord` uses macOS glyph style for the non-mod part: `"N"`, `"⇧J"`, `"⎋"`,
 * `","`, `"⏎"`. macOS → `⌘N`; Linux/Windows → `Ctrl+N` / `Ctrl+Shift+J`.
 */
export function modShortcut(chord: string): string {
  if (isMac()) return `⌘${chord}`;
  const rest = chord
    .replace(/⇧/g, "Shift+")
    .replace(/⎋/g, "Esc")
    .replace(/⏎/g, "Enter");
  return `Ctrl+${rest}`;
}
