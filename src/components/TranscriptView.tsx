import { Check, ChevronDown, Copy, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { modShortcut } from "../lib/platform";
import {
  ASK_USER_QUESTION,
  askQuestions,
  describeAlwaysAllow,
  isCardRequest,
  isInteractiveTool,
  permissionSummary,
  planOf,
  timeLabel,
  truncate,
} from "../lib/transcript";
import type { AgentRequest, Entry, PendingPermission, PermissionReply } from "../lib/types";
import { useEgant } from "../store";
import { Composer } from "./Composer";
import { DecisionPrompt } from "./DecisionPrompt";
import { Markdown } from "./Markdown";
import { PlanCard } from "./PlanCard";
import { QuestionCard } from "./QuestionCard";
import { RunPill } from "./RunPill";
import { SettledRequest } from "./SettledRequest";
import { StatusLine } from "./StatusLine";
import { ToolActivityGroup, ToolCard } from "./ToolCards";

// ---------------------------------------------------------------------------
// Chat outline — a port of zeron's MessageRail (`crates/ui/src/rail.rs`,
// `motion.rs`, docs/research/feature-inventory.md §1.8). Values mirror
// upstream exactly:
// - geometry: left 16px, width 26px, tick slot 10px, gap 3px, bar 2px tall
//   with 1px rounding, w-3 rest / w-5 hovered. Only hover grows the tick;
//   the active one just reads brighter (text at 80% vs ink at 16%).
// - preview card per hovered tick: 280px wide, 8px padding, 6px gap, 12px
//   prompt (single line, 160 chars) + 11px reply opening (200 chars), and a
//   10px "{n} prompts" note for condensed buckets. 12px radius, 16px frost.
// - motion: 500ms ease-in-out scroll glide over the whole distance (never
//   percent-of-remaining), 150ms tailwind-ease hover fades, 140ms menu-in
//   (fade + rise 2px, see `.rail-card-in`).
// - hidden below 2 ticks, and below a 768px transcript container
//   (RAIL_MIN_… = 48rem) — the stage wrapper carries `@container` so the
//   gate reads container width, never viewport width. The rail must stay a
//   descendant of that wrapper for the query to match.
// - past 12 visible ticks the rail downsamples into even buckets instead of
//   growing — a fixed footprint, never a full-height minimap.
// ---------------------------------------------------------------------------

/** Vertical breathing room kept clear above/below the tick stack. */
const RAIL_V_MARGIN = 24;
/** One tick's hit-row height, and the gap between ticks. */
const TICK_SLOT = 10;
const TICK_GAP = 3;
/** Hard cap on visible ticks — the rail stays compact on tall windows. */
const MAX_RAIL_TICKS = 12;
/** Viewport-top reading line: titlebar 38px + 10px, plus the half-pixel the
 * upstream walk-forward comparison carries. */
const READ_INSET_PX = 48.5;
/** A jumped-to prompt lands this far below the viewport top (OWN_SEND_… = 48). */
const JUMP_INSET_PX = 48;
/** `motion::SCROLL_GLIDE`: 500ms `EASE_IN_OUT`. */
const SCROLL_GLIDE_MS = 500;
/** Preview caps: prompt title is a one-line surface, reply its opening. */
const PREVIEW_PROMPT_CHARS = 160;
const PREVIEW_REPLY_CHARS = 200;

/** One rail tick: a user prompt and the opening of the reply that followed. */
type OutlineTick = {
  /** Position among rendered entries — what the scroll anchors key on. */
  entryIndex: number;
  n: number;
  prompt: string;
  reply: string | null;
};

/** How many tick slots fit in a rail of `height` px (always ≥ 1). */
function railCapacity(height: number): number {
  const usable = Math.max(height - 2 * RAIL_V_MARGIN, TICK_SLOT);
  return Math.max(1, Math.floor((usable + TICK_GAP) / (TICK_SLOT + TICK_GAP)));
}

/** Slots the rail actually uses: what fits, hard-capped at MAX_RAIL_TICKS. */
function railSlots(height: number): number {
  return Math.min(railCapacity(height), MAX_RAIL_TICKS);
}

/** Evenly-sized buckets over the conversation when prompts outnumber slots.
 * With n <= capacity every bucket is a single tick (the identity). */
function tickBuckets(n: number, capacity: number): Array<[number, number]> {
  if (n === 0) return [];
  const cap = Math.min(Math.max(capacity, 1), n);
  const out: Array<[number, number]> = [];
  for (let k = 0; k < cap; k++) {
    out.push([Math.floor((k * n) / cap), Math.floor(((k + 1) * n) / cap)]);
  }
  return out;
}

/** The bucket containing tick `ix` (for active/hover mapping). */
function bucketOf(buckets: Array<[number, number]>, ix: number): number | null {
  const found = buckets.findIndex(([s, e]) => ix >= s && ix < e);
  return found === -1 ? null : found;
}

/** CSS `cubic-bezier()` evaluated exactly (Newton–Raphson + bisection). */
function cubicBezier(x1: number, y1: number, x2: number, y2: number): (x: number) => number {
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const solveX = (x: number) => {
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return t;
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 32; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) return t;
      if (x > v) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return t;
  };
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    return sampleY(solveX(x));
  };
}

/** EASE_IN_OUT (0.42, 0, 0.58, 1): gentle first frame, midpoint exactly half. */
const easeInOut = cubicBezier(0.42, 0, 0.58, 1);

/** Duration-based glide timeline (pure): each frame consumes
 * `(e_now − e_prev) / (1 − e_prev)` of whatever distance currently remains,
 * so a mid-flight re-layout continues the same timeline — no restart, no
 * compensating jump, exact landing. */
class GlideTimeline {
  private easedPrev = 0;

  step(eased: number): number {
    const clamped = Math.min(Math.max(eased, this.easedPrev), 1);
    const denom = 1 - this.easedPrev;
    const frac = denom <= 1e-6 ? 1 : (clamped - this.easedPrev) / denom;
    this.easedPrev = clamped;
    return Math.min(Math.max(frac, 0), 1);
  }
}

/** The stage's content: the conversation, and the composer that drives it.
 * Reads the active session's transcript mirror on render, which is what makes
 * streaming free — each `session-event` folds into the store and this
 * re-renders. */
export function TranscriptView() {
  const snapshot = useEgant((s) => s.snapshot);
  const transcripts = useEgant((s) => s.transcripts);
  const openFolderDialog = useEgant((s) => s.openFolderDialog);
  const answerPermission = useEgant((s) => s.answerPermission);
  const openFile = useEgant((s) => s.openFile);
  const error = useEgant((s) => s.error);
  const dismissError = useEgant((s) => s.dismissError);

  const activeId = snapshot?.activeSession;
  const active = snapshot?.sessions.find((s) => s.id === activeId);

  // The error toast above the composer auto-dismisses: a sticky red bar that
  // has to be clicked away reads as a crash, while most store errors are
  // transient (a failed send, a blip mid-answer). It stays long enough to
  // read, then goes on its own — clicking still dismisses it sooner.
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => dismissError(), 5000);
    return () => clearTimeout(timer);
  }, [error, dismissError]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const promptRefs = useRef(new Map<number, HTMLDivElement | null>());
  /** Index into `ticks` (not an entry index): the prompt whose section is read. */
  const [activeTick, setActiveTick] = useState<number | null>(null);
  /** Viewport height for the fixed-footprint bucket math (600 pre-layout). */
  const [viewportH, setViewportH] = useState(600);
  const glideRef = useRef<number | null>(null);

  const transcript = activeId != null ? transcripts[activeId] : undefined;
  // Reasoning is dropped rather than drawn. The status line at the tail
  // already says the turn is thinking, and once the answer is there a
  // scrollback of settled "Thought for 4s" rows is just noise between the
  // things that actually happened. Filtered here rather than in `RenderEntry`
  // so the grouping below never sees one either — an entry that renders
  // nothing would still split two neighbouring Reads into separate cards, for
  // a reason invisible on screen.
  const entries = (transcript?.entries ?? []).filter((entry) => entry.kind !== "thinking");
  // The approval table: every outstanding request, oldest first. Older
  // snapshots carry only `pending` — mirror it so the table still renders.
  const pendingList =
    transcript?.pendingList ??
    (transcript?.pending != null ? [transcript.pending] : []);
  // A question or a plan is the agent asking the user something, not asking
  // leave to act: each gets its own card.
  const cardRequests = pendingList.filter(isCardRequest);
  const tableRequests = pendingList.filter((p) => !isCardRequest(p));

  // The status line at the tail of the transcript covers the whole turn — the
  // gap before the first token included — so there is never a stretch of the
  // wait with nothing on screen accounting for it.
  const busy = transcript?.state === "running" || transcript?.state === "awaiting_permission";

  // Rail ticks: one per user prompt, each carrying the opening of the
  // assistant reply that followed it (`rail_ticks` + `first_reply_text`).
  // Memoized off the raw transcript entries (not the filtered `entries`
  // above) so a streaming reply — a new array every token — doesn't rebuild
  // what doesn't depend on it; the reply opening re-resolves as it streams.
  const ticks = useMemo<OutlineTick[]>(() => {
    const source = transcript?.entries ?? [];
    // `entries` drops `thinking` rows, so indices shift by that count. Walk
    // the filtered list for text but resolve back to the same numbering the
    // scroll anchors use below (position among rendered entries).
    const visible = source.filter((entry) => entry.kind !== "thinking");
    const out: OutlineTick[] = [];
    visible.forEach((entry, entryIndex) => {
      if (entry.kind !== "user") return;
      let reply: string | null = null;
      for (let j = entryIndex + 1; j < visible.length; j++) {
        const next = visible[j];
        if (next.kind === "assistant" && next.text.trim() !== "") {
          reply = outlinePreview(next.text, PREVIEW_REPLY_CHARS);
          break;
        }
      }
      out.push({
        entryIndex,
        n: out.length + 1,
        prompt: outlinePreview(entry.text, PREVIEW_PROMPT_CHARS),
        reply,
      });
    });
    return out;
  }, [transcript?.entries]);
  // A minimap of one exchange is noise, not navigation — the rail hides
  // below two marks.
  const showOutline = ticks.length >= 2;

  // The active tick for a scroll position: the last tick whose row is at or
  // above the reading line (viewport top + chrome inset). Before the first
  // tick's row, the first tick is active.
  const updateActiveFromScroll = () => {
    const root = scrollRef.current;
    if (!root || ticks.length === 0) return;
    const line = root.getBoundingClientRect().top + READ_INSET_PX;
    let found: number | null = null;
    ticks.forEach((tick, ix) => {
      const el = promptRefs.current.get(tick.entryIndex);
      if (el && el.getBoundingClientRect().top <= line) found = ix;
    });
    setActiveTick(found ?? 0);
  };

  const jumpToPrompt = (entryIndex: number) => {
    const root = scrollRef.current;
    const el = promptRefs.current.get(entryIndex);
    if (!root || !el) return;
    // Leaving the tail breaks the pin on purpose — the stick effect would
    // otherwise yank a jump-to-#1 straight back to the bottom on next render.
    // The scroll handler re-arms it once the user returns to the bottom.
    stickRef.current = false;
    if (glideRef.current != null) cancelAnimationFrame(glideRef.current);
    const target =
      el.getBoundingClientRect().top -
      root.getBoundingClientRect().top +
      root.scrollTop -
      JUMP_INSET_PX;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      root.scrollTop = target;
      return;
    }
    // The 500ms glide drives every frame's position from the timeline, never
    // from a percent of the remaining distance: the position is read back
    // each frame, so a measurement correcting the estimate just re-enters
    // the timeline, and raw >= 1 lands exactly.
    const timeline = new GlideTimeline();
    const started = performance.now();
    const frame = (now: number) => {
      const raw = Math.min(1, (now - started) / SCROLL_GLIDE_MS);
      const frac = timeline.step(easeInOut(raw));
      if (raw >= 1) {
        root.scrollTop = target;
        glideRef.current = null;
        return;
      }
      root.scrollTop += frac * (target - root.scrollTop);
      glideRef.current = requestAnimationFrame(frame);
    };
    glideRef.current = requestAnimationFrame(frame);
  };

  // Viewport height for the fixed-footprint bucket math. Pre-layout the
  // viewport reads 0; assume a typical height for that frame rather than
  // collapsing to a single tick.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    setViewportH(root.clientHeight || 600);
    const observer = new ResizeObserver(() => {
      setViewportH(root.clientHeight || 600);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [activeId]);

  // Re-resolve the active tick once layout settles — streaming growth moves
  // rows without scrolling, and the scroll handler alone would miss it.
  useEffect(() => {
    if (!showOutline) return;
    const id = requestAnimationFrame(() => updateActiveFromScroll());
    return () => cancelAnimationFrame(id);
  });

  // A running glide yields to unmount rather than writing to a dead node.
  useEffect(
    () => () => {
      if (glideRef.current != null) cancelAnimationFrame(glideRef.current);
    },
    [],
  );

  // Stay pinned to the bottom while the user is already there; never yank them
  // back once they scroll up to read. Deliberately every render rather than on
  // a dependency list: a streaming reply grows the column without changing the
  // entry count, and the status line trailing it has to stay in view too.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  });

  if (!snapshot) return <div className="size-full" />;

  if (snapshot.projects.length === 0) {
    return (
      <Centered
        title="No folder open"
        detail="Point egant at a project to start an agent session."
        actionLabel="Open a folder"
        onAction={() => void openFolderDialog()}
      />
    );
  }

  if (!active) {
    return (
      <Centered title="No conversation open" detail={`Press ${modShortcut("N")} to start one`} />
    );
  }

  return (
    <div className="relative @container flex size-full flex-col">
      <div
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          updateActiveFromScroll();
        }}
        className="rise flex flex-1 items-start justify-center overflow-y-auto px-6 pt-4 pb-2"
        style={{ animationDelay: "90ms" }}
      >
        <div className="flex w-full max-w-[735px] flex-col gap-5">
          {/* One row per entry, in order — except consecutive tool calls,
            which fold into a single grouped activity block (`Ran 1 command
            · read 5 files · searched 1 time`) with one row per call. The
            model's own words stay as Markdown text between the blocks, so a
            turn reads like "Now let's guard… / [activity] / Now register…"
            instead of every call collapsing into one giant dropdown. */}
          {(() => {
            const nodes: ReactNode[] = [];
            let i = 0;
            while (i < entries.length) {
              const entry = entries[i]!;
              // A question or a plan stands on its own rather than folding
              // into the activity around it: settled, it is a record of what
              // was asked and answered; still open, it is the card below.
              if (entry.kind === "tool" && isInteractiveTool(entry.name)) {
                nodes.push(
                  <SettledRequest
                    key={i}
                    entry={entry}
                    onOpenPlan={(path) => openFile(active.id, path, path.split("/").pop() ?? path)}
                  />,
                );
                i++;
                continue;
              }
              if (entry.kind === "tool") {
                let j = i + 1;
                while (
                  j < entries.length &&
                  entries[j]!.kind === "tool" &&
                  !isInteractiveTool((entries[j] as Extract<Entry, { kind: "tool" }>).name)
                ) {
                  j++;
                }
                nodes.push(
                  <ToolActivityGroup
                    key={`tools-${i}`}
                    entries={entries.slice(i, j) as Extract<Entry, { kind: "tool" }>[]}
                  />,
                );
                i = j;
                continue;
              }
              if (entry.kind === "user") {
                nodes.push(
                  <div
                    key={i}
                    ref={(el) => {
                      if (el) promptRefs.current.set(i, el);
                      else promptRefs.current.delete(i);
                    }}
                    data-prompt-index={i}
                    className="scroll-mt-[48px]"
                  >
                    <RenderEntry entry={entry} sessionId={active.id} />
                  </div>,
                );
              } else if (
                entry.kind === "assistant" &&
                !entry.streaming &&
                entry.text.trim() === ""
              ) {
                // A settled but empty reply row carries no words — skip it so
                // it never inserts a phantom gap between two dropdowns. A
                // *streaming* empty row still renders: its trailing ▌ is the
                // "still typing" cue.
                nodes.push(<span key={i} className="hidden" />);
              } else {
                nodes.push(<RenderEntry key={i} entry={entry} sessionId={active.id} />);
              }
              i++;
            }
            return nodes;
          })()}
          {cardRequests.map((pending) =>
            pending.toolName === ASK_USER_QUESTION ? (
              <QuestionCard
                key={pending.requestId}
                questions={askQuestions(pending.input)}
                onAnswer={(reply) => void answerPermission(active.id, pending.requestId, reply)}
              />
            ) : (
              <PlanCard
                key={pending.requestId}
                {...planOf(pending.input)}
                onAnswer={(reply) => void answerPermission(active.id, pending.requestId, reply)}
                onOpenPlan={(path) => openFile(active.id, path, path.split("/").pop() ?? path)}
              />
            ),
          )}
          {tableRequests.length > 0 && (
            <PermissionTable
              items={tableRequests}
              agent={active.agent}
              cwd={active.cwd}
              onAnswer={(requestId, reply) => void answerPermission(active.id, requestId, reply)}
            />
          )}
          {/* Trailing the transcript, the way Claude Code puts it: directly
            under the text still being generated rather than docked to the
            composer. The pull-up trims the column's own gap so it reads as
            part of the reply above it, not as a separate block. */}
          {busy && transcript && (
            <div className="-mt-2.5">
              <StatusLine state={transcript.state} startedAt={transcript.turnStartedAt} />
            </div>
          )}
          {/* The task is done — offer to run what it just changed, in the
            checkout it changed it in. A worktree session's work isn't in the
            folder you opened, so the pill names the branch it runs on. */}
          {!busy && transcript && entries.length > 0 && (
            <div className="-mt-1">
              <RunPill cwd={active.cwd} worktree={active.worktree} />
            </div>
          )}
        </div>
      </div>

      {showOutline && (
        <ChatOutline
          ticks={ticks}
          activeTick={activeTick}
          viewportH={viewportH}
          onJump={jumpToPrompt}
        />
      )}

      <div className="rise flex w-full shrink-0 flex-col items-center px-6 pb-2">
        <div className="flex w-full max-w-[735px] flex-col">
          {error && (
            <button
              type="button"
              title="Dismiss"
              onClick={dismissError}
              className="row-in mb-2 w-full cursor-pointer truncate rounded-lg bg-[rgba(224,112,112,0.14)] px-3 py-1.5 text-left text-xs text-[var(--danger)]"
            >
              {error}
            </button>
          )}
          <Composer sessionId={active.id} />
        </div>
      </div>
    </div>
  );
}

/** First line of a prompt, single-spaced, for outline rows and tooltips. */
function outlinePreview(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length > limit ? `${single.slice(0, limit - 1)}…` : single;
}

/** MessageRail: a left vertical minimap of the user's prompts. The active
 * tick brightens, hover grows the tick and shows a preview card (prompt +
 * reply opening), click glides the transcript to that row. An absolute
 * overlay in the transcript's left gutter (never over the text), hidden
 * below a 768px transcript container. */
function ChatOutline({
  ticks,
  activeTick,
  viewportH,
  onJump,
}: {
  ticks: OutlineTick[];
  activeTick: number | null;
  viewportH: number;
  onJump: (entryIndex: number) => void;
}) {
  const [hovered, setHovered] = useState<number | null>(null);
  const buckets = useMemo(
    () => tickBuckets(ticks.length, railSlots(viewportH)),
    [ticks.length, viewportH],
  );
  const activeBucket = activeTick != null ? bucketOf(buckets, activeTick) : null;

  return (
    <nav
      aria-label="Chat outline"
      className="absolute top-0 bottom-0 left-4 z-20 hidden w-[26px] flex-col items-start justify-center gap-[3px] @min-[768px]:flex"
    >
      {buckets.map(([start, end], ix) => {
        // The bucket's representative: the active tick when it falls inside
        // (hover then previews what you're reading), else the range's first.
        const rep =
          activeTick != null && activeTick >= start && activeTick < end ? activeTick : start;
        const tick = ticks[rep];
        if (!tick) return null;
        const bucketLen = end - start;
        const isActive = activeBucket === ix;
        const isHovered = hovered === ix;
        const label = `Prompt ${tick.n}: ${tick.prompt}`;
        return (
          <div
            key={ix}
            className="relative flex h-[10px] w-full items-center"
            onMouseEnter={() => setHovered(ix)}
            onMouseLeave={() => setHovered((h) => (h === ix ? null : h))}
          >
            <button
              type="button"
              title={label}
              aria-label={`Go to prompt ${tick.n}`}
              aria-current={isActive ? "true" : undefined}
              onClick={() => onJump(tick.entryIndex)}
              className="flex h-full w-full cursor-pointer items-center"
            >
              {/* Only hover grows the tick; the active one just reads brighter
                (w-3 rest, w-5 hovered). Fades ride the 150ms tailwind curve. */}
              <span
                className={`h-[2px] rounded-[1px] bg-[var(--ink)] transition-[width,opacity] duration-150 ease-[cubic-bezier(0.4,0,0.2,1)] ${
                  isHovered
                    ? "w-5 opacity-80"
                    : isActive
                      ? "w-3 opacity-80"
                      : "w-3 opacity-[0.16]"
                }`}
              />
            </button>
            {isHovered && (
              <div className="pointer-events-none absolute top-1/2 left-full -translate-y-1/2">
                {/* Fixed footprint: capped height with clipped text, so the
                  card never sprawls over the transcript beneath it. */}
                <div className="menu rail-card-in flex max-h-[220px] w-[280px] flex-col gap-1.5 overflow-hidden rounded-[12px] p-2 backdrop-blur-[16px]">
                  <div className="truncate text-[12px] leading-5 text-[var(--ink)]">
                    {tick.prompt}
                  </div>
                  {tick.reply != null && (
                    <div className="line-clamp-4 text-[11px] leading-5 text-[var(--muted)]">
                      {tick.reply}
                    </div>
                  )}
                  {/* Condensed bucket: say how many prompts it stands for. */}
                  {bucketLen > 1 && (
                    <div className="text-[10px] text-[var(--muted)]">
                      {bucketLen} prompts
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

function Centered({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-1">
      <div className="text-sm text-[var(--muted)]">{title}</div>
      <div className="text-xs text-[var(--faint)]">{detail}</div>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="mt-3 flex cursor-pointer items-center gap-1.5 rounded-full bg-[#f2f2f5] px-3.5 py-1.5 text-xs text-[#0c0c0e] hover:opacity-85"
        >
          <FolderOpen size={14} strokeWidth={2} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function RenderEntry({ entry, sessionId }: { entry: Entry; sessionId: number }) {
  switch (entry.kind) {
    // The user's turn is a right-aligned bubble; the agent's is plain text on
    // the stage. One of the two has to be the ground, and there is far more
    // agent output than user input.
    case "user":
      return (
        <div className="flex w-full justify-end">
          <div className="max-w-[80%] rounded-2xl bg-[var(--bubble)] px-4 py-2.5 text-sm leading-6 whitespace-pre-wrap text-[var(--ink)]">
            {entry.text}
          </div>
        </div>
      );

    case "assistant":
      return (
        <div className="flex w-full flex-col gap-1.5">
          {/* The trailing block is the "still typing" cue — appended to the
            source text so it rides along inside whatever markdown element
            (paragraph, code fence) is still streaming in. */}
          <Markdown text={entry.streaming ? `${entry.text}▌` : entry.text} />
          {/* The footer is what marks a reply as finished, so it waits for the
            stream to settle. */}
          {!entry.streaming && entry.at !== undefined && (
            <div className="flex items-center gap-2 text-[11px] text-[var(--faint)]">
              <span>{timeLabel(entry.at)}</span>
              <CopyButton text={entry.text} />
            </div>
          )}
        </div>
      );

    // Never reached — `TranscriptView` filters these out before grouping. The
    // case stays so the switch is still exhaustive over `Entry`, and so the
    // next person sees where reasoning went.
    case "thinking":
      return null;

    case "tool":
      return <ToolCard entry={entry} />;

    case "agent_request":
      return <AgentRequestCard sessionId={sessionId} id={entry.id} request={entry.request} />;

    case "notice":
      return (
        <div
          className={`w-full rounded-xl p-2.5 text-xs whitespace-pre-wrap ${
            entry.isError
              ? "bg-[rgba(224,112,112,0.14)] text-[var(--danger)]"
              : "bg-[var(--card)] text-[var(--muted)]"
          }`}
        >
          {entry.text}
        </div>
      );
  }
}

/** Dispatches an `agent_request` entry to the card for its kind, and wires
 * its answer to the store — the one place a request's `type` decides which
 * component renders it. A future request kind (confirmation, text input, a
 * tool-approval prompt…) adds its own card and a case here; nothing upstream
 * of this function needs to know the difference. */
function AgentRequestCard({
  sessionId,
  id,
  request,
}: {
  sessionId: number;
  id: string;
  request: AgentRequest;
}) {
  const response = useEgant((s) => s.decisionResponses[`${sessionId}:${id}`] ?? null);
  const answerDecision = useEgant((s) => s.answerDecision);

  switch (request.type) {
    case "decision":
      return (
        <DecisionPrompt
          prompt={request}
          response={response}
          onSubmit={(answer) => void answerDecision(sessionId, request, answer)}
        />
      );
  }
}

/** Confirms in place rather than with a toast: the check is where the click
 * was, and it falls back to the copy icon on its own. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      title="Copy reply"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => setCopied(true));
      }}
      className="cursor-pointer rounded-sm p-0.5 hover:text-[var(--ink)]"
    >
      {copied ? (
        <Check size={12} strokeWidth={2} />
      ) : (
        <Copy size={12} strokeWidth={2} />
      )}
    </button>
  );
}

/** One table row per outstanding request, like other agent apps: what the
 * agent wants, the exact resource, and Allow once / Always allow / Deny.
 * "Always allow" says what it saves: the rule the CLI suggested (Claude) —
 * never a switch of mode — or, on opencode, which has no rules, that it stops
 * asking in this chat. Allow on a turn-based wire (opencode) retries the turn
 * with auto-approve; on a live wire (Claude) it answers mid-turn. */
function PermissionTable({
  items,
  agent,
  cwd,
  onAnswer,
}: {
  items: PendingPermission[];
  agent: string;
  cwd: string;
  onAnswer: (requestId: string, reply: PermissionReply) => void;
}) {
  return (
    <div className="composer flex w-full flex-col gap-2 rounded-xl p-3">
      <div className="flex items-baseline gap-2">
        <div className="text-sm text-[var(--ink)]">
          {items.length === 1 ? "Permission needed" : `${items.length} permissions needed`}
        </div>
        <div className="text-[11px] text-[var(--faint)]">
          Nothing runs until you answer
        </div>
      </div>
      <div className="flex w-full flex-col gap-1.5">
        {items.map((pending) => (
          <PermissionRow
            key={pending.requestId}
            pending={pending}
            agent={agent}
            cwd={cwd}
            onAnswer={(reply) => onAnswer(pending.requestId, reply)}
          />
        ))}
      </div>
    </div>
  );
}

function PermissionRow({
  pending,
  agent,
  cwd,
  onAnswer,
}: {
  pending: PendingPermission;
  agent: string;
  cwd: string;
  onAnswer: (reply: PermissionReply) => void;
}) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState("");
  const always = describeAlwaysAllow(pending, agent);
  // A note for the agent and "stop the turn" need a live channel to ride:
  // opencode's denial has already happened by the time the row shows.
  const live = agent !== "opencode";
  const resource = permissionSummary(pending.input);
  const description = pending.description?.trim() || null;
  const root = cwd.endsWith("/") ? cwd : `${cwd}/`;
  const outside =
    pending.blockedPath && !pending.blockedPath.startsWith(root) ? pending.blockedPath : null;

  const deny = (stop: boolean) =>
    onAnswer({ decision: "deny", feedback: note.trim() || undefined, stop });

  return (
    <div className="flex w-full flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2.5">
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded-md bg-[var(--bubble)] px-1.5 py-0.5 font-mono text-[11px] text-[var(--ink)]">
          {pending.toolName}
        </span>
        <span className="flex-1 truncate text-xs text-[var(--muted)]" title={resource}>
          {truncate(description ?? resource, 200)}
        </span>
      </div>
      {description && (
        <div className="truncate font-mono text-[11px] text-[var(--faint)]" title={resource}>
          {truncate(resource, 300)}
        </div>
      )}
      {outside && (
        <div className="truncate text-[11px] text-[var(--faint)]" title={outside}>
          Outside this project: <span className="font-mono">{outside}</span>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => onAnswer({ decision: "allow" })}
          className="cursor-pointer rounded-full bg-[#f2f2f5] px-3 py-1 text-xs text-[#0c0c0e] hover:opacity-85"
        >
          Allow once
        </button>
        {always && (
          <button
            type="button"
            title={always.detail}
            onClick={() => onAnswer({ decision: "allow-always" })}
            className="max-w-[320px] cursor-pointer truncate rounded-full bg-[var(--bubble)] px-3 py-1 text-xs text-[var(--ink)] hover:opacity-85"
          >
            {always.label}
          </button>
        )}
        <span className="flex items-center">
          <button
            type="button"
            onClick={() => onAnswer({ decision: "deny" })}
            className="cursor-pointer rounded-full bg-transparent py-1 pr-1 pl-3 text-xs text-[var(--muted)] hover:text-[var(--ink)]"
          >
            Deny
          </button>
          {live && (
            <button
              type="button"
              title="Deny with a note, or stop the turn"
              aria-expanded={denying}
              onClick={() => setDenying((v) => !v)}
              className="cursor-pointer rounded-full p-1 text-[var(--faint)] hover:text-[var(--ink)]"
            >
              <ChevronDown
                size={12}
                strokeWidth={2}
                className={`transition-transform ${denying ? "rotate-180" : ""}`}
              />
            </button>
          )}
        </span>
      </div>
      {denying && live && (
        <div className="flex flex-col gap-1.5">
          <input
            autoFocus
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) deny(false);
              if (e.key === "Escape") setDenying(false);
            }}
            placeholder="Tell Claude what to do instead…"
            className="w-full rounded-md border border-[var(--border)] bg-[rgba(0,0,0,0.15)] px-2 py-1.5 text-xs text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
          />
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => deny(false)}
              className="cursor-pointer rounded-full bg-[var(--bubble)] px-3 py-1 text-xs text-[var(--ink)] hover:opacity-85"
            >
              {note.trim() ? "Deny with note" : "Deny"}
            </button>
            <button
              type="button"
              title="Refuse and end this turn, the way Stop does"
              onClick={() => deny(true)}
              className="cursor-pointer rounded-full bg-transparent px-3 py-1 text-xs text-[var(--danger)] hover:bg-[var(--hover)]"
            >
              Deny &amp; stop
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
