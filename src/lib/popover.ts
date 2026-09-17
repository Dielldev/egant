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

/** Picks a side *and* a height that actually fits it. `shouldOpenUpward`
 * alone only compares which side has *more* room — it doesn't check that the
 * chosen side has *enough*. A trigger sitting in the lower half of a short
 * window can still have less headroom above it than the menu wants, so a
 * blind fixed height renders the menu's top rows above the window's own top
 * edge — clipped by `overflow: hidden` on `body`, not by anything the menu
 * itself draws, so it looks like the icons in that row are sliced in half.
 * Capping the menu's height to whatever space is actually there keeps the
 * whole menu on screen and lets its own internal scroll region take over
 * instead. */
export function fitMenu(
  triggerRef: RefObject<HTMLElement | null>,
  preferredHeight: number,
  margin = 8,
): { openUpward: boolean; maxHeight: number } {
  const rect = triggerRef.current?.getBoundingClientRect();
  if (!rect) return { openUpward: false, maxHeight: preferredHeight };
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  const spaceAbove = rect.top - margin;
  const openUpward = spaceBelow < preferredHeight && spaceAbove > spaceBelow;
  const available = openUpward ? spaceAbove : spaceBelow;
  return {
    openUpward,
    maxHeight: Math.max(160, Math.min(preferredHeight, available)),
  };
}

/** Height for a menu that always hangs *below* its trigger, whatever the room
 * down there. Flipping a menu upward moves it out from under the pointer and
 * puts its first row where its last row was a moment ago, which is
 * disorienting for a menu opened as often as the model picker; this keeps the
 * direction constant and lets the menu's own scroll region absorb a short
 * window instead. The floor is what stops a trigger near the bottom edge from
 * collapsing the menu into a sliver — below it, a little overflow beats an
 * unusable two-row list. */
export function fitBelow(
  triggerRef: RefObject<HTMLElement | null>,
  preferredHeight: number,
  margin = 8,
): number {
  const rect = triggerRef.current?.getBoundingClientRect();
  if (!rect) return preferredHeight;
  const spaceBelow = window.innerHeight - rect.bottom - margin;
  return Math.max(240, Math.min(preferredHeight, spaceBelow));
}

/** Same idea, sideways: a menu anchored to `left-0` of a trigger sitting near
 * the right edge of a narrowed column (the composer, with the workspace panel
 * open) runs out of room and spills over whatever sits to the right instead.
 * Flips to anchoring `right-0` when that would happen. */
export function shouldOpenLeftward(
  triggerRef: RefObject<HTMLElement | null>,
  menuWidth: number,
): boolean {
  const rect = triggerRef.current?.getBoundingClientRect();
  if (!rect) return false;
  const spaceRight = window.innerWidth - rect.left;
  const spaceLeft = rect.right;
  return spaceRight < menuWidth && spaceLeft > spaceRight;
}
