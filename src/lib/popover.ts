// Keeps a dropdown on screen. The window scrolls nothing (`overflow: hidden`
// on `body`), so a popover that opens downward past the bottom edge isn't
// scrollable into view — it's simply gone. Every anchored menu in the sidebar
// and composer measures its trigger on open and flips upward when there
// isn't room below, rather than trusting `top-full` blindly.

import type { RefObject } from "react";

/** Whether a menu anchored under `triggerRef` should instead open upward, so
 * it never renders past the window's edges. Measured once, on open — these
 * are menus that close on outside click, not layouts that track live
 * resizes. */
export function shouldOpenUpward(
  triggerRef: RefObject<HTMLElement | null>,
  menuHeight: number,
): boolean {
  const rect = triggerRef.current?.getBoundingClientRect();
  if (!rect) return false;
  const spaceBelow = window.innerHeight - rect.bottom;
  const spaceAbove = rect.top;
  return spaceBelow < menuHeight && spaceAbove > spaceBelow;
}
