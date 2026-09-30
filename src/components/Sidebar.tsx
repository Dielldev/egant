import {
  Archive,
  Bot,
  Calendar,
  Check,
  ChevronDown,
  Clock,
  FolderGit2,
  Folder,
  GitBranch,
  Laptop,
  List,
  ListFilter,
  MapPin,
  Plus,
  Search,
  Smartphone,
  TerminalSquare,
  X,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { shouldOpenUpward } from "../lib/popover";
import { modShortcut } from "../lib/platform";
import type { MobileDevice, SessionInfo } from "../lib/types";
import { agentName, AGENT_ACCENT, AGENT_PROVIDER } from "./AgentPicker";
import { EditableTitle } from "./EditableTitle";
import { ProviderGlyph } from "./ProviderLogo";
import { useEgant } from "../store";
import { ProjectMenu } from "./ProjectMenu";
import { WindowBar } from "./WindowBar";

/** The window's one column of navigation, laid out like zeron's: a project
 * dropdown on top ("All projects" or one folder), then that folder's
 * conversations as two-line cards under a section header. Pick a folder and
 * only its conversations are listed; pick "All projects" and every one is. The
 * same sidebar on the launch screen and over a conversation — it is the same
 * list either way, so it is the same component in the same place. */
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
  const sidebarProject = useEgant((s) => s.sidebarProject);
  const sidebarSort = useEgant((s) => s.sidebarSort);
  const setSidebarSort = useEgant((s) => s.setSidebarSort);
  const sidebarShowBranch = useEgant((s) => s.sidebarShowBranch);
  const setSidebarShowBranch = useEgant((s) => s.setSidebarShowBranch);
  const sidebarShowHarness = useEgant((s) => s.sidebarShowHarness);
  const setSidebarShowHarness = useEgant((s) => s.setSidebarShowHarness);
  const sidebarShowLocation = useEgant((s) => s.sidebarShowLocation);
  const setSidebarShowLocation = useEgant((s) => s.setSidebarShowLocation);
  const sidebarWorktreesOnly = useEgant((s) => s.sidebarWorktreesOnly);
  const setSidebarWorktreesOnly = useEgant((s) => s.setSidebarWorktreesOnly);
  const collapsedGroups = useEgant((s) => s.collapsedGroups);
  const toggleGroupCollapsed = useEgant((s) => s.toggleGroupCollapsed);
  const selectProject = useEgant((s) => s.selectProject);
  const selectSession = useEgant((s) => s.selectSession);
  const archiveSession = useEgant((s) => s.archiveSession);
  const renameSession = useEgant((s) => s.renameSession);
  const unread = useEgant((s) => s.unread);
  const createSession = useEgant((s) => s.createSession);
  const openSettings = useEgant((s) => s.openSettings);
  const sidebarWidth = useEgant((s) => s.sidebarWidth);
  const setSidebarWidth = useEgant((s) => s.setSidebarWidth);

  const filterRef = useRef<HTMLInputElement>(null);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const [openUpward, setOpenUpward] = useState(false);
  const [resizing, setResizing] = useState(false);
  const now = useNow();

  useEffect(() => {
    if (focusFilterToken > 0) filterRef.current?.focus();
  }, [focusFilterToken]);

  const toggleFilter = () => {
    if (!filterOpen) {
      setOpenUpward(shouldOpenUpward(filterBtnRef, Math.min(420, window.innerHeight * 0.7)));
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
  const projects = snapshot?.projects ?? [];
  const sessions = snapshot?.sessions ?? [];
  const needle = filter.trim().toLowerCase();
  const projectNameOf = (projectId: number) =>
    projects.find((p) => p.id === projectId)?.name ?? "No project";
  // A filter naming a folder that has since been removed reads as "All
  // projects" — the header does the same — rather than an empty list.
  const listedProject =
    sidebarProject != null && projects.some((p) => p.id === sidebarProject)
      ? sidebarProject
      : null;
  const inProject = listedProject == null ? sessions : sessions.filter((s) => s.projectId === listedProject);

  const rows = useMemo(() => {
    const list = inProject.filter(
      (session) =>
        (!sidebarWorktreesOnly || session.worktree != null) &&
        (needle === "" ||
          `${session.title} ${projectNameOf(session.projectId)}`.toLowerCase().includes(needle)),
    );
    list.sort((a, b) =>
      sidebarSort === "updated"
        ? b.startedUnixMs - a.startedUnixMs
        : a.startedUnixMs - b.startedUnixMs,
    );
    return list;
    // `projectNameOf` closes over `projects`, which is what actually changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inProject, sidebarWorktreesOnly, needle, sidebarSort, projects]);

  const pairedDevices = usePairedDevices();

  // Grouping preserves the sort order above — a group's position is wherever
  // its first (by that order) session lands, so switching sort still moves the
  // groups sensibly instead of relying on project-list order. By device is the
  // exception: the Mac's group leads, then each phone by its latest chat.
  const groups = useMemo(() => {
    if (sidebarOrganize === "flat") return null;
    type Group = {
      key: string;
      label: string;
      projectId: number | null;
      phone: boolean;
      sessions: SessionInfo[];
      /** What an empty group says instead of a list. */
      note?: string;
    };
    const map = new Map<string, Group>();
    const byProject = sidebarOrganize === "byProject";
    for (const session of rows) {
      const place = session.device ?? machine;
      const key = byProject ? `project:${session.projectId}` : `device:${place}`;
      let group = map.get(key);
      if (!group) {
        group = {
          key,
          label: byProject ? projectNameOf(session.projectId) : place || "This device",
          projectId: byProject ? session.projectId : null,
          phone: !byProject && session.device != null,
          sessions: [],
        };
        map.set(key, group);
      }
      group.sessions.push(session);
    }
    if (byProject) return Array.from(map.values());

    // A paired phone with nothing to list still gets its group, so it is
    // always findable — unless a search or a project is narrowing the list,
    // where every phone would look empty for the wrong reason.
    if (needle === "" && listedProject == null) {
      for (const device of pairedDevices) {
        const key = `device:${device.name}`;
        if (map.has(key)) continue;
        map.set(key, {
          key,
          label: device.name,
          projectId: null,
          phone: true,
          sessions: [],
          note: sessions.some((s) => s.device === device.name)
            ? "Its chats are hidden by the Worktrees only filter"
            : "No chats yet",
        });
      }
    }
    const latest = (group: Group) =>
      group.sessions.reduce((at, s) => Math.max(at, s.startedUnixMs), 0);
    const seen = (group: Group) =>
      pairedDevices.find((d) => d.name === group.label)?.lastSeenMs ?? 0;
    return Array.from(map.values()).sort((a, b) => {
      if (a.phone !== b.phone) return a.phone ? 1 : -1;
      if (!a.phone) return 0;
      // Phones with chats by their newest chat; ones with none after them,
      // by when the phone was last seen.
      const aEmpty = a.sessions.length === 0;
      const bEmpty = b.sessions.length === 0;
      if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
      return aEmpty ? seen(b) - seen(a) : latest(b) - latest(a);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, sessions, sidebarOrganize, machine, projects, pairedDevices, needle, listedProject]);

  const rowProps = (session: SessionInfo) => {
    const project = projectNameOf(session.projectId);
    const branch = sidebarShowBranch ? (session.worktree?.branch ?? session.branch) : null;
    const harness =
      catalog.find((c) => c.id === session.agent)?.name ?? agentName(agents, session.agent);
    return {
      title: session.title,
      tooltip: `${session.title} — ${project} @ ${session.device ?? machine}${session.branch ? ` · ${session.branch}` : ""} · ${harness}`,
      location: sidebarShowLocation
        ? `${project}${(session.device ?? machine) ? ` @ ${session.device ?? machine}` : ""}`
        : null,
      startedUnixMs: session.startedUnixMs,
      now,
      selected: session.id === snapshot?.activeSession,
      busy: session.busy,
      // opencode's denials arrive after its turn has already ended, so a
      // waiting row counts as much as the state does (the phone's "Needs you"
      // group reads the same count).
      awaiting: session.state === "awaiting_permission" || (session.pendingCount ?? 0) > 0,
      unread: unread[session.id] === true,
      agent: session.agent,
      showHarness: sidebarShowHarness,
      cli: session.kind === "cli",
      branch,
      inWorktree: session.worktree != null,
      // Under By device the group header already says it's a phone's.
      phone: sidebarOrganize !== "byDevice" ? session.device : null,
      onClick: () => void selectSession(session.id),
      onArchive: () => void archiveSession(session.id),
      onRename: (title: string) => void renameSession(session.id, title),
    };
  };

  const newSessionInProject = (projectId: number) => {
    const run = async () => {
      if (snapshot?.activeProject !== projectId) await selectProject(projectId);
      await createSession();
    };
    void run();
  };

  return (
    <aside
      style={{ width: sidebarWidth }}
      className="sidebar-glass relative flex h-full shrink-0 flex-col text-[var(--muted)]"
    >
      <WindowBar />

      <div data-tauri-drag-region className="flex w-full items-center gap-1 px-2 pt-1 pb-1">
        <ProjectMenu variant="header" machine={machine} />
        <button
          type="button"
          title="Search sessions and projects"
          onClick={() => openSearch()}
          className="flex h-[29px] w-[29px] shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <Search size={15} strokeWidth={2} />
        </button>
        <div className="relative shrink-0">
          <button
            ref={filterBtnRef}
            type="button"
            title={`View options · ${modShortcut("K")}`}
            onClick={toggleFilter}
            className={`flex h-[29px] w-[29px] cursor-pointer items-center justify-center rounded-lg hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
              filterOpen ? "bg-[var(--hover)] text-[var(--ink)]" : "text-[var(--muted)]"
            }`}
          >
            <ListFilter size={15} strokeWidth={2} />
          </button>

          {filterOpen && (
            <>
              <div
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => closeFilter()}
              />
              <div
                style={{ transformOrigin: openUpward ? "bottom right" : "top right" }}
                className={`menu absolute right-0 z-50 flex max-h-[min(440px,70vh)] w-[240px] flex-col overflow-hidden rounded-xl p-1.5 text-[13px] ${
                  openUpward ? "menu-pop-up bottom-full mb-1.5" : "menu-pop top-full mt-1.5"
                }`}
              >
                <div className="shrink-0 pb-1.5">
                  <div className="flex items-center gap-2 rounded-lg bg-[var(--card)] px-2.5 py-1.5">
                    <Search size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                    <input
                      ref={filterRef}
                      autoFocus
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Search conversations…"
                      className="min-w-0 flex-1 bg-transparent text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
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
                    icon={Laptop}
                    checked={sidebarOrganize === "byDevice"}
                    onClick={() => setSidebarOrganize("byDevice")}
                  >
                    By device
                  </OptionRow>
                  <OptionRow
                    icon={Folder}
                    checked={sidebarOrganize === "byProject"}
                    onClick={() => setSidebarOrganize("byProject")}
                  >
                    By project
                  </OptionRow>
                  <OptionRow
                    icon={List}
                    checked={sidebarOrganize === "flat"}
                    onClick={() => setSidebarOrganize("flat")}
                  >
                    None
                  </OptionRow>

                  <div className="mx-1.5 my-1 border-t border-[var(--border)]" />
                  <SectionLabel>Filter</SectionLabel>
                  <OptionRow
                    icon={FolderGit2}
                    checked={sidebarWorktreesOnly}
                    onClick={() => setSidebarWorktreesOnly(!sidebarWorktreesOnly)}
                  >
                    Worktrees only
                  </OptionRow>

                  <div className="mx-1.5 my-1 border-t border-[var(--border)]" />
                  <SectionLabel>Sort</SectionLabel>
                  <OptionRow
                    icon={Clock}
                    checked={sidebarSort === "updated"}
                    onClick={() => setSidebarSort("updated")}
                  >
                    Last updated
                  </OptionRow>
                  <OptionRow
                    icon={Calendar}
                    checked={sidebarSort === "created"}
                    onClick={() => setSidebarSort("created")}
                  >
                    Created
                  </OptionRow>

                  <div className="mx-1.5 my-1 border-t border-[var(--border)]" />
                  <SectionLabel>Show</SectionLabel>
                  <OptionRow
                    icon={GitBranch}
                    checked={sidebarShowBranch}
                    onClick={() => setSidebarShowBranch(!sidebarShowBranch)}
                  >
                    Branch
                  </OptionRow>
                  <OptionRow
                    icon={Bot}
                    checked={sidebarShowHarness}
                    onClick={() => setSidebarShowHarness(!sidebarShowHarness)}
                  >
                    Harness
                  </OptionRow>
                  <OptionRow
                    icon={MapPin}
                    checked={sidebarShowLocation}
                    onClick={() => setSidebarShowLocation(!sidebarShowLocation)}
                  >
                    Location
                  </OptionRow>
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pt-1 pb-2">
        {groups ? (
          groups.map((group) => {
            // A search in progress overrides collapse: hiding the very match
            // the user is looking for would defeat the search.
            const collapsed = needle === "" && !!collapsedGroups[group.key];
            return (
              <div key={group.key} className="flex flex-col pt-3 first:pt-1">
                <div className="group/header flex h-7 w-full items-center gap-2 rounded-md pr-1 pl-2">
                  <button
                    type="button"
                    title={collapsed ? "Expand" : "Collapse"}
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroupCollapsed(group.key)}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
                  >
                    {group.phone && (
                      <Smartphone
                        size={12}
                        strokeWidth={2}
                        aria-label="Phone"
                        className="-mr-1 shrink-0 text-[var(--faint)]"
                      />
                    )}
                    <span className="min-w-0 truncate text-[12px] font-medium text-[var(--muted)]">
                      {collapsed ? `${group.label} (${group.sessions.length})` : group.label}
                    </span>
                    <span className="h-px min-w-3 flex-1 bg-[var(--border)]" />
                    <ChevronDown
                      size={14}
                      strokeWidth={2}
                      className={`shrink-0 text-[var(--faint)] transition-transform ${
                        collapsed ? "-rotate-90" : ""
                      }`}
                    />
                  </button>
                  {group.projectId != null && (
                    <button
                      type="button"
                      title={`New conversation in ${group.label}`}
                      onClick={() => newSessionInProject(group.projectId!)}
                      className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] opacity-0 group-hover/header:opacity-100 hover:bg-[var(--hover)] hover:text-[var(--ink)] focus-visible:opacity-100"
                    >
                      <Plus size={13} strokeWidth={2} />
                    </button>
                  )}
                </div>
                {!collapsed && group.sessions.length === 0 && (
                  <div className="px-2 pt-1 pb-0.5 text-[12px] text-[var(--faint)]">
                    {group.note ?? "No chats yet"}
                  </div>
                )}
                {!collapsed && group.sessions.length > 0 && (
                  <div className="flex flex-col gap-0.5 pt-1">
                    {group.sessions.map((session) => (
                      <SessionRow key={session.id} {...rowProps(session)} />
                    ))}
                  </div>
                )}
              </div>
            );
          })
        ) : (
          <div className="flex flex-col gap-0.5">
            {rows.map((session) => (
              <SessionRow key={session.id} {...rowProps(session)} />
            ))}
          </div>
        )}
        {rows.length === 0 && !groups?.length && (
          <div className="px-2 py-1 text-[13px] text-[var(--faint)]">
            {inProject.length === 0
              ? listedProject == null
                ? "No sessions yet"
                : `No sessions in ${projectNameOf(listedProject)} yet`
              : "Nothing matches"}
          </div>
        )}
      </div>

      {/* Where the agent runs. Everything in this window is a local process on
        this machine, and the footer is the standing reminder of it — as well
        as the way into Settings. */}
      <div className="w-full shrink-0 px-2 py-2">
        <button
          type="button"
          title={`Open settings · ${modShortcut(",")}`}
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

/** The phones paired with this Mac, kept current as they pair and unpair —
 * the sidebar needs them for a phone that has not started a chat yet. */
function usePairedDevices(): MobileDevice[] {
  const [devices, setDevices] = useState<MobileDevice[]>([]);
  useEffect(() => {
    let live = true;
    const load = () =>
      void api
        .mobileStatus()
        .then((status) => live && setDevices(status.devices))
        .catch(() => {});
    load();
    let unlisten: (() => void) | undefined;
    void listen("mobile-changed", load).then((stop) => {
      if (live) unlisten = stop;
      else stop();
    });
    return () => {
      live = false;
      unlisten?.();
    };
  }, []);
  return devices;
}

/** A clock that ticks once a minute, so "3m" on a card doesn't sit at "3m"
 * for an hour while the window is open. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** How long ago, in the coarsest unit that still says something — the idle
 * state of a card's top-right corner. */
function shortAgo(ms: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - ms) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  if (days < 30) return `${Math.floor(days / 7)}w`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
      {children}
    </div>
  );
}

function OptionRow({
  icon: Icon,
  checked,
  onClick,
  children,
}: {
  icon: React.ComponentType<{ size?: number; strokeWidth?: number; className?: string }>;
  checked: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex h-[30px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
    >
      <Icon size={14} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && <Check size={13} strokeWidth={2} className="shrink-0 text-[var(--ink)]" />}
    </button>
  );
}

/** One conversation, as a card the way zeron draws it: a small
 * `project @ machine` line over the harness logo and the title, the branch on a
 * third line when one is showing. The top-right corner says what the session
 * is doing — a working dot, or how long ago it started — and turns into a
 * Close button under the pointer. */
function SessionRow({
  title,
  tooltip,
  location,
  startedUnixMs,
  now,
  selected,
  busy,
  awaiting,
  unread,
  agent,
  showHarness,
  cli,
  branch,
  inWorktree,
  phone,
  onClick,
  onArchive,
  onRename,
}: {
  title: string;
  tooltip: string;
  /** `project @ machine`, or `null` when Location is switched off. */
  location: string | null;
  startedUnixMs: number;
  now: number;
  selected: boolean;
  busy: boolean;
  /** Blocked on the user — a permission, a question, a plan. Wins over
   * `busy`, which is also set while it waits. */
  awaiting?: boolean;
  /** Something happened since this session was last on screen. */
  unread?: boolean;
  agent: string;
  showHarness: boolean;
  /** This session is the agent's own CLI in a terminal, not a chat. */
  cli?: boolean;
  branch?: string | null;
  /** The branch belongs to a worktree of its own rather than the project's. */
  inWorktree?: boolean;
  /** The paired phone that started this chat; `null` for one from this Mac. */
  phone?: string | null;
  onClick: () => void;
  /** Out of the window, kept on disk (Settings → Archived), with an Undo. */
  onArchive: () => void;
  /** Double-clicking the title edits it in place. */
  onRename: (title: string) => void;
}) {
  // The corner: what's happening now, swapped for Archive while the pointer
  // is on the card. Same slot either way, so nothing on the card shifts. A
  // session waiting on the user says so in its own colour and holds still —
  // "Working" is only for an agent that really is.
  const corner = (
    <span className="flex h-[14px] shrink-0 items-center">
      <span className="flex items-center gap-1 text-[10px] font-medium text-[var(--faint)] group-hover:hidden">
        {awaiting ? (
          <>
            <span className="h-1.5 w-1.5 rounded-full bg-[var(--attention)]" />
            <span className="text-[var(--attention)]">Needs you</span>
          </>
        ) : busy ? (
          <>
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--busy)]" />
            <span className="text-[var(--busy)]">Working</span>
          </>
        ) : (
          <>
            {unread && (
              <span
                title="New since you last looked"
                className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]"
              />
            )}
            <span title={`Started ${new Date(startedUnixMs).toLocaleString()}`}>
              {shortAgo(startedUnixMs, now)}
            </span>
          </>
        )}
      </span>
      {/* Taller than the line it sits on, so it overflows the row's padding
        instead of making the card grow the moment the pointer arrives. */}
      <button
        type="button"
        title="Archive conversation — restore it from Settings → Archived"
        onClick={(e) => {
          // Stops the click reaching the card, which would select the
          // conversation on its way to archiving it.
          e.stopPropagation();
          onArchive();
        }}
        className="hidden h-[18px] cursor-pointer items-center gap-1 rounded-[5px] bg-[var(--bubble)] px-1.5 text-[10px] text-[var(--muted)] group-hover:flex hover:text-[var(--ink)]"
      >
        <Archive size={11} strokeWidth={2} />
        Archive
      </button>
    </span>
  );

  return (
    <div
      role="button"
      tabIndex={0}
      title={tooltip}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      className={`group flex w-full cursor-pointer flex-col gap-0.5 rounded-lg px-2 py-1.5 text-left ${
        selected ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
      }`}
    >
      {location != null && (
        <div className="flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[11px] leading-[14px] text-[var(--muted)]/70">
            {location}
          </span>
          {corner}
        </div>
      )}
      <div className="flex w-full items-center gap-2">
        {showHarness && (
          <span className="shrink-0 opacity-80">
            <ProviderGlyph
              provider={AGENT_PROVIDER[agent] ?? agent}
              size={13}
              color={AGENT_ACCENT[agent]}
            />
          </span>
        )}
        <EditableTitle
          title={title}
          onRename={onRename}
          className={`min-w-0 flex-1 truncate text-[13px] leading-[17px] ${
            selected
              ? "text-[var(--ink)]"
              : "text-[var(--ink)]/80 group-hover:text-[var(--ink)]"
          }`}
          inputClassName="min-w-0 flex-1 rounded-md border border-[var(--accent)]/60 bg-[rgba(0,0,0,0.2)] px-1 text-[13px] leading-[17px] text-[var(--ink)] outline-none"
        />
        {phone != null && (
          <span title={`Started on ${phone}`} className="shrink-0">
            <Smartphone size={11} strokeWidth={2} className="text-[var(--faint)]" />
          </span>
        )}
        {cli && (
          <TerminalSquare size={11} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        )}
        {location == null && corner}
      </div>
      {branch && (
        <div
          title={`Branch ${branch}`}
          className="flex w-full items-center gap-1.5 text-[11px] leading-[14px] text-[var(--muted)]/70"
        >
          {inWorktree ? (
            <FolderGit2 size={11} strokeWidth={2} className="shrink-0" />
          ) : (
            <GitBranch size={11} strokeWidth={2} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">{branch}</span>
        </div>
      )}
    </div>
  );
}
