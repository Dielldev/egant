import { Monitor, Search, Settings, SquarePen, TerminalSquare, X } from "lucide-react";
import { useState } from "react";
import type { ReactNode } from "react";
import { useNow } from "@egant/components/useNow";
import type { MobileSession } from "../api";
import { useMobile } from "../store";
import { AgentGlyph, Mark, shortAgo } from "./bits";
import { InstallHint } from "./InstallHint";
import { ProjectDot } from "./Pickers";

/** Every chat on the Mac, the way ChatGPT's side panel lists them: search and
 * a new chat up top, the ones blocked on an answer first, then the rest by
 * when they were last active — and this Mac, with Settings, at the foot. */
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

  const q = query.trim().toLowerCase();
  const matching = [...sessions]
    .filter(
      (s) => !q || s.title.toLowerCase().includes(q) || s.projectName.toLowerCase().includes(q),
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
    <div className="flex h-full flex-col bg-[var(--raised)]">
      <div className="safe-top shrink-0">
        <div className="flex items-center gap-2 px-3 pt-2 pb-2">
          <label className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full bg-[var(--raised-2)] px-3.5">
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
          <button
            type="button"
            aria-label="New chat"
            onClick={() => open(null)}
            className="press flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-[var(--ink)] active:bg-[var(--hover)]"
          >
            <SquarePen size={20} strokeWidth={1.9} />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-3">
        {!q && (
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
            {q
              ? "No chats match."
              : `No chats on ${machine || "your Mac"} yet. Start one and it shows up here.`}
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
              className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-[var(--raised)] ${
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
        <ProjectDot hue={session.projectHue} size={7} />
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
