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
