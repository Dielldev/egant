import {
  FolderTree,
  GitBranch,
  GitCompare,
  Maximize2,
  Minimize2,
  Plus,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PanelTabKind } from "../store";
import { useEgant, workspaceRoot } from "../store";
import { DiffsPanel } from "./DiffsPanel";
import { FileTree } from "./FileTree";
import { HistoryPanel } from "./HistoryPanel";
import { disposeTerminalsExcept, TerminalPane } from "./TerminalPane";

/** The column on the right: the project's files and its terminals, in tabs.
 *
 * It is the window's third column and the only one that isn't about the
 * conversation — which is why it stays closed until the stage header's panel
 * button asks for it. Its tabs belong to the window rather than to a
 * conversation: a shell running a build should not disappear because the
 * sidebar moved to another thread. */
export function WorkspacePanel() {
  const panelWidth = useEgant((s) => s.panelWidth);
  const setPanelWidth = useEgant((s) => s.setPanelWidth);
  const tabs = useEgant((s) => s.panelTabs);
  const activeTab = useEgant((s) => s.panelTab);
  const setPanelTab = useEgant((s) => s.setPanelTab);
  const closePanelTab = useEgant((s) => s.closePanelTab);
  const openFilesTab = useEgant((s) => s.openFilesTab);
  const openTerminalTab = useEgant((s) => s.openTerminalTab);
  const openDiffsTab = useEgant((s) => s.openDiffsTab);
  const openHistoryTab = useEgant((s) => s.openHistoryTab);
  const togglePanel = useEgant((s) => s.togglePanel);
  const snapshot = useEgant((s) => s.snapshot);
  const maximized = useEgant((s) => s.panelMaximized);
  const toggleMaximized = useEgant((s) => s.togglePanelMaximized);
  const sidebarWidth = useEgant((s) => s.sidebarWidth);
  const sidebarVisible = snapshot?.sidebarVisible ?? true;

  const [adding, setAdding] = useState(false);
  const [resizing, setResizing] = useState(false);
  // Maximized means "everything the sidebar isn't using". Held as a number
  // rather than a class so the width can be animated between the two states —
  // `flex-1` has nothing to transition from.
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setWindowWidth(window.innerWidth);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  const fullWidth = Math.max(320, windowWidth - (sidebarVisible ? sidebarWidth : 0));

  // The file tree follows the conversation in front of you; a terminal keeps
  // the directory it was opened in.
  const root = workspaceRoot(snapshot);

  // A closed tab's shell is killed by the store; this drops the xterm that was
  // drawing it.
  useEffect(() => {
    disposeTerminalsExcept(tabs.map((tab) => tab.id));
  }, [tabs]);

  // Drag-to-resize from the panel's left edge — the mirror of the sidebar's,
  // so the width grows as the pointer moves left.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useEgant.getState().panelWidth;
    setResizing(true);
    const onMove = (ev: PointerEvent) => setPanelWidth(startWidth - (ev.clientX - startX));
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <aside
      style={{
        width: maximized ? fullWidth : panelWidth,
        // Only while it is settling between the two states: a transition left
        // on permanently would make the drag-to-resize handle lag the pointer.
        transition: resizing ? undefined : "width 280ms cubic-bezier(0.22, 1, 0.36, 1)",
      }}
      className="sidebar-glass relative z-20 flex h-full shrink-0 flex-col border-l border-[var(--border)] text-[var(--muted)]"
    >
      {/* Same height as the window bar across the way, so the three columns
        start their content on one line. The strip doubles as a drag region. */}
      <div
        data-tauri-drag-region
        className="flex h-[38px] w-full shrink-0 items-center gap-1 pr-1.5 pl-1.5"
      >
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {tabs.map((tab) => (
            <PanelTabButton
              key={tab.id}
              icon={<TabIcon kind={tab.kind} size={13} />}
              title={tab.title}
              dim={tab.exited === true}
              active={tab.id === activeTab}
              onClick={() => setPanelTab(tab.id)}
              onClose={() => closePanelTab(tab.id)}
            />
          ))}
        </div>

        <div className="relative shrink-0">
          <button
            type="button"
            title="New tab"
            onClick={() => setAdding((open) => !open)}
            className={`cursor-pointer rounded-md p-1 hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
              adding ? "text-[var(--ink)]" : "text-[var(--faint)]"
            }`}
          >
            <Plus size={14} strokeWidth={2} />
          </button>
          {adding && (
            <>
              <div
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setAdding(false)}
              />
              <div className="menu menu-pop absolute top-full right-0 z-50 mt-1.5 flex w-[180px] flex-col overflow-hidden rounded-xl p-1.5 text-[13px]">
                <MenuRow
                  icon={<FolderTree size={13} strokeWidth={2} />}
                  onClick={() => {
                    openFilesTab();
                    setAdding(false);
                  }}
                >
                  Files
                </MenuRow>
                <MenuRow
                  icon={<GitCompare size={13} strokeWidth={2} />}
                  onClick={() => {
                    openDiffsTab();
                    setAdding(false);
                  }}
                >
                  Diffs
                </MenuRow>
                <MenuRow
                  icon={<GitBranch size={13} strokeWidth={2} />}
                  onClick={() => {
                    openHistoryTab();
                    setAdding(false);
                  }}
                >
                  History
                </MenuRow>
                <MenuRow
                  icon={<TerminalIcon size={13} strokeWidth={2} />}
                  onClick={() => {
                    openTerminalTab();
                    setAdding(false);
                  }}
                >
                  New terminal
                </MenuRow>
              </div>
            </>
          )}
        </div>

        <button
          type="button"
          title={maximized ? "Back to the conversation · ⌘⇧J" : "Fill the window · ⌘⇧J"}
          onClick={() => toggleMaximized()}
          className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          {maximized ? (
            <Minimize2 size={13} strokeWidth={2} />
          ) : (
            <Maximize2 size={13} strokeWidth={2} />
          )}
        </button>

        <button
          type="button"
          title="Close panel"
          onClick={() => togglePanel()}
          className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Every tab stays mounted and hidden rather than unmounting: a terminal
        is a running process, and a tree is a page of expansions the user has
        already paid for. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`min-h-0 flex-1 flex-col ${tab.id === activeTab ? "flex" : "hidden"}`}
          >
            {tab.kind === "files" ? (
              <FileTree root={root} />
            ) : tab.kind === "diffs" ? (
              <DiffsPanel root={root} tabId={tab.id} scope={tab.scope} />
            ) : tab.kind === "history" ? (
              <HistoryPanel root={root} />
            ) : (
              <TerminalPane tabId={tab.id} cwd={tab.cwd} active={tab.id === activeTab} />
            )}
          </div>
        ))}
        {/* The panel with nothing in it is the chooser: the button that
          opened it deliberately doesn't decide what it should hold. */}
        {tabs.length === 0 && (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-5">
            <div className="mb-1 text-[12px] text-[var(--faint)]">Open in this panel</div>
            <ChooserButton
              icon={<FolderTree size={15} strokeWidth={1.9} />}
              label="Files"
              detail="Browse the project"
              onClick={openFilesTab}
            />
            <ChooserButton
              icon={<GitCompare size={15} strokeWidth={1.9} />}
              label="Diffs"
              detail="What changed, and against what"
              onClick={openDiffsTab}
            />
            <ChooserButton
              icon={<TerminalIcon size={15} strokeWidth={1.9} />}
              label="Terminal"
              detail="A shell in this folder"
              onClick={openTerminalTab}
            />
            <ChooserButton
              icon={<GitBranch size={15} strokeWidth={1.9} />}
              label="History"
              detail="Every commit, newest first"
              onClick={openHistoryTab}
            />
          </div>
        )}
      </div>

      {/* Drag-to-resize, matching the sidebar's hair-thin target. Gone while
        the panel is maximized: its width is the window's, and dragging would
        be an argument with the button that set it. */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={startResize}
        className={`absolute top-0 left-0 z-10 h-full w-3 -translate-x-1/2 cursor-col-resize ${
          maximized ? "hidden" : ""
        }`}
      >
        <div
          className={`mx-auto h-full w-px transition-colors ${
            resizing ? "bg-[var(--accent)]" : "bg-transparent hover:bg-[var(--border)]"
          }`}
        />
      </div>
    </aside>
  );
}

/** The glyph for a panel tab's kind, shared by its tab and its button. */
function TabIcon({ kind, size = 12 }: { kind: PanelTabKind; size?: number }) {
  const props = { size, strokeWidth: 2 } as const;
  if (kind === "files") return <FolderTree {...props} />;
  if (kind === "diffs") return <GitCompare {...props} />;
  if (kind === "history") return <GitBranch {...props} />;
  return <TerminalIcon {...props} />;
}

/** One of the things the panel can hold. Big enough to be the answer to
 * "what is this column for?" the first time it opens. */
function ChooserButton({
  icon,
  label,
  detail,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  detail: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full max-w-[220px] cursor-pointer items-center gap-2.5 rounded-lg border border-[var(--border)] px-3 py-2 text-left hover:bg-[var(--hover)]"
    >
      <span className="shrink-0 text-[var(--muted)]">{icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[14px] text-[var(--ink)]">{label}</span>
        <span className="truncate text-[12px] text-[var(--faint)]">{detail}</span>
      </span>
    </button>
  );
}

function PanelTabButton({
  icon,
  title,
  active,
  dim,
  onClick,
  onClose,
}: {
  icon: React.ReactNode;
  title: string;
  active: boolean;
  dim: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      title={title}
      className={`group flex max-w-[140px] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1 pl-1.5 text-[13px] ${
        active
          ? "bg-[var(--selected)] text-[var(--ink)]"
          : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      } ${dim ? "opacity-55" : ""}`}
    >
      <span className="shrink-0 text-[var(--faint)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <button
        type="button"
        title="Close tab"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="shrink-0 cursor-pointer rounded-sm p-0.5 opacity-0 group-hover:opacity-100 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <X size={11} strokeWidth={2.2} />
      </button>
    </div>
  );
}

function MenuRow({
  icon,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      <span className="shrink-0 text-[var(--faint)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}
