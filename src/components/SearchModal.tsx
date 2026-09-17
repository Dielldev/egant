import { CornerDownLeft, Folder, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project, SessionInfo } from "../lib/types";
import { AGENT_ACCENT, AGENT_PROVIDER } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";
import { useEgant } from "../store";

type SearchTab = "all" | "chats" | "cli" | "projects";

const TABS: { id: SearchTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "chats", label: "Chats" },
  { id: "cli", label: "CLI" },
  { id: "projects", label: "Projects" },
];

type Row =
  | { kind: "session"; session: SessionInfo }
  | { kind: "project"; project: Project };

const DAY_MS = 86_400_000;

/** A coarse, glanceable age — the same buckets a search result list uses
 * everywhere: today's items get no label at all in most UIs, but naming
 * "Past week" vs "Past month" is what makes scanning a long list fast. */
function relativeLabel(unixMs: number): string {
  const age = Date.now() - unixMs;
  if (age < DAY_MS) return "Today";
  if (age < 2 * DAY_MS) return "Yesterday";
  if (age < 7 * DAY_MS) return "Past week";
  if (age < 30 * DAY_MS) return "Past month";
  if (age < 365 * DAY_MS) return "Past year";
  return "Older";
}

/** The window-wide search — every session and project on this machine, not
 * just what the sidebar happens to have rendered. Opened from the search
 * button next to the sidebar's filter icon, styled after Claude's own
 * command-style search: a query field, a row of type tabs, and a result
 * list keyboard-driven the same way (↑↓ to move, ←→ to change tab, ↵ to
 * open, Esc to back out). */
export function SearchModal() {
  const open = useEgant((s) => s.searchOpen);
  const close = useEgant((s) => s.closeSearch);
  const snapshot = useEgant((s) => s.snapshot);
  const selectSession = useEgant((s) => s.selectSession);
  const selectProject = useEgant((s) => s.selectProject);

  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<SearchTab>("all");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Every open starts clean — a stale query or tab from last time would be
  // more confusing than an empty field, since the modal itself gives no
  // other sign of what was searched before.
  useEffect(() => {
    if (!open) return;
    setQuery("");
    setTab("all");
    setIndex(0);
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, [open]);

  const sessions = snapshot?.sessions ?? [];
  const projects = snapshot?.projects ?? [];
  const projectNameOf = (id: number) => projects.find((p) => p.id === id)?.name ?? "No project";

  const rows = useMemo<Row[]>(() => {
    const needle = query.trim().toLowerCase();
    const wantSessions = tab !== "projects";
    const wantProjects = tab === "all" || tab === "projects";

    const sessionRows: Row[] = wantSessions
      ? sessions
          .filter((s) => tab === "all" || (tab === "chats" ? s.kind === "chat" : tab === "cli" ? s.kind === "cli" : true))
          .filter(
            (s) =>
              needle === "" ||
              `${s.title} ${projectNameOf(s.projectId)}`.toLowerCase().includes(needle),
          )
          .sort((a, b) => b.startedUnixMs - a.startedUnixMs)
          .map((session) => ({ kind: "session" as const, session }))
      : [];

    const projectRows: Row[] = wantProjects
      ? projects
          .filter((p) => needle === "" || p.name.toLowerCase().includes(needle))
          .map((project) => ({ kind: "project" as const, project }))
      : [];

    return tab === "projects" ? projectRows : [...sessionRows, ...projectRows];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions, projects, tab, query]);

  // Whatever narrowed the list moves the selection back to the top — an
  // index left pointing at row 6 of a list that's now 2 rows long would
  // either select nothing or the wrong thing.
  useEffect(() => setIndex(0), [rows]);

  const activate = (row: Row) => {
    if (row.kind === "session") void selectSession(row.session.id);
    else void selectProject(row.project.id);
    close();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "Escape":
          e.preventDefault();
          close();
          break;
        case "ArrowDown":
          e.preventDefault();
          setIndex((i) => Math.min(i + 1, rows.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setIndex((i) => Math.max(i - 1, 0));
          break;
        case "ArrowLeft":
        case "ArrowRight": {
          e.preventDefault();
          const dir = e.key === "ArrowLeft" ? -1 : 1;
          const at = TABS.findIndex((t) => t.id === tab);
          setTab(TABS[(at + dir + TABS.length) % TABS.length].id);
          break;
        }
        case "Enter": {
          const row = rows[index];
          if (row) {
            e.preventDefault();
            activate(row);
          }
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rows, index, tab, close]);

  if (!open) return null;

  const selectedIndex = Math.min(index, Math.max(rows.length - 1, 0));

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-6 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={close}
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="flex max-h-[min(560px,70vh)] w-full max-w-[600px] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--stage)] shadow-2xl"
      >
        <div className="flex shrink-0 items-center gap-2.5 border-b border-[var(--border)] px-4 py-3">
          <Search size={15} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions and projects…"
            className="min-w-0 flex-1 bg-transparent text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
          />
          <button
            type="button"
            onClick={close}
            title="Close · Esc"
            className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <X size={14} strokeWidth={2} />
          </button>
        </div>

        <div className="flex shrink-0 items-center gap-4 border-b border-[var(--border)] px-4 py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`cursor-pointer text-[12.5px] ${
                tab === t.id
                  ? "font-medium text-[var(--ink)]"
                  : "text-[var(--faint)] hover:text-[var(--muted)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {rows.length === 0 ? (
            <div className="px-3 py-8 text-center text-[12.5px] text-[var(--faint)]">
              {query.trim() === "" ? "Nothing here yet" : "Nothing matches"}
            </div>
          ) : (
            rows.map((row, i) => {
              const selected = i === selectedIndex;
              const key = row.kind === "session" ? `s${row.session.id}` : `p${row.project.id}`;
              return (
                <div
                  key={key}
                  role="button"
                  tabIndex={-1}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => activate(row)}
                  className={`flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left ${
                    selected ? "bg-[var(--hover)]" : ""
                  }`}
                >
                  {row.kind === "session" ? (
                    <ProviderGlyph
                      provider={AGENT_PROVIDER[row.session.agent] ?? row.session.agent}
                      size={14}
                      color={AGENT_ACCENT[row.session.agent]}
                    />
                  ) : (
                    <Folder size={14} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">
                    {row.kind === "session" ? row.session.title : row.project.name}
                  </span>
                  {row.kind === "session" && (
                    <span className="shrink-0 text-[11px] text-[var(--faint)]">
                      {relativeLabel(row.session.startedUnixMs)}
                    </span>
                  )}
                  {selected && (
                    <CornerDownLeft
                      size={12}
                      strokeWidth={2}
                      className="shrink-0 text-[var(--faint)]"
                    />
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="flex shrink-0 items-center gap-4 border-t border-[var(--border)] px-4 py-2 text-[10.5px] text-[var(--faint)]">
          <Hint label="Select" keys={["↑", "↓"]} />
          <Hint label="Change type" keys={["←", "→"]} />
          <Hint label="Open" keys={["↵"]} />
          <Hint label="Close" keys={["esc"]} />
        </div>
      </div>
    </div>
  );
}

function Hint({ label, keys }: { label: string; keys: string[] }) {
  return (
    <div className="flex items-center gap-1.5">
      <span>{label}</span>
      <span className="flex items-center gap-0.5">
        {keys.map((k) => (
          <kbd
            key={k}
            className="rounded-[4px] border border-[var(--border)] px-1 py-[1px] font-sans text-[10px] text-[var(--muted)]"
          >
            {k}
          </kbd>
        ))}
      </span>
    </div>
  );
}
