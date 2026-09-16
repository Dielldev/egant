import { Check, GitBranch, ListFilter, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ageLabel } from "../lib/transcript";
import { shouldOpenUpward } from "../lib/popover";
import type { SessionInfo } from "../lib/types";
import { AGENT_ACCENT, AGENT_PROVIDER, agentName } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";
import { useEgant } from "../store";
import { ProjectMenu } from "./ProjectMenu";
import { useNow } from "./useNow";
import { WindowBar } from "./WindowBar";

/** The window's one column of navigation: every conversation on this machine,
 * newest last, under a header naming the project they run in. The same
 * sidebar on the launch screen and over a conversation — it is the same list
 * either way, so it is the same component in the same place. */
export function Sidebar() {
  const snapshot = useEgant((s) => s.snapshot);
  const agents = useEgant((s) => s.agents);
  const filter = useEgant((s) => s.filter);
  const filterOpen = useEgant((s) => s.filterOpen);
  const setFilter = useEgant((s) => s.setFilter);
  const openFilter = useEgant((s) => s.openFilter);
  const closeFilter = useEgant((s) => s.closeFilter);
  const focusFilterToken = useEgant((s) => s.focusFilterToken);
  const sidebarOrganize = useEgant((s) => s.sidebarOrganize);
  const setSidebarOrganize = useEgant((s) => s.setSidebarOrganize);
  const sidebarSort = useEgant((s) => s.sidebarSort);
  const setSidebarSort = useEgant((s) => s.setSidebarSort);
  const sidebarShowBranch = useEgant((s) => s.sidebarShowBranch);
  const setSidebarShowBranch = useEgant((s) => s.setSidebarShowBranch);
  const sidebarShowHarness = useEgant((s) => s.sidebarShowHarness);
  const setSidebarShowHarness = useEgant((s) => s.setSidebarShowHarness);
  const selectProject = useEgant((s) => s.selectProject);
  const selectSession = useEgant((s) => s.selectSession);
  const closeSession = useEgant((s) => s.closeSession);
  const openSettings = useEgant((s) => s.openSettings);
  const sidebarWidth = useEgant((s) => s.sidebarWidth);
  const setSidebarWidth = useEgant((s) => s.setSidebarWidth);

  const filterRef = useRef<HTMLInputElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const [openUpward, setOpenUpward] = useState(false);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    if (focusFilterToken > 0) filterRef.current?.focus();
  }, [focusFilterToken]);

  const toggleFilter = () => {
    if (!filterOpen) {
      setOpenUpward(shouldOpenUpward(filterBtnRef, Math.min(360, window.innerHeight * 0.6)));
    }
    filterOpen ? closeFilter() : openFilter();
  };

  // Drag-to-resize from the sidebar's right edge. Reads the live width off
  // the store on every move rather than closing over `sidebarWidth`, so a
  // fast drag never fights a stale start point.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = useEgant.getState().sidebarWidth;
    setResizing(true);
    const onMove = (ev: PointerEvent) => {
      setSidebarWidth(startWidth + (ev.clientX - startX));
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  useEffect(() => {
    if (!filterOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeFilter();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filterOpen, closeFilter]);

  const machine = snapshot?.machineName ?? "";
  const sessions = snapshot?.sessions ?? [];
  const needle = filter.trim().toLowerCase();
  const projectNameOf = (projectId: number) =>
    snapshot?.projects.find((p) => p.id === projectId)?.name ?? "No project";

  const matched = sessions.filter(
    (session) =>
      needle === "" ||
      `${session.title} ${projectNameOf(session.projectId)}`.toLowerCase().includes(needle),
  );

  const rows = useMemo(() => {
    const list = [...matched];
    list.sort((a, b) =>
      sidebarSort === "updated"
        ? b.startedUnixMs - a.startedUnixMs
        : a.startedUnixMs - b.startedUnixMs,
    );
    return list;
  }, [matched, sidebarSort]);

  // Grouping preserves the sort order above — a group's position is wherever
  // its first (by that order) session lands, so switching sort still moves
  // the groups sensibly instead of relying on project-list order.
  const groups = useMemo(() => {
    if (sidebarOrganize !== "byProject") return null;
    const map = new Map<number, SessionInfo[]>();
    for (const session of rows) {
      const list = map.get(session.projectId);
      if (list) list.push(session);
      else map.set(session.projectId, [session]);
    }
    return Array.from(map.entries());
  }, [rows, sidebarOrganize]);

  const rowProps = (session: SessionInfo) => ({
    key: session.id,
    title: session.title,
    context: `${projectNameOf(session.projectId)} @ ${machine}`,
    age: session.startedUnixMs,
    selected: session.id === snapshot?.activeSession,
    busy: session.busy,
    agent: session.agent,
    branch: sidebarShowBranch ? session.branch : null,
    harnessLabel: sidebarShowHarness ? agentName(agents, session.agent) : null,
    onClick: () => void selectSession(session.id),
    onClose: () => void closeSession(session.id),
  });

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="sidebar-glass relative flex h-full shrink-0 flex-col text-[var(--muted)]"
    >
      <WindowBar />

      <div className="flex w-full items-center gap-1 px-3 pb-2">
        <ProjectMenu variant="header" machine={machine} />
        <div className="relative shrink-0">
          <button
            ref={filterBtnRef}
            type="button"
            title="Filter conversations · ⌘K"
            onClick={toggleFilter}
            className={`cursor-pointer rounded-md p-1 hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
              filterOpen ? "text-[var(--ink)]" : "text-[var(--faint)]"
            }`}
          >
            <ListFilter size={14} strokeWidth={2} />
          </button>

          {filterOpen && (
            <>
              <div
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => closeFilter()}
              />
              <div
                style={{ transformOrigin: openUpward ? "bottom right" : "top right" }}
                className={`menu absolute right-0 z-50 flex max-h-[min(360px,60vh)] w-[230px] flex-col overflow-hidden rounded-xl p-1.5 text-xs ${
                  openUpward ? "menu-pop-up bottom-full mb-1.5" : "menu-pop top-full mt-1.5"
                }`}
              >
                <div className="shrink-0 pb-1.5">
                  <div className="flex items-center gap-2 rounded-lg bg-[rgba(255,255,255,0.05)] px-2.5 py-1.5">
                    <Search size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                    <input
                      ref={filterRef}
                      autoFocus
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search conversations…"
                      className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
                    />
                    {filter !== "" && (
                      <button
                        type="button"
                        onClick={() => setFilter("")}
                        className="shrink-0 cursor-pointer text-[var(--faint)] hover:text-[var(--ink)]"
                      >
                        <X size={12} strokeWidth={2} />
                      </button>
                    )}
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  <SectionLabel>Organize</SectionLabel>
                  <OptionRow
                    checked={sidebarOrganize === "byProject"}
                    onClick={() => setSidebarOrganize("byProject")}
                  >
                    By project
                  </OptionRow>
                  <OptionRow
                    checked={sidebarOrganize === "flat"}
                    onClick={() => setSidebarOrganize("flat")}
                  >
                    In one list
                  </OptionRow>

                  <div className="mx-1.5 my-1 border-t border-[var(--border)]" />
                  <SectionLabel>Sort</SectionLabel>
                  <OptionRow
                    checked={sidebarSort === "updated"}
                    onClick={() => setSidebarSort("updated")}
                  >
                    Last updated
                  </OptionRow>
                  <OptionRow
                    checked={sidebarSort === "created"}
                    onClick={() => setSidebarSort("created")}
                  >
                    Created
                  </OptionRow>

                  <div className="mx-1.5 my-1 border-t border-[var(--border)]" />
                  <SectionLabel>Show</SectionLabel>
                  <OptionRow
                    checked={sidebarShowBranch}
                    onClick={() => setSidebarShowBranch(!sidebarShowBranch)}
                  >
                    Branch
                  </OptionRow>
                  <OptionRow
                    checked={sidebarShowHarness}
                    onClick={() => setSidebarShowHarness(!sidebarShowHarness)}
                  >
                    Harness
                  </OptionRow>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-1.5 pb-2">
        {groups
          ? groups.map(([projectId, list]) => (
              <div key={projectId} className="flex flex-col gap-px pt-1.5 first:pt-0">
                <button
                  type="button"
                  onClick={() => void selectProject(projectId)}
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1 text-left text-[11px] font-medium text-[var(--faint)] hover:text-[var(--ink)]"
                >
                  <span className="truncate">{projectNameOf(projectId)}</span>
                </button>
                {list.map((session) => (
                  <SessionRow {...rowProps(session)} />
                ))}
              </div>
            ))
          : rows.map((session) => <SessionRow {...rowProps(session)} />)}
        {rows.length === 0 && (
          <div className="px-2.5 py-1 text-xs text-[var(--faint)]">
            {sessions.length === 0 ? "No conversations yet" : "Nothing matches"}
          </div>
        )}
      </div>

      {/* Where the agent runs. Everything in this window is a local process on
        this machine, and the footer is the standing reminder of it — as well
        as the way into Settings. */}
      <div className="w-full shrink-0 px-2 py-2">
        <button
          type="button"
          title="Open settings · ⌘,"
          onClick={() => openSettings()}
          className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2 py-2 hover:bg-[var(--hover)]"
        >
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[rgba(255,255,255,0.1)] text-[11px] font-medium text-[var(--ink)]">
            L
          </span>
          <span className="truncate text-[13px] text-[var(--muted)]">Local only</span>
        </button>
      </div>

      {/* Drag-to-resize. A hair-thin hit target grown by its own padding so
        it's easy to grab without a visible gutter eating into the list. */}
      <div
        role="separator"
        aria-orientation="vertical"
        title="Drag to resize"
        onPointerDown={startResize}
        className="absolute top-0 right-0 z-10 h-full w-3 translate-x-1/2 cursor-col-resize"
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

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
      {children}
    </div>
  );
}

function OptionRow({
  checked,
  onClick,
  children,
}: {
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check size={13} strokeWidth={2} className="shrink-0 text-[var(--ink)]" />}
    </button>
  );
}

/** One conversation: where it runs and how long ago it started, then its
 * title. Two lines that read as a single unit, the way a mail client merges
 * sender, subject and snippet into one row. */
function SessionRow({
  title,
  context,
  age,
  selected,
  busy,
  agent,
  branch,
  harnessLabel,
  onClick,
  onClose,
}: {
  title: string;
  context: string;
  age: number;
  selected: boolean;
  busy: boolean;
  agent: string;
  branch?: string | null;
  harnessLabel?: string | null;
  onClick: () => void;
  onClose: () => void;
}) {
  const now = useNow(30_000);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={`group flex w-full cursor-pointer flex-col gap-[3px] rounded-lg px-2.5 py-2 text-left ${
        selected ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
      }`}
    >
      <span className="flex w-full items-center text-[11px] text-[var(--faint)]">
        <span className="min-w-0 flex-1 truncate">
          {context}
          {harnessLabel && <> · {harnessLabel}</>}
          {branch && (
            <span className="ml-1 inline-flex items-center gap-0.5 align-middle">
              <GitBranch size={10} strokeWidth={2} className="inline shrink-0" /> {branch}
            </span>
          )}
        </span>
        {busy && <span className="mx-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
        {/* The close button takes the timestamp's place on hover rather than
          adding a column that shifts the row. */}
        <span className="ml-2 shrink-0 group-hover:hidden">{ageLabel(age, now)}</span>
        <button
          type="button"
          title="Close conversation"
          onClick={(e) => {
            // Stops the click reaching the row, which would select the
            // conversation on its way to closing it.
            e.stopPropagation();
            onClose();
          }}
          className="ml-2 hidden shrink-0 cursor-pointer rounded-sm p-0.5 hover:bg-[rgba(255,255,255,0.12)] hover:text-[var(--ink)] group-hover:block"
        >
          <X size={11} strokeWidth={2} />
        </button>
      </span>
      <span className="flex w-full items-center gap-1.5">
        <ProviderGlyph
          provider={AGENT_PROVIDER[agent] ?? agent}
          size={13}
          color={AGENT_ACCENT[agent]}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[var(--ink)]">
          {title}
        </span>
      </span>
    </div>
  );
}
