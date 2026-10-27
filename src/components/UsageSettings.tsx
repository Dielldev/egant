import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  Terminal,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AGENT_ACCENT, AGENT_PROVIDER, fallbackName } from "../lib/agents";
import { api } from "../lib/api";
import { log } from "../lib/logger";
import type { ClaudeUsage, ModelUsageStat, OpencodeUsageStats, TokenActivity } from "../lib/types";
import { formatResetIn, isUsageCritical, roundPercent } from "../lib/usageLimits";
import { useEgant } from "../store";
import { BRAND_COLORS, ProviderLogo } from "./ProviderLogo";
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
  turns?: number;
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
  }, [fetchClaudeUsage, fetchOpencodeUsage, verifyAgents]);

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

    // Compute fallback reset if needed
    for (const sec of sectionsMap.values()) {
      if (sec.fiveHourTokens > 0 && !sec.fiveHourResetsAt && sec.lastUsedAt) {
        sec.fiveHourResetsAt = sec.lastUsedAt + 5 * 3600;
      }
    }

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
  opencodeUsage,
  now,
}: {
  section: ProviderSectionData;
  claudeUsage: ClaudeUsage | null;
  opencodeUsage: OpencodeUsageStats | null;
  now: number;
}) {
  const brandColor =
    BRAND_COLORS[section.vendor.toLowerCase()] ??
    BRAND_COLORS[section.id.toLowerCase()] ??
    AGENT_ACCENT[section.agentId] ??
    "var(--accent)";

  // Derive the main models & quotas for this provider in PERCENTAGE
  const quotas: MainModelQuota[] = useMemo(() => {
    const list: MainModelQuota[] = [];

    // Anthropic: Direct from Claude OAuth Plan Limits
    if (section.id === "anthropic") {
      if (claudeUsage) {
        if (claudeUsage.fiveHour) {
          list.push({
            key: "five-hour",
            name: "Session Limit (5-Hour Window)",
            percent: roundPercent(claudeUsage.fiveHour),
            resetsAt: claudeUsage.fiveHour.resetsAt,
            statusText: "Rolling 5-hour session window",
          });
        }
        if (claudeUsage.sevenDaySonnet) {
          list.push({
            key: "sonnet-weekly",
            name: "Claude 3.7 Sonnet (Weekly Quota)",
            percent: roundPercent(claudeUsage.sevenDaySonnet),
            resetsAt: claudeUsage.sevenDaySonnet.resetsAt,
            statusText: "Weekly dedicated Sonnet allocation",
          });
        }
        if (claudeUsage.sevenDay) {
          list.push({
            key: "seven-day",
            name: "Weekly Limit (All Models)",
            percent: roundPercent(claudeUsage.sevenDay),
            resetsAt: claudeUsage.sevenDay.resetsAt,
            statusText: "7-day account-wide plan quota",
          });
        }
      }

      // If no official OAuth quota (or empty), fallback to main models from activity
      if (list.length === 0) {
        const activeModels = section.models.filter(
          (m) => m.stats && (m.stats.fiveHourTokens > 0 || m.stats.weeklyTokens > 0),
        );
        if (activeModels.length > 0) {
          for (const m of activeModels) {
            const data = m.stats!;
            const pct = data.fiveHourTokens > 0
              ? Math.min(100, Math.max(5, Math.round((data.fiveHourTokens / 1_000_000) * 100)))
              : 0;
            list.push({
              key: m.model,
              name: m.displayName,
              percent: pct,
              resetsAt: data.fiveHourResetsAt ?? null,
              statusText: data.fiveHourTurns > 0 ? `${data.fiveHourTurns} turns in window` : undefined,
              turns: data.fiveHourTurns,
            });
          }
        } else {
          list.push({
            key: "claude-session",
            name: "Claude 3.7 Sonnet (Session Window)",
            percent: 0,
            resetsAt: null,
            statusText: undefined,
          });
        }
      }
      return list;
    }

    // Google / Antigravity: Group effort variants into base main models
    if (section.id === "google") {
      const baseMap = new Map<string, {
        fiveHourTokens: number;
        fiveHourTurns: number;
        resetsAt: number | null;
      }>();

      for (const m of section.models) {
        if (!m.stats || (m.stats.fiveHourTokens === 0 && m.stats.weeklyTokens === 0)) {
          continue;
        }
        const base = m.baseName || "Gemini 3.8 Flash";
        const entry = baseMap.get(base) ?? { fiveHourTokens: 0, fiveHourTurns: 0, resetsAt: null };
        entry.fiveHourTokens += m.stats.fiveHourTokens;
        entry.fiveHourTurns += m.stats.fiveHourTurns;
        if (m.stats.fiveHourResetsAt) {
          entry.resetsAt = Math.max(entry.resetsAt ?? 0, m.stats.fiveHourResetsAt);
        } else if (m.stats.lastUsedAt && m.stats.fiveHourTokens > 0) {
          entry.resetsAt = Math.max(entry.resetsAt ?? 0, m.stats.lastUsedAt + 5 * 3600);
        }
        baseMap.set(base, entry);
      }

      if (baseMap.size === 0) {
        baseMap.set("Gemini 3.8 Flash", { fiveHourTokens: 0, fiveHourTurns: 0, resetsAt: null });
      }

      for (const [base, data] of baseMap.entries()) {
        const pct = data.fiveHourTokens > 0
          ? Math.min(100, Math.max(5, Math.round((data.fiveHourTokens / 1_000_000) * 100)))
          : 0;
        list.push({
          key: base,
          name: base,
          percent: pct,
          resetsAt: data.resetsAt,
          statusText: data.fiveHourTurns > 0 ? `${data.fiveHourTurns} turns in window` : undefined,
          turns: data.fiveHourTurns,
        });
      }
      return list;
    }

    // OpenAI / Codex: Main models
    if (section.id === "openai") {
      const baseMap = new Map<string, {
        fiveHourTokens: number;
        fiveHourTurns: number;
        resetsAt: number | null;
      }>();

      for (const m of section.models) {
        if (!m.stats || (m.stats.fiveHourTokens === 0 && m.stats.weeklyTokens === 0)) {
          continue;
        }
        const base = m.baseName || "Codex / GPT-5.6";
        const entry = baseMap.get(base) ?? { fiveHourTokens: 0, fiveHourTurns: 0, resetsAt: null };
        entry.fiveHourTokens += m.stats.fiveHourTokens;
        entry.fiveHourTurns += m.stats.fiveHourTurns;
        if (m.stats.fiveHourResetsAt) {
          entry.resetsAt = Math.max(entry.resetsAt ?? 0, m.stats.fiveHourResetsAt);
        } else if (m.stats.lastUsedAt && m.stats.fiveHourTokens > 0) {
          entry.resetsAt = Math.max(entry.resetsAt ?? 0, m.stats.lastUsedAt + 5 * 3600);
        }
        baseMap.set(base, entry);
      }

      if (baseMap.size === 0) {
        baseMap.set("Codex / GPT-5.6", { fiveHourTokens: 0, fiveHourTurns: 0, resetsAt: null });
      }

      for (const [base, data] of baseMap.entries()) {
        const pct = data.fiveHourTokens > 0
          ? Math.min(100, Math.max(5, Math.round((data.fiveHourTokens / 1_000_000) * 100)))
          : 0;
        list.push({
          key: base,
          name: base,
          percent: pct,
          resetsAt: data.resetsAt,
          statusText: data.fiveHourTurns > 0 ? `${data.fiveHourTurns} turns in window` : undefined,
          turns: data.fiveHourTurns,
        });
      }
      return list;
    }

    // OpenCode: Free tier and auth quota
    if (section.id === "opencode") {
      if (opencodeUsage?.freeLimitReached) {
        list.push({
          key: "opencode-zen",
          name: "OpenCode Zen (Free Tier Quota)",
          percent: 100,
          resetsAt: null,
          statusBadge: "Rate Limited",
          statusText: "Free community quota reached on this network",
        });
      } else if (opencodeUsage?.hasAuth) {
        list.push({
          key: "opencode-auth",
          name: "OpenCode (Configured Provider)",
          percent: 0,
          resetsAt: null,
          statusBadge: "Active",
          statusText: "Authenticated with provider credentials",
        });
      } else {
        list.push({
          key: "opencode-zen",
          name: "OpenCode Zen (Community Models)",
          percent: 0,
          resetsAt: null,
          statusBadge: "Ready",
          statusText: "Free community tier ready",
        });
      }
      return list;
    }

    // Generic fallback for any other provider
    const pct = section.fiveHourTokens > 0
      ? Math.min(100, Math.max(5, Math.round((section.fiveHourTokens / 1_000_000) * 100)))
      : 0;
    list.push({
      key: section.id,
      name: `${section.name} (Session Window)`,
      percent: pct,
      resetsAt: section.fiveHourResetsAt,
      statusText: section.fiveHourTurns > 0 ? `${section.fiveHourTurns} turns in window` : undefined,
      turns: section.fiveHourTurns,
    });
    return list;
  }, [section, claudeUsage, opencodeUsage]);

  // Primary percentage to show in provider header badge
  const maxPercent = useMemo(() => {
    if (quotas.length === 0) return 0;
    return Math.max(...quotas.map((q) => q.percent));
  }, [quotas]);

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)] shadow-xs">
      {/* Provider Header with Vivid Brand Logo */}
      <div className="flex items-center justify-between border-b border-[var(--border)] bg-[var(--surface)] px-4 py-3.5">
        <div className="flex items-center gap-3 min-w-0">
          <ProviderLogo provider={section.vendor} size={30} color={brandColor} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-semibold text-[14px] text-[var(--ink)] truncate">
                {section.name}
              </span>
              {section.connected && (
                <span className="inline-flex items-center gap-1 rounded-full bg-[var(--surface)] px-2 py-0.5 text-[10px] font-medium text-emerald-500 border border-emerald-500/20">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Connected
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-semibold tabular-nums border"
            style={{
              color: maxPercent >= 90 ? "#ef4444" : maxPercent > 0 ? brandColor : "var(--muted)",
              borderColor:
                maxPercent >= 90
                  ? "rgba(239, 68, 68, 0.3)"
                  : maxPercent > 0
                  ? `color-mix(in srgb, ${brandColor} 30%, var(--border))`
                  : "var(--border)",
              backgroundColor: "var(--card)",
            }}
          >
            {maxPercent > 0 ? `${maxPercent}% used` : "0% used"}
          </span>
        </div>
      </div>

      {/* Main Models Bars — in Percentage with Brand Colors */}
      <div className="p-4 space-y-3">
        {quotas.map((q) => (
          <MainModelBar
            key={q.key}
            name={q.name}
            percent={q.percent}
            resetsAt={q.resetsAt}
            now={now}
            brandColor={brandColor}
            statusText={q.statusText}
            statusBadge={q.statusBadge}
          />
        ))}

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
  brandColor,
  statusText,
  statusBadge,
}: {
  name: string;
  percent: number;
  resetsAt?: string | number | null;
  now: number;
  brandColor: string;
  statusText?: string;
  statusBadge?: string;
}) {
  const critical = isUsageCritical(percent);
  const elevated = percent >= 60;
  const resetLabel = formatResetIn(resetsAt, now, { withClock: true });

  const barFillColor = critical ? "#ef4444" : elevated ? "#f59e0b" : brandColor;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4 transition-colors">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span
            className="h-2.5 w-2.5 rounded-full shrink-0"
            style={{ backgroundColor: barFillColor }}
          />
          <span className="font-semibold text-[13px] text-[var(--ink)] truncate">
            {name}
          </span>
          {statusBadge && (
            <span
              className="rounded-full px-2 py-0.5 text-[10px] font-semibold border"
              style={{
                color: statusBadge === "Rate Limited" ? "#ef4444" : "#10b981",
                borderColor: statusBadge === "Rate Limited" ? "rgba(239, 68, 68, 0.3)" : "rgba(16, 185, 129, 0.3)",
                backgroundColor: statusBadge === "Rate Limited" ? "rgba(239, 68, 68, 0.1)" : "rgba(16, 185, 129, 0.1)",
              }}
            >
              {statusBadge}
            </span>
          )}
        </div>

        <div className="text-right">
          <span
            className="text-[17px] font-bold tabular-nums"
            style={{ color: critical ? "#ef4444" : "var(--ink)" }}
          >
            {percent}%
          </span>
          <span className="ml-1 text-[11px] text-[var(--faint)]">used</span>
        </div>
      </div>

      {/* Progress Bar (Solid Brand Color) */}
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${Math.min(100, Math.max(percent > 0 ? 3 : 0, percent))}%`,
            backgroundColor: barFillColor,
          }}
        />
      </div>

      {/* Footer: Reset Time & Status */}
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <div>
          {resetLabel ? (
            <span className="inline-flex items-center gap-1.5 font-medium text-[var(--ink)]">
              <Clock size={12} style={{ color: brandColor }} />
              <span>{resetLabel}</span>
            </span>
          ) : percent === 0 ? (
            <span className="inline-flex items-center gap-1.5 text-emerald-500 font-medium">
              <CheckCircle2 size={12} />
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
    <div className="rounded-xl border border-rose-500/30 bg-[var(--card)] p-4">
      <div className="flex items-start gap-3">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-500">
          <AlertTriangle size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-[13px] text-rose-500">
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
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--accent)] px-3 py-1.5 text-[12px] font-medium text-[var(--accent-ink)] hover:opacity-90 disabled:opacity-50"
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
