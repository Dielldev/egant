import { useEffect, useRef, useState } from "react";
import type { TouchEvent } from "react";
import { useMobile } from "../store";
import { Backdrop } from "./Backdrop";
import { Conversation, StartingChat } from "./Conversation";
import { Drawer } from "./Drawer";
import { Home } from "./Home";
import { SettingsScreen } from "./SettingsScreen";
import { Toast } from "./Toast";

/** How far from the left edge a swipe has to start to pull the drawer out —
 * anywhere further in belongs to what is on screen (a code block's own
 * sideways scroll, say). */
const EDGE_PX = 28;

function drawerWidth(): number {
  return Math.round(Math.min(window.innerWidth * 0.86, 360));
}

/** The whole app once it is connected: the page (a new chat or an open one)
 * over the chat drawer, which a tap on ☰ or a swipe from the left edge
 * slides the page aside to show — and Settings rising over both. */
export function Shell() {
  const openSession = useMobile((s) => s.openSession);
  const starting = useMobile((s) => s.starting);
  const settingsOpen = useMobile((s) => s.settingsOpen);
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
  const [width, setWidth] = useState(drawerWidth);
  const gesture = useRef<{ x0: number; y0: number; base: number; axis: "x" | "y" | null } | null>(
    null,
  );

  useEffect(() => {
    const onResize = () => setWidth(drawerWidth());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Anything that opens a page closes the drawer over it.
  useEffect(() => {
    setOpen(false);
  }, [openSession, settingsOpen]);

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    if (!touch || settingsOpen) return;
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
  const progress = offset / width;

  return (
    <div
      className={`relative h-full overflow-hidden bg-[var(--raised)] ${drag != null ? "dragging" : ""}`}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchEnd}
    >
      <aside
        className="drawer-slide absolute inset-y-0 left-0"
        style={{ width, transform: `translateX(${(progress - 1) * width * 0.25}px)` }}
        aria-hidden={!open}
      >
        <Drawer onClose={() => setOpen(false)} />
      </aside>

      <main
        className="drawer-slide absolute inset-0 overflow-hidden bg-[var(--stage)]"
        style={{
          transform: `translateX(${offset}px)`,
          borderRadius: offset > 0 ? 28 : 0,
          boxShadow: offset > 0 ? "-12px 0 40px rgba(0,0,0,0.35)" : undefined,
        }}
      >
        <Backdrop visible={openSession == null && starting == null} />
        <div className="relative h-full">
          {openSession != null ? (
            <Conversation id={openSession} onMenu={() => setOpen(true)} needsYou={needsYou} />
          ) : starting != null ? (
            <StartingChat starting={starting} onMenu={() => setOpen(true)} />
          ) : (
            <Home onMenu={() => setOpen(true)} needsYou={needsYou} />
          )}
        </div>
        {offset > 0 && (
          <div
            className="absolute inset-0 z-40 bg-black"
            style={{ opacity: 0.3 * progress }}
            onClick={() => setOpen(false)}
          />
        )}
      </main>

      {settingsOpen && <SettingsScreen />}
      <Toast />
    </div>
  );
}
