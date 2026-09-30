import { useEffect, useRef, useState } from "react";
import type { TouchEvent } from "react";
import { useMobile } from "../store";
import { Conversation, StartingChat } from "./Conversation";
import { Drawer } from "./Drawer";
import { Home } from "./Home";
import { SettingsScreen } from "./SettingsScreen";
import { Toast } from "./Toast";
import { UsagePage } from "./UsagePage";

/** How far from the left edge a swipe has to start to pull the drawer out —
 * anywhere further in belongs to what is on screen (a code block's own
 * sideways scroll, say). */
const EDGE_PX = 28;

/** The whole app once it is connected: the page (a new chat or an open one),
 * the chat drawer that a tap on ☰ or a swipe from the left edge slides in
 * over all of it, and Settings rising over both. */
export function Shell() {
  const openSession = useMobile((s) => s.openSession);
  const starting = useMobile((s) => s.starting);
  const settingsOpen = useMobile((s) => s.settingsOpen);
  const usageOpen = useMobile((s) => s.usageOpen);
  const needsYou = useMobile((s) =>
    s.sessions.some((session) => session.pendingCount > 0 && session.id !== s.openSession),
  );

  const [open, setOpen] = useState(false);
  const [drag, setDragState] = useState<number | null>(null);
  // Read by the touch handlers, which can run before React has drawn the
  // last move (a quick flick ends inside one frame).
  const dragRef = useRef<number | null>(null);
  const setDrag = (value: number | null) => {
    dragRef.current = value;
    setDragState(value);
  };
  const [width, setWidth] = useState(() => window.innerWidth);
  const gesture = useRef<{ x0: number; y0: number; base: number; axis: "x" | "y" | null } | null>(
    null,
  );

  useEffect(() => {
    const onResize = () => setWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Anything that opens a page closes the drawer over it.
  useEffect(() => {
    setOpen(false);
  }, [openSession, settingsOpen, usageOpen]);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || settingsOpen || usageOpen) return;
    if (!open && touch.clientX > EDGE_PX) return;
    gesture.current = { x0: touch.clientX, y0: touch.clientY, base: open ? width : 0, axis: null };
  };
  const onTouchMove = (event: TouchEvent) => {
    const g = gesture.current;
    const touch = event.touches[0];
    if (!g || !touch) return;
    const dx = touch.clientX - g.x0;
    const dy = touch.clientY - g.y0;
    if (g.axis == null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      g.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    }
    if (g.axis !== "x") {
      gesture.current = null;
      return;
    }
    setDrag(Math.max(0, Math.min(width, g.base + dx)));
  };
  const onTouchEnd = () => {
    const g = gesture.current;
    const dragged = dragRef.current;
    gesture.current = null;
    if (dragged == null || !g) return;
    // A third of the way is enough, either way.
    setOpen(g.base === 0 ? dragged > width / 3 : dragged > (width * 2) / 3);
    setDrag(null);
  };

  const offset = drag ?? (open ? width : 0);

  return (
    <div
      className={`relative h-full overflow-hidden bg-[var(--stage)] ${drag != null ? "dragging" : ""}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <main className="absolute inset-0" aria-hidden={open}>
        {openSession != null ? (
          <Conversation id={openSession} onMenu={() => setOpen(true)} needsYou={needsYou} />
        ) : starting != null ? (
          <StartingChat starting={starting} onMenu={() => setOpen(true)} />
        ) : (
          <Home onMenu={() => setOpen(true)} needsYou={needsYou} />
        )}
      </main>

      <aside
        className="drawer-slide absolute inset-0 z-40"
        style={{ transform: `translateX(${offset - width}px)` }}
        aria-hidden={!open}
      >
        <Drawer onClose={() => setOpen(false)} />
      </aside>

      {settingsOpen && <SettingsScreen />}
      {usageOpen && <UsagePage />}
      <Toast />
    </div>
  );
}
