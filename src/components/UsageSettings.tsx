import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Clock,
  Flame,
  Gauge,
  Layers,
  RefreshCw,
  Search,
  Terminal,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AGENT_PROVIDER, fallbackName } from "../lib/agents";
import { api } from "../lib/api";
import { log } from "../lib/logger";
import { formatTokens } from "../lib/transcript";
import type { AgentModel, ClaudeUsage, ModelUsageStat, OpencodeUsageStats, TokenActivity } from "../lib/types";
import { formatResetIn, isUsageCritical, roundPercent } from "../lib/usageLimits";
import { useEgant } from "../store";
import { ProviderLogo } from "./ProviderLogo";
import { Card, DevicePill, Pills, SectionHead, usePersistentState } from "./SettingsKit";
import { useNow } from "./useNow";

type TimeWindow = "both" | "5hour" | "weekly" | "all";

const WINDOW_OPTIONS: { value: TimeWindow; label: string }[] = [
  { value: "both", label: "5-Hour & Weekly" },
  { value: "5hour", label: "5-Hour Window" },
  { value: "weekly", label: "Weekly (7 Days)" },
  { value: "all", label: "All Time" },
];

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

/** Format relative time since epoch seconds. */
function formatTimeAgo(epochSecs: number, nowMs: number): string {
  if (!epochSecs) return "Never active";
  const ms = nowMs - epochSecs * 1000;
  if (ms <= 0) return "Just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  return `${weeks}w ago`;
}

interface ModelItem {
  agent: string;
  model: string;
  displayName: string;
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
  models: ModelItem[];
}

export function UsageSection() {
  const machine = useEgant((s) => s.snapshot?.machineName ?? "Local device");
  const agents = useEgant((s) => s.agents);
  const verifyAgents = useEgant((s) => s.verifyAgents);
  const claudeUsage = useEgant((s) => s.claudeUsage);
  const fetchClaudeUsage = useEgant((s) => s.fetchClaudeUsage);
  const opencodeUsage = useEgant((s) => s.opencodeUsage);
  const fetchOpencodeUsage = useEgant((s) => s.fetchOpencodeUsage);

  const [activity, setActivity] = useState<TokenActivity | null>(null);
  const [catalogModels, setCatalogModels] = useState<AgentModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [windowMode, setWindowMode] = usePersistentState<TimeWindow>("egant.usage.windowMode", "both");
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
        fetchOpencodeUsage().catch(() => null),
        verifyAgents().catch(() => null),
      ]);

      if (act) {
        setActivity(act);
      }

      // Also collect registered models from active agents so models with 0 turns appear
      const agentIds = ["claude", "codex", "opencode", "antigravity"];
      const allModPromises = agentIds.map((id) =>
        api.listModels(id).catch(() => [] as AgentModel[]),
      );
      const modLists = await Promise.all(allModPromises);
      const mergedModels: AgentModel[] = [];
      const seenIds = new Set<string>();
      for (const list of modLists) {
        for (const m of list) {
          if (!seenIds.has(m.id)) {
            seenIds.add(m.id);
            mergedModels.push(m);
          }
        }
      }
      setCatalogModels(mergedModels);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [fetchClaudeUsage, fetchOpencodeUsage, verifyAgents]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Build provider sections and model rows
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
          models: [],
        };
        sectionsMap.set(provId, sec);
      }
      return sec;
    };

    // Pre-populate standard providers so they always have dedicated tabs/cards
    getOrCreateSection("anthropic", "Anthropic / Claude", "claude", "claude");
    getOrCreateSection("openai", "OpenAI / Codex", "openai", "codex");
    getOrCreateSection("google", "Google / Antigravity", "google", "antigravity");
    getOrCreateSection("opencode", "OpenCode", "opencode", "opencode");

    // Add stats from token activity logs
    const statsList = activity?.modelStats ?? [];
    const seenModelKeys = new Set<string>();

    const normKey = (agent: string, model: string) => {
      const cleanModel = model.replace(/^opencode\//i, "").toLowerCase();
      return `${agent.toLowerCase()}:${cleanModel}`;
    };

    for (const stat of statsList) {
      const group = providerGroupFor(stat.agent, stat.model);
      const sec = getOrCreateSection(group.id, group.name, group.vendor, stat.agent);

      sec.fiveHourTokens += stat.fiveHourTokens;
      sec.weeklyTokens += stat.weeklyTokens;
      sec.allTimeTokens += stat.allTimeTokens;
      sec.fiveHourTurns += stat.fiveHourTurns;
      sec.weeklyTurns += stat.weeklyTurns;

      const isSonnet = stat.model.toLowerCase().includes("sonnet");
      const isClaude = group.id === "anthropic" || stat.model.toLowerCase().includes("claude");
      seenModelKeys.add(normKey(stat.agent, stat.model));

      sec.models.push({
        agent: stat.agent,
        model: stat.model,
        displayName: formatModelTitle(stat.model),
        contextWindow: 0, // will check catalog below
        stats: stat,
        isSonnet,
        isClaude,
      });
    }

    // Merge in catalog models if not already seen
    for (const cm of catalogModels) {
      const group = providerGroupFor(cm.provider, cm.id);
      const sec = getOrCreateSection(group.id, group.name, group.vendor, cm.provider);
      const key = normKey(cm.provider, cm.id);
      if (!seenModelKeys.has(key)) {
        seenModelKeys.add(key);
        const isSonnet = cm.id.toLowerCase().includes("sonnet") || cm.name.toLowerCase().includes("sonnet");
        const isClaude = group.id === "anthropic" || cm.id.toLowerCase().includes("claude");
        sec.models.push({
          agent: cm.provider,
          model: cm.id,
          displayName: cm.name || formatModelTitle(cm.id),
          contextWindow: cm.maxContext || cm.context || 0,
          stats: undefined,
          isSonnet,
          isClaude,
        });
      } else {
        // Update context window
        const found = sec.models.find((m) => normKey(m.agent, m.model) === key);
        if (found) {
          found.contextWindow = cm.maxContext || cm.context || 0;
          if (cm.name && cm.name !== cm.id) {
            found.displayName = cm.name;
          }
          found.model = cm.id;
        }
      }
    }

    // Sort models inside each provider by weekly tokens, then 5h tokens, then display name
    for (const sec of sectionsMap.values()) {
      sec.models.sort((a, b) => {
        const aWeek = a.stats?.weeklyTokens ?? 0;
        const bWeek = b.stats?.weeklyTokens ?? 0;
        if (bWeek !== aWeek) return bWeek - aWeek;
        const a5h = a.stats?.fiveHourTokens ?? 0;
        const b5h = b.stats?.fiveHourTokens ?? 0;
        if (b5h !== a5h) return b5h - a5h;
        return a.displayName.localeCompare(b.displayName);
      });
    }

    return Array.from(sectionsMap.values()).filter(
      (sec) => sec.models.length > 0 || sec.connected || sec.weeklyTokens > 0,
    );
  }, [activity, catalogModels, agents]);

  // Overall totals across providers
  const overall = useMemo(() => {
    let fiveHourTokens = 0;
    let weeklyTokens = 0;
    let allTimeTokens = 0;
    let activeModelsCount = 0;

    for (const sec of providerSections) {
      fiveHourTokens += sec.fiveHourTokens;
      weeklyTokens += sec.weeklyTokens;
      allTimeTokens += sec.allTimeTokens;
      for (const m of sec.models) {
        if ((m.stats?.weeklyTokens ?? 0) > 0 || (m.stats?.fiveHourTokens ?? 0) > 0) {
          activeModelsCount++;
        }
      }
    }

    return { fiveHourTokens, weeklyTokens, allTimeTokens, activeModelsCount };
  }, [providerSections]);

  // Filter sections by provider & query
  const filteredSections = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providerSections
      .filter((sec) => providerFilter === "all" || sec.id === providerFilter)
      .map((sec) => {
        if (!q) return sec;
        const filteredModels = sec.models.filter(
          (m) =>
            m.model.toLowerCase().includes(q) ||
            m.displayName.toLowerCase().includes(q) ||
            sec.name.toLowerCase().includes(q),
        );
        return { ...sec, models: filteredModels };
      })
      .filter((sec) => sec.models.length > 0 || !q);
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
        count={`${overall.activeModelsCount} active`}
        sub="Rolling 5-hour session windows, weekly quotas, and per-model token breakdown by provider."
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

      {/* Overview Stat Cards */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard
          icon={<Clock size={16} className="text-[var(--accent)]" />}
          title="5-Hour Session Window"
          value={formatTokens(overall.fiveHourTokens)}
          sub="tokens consumed in the rolling 5h window"
          highlight={overall.fiveHourTokens > 0}
        />
        <SummaryCard
          icon={<Flame size={16} className="text-[#e8835a]" />}
          title="Weekly Volume (7 Days)"
          value={formatTokens(overall.weeklyTokens)}
          sub="tokens consumed in the last 7 days"
          highlight={overall.weeklyTokens > 0}
        />
        <SummaryCard
          icon={<Gauge size={16} className="text-[#5b8def]" />}
          title={providerFilter === "opencode" ? "OpenCode Quota Status" : "Claude Plan Limits"}
          value={
            providerFilter === "opencode"
              ? opencodeUsage?.freeLimitReached
                ? "Rate Limited"
                : opencodeUsage?.hasAuth
                ? "Account Active"
                : "Free Tier Active"
              : claudeUsage?.fiveHour
              ? `${roundPercent(claudeUsage.fiveHour)}% 5h limit`
              : "No plan quota"
          }
          sub={
            providerFilter === "opencode"
              ? opencodeUsage?.freeLimitReached
                ? "Free tier limit reached"
                : opencodeUsage?.hasAuth
                ? "Configured provider credentials"
                : "OpenCode Zen free models"
              : claudeUsage?.sevenDay
              ? `${roundPercent(claudeUsage.sevenDay)}% weekly limit`
              : "Read from Claude OAuth"
          }
          highlight={
            providerFilter === "opencode"
              ? Boolean(opencodeUsage?.installed)
              : Boolean(claudeUsage?.fiveHour)
          }
        />
      </div>

      {/* Control bar: Window toggle & Provider filter & Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <Pills
            options={WINDOW_OPTIONS}
            value={windowMode}
            onChange={(val) => setWindowMode(val)}
          />
          <div className="h-4 w-px bg-[var(--border)]" />
          <Pills
            options={providerFilterOptions}
            value={providerFilter}
            onChange={(val) => setProviderFilter(val)}
          />
        </div>

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

      {/* Provider Sections */}
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
        filteredSections.map((sec) => (
          <ProviderUsageCard
            key={sec.id}
            section={sec}
            windowMode={windowMode}
            claudeUsage={sec.id === "anthropic" ? claudeUsage : null}
            opencodeUsage={sec.id === "opencode" ? opencodeUsage : null}
            now={now}
          />
        ))
      )}
    </div>
  );
}

function SummaryCard({
  icon,
  title,
  value,
  sub,
  highlight,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-xl border bg-[var(--card)] p-4 transition-colors ${
        highlight ? "border-[var(--border)]" : "border-[var(--border)] opacity-85"
      }`}
    >
      <div className="flex items-center gap-2 text-[12px] font-medium text-[var(--muted)]">
        {icon}
        <span>{title}</span>
      </div>
      <div className="mt-2 text-[22px] font-semibold tracking-tight text-[var(--ink)]">
        {value}
      </div>
      <div className="mt-1 text-[11px] text-[var(--faint)]">{sub}</div>
    </div>
  );
}

function ProviderUsageCard({
  section,
  windowMode,
  claudeUsage,
  opencodeUsage,
  now,
}: {
  section: ProviderSectionData;
  windowMode: TimeWindow;
  claudeUsage: ClaudeUsage | null;
  opencodeUsage: OpencodeUsageStats | null;
  now: number;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xs">
      {/* Provider Header */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--raised)]/40 px-4 py-3.5">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderLogo provider={section.vendor} size={30} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[14px] text-[var(--ink)] truncate">
                {section.name}
              </span>
              {section.connected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface)] px-2 py-0.5 text-[10px] font-medium text-emerald-500">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Connected
                </span>
              )}
            </div>
            <div className="text-[11px] text-[var(--faint)]">
              {section.models.length} {section.models.length === 1 ? "model" : "models"} configured
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-3 text-[12px]">
            <div className="text-right">
              <span className="block font-semibold text-[var(--ink)] tabular-nums">
                {formatTokens(section.fiveHourTokens)}
              </span>
              <span className="block text-[10px] text-[var(--faint)]">5h rolling</span>
            </div>
            <div className="h-5 w-px bg-[var(--border)]" />
            <div className="text-right">
              <span className="block font-semibold text-[var(--ink)] tabular-nums">
                {formatTokens(section.weeklyTokens)}
              </span>
              <span className="block text-[10px] text-[var(--faint)]">7-day volume</span>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] cursor-pointer"
            aria-label="Toggle section"
          >
            <ChevronDown
              size={15}
              className={`transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
            />
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="p-4 space-y-4">
          {/* Provider Quota limits (e.g. Anthropic 5-hour and Weekly plan limits) */}
          {claudeUsage && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/50 p-3.5">
              <div className="mb-2.5 flex items-center justify-between">
                <span className="text-[12px] font-medium text-[var(--ink)]">
                  Account Plan Quotas
                </span>
                <span className="text-[11px] text-[var(--faint)]">
                  Direct from Anthropic OAuth
                </span>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                {claudeUsage.fiveHour ? (
                  <LimitGauge
                    label="5-Hour Plan Limit"
                    percent={roundPercent(claudeUsage.fiveHour)}
                    resetsAt={claudeUsage.fiveHour.resetsAt}
                    now={now}
                  />
                ) : (
                  <div className="text-[11px] text-[var(--faint)]">5h limit unavailable</div>
                )}
                {claudeUsage.sevenDay ? (
                  <LimitGauge
                    label="Weekly Limit (All Models)"
                    percent={roundPercent(claudeUsage.sevenDay)}
                    resetsAt={claudeUsage.sevenDay.resetsAt}
                    now={now}
                  />
                ) : (
                  <div className="text-[11px] text-[var(--faint)]">Weekly limit unavailable</div>
                )}
                {claudeUsage.sevenDaySonnet ? (
                  <LimitGauge
                    label="Weekly Limit (Sonnet Quota)"
                    percent={roundPercent(claudeUsage.sevenDaySonnet)}
                    resetsAt={claudeUsage.sevenDaySonnet.resetsAt}
                    now={now}
                  />
                ) : (
                  <div className="text-[11px] text-[var(--faint)]">
                    No dedicated Sonnet quota
                  </div>
                )}
              </div>
            </div>
          )}

          {/* OpenCode Usage & Quota Dashboard */}
          {section.id === "opencode" && opencodeUsage && (
            <OpencodeUsageDashboard stats={opencodeUsage} />
          )}

          {/* Model cards */}
          <div className="space-y-2.5">
            {section.models.map((item) => (
              <ModelUsageCard
                key={`${item.agent}:${item.model}`}
                item={item}
                windowMode={windowMode}
                claudeUsage={claudeUsage}
                now={now}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function OpencodeUsageDashboard({ stats }: { stats: OpencodeUsageStats }) {
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
    <div className="space-y-3">
      {/* Status banner */}
      {stats.freeLimitReached ? (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
          <div className="flex items-start gap-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/20 text-rose-500">
              <AlertTriangle size={17} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-semibold text-[13px] text-rose-500">
                  OpenCode Free Usage Limit Reached
                </span>
                <span className="rounded-md bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-400">
                  Rate Limited
                </span>
              </div>
              <p className="mt-1 text-[12px] text-[var(--muted)] leading-relaxed">
                OpenCode Zen&apos;s shared free tier quota has been exhausted on this device/network.
                Requests will fail with <code className="rounded bg-[var(--surface)] px-1 py-0.5 font-mono text-[11px] text-rose-400">AI_APICallError: Free usage limit reached</code> until the quota resets.
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2.5">
                <button
                  type="button"
                  onClick={handleConnect}
                  disabled={connecting}
                  className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50"
                >
                  <Terminal size={13} />
                  {connecting ? "Opening Terminal…" : "Add Account / Provider (opencode auth login)"}
                </button>
                <a
                  href="https://opencode.ai/go"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] text-[var(--muted)] hover:text-[var(--ink)] hover:underline"
                >
                  Learn about OpenCode Go →
                </a>
              </div>
            </div>
          </div>
        </div>
      ) : stats.hasAuth ? (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3.5">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 size={16} className="text-emerald-500 shrink-0" />
            <div className="text-[12px] text-[var(--ink)]">
              <span className="font-medium text-emerald-400">Provider Account Connected:</span>{" "}
              <span className="text-[var(--muted)]">
                API requests are authenticated with your configured provider credentials and not limited to the shared free quota.
              </span>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)]/50 p-3.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-medium text-[var(--ink)]">
                OpenCode Zen Free Tier Active
              </span>
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400">
                Ready
              </span>
            </div>
            <span className="text-[11px] text-[var(--faint)]">
              Community free models (no login required)
            </span>
          </div>
        </div>
      )}

      {/* 4 Stat Cards */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/50 p-3">
          <div className="text-[11px] font-medium text-[var(--faint)]">Total Sessions</div>
          <div className="mt-1 text-[18px] font-semibold text-[var(--ink)] tabular-nums">
            {stats.totalSessions.toLocaleString()}
          </div>
          <div className="text-[10px] text-[var(--faint)]">across {stats.daysSpan} days</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/50 p-3">
          <div className="text-[11px] font-medium text-[var(--faint)]">Total Messages</div>
          <div className="mt-1 text-[18px] font-semibold text-[var(--ink)] tabular-nums">
            {stats.totalMessages.toLocaleString()}
          </div>
          <div className="text-[10px] text-[var(--faint)]">in local database</div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/50 p-3">
          <div className="text-[11px] font-medium text-[var(--faint)]">Lifetime Volume</div>
          <div className="mt-1 text-[18px] font-semibold text-[var(--ink)] tabular-nums">
            {formatTokens(stats.totalTokens)}
          </div>
          <div className="text-[10px] text-[var(--faint)]">
            {formatTokens(stats.tokensInput)} in / {formatTokens(stats.tokensOutput)} out
          </div>
        </div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/50 p-3">
          <div className="text-[11px] font-medium text-[var(--faint)]">Total Cost</div>
          <div className="mt-1 text-[18px] font-semibold text-[var(--ink)] tabular-nums">
            ${stats.totalCost.toFixed(2)}
          </div>
          <div className="text-[10px] text-[var(--faint)]">Free community tier</div>
        </div>
      </div>

      {/* Tool usage stats */}
      {stats.topTools.length > 0 && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)]/30 p-3.5">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-[var(--ink)]">
              <Wrench size={14} className="text-[var(--accent)]" />
              <span>Tool Usage Breakdown</span>
            </div>
            <span className="text-[11px] text-[var(--faint)]">Top tools invoked by OpenCode</span>
          </div>
          <div className="space-y-2">
            {stats.topTools.map((tool) => (
              <div key={tool.name} className="flex items-center gap-3 text-[12px]">
                <span className="w-28 shrink-0 font-mono text-[11px] text-[var(--ink)] truncate">
                  {tool.name}
                </span>
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--border)]">
                  <div
                    className="h-full rounded-full bg-[var(--accent)] transition-all duration-300"
                    style={{ width: `${Math.max(2, tool.percentage)}%` }}
                  />
                </div>
                <span className="w-32 shrink-0 text-right text-[11px] text-[var(--muted)] tabular-nums">
                  {tool.count.toLocaleString()} calls ({tool.percentage.toFixed(1)}%)
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LimitGauge({
  label,
  percent,
  resetsAt,
  now,
}: {
  label: string;
  percent: number;
  resetsAt: string | null;
  now: number;
}) {
  const critical = isUsageCritical(percent);
  const resetLabel = formatResetIn(resetsAt, now);

  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--card)] p-2.5">
      <div className="flex items-baseline justify-between gap-1">
        <span className="text-[11px] font-medium text-[var(--muted)]">{label}</span>
        <span
          className={`text-[12px] font-semibold tabular-nums ${
            critical ? "text-[var(--danger)]" : "text-[var(--ink)]"
          }`}
        >
          {percent}%
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
        <div
          className={`h-full rounded-full transition-all duration-300 ${
            critical ? "bg-[var(--danger)]" : "bg-[var(--accent)]"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {resetLabel && (
        <div className="mt-1 text-[10px] text-[var(--faint)]">{resetLabel}</div>
      )}
    </div>
  );
}

function ModelUsageCard({
  item,
  windowMode,
  claudeUsage,
  now,
}: {
  item: ModelItem;
  windowMode: TimeWindow;
  claudeUsage: ClaudeUsage | null;
  now: number;
}) {
  const stat = item.stats;
  const fiveHourTokens = stat?.fiveHourTokens ?? 0;
  const weeklyTokens = stat?.weeklyTokens ?? 0;
  const allTimeTokens = stat?.allTimeTokens ?? 0;
  const lastActiveText = stat?.lastUsedAt
    ? formatTimeAgo(stat.lastUsedAt, now)
    : "No logged turns";

  // Check if model links to Claude plan quotas
  const fiveHourLimit = item.isClaude && claudeUsage?.fiveHour ? claudeUsage.fiveHour : null;
  const weeklyLimit = item.isSonnet && claudeUsage?.sevenDaySonnet
    ? claudeUsage.sevenDaySonnet
    : item.isClaude && claudeUsage?.sevenDay
      ? claudeUsage.sevenDay
      : null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-3 hover:border-[var(--accent)]/40 transition-colors">
      {/* Model Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)]/60 pb-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-[var(--ink)] truncate">
              {item.displayName}
            </span>
            <span className="font-mono text-[11px] text-[var(--faint)] truncate">
              {item.model}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {item.contextWindow > 0 && (
            <span className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[11px] text-[var(--muted)] tabular-nums">
              {formatTokens(item.contextWindow)} window
            </span>
          )}
          <span className="rounded-md bg-[var(--bubble)] px-2 py-0.5 text-[10px] text-[var(--faint)]">
            {lastActiveText}
          </span>
        </div>
      </div>

      {/* Usage Windows */}
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* 5-Hour Usage Box */}
        {(windowMode === "both" || windowMode === "5hour") && (
          <div className="rounded-md border border-[var(--border)]/70 bg-[var(--surface)]/30 p-2.5">
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--muted)]">
                <Clock size={12} className="text-[var(--accent)]" />
                5-Hour Usage
              </span>
              <span className="text-[12px] font-semibold text-[var(--ink)] tabular-nums">
                {formatTokens(fiveHourTokens)}
              </span>
            </div>

            <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--faint)]">
              <span>{stat?.fiveHourTurns ?? 0} turns</span>
              {fiveHourTokens > 0 && (
                <span title={`${fiveHourTokens.toLocaleString()} tokens`}>
                  In: {formatTokens(stat?.fiveHourInput ?? 0)} · Out: {formatTokens(stat?.fiveHourOutput ?? 0)} · Cache: {formatTokens(stat?.fiveHourCache ?? 0)}
                </span>
              )}
            </div>

            {fiveHourLimit && (
              <div className="mt-2.5 pt-2 border-t border-[var(--border)]/50">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-[var(--faint)]">5h quota limit</span>
                  <span className="font-medium text-[var(--ink)] tabular-nums">
                    {roundPercent(fiveHourLimit)}%
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
                  <div
                    className={`h-full rounded-full ${
                      isUsageCritical(roundPercent(fiveHourLimit))
                        ? "bg-[var(--danger)]"
                        : "bg-[var(--accent)]"
                    }`}
                    style={{ width: `${roundPercent(fiveHourLimit)}%` }}
                  />
                </div>
                {fiveHourLimit.resetsAt && (
                  <div className="mt-0.5 text-[9px] text-[var(--faint)]">
                    {formatResetIn(fiveHourLimit.resetsAt, now)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Weekly Usage Box */}
        {(windowMode === "both" || windowMode === "weekly") && (
          <div className="rounded-md border border-[var(--border)]/70 bg-[var(--surface)]/30 p-2.5">
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--muted)]">
                <Flame size={12} className="text-[#e8835a]" />
                Weekly Usage (7d)
              </span>
              <span className="text-[12px] font-semibold text-[var(--ink)] tabular-nums">
                {formatTokens(weeklyTokens)}
              </span>
            </div>

            <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--faint)]">
              <span>{stat?.weeklyTurns ?? 0} turns</span>
              {weeklyTokens > 0 && (
                <span title={`${weeklyTokens.toLocaleString()} tokens`}>
                  In: {formatTokens(stat?.weeklyInput ?? 0)} · Out: {formatTokens(stat?.weeklyOutput ?? 0)} · Cache: {formatTokens(stat?.weeklyCache ?? 0)}
                </span>
              )}
            </div>

            {weeklyLimit && (
              <div className="mt-2.5 pt-2 border-t border-[var(--border)]/50">
                <div className="flex items-center justify-between text-[10px]">
                  <span className="text-[var(--faint)]">
                    {item.isSonnet ? "Sonnet weekly quota" : "Weekly quota limit"}
                  </span>
                  <span className="font-medium text-[var(--ink)] tabular-nums">
                    {roundPercent(weeklyLimit)}%
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
                  <div
                    className={`h-full rounded-full ${
                      isUsageCritical(roundPercent(weeklyLimit))
                        ? "bg-[var(--danger)]"
                        : "bg-[#e8835a]"
                    }`}
                    style={{ width: `${roundPercent(weeklyLimit)}%` }}
                  />
                </div>
                {weeklyLimit.resetsAt && (
                  <div className="mt-0.5 text-[9px] text-[var(--faint)]">
                    {formatResetIn(weeklyLimit.resetsAt, now)}
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* All-Time stats when selected */}
        {windowMode === "all" && (
          <div className="rounded-md border border-[var(--border)]/70 bg-[var(--surface)]/30 p-2.5 col-span-2">
            <div className="flex items-baseline justify-between">
              <span className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--muted)]">
                <Layers size={12} className="text-[var(--muted)]" />
                All-Time Token Activity
              </span>
              <span className="text-[12px] font-semibold text-[var(--ink)] tabular-nums">
                {formatTokens(allTimeTokens)}
              </span>
            </div>
            <div className="mt-1 flex items-center justify-between text-[11px] text-[var(--faint)]">
              <span>{stat?.allTimeTurns ?? 0} lifetime turns</span>
              <span title={`${allTimeTokens.toLocaleString()} tokens`}>
                In: {formatTokens(stat?.allTimeInput ?? 0)} · Out: {formatTokens(stat?.allTimeOutput ?? 0)} · Cache: {formatTokens(stat?.allTimeCache ?? 0)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
