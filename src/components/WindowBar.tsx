import { ChevronLeft, ChevronRight, PanelLeft, Plus } from "lucide-react";
import { useEgant } from "../store";

/** The row that shares the title bar with the traffic lights: sidebar toggle,
 * session history, new session. It rides at the top of whichever column is
 * leftmost — the sidebar when it is open, the stage when it is not — so the
 * buttons keep the same place beside the traffic lights either way. The strip
 * is also the window's drag handle. */
export function WindowBar() {
  const snapshot = useEgant((s) => s.snapshot);
  const toggleSidebar = useEgant((s) => s.toggleSidebar);
  const selectPrevSession = useEgant((s) => s.selectPrevSession);
  const selectNextSession = useEgant((s) => s.selectNextSession);
  const createSession = useEgant((s) => s.createSession);

  const sessions = snapshot?.sessions ?? [];
  const index = sessions.findIndex((s) => s.id === snapshot?.activeSession);
  const canBack = index > 0;
  const canForward = index >= 0 && index < sessions.length - 1;
  const open = snapshot?.sidebarVisible ?? true;

  return (
    <div
      data-tauri-drag-region
      // The 76px inset clears the traffic lights, which macOS draws over the
      // window rather than in a bar of its own.
      className="flex h-[38px] w-full shrink-0 items-center gap-0.5 pr-2 pl-[76px]"
    >
      {/* Frosted pill so the controls stay readable over bright wallpaper —
        same dark glass as the composer. The pill itself stays a drag region;
        buttons inside a drag region still receive clicks. */}
      <div
        data-tauri-drag-region
        className="composer flex items-center gap-0.5 px-1.5 py-0.5"
        style={{ borderRadius: "999px" }}
      >
      <Button
        label="Toggle sidebar · ⌘B"
        onClick={() => void toggleSidebar()}
        active={open}
      >
        <PanelLeft size={15} strokeWidth={2} />
      </Button>
      <Button
        label="Previous conversation"
        disabled={!canBack}
        onClick={() => void selectPrevSession()}
      >
        <ChevronLeft size={15} strokeWidth={2} />
      </Button>
      <Button
        label="Next conversation"
        disabled={!canForward}
        onClick={() => void selectNextSession()}
      >
        <ChevronRight size={15} strokeWidth={2} />
      </Button>
      <Button label="New conversation · ⌘N" onClick={() => void createSession()}>
        <Plus size={15} strokeWidth={2} />
      </Button>
      </div>
      <div data-tauri-drag-region className="h-full flex-1" />
    </div>
  );
}

function Button({
  label,
  disabled,
  active,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`cursor-pointer rounded-md p-1.5 hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-25 disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] ${
        active ? "text-[var(--ink)]" : "text-[var(--muted)]"
      }`}
    >
      {children}
    </button>
  );
}
