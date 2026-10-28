import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AGENT_PROVIDER, fallbackName } from "../lib/agents";
import { api } from "../lib/api";
import { log } from "../lib/logger";
import { formatTokens } from "../lib/transcript";
import type {
  ClaudeUsage,
  CodexUsage,
  ModelUsageStat,
  OpencodeUsageStats,
  TokenActivity,
} from "../lib/types";
import { formatResetIn, roundPercent } from "../lib/usageLimits";
import { useEgant } from "../store";
import { ProviderLogo } from "./ProviderLogo";
import { Card, DevicePill, Pills, SectionHead, usePersistentState } from "./SettingsKit";
import { useNow } from "./useNow";

/** Prettify model IDs like `claude-opus-5-5` -> "Opus 5.5", `gpt-5.6-terra` -> "GPT 5.6 Terra". */
export function formatModelTitle(id: string): string {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (claude) {
    const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
    return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  }
  if (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3")) {
    return id
      .split("-")
      .map((part) => (part === "gpt" ? "GPT" : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ");
  }
  if (id.startsWith("gemini-")) {
    return id
      .split("-")
      .map((part) => (part === "gemini" ? "Gemini" : part.charAt(0).toUpperCase() + part.slice(1)))
      .join(" ");
  }
  return id;
}

/** Collapse reasoning effort variants (e.g. High, Low, Medium) into base model name. */
export function baseModelName(id: string): string {
  const clean = id
    .replace(/-(high|low|medium|minimal|xhigh|ultra)$/i, "")
    .replace(/\s*\((High|Low|Medium|Minimal|X-High|Ultra)\)$/i, "");
  return formatModelTitle(clean);
}

/** Human-readable name for a Codex window based on its length. */
function codexWindowName(seconds: number | null): string {
  if (seconds == null || seconds <= 0) return "Usage window";
  if (seconds <= 6 * 3600) return "5-hour session limit";
  if (seconds <= 7 * 86400) return "Weekly limit";
  const days = Math.round(seconds / 86400);
  return `${days}-day limit`;
}

/** Determine which provider group an agent/model belongs to. */
export function providerGroupFor(agent: string, model: string): {
  id: string;
  name: string;
  vendor: string;
} {
  const lowerAgent = agent.toLowerCase();
  const lowerModel = model.toLowerCase();

  if (lowerAgent === "claude" || lowerModel.startsWith("claude")) {
    return { id: "anthropic", name: "Anthropic / Claude", vendor: "claude" };
  }
  if (
    lowerAgent === "codex" ||
    lowerAgent === "openai" ||
    lowerModel.startsWith("gpt") ||
    lowerModel.startsWith("o1") ||
    lowerModel.startsWith("o3") ||
    lowerModel.startsWith("codex")
  ) {
    return { id: "openai", name: "OpenAI / Codex", vendor: "openai" };
  }
  if (
    lowerAgent === "antigravity" ||
    lowerModel.startsWith("gemini")
  ) {
    return { id: "google", name: "Google / Antigravity", vendor: "google" };
  }
  if (lowerAgent === "opencode") {
    return { id: "opencode", name: "OpenCode", vendor: "opencode" };
  }
  return {
    id: lowerAgent,
    name: fallbackName(agent),
    vendor: AGENT_PROVIDER[lowerAgent] ?? lowerAgent,
  };
}

interface ModelItem {
  agent: string;
  model: string;
  displayName: string;
  baseName: string;
  contextWindow: number;
  stats?: ModelUsageStat;
  isSonnet: boolean;
  isClaude: boolean;
}

interface ProviderSectionData {
  id: string;
  name: string;
  vendor: string;
  agentId: string;
  connected: boolean;
  fiveHourTokens: number;
  weeklyTokens: number;
  allTimeTokens: number;
  fiveHourTurns: number;
  weeklyTurns: number;
  allTimeTurns: number;
  fiveHourResetsAt: number | null;
  lastUsedAt: number | null;
  models: ModelItem[];
}

interface MainModelQuota {
  key: string;
  name: string;
  percent: number;
  resetsAt: string | number | null;
  statusText?: string;
  statusBadge?: string;
  vendor: string;
}

export function UsageSection() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "Local device");
  const agents = useEgant((s) => s.agents);
  const verifyAgents = useEgant((s) => s.verifyAgents);
  const claudeUsage = useEgant((s) => s.claudeUsage);
  const fetchClaudeUsage = useEgant((s) => s.fetchClaudeUsage);
  const codexUsage = useEgant((s) => s.codexUsage);
  const fetchCodexUsage = useEgant((s) => s.fetchCodexUsage);
  const opencodeUsage = useEgant((s) => s.opencodeUsage);
  const fetchOpencodeUsage = useEgant((s) => s.fetchOpencodeUsage);

  const [activity, setActivity] = useState<TokenActivity | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [providerFilter, setProviderFilter] = usePersistentState<string>("egant.usage.providerFilter", "all");
  const [query, setQuery] = useState("");
  const now = useNow(30_000);

  const loadData = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);

    try {
      const [act] = await Promise.all([
        api.tokenActivity().catch((e) => {
          log.warn("usage", `tokenActivity failed: ${String(e)}`);
          return null;
        }),
        fetchClaudeUsage().catch(() => null),
        fetchCodexUsage().catch(() => null),
        fetchOpencodeUsage().catch(() => null),
        verifyAgents().catch(() => null),
      ]);

      if (act) {
        setActivity(act);
      }
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchClaudeUsage, fetchCodexUsage, fetchOpencodeUsage, verifyAgents]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Build provider sections
  const providerSections = useMemo(() => {
    const sectionsMap = new Map<string, ProviderSectionData>();

    const getOrCreateSection = (
      provId: string,
      provName: string,
      vendor: string,
      agentId: string,
    ): ProviderSectionData => {
      let sec = sectionsMap.get(provId);
      if (!sec) {
        const agentStatus = agents.find((a) => a.id === agentId || a.id === provId);
        sec = {
          id: provId,
          name: provName,
          vendor,
          agentId,
          connected: agentStatus?.connected ?? false,
          fiveHourTokens: 0,
          weeklyTokens: 0,
          allTimeTokens: 0,
          fiveHourTurns: 0,
          weeklyTurns: 0,
          allTimeTurns: 0,
          fiveHourResetsAt: null,
          lastUsedAt: null,
          models: [],
        };
        sectionsMap.set(provId, sec);
      }
      return sec;
    };

    // Pre-populate standard providers
    getOrCreateSection("anthropic", "Anthropic / Claude", "claude", "claude");
    getOrCreateSection("openai", "OpenAI / Codex", "openai", "codex");
    getOrCreateSection("google", "Google / Antigravity", "google", "antigravity");
    getOrCreateSection("opencode", "OpenCode", "opencode", "opencode");

    // Add stats from token activity logs
    const statsList = activity?.modelStats ?? [];

    for (const stat of statsList) {
      // Safety: Skip malformed model names (e.g. code snippets, newlines, etc.)
      if (
        !stat.model ||
        stat.model.length > 50 ||
        stat.model.includes("\n") ||
        stat.model.includes("\r") ||
        stat.model.includes("{") ||
        stat.model.includes("}") ||
        stat.model.includes(";") ||
        stat.model.includes("&") ||
        stat.model.includes("=")
      ) {
        continue;
      }

      const group = providerGroupFor(stat.agent, stat.model);
      const sec = getOrCreateSection(group.id, group.name, group.vendor, stat.agent);

      sec.fiveHourTokens += stat.fiveHourTokens;
      sec.weeklyTokens += stat.weeklyTokens;
      sec.allTimeTokens += stat.allTimeTokens;
      sec.fiveHourTurns += stat.fiveHourTurns;
      sec.weeklyTurns += stat.weeklyTurns;
      sec.allTimeTurns += stat.allTimeTurns;

      if (stat.fiveHourResetsAt) {
        sec.fiveHourResetsAt = Math.max(sec.fiveHourResetsAt ?? 0, stat.fiveHourResetsAt);
      }
      if (stat.lastUsedAt) {
        sec.lastUsedAt = Math.max(sec.lastUsedAt ?? 0, stat.lastUsedAt);
      }

      const isSonnet = stat.model.toLowerCase().includes("sonnet");
      const isClaude = group.id === "anthropic" || stat.model.toLowerCase().includes("claude");

      sec.models.push({
        agent: stat.agent,
        model: stat.model,
        displayName: formatModelTitle(stat.model),
        baseName: baseModelName(stat.model),
        contextWindow: 0,
        stats: stat,
        isSonnet,
        isClaude,
      });
    }

    // (No invented reset times here: providers without a real usage endpoint
    // get local activity counts only — never a guessed percentage or clock.)

    return Array.from(sectionsMap.values()).filter(
      (sec) => sec.models.length > 0 || sec.connected || sec.weeklyTokens > 0,
    );
  }, [activity, agents]);

  // Filter sections by provider & query
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providerSections
      .filter((sec) => providerFilter === "all" || sec.id === providerFilter)
      .filter((sec) => {
        if (!q) return true;
        // Search by provider identity, common aliases, or model names
        const matchesProvider =
          sec.name.toLowerCase().includes(q) ||
          sec.vendor.toLowerCase().includes(q) ||
          sec.id.toLowerCase().includes(q) ||
          (sec.id === "openai" && (q === "chatgpt" || q === "gpt" || q === "codex")) ||
          (sec.id === "anthropic" && (q === "claude" || q === "sonnet" || q === "opus" || q === "haiku")) ||
          (sec.id === "google" && (q === "antigravity" || q === "gemini" || q === "flash" || q === "pro")) ||
          (sec.id === "opencode" && (q === "zen" || q === "community"));
        if (matchesProvider) return true;
        return sec.models.some(
          (m) =>
            m.model.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            m.baseName.toLowerCase().includes(q),
        );
      });
  }, [providerSections, providerFilter, query]);

  const providerFilterOptions = useMemo(() => {
    const list = [{ value: "all", label: "All Providers" }];
    for (const sec of providerSections) {
      list.push({ value: sec.id, label: sec.name.split("/")[0]?.trim() || sec.name });
    }
    return list;
  }, [providerSections]);

  return (
    <div className="space-y-6">
      <SectionHead
        title="Usage"
        count={`${providerSections.length} providers`}
        sub="Model plan quotas, session limits, and reset times."
        right={
          <>
            <button
              type="button"
              onClick={() => void loadData(true)}
              disabled={refreshing}
              className="flex cursor-pointer items-center gap-1.5 text-[13px] text-[var(--muted)] hover:text-[var(--ink)] disabled:opacity-50"
            >
              <RefreshCw
                size={13}
                strokeWidth={2}
                className={refreshing ? "animate-spin" : ""}
              />
              Refresh
            </button>
            <DevicePill name={machine} />
          </>
        }
      />

      {/* Control bar: Provider filter & Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Pills
          options={providerFilterOptions}
          value={providerFilter}
          onChange={(val) => setProviderFilter(val)}
        />

        <div className="relative min-w-[200px]">
          <Search
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models…"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pl-8 pr-3 text-[12px] text-[var(--ink)] placeholder-[var(--faint)] focus:border-[var(--accent)] focus:outline-none"
          />
        </div>
      </div>

      {/* Provider Cards */}
      {loading && filteredSections.length === 0 ? (
        <Card>
          <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-[var(--muted)]">
            <RefreshCw size={15} className="animate-spin" />
            Loading model usage and quota limits…
          </div>
        </Card>
      ) : filteredSections.length === 0 ? (
        <Card>
          <div className="py-12 text-center text-[13px] text-[var(--muted)]">
            No models found matching your search.
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {filteredSections.map((sec) => (
            <ProviderUsageCard
              key={sec.id}
              section={sec}
              claudeUsage={sec.id === "anthropic" ? claudeUsage : null}
              codexUsage={sec.id === "openai" ? codexUsage : null}
              opencodeUsage={sec.id === "opencode" ? opencodeUsage : null}
              now={now}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderUsageCard({
  section,
  claudeUsage,
  codexUsage,
  opencodeUsage,
  now,
}: {
  section: ProviderSectionData;
  claudeUsage: ClaudeUsage | null;
  codexUsage: CodexUsage | null;
  opencodeUsage: OpencodeUsageStats | null;
  now: number;
}) {
  // Real plan quotas only. When a provider doesn't expose a usable quota
  // endpoint (or isn't signed in) we show nothing here instead of an invented
  // percentage — see the body below.
  const quotas: MainModelQuota[] = useMemo(() => {
    const list: MainModelQuota[] = [];
    if (section.id === "anthropic") {
      if (claudeUsage) {
        if (claudeUsage.fiveHour) {
          list.push({
            key: "five-hour",
            name: "5-hour session limit",
            percent: roundPercent(claudeUsage.fiveHour),
            resetsAt: claudeUsage.fiveHour.resetsAt,
            statusText: "Rolling 5-hour session window",
            vendor: "claude",
          });
        }
        if (claudeUsage.sevenDay) {
          list.push({
            key: "seven-day",
            name: "Weekly limit (all models)",
            percent: roundPercent(claudeUsage.sevenDay),
            resetsAt: claudeUsage.sevenDay.resetsAt,
            statusText: "7-day account-wide plan quota",
            vendor: "claude",
          });
        }
        if (claudeUsage.sevenDaySonnet) {
          list.push({
            key: "sonnet-weekly",
            name: "Weekly limit · Sonnet",
            percent: roundPercent(claudeUsage.sevenDaySonnet),
            resetsAt: claudeUsage.sevenDaySonnet.resetsAt,
            statusText: "Weekly dedicated Sonnet allocation",
            vendor: "claude",
          });
        }
      }
      return list;
    }
    if (section.id === "openai") {
      if (codexUsage) {
        if (codexUsage.primary) {
          const w = codexUsage.primary;
          list.push({
            key: "primary",
            name: codexWindowName(w.windowSeconds),
            percent: Math.min(100, Math.max(0, Math.round(w.usedPercent))),
            resetsAt: w.resetsAtEpoch,
            statusText: codexUsage.plan ? `ChatGPT ${codexUsage.plan}` : undefined,
            statusBadge: codexUsage.limitReached ? "Limit reached" : undefined,
            vendor: "openai",
          });
        }
        if (codexUsage.secondary) {
          const w = codexUsage.secondary;
          list.push({
            key: "secondary",
            name: codexWindowName(w.windowSeconds),
            percent: Math.min(100, Math.max(0, Math.round(w.usedPercent))),
            resetsAt: w.resetsAtEpoch,
            statusBadge: codexUsage.limitReached ? "Limit reached" : undefined,
            vendor: "openai",
          });
        }
      }
      return list;
    }
    // OpenCode: its real quota state comes from opencodeUsage (auth / free-tier
    // exhaustion) and is rendered as a status row, never as a guessed percent.
    if (section.id === "opencode") {
      if (opencodeUsage?.freeLimitReached) {
        list.push({
          key: "opencode-zen",
          name: "OpenCode Zen (Free Tier Quota)",
          percent: 100,
          resetsAt: null,
          statusBadge: "Rate Limited",
          statusText: "Free community quota reached on this network",
          vendor: "opencode",
        });
      } else if (opencodeUsage?.hasAuth) {
        list.push({
          key: "opencode-auth",
          name: "OpenCode (Configured Provider)",
          percent: 0,
          resetsAt: null,
          statusBadge: "Active",
          statusText: "Authenticated with provider credentials",
          vendor: "opencode",
        });
      } else if (opencodeUsage) {
        list.push({
          key: "opencode-zen",
          name: "OpenCode Zen (Community Models)",
          percent: 0,
          resetsAt: null,
          statusBadge: "Ready",
          statusText: "Free community tier ready",
          vendor: "opencode",
        });
      }
      return list;
    }
    // Google / others: no plan quota endpoint we can read — show nothing here.
    return list;
  }, [section, claudeUsage, codexUsage, opencodeUsage]);

  // Primary percentage to show in the provider header badge — only when there
  // are real windows to average over.
  const maxPercent = useMemo(() => {
    if (quotas.length === 0) return null;
    return Math.max(...quotas.map((q) => q.percent));
  }, [quotas]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xs">
      {/* Provider Header with Clean Monochrome Logo */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderLogo provider={section.vendor} size={28} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[14px] text-[var(--ink)] truncate">
                {section.name}
              </span>
              {section.connected && (
                <span className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--muted)]">
                  Connected
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {maxPercent != null && (
            <span className="rounded-full border border-[var(--border)] bg-[var(--card)] px-2.5 py-0.5 text-[11px] font-medium tabular-nums text-[var(--muted)]">
              {maxPercent}% used
            </span>
          )}
        </div>
      </div>

      {/* Main Models Bars */}
      <div className="p-4 space-y-3">
        {quotas.map((q) => (
          <MainModelBar
            key={q.key}
            name={q.name}
            percent={q.percent}
            resetsAt={q.resetsAt}
            now={now}
            vendor={q.vendor}
            statusText={q.statusText}
            statusBadge={q.statusBadge}
          />
        ))}

        {quotas.length === 0 && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] px-4 py-4 text-[12px] text-[var(--muted)]">
            {section.id === "anthropic"
              ? "Claude didn't report a plan quota right now — it may be signed out on your Mac, or the endpoint is rate-limiting. Local activity is below."
              : section.id === "openai"
                ? "Codex didn't report a plan quota right now — it may be signed in with an API key, or the endpoint is unavailable. Local activity is below."
                : section.id === "google"
                  ? "Google / Antigravity doesn't expose a plan quota we can read — local activity is below."
                  : section.id === "opencode" && opencodeUsage
                    ? null
                    : "No plan quota to show for this provider."}
          </div>
        )}

        {/* Local activity for providers without a real quota endpoint, and as
            a complement for the ones that have one. */}
        {section.models.length > 0 && (
          <div className="space-y-2">
            {section.id !== "anthropic" && section.id !== "openai" && (
              <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--faint)]">
                Local activity (real usage from this machine's logs)
              </div>
            )}
            {section.id === "anthropic" && section.models.length > 0 && (
              <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--faint)]">
                Local activity
              </div>
            )}
            {section.models.map((m) => {
              const s = m.stats;
              if (!s) return null;
              const weekly = s.weeklyTokens;
              const turns = s.weeklyTurns;
              return (
                <div
                  key={m.model}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-[11px] text-[var(--muted)]"
                >
                  <span className="font-medium text-[var(--ink)] truncate">{m.displayName}</span>
                  <span className="tabular-nums">
                    {weekly > 0 ? `${formatTokens(weekly)} tokens this week` : "no usage this week"}
                    {turns > 0 ? ` · ${turns} turn${turns === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        {/* OpenCode Connect Action banner if rate limited */}
        {section.id === "opencode" && opencodeUsage?.freeLimitReached && (
          <OpencodeLimitBanner />
        )}
      </div>
    </div>
  );
}

function MainModelBar({
  name,
  percent,
  resetsAt,
  now,
  vendor,
  statusText,
  statusBadge,
}: {
  name: string;
  percent: number;
  resetsAt?: string | number | null;
  now: number;
  vendor: string;
  statusText?: string;
  statusBadge?: string;
}) {
  const resetLabel = formatResetIn(resetsAt, now, { withClock: true });

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <ProviderLogo provider={vendor} size={20} />
          <span className="font-semibold text-[13px] text-[var(--ink)] truncate">
            {name}
          </span>
          {statusBadge && (
            <span className="rounded-md border border-[var(--border)] bg-[var(--card)] px-2 py-0.5 text-[10.5px] font-medium text-[var(--muted)]">
              {statusBadge}
            </span>
          )}
        </div>

        <div className="text-right">
          <span className="text-[15px] font-semibold tabular-nums text-[var(--ink)]">
            {percent}%
          </span>
          <span className="ml-1 text-[11px] text-[var(--muted)]">used</span>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
        <div
          className="h-full rounded-full transition-all duration-300 bg-[var(--muted)]"
          style={{
            width: `${Math.min(100, Math.max(0, percent))}%`,
          }}
        />
      </div>

      {/* Footer: Reset Time & Status */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div>
          {resetLabel ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--ink)]">
              <Clock size={12} className="text-[var(--muted)]" />
              <span>{resetLabel}</span>
            </span>
          ) : percent === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-[var(--muted)]">
              <CheckCircle2 size={12} className="text-[var(--muted)]" />
              <span>Ready · 100% capacity available</span>
            </span>
          ) : (
            <span className="text-[var(--faint)]">Active session window</span>
          )}
        </div>

        {statusText && (
          <span className="text-[var(--faint)] tabular-nums">{statusText}</span>
        )}
      </div>
    </div>
  );
}

function OpencodeLimitBanner() {
  const [connecting, setConnecting] = useState(false);

  const handleConnect = async () => {
    setConnecting(true);
    try {
      await api.connectAgent("opencode");
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--card)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--hover)] text-[var(--muted)]">
          <AlertTriangle size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[13px] text-[var(--ink)]">
              OpenCode Free Usage Limit Reached
            </span>
          </div>
          <p className="mt-1 text-[12px] text-[var(--muted)] leading-relaxed">
            OpenCode Zen shared free quota has been exhausted. Connect an account to continue.
          </p>
          <div className="mt-3">
            <button
              type="button"
              onClick={handleConnect}
              disabled={connecting}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <Terminal size={13} />
              {connecting ? "Opening Terminal…" : "Add Account (opencode auth login)"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
