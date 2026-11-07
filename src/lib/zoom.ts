import { getCurrentWebview } from "@tauri-apps/api/webview";
import { log } from "./logger";
import { isLinux } from "./platform";

// View > Zoom In / Zoom Out / Actual Size. The window is a web view, so this is
// the web view's own zoom: everything scales together, layout included, and the
// level is kept across launches the way a Mac app's would be.
//
// On Linux WebKitGTK, `webview.setZoom` is unreliable (often a no-op). CSS
// `zoom` on `#root` is the path that visibly changes text size there.

const KEY = "egant.zoom";
const MIN = 0.7;
const MAX = 1.6;
const STEP = 0.1;

function load(): number {
  try {
    const stored = Number(localStorage.getItem(KEY));
    return Number.isFinite(stored) && stored >= MIN && stored <= MAX ? stored : 1;
  } catch {
    return 1;
  }
}

let level = load();

function applyCssZoom(next: number): void {
  const root = document.getElementById("root");
  if (!root) return;
  if (next === 1) {
    root.style.removeProperty("zoom");
  } else {
    root.style.zoom = String(next);
  }
}

async function apply(next: number): Promise<void> {
  level = Math.round(Math.min(MAX, Math.max(MIN, next)) * 100) / 100;
  try {
    localStorage.setItem(KEY, String(level));
  } catch {
    // A zoom that doesn't persist is still a zoom.
  }

  if (isLinux()) {
    applyCssZoom(level);
    return;
  }

  try {
    await getCurrentWebview().setZoom(level);
    // Native zoom owns the scale — clear any leftover CSS fallback.
    document.getElementById("root")?.style.removeProperty("zoom");
  } catch (error) {
    log.warn("zoom", `couldn't set the zoom level: ${String(error)}`);
    applyCssZoom(level);
  }
}

/** Puts the saved level back at launch. Does nothing at 100%. */
export function restoreZoom(): void {
  if (level !== 1) void apply(level);
}

export function zoomIn(): void {
  void apply(level + STEP);
}

export function zoomOut(): void {
  void apply(level - STEP);
}

export function resetZoom(): void {
  void apply(1);
}
