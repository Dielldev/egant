import type { ClaudeUsage, UsageWindow } from "./types";

/** Only worth flagging red once a window is nearly exhausted — anything
 * short of that is normal, everyday usage, not a warning. */
export function isUsageCritical(percent: number): boolean {
  return percent >= 90;
}

/** "resets in 3h 12m" / "resets in 42m" / "" once the window has already
 * rolled over (or the endpoint gave no timestamp). */
export function formatResetIn(
  resetsAt: string | number | null | undefined,
  now: number,
  options?: { withClock?: boolean; prefix?: string },
): string {
  if (!resetsAt) return "";
  let targetMs: number;
  if (typeof resetsAt === "number") {
    targetMs = resetsAt < 1e11 ? resetsAt * 1000 : resetsAt;
  } else {
    targetMs = Date.parse(resetsAt);
  }
  if (!Number.isFinite(targetMs)) return "";
  const ms = targetMs - now;
  if (ms <= 0) return "";
  const minutes = Math.round(ms / 60_000);
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const days = Math.floor(hours / 24);

  const prefix = options?.prefix ?? "resets in";
  let relative = "";
  if (days >= 1) {
    const remHours = hours % 24;
    relative = `${prefix} ${days}d ${remHours}h`;
  } else if (hours <= 0) {
    relative = `${prefix} ${Math.max(1, mins)}m`;
  } else {
    relative = `${prefix} ${hours}h ${mins}m`;
  }

  if (options?.withClock) {
    const date = new Date(targetMs);
    const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return `${relative} (${clock})`;
  }
  return relative;
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
