import { useEffect } from "react";
import { DiffTabView } from "./components/DiffTabView";
import { FileView } from "./components/FileView";
import { LaunchScreen } from "./components/LaunchScreen";
import { SessionHeader } from "./components/SessionHeader";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { StageTabs } from "./components/StageTabs";
import { TranscriptView } from "./components/TranscriptView";
import { Wallpaper } from "./components/Wallpaper";
import { WorkspacePanel } from "./components/WorkspacePanel";
import type { StageTab } from "./store";
import { applyAppearance, CHAT_TAB, useEgant, selectLaunching } from "./store";

/** Stable empty list: a fresh `[]` per render would make the store's snapshot
 * a new value on every read. */
const NO_TABS: StageTab[] = [];

export default function App() {
  const snapshot = useEgant((s) => s.snapshot);
  const transcripts = useEgant((s) => s.transcripts);
  const settingsOpen = useEgant((s) => s.settingsOpen);
  const startingNewSession = useEgant((s) => s.startingNewSession);
  const panelOpen = useEgant((s) => s.panelOpen);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    useEgant
      .getState()
      .init()
      .then((u) => {
        if (!cancelled) unlisten = u;
        else u();
      })
      .catch((e: unknown) => console.error("failed to initialise egant", e));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // Paint the persisted appearance before first paint, then follow the OS
  // while the mode is `system`.
  useEffect(() => {
    applyAppearance(useEgant.getState().appearance);
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyAppearance(useEgant.getState().appearance);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  // Plain `Esc` backs out of settings without touching the session.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      const store = useEgant.getState();
      if (store.settingsOpen) {
        e.preventDefault();
        store.closeSettings();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Global shortcuts. Mirrors the GPUI shell's key bindings.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const store = useEgant.getState();
      if (e.key === ",") {
        e.preventDefault();
        store.openSettings();
        return;
      }
      // Settings open: `Esc` backs out instead of touching the session.
      if (e.key === "Escape") {
        e.preventDefault();
        if (store.settingsOpen) {
          store.closeSettings();
          return;
        }
      }
      const active = store.snapshot?.activeSession;
      switch (e.key) {
        case "n":
          e.preventDefault();
          void store.createSession();
          break;
        case "k":
          e.preventDefault();
          store.openFilter();
          break;
        case "l":
          e.preventDefault();
          store.requestFocusComposer();
          break;
        case "b":
          e.preventDefault();
          void store.toggleSidebar();
          break;
        // The workspace panel — files and terminals — mirroring ⌘B for the
        // sidebar on the other side of the window.
        case "j":
          e.preventDefault();
          store.togglePanel();
          break;
        case "Escape":
          e.preventDefault();
          if (active != null) void store.interrupt(active);
          break;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const activeId = snapshot?.activeSession;
  const activeTranscript = activeId != null ? transcripts[activeId] : undefined;

  // Files opened from the panel hang off the conversation they were opened
  // beside; `-1` holds the ones opened before there is a conversation at all.
  const stageKey = activeId ?? -1;
  const stageTabs = useEgant((s) => s.stageTabs[stageKey] ?? NO_TABS);
  const showing = useEgant((s) => s.stageTab[stageKey] ?? CHAT_TAB);
  const openTab = stageTabs.find((tab) => tab.key === showing) ?? null;

  // The two states of one window. The sidebar is common to both — only the
  // stage beside it changes, from the launch composer to the conversation.
  const launching = selectLaunching(snapshot ?? null, transcripts, startingNewSession);
  const loading = !launching && activeTranscript === undefined;
  // An open file or diff takes the stage whichever state the conversation is
  // in, so the launch look yields to it rather than drawing a wallpaper behind
  // code.
  const onLaunch = launching && openTab === null;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent text-[var(--ink)]">
      {settingsOpen ? (
        <SettingsPage />
      ) : (
        <>
          {(snapshot?.sidebarVisible ?? true) && <Sidebar />}
          {/* One stage in every state: the launch wallpaper and the
            conversation's `--stage-tint` wash over the transparent Tauri
            window's native macOS blur are the same surface with a different
            ground. Appearance > Glass > Opaque swaps the latter for a flat
            fill instead (see `.stage-glass`). */}
          <div
            className={`relative flex h-full min-w-[420px] flex-1 flex-col overflow-hidden ${
              onLaunch ? "" : "stage-glass"
            }`}
          >
            {onLaunch && <Wallpaper launch />}
            <div className="relative z-10 flex h-full flex-col">
              <SessionHeader bare={onLaunch} />
              <StageTabs sessionKey={stageKey} />
              {openTab?.kind === "diff" ? (
                <DiffTabView tab={openTab} />
              ) : openTab ? (
                <FileView path={openTab.path} name={openTab.name} />
              ) : onLaunch ? (
                <LaunchScreen />
              ) : loading ? (
                // Transcript still crossing the IPC boundary — one blank frame,
                // never a flash of the wrong screen.
                <div className="min-h-0 flex-1" />
              ) : (
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <TranscriptView />
                </div>
              )}
            </div>
          </div>
          {panelOpen && <WorkspacePanel />}
        </>
      )}
    </div>
  );
}
