import { RefreshCw, X } from "lucide-react";
import { useEffect } from "react";
import { useNow } from "@egant/components/useNow";
import { fallbackName } from "@egant/lib/agents";
import { contextFraction, contextWindow, formatCost, formatTokens } from "@egant/lib/transcript";
import type { SessionUsage, UsageWindow } from "@egant/lib/types";
import { formatResetIn, isUsageCritical, roundPercent } from "@egant/lib/usageLimits";
import { useMobile } from "../store";
import { useUsage } from "../usage";
import { Group } from "./Sheet";

/** Usage, as a page that rises over the app: Claude's 5-hour and weekly
 * limits as the Mac reads them, and — when a chat is open — how full that
 * chat's context window is. Codex and OpenCode report no plan quota, so their
 * chats show context alone. */
export function UsagePage() {
  const close = useMobile((s) => s.closeUsage);
  const openSession = useMobile((s) => s.openSession);
  const session = useMobile((s) => s.sessions.find((item) => item.id === openSession));
  const transcript = useMobile((s) => (openSession != null ? s.transcripts[openSession] : undefined));
  const { claude, loaded, loading, error, load } = useUsage();
  const now = useNow(30_000);

  // Fresh on opening, and again each minute while it stays open.
  useEffect(() => {
    void load(true);
    const timer = setInterval(() => void load(true), 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const hasWindows = claude != null && (claude.fiveHour || claude.sevenDay || claude.sevenDaySonnet);
  const context = transcript && transcript.usage.contextTokens > 0 ? transcript.usage : null;

  return (
    <div className="page-in fixed inset-0 z-[55] flex flex-col bg-[var(--stage)]">
      <header className="safe-top shrink-0">
        <div className="grid h-[54px] grid-cols-[52px_1fr_52px] items-center px-1">
          <button
            type="button"
            aria-label="Close usage"
            onClick={close}
            className="press ml-1 flex h-10 w-10 items-center justify-center rounded-full bg-[var(--raised)] text-[var(--ink)]"
          >
            <X size={19} strokeWidth={2.2} />
          </button>
          <div className="text-center text-[17px] font-semibold text-[var(--ink)]">Usage</div>
          <button
            type="button"
            aria-label="Refresh"
            onClick={() => void load(true)}
            className="press mr-1 flex h-10 w-10 items-center justify-center justify-self-end rounded-full text-[var(--muted)]"
          >
            <RefreshCw size={18} strokeWidth={2.1} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      <div className="safe-bottom min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-2">
        <div className="mx-auto w-full max-w-[560px]">
          {context && session && (
            <Group label="This chat" note={`${session.title} · ${fallbackName(session.agent)}`}>
              <div className="px-4 py-4">
                <ContextBlock usage={context} costUsd={transcript?.totalCostUsd ?? 0} />
              </div>
            </Group>
          )}

          <Group
            label="Claude plan limits"
            note="Read from your Mac's Claude sign-in. Codex and OpenCode don't report a plan limit."
          >
            {hasWindows ? (
              <div className="divide-y divide-[var(--hairline)]">
                {claude.fiveHour && <Limit label="5-hour limit" window={claude.fiveHour} now={now} />}
                {claude.sevenDay && <Limit label="Weekly limit" window={claude.sevenDay} now={now} />}
                {claude.sevenDaySonnet && (
                  <Limit label="Weekly · Sonnet" window={claude.sevenDaySonnet} now={now} />
                )}
              </div>
            ) : (
              <div className="px-4 py-5 text-[15px] leading-relaxed text-[var(--muted)]">
                {!loaded && !error
                  ? "Reading your usage…"
                  : error && !loaded
                    ? error
                    : claude == null
                      ? "Claude isn't signed in on your Mac, so there's no plan limit to show."
                      : "Your plan didn't report any limits."}
              </div>
            )}
          </Group>
          {error && loaded && (
            <p className="px-4 pb-6 text-center text-[13px] text-[var(--danger)]">
              Couldn't refresh — showing the last reading. {error}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** One window: how much of it is used, as a bar that grows in, and when it
 * starts over. */
function Limit({ label, window, now }: { label: string; window: UsageWindow; now: number }) {
  const percent = roundPercent(window);
  const reset = formatResetIn(window.resetsAt, now);
  return (
    <div className="px-4 py-4">
      <div className="flex items-baseline justify-between">
        <span className="text-[16px] text-[var(--ink)]">{label}</span>
        <span className="text-[16px] font-semibold tabular-nums text-[var(--ink)]">{percent}%</span>
      </div>
      <Bar percent={percent} critical={isUsageCritical(percent)} />
      {reset && <div className="mt-2 text-[13px] text-[var(--muted)]">{reset[0]!.toUpperCase() + reset.slice(1)}</div>}
    </div>
  );
}

function ContextBlock({ usage, costUsd }: { usage: SessionUsage; costUsd: number }) {
  const fraction = contextFraction(usage);
  const percent = Math.max(1, Math.round(fraction * 100));
  return (
    <>
      <div className="flex items-baseline justify-between">
        <span className="text-[16px] text-[var(--ink)]">Context window</span>
        <span className="text-[16px] font-semibold tabular-nums text-[var(--ink)]">{percent}%</span>
      </div>
      <Bar percent={percent} critical={fraction >= 0.9} />
      <div className="mt-2 flex justify-between text-[13px] text-[var(--muted)]">
        <span>
          {formatTokens(usage.contextTokens)} of {formatTokens(contextWindow(usage))} tokens
        </span>
        {costUsd > 0 && <span>{formatCost(costUsd)} so far</span>}
      </div>
      <div className="mt-1 text-[13px] text-[var(--faint)]">
        {formatTokens(usage.totalTokens)} tokens over {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
      </div>
    </>
  );
}

function Bar({ percent, critical }: { percent: number; critical: boolean }) {
  return (
    <div className="mt-2.5 h-2 w-full overflow-hidden rounded-full bg-[var(--bubble)]">
      <div
        className={`bar-grow h-full rounded-full ${critical ? "bg-[var(--danger)]" : "bg-[var(--ink)]"}`}
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

/** The one-line reading above a chat's composer: the context window's share
 * and, for Claude, the tighter of its plan limits. A tap opens the page. */
export function UsageStrip({
  agent,
  usage,
}: {
  agent: string;
  usage: SessionUsage;
}) {
  const openUsage = useMobile((s) => s.openUsage);
  const claude = useUsage((s) => s.claude);
  const load = useUsage((s) => s.load);
  useEffect(() => {
    if (agent === "claude") void load();
  }, [agent, load]);

  const hasContext = usage.contextTokens > 0;
  const limits = agent === "claude" && claude ? [claude.fiveHour, claude.sevenDay] : [];
  const worst = limits.reduce<UsageWindow | null>(
    (best, window) => (window && (!best || window.usedPercent > best.usedPercent) ? window : best),
    null,
  );
  if (!hasContext && !worst) return null;

  const contextPercent = hasContext ? Math.max(1, Math.round(contextFraction(usage) * 100)) : null;
  const fiveHour = claude?.fiveHour;
  return (
    <button
      type="button"
      onClick={openUsage}
      className="press fade-up mx-auto mb-1.5 flex h-7 items-center gap-2 rounded-full px-3 text-[12.5px] text-[var(--muted)] active:bg-[var(--hover)]"
    >
      {hasContext && contextPercent != null && (
        <span className="flex items-center gap-1.5 tabular-nums">
          <Ring percent={contextPercent} />
          {formatTokens(usage.contextTokens)} / {formatTokens(contextWindow(usage))} context
        </span>
      )}
      {hasContext && worst && <span className="text-[var(--faint)]">·</span>}
      {worst && (
        <span className="tabular-nums">
          {fiveHour && worst === fiveHour ? "5h" : "Week"} {roundPercent(worst)}%
        </span>
      )}
    </button>
  );
}

function Ring({ percent }: { percent: number }) {
  const radius = 5;
  const circumference = 2 * Math.PI * radius;
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" className="shrink-0" aria-hidden>
      <circle cx="6.5" cy="6.5" r={radius} fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.3" />
      <circle
        cx="6.5"
        cy="6.5"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={`${((percent / 100) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
        transform="rotate(-90 6.5 6.5)"
      />
    </svg>
  );
}
