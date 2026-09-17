import { useEffect, useRef, useState } from "react";
import { shouldOpenLeftward, shouldOpenUpward } from "../lib/popover";
import {
  contextFraction,
  contextWindow,
  formatCost,
  formatTokens,
} from "../lib/transcript";
import type { ClaudeUsage, SessionUsage } from "../lib/types";
import { formatResetIn, hasUsageData, isUsageCritical, roundPercent } from "../lib/usageLimits";
import { useNow } from "./useNow";

/** One box, like Claude Code's own: how full this conversation's context
 * window is (every agent reports this), and — folded into the same popover
 * rather than a second icon beside it — Claude's account-wide 5-hour and
 * weekly quota, when there is one to show. Codex and OpenCode have no such
 * quota to poll, so that section simply isn't there for them; nothing
 * stands in for it.
 *
 * Silent until there is at least one number to show: a ring reading 0%
 * before anything has happened is noise, not information. */
export function UsageMeter({
  usage,
  costUsd,
  claudeUsage,
}: {
  usage: SessionUsage;
  costUsd: number;
  /** `null` for a non-Claude session, or before the first fetch lands. */
  claudeUsage: ClaudeUsage | null;
}) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(true);
  const [openLeftward, setOpenLeftward] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const now = useNow(30_000);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const hasContext = usage.totalTokens > 0;
  const hasLimits = hasUsageData(claudeUsage);
  if (!hasContext && !hasLimits) return null;

  const contextFractionValue = hasContext ? contextFraction(usage) : 0;
  const contextPercent = hasContext ? Math.max(1, Math.round(contextFractionValue * 100)) : null;
  const window_ = contextWindow(usage);

  const fiveHour = hasLimits ? roundPercent(claudeUsage!.fiveHour) : 0;
  const sevenDay = hasLimits ? roundPercent(claudeUsage!.sevenDay) : 0;
  const limitsWorst = hasLimits ? Math.max(fiveHour, sevenDay) : null;

  // The ring shows context occupancy whenever there is one — it's what
  // decides whether there's room for another message. Before a session's
  // first turn has settled, the account-wide quota (already fetched) takes
  // the ring over instead of showing nothing.
  const ringPercent = contextPercent ?? limitsWorst ?? 0;
  const ringCritical =
    contextPercent != null ? contextFractionValue >= 0.9 : isUsageCritical(limitsWorst ?? 0);
  const radius = 5;
  const circumference = 2 * Math.PI * radius;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title={
          contextPercent != null
            ? `${usage.contextTokens.toLocaleString()} of ${window_.toLocaleString()} tokens in context`
            : "Claude usage — click for the reset times"
        }
        onClick={() => {
          if (!open) {
            setOpenUpward(shouldOpenUpward(rootRef, 280));
            setOpenLeftward(shouldOpenLeftward(rootRef, 248));
          }
          setOpen((o) => !o);
        }}
        className={`flex cursor-pointer items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] hover:bg-[rgba(255,255,255,0.08)] ${
          ringCritical ? "text-[var(--danger)]" : "text-[var(--faint)] hover:text-[var(--ink)]"
        }`}
      >
        <svg width="13" height="13" viewBox="0 0 13 13" className="shrink-0">
          <circle
            cx="6.5"
            cy="6.5"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            opacity="0.3"
          />
          {/* Rotated so the arc starts at twelve o'clock rather than three. */}
          <circle
            cx="6.5"
            cy="6.5"
            r={radius}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeDasharray={`${((ringPercent / 100) * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            transform="rotate(-90 6.5 6.5)"
          />
        </svg>
        {ringPercent}%
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            style={{
              transformOrigin: `${openUpward ? "bottom" : "top"} ${openLeftward ? "right" : "left"}`,
            }}
            className={`menu absolute z-50 w-[248px] rounded-xl p-3 text-xs ${
              openLeftward ? "right-0" : "left-0"
            } ${openUpward ? "menu-pop-up bottom-full mb-2" : "menu-pop top-full mt-2"}`}
          >
            {contextPercent != null && (
              <>
                <div className="mb-2 flex items-baseline justify-between">
                  <span className="font-medium text-[var(--ink)]">Context window</span>
                  <span className="text-[var(--muted)]">
                    {formatTokens(usage.contextTokens)} / {formatTokens(window_)} ({contextPercent}%)
                  </span>
                </div>
                <div className="h-1 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.1)]">
                  <div
                    className={`h-full rounded-full ${
                      contextFractionValue >= 0.9 ? "bg-[var(--danger)]" : "bg-[var(--muted)]"
                    }`}
                    style={{ width: `${contextPercent}%` }}
                  />
                </div>
              </>
            )}

            {hasLimits && (
              <div className={contextPercent != null ? "mt-3 border-t border-[rgba(255,255,255,0.08)] pt-3" : ""}>
                <div className="mb-2 font-medium text-[var(--ink)]">Plan usage limits</div>
                {claudeUsage!.fiveHour && (
                  <LimitRow
                    label="5-hour limit"
                    percent={fiveHour}
                    resetsAt={claudeUsage!.fiveHour.resetsAt}
                    now={now}
                  />
                )}
                {claudeUsage!.sevenDay && (
                  <LimitRow
                    label="Weekly limit"
                    percent={sevenDay}
                    resetsAt={claudeUsage!.sevenDay.resetsAt}
                    now={now}
                    spaced={claudeUsage!.fiveHour != null}
                  />
                )}
                {claudeUsage!.sevenDaySonnet && (
                  <LimitRow
                    label="Weekly (Sonnet)"
                    percent={roundPercent(claudeUsage!.sevenDaySonnet)}
                    resetsAt={claudeUsage!.sevenDaySonnet.resetsAt}
                    now={now}
                    spaced
                  />
                )}
              </div>
            )}

            {hasContext && (
              <div
                className={
                  contextPercent != null || hasLimits
                    ? "mt-3 border-t border-[rgba(255,255,255,0.08)] pt-3"
                    : ""
                }
              >
                <div className="mb-1.5 font-medium text-[var(--ink)]">
                  This session
                  <span className="ml-1.5 font-normal text-[var(--faint)]">
                    {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
                  </span>
                </div>
                <StatRow label="Input" value={formatTokens(usage.inputTokens)} />
                <StatRow label="Output" value={formatTokens(usage.outputTokens)} />
                <StatRow label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
                <StatRow label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
                <div className="mt-1.5 border-t border-[rgba(255,255,255,0.08)] pt-1.5">
                  <StatRow label="Total" value={formatTokens(usage.totalTokens)} strong />
                  {costUsd > 0 && <StatRow label="Cost" value={formatCost(costUsd)} strong />}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function LimitRow({
  label,
  percent,
  resetsAt,
  now,
  spaced,
}: {
  label: string;
  percent: number;
  resetsAt: string | null;
  now: number;
  spaced?: boolean;
}) {
  const critical = isUsageCritical(percent);
  const resetLabel = formatResetIn(resetsAt, now);
  return (
    <div className={spaced ? "mt-3" : ""}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[var(--faint)]">{label}</span>
        <span className={`font-medium ${critical ? "text-[var(--danger)]" : "text-[var(--ink)]"}`}>
          {percent}%
        </span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.1)]">
        <div
          className={`h-full rounded-full ${critical ? "bg-[var(--danger)]" : "bg-[var(--muted)]"}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      {resetLabel && <div className="mt-1.5 text-[var(--faint)]">{resetLabel}</div>}
    </div>
  );
}

function StatRow({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-[var(--faint)]">{label}</span>
      <span className={strong ? "text-[var(--ink)]" : "text-[var(--muted)]"}>{value}</span>
    </div>
  );
}
