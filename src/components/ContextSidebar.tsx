import {
  ChevronDown,
  ChevronUp,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  GripVertical,
  Laptop,
  Settings,
  Smartphone,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import {
  CONTEXT_WIDTH,
  type ContextSectionId,
  contextBreakdown,
  mcpToolCounts,
  moveContextSection,
  prettyServerName,
  shortenHome,
  toolServerKey,
} from "../lib/contextSidebar";
import { formatCost, formatTokens } from "../lib/transcript";
import type { GitChange, InstalledMcp, RepoStatus } from "../lib/types";
import { modelWindowFor } from "../lib/types";
import { selectActiveSession, useEgant, workspaceRoot } from "../store";
import { usePhoneAccess } from "./PhoneAccess";
import { Toggle } from "./SettingsKit";

const DRAG_TYPE = "application/x-egant-context-section";

/** The column on the right that says what the conversation in front of you is
 * made of and where it runs: how full the window is, the environment, the MCP
 * servers, and what has changed on disk. Works for every agent — the window
 * reading is the one number each harness reports, and the rest comes from
 * egant's own state. Sections drag into any order; the order is remembered. */
export function ContextSidebar() {
  const order = useEgant((s) => s.contextOrder);
  const setOrder = useEgant((s) => s.setContextOrder);
  const toggleContext = useEgant((s) => s.toggleContext);

  // `armed` is the section whose grip is held — only then does its card become
  // draggable, so selecting text inside a section never starts a drag.
  const [armed, setArmed] = useState<ContextSectionId | null>(null);
  const [dragging, setDragging] = useState<ContextSectionId | null>(null);
  const [over, setOver] = useState<{ id: ContextSectionId; after: boolean } | null>(null);

  const commit = (id: ContextSectionId, target: ContextSectionId, after: boolean) => {
    setOrder(moveContextSection(order, id, target, after));
  };

  const end = () => {
    setArmed(null);
    setDragging(null);
    setOver(null);
  };

  return (
    <aside
      style={{ width: CONTEXT_WIDTH }}
      className="sidebar-glass relative z-20 flex h-full shrink-0 flex-col border-l border-[var(--border)] text-[var(--muted)]"
    >
      <div
        data-tauri-drag-region
        className="flex h-[38px] w-full shrink-0 items-center justify-between pr-1.5 pl-3.5"
      >
        <span data-tauri-drag-region className="text-[13px] font-medium text-[var(--ink)]">
          Session
        </span>
        <button
          type="button"
          title="Close"
          onClick={() => toggleContext()}
          className="cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <X size={14} strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-4">
        {order.map((id, index) => (
          <div
            key={id}
            draggable={armed === id}
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, id);
              e.dataTransfer.effectAllowed = "move";
              setDragging(id);
            }}
            onDragOver={(e) => {
              if (!dragging || dragging === id) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientY > rect.top + rect.height / 2;
              setOver((prev) =>
                prev?.id === id && prev.after === after ? prev : { id, after },
              );
            }}
            onDrop={(e) => {
              e.preventDefault();
              const from = (e.dataTransfer.getData(DRAG_TYPE) || dragging) as ContextSectionId;
              if (from && over) commit(from, over.id, over.after);
              end();
            }}
            onDragEnd={end}
            className={`relative ${index > 0 ? "mt-3 border-t border-[var(--border)] pt-3" : ""} ${
              dragging === id ? "opacity-40" : ""
            }`}
          >
            {over?.id === id && dragging !== id && (
              <div
                className={`pointer-events-none absolute right-0 left-0 h-0.5 rounded-full bg-[var(--accent)] ${
                  over.after ? "-bottom-[7px]" : "-top-[7px]"
                }`}
              />
            )}
            <SectionHeader
              id={id}
              title={SECTION_TITLES[id]}
              onArm={() => setArmed(id)}
              onDisarm={() => {
                if (!dragging) setArmed(null);
              }}
              onMove={(by) => {
                const at = order.indexOf(id);
                const target = order[at + by];
                if (target) commit(id, target, by > 0);
              }}
            />
            {id === "context" && <ContextSection />}
            {id === "environment" && <EnvironmentSection />}
            {id === "connectors" && <ConnectorsSection />}
            {id === "changes" && <ChangesSection />}
          </div>
        ))}
      </div>
    </aside>
  );
}

const SECTION_TITLES: Record<ContextSectionId, string> = {
  context: "Context",
  environment: "Environment",
  connectors: "Connectors",
  changes: "Changes",
};

function SectionHeader({
  id,
  title,
  onArm,
  onDisarm,
  onMove,
}: {
  id: ContextSectionId;
  title: string;
  onArm: () => void;
  onDisarm: () => void;
  onMove: (by: -1 | 1) => void;
}) {
  return (
    <div className="group mb-2 flex items-center justify-between">
      <span className="text-[13px] font-medium text-[var(--ink)]">{title}</span>
      {/* The grip is the only handle. Arrow keys on it reorder too, for anyone
        not dragging. */}
      <button
        type="button"
        aria-label={`Reorder ${title}`}
        title="Drag to reorder"
        data-section={id}
        onMouseDown={onArm}
        onMouseUp={onDisarm}
        onMouseLeave={onDisarm}
        onKeyDown={(e) => {
          if (e.key === "ArrowUp") {
            e.preventDefault();
            onMove(-1);
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            onMove(1);
          }
        }}
        className="cursor-grab rounded p-0.5 text-[var(--faint)] opacity-0 group-hover:opacity-100 hover:text-[var(--ink)] focus-visible:opacity-100 active:cursor-grabbing"
      >
        <GripVertical size={13} strokeWidth={2} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

function ContextSection() {
  const snapshot = useEgant((s) => s.snapshot);
  const session = selectActiveSession(snapshot);
  const transcript = useEgant((s) =>
    session ? s.transcripts[session.id] : undefined,
  );
  const catalog = useEgant((s) => (session ? s.modelCache[session.agent] : undefined));

  const model = transcript?.model ?? session?.modelOverride ?? null;
  const modelWindow = modelWindowFor(catalog, model);
  const usage = transcript?.usage;
  const window_ = usage && usage.contextWindow > 0 ? usage.contextWindow : modelWindow;

  const breakdown = useMemo(
    () =>
      usage && window_ > 0
        ? contextBreakdown(transcript?.entries ?? [], usage, window_)
        : null,
    // Entries are replaced on every fold, so identity is the right key.
    [transcript?.entries, usage, window_],
  );

  if (session?.kind === "cli") {
    return (
      <p className="text-[12.5px] leading-relaxed text-[var(--faint)]">
        This session runs the agent&apos;s own terminal, which doesn&apos;t report its
        context window to egant.
      </p>
    );
  }
  if (!usage || !breakdown) {
    return (
      <p className="text-[12.5px] leading-relaxed text-[var(--faint)]">
        {window_ > 0
          ? `Nothing in the window yet — ${formatTokens(window_)} available.`
          : "The window fills in after the first reply."}
      </p>
    );
  }

  const percent = breakdown.used > 0 ? Math.max(1, Math.round(breakdown.fraction * 100)) : 0;
  const pct = (tokens: number) => {
    const p = (tokens / breakdown.window) * 100;
    return p > 0 && p < 0.1 ? "<0.1%" : `${p.toFixed(1)}%`;
  };

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <span className="text-[15px] font-medium text-[var(--ink)]">{percent}% used</span>
        <span className="text-[12px] tabular-nums text-[var(--faint)]">
          {formatTokens(breakdown.used)} / {formatTokens(breakdown.window)}
        </span>
      </div>
      <div className="mt-2 flex h-1.5 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
        {breakdown.slices
          .filter((s) => s.id !== "free" && s.tokens > 0)
          .map((s) => (
            <div
              key={s.id}
              title={s.label}
              style={{
                width: `${(s.tokens / breakdown.window) * 100}%`,
                background: s.color,
                minWidth: 2,
              }}
            />
          ))}
      </div>
      <ul className="mt-3 flex flex-col gap-1.5">
        {breakdown.slices.map((s) => (
          <li key={s.id} className="flex items-center gap-2 text-[12.5px]">
            <span
              className="size-2.5 shrink-0 rounded-[3px]"
              style={{ background: s.color }}
            />
            <span className="min-w-0 flex-1 truncate">{s.label}</span>
            <span className="tabular-nums text-[var(--faint)]">
              {s.estimated && s.tokens > 0 ? "~" : ""}
              {formatTokens(s.tokens)}
            </span>
            <span className="w-[46px] text-right tabular-nums text-[var(--muted)]">
              {pct(s.tokens)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-[11.5px] leading-relaxed text-[var(--faint)]">
        The total is reported by the agent. How it splits is estimated from the
        conversation&apos;s text.
      </p>
      {usage.turns > 0 && (
        <p className="mt-1.5 text-[11.5px] text-[var(--faint)]">
          {usage.turns} {usage.turns === 1 ? "turn" : "turns"} ·{" "}
          {formatTokens(usage.totalTokens)} tokens
          {transcript && transcript.totalCostUsd > 0
            ? ` · ${formatCost(transcript.totalCostUsd)}`
            : ""}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

function EnvironmentSection() {
  const snapshot = useEgant((s) => s.snapshot);
  const openSettings = useEgant((s) => s.openSettings);
  const changesToken = useEgant((s) => s.changesToken);
  const session = selectActiveSession(snapshot);
  const root = workspaceRoot(snapshot);
  const project =
    snapshot?.projects.find((p) => p.id === session?.projectId) ??
    snapshot?.projects.find((p) => p.id === snapshot?.activeProject) ??
    null;
  const busy = session?.busy ?? false;
  const phone = usePhoneAccess();

  // The session's recorded branch can be stale — the agent may have switched —
  // so the repository is asked when something could have changed it.
  const [repo, setRepo] = useState<RepoStatus | null>(null);
  useEffect(() => {
    if (!root) {
      setRepo(null);
      return;
    }
    let cancelled = false;
    api
      .repoStatus(root)
      .then((r) => !cancelled && setRepo(r))
      .catch(() => !cancelled && setRepo(null));
    return () => {
      cancelled = true;
    };
  }, [root, changesToken, busy]);

  const branch = repo?.branch ?? session?.branch ?? null;
  const device = session?.device ?? snapshot?.machineName ?? "";
  const phoneOn = phone.status?.enabled ?? false;

  return (
    <div className="flex flex-col gap-1">
      <Row icon={<Laptop size={15} strokeWidth={1.8} />} title={device}>
        <button
          type="button"
          title="Settings"
          onClick={() => openSettings()}
          className="cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <Settings size={14} strokeWidth={1.9} />
        </button>
      </Row>
      <Row
        icon={<FolderOpen size={15} strokeWidth={1.8} />}
        title={`${project?.name ?? "—"}${root ? ` · ${shortenHome(root)}` : ""}`}
      />
      {branch && (
        <Row icon={<GitBranch size={15} strokeWidth={1.8} />} title={branch}>
          {repo && (repo.ahead || repo.behind) ? (
            <span className="text-[11.5px] tabular-nums text-[var(--faint)]">
              {repo.ahead ? `↑${repo.ahead}` : ""}
              {repo.ahead && repo.behind ? " " : ""}
              {repo.behind ? `↓${repo.behind}` : ""}
            </span>
          ) : session?.worktree ? (
            <span className="text-[11.5px] text-[var(--faint)]">worktree</span>
          ) : null}
        </Row>
      )}
      <Row icon={<Smartphone size={15} strokeWidth={1.8} />} title="Phone access">
        <Toggle
          on={phoneOn}
          label="Phone access"
          disabled={phone.busy || phone.status === null}
          onChange={(next) => void phone.run(() => api.mobileSetEnabled(next))}
        />
      </Row>
      {phone.problem && (
        <p className="pl-[27px] text-[11.5px] leading-snug text-[var(--danger)]">
          {phone.problem}
        </p>
      )}
    </div>
  );
}

function Row({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[28px] items-center gap-2.5">
      <span className="shrink-0 text-[var(--faint)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]" title={title}>
        {title}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

const COLLAPSED_CONNECTORS = 4;

interface Connector {
  key: string;
  name: string;
  /** Tools the live session has from it; `null` before it has reported any. */
  tools: number | null;
  configured: boolean;
}

function ConnectorsSection() {
  const snapshot = useEgant((s) => s.snapshot);
  const openLibrary = useEgant((s) => s.openLibrary);
  const session = selectActiveSession(snapshot);
  const tools = useEgant((s) => (session ? s.transcripts[session.id]?.tools : undefined));
  const [library, setLibrary] = useState<InstalledMcp[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const agent = session?.agent ?? null;

  useEffect(() => {
    let cancelled = false;
    api
      .libraryMcp()
      .then((lib) => !cancelled && setLibrary(lib.servers))
      .catch(() => !cancelled && setLibrary([]));
    return () => {
      cancelled = true;
    };
  }, [agent]);

  const connectors = useMemo(() => {
    const live = mcpToolCounts(tools ?? []);
    const reported = (tools?.length ?? 0) > 0;
    const out: Connector[] = [];
    const seen = new Set<string>();
    for (const server of library ?? []) {
      if (agent && !server.agents.includes(agent)) continue;
      const key = toolServerKey(server.name);
      seen.add(key);
      out.push({
        key,
        name: server.name,
        tools: reported ? (live.get(key) ?? 0) : null,
        configured: true,
      });
    }
    // Servers the agent has tools from that no config here names: claude.ai
    // connectors and plugin servers, which are real and in use.
    for (const [key, count] of live) {
      if (seen.has(key)) continue;
      out.push({ key, name: prettyServerName(key), tools: count, configured: false });
    }
    return out.sort(
      (a, b) =>
        Number((b.tools ?? 0) > 0) - Number((a.tools ?? 0) > 0) ||
        a.name.localeCompare(b.name),
    );
  }, [library, tools, agent]);

  if (library === null && !tools) {
    return <p className="text-[12.5px] text-[var(--faint)]">Loading…</p>;
  }
  if (connectors.length === 0) {
    return (
      <div className="flex flex-col items-start gap-2">
        <p className="text-[12.5px] leading-relaxed text-[var(--faint)]">
          No MCP servers are set up for this agent.
        </p>
        <button
          type="button"
          onClick={() => openLibrary("mcp")}
          className="cursor-pointer rounded-md border border-[var(--border)] px-2.5 py-1 text-[12.5px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          Open Library
        </button>
      </div>
    );
  }

  const shown = expanded ? connectors : connectors.slice(0, COLLAPSED_CONNECTORS);
  return (
    <div className="flex flex-col gap-1">
      {shown.map((c) => (
        <div key={c.key} className="flex min-h-[28px] items-center gap-2.5">
          <span className="flex size-[18px] shrink-0 items-center justify-center rounded-[5px] border border-[var(--border)] text-[10px] font-medium text-[var(--muted)]">
            {c.name.charAt(0).toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]" title={c.name}>
            {c.name}
          </span>
          <ConnectorStatus tools={c.tools} />
        </div>
      ))}
      {connectors.length > COLLAPSED_CONNECTORS && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-0.5 flex cursor-pointer items-center gap-1 self-start text-[12.5px] text-[var(--faint)] hover:text-[var(--ink)]"
        >
          {expanded ? (
            <>
              Show less <ChevronUp size={12} strokeWidth={2} />
            </>
          ) : (
            <>
              Show {connectors.length - COLLAPSED_CONNECTORS} more{" "}
              <ChevronDown size={12} strokeWidth={2} />
            </>
          )}
        </button>
      )}
    </div>
  );
}

function ConnectorStatus({ tools }: { tools: number | null }) {
  if (tools === null) {
    return <span className="text-[11.5px] text-[var(--faint)]">Configured</span>;
  }
  if (tools === 0) {
    return (
      <span className="text-[11.5px] text-[var(--faint)]" title="Set up, but this session has no tools from it">
        Not loaded
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[11.5px] text-[var(--muted)]">
      <span className="size-1.5 rounded-full bg-[var(--diff-add-fg)]" />
      {tools} {tools === 1 ? "tool" : "tools"}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

function ChangesSection() {
  const snapshot = useEgant((s) => s.snapshot);
  const changesToken = useEgant((s) => s.changesToken);
  const openDiffsTab = useEgant((s) => s.openDiffsTab);
  const session = selectActiveSession(snapshot);
  const root = workspaceRoot(snapshot);
  const busy = session?.busy ?? false;
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [failed, setFailed] = useState(false);
  const last = useRef(0);

  // Refreshed when a turn settles — that is when the agent's edits land — and
  // whenever the Diffs panel reports a change of its own.
  useEffect(() => {
    if (!root) {
      setChanges(null);
      return;
    }
    const mine = ++last.current;
    api
      .changesList(root)
      .then((rows) => {
        if (mine !== last.current) return;
        setChanges(rows);
        setFailed(false);
      })
      .catch(() => {
        if (mine !== last.current) return;
        setChanges(null);
        setFailed(true);
      });
  }, [root, changesToken, busy]);

  if (failed || !root) {
    return <p className="text-[12.5px] text-[var(--faint)]">Not a git repository.</p>;
  }
  if (changes === null) {
    return <p className="text-[12.5px] text-[var(--faint)]">Loading…</p>;
  }

  const added = changes.reduce((n, c) => n + c.additions, 0);
  const removed = changes.reduce((n, c) => n + c.deletions, 0);
  if (changes.length === 0) {
    return <p className="text-[12.5px] text-[var(--faint)]">No uncommitted changes.</p>;
  }

  return (
    <div className="flex items-center gap-2.5">
      <span className="text-[13px] tabular-nums">
        <span className="text-[var(--diff-add-fg)]">+{added}</span>{" "}
        <span className="text-[var(--diff-del-fg)]">−{removed}</span>
      </span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--faint)]">
        {changes.length} {changes.length === 1 ? "file" : "files"}
      </span>
      <button
        type="button"
        title="Review the changes, and open a pull request from the Diffs tab"
        onClick={() => openDiffsTab()}
        className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-[var(--bubble)] px-2.5 py-1 text-[12.5px] text-[var(--ink)] hover:bg-[var(--selected)]"
      >
        <GitPullRequest size={12.5} strokeWidth={2} />
        Review
      </button>
    </div>
  );
}
