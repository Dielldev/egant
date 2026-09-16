import { useEffect, useRef, useState } from "react";
import { shouldOpenUpward } from "../lib/popover";
import {
  contextFraction,
  contextWindow,
  formatCost,
  formatTokens,
} from "../lib/transcript";
import type { SessionUsage } from "../lib/types";

/** How full the context window is, as a ring under the composer's right edge,
 * and — on click — everything the session has spent to get there.
 *
 * Silent until the first turn reports its tokens: a ring reading 0% before
 * anything has happened is noise, not information.
 *
 * The ring and the popover read different numbers on purpose. The ring shows
 * the *newest turn's* occupancy of the window, because that is what decides
 * whether there is room for another message. The breakdown underneath shows
 * *cumulative* totals for the whole session, because that is what answers
 * "what has this conversation cost me". Summing occupancy would sail past
 * 100% by the third turn. */
export function ContextMeter({ usage, costUsd }: { usage: SessionUsage; costUsd: number }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(true);
  const rootRef = useRef<HTMLDivElement>(null);

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

  if (usage.totalTokens <= 0) return null;

  const fraction = contextFraction(usage);
  const percent = Math.max(1, Math.round(fraction * 100));
  const window_ = contextWindow(usage);
  const tight = fraction >= 0.9;
  const radius = 5;
  const circumference = 2 * Math.PI * radius;

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        title={`${usage.contextTokens.toLocaleString()} of ${window_.toLocaleString()} tokens in context`}
        onClick={() => {
          if (!open) setOpenUpward(shouldOpenUpward(rootRef, 260));
          setOpen((o) => !o);
        }}
        className={`flex cursor-pointer items-center gap-1.5 rounded-full px-1.5 py-0.5 text-[11px] hover:bg-[rgba(255,255,255,0.08)] ${
          tight ? "text-[var(--danger)]" : "text-[var(--faint)] hover:text-[var(--ink)]"
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
            strokeDasharray={`${(fraction * circumference).toFixed(2)} ${circumference.toFixed(2)}`}
            transform="rotate(-90 6.5 6.5)"
          />
        </svg>
        {percent}%
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            style={{ transformOrigin: openUpward ? "bottom right" : "top right" }}
            className={`menu absolute right-0 z-50 w-[248px] rounded-xl p-3 text-xs ${
              openUpward ? "menu-pop-up bottom-full mb-2" : "menu-pop top-full mt-2"
            }`}
          >
            <div className="mb-2 flex items-baseline justify-between">
              <span className="font-medium text-[var(--ink)]">Context</span>
              <span className="text-[var(--muted)]">
                {formatTokens(usage.contextTokens)} / {formatTokens(window_)}
              </span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.1)]">
              <div
                className={`h-full rounded-full ${
                  tight ? "bg-[var(--danger)]" : "bg-[var(--muted)]"
                }`}
                style={{ width: `${percent}%` }}
              />
            </div>

            <div className="mt-3 mb-1.5 font-medium text-[var(--ink)]">
              This session
              <span className="ml-1.5 font-normal text-[var(--faint)]">
                {usage.turns} {usage.turns === 1 ? "turn" : "turns"}
              </span>
            </div>
            <Row label="Input" value={formatTokens(usage.inputTokens)} />
            <Row label="Output" value={formatTokens(usage.outputTokens)} />
            <Row label="Cache write" value={formatTokens(usage.cacheCreationTokens)} />
            <Row label="Cache read" value={formatTokens(usage.cacheReadTokens)} />
            <div className="mt-1.5 border-t border-[rgba(255,255,255,0.08)] pt-1.5">
              <Row label="Total" value={formatTokens(usage.totalTokens)} strong />
              {costUsd > 0 && <Row label="Cost" value={formatCost(costUsd)} strong />}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between py-0.5">
      <span className="text-[var(--faint)]">{label}</span>
      <span className={strong ? "text-[var(--ink)]" : "text-[var(--muted)]"}>{value}</span>
    </div>
  );
}
