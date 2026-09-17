import type { ClaudeUsage, UsageWindow } from "./types";

/** Only worth flagging red once a window is nearly exhausted — anything
 * short of that is normal, everyday usage, not a warning. */
export function isUsageCritical(percent: number): boolean {
  return percent >= 90;
}

/** "resets in 3h 12m" / "resets in 42m" / "" once the window has already
 * rolled over (or the endpoint gave no timestamp). */
export function formatResetIn(resetsAt: string | null, now: number): string {
  if (!resetsAt) return "";
  const target = Date.parse(resetsAt);
  if (!Number.isFinite(target)) return "";
  const ms = target - now;
  if (ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours <= 0) return `resets in ${mins}m`;
  return `resets in ${hours}h ${mins}m`;
}

/** Whether there is anything at all worth showing a pill for. */
export function hasUsageData(usage: ClaudeUsage | null): usage is ClaudeUsage {
  return (
    usage != null &&
    (usage.fiveHour != null || usage.sevenDay != null || usage.sevenDaySonnet != null)
  );
}

export function roundPercent(window_: UsageWindow | null): number {
  if (!window_) return 0;
  return Math.min(100, Math.max(0, Math.round(window_.usedPercent)));
}
