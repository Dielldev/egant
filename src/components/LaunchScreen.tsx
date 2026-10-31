import { ImagePlus, Monitor } from "lucide-react";
import { useRef, useState } from "react";
import { useEgant } from "../store";
import { ActivityPanel } from "./ActivityPanel";
import { Composer } from "./Composer";
import { ProjectMenu } from "./ProjectMenu";
import { CheckoutChips } from "./Worktree";

/** The stage before the first message lands: the same composer the
 * conversation uses, centred, over the launch wallpaper. Nothing here is a
 * screen of its own — it is the conversation with nothing in it yet, which is
 * why the header, the tab strip and the wallpaper around it belong to the
 * stage in `App` rather than to this. */
export function LaunchScreen({ exiting }: { exiting?: boolean }) {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "");
  const chooseWallpaper = useEgant((s) => s.chooseWallpaper);
  const attachContextFromSession = useEgant((s) => s.attachContextFromSession);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);

  const handleDragEnter = (e: React.DragEvent) => {
    dragCounterRef.current++;
    const dragging = useEgant.getState().draggingSession;
    if (
      dragging ||
      e.dataTransfer?.types?.includes("application/x-egant-session") ||
      e.dataTransfer?.types?.includes("text/plain")
    ) {
      e.preventDefault();
      setIsDragOver(true);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    const dragging = useEgant.getState().draggingSession;
    if (
      dragging ||
      e.dataTransfer?.types?.includes("application/x-egant-session") ||
      e.dataTransfer?.types?.includes("text/plain")
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (!isDragOver) setIsDragOver(true);
    }
  };

  const handleDragLeave = () => {
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragOver(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    dragCounterRef.current = 0;
    setIsDragOver(false);
    e.preventDefault();
    e.stopPropagation();

    const dragging = useEgant.getState().draggingSession;
    if (dragging) {
      useEgant.getState().setDraggingSession(null);
      void attachContextFromSession(dragging);
      return;
    }

    const sessionData =
      e.dataTransfer.getData("application/x-egant-session") ||
      e.dataTransfer.getData("text/plain");
    if (sessionData) {
      try {
        const parsed = JSON.parse(sessionData);
        if (parsed && typeof parsed.id === "number") {
          void attachContextFromSession({
            id: parsed.id,
            title: parsed.title,
            agent: parsed.agent,
            model: parsed.model ?? null,
          });
        }
      } catch {}
    }
  };

  // The launch screen is the only place the wallpaper is ever seen, so this is
  // where the empty state lives. Read the setting rather than `wallpaperUrl`:
  // the image crosses the IPC boundary a beat after launch, and keying off it
  // would flash the button for someone who already has one.
  const hasWallpaper = useEgant((s) => s.snapshot?.settings.wallpaper != null);

  return (
    <>
      {!hasWallpaper && (
        <button
          type="button"
          title="Choose a background image for the new thread screen"
          onClick={() => void chooseWallpaper()}
          className={`absolute top-4 right-5 z-20 flex cursor-pointer items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--sidebar)]/70 px-3.5 py-2 text-[12px] font-semibold text-[var(--ink)] shadow-lg backdrop-blur-xl transition hover:bg-[var(--hover)] ${
            exiting ? "dock-exit" : "rise"
          }`}
        >
          <ImagePlus
            size={14}
            strokeWidth={2.2}
            className="shrink-0 text-[var(--accent)]"
          />
          Set up wallpaper
        </button>
      )}
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className="relative flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8"
        style={{ paddingTop: "32vh" }}
      >
        <div className={`w-full max-w-[735px] ${exiting ? "dock-exit" : "rise"}`}>
          {/* Where the next turn will run, right-aligned to the composer it
            belongs to. Deliberately unpositioned (no z-index of its own):
            the composer below establishes its own stacking context (its
            backdrop-filter triggers one even though it isn't `position`ed),
            so this row must stay out of one too, or it would get pinned
            behind the composer and its dropdowns (the project menu's own
            popover included) would render clipped underneath it. */}
          <div
            className="mb-2 flex items-center justify-end gap-4 text-xs font-semibold text-white"
            style={{ textShadow: "0 1px 6px rgba(0,0,0,0.75), 0 1px 2px rgba(0,0,0,0.9)" }}
          >
            {/* A label, not a control: every session in this window is a
              local process, so there is no other machine to pick. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <Monitor size={13} strokeWidth={2} className="shrink-0" />
              <span className="truncate">{machine}</span>
            </span>
            <ProjectMenu variant="chip" />
          </div>
          <Composer sessionId={null} hero autoFocus />
          {/* Under the composer rather than in the row above it: that row names
            where you are — this machine, this project — while these two name
            what the next send will do with it. */}
          <div
            className="mt-2.5 flex items-center gap-4 pl-6 text-xs"
            style={{ textShadow: "0 1px 6px rgba(0,0,0,0.75), 0 1px 2px rgba(0,0,0,0.9)" }}
          >
            <CheckoutChips />
          </div>
          {/* Below the composer, where a long window has room for it and a short
            one scrolls to it: the stage owns the scrolling so the composer keeps
            the place it has always had. */}
          <ActivityPanel />
        </div>
      </div>
    </>
  );
}
