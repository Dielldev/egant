import {
  Check,
  Monitor,
  Search,
  Settings,
  SlidersHorizontal,
  SquarePen,
  TerminalSquare,
  X,
} from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNow } from "@egant/components/useNow";
import { SHORT_NAMES, fallbackName } from "@egant/lib/agents";
import type { MobileSession } from "../api";
import { useMobile } from "../store";
import { AgentGlyph, Mark, shortAgo } from "./bits";
import { InstallHint } from "./InstallHint";
import { ProjectIcon } from "./Pickers";

type Status = "all" | "working" | "needs";

/** Every chat on the Mac, full screen over the page: close, search and a new
 * chat up top, filters for project, state and agent under them, the ones
 * blocked on an answer first, then the rest by when they were last active —
 * and this Mac, with Settings, at the foot. */
export function Drawer({ onClose }: { onClose: () => void }) {
  const sessions = useMobile((s) => s.sessions);
  const openSession = useMobile((s) => s.openSession);
  const navigate = useMobile((s) => s.navigate);
  const openSettings = useMobile((s) => s.openSettings);
  const machine = useMobile((s) => s.machineName);
  const connection = useMobile((s) => s.connection);
  const device = useMobile((s) => s.device);
  const now = useNow(30_000);
  const [query, setQuery] = useState("");
  const [projectId, setProjectId] = useState<number | null>(null);
  const [status, setStatus] = useState<Status>("all");
  const [agent, setAgent] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

  // What there is to filter by: the projects and agents that have chats.
  const projects = new Map<number, { name: string; hue: number; count: number }>();
  const agents = new Map<string, number>();
  for (const s of sessions) {
    const known = projects.get(s.projectId);
    projects.set(s.projectId, {
      name: s.projectName,
      hue: s.projectHue,
      count: (known?.count ?? 0) + 1,
    });
    agents.set(s.agent, (agents.get(s.agent) ?? 0) + 1);
  }
  const workingCount = sessions.filter((s) => s.busy && s.pendingCount === 0).length;
  const needsCount = sessions.filter((s) => s.pendingCount > 0).length;
  // A filter whose chats are all gone is no filter at all.
  const project = projectId != null && projects.has(projectId) ? projectId : null;
  const agentFilter = agent != null && agents.has(agent) ? agent : null;
  const filtering = project != null || status !== "all" || agentFilter != null;

  const q = query.trim().toLowerCase();
  const matching = [...sessions]
    .filter(
      (s) =>
        (!q || s.title.toLowerCase().includes(q) || s.projectName.toLowerCase().includes(q)) &&
        (project == null || s.projectId === project) &&
        (agentFilter == null || s.agent === agentFilter) &&
        (status === "all" ||
          (status === "needs" ? s.pendingCount > 0 : s.busy && s.pendingCount === 0)),
    )
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  const needsYou = matching.filter((s) => s.pendingCount > 0);
  const groups = groupByDay(
    matching.filter((s) => s.pendingCount === 0),
    now,
  );

  const open = (id: number | null) => {
    navigate(id);
    onClose();
  };

  return (
    <div className="flex h-full flex-col bg-[var(--stage)]">
      <div className="safe-top shrink-0">
        <div className="flex items-center gap-1.5 px-2 pt-2 pb-2">
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--ink)] active:bg-[var(--hover)]"
          >
            <X size={22} strokeWidth={2} />
          </button>
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--raised)] px-3.5">
            <Search size={16} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent text-[16px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")}>
                <X size={15} strokeWidth={2.2} className="text-[var(--faint)]" />
              </button>
            )}
          </label>
          <div className="relative shrink-0">
            <button
              type="button"
              aria-label="Filter chats"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((was) => !was)}
              className={`press relative flex h-10 w-10 items-center justify-center rounded-full text-[var(--ink)] active:bg-[var(--hover)] ${
                menuOpen ? "bg-[var(--raised-2)]" : ""
              }`}
            >
              <SlidersHorizontal size={19} strokeWidth={1.9} />
              {filtering && (
                <span className="absolute top-2 right-2 h-2.5 w-2.5 rounded-full border-2 border-[var(--stage)] bg-[var(--ink)]" />
              )}
            </button>
            {menuOpen && (
              <>
                <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
                <div
                  role="menu"
                  className="pop-in-top no-scrollbar absolute top-full right-0 z-40 mt-2 max-h-[min(70vh,560px)] w-[min(300px,calc(100vw-24px))] overflow-y-auto rounded-[22px] border border-[var(--hairline)] bg-[var(--raised)] py-1.5 shadow-[0_16px_48px_rgba(0,0,0,0.35)]"
                >
                  <MenuSection label="Project">
                    <MenuItem selected={project == null} onClick={() => setProjectId(null)}>
                      All projects
                    </MenuItem>
                    {[...projects.entries()].map(([id, info]) => (
                      <MenuItem
                        key={id}
                        selected={project === id}
                        detail={info.count}
                        icon={<ProjectIcon size={16} />}
                        onClick={() => setProjectId(project === id ? null : id)}
                      >
                        {info.name}
                      </MenuItem>
                    ))}
                  </MenuSection>
                  <MenuSection label="State">
                    <MenuItem selected={status === "all"} onClick={() => setStatus("all")}>
                      Any
                    </MenuItem>
                    <MenuItem
                      selected={status === "working"}
                      detail={workingCount}
                      onClick={() => setStatus(status === "working" ? "all" : "working")}
                    >
                      Working
                    </MenuItem>
                    <MenuItem
                      selected={status === "needs"}
                      detail={needsCount}
                      onClick={() => setStatus(status === "needs" ? "all" : "needs")}
                    >
                      Needs you
                    </MenuItem>
                  </MenuSection>
                  {agents.size > 1 && (
                    <MenuSection label="Agent">
                      <MenuItem selected={agentFilter == null} onClick={() => setAgent(null)}>
                        All agents
                      </MenuItem>
                      {[...agents.entries()].map(([id, count]) => (
                        <MenuItem
                          key={id}
                          selected={agentFilter === id}
                          detail={count}
                          icon={<AgentGlyph agent={id} size={13} />}
                          onClick={() => setAgent(agentFilter === id ? null : id)}
                        >
                          {SHORT_NAMES[id] ?? fallbackName(id)}
                        </MenuItem>
                      ))}
                    </MenuSection>
                  )}
                  {filtering && (
                    <button
                      type="button"
                      onClick={() => {
                        setProjectId(null);
                        setStatus("all");
                        setAgent(null);
                        setMenuOpen(false);
                      }}
                      className="mt-1 w-full border-t border-[var(--hairline)] px-4 py-3 text-left text-[15px] font-medium text-[var(--danger)] active:bg-[var(--hover)]"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            aria-label="New chat"
            onClick={() => open(null)}
            className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--ink)] active:bg-[var(--hover)]"
          >
            <SquarePen size={20} strokeWidth={1.9} />
          </button>
        </div>

        {filtering && (
          <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 pb-2">
            {project != null && (
              <Applied
                icon={<ProjectIcon size={13} />}
                label={projects.get(project)?.name ?? ""}
                onClear={() => setProjectId(null)}
              />
            )}
            {status !== "all" && (
              <Applied
                label={status === "working" ? "Working" : "Needs you"}
                onClear={() => setStatus("all")}
              />
            )}
            {agentFilter != null && (
              <Applied
                label={SHORT_NAMES[agentFilter] ?? fallbackName(agentFilter)}
                onClear={() => setAgent(null)}
              />
            )}
          </div>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {!q && !filtering && (
          <button
            type="button"
            onClick={() => open(null)}
            className={`press mb-2 flex w-full items-center gap-3 rounded-[14px] px-3 py-2.5 text-left ${
              openSession == null ? "bg-[var(--raised-2)]" : "active:bg-[var(--hover)]"
            }`}
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--stage)] text-[var(--ink)]">
              <Mark height={11} />
            </span>
            <span className="text-[16px] font-medium text-[var(--ink)]">New chat</span>
          </button>
        )}

        {needsYou.length > 0 && (
          <Section label="Needs you" accent>
            {needsYou.map((session) => (
              <Row
                key={session.id}
                session={session}
                now={now}
                active={session.id === openSession}
                onOpen={() => open(session.id)}
              />
            ))}
          </Section>
        )}
        {groups.map(([label, rows]) => (
          <Section key={label} label={label}>
            {rows.map((session) => (
              <Row
                key={session.id}
                session={session}
                now={now}
                active={session.id === openSession}
                onOpen={() => open(session.id)}
              />
            ))}
          </Section>
        ))}
        {matching.length === 0 && (
          <div className="px-6 py-12 text-center text-[14px] leading-relaxed text-[var(--muted)]">
            {q || filtering
              ? "No chats match."
              : `No chats on ${machine || "your Mac"} yet. Start one and it shows up here.`}
            {filtering && (
              <button
                type="button"
                onClick={() => {
                  setProjectId(null);
                  setStatus("all");
                  setAgent(null);
                }}
                className="press mx-auto mt-3 block rounded-full bg-[var(--raised-2)] px-4 py-1.5 text-[14px] font-medium text-[var(--ink)]"
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        <div className="px-1 pt-2">
          <InstallHint />
        </div>
      </div>

      <div className="safe-bottom shrink-0 border-t border-[var(--hairline)] px-2 pt-2">
        <button
          type="button"
          onClick={() => {
            openSettings();
            onClose();
          }}
          className="press flex w-full items-center gap-3 rounded-[14px] px-2.5 py-2 text-left active:bg-[var(--hover)]"
        >
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--raised-2)] text-[var(--ink)]">
            <Monitor size={17} strokeWidth={2} />
            <span
              className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-[var(--stage)] ${
                connection === "live"
                  ? "bg-emerald-400"
                  : connection === "connecting"
                    ? "animate-pulse bg-amber-400"
                    : "bg-[var(--danger)]"
              }`}
            />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-medium text-[var(--ink)]">
              {machine || "Your Mac"}
            </span>
            <span className="block truncate text-[12.5px] text-[var(--muted)]">
              {connection === "live"
                ? `Connected · ${device?.name ?? "this phone"}`
                : connection === "connecting"
                  ? "Reconnecting…"
                  : "Offline"}
            </span>
          </span>
          <Settings size={19} strokeWidth={1.9} className="shrink-0 text-[var(--muted)]" />
        </button>
      </div>
    </div>
  );
}

function MenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-[var(--hairline)] pb-1 last:border-b-0">
      <div className="px-4 pt-2.5 pb-1 text-[12px] font-semibold tracking-[0.06em] text-[var(--faint)] uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function MenuItem({
  selected,
  detail,
  icon,
  onClick,
  children,
}: {
  selected: boolean;
  detail?: number;
  icon?: ReactNode;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      onClick={onClick}
      className="flex min-h-[46px] w-full items-center gap-3 px-4 py-2 text-left active:bg-[var(--hover)]"
    >
      {icon && <span className="flex w-4 shrink-0 items-center justify-center text-[var(--muted)]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate text-[16px] text-[var(--ink)]">{children}</span>
      {detail != null && <span className="text-[14px] tabular-nums text-[var(--faint)]">{detail}</span>}
      <span className="flex w-5 shrink-0 justify-end text-[var(--ink)]">
        {selected && <Check size={18} strokeWidth={2.4} />}
      </span>
    </button>
  );
}

/** A filter that is on, shown under the search box; a tap takes it off. */
function Applied({ label, icon, onClear }: { label: string; icon?: ReactNode; onClear: () => void }) {
  return (
    <button
      type="button"
      onClick={onClear}
      aria-label={`Remove filter ${label}`}
      className="press fade-up flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-[var(--raised-2)] pr-2 pl-2.5 text-[13px] font-medium text-[var(--ink)]"
    >
      {icon}
      <span className="max-w-[160px] truncate">{label}</span>
      <X size={13} strokeWidth={2.4} className="text-[var(--muted)]" />
    </button>
  );
}

function Section({ label, accent, children }: { label: string; accent?: boolean; children: ReactNode }) {
  return (
    <section className="mb-3">
      <div
        className={`px-3 pt-2 pb-1 text-[13px] font-semibold ${
          accent ? "text-amber-600 dark:text-amber-300" : "text-[var(--faint)]"
        }`}
      >
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/** One chat: its title, and under it where it runs and what it is doing. */
function Row({
  session,
  now,
  active,
  onOpen,
}: {
  session: MobileSession;
  now: number;
  active: boolean;
  onOpen: () => void;
}) {
  const waiting = session.pendingCount > 0;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`flex w-full flex-col gap-0.5 rounded-[14px] px-3 py-2 text-left ${
        active ? "bg-[var(--raised-2)]" : "active:bg-[var(--hover)]"
      }`}
    >
      <span className="flex w-full items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[15.5px] leading-6 text-[var(--ink)]">
          {session.title}
        </span>
        {session.kind === "cli" && (
          <TerminalSquare size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        )}
        {waiting ? (
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
        ) : session.busy ? (
          <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-[var(--busy)]" />
        ) : null}
      </span>
      <span className="flex w-full min-w-0 items-center gap-1.5 text-[12.5px] leading-4 text-[var(--muted)]">
        <ProjectIcon size={12} />
        <span className="min-w-0 truncate">{session.projectName}</span>
        <span className="text-[var(--faint)]">·</span>
        <span className="shrink-0 opacity-80">
          <AgentGlyph agent={session.agent} size={11} />
        </span>
        <span className="ml-auto shrink-0 pl-2 text-[var(--faint)]">
          {waiting
            ? session.pendingCount === 1
              ? "Needs approval"
              : `${session.pendingCount} approvals`
            : session.busy
              ? "Working"
              : shortAgo(session.lastActivityMs, now)}
        </span>
      </span>
    </button>
  );
}

/** Today, Yesterday, the week, the month, and everything before. */
function groupByDay(sessions: MobileSession[], now: number): [string, MobileSession[]][] {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const day = 86_400_000;
  const buckets: [string, (ms: number) => boolean][] = [
    ["Today", (ms) => ms >= today],
    ["Yesterday", (ms) => ms >= today - day],
    ["Previous 7 days", (ms) => ms >= today - 7 * day],
    ["Previous 30 days", (ms) => ms >= today - 30 * day],
    ["Older", () => true],
  ];
  const out = new Map<string, MobileSession[]>();
  for (const session of sessions) {
    const label = buckets.find(([, test]) => test(session.lastActivityMs))?.[0] ?? "Older";
    out.set(label, [...(out.get(label) ?? []), session]);
  }
  return buckets.flatMap(([label]) => (out.has(label) ? [[label, out.get(label)!] as [string, MobileSession[]]] : []));
}
