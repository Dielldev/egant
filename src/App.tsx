import { useEffect } from "react";
import { LaunchScreen } from "./components/LaunchScreen";
import { SessionHeader } from "./components/SessionHeader";
import { SettingsPage } from "./components/SettingsPage";
import { Sidebar } from "./components/Sidebar";
import { TranscriptView } from "./components/TranscriptView";
import { applyAppearance, useEgant, selectLaunching } from "./store";

export default function App() {
  const snapshot = useEgant((s) => s.snapshot);
  const transcripts = useEgant((s) => s.transcripts);
  const settingsOpen = useEgant((s) => s.settingsOpen);
  const startingNewSession = useEgant((s) => s.startingNewSession);

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

  // The two states of one window. The sidebar is common to both — only the
  // stage beside it changes, from the launch composer to the conversation.
  const launching = selectLaunching(snapshot ?? null, transcripts, startingNewSession);
  const loading = !launching && activeTranscript === undefined;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-transparent text-[var(--ink)]">
      {settingsOpen ? (
        <SettingsPage />
      ) : (
        <>
          {(snapshot?.sidebarVisible ?? true) && <Sidebar />}
          {launching ? (
            <LaunchScreen />
          ) : loading ? (
            // Transcript still crossing the IPC boundary — one blank frame, never
            // a flash of the wrong screen.
            <div className="min-w-[420px] flex-1" />
          ) : (
            // Talking to an agent: a barely-there `--stage-tint` wash over
            // the transparent Tauri window's native macOS blur — no
            // wallpaper, no gradient. Appearance > Glass > Opaque swaps this
            // for a flat, fully solid fill instead (see `.stage-glass`).
            <div className="stage-glass relative flex h-full min-w-[420px] flex-1 flex-col overflow-hidden">
              <div className="relative z-10 flex h-full flex-col">
                <SessionHeader />
                <div className="flex min-h-0 flex-1 overflow-hidden">
                  <TranscriptView />
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
