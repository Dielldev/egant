import { useEffect, useMemo, useState } from "react";
import { AGENT_ACCENT, AGENT_PROVIDER, SHORT_NAMES } from "../lib/agents";
import { api } from "../lib/api";
import { log } from "../lib/logger";
import { useEgant } from "../store";
import type { ModelDay, TokenActivity } from "../lib/types";
import { ProviderGlyph } from "./ProviderLogo";

/** GitHub's year: 53 week-columns, the last one holding today. */
const WEEKS = 53;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** How many of the most-used models get a segment of their own before the
 * rest are folded into "Other". */
const MODEL_SEGMENTS = 6;

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
  { id: "week", label: "1 week", days: 7 },
  { id: "month", label: "1 month", days: 30 },
  { id: "quarter", label: "90 days", days: 90 },
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
  return "all";
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
  input: number;
  output: number;
  cache: number;
  activeDays: number;
  agents: Segment[];
  models: Segment[];
}

/** Sums the days on or after `since` (`YYYY-MM-DD`, or `null` for all of
 * them) into the headline and the two ways of splitting it. */
function summarize(data: TokenActivity, since: string | null): Summary {
  const summary: Summary = {
    total: 0,
    input: 0,
    output: 0,
    cache: 0,
    activeDays: 0,
    agents: [],
    models: [],
  };
  const agents = new Map<string, number>();
  const models = new Map<string, Segment>();
  for (const day of data.days) {
    if (since !== null && day.date < since) continue;
    summary.activeDays += 1;
    for (const m of day.models) {
      const tokens = m.input + m.output + m.cache;
      summary.total += tokens;
      summary.input += m.input;
      summary.output += m.output;
      summary.cache += m.cache;
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
          color: AGENT_ACCENT[m.agent] ?? "var(--muted)",
          agent: m.agent,
        });
    }
  }

  summary.agents = [...agents]
    .map(([agent, tokens]) => ({
      key: agent,
      label: SHORT_NAMES[agent] ?? agent,
      tokens,
      color: AGENT_ACCENT[agent] ?? "var(--muted)",
      agent,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // Models take their agent's colour and fade a little with rank, so
  // neighbours from the same agent stay apart.
  const ranked = [...models.values()].sort((a, b) => b.tokens - a.tokens);
  const rankInAgent = new Map<string, number>();
  summary.models = ranked.slice(0, MODEL_SEGMENTS).map((segment) => {
    const rank = rankInAgent.get(segment.agent!) ?? 0;
    rankInAgent.set(segment.agent!, rank + 1);
    const strength = [100, 74, 56, 42][rank] ?? 34;
    return { ...segment, color: `color-mix(in srgb, ${segment.color} ${strength}%, transparent)` };
  });
  const rest = ranked.slice(MODEL_SEGMENTS).reduce((sum, segment) => sum + segment.tokens, 0);
  if (rest > 0) {
    summary.models.push({
      key: "other",
      label: "Other",
      tokens: rest,
      color: "color-mix(in srgb, var(--muted) 45%, transparent)",
      agent: null,
    });
  }
  return summary;
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

/** The year as 53 columns of Sunday-to-Saturday, ending with this week.
 * Brightness steps by quartile of the busy days: token counts are so skewed
 * that a linear scale would leave every ordinary day looking empty. */
function buildCells(
  data: TokenActivity,
  since: string | null,
): { cells: Cell[]; labels: { column: number; text: string }[] } {
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

  // A month's name goes over the first column that starts in it, and never
  // closer than three columns to the last one, or the names run together.
  const labels: { column: number; text: string }[] = [];
  let lastColumn = -3;
  let lastMonth = new Date(first * DAY_MS).getUTCMonth();
  for (let column = 1; column < WEEKS; column++) {
    const month = new Date((first + column * 7) * DAY_MS).getUTCMonth();
    if (month === lastMonth) continue;
    lastMonth = month;
    if (column - lastColumn < 3) continue;
    labels.push({ column, text: MONTHS[month] });
    lastColumn = column;
  }
  return { cells, labels };
}

const LEVEL_STRENGTH = [0, 30, 52, 76, 100];

function levelColor(level: number): string {
  return level === 0
    ? "var(--bubble)"
    : `color-mix(in srgb, var(--accent) ${LEVEL_STRENGTH[level]}%, transparent)`;
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

/** What the launch screen shows under the composer: the year as a calendar of
 * token activity, the running total, and how it splits between agents or
 * between models. Read from the CLIs' own logs (see `activity.rs`), so it
 * includes work done outside egant. */
export function ActivityPanel() {
  const enabled = useEgant((s) => s.appearance.showActivity);
  if (!enabled) return null;
  return <ActivityCard />;
}

/** Split from the switch above so that, with the panel off, nothing reads the
 * logs: the hook only runs once the card is on screen. */
function ActivityCard() {
  const { data, failed } = useTokenActivity();
  const [by, setBy] = useState<"agents" | "models">("agents");
  const [range, setRange] = useState<RangeId>(loadRange);

  // The first day of the range, counting today as day one of N.
  const since = useMemo(() => {
    const days = RANGES.find((r) => r.id === range)?.days;
    if (!days) return null;
    const now = new Date();
    return dayKey(dayNumber(now.getFullYear(), now.getMonth(), now.getDate()) - (days - 1));
  }, [range]);

  const grid = useMemo(() => (data ? buildCells(data, since) : null), [data, since]);
  const summary = useMemo(() => (data ? summarize(data, since) : null), [data, since]);
  const segments = summary ? (by === "agents" ? summary.agents : summary.models) : [];

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

  const pills = (
    options: readonly { id: string; label: string }[],
    value: string,
    onPick: (id: never) => void,
  ) => (
    <div className="flex shrink-0 rounded-full bg-[var(--bubble)] p-0.5 text-[12px]">
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          onClick={() => onPick(option.id as never)}
          className={`cursor-pointer rounded-full px-2.5 py-0.5 whitespace-nowrap ${
            value === option.id
              ? "bg-[var(--selected)] text-[var(--ink)]"
              : "text-[var(--muted)] hover:text-[var(--ink)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
  const rangeLabel = RANGES.find((r) => r.id === range)?.label ?? "";

  return (
    <div className="composer mt-5 w-full rounded-2xl px-5 py-4" aria-label="Token activity">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {summary ? (
            <>
              <div
                className="flex items-baseline gap-2"
                title={`Input ${formatBig(summary.input)} · Output ${formatBig(summary.output)} · Cache ${formatBig(summary.cache)}`}
              >
                <span className="text-[26px] leading-none font-semibold tracking-tight text-[var(--ink)] tabular-nums">
                  {formatBig(summary.total)}
                </span>
                <span className="text-[13px] text-[var(--muted)]">tokens</span>
              </div>
              <div className="mt-1.5 text-[12px] text-[var(--faint)]">
                {summary.activeDays} active {summary.activeDays === 1 ? "day" : "days"} ·{" "}
                {range === "all" ? "all time" : `last ${rangeLabel.replace("1 ", "")}`}
              </div>
            </>
          ) : (
            <>
              <div className="h-[26px] w-28 animate-pulse rounded-md bg-[var(--bubble)]" />
              <div className="mt-1.5 text-[12px] text-[var(--faint)]">Reading your agents' logs…</div>
            </>
          )}
        </div>
        {pills(RANGES, range, pickRange)}
      </div>

      <div className="mt-4">
        {/* Month names sit on the same columns as the cells beneath them. */}
        <div
          className="mb-1 grid h-3 text-[10px] leading-3 text-[var(--faint)]"
          style={{ gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`, columnGap: 3 }}
        >
          {grid?.labels.map((label) => (
            <span key={label.column} className="whitespace-nowrap" style={{ gridColumnStart: label.column + 1 }}>
              {label.text}
            </span>
          ))}
        </div>
        <div
          className="grid"
          style={{
            gridTemplateColumns: `repeat(${WEEKS}, minmax(0, 1fr))`,
            gridTemplateRows: "repeat(7, auto)",
            gridAutoFlow: "column",
            gap: 3,
          }}
        >
          {grid
            ? grid.cells.map((cell) => (
                <div
                  key={cell.key}
                  title={dayTitle(cell)}
                  className="rounded-[2.5px]"
                  style={{
                    aspectRatio: "1",
                    background: levelColor(cell.level),
                    opacity: cell.outside ? 0.25 : undefined,
                    visibility: cell.future ? "hidden" : undefined,
                  }}
                />
              ))
            : Array.from({ length: WEEKS * 7 }, (_, i) => (
                <div key={i} className="rounded-[2.5px] bg-[var(--bubble)]" style={{ aspectRatio: "1" }} />
              ))}
        </div>
        <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-[var(--faint)]">
          <span className="mr-0.5">Less</span>
          {LEVEL_STRENGTH.map((_, level) => (
            <span
              key={level}
              className="h-[9px] w-[9px] rounded-[2px]"
              style={{ background: levelColor(level) }}
            />
          ))}
          <span className="ml-0.5">More</span>
        </div>
      </div>

      {summary && (
        <div className="mt-3.5 border-t border-[var(--border)] pt-3.5">
          <div className="mb-3 flex items-center justify-between gap-3">
            <span className="text-[12px] text-[var(--faint)]">Share of tokens</span>
            {pills(
              [
                { id: "agents", label: "Agents" },
                { id: "models", label: "Models" },
              ],
              by,
              setBy,
            )}
          </div>
          {summary.total === 0 ? (
            <div className="py-2 text-[12px] text-[var(--faint)]">No activity in this range.</div>
          ) : (
            <>
              <div className="flex h-2 w-full gap-[2px] overflow-hidden rounded-full">
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
              <div className="mt-3 grid grid-cols-3 gap-x-4 gap-y-2">
                {segments.map((segment) => (
                  <div key={segment.key} className="flex min-w-0 items-center gap-2 text-[12px]">
                    {by === "agents" && segment.agent ? (
                      <ProviderGlyph
                        provider={AGENT_PROVIDER[segment.agent] ?? segment.agent}
                        size={14}
                        color={segment.color}
                      />
                    ) : (
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ background: segment.color }}
                      />
                    )}
                    <span className="min-w-0 truncate text-[var(--ink)]" title={segment.label}>
                      {segment.label}
                    </span>
                    <span className="shrink-0 font-medium text-[var(--ink)] tabular-nums">
                      {formatPercent(segment.tokens, summary.total)}
                    </span>
                    <span className="shrink-0 text-[var(--faint)] tabular-nums">
                      {formatBig(segment.tokens)}
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
