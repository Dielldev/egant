import {
  Check,
  ChevronRight,
  FolderGit2,
  ListFilter,
  Plus,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { shouldOpenUpward } from "../lib/popover";
import type { SessionInfo, WorktreeInfo } from "../lib/types";
import { agentName, AGENT_ACCENT, AGENT_PROVIDER } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";
import { useEgant } from "../store";
import { ProjectMenu } from "./ProjectMenu";
import { WindowBar } from "./WindowBar";

/** The window's one column of navigation: every conversation on this machine,
 * newest last, under a header naming the project they run in. The same
 * sidebar on the launch screen and over a conversation — it is the same list
 * either way, so it is the same component in the same place. */
export function Sidebar() {
  const snapshot = useEgant((s) => s.snapshot);
  const agents = useEgant((s) => s.agents);
  const catalog = useEgant((s) => s.catalog);
  const filter = useEgant((s) => s.filter);
  const filterOpen = useEgant((s) => s.filterOpen);
  const setFilter = useEgant((s) => s.setFilter);
  const openFilter = useEgant((s) => s.openFilter);
  const closeFilter = useEgant((s) => s.closeFilter);
  const focusFilterToken = useEgant((s) => s.focusFilterToken);
  const openSearch = useEgant((s) => s.openSearch);
  const sidebarOrganize = useEgant((s) => s.sidebarOrganize);
  const setSidebarOrganize = useEgant((s) => s.setSidebarOrganize);
  const sidebarSort = useEgant((s) => s.sidebarSort);
  const setSidebarSort = useEgant((s) => s.setSidebarSort);
  const sidebarShowBranch = useEgant((s) => s.sidebarShowBranch);
  const setSidebarShowBranch = useEgant((s) => s.setSidebarShowBranch);
  const sidebarShowHarness = useEgant((s) => s.sidebarShowHarness);
  const setSidebarShowHarness = useEgant((s) => s.setSidebarShowHarness);
  const sidebarWorktreesOnly = useEgant((s) => s.sidebarWorktreesOnly);
  const setSidebarWorktreesOnly = useEgant((s) => s.setSidebarWorktreesOnly);
  const collapsedProjects = useEgant((s) => s.collapsedProjects);
  const toggleProjectCollapsed = useEgant((s) => s.toggleProjectCollapsed);
  const collapsedWorktrees = useEgant((s) => s.collapsedWorktrees);
  const toggleWorktreeCollapsed = useEgant((s) => s.toggleWorktreeCollapsed);
  const selectProject = useEgant((s) => s.selectProject);
  const selectSession = useEgant((s) => s.selectSession);
  const closeSession = useEgant((s) => s.closeSession);
  const createSession = useEgant((s) => s.createSession);
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
      (!sidebarWorktreesOnly || session.worktree != null) &&
      (needle === "" ||
        `${session.title} ${projectNameOf(session.projectId)}`.toLowerCase().includes(needle)),
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
  // the groups sensibly instead of relying on project-list order. Within a
  // project, sessions running in their own worktree are further split into
  // one folder per worktree — the checkout is what actually separates them,
  // same as separate branches in a real folder tree — while sessions still on
  // the project's own checkout stay flat under the project, as they always
  // did.
  const groups = useMemo(() => {
    if (sidebarOrganize !== "byProject") return null;
    const map = new Map<number, SessionInfo[]>();
    for (const session of rows) {
      const list = map.get(session.projectId);
      if (list) list.push(session);
      else map.set(session.projectId, [session]);
    }
    return Array.from(map.entries()).map(([projectId, list]) => {
      const main: SessionInfo[] = [];
      const worktreeOrder: string[] = [];
      const worktreeMap = new Map<string, { worktree: WorktreeInfo; sessions: SessionInfo[] }>();
      for (const session of list) {
        const worktree = session.worktree;
        if (!worktree) {
          main.push(session);
          continue;
        }
        const entry = worktreeMap.get(worktree.path);
        if (entry) entry.sessions.push(session);
        else {
          worktreeMap.set(worktree.path, { worktree, sessions: [session] });
          worktreeOrder.push(worktree.path);
        }
      }
      return {
        projectId,
        total: list.length,
        main,
        worktrees: worktreeOrder.map((path) => worktreeMap.get(path)!),
      };
    });
  }, [rows, sidebarOrganize]);

  const rowProps = (session: SessionInfo) => {
    const project = projectNameOf(session.projectId);
    const branch = sidebarShowBranch ? session.branch : null;
    const harness = sidebarShowHarness
      ? (catalog.find((c) => c.id === session.agent)?.name ??
        agentName(agents, session.agent))
      : null;
    return {
      key: session.id,
      title: session.title,
      tooltip: `${session.title} — ${project} @ ${machine}${branch ? ` · ${branch}` : ""}${harness ? ` · ${harness}` : ""}`,
      projectLabel: project,
      selected: session.id === snapshot?.activeSession,
      busy: session.busy,
      agent: session.agent,
      cli: session.kind === "cli",
      branch,
      onClick: () => void selectSession(session.id),
      onClose: () => void closeSession(session.id),
    };
  };

  const newSessionInProject = (projectId: number) => {
    const run = async () => {
      if (snapshot?.activeProject !== projectId) await selectProject(projectId);
      await createSession();
    };
    void run();
  };

  const newSessionInWorktree = (projectId: number, worktree: WorktreeInfo) => {
    const run = async () => {
      if (snapshot?.activeProject !== projectId) await selectProject(projectId);
      await createSession(worktree);
    };
    void run();
  };

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="sidebar-glass relative flex h-full shrink-0 flex-col text-[var(--muted)]"
    >
      <WindowBar />

      <div className="flex w-full items-center gap-1 px-3 pb-2">
        <ProjectMenu variant="header" machine={machine} />
        <button
          type="button"
          title="Search sessions and projects"
          onClick={() => openSearch()}
          className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <Search size={14} strokeWidth={2} />
        </button>
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
                  <div className="flex items-center gap-2 rounded-lg bg-[var(--card)] px-2.5 py-1.5">
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
                  <SectionLabel>Filter</SectionLabel>
                  <OptionRow
                    checked={sidebarWorktreesOnly}
                    onClick={() => setSidebarWorktreesOnly(!sidebarWorktreesOnly)}
                  >
                    Worktrees only
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
          ? groups.map(({ projectId, total, main, worktrees }) => {
              // A search in progress overrides collapse: hiding the very
              // match the user is looking for would defeat the search.
              const collapsed = needle === "" && !!collapsedProjects[String(projectId)];
              return (
                <div key={projectId} className="flex flex-col gap-px pt-3 first:pt-0">
                  <div className="group flex w-full items-center gap-1 rounded-md py-1 pr-1 pl-1">
                    <button
                      type="button"
                      title={collapsed ? "Expand" : "Collapse"}
                      onClick={() => toggleProjectCollapsed(projectId)}
                      className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                    >
                      <ChevronRight
                        size={11}
                        strokeWidth={2.5}
                        className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
                      />
                    </button>
                    <button
                      type="button"
                      title={projectNameOf(projectId)}
                      onClick={() => void selectProject(projectId)}
                      className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12.5px] font-normal text-[var(--muted)] hover:text-[var(--ink)]"
                    >
                      {projectNameOf(projectId)}
                    </button>
                    {collapsed && (
                      <span className="shrink-0 text-[10.5px] text-[var(--faint)]">
                        {total}
                      </span>
                    )}
                    <button
                      type="button"
                      title={`New conversation in ${projectNameOf(projectId)}`}
                      onClick={() => newSessionInProject(projectId)}
                      className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] opacity-100 hover:bg-[var(--hover)] hover:text-[var(--ink)] group-hover:opacity-100"
                    >
                      <Plus size={12} strokeWidth={2} />
                    </button>
                  </div>
                  {!collapsed && (
                    <>
                      {main.map((session) => (
                        <SessionRow {...rowProps(session)} showProject={false} />
                      ))}
                      {worktrees.map(({ worktree, sessions }) => {
                        const worktreeKey = `${projectId}:${worktree.path}`;
                        const worktreeCollapsed =
                          needle === "" && !!collapsedWorktrees[worktreeKey];
                        return (
                          <div key={worktreeKey} className="flex flex-col gap-px">
                            <div className="group flex w-full items-center gap-1 rounded-md py-1 pr-1 pl-4">
                              <button
                                type="button"
                                title={worktreeCollapsed ? "Expand" : "Collapse"}
                                onClick={() => toggleWorktreeCollapsed(worktreeKey)}
                                className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                              >
                                <ChevronRight
                                  size={10}
                                  strokeWidth={2.5}
                                  className={`transition-transform ${worktreeCollapsed ? "" : "rotate-90"}`}
                                />
                              </button>
                              <button
                                type="button"
                                title={`${worktree.branch} — cut from ${worktree.base}`}
                                onClick={() => toggleWorktreeCollapsed(worktreeKey)}
                                className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left text-[var(--faint)] hover:text-[var(--ink)]"
                              >
                                <FolderGit2 size={11} strokeWidth={2} className="shrink-0" />
                                <span className="min-w-0 flex-1 truncate text-[11.5px] font-normal">
                                  {worktree.name}
                                </span>
                              </button>
                              {worktreeCollapsed && (
                                <span className="shrink-0 text-[10.5px] text-[var(--faint)]">
                                  {sessions.length}
                                </span>
                              )}
                              <button
                                type="button"
                                title={`New conversation in ${worktree.name}`}
                                onClick={() => newSessionInWorktree(projectId, worktree)}
                                className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] opacity-100 hover:bg-[var(--hover)] hover:text-[var(--ink)] group-hover:opacity-100"
                              >
                                <Plus size={11} strokeWidth={2} />
                              </button>
                            </div>
                            {!worktreeCollapsed &&
                              sessions.map((session) => (
                                <SessionRow {...rowProps(session)} showProject={false} indent />
                              ))}
                          </div>
                        );
                      })}
                    </>
                  )}
                </div>
              );
            })
          : rows.map((session) => <SessionRow {...rowProps(session)} showProject />)}
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
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--bubble)] text-[11px] font-medium text-[var(--ink)]">
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

/** One conversation: a single compact line — agent logo + title — grouped
 * under its project like Claude Code. The grey `project @ machine` meta line
 * is gone (the group header already says where it runs). History reads small
 * like opencode: 12.5px titles with tight padding. Flat list keeps the
 * project name as a faint suffix since there is no header to say it. */
function SessionRow({
  title,
  tooltip,
  projectLabel,
  showProject,
  selected,
  busy,
  agent,
  cli,
  branch,
  indent,
  onClick,
  onClose,
}: {
  title: string;
  tooltip: string;
  projectLabel: string;
  showProject?: boolean;
  selected: boolean;
  busy: boolean;
  agent: string;
  /** This session is the agent's own CLI in a terminal, not a chat. */
  cli?: boolean;
  branch?: string | null;
  /** Nested under a worktree folder — pushed in to read as a child of it. */
  indent?: boolean;
  onClick: () => void;
  onClose: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      title={tooltip}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={`group flex w-full cursor-pointer items-center gap-2 rounded-md py-[5px] pr-2 text-left ${
        indent ? "pl-8" : "pl-2"
      } ${selected ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
    >
      <ProviderGlyph
        provider={AGENT_PROVIDER[agent] ?? agent}
        size={12}
        color={AGENT_ACCENT[agent]}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[12.5px] leading-[1.35] ${
          selected
            ? "font-medium text-[var(--ink)]"
            : "font-normal text-[var(--muted)] group-hover:text-[var(--ink)]"
        }`}
      >
        {title}
      </span>
      {showProject && (
        <span className="max-w-[90px] shrink-0 truncate text-[10.5px] text-[var(--faint)]">
          {projectLabel}
        </span>
      )}
      {branch && (
        <span
          title={`Branch ${branch}`}
          className="max-w-[80px] shrink-0 truncate text-[10.5px] text-[var(--faint)]"
        >
          {branch}
        </span>
      )}
      {busy && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--busy)]" />}
      {/* Two rows can otherwise look identical — same agent, same project —
        while one is a transcript and the other a live terminal. */}
      {cli && (
        <TerminalSquare size={10} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
      )}
      <button
        type="button"
        title="Close conversation"
        onClick={(e) => {
          // Stops the click reaching the row, which would select the
          // conversation on its way to closing it.
          e.stopPropagation();
          onClose();
        }}
        className="hidden shrink-0 cursor-pointer rounded-sm p-0.5 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)] group-hover:block"
      >
        <X size={10} strokeWidth={2} />
      </button>
    </div>
  );
}
