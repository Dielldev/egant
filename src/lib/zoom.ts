import { getCurrentWebview } from "@tauri-apps/api/webview";
import { log } from "./logger";

// View > Zoom In / Zoom Out / Actual Size. The window is a web view, so this is
// the web view's own zoom: everything scales together, layout included, and the
// level is kept across launches the way a Mac app's would be.

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

async function apply(next: number): Promise<void> {
  level = Math.round(Math.min(MAX, Math.max(MIN, next)) * 100) / 100;
  try {
    localStorage.setItem(KEY, String(level));
  } catch {
    // A zoom that doesn't persist is still a zoom.
  }
  try {
    await getCurrentWebview().setZoom(level);
  } catch (error) {
    log.warn("zoom", `couldn't set the zoom level: ${String(error)}`);
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
