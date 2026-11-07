// Settings > Agents: every coding-agent CLI egant knows about, whether this
// machine has it, and one click to install the ones it doesn't.
//
// The list is deliberately flat — a row is a name and its state, nothing
// else. Everything an agent needs (install, sign-in, default model) lives in
// the sheet a row opens, so the page itself stays scannable at 20+ agents.

import {
  AlertTriangle,
  AlignLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  ExternalLink,
  MoreHorizontal,
  RefreshCw,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { api } from "../lib/api";
import type {
  AgentCatalogEntry,
  AgentInstallOutcome,
  AgentModel,
  AgentStatus,
  AgentUpdate,
} from "../lib/types";
import { CONTEXT_PRESETS, formatContext, parseContext } from "../lib/types";
import { useEgant } from "../store";
import { ProviderLogo } from "./ProviderLogo";
import { Card, DevicePill, Row, SectionHead, Select, Toggle } from "./SettingsKit";

type Filter = "all" | "installed" | "missing";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "installed", label: "Installed" },
  { id: "missing", label: "Not installed" },
];

export function AgentsSection() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "Local device");
  const agents = useEgant((s) => s.agents);
  const verifyAgents = useEgant((s) => s.verifyAgents);

  const catalog = useEgant((s) => s.catalog);
  const fetchCatalog = useEgant((s) => s.fetchCatalog);
  // Set when the composer's picker deep-links into one agent's sheet.
  const agentSheetId = useEgant((s) => s.agentSheetId);
  const setAgentSheetId = useEgant((s) => s.setAgentSheetId);
  const [updates, setUpdates] = useState<Record<string, AgentUpdate>>({});
  const [loading, setLoading] = useState(true);
  const [sheetRefreshing, setSheetRefreshing] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(agentSheetId);

  // Update checks spawn the CLI and hit the npm registry, so they only run
  // for agents that are actually installed, and only once per refresh — the
  // ref keeps a re-render from firing the same lookups again.
  const checked = useRef(new Set<string>());

  const refreshAgent = useCallback(
    async (id: string) => {
      setSheetRefreshing(true);
      try {
        const [freshEntry, updateInfo] = await Promise.all([
          api.getAgentCatalogEntry(id).catch(() => null),
          api.checkAgentUpdate(id).catch(() => null),
          verifyAgents().catch(() => {}),
        ]);
        if (freshEntry) {
          useEgant.setState((prev) => ({
            catalog: prev.catalog.map((row) => (row.id === id ? freshEntry : row)),
          }));
        }
        if (updateInfo) {
          setUpdates((prev) => ({ ...prev, [id]: updateInfo }));
        }
      } finally {
        setSheetRefreshing(false);
      }
    },
    [verifyAgents],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      await fetchCatalog();
      const rows = useEgant.getState().catalog;
      for (const row of rows) {
        if (!row.installed || checked.current.has(row.id)) continue;
        checked.current.add(row.id);
        void api
          .checkAgentUpdate(row.id)
          .then((info) => setUpdates((prev) => ({ ...prev, [row.id]: info })))
          .catch(() => {
            // Offline, or no npm on this machine: no badge rather than a
            // wrong one.
          });
      }
    } finally {
      setLoading(false);
    }
  }, [fetchCatalog]);

  useEffect(() => {
    void load();
    // A live recheck, not just the cached presence list — opening this page
    // is exactly when a stale "connected" (credentials file present, token
    // actually expired) would otherwise be shown at face value.
    void verifyAgents();
    // The deep link is one-shot: closing the sheet must not reopen it.
    setAgentSheetId(null);
  }, [load, verifyAgents, setAgentSheetId]);

  const refresh = () => {
    checked.current.clear();
    setUpdates({});
    void load();
    void verifyAgents();
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return catalog.filter((entry) => {
      if (filter === "installed" && !entry.installed) return false;
      if (filter === "missing" && entry.installed) return false;
      if (!needle) return true;
      return (
        entry.name.toLowerCase().includes(needle) ||
        entry.cli.toLowerCase().includes(needle) ||
        entry.id.includes(needle)
      );
    });
  }, [catalog, filter, query]);

  const recommended = visible.filter((entry) => entry.recommended);
  const open = catalog.find((entry) => entry.id === openId) ?? null;
  const statusOf = (id: string) => agents.find((a) => a.id === id);

  return (
    <div>
      <SectionHead
        title="Agents"
        sub="Manage agents and model configurations."
        right={<DevicePill name={machine} />}
      />

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-0.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-0.5">
          {FILTERS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilter(tab.id)}
              className={`cursor-pointer rounded-md px-3 py-1 text-[12px] whitespace-nowrap ${
                tab.id === filter
                  ? "bg-[var(--selected)] font-medium text-[var(--ink)]"
                  : "text-[var(--muted)] hover:text-[var(--ink)]"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto min-w-0 flex-1 md:max-w-[300px]">
          <Search
            size={14}
            strokeWidth={2}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--faint)]"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agents…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pr-3 pl-8 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
          />
        </div>
        <button
          type="button"
          title="Recheck which agents are installed"
          onClick={refresh}
          className="flex shrink-0 cursor-pointer items-center rounded-lg border border-[var(--border)] bg-[var(--card)] p-2 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCw size={14} strokeWidth={2} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="mt-2 border-t border-[var(--border)]" />

      {recommended.length > 0 && (
        <AgentGroup title="Recommended" count={recommended.length}>
          {recommended.map((entry) => (
            <AgentRow
              key={entry.id}
              entry={entry}
              update={updates[entry.id]}
              onOpen={() => setOpenId(entry.id)}
            />
          ))}
        </AgentGroup>
      )}

      <AgentGroup title="All agents" count={visible.length}>
        {visible.map((entry) => (
          <AgentRow
            key={entry.id}
            entry={entry}
            update={updates[entry.id]}
            onOpen={() => setOpenId(entry.id)}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-2 py-6 text-[13px] text-[var(--faint)]">
            {loading ? "Looking for agents…" : "No agent matches that search."}
          </div>
        )}
      </AgentGroup>

      <div className="mt-8">
        <SessionTitlesCard />
      </div>

      {open && (
        <AgentSheet
          entry={open}
          status={statusOf(open.id)}
          update={updates[open.id]}
          refreshing={sheetRefreshing}
          onRefresh={() => refreshAgent(open.id)}
          onClose={() => setOpenId(null)}
          onInstalled={async (next) => {
            useEgant.setState((prev) => ({
              catalog: prev.catalog.map((row) => (row.id === next.id ? next : row)),
            }));
            checked.current.delete(next.id);
            await refreshAgent(next.id);
          }}
        />
      )}
    </div>
  );
}

function AgentGroup({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="mt-5">
      <h2 className="px-2 pb-1 text-[12px] font-medium text-[var(--muted)]">
        {title} ({count})
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function AgentRow({
  entry,
  update,
  onOpen,
}: {
  entry: AgentCatalogEntry;
  update?: AgentUpdate;
  onOpen: () => void;
}) {
  const version = update?.current || entry.version;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-[var(--hover)]"
    >
      <ProviderLogo provider={entry.vendor} size={30} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] text-[var(--ink)]">
        {entry.name}
      </span>
      {version && (
        <span className="shrink-0 font-mono text-[11px] text-[var(--muted)]">
          v{version}
        </span>
      )}
      {entry.chatUi && <Badge tone="info">Chat UI</Badge>}
      {update?.updateAvailable && <Badge tone="warn">Update available</Badge>}
      <Badge tone={entry.installed ? "good" : "idle"}>
        {entry.installed ? "Installed" : "Not installed"}
      </Badge>
    </button>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "info" | "warn" | "good" | "idle";
  children: ReactNode;
}) {
  const tones = {
    info: "border-[var(--border)] bg-[var(--card)] text-[var(--muted)]",
    warn: "border-amber-400/25 bg-amber-500/15 text-amber-300",
    good: "border-[var(--border)] bg-[var(--card)] text-[var(--muted)]",
    idle: "border-[var(--border)] bg-[var(--hover)] text-[var(--faint)]",
  } as const;
  return (
    <span
      className={`shrink-0 rounded-md border px-2 py-0.5 text-[11px] whitespace-nowrap ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Live install output
// ---------------------------------------------------------------------------

/** A just-enough terminal for installer output: `\r` returns to the start of
 * the line so a progress bar redraws in place instead of stacking a hundred
 * rows, `\n` starts a new one, and colour/cursor escapes are dropped. */
interface TermBuffer {
  lines: string[];
  col: number;
}

const MAX_TERM_LINES = 400;
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;

function newTermBuffer(): TermBuffer {
  return { lines: [""], col: 0 };
}

function writeTerm(buf: TermBuffer, chunk: string) {
  for (const ch of chunk.replace(ANSI, "")) {
    if (ch === "\n") {
      buf.lines.push("");
      buf.col = 0;
    } else if (ch === "\r") {
      buf.col = 0;
    } else {
      const last = buf.lines.length - 1;
      const line = buf.lines[last];
      buf.lines[last] =
        buf.col >= line.length
          ? line + ch
          : line.slice(0, buf.col) + ch + line.slice(buf.col + 1);
      buf.col += 1;
    }
  }
  if (buf.lines.length > MAX_TERM_LINES) {
    buf.lines.splice(0, buf.lines.length - MAX_TERM_LINES);
  }
}

const termText = (buf: TermBuffer) => buf.lines.join("\n").trimEnd();

// ---------------------------------------------------------------------------
// The sheet a row opens
// ---------------------------------------------------------------------------

function AgentSheet({
  entry,
  status,
  update,
  refreshing,
  onRefresh,
  onClose,
  onInstalled,
}: {
  entry: AgentCatalogEntry;
  status?: AgentStatus;
  update?: AgentUpdate;
  refreshing?: boolean;
  onRefresh?: () => Promise<void>;
  onClose: () => void;
  onInstalled: (next: AgentCatalogEntry) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showReinstall, setShowReinstall] = useState(false);
  // The command's output as it streams in, rendered like a terminal.
  const [live, setLive] = useState("");
  const term = useRef<TermBuffer>(newTermBuffer());
  const liveRef = useRef<HTMLPreElement | null>(null);

  // Capture phase, so `Esc` closes the sheet rather than the whole settings
  // window (App's own handler listens on `window` at bubble phase).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  // Live check on mount to ensure we have the real version and update status
  useEffect(() => {
    if (entry.installed && onRefresh) {
      void onRefresh();
    }
  }, [entry.id]);

  // The backend streams the install command's output while it runs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<{ agent: string; data: string }>("agent-install-output", (event) => {
      if (event.payload.agent !== entry.id) return;
      writeTerm(term.current, event.payload.data);
      setLive(termText(term.current));
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [entry.id]);

  // Keep the newest line in view while it streams.
  useEffect(() => {
    const el = liveRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [live]);

  const copy = (label: string, text: string) => {
    void navigator.clipboard?.writeText(text).catch(() => {});
    setCopied(label);
    setTimeout(() => setCopied(null), 1400);
  };

  /** Both actions are the same shape: run a backend command that re-probes
   * the row, then show its log. `key` is what the spinner keys off, so two
   * source rows can't both spin. */
  const run = async (key: string, call: () => Promise<AgentInstallOutcome>) => {
    setBusy(key);
    setLog(null);
    setFailed(false);
    term.current = newTermBuffer();
    setLive("");
    try {
      const outcome = await call();
      setFailed(!outcome.success);
      // What streamed is the real, interleaved terminal; fall back to the
      // captured tail only if nothing came through the event.
      const streamed = termText(term.current);
      setLog(
        streamed ||
          outcome.output ||
          (outcome.success ? "Done." : "The command failed."),
      );
      onInstalled(outcome.status);
      if (onRefresh) {
        void onRefresh();
      }
    } catch (error) {
      setFailed(true);
      setLog(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const options = entry.installOptions;
  const preferred = options.find((o) => o.recommended) ?? options[0] ?? null;
  const hasUpdate = update?.updateAvailable ?? false;
  const version = update?.current || entry.version;
  // Which source "Install latest" / "Update" runs. The backend names one when it could
  // check; otherwise the entry's recommended source.
  const updateOption =
    options.find((o) => o.method === update?.method) ?? preferred;

  return (
    <div className="fixed inset-0 z-[90] flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="menu relative m-3 flex w-full max-w-[560px] flex-col overflow-hidden rounded-2xl">
        <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-1">
          <span className="text-[12px] text-[var(--muted)]">
            {entry.installed ? "Agent Settings" : "Install Agent"}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pt-3 pb-6">
          <header className="flex items-start gap-3.5">
            <ProviderLogo provider={entry.vendor} size={48} />
            <div className="min-w-0 flex-1">
              <div className="text-[18px] font-semibold text-[var(--ink)]">{entry.name}</div>
              <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                Supports: {entry.supports.join(", ")}
              </div>
            </div>
            <button
              type="button"
              onClick={() => void api.openUrl(entry.website)}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              View Website
              <ExternalLink size={13} strokeWidth={2} />
            </button>
          </header>

          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-[13px] text-[var(--muted)]">Installation</h3>
              {entry.installed && onRefresh && (
                <button
                  type="button"
                  onClick={() => void onRefresh()}
                  disabled={refreshing || busy !== null}
                  title="Check actual installed version and updates"
                  className="flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:opacity-50"
                >
                  <RefreshCw size={11} strokeWidth={2} className={refreshing ? "animate-spin" : ""} />
                  <span>{refreshing ? "Checking…" : "Check version"}</span>
                </button>
              )}
            </div>
            <div className="flex items-center gap-3 rounded-xl border border-[var(--border)] px-3.5 py-3">
              <span
                className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${
                  entry.installed
                    ? "bg-[var(--selected)] text-[var(--ink)]"
                    : "bg-[var(--hover)] text-[var(--faint)]"
                }`}
              >
                {busy || refreshing ? (
                  <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" />
                ) : entry.installed ? (
                  <Check size={14} strokeWidth={2.5} />
                ) : (
                  <X size={14} strokeWidth={2.5} />
                )}
              </span>
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px]">
                {entry.installed ? (
                  <>
                    <span className="shrink-0 text-[var(--ink)]">Found</span>
                    {version && (
                      <span className="shrink-0 rounded-md bg-[var(--hover)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--muted)]">
                        v{version}
                      </span>
                    )}
                    <span className="min-w-0 truncate text-[var(--muted)]" title={entry.executable ?? ""}>
                      {entry.executable}
                    </span>
                  </>
                ) : (
                  <span className="text-[var(--muted)]">
                    {options.length > 0 ? "Not found — install below" : "Not found on this device"}
                  </span>
                )}
              </span>
              <div className="relative shrink-0">
                <button
                  type="button"
                  aria-label="Installation options"
                  onClick={() => setMenuOpen((v) => !v)}
                  className="cursor-pointer rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                >
                  <MoreHorizontal size={16} strokeWidth={2} />
                </button>
                {menuOpen && (
                  <>
                    <div className="fixed inset-0 z-[95]" onClick={() => setMenuOpen(false)} />
                    <div className="menu absolute right-0 z-[96] mt-1 w-[220px] overflow-hidden rounded-xl p-1">
                      {entry.executable && (
                        <SheetMenuItem
                          onClick={() => {
                            copy("path", entry.executable ?? "");
                            setMenuOpen(false);
                          }}
                        >
                          Copy path
                        </SheetMenuItem>
                      )}
                      {preferred && (
                        <SheetMenuItem
                          onClick={() => {
                            copy("command", preferred.command);
                            setMenuOpen(false);
                          }}
                        >
                          Copy install command
                        </SheetMenuItem>
                      )}
                      <SheetMenuItem
                        onClick={() => {
                          void api.openUrl(entry.website);
                          setMenuOpen(false);
                        }}
                      >
                        Open website
                      </SheetMenuItem>
                    </div>
                  </>
                )}
              </div>
            </div>
            {copied && (
              <div className="mt-1.5 text-[12px] text-[var(--faint)]">Copied {copied}.</div>
            )}
          </section>

          {entry.installed && updateOption && (
            <section>
              {hasUpdate ? (
                <div className="rounded-xl border border-amber-400/25 bg-amber-500/[0.06]">
                  <div className="flex items-center justify-between px-3.5 pt-3">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium text-[var(--ink)]">Update available</span>
                      <span className="flex items-center gap-1 text-[12px] text-[var(--muted)]">
                        <span className="font-mono">{version || update?.current}</span>
                        <ArrowRight size={11} strokeWidth={2} />
                        <span className="font-mono font-semibold text-amber-300">{update?.latest}</span>
                      </span>
                    </div>
                  </div>
                  <CommandRow
                    command={updateOption.updateCommand}
                    label={`Update to v${update?.latest}`}
                    busy={busy === "update"}
                    disabled={busy !== null}
                    onRun={() =>
                      void run("update", () => api.updateAgent(entry.id, updateOption.method))
                    }
                  />
                </div>
              ) : (
                <div className="rounded-xl border border-[var(--border)] px-3.5 py-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-[13px]">
                      {update?.latest ? (
                        <>
                          <Check size={14} strokeWidth={2.5} className="text-emerald-500" />
                          <span className="text-[var(--ink)]">Up to date</span>
                          <span className="font-mono text-[11px] text-[var(--muted)]">
                            v{version || update.latest}
                          </span>
                        </>
                      ) : update ? (
                        <span className="text-[12px] text-[var(--muted)]">
                          v{version || "unknown"} installed · published release could not be verified
                        </span>
                      ) : (
                        <div className="flex items-center gap-2 text-[12px] text-[var(--muted)]">
                          <RefreshCw size={12} className="animate-spin text-[var(--muted)]" />
                          <span>Checking for updates…</span>
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setShowReinstall((v) => !v)}
                      className="cursor-pointer text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
                    >
                      {showReinstall ? "Hide command" : "Reinstall"}
                    </button>
                  </div>
                  {showReinstall && (
                    <div className="mt-3 border-t border-[var(--border)] pt-2.5">
                      <div className="mb-1 text-[11px] text-[var(--muted)]">
                        Re-run command to repair or reinstall this CLI:
                      </div>
                      <CommandRow
                        command={updateOption.updateCommand}
                        label="Reinstall"
                        busy={busy === "update"}
                        disabled={busy !== null}
                        onRun={() =>
                          void run("update", () => api.updateAgent(entry.id, updateOption.method))
                        }
                      />
                    </div>
                  )}
                </div>
              )}
            </section>
          )}

          {!entry.installed && (
            <section>
              <div className="rounded-xl border border-[var(--border)]">
                <div className="px-3.5 pt-3 text-[13px] text-[var(--ink)]">Install</div>
                {options.length > 0 ? (
                  options.map((option) => (
                    <CommandRow
                      key={option.method}
                      command={option.command}
                      label="Install"
                      method={options.length > 1 ? option.method : undefined}
                      recommended={options.length > 1 && option.recommended}
                      busy={busy === option.method}
                      disabled={busy !== null}
                      onRun={() =>
                        void run(option.method, () => api.installAgent(entry.id, option.method))
                      }
                    />
                  ))
                ) : (
                  <div className="px-3.5 pt-1.5 pb-3.5 text-[12px] leading-relaxed text-[var(--muted)]">
                    {entry.name} publishes no one-line install — follow the setup on their
                    site, then hit Refresh on the Agents list.
                  </div>
                )}
              </div>
            </section>
          )}

          {busy && (
            <div className="-mt-3">
              <div className="mb-1 flex items-center gap-1.5 text-[12px] text-[var(--ink)]">
                <RefreshCw size={12} strokeWidth={2.5} className="animate-spin" />
                Running in your login shell…
              </div>
              <pre
                ref={liveRef}
                className="max-h-[220px] min-h-[64px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-[var(--muted)]"
              >
                {live || "Starting…"}
              </pre>
              <p className="mt-1.5 text-[12px] text-[var(--muted)]">
                A command that asks for a password can't answer here — run it in a terminal
                if this fails.
              </p>
            </div>
          )}
          {log && !busy && (
            <div className="-mt-3">
              <div
                className={`mb-1 flex items-center gap-1.5 text-[12px] ${
                  failed ? "text-amber-300" : "text-[var(--ink)]"
                }`}
              >
                {failed ? (
                  <AlertTriangle size={12} strokeWidth={2} />
                ) : (
                  <Check size={12} strokeWidth={2.5} />
                )}
                {failed ? "That command failed" : `${entry.name} is ready`}
                <button
                  type="button"
                  onClick={() => copy("log", log)}
                  className="ml-auto flex cursor-pointer items-center gap-1 text-[var(--faint)] hover:text-[var(--ink)]"
                >
                  <Copy size={11} strokeWidth={2} />
                  {copied === "log" ? "Copied" : "Copy log"}
                </button>
              </div>
              <pre className="max-h-[220px] overflow-auto rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-[var(--muted)]">
                {log}
              </pre>
            </div>
          )}

          {entry.chatUi && <ChatUiSettings entry={entry} status={status} />}
          <CliSettings entry={entry} />
        </div>
      </div>
    </div>
  );
}

/** One runnable command: the line itself, and the button that runs it. The
 * shared shape behind both the install sources and "Install latest". */
function CommandRow({
  command,
  label,
  method,
  recommended,
  busy,
  disabled,
  onRun,
}: {
  command: string;
  label: string;
  method?: string;
  recommended?: boolean;
  busy: boolean;
  disabled: boolean;
  onRun: () => void;
}) {
  return (
    <div className="px-3.5 pt-2.5 pb-3.5">
      {method && (
        <div className="mb-1.5 flex items-center gap-1.5 text-[11px] text-[var(--faint)]">
          <span className="uppercase">{method}</span>
          {recommended && (
            <span className="rounded border border-[var(--border)] px-1 py-px text-[10px] text-[var(--muted)]">
              Recommended
            </span>
          )}
        </div>
      )}
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-2 font-mono text-[12px] text-[var(--ink)]">
          {command}
        </code>
        <button
          type="button"
          disabled={disabled}
          onClick={onRun}
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-2 text-[13px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-50"
        >
          {busy ? (
            <RefreshCw size={13} strokeWidth={2.5} className="animate-spin" />
          ) : (
            <Download size={13} strokeWidth={2.5} />
          )}
          {busy ? "Running…" : label}
        </button>
      </div>
    </div>
  );
}

function SheetMenuItem({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] text-[var(--ink)] hover:bg-[var(--hover)]"
    >
      {children}
    </button>
  );
}

/** The part of the sheet only the agents egant drives itself get: whether
 * the composer offers them, the account they run as, and their default
 * model. Writes straight into the store, so the composer and the next
 * `create_session` read the same values. */
function ChatUiSettings({
  entry,
  status,
}: {
  entry: AgentCatalogEntry;
  status?: AgentStatus;
}) {
  const enabledAgents = useEgant((s) => s.enabledAgents);
  const setAgentEnabled = useEgant((s) => s.setAgentEnabled);
  const fetchAgents = useEgant((s) => s.fetchAgents);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const on = entry.installed && (enabledAgents[entry.id] ?? false);

  const connect = async () => {
    setConnecting(true);
    setError(null);
    try {
      await api.connectAgent(entry.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
      // The flow finishes in a browser tab or a terminal on the user's own
      // clock — re-probe rather than claiming it landed.
      void fetchAgents();
    }
  };

  return (
    <section>
      <h3 className="mb-2 text-[13px] text-[var(--muted)]">In egant</h3>
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-[13px] text-[var(--ink)]">Offer in the composer</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted)]">
              {entry.installed
                ? "New sessions can pick this agent."
                : "Install the CLI to enable."}
            </div>
          </div>
          <Toggle
            on={on}
            disabled={!entry.installed}
            label={`${entry.name} enabled`}
            onChange={(next) => setAgentEnabled(entry.id, next)}
          />
        </div>

        {entry.installed && (
          <div className="flex items-center gap-3 border-t border-[var(--border)] pt-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-[var(--ink)]">Account</div>
              <div className="mt-0.5 truncate text-[12px] text-[var(--muted)]">
                {error ? (
                  <span className="text-amber-300">{error}</span>
                ) : status?.connected ? (
                  <span className="text-[var(--ink)]">{status.email ?? "Signed in"}</span>
                ) : (
                  "Not signed in on this device."
                )}
              </div>
            </div>
            <button
              type="button"
              disabled={connecting}
              onClick={() => void connect()}
              className="shrink-0 cursor-pointer rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--ink)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-50"
            >
              {status?.connected ? "Switch account" : "Sign in"}
            </button>
          </div>
        )}

        {entry.installed && on && (
          <div className="border-t border-[var(--border)] pt-3">
            <AgentDefaults id={entry.id} installed={entry.installed} />
          </div>
        )}
      </div>
    </section>
  );
}

/** Running this agent as its own CLI, in a terminal on the stage.
 *
 * Two shapes, and which one shows is not a style choice: an agent egant has
 * a chat harness for gets a switch (chat or CLI — the same one the composer's
 * agent tabs carry), and one it doesn't gets a plain button, because for
 * those the CLI is not an alternative to anything. */
function CliSettings({ entry }: { entry: AgentCatalogEntry }) {
  const chatUiAgents = useEgant((s) => s.chatUiAgents);
  const setChatUi = useEgant((s) => s.setChatUi);
  const askCliLaunch = useEgant((s) => s.askCliLaunch);
  const closeSettings = useEgant((s) => s.closeSettings);
  const chat = entry.chatUi && (chatUiAgents[entry.id] ?? true);

  const openCli = () => {
    // The dialog lives over the window, not over Settings — and the session
    // it starts is on the stage, which is where the user should end up.
    closeSettings();
    askCliLaunch(entry.id);
  };

  return (
    <section>
      <h3 className="mb-2 text-[13px] text-[var(--muted)]">Terminal</h3>
      <div className="flex flex-col gap-3 rounded-xl border border-[var(--border)] px-3.5 py-3">
        {entry.chatUi ? (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-[var(--ink)]">Use egant's chat UI</div>
              <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                {chat
                  ? "Turns render as chat, with tools and permissions in egant."
                  : `Picking ${entry.name} opens its own CLI in a terminal instead.`}
              </div>
            </div>
            <Toggle
              on={chat}
              label={`egant chat UI for ${entry.name}`}
              onChange={(next) => {
                setChatUi(entry.id, next);
                if (!next) openCli();
              }}
            />
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-[var(--ink)]">Run in a terminal</div>
              <div className="mt-0.5 text-[12px] text-[var(--muted)]">
                {entry.installed
                  ? `egant has no chat harness for ${entry.name} — it runs as its own CLI, in this project.`
                  : "Install the CLI to enable."}
              </div>
            </div>
            <button
              type="button"
              disabled={!entry.installed}
              onClick={openCli}
              className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[12px] text-[var(--ink)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-50"
            >
              <TerminalSquare size={12} strokeWidth={2} />
              Open session
            </button>
          </div>
        )}
        <div className="border-t border-[var(--border)] pt-3 text-[12px] text-[var(--muted)]">
          Opens{" "}
          <code className="rounded bg-[var(--card)] px-1 py-px font-mono text-[11px] text-[var(--ink)]">
            {entry.launchCommand}
          </code>{" "}
          with your login shell's environment, in the project's folder.
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Per-agent defaults
// ---------------------------------------------------------------------------

/** Stable fallback for "no bad models recorded for this agent" — a zustand
 * selector must never construct a fresh `[]`/`{}` inline (its default
 * equality check is by reference, so a new empty array on every call never
 * matches the last one, and React's `useSyncExternalStore` loops forever
 * re-rendering to "check again"; this is the exact
 * "getSnapshot should be cached" failure). Reusing one constant reference
 * keeps the empty case referentially stable across renders. */
const NO_BAD_MODELS: string[] = [];

function AgentDefaults({ id, installed }: { id: string; installed: boolean }) {
  const defaultModels = useEgant((s) => s.defaultModels);
  const setDefaultModel = useEgant((s) => s.setDefaultModel);
  const defaultVariants = useEgant((s) => s.defaultVariants);
  const setDefaultVariant = useEgant((s) => s.setDefaultVariant);
  const defaultContexts = useEgant((s) => s.defaultContexts);
  const setDefaultContext = useEgant((s) => s.setDefaultContext);
  // Select the stable `badModels` object itself, not a derived slice of it —
  // see `NO_BAD_MODELS`'s comment for why the derived form looped forever.
  const badModels = useEgant((s) => s.snapshot?.badModels);
  const badModelIds = badModels?.[id] ?? NO_BAD_MODELS;
  const [models, setModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    api
      .listModels(id)
      .then((rows) => {
        if (live) setModels(rows);
      })
      .catch((e: unknown) => {
        if (live) {
          setModels([]);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [id]);

  const currentModel = defaultModels[id] ?? "";
  const modelRow = models.find((m) => m.id === currentModel) ?? null;
  const allVariants = useMemo(() => {
    const set = new Set<string>();
    for (const m of models) for (const v of m.variants) set.add(v);
    if (modelRow) for (const v of modelRow.variants) set.add(v);
    const saved = (defaultVariants[id] ?? "").trim();
    if (saved) set.add(saved);
    return [...set].sort();
  }, [models, modelRow, defaultVariants, id]);
  const currentVariant = defaultVariants[id] ?? "";
  const currentContextNum = parseContext((defaultContexts[id] ?? "").trim());
  const contextOptions = useMemo(() => {
    const opts = [...CONTEXT_PRESETS];
    if (currentContextNum > 0 && !opts.some((p) => parseContext(p) === currentContextNum)) {
      opts.push(formatContext(currentContextNum));
    }
    return opts;
  }, [currentContextNum]);

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1.5 text-[12px] text-[var(--faint)]">
        {modelRow && <ProviderLogo provider={modelRow.provider} size={18} />}
        Default model
      </span>
      <Select
        value={currentModel}
        disabled={loading || !installed}
        className="max-w-[240px]"
        onChange={(next) => {
          setDefaultModel(id, next);
          // A stale variant for the new model would fail the turn.
          const row = models.find((m) => m.id === next) ?? null;
          if (!row || (currentVariant && !row.variants.includes(currentVariant))) {
            setDefaultVariant(id, "");
          }
        }}
      >
        <option value="">CLI default</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {badModelIds.includes(m.id) ? "⚠ " : ""}
            {m.name} —{" "}
            {badModelIds.includes(m.id)
              ? "Failed earlier this session"
              : m.description || m.providerName}
          </option>
        ))}
      </Select>
      {loading && <span className="text-[12px] text-[var(--faint)]">Loading…</span>}
      {!loading && modelRow && badModelIds.includes(modelRow.id) && (
        <span
          className="flex items-center gap-1 text-[12px] text-amber-400/90"
          title="This model failed with a model/catalog error earlier this session — it may still be worth retrying."
        >
          <AlertTriangle size={12} strokeWidth={2} />
          Failed earlier this session
        </span>
      )}
      {error && !loading && (
        <span className="max-w-[300px] truncate text-[12px] text-amber-400/90" title={error}>
          {error}
        </span>
      )}
      {allVariants.length > 0 && (
        <>
          <span className="ml-1 text-[12px] text-[var(--faint)]">Reasoning</span>
          <Select value={currentVariant} onChange={(next) => setDefaultVariant(id, next)}>
            <option value="">CLI default</option>
            {allVariants.map((v) => (
              <option key={v} value={v}>
                {v}
              </option>
            ))}
          </Select>
        </>
      )}
      <span className="ml-1 text-[12px] text-[var(--faint)]">Context</span>
      <Select
        value={currentContextNum > 0 ? formatContext(currentContextNum) : ""}
        title="Default context window for new sessions (Codex: passed as model_context_window)"
        onChange={(next) => setDefaultContext(id, next)}
      >
        <option value="">Model default</option>
        {contextOptions.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </Select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session titles
// ---------------------------------------------------------------------------

function SessionTitlesCard() {
  const titleAgent = useEgant((s) => s.snapshot?.settings.titleAgent ?? "claude");
  const setTitleAgent = async (next: string) => {
    try {
      const settings = await api.setTitleAgent(next);
      const snapshot = useEgant.getState().snapshot;
      if (snapshot) useEgant.setState({ snapshot: { ...snapshot, settings } });
    } catch {
      // Keep the previous selection on failure.
    }
  };
  return (
    <Card>
      <Row
        icon={AlignLeft}
        title="Session titles"
        sub="The agent used to name new sessions. Claude Code and Codex support restricted title generation. Off keeps the first-line title."
        control={
          <Select value={titleAgent} onChange={(v) => void setTitleAgent(v)}>
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="off">Off</option>
          </Select>
        }
      />
    </Card>
  );
}
