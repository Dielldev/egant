import { useEffect, useState } from "react";
import { selectOnLaunchScreen, useEgant } from "../store";

/** The least room the conversation column is given before something else
 * yields. Under this the composer's controls wrap onto a second row and the
 * header truncates the title to a few letters. */
export const MIN_STAGE_WIDTH = 440;

/** The narrowest the workspace panel can be dragged — mirrored by the store's
 * `setPanelWidth` clamp. */
export const MIN_PANEL_WIDTH = 240;

export function useWindowWidth(): number {
  const [width, setWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

/** Whether the sidebar is on screen, and how wide the workspace panel may be.
 *
 * Three columns need more than the minimum window gives them: sidebar and
 * panel together would leave the conversation a couple of hundred pixels. The
 * panel gives up width first, down to its floor; past that the sidebar steps
 * aside (it stays one click — or ⌘B — away, and the saved preference is
 * untouched, so it returns the moment there is room or the panel closes). */
export function useColumnLayout() {
  const preferred = useEgant((s) => s.snapshot?.sidebarVisible ?? true);
  const sidebarWidth = useEgant((s) => s.sidebarWidth);
  const panelWidth = useEgant((s) => s.panelWidth);
  const panelMaximized = useEgant((s) => s.panelMaximized);
  const libraryOpen = useEgant((s) => s.libraryOpen);
  const settingsOpen = useEgant((s) => s.settingsOpen);
  const panelOpen = useEgant((s) => s.panelOpen && !selectOnLaunchScreen(s));
  const windowWidth = useWindowWidth();

  const panelShown = panelOpen && !libraryOpen && !settingsOpen;
  // A maximized panel replaces the stage, so there is no stage to protect.
  const crowded =
    preferred &&
    panelShown &&
    !panelMaximized &&
    windowWidth - sidebarWidth - MIN_PANEL_WIDTH < MIN_STAGE_WIDTH;
  const sidebarShown = preferred && !crowded;
  const room = windowWidth - (sidebarShown ? sidebarWidth : 0) - MIN_STAGE_WIDTH;

  return {
    windowWidth,
    sidebarShown,
    /** The sidebar is wanted but has stepped aside for the panel. */
    sidebarYielded: crowded,
    /** The panel's width, held back so the stage keeps its minimum. */
    panelWidth: Math.max(MIN_PANEL_WIDTH, Math.min(panelWidth, room)),
  };
}
