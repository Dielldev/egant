import { useEffect, useMemo, useState } from "react";
import { SHORT_NAMES } from "../lib/agents";
import { api } from "../lib/api";
import { log } from "../lib/logger";
import { useEgant } from "../store";
import type { ModelDay, TokenActivity } from "../lib/types";

/** The calendar's width: 48 week-columns, the last one holding today. */
const WEEKS = 48;
const DAY_MS = 86_400_000;

/** How many of the most-used models get a row of their own before the rest
 * are folded into "Other". */
const MODEL_SEGMENTS = 5;

/** What the last fetch found, kept for the life of the window: the launch
 * screen mounts again for every new session, and reading the logs is not
 * something to repeat on each one. */
let remembered: { at: number; data: TokenActivity } | null = null;
const STALE_MS = 60_000;

function useTokenActivity() {
  const [data, setData] = useState<TokenActivity | null>(remembered?.data ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (remembered && Date.now() - remembered.at < STALE_MS) return;
    let live = true;
    api
      .tokenActivity()
      .then((next) => {
        remembered = { at: Date.now(), data: next };
        if (live) setData(next);
      })
      .catch((error: unknown) => {
        log.warn("activity", `couldn't read token activity: ${String(error)}`);
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);
  return { data, failed };
}

/** 4_987_966_817 → "4.99B", 441_981_194 → "442M", 18_356_364 → "18.4M". */
function formatBig(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 1 : 2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(n);
}

function formatPercent(part: number, whole: number): string {
  if (whole <= 0 || part <= 0) return "0%";
  const percent = (part / whole) * 100;
  return percent < 0.1 ? "<0.1%" : `${percent.toFixed(1)}%`;
}

/** `claude-opus-5-5` → "Opus 5.5", `claude-haiku-4-5-20251001` → "Haiku 4.5".
 * Everyone else's ids are already what their own CLI shows. */
export function modelLabel(id: string): string {
  const claude = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(id);
  if (!claude) return id;
  const family = claude[1].charAt(0).toUpperCase() + claude[1].slice(1);
  return `${family} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
}

const RANGES = [
  { id: "week", label: "This week", days: 7 },
  { id: "month", label: "This month", days: 30 },
  { id: "all", label: "All time", days: null },
] as const;
type RangeId = (typeof RANGES)[number]["id"];

const RANGE_KEY = "egant.activityRange";

function loadRange(): RangeId {
  try {
    const saved = localStorage.getItem(RANGE_KEY);
    if (RANGES.some((range) => range.id === saved)) return saved as RangeId;
  } catch {
    // Storage can be unavailable; the default is fine.
  }
  return "week";
}

function dayTotal(models: ModelDay[]): number {
  return models.reduce((sum, m) => sum + m.input + m.output + m.cache, 0);
}

interface Segment {
  key: string;
  label: string;
  tokens: number;
  color: string;
  agent: string | null;
}

interface Summary {
  total: number;
  messages: number;
  sessions: number;
  activeDays: number;
  agents: Segment[];
  models: Segment[];
}

/** Sums the days on or after `since` (`YYYY-MM-DD`, or `null` for all of
 * them) into the headline figures and the two ways of splitting the tokens. */
function summarize(data: TokenActivity, since: string | null): Summary {
  const summary: Summary = {
    total: 0,
    messages: 0,
    sessions: 0,
    activeDays: 0,
    agents: [],
    models: [],
  };
  const agents = new Map<string, number>();
  const models = new Map<string, Segment>();
  const sessions = new Set<number>();
  for (const day of data.days) {
    if (since !== null && day.date < since) continue;
    summary.activeDays += 1;
    for (const id of day.sessions ?? []) sessions.add(id);
    for (const m of day.models) {
      const tokens = m.input + m.output + m.cache;
      summary.total += tokens;
      summary.messages += m.turns ?? 0;
      agents.set(m.agent, (agents.get(m.agent) ?? 0) + tokens);
      // Two ids that read the same ("Haiku 4.5" with and without a date) are
      // one model.
      const label = modelLabel(m.model);
      const key = `${m.agent}:${label}`;
      const seen = models.get(key);
      if (seen) seen.tokens += tokens;
      else
        models.set(key, {
          key,
          label,
          tokens,
          color: "",
          agent: m.agent,
        });
    }
  }
  summary.sessions = sessions.size;

  summary.agents = [...agents]
    .map(([agent, tokens]) => ({
      key: agent,
      label: SHORT_NAMES[agent] ?? agent,
      tokens,
      color: "",
      agent,
    }))
    .sort((a, b) => b.tokens - a.tokens)
    .map((segment, rank) => ({ ...segment, color: shareColor(rank) }));

  const ranked = [...models.values()].sort((a, b) => b.tokens - a.tokens);
  summary.models = ranked
    .slice(0, MODEL_SEGMENTS)
    .map((segment, rank) => ({ ...segment, color: shareColor(rank) }));
  const rest = ranked.slice(MODEL_SEGMENTS).reduce((sum, segment) => sum + segment.tokens, 0);
  if (rest > 0) {
    summary.models.push({
      key: "other",
      label: "Other",
      tokens: rest,
      color: shareColor(MODEL_SEGMENTS),
      agent: null,
    });
  }
  return summary;
}

/** Shares are drawn in the text colour at falling strengths, biggest first,
 * so the panel stays one colour like the calendar above it. */
const SHARE_STRENGTH = [100, 74, 54, 40, 30, 22];

function shareColor(rank: number): string {
  return `color-mix(in srgb, var(--ink) ${SHARE_STRENGTH[rank] ?? 18}%, transparent)`;
}

/** Days since 1970-01-01 of a calendar date, with no time zone in it. */
function dayNumber(year: number, month: number, day: number): number {
  return Date.UTC(year, month, day) / DAY_MS;
}

function dayKey(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

interface Cell {
  key: string;
  day: number;
  tokens: number;
  level: number;
  /** Later this week than today: part of the grid, but nothing to show. */
  future: boolean;
  /** Before the chosen range starts: drawn faintly, still hoverable. */
  outside: boolean;
}

/** The last 48 weeks as columns of Sunday-to-Saturday, ending with this one.
 * Brightness steps by quartile of the busy days: token counts are so skewed
 * that a linear scale would leave every ordinary day looking empty. */
function buildCells(data: TokenActivity, since: string | null): Cell[] {
  const now = new Date();
  const today = dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
  // 1970-01-01 was a Thursday, so day 0 sits at weekday 4 (Sunday = 0).
  const weekday = (today + 4) % 7;
  const first = today - weekday - (WEEKS - 1) * 7;

  const byDay = new Map(data.days.map((day) => [day.date, dayTotal(day.models)]));
  const busy = [...byDay.values()].filter((tokens) => tokens > 0).sort((a, b) => a - b);
  const at = (share: number) => busy[Math.min(busy.length - 1, Math.floor(busy.length * share))] ?? 0;
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];

  const cells: Cell[] = [];
  for (let i = 0; i < WEEKS * 7; i++) {
    const day = first + i;
    const key = dayKey(day);
    const tokens = byDay.get(key) ?? 0;
    const level = tokens === 0 ? 0 : tokens <= q1 ? 1 : tokens <= q2 ? 2 : tokens <= q3 ? 3 : 4;
    cells.push({ key, day, tokens, level, future: day > today, outside: since !== null && key < since });
  }
  return cells;
}

/** The calendar is drawn in the text colour rather than the accent, so it
 * reads as part of the page and stays quiet over any wallpaper. */
const LEVEL_STRENGTH = [10, 30, 50, 74, 100];

function levelColor(level: number): string {
  return `color-mix(in srgb, var(--ink) ${LEVEL_STRENGTH[level]}%, transparent)`;
}

function dayTitle(cell: Cell): string {
  const date = new Date(cell.day * DAY_MS).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return cell.tokens > 0 ? `${date} — ${formatBig(cell.tokens)} tokens` : `${date} — no activity`;
}

/** The panel has nothing behind it, so the wallpaper shows through; the shadow
 * is what keeps the text legible over a bright part of one. */
const TEXT_SHADOW = "0 1px 8px rgba(0,0,0,0.7), 0 1px 2px rgba(0,0,0,0.85)";

/** What the launch screen shows above the composer, straight over the
 * wallpaper: messages, sessions, active
 * days and tokens for a range, the last half-year as a calendar, and (if
 * Appearance asks for it) how the tokens split between agents or models. Read
 * from the CLIs' own logs (see `activity.rs`), so it includes work done outside
 * egant. */
export function ActivityPanel() {
  const enabled = useEgant((s) => s.appearance.showActivity);
  if (!enabled) return null;
  return <ActivityCard />;
}

/** Split from the switch above so that, with the panel off, nothing reads the
 * logs: the hook only runs once the card is on screen. */
function ActivityCard() {
  const { data, failed } = useTokenActivity();
  const detail = useEgant((s) => s.appearance.activityDetail);
  const [range, setRange] = useState<RangeId>(loadRange);

  // The first day of the range, counting today as day one of N.
  const since = useMemo(() => {
    const days = RANGES.find((r) => r.id === range)?.days;
    if (!days) return null;
    const now = new Date();
    return dayKey(dayNumber(now.getFullYear(), now.getMonth(), now.getDate()) - (days - 1));
  }, [range]);

  const cells = useMemo(() => (data ? buildCells(data, since) : null), [data, since]);
  const summary = useMemo(() => (data ? summarize(data, since) : null), [data, since]);
  const segments = summary ? (detail === "models" ? summary.models : summary.agents) : [];

  const pickRange = (next: RangeId) => {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // Not remembering the choice is harmless.
    }
  };

  if (failed && !data) return null;
  if (data && data.days.length === 0) return null;

  const stats = [
    { label: "messages", value: summary ? summary.messages.toLocaleString() : null },
    { label: "sessions", value: summary ? summary.sessions.toLocaleString() : null },
    { label: "active days", value: summary ? summary.activeDays.toLocaleString() : null },
    { label: "tokens", value: summary ? formatBig(summary.total) : null },
  ];

  return (
    <div
      className="mb-5 w-full px-6 py-2 text-[var(--ink)]"
      aria-label="Activity"
      style={{ textShadow: TEXT_SHADOW }}
    >
      <div className="mb-3.5 flex items-center gap-4 text-[12px]">
        {RANGES.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => pickRange(option.id)}
            className={`cursor-pointer transition-colors ${
              range === option.id
                ? "font-semibold text-[var(--ink)]"
                : "text-[var(--ink)]/60 hover:text-[var(--ink)]"
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="mb-4 flex items-start justify-between gap-6">
        {stats.map((stat) => (
          <div key={stat.label} className="min-w-0">
            {stat.value === null ? (
              <div className="h-[24px] w-12 animate-pulse rounded-md bg-[var(--bubble)]" />
            ) : (
              <div className="text-[24px] leading-none font-semibold tracking-tight tabular-nums">
                {stat.value}
              </div>
            )}
            <div className="mt-1.5 text-[11px] text-[var(--ink)]/65">{stat.label}</div>
          </div>
        ))}
      </div>

      <div
        className="grid"
        style={{
          gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`,
          gridTemplateRows: "repeat(7, auto)",
          gridAutoFlow: "column",
          gap: 4,
        }}
      >
        {(cells ?? []).map((cell) => (
          <div
            key={cell.key}
            title={dayTitle(cell)}
            className="rounded-[3px]"
            style={{
              aspectRatio: "1",
              background: levelColor(cell.level),
              opacity: cell.outside ? 0.35 : undefined,
              visibility: cell.future ? "hidden" : undefined,
            }}
          />
        ))}
        {!cells &&
          Array.from({ length: WEEKS * 7 }, (_, i) => (
            <div key={i} className="rounded-[3px]" style={{ aspectRatio: "1", background: levelColor(0) }} />
          ))}
      </div>

      {detail !== "off" && summary && summary.total > 0 && (
        <div className="mt-5">
          <div className="flex h-1.5 w-full gap-[2px] overflow-hidden rounded-full">
            {segments.map((segment) => (
              <div
                key={segment.key}
                title={`${segment.label} — ${formatPercent(segment.tokens, summary.total)} · ${formatBig(segment.tokens)} tokens`}
                className="h-full"
                style={{
                  width: `${(segment.tokens / summary.total) * 100}%`,
                  minWidth: 3,
                  background: segment.color,
                }}
              />
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            {segments.map((segment) => (
              <div
                key={segment.key}
                title={`${formatBig(segment.tokens)} tokens`}
                className="flex min-w-0 items-center gap-1.5 text-[12px]"
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ background: segment.color }}
                />
                <span className="truncate">{segment.label}</span>
                <span className="shrink-0 text-[var(--ink)]/65 tabular-nums">
                  {formatPercent(segment.tokens, summary.total)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
