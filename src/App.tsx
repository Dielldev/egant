import { useEffect, useRef, useState } from "react";
import { CliLaunchDialog } from "./components/CliLaunchDialog";
import { CliStage } from "./components/CliStage";
import { ConflictFileView } from "./components/ConflictResolution";
import { DiffTabView } from "./components/DiffTabView";
import { FileView } from "./components/FileView";
import { LaunchScreen } from "./components/LaunchScreen";
import { NoticeToast } from "./components/NoticeToast";
import { LogoLoader } from "./components/Logo";
import { SearchModal } from "./components/SearchModal";
import { SessionHeader } from "./components/SessionHeader";
import { log } from "./lib/logger";
import { LibraryPage } from "./components/LibraryPage";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { StageTabs } from "./components/StageTabs";
import { disposeCliTerminals } from "./components/TerminalPane";
import { TranscriptView } from "./components/TranscriptView";
import { Wallpaper } from "./components/Wallpaper";
import { WorkspacePanel } from "./components/WorkspacePanel";
import type { StageTab } from "./store";
import {
  applyAppearance,
  CHAT_TAB,
  selectActiveSession,
  selectLaunching,
  selectOnLaunchScreen,
  useEgant,
} from "./store";

/** Stable empty list: a fresh `[]` per render would make the store's snapshot
 * a new value on every read. */
const NO_TABS: StageTab[] = [];

/** How long the hero composer takes to dock at the bottom — matches the
 * `.dock-exit` and `.rise` durations in `index.css` so nothing settles early. */
const DOCK_MS = 420;

/** How long the launch mark holds the window, at minimum.
 *
 * `init()` is a single IPC call that usually answers inside a frame or two, so
 * with no floor the loader is never actually seen — the window would snap
 * straight to the launch screen and the mark would be dead code. This is about
 * one pass of the wave across it. Drop it to 0 to hand the window over the
 * instant the snapshot lands. */
const SPLASH_MS = 1400;

type Stage = "launch" | "docking" | "thread";

export default function App() {
  const snapshot = useEgant((s) => s.snapshot);
  const transcripts = useEgant((s) => s.transcripts);
  const settingsOpen = useEgant((s) => s.settingsOpen);
  const libraryOpen = useEgant((s) => s.libraryOpen);
  const startingNewSession = useEgant((s) => s.startingNewSession);
  const panelMaximized = useEgant((s) => s.panelMaximized);
  // The launch screen has no workspace to show, so the panel is derived away
  // there — whatever `panelOpen` was persisted as, including at startup and
  // after "+" from a session that had it open.
  const panelVisible = useEgant((s) => s.panelOpen && !selectOnLaunchScreen(s));

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    useEgant
      .getState()
      .init()
      .then((u) => {
        if (!cancelled) unlisten = u;
        else u();
        log.info("app", "backend initialised");
      })
      .catch((e: unknown) => log.error("app", "failed to initialise egant", e));
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

  // Runs the splash out to `SPLASH_MS` regardless of how fast the snapshot
  // arrives. One shot on mount: there is no second boot to cover.
  const [splashHeld, setSplashHeld] = useState(SPLASH_MS <= 0);
  useEffect(() => {
    if (SPLASH_MS <= 0) return;
    const timer = setTimeout(() => setSplashHeld(true), SPLASH_MS);
    return () => clearTimeout(timer);
  }, []);

  // Plain `Esc` backs out of settings (or the Library) without touching the
  // session.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      const store = useEgant.getState();
      if (store.settingsOpen) {
        e.preventDefault();
        store.closeSettings();
      } else if (store.libraryOpen) {
        e.preventDefault();
        store.closeLibrary();
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
        if (store.libraryOpen) {
          store.closeLibrary();
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
        // Shift-L is the Library, beside plain ⌘L focusing the composer.
        case "L":
          e.preventDefault();
          if (store.libraryOpen) store.closeLibrary();
          else store.openLibrary();
          break;
        case "p":
          e.preventDefault();
          store.openSearch();
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
        // Shift makes it fill the window. `e.key` is already the shifted
        // character, which is what tells the two apart.
        case "J":
          e.preventDefault();
          store.togglePanelMaximized();
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

  // Closing a CLI session is the only thing that ends the agent running in
  // it — unlike a panel terminal, nothing on the backend owns that process.
  // Driven off the session list rather than off the close action so a
  // session that goes away any other way (a project removed, a restore that
  // dropped it) takes its terminal with it too.
  const sessions = snapshot?.sessions;
  useEffect(() => {
    if (!sessions) return;
    disposeCliTerminals(
      sessions.filter((s) => s.kind === "cli").map((s) => s.id),
    );
  }, [sessions]);

  const activeId = snapshot?.activeSession;
  const activeTranscript = activeId != null ? transcripts[activeId] : undefined;
  // A session that runs its own CLI takes the stage whole: no launch
  // composer to dock, no transcript to stream, nothing to wait for.
  // `startingNewSession` wins: "+" asks for the launch screen back, and the
  // CLI session it was asked *from* is still the active one until the next
  // session exists. Without this the launch screen would have nowhere to
  // draw and ⌘N would look like it did nothing.
  const cliSession = selectActiveSession(snapshot ?? null);
  const cli =
    !startingNewSession && cliSession?.kind === "cli" ? cliSession : null;

  // Files opened from the panel hang off the conversation they were opened
  // beside; `-1` holds the ones opened before there is a conversation at all.
  const stageKey = activeId ?? -1;
  const stageTabs = useEgant((s) => s.stageTabs[stageKey] ?? NO_TABS);
  const showing = useEgant((s) => s.stageTab[stageKey] ?? CHAT_TAB);
  const openTab = stageTabs.find((tab) => tab.key === showing) ?? null;

  // The two states of one window. The sidebar is common to both — only the
  // stage beside it changes, from the launch composer to the conversation.
  const launching = selectLaunching(snapshot ?? null, transcripts, startingNewSession);
  const loading = !launching && !cli && activeTranscript === undefined;
  // The moment real transcript content — not just a cleared `launching` flag
  // — is on screen. `launching` can go false a tick before the first message
  // actually lands (the session exists, its transcript doesn't yet), and
  // docking on that earlier flip would play the hand-off into an empty
  // `loading` frame instead of the message it's meant to reveal.
  const threadReady = !launching && !loading;

  // Drives the hand-off between the launch composer and the docked one: a
  // hard swap reads as a glitch, so `docking` keeps both mounted, stacked,
  // for one `DOCK_MS` beat while `LaunchScreen` slides out (`.dock-exit`)
  // and `TranscriptView` rises into place (`.rise`) under it. Coming back
  // to an empty launch screen (a fresh "+" session) snaps instead — there is
  // no picture yet to dissolve back into.
  const [stage, setStage] = useState<Stage>(threadReady ? "thread" : "launch");
  const wasReady = useRef(threadReady);
  useEffect(() => {
    if (wasReady.current === threadReady) return;
    wasReady.current = threadReady;
    if (!threadReady) {
      setStage("launch");
      return;
    }
    setStage("docking");
    useEgant.getState().requestFocusComposer();
    const timer = setTimeout(() => setStage("thread"), DOCK_MS);
    return () => clearTimeout(timer);
  }, [threadReady]);

  // Every hook above has run; from here the window can bail out early.
  //
  // Two things have to be true before the launch screen is worth showing: the
  // snapshot has to have crossed from Rust (its project menu, agent picker and
  // machine name are all fed from it, and hollow versions of those read as a
  // broken window), and the splash has to have had its beat. The snapshot
  // nearly always wins that race, which is the whole reason for the timer —
  // see `SPLASH_MS`.
  if (snapshot === null || !splashHeld) {
    return (
      <div className="stage-glass loader-fade flex h-screen w-screen items-center justify-center">
        <LogoLoader width={120} label="Starting egant" />
      </div>
    );
  }

  const docking = stage === "docking";
  // An open file or diff takes the stage whichever state the conversation is
  // in, so the launch look yields to it rather than drawing a wallpaper
  // behind code. A CLI session yields to neither: it has no launch state to
  // dissolve out of and no transcript to rise into.
  const heroVisible = stage !== "thread" && openTab === null && cli === null;
  const threadVisible = stage !== "launch" && openTab === null && cli === null;

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
            fill instead (see `.stage-glass`). The tint stays on underneath
            in every state now — `heroVisible`'s wallpaper dissolves off the
            top of it on dock instead of the stage cutting to it in one frame. */}
          {/* The Library takes the stage, not the window: the sidebar stays,
            so a conversation is one click away. */}
          {libraryOpen ? (
            <LibraryPage />
          ) : (
            <>
              {/* The stage slides out from under a maximizing panel rather than
                being squeezed by it: the panel's width animates over 280ms, and
                without this the transcript would reflow through every width on the
                way. Fading as it goes is what makes the squeeze invisible. */}
              <div
                style={{
                  transition:
                    "opacity 220ms cubic-bezier(0.22, 1, 0.36, 1), transform 280ms cubic-bezier(0.22, 1, 0.36, 1)",
                }}
                className={`stage-glass relative flex h-full flex-1 flex-col overflow-hidden ${
                  // Only while there is a panel to have taken the room: the
                  // maximized flag outlives closing the panel, and a stage slid
                  // out from under nothing is an empty window.
                  panelMaximized && panelVisible
                    ? "pointer-events-none min-w-0 -translate-x-10 opacity-0"
                    : "min-w-0 translate-x-0 opacity-100"
                }`}
              >
                {heroVisible && <Wallpaper launch exiting={docking} />}
                {/* Outside the stage's own states: closing the last conversation
                  is exactly when there is something to say about its worktree,
                  and by then the transcript it would have sat above is gone. */}
                <NoticeToast />
                <div className="relative z-10 flex h-full flex-col">
                  <SessionHeader bare={stage !== "thread"} />
                  <StageTabs sessionKey={stageKey} />
                  {openTab?.kind === "diff" && openTab.status === "conflicted" ? (
                    <ConflictFileView tab={openTab} />
                  ) : openTab?.kind === "diff" ? (
                    <DiffTabView tab={openTab} />
                  ) : openTab ? (
                    <FileView key={openTab.key} path={openTab.path} name={openTab.name} />
                  ) : cli ? (
                    <CliStage session={cli} />
                  ) : (
                    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                      {threadVisible &&
                        (loading ? (
                          // Transcript still crossing the IPC boundary — one blank
                          // frame, never a flash of the wrong screen.
                          <div className="min-h-0 flex-1" />
                        ) : (
                          <div className="flex min-h-0 flex-1 overflow-hidden">
                            <TranscriptView />
                          </div>
                        ))}
                      {/* Absolutely stacked over the thread beneath it so the two
                        overlap for the `docking` beat instead of stacking in flow. */}
                      {heroVisible && (
                        <div className="absolute inset-0 flex flex-col">
                          <LaunchScreen exiting={docking} />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {panelVisible && <WorkspacePanel />}
            </>
          )}
        </>
      )}
      {/* Outside the settings branch: the dialog is reachable both from the
        composer's agent picker and from Settings > Agents, and it should
        look the same either way. */}
      <CliLaunchDialog />
      <SearchModal />
    </div>
  );
}
