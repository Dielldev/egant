import { useEffect, useState } from "react";
import { selectOnLaunchScreen, useEgant } from "../store";
import { MIN_PANEL_WIDTH, MIN_STAGE_WIDTH } from "./columns";
import { CONTEXT_WIDTH } from "./contextSidebar";

export { MIN_PANEL_WIDTH, MIN_STAGE_WIDTH };

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
  const contextOpen = useEgant((s) => s.contextOpen && !selectOnLaunchScreen(s));
  const windowWidth = useWindowWidth();

  const panelShown = panelOpen && !libraryOpen && !settingsOpen;
  // A maximized panel replaces the stage, so there is no stage to protect —
  // and no room beside it for the context column either.
  const contextShown = contextOpen && !libraryOpen && !settingsOpen && !(panelShown && panelMaximized);
  const contextWidth = contextShown ? CONTEXT_WIDTH : 0;
  const crowded =
    preferred &&
    (panelShown || contextShown) &&
    !(panelShown && panelMaximized) &&
    windowWidth - sidebarWidth - contextWidth - (panelShown ? MIN_PANEL_WIDTH : 0) < MIN_STAGE_WIDTH;
  const sidebarShown = preferred && !crowded;
  const room = windowWidth - (sidebarShown ? sidebarWidth : 0) - contextWidth - MIN_STAGE_WIDTH;

  return {
    windowWidth,
    sidebarShown,
    /** The sidebar is wanted but has stepped aside for the right-hand columns. */
    sidebarYielded: crowded,
    /** The context column is on screen (its width is `CONTEXT_WIDTH`). */
    contextShown,
    /** The panel's width, held back so the stage keeps its minimum. */
    panelWidth: Math.max(MIN_PANEL_WIDTH, Math.min(panelWidth, room)),
  };
}
