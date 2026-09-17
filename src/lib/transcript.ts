// The renderable shape of a conversation, folded on the frontend.
// A mechanical port of `Transcript::apply` in `crates/harness/src/transcript.rs`:
// the backend owns the canonical transcript, the window owns this mirror and
// folds each `session-event` into it so streaming costs one small payload per
// token instead of a full snapshot per token.

import type {
  Entry,
  HarnessEvent,
  SessionUsage,
  TranscriptDto,
  TranscriptState,
  TurnState,
  TurnUsage,
} from "./types";

export function emptyTranscript(): TranscriptState {
  return {
    entries: [],
    state: "idle",
    sessionId: null,
    model: null,
    tools: [],
    pending: null,
    totalCostUsd: 0,
    lastTurnMs: 0,
    usage: emptyUsage(),
    toolIndex: {},
    turnStartedAt: null,
  };
}

export function emptyUsage(): SessionUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    turns: 0,
    contextTokens: 0,
    contextWindow: 0,
  };
}

/** Folds one turn's accounting into a session's running totals — a mechanical
 * port of `SessionUsage::record`, so the live fold and a re-fetched snapshot
 * never disagree. */
export function recordUsage(session: SessionUsage, turn: TurnUsage): SessionUsage {
  const turnTotal =
    turn.inputTokens + turn.outputTokens + turn.cacheCreationTokens + turn.cacheReadTokens;
  // A turn the backend never accounted for — interrupted before it settled,
  // or run on a wire that reports no tokens — must not inflate the turn count
  // or blank a meter that was reading correctly.
  if (turnTotal <= 0) return session;
  return {
    inputTokens: session.inputTokens + turn.inputTokens,
    outputTokens: session.outputTokens + turn.outputTokens,
    cacheCreationTokens: session.cacheCreationTokens + turn.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens + turn.cacheReadTokens,
    totalTokens: session.totalTokens + turnTotal,
    turns: session.turns + 1,
    // Replaced, not added: see `SessionUsage`.
    contextTokens: turnTotal,
    contextWindow: turn.contextWindow > 0 ? turn.contextWindow : session.contextWindow,
  };
}

/** A snapshot fetched over IPC gains its tool index by scanning once. */
export function fromDto(dto: TranscriptDto): TranscriptState {
  const toolIndex: Record<string, number> = {};
  dto.entries.forEach((entry, index) => {
    if (entry.kind === "tool") toolIndex[entry.id] = index;
  });
  // A turn already in flight when the window adopts the snapshot started
  // before this clock existed; counting from now is the honest answer
  // available, and it only ever affects a mid-turn reload.
  return { ...dto, toolIndex, turnStartedAt: dto.state === "idle" ? null : Date.now() };
}

/** Records a turn the user just sent, before the agent has replied. The
 * backend applies the same echo, and both folds are deterministic, so they
 * agree — this is what makes the message appear on keypress. */
export function pushUser(prev: TranscriptState, text: string): TranscriptState {
  return {
    ...prev,
    entries: [...prev.entries, { kind: "user", text }],
    state: "running",
    // The turn starts on keypress, not on the agent's first byte — that gap is
    // exactly the part of the wait the status line exists to account for.
    turnStartedAt: prev.turnStartedAt ?? Date.now(),
  };
}

/** Clears a permission prompt the user just answered. The backend applies the
 * same transition; no event will restate it. */
export function resolvePermission(prev: TranscriptState): TranscriptState {
  return {
    ...prev,
    pending: null,
    state: "running",
    turnStartedAt: prev.turnStartedAt ?? Date.now(),
  };
}

/** Folds one event, then keeps the turn clock in step with the state the fold
 * landed on: a turn that is running has a start stamp, an idle one has none.
 * Done once out here rather than in nine branches — every event that moves the
 * state passes through this. */
export function applyEvent(prev: TranscriptState, event: HarnessEvent): TranscriptState {
  const next = foldEvent(prev, event);
  if (next.state === "idle") {
    return next.turnStartedAt === null ? next : { ...next, turnStartedAt: null };
  }
  return next.turnStartedAt === null ? { ...next, turnStartedAt: Date.now() } : next;
}

function foldEvent(prev: TranscriptState, event: HarnessEvent): TranscriptState {
  // Shallow copies; the helpers below mutate the copies, never `prev`.
  const s: TranscriptState = {
    ...prev,
    entries: [...prev.entries],
    toolIndex: { ...prev.toolIndex },
  };

  switch (event.type) {
    case "ready":
      return {
        ...s,
        sessionId: event.session_id,
        model: event.model,
        tools: event.tools,
      };

    case "assistant_delta":
      appendStreaming(s, event.text, false);
      return { ...s, state: "running" };

    case "thinking_delta":
      appendStreaming(s, event.text, true);
      return { ...s, state: "running" };

    // The settled message supersedes whatever the deltas built: same content,
    // but canonical. Replacing avoids doubled text when a backend sends both.
    case "assistant_message": {
      const last = s.entries[s.entries.length - 1];
      if (last?.kind === "assistant" && last.streaming) {
        s.entries[s.entries.length - 1] = {
          kind: "assistant",
          text: event.text,
          streaming: false,
          at: last.at,
        };
      } else {
        s.entries.push({
          kind: "assistant",
          text: event.text,
          streaming: false,
          at: Date.now(),
        });
      }
      settleStreaming(s.entries);
      return s;
    }

    case "tool_use":
      settleStreaming(s.entries);
      s.toolIndex[event.id] = s.entries.length;
      s.entries.push({
        kind: "tool",
        id: event.id,
        name: event.name,
        input: event.input,
        output: null,
        isError: false,
      });
      return s;

    case "tool_result": {
      const index = s.toolIndex[event.id];
      if (index !== undefined) {
        const entry = s.entries[index];
        if (entry?.kind === "tool") {
          s.entries[index] = { ...entry, output: event.output, isError: event.is_error };
        }
      }
      return s;
    }

    case "permission_request":
      return {
        ...s,
        state: "awaiting_permission",
        pending: {
          requestId: event.request_id,
          toolName: event.tool_name,
          input: event.input,
        },
      };

    case "turn_ended": {
      settleStreaming(s.entries);
      const next: TranscriptState = {
        ...s,
        state: "idle",
        totalCostUsd: s.totalCostUsd + event.cost_usd,
        lastTurnMs: event.duration_ms,
        usage: recordUsage(s.usage, event.usage),
      };
      if (event.is_error && event.result) {
        next.entries = [...next.entries, { kind: "notice", text: event.result, isError: true }];
      }
      return next;
    }

    case "error":
      return {
        ...s,
        entries: [...s.entries, { kind: "notice", text: event.message, isError: true }],
      };

    case "exited": {
      settleStreaming(s.entries);
      const failed = event.code !== null && event.code !== 0;
      return {
        ...s,
        state: "idle",
        entries: [
          ...s.entries,
          {
            kind: "notice",
            text:
              event.code === null
                ? "Agent exited."
                : `Agent exited with status ${event.code}.`,
            isError: failed,
          },
        ],
      };
    }
  }
}

/** Appends a delta to the open entry of the matching kind, opening one if the
 * last entry is something else (a tool call, say). */
function appendStreaming(s: TranscriptState, delta: string, thinking: boolean): void {
  const last = s.entries[s.entries.length - 1];
  if (thinking && last?.kind === "thinking" && last.streaming) {
    s.entries[s.entries.length - 1] = { ...last, text: last.text + delta };
    return;
  }
  if (!thinking && last?.kind === "assistant" && last.streaming) {
    s.entries[s.entries.length - 1] = { ...last, text: last.text + delta };
    return;
  }
  s.entries.push(
    thinking
      ? { kind: "thinking", text: delta, streaming: true, at: Date.now() }
      : { kind: "assistant", text: delta, streaming: true, at: Date.now() },
  );
}

/** Closes every still-open entry at the tail. Stops at the first settled one:
 * anything older was closed by an earlier call. */
function settleStreaming(entries: Entry[]): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if ((entry.kind === "assistant" || entry.kind === "thinking") && entry.streaming) {
      entries[i] =
        entry.kind === "thinking" && entry.at !== undefined
          ? { ...entry, streaming: false, elapsedMs: Date.now() - entry.at }
          : { ...entry, streaming: false };
    } else {
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Display helpers (ported from the GPUI shell's panes)
// ---------------------------------------------------------------------------

/** How long a session has been open, as the sidebar writes it: `now`, `5m`,
 * `9h`, `2d`. */
export function ageLabel(startedUnixMs: number, nowMs: number): string {
  const seconds = Math.max(0, Math.floor((nowMs - startedUnixMs) / 1000));
  if (seconds <= 59) return "now";
  if (seconds <= 3599) return `${Math.floor(seconds / 60)}m`;
  if (seconds <= 86_399) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

/** The moment a reply landed, as the line under it reads: `Sep 15, 4:09 PM`. */
export function timeLabel(atMs: number): string {
  return new Date(atMs).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The window to measure against before an agent has named its own. Every
 * current Claude model ships with at least this much, and a session running a
 * larger one (`claude-opus-5[1m]`) reports its real window on the first turn,
 * so this only ever governs an empty transcript. */
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** How full the context window is, 0..1. */
export function contextFraction(usage: SessionUsage): number {
  const window = usage.contextWindow > 0 ? usage.contextWindow : DEFAULT_CONTEXT_WINDOW;
  return Math.min(1, usage.contextTokens / window);
}

/** The window a reading is measured against, resolved for display. */
export function contextWindow(usage: SessionUsage): number {
  return usage.contextWindow > 0 ? usage.contextWindow : DEFAULT_CONTEXT_WINDOW;
}

/** Token counts at a glance: `25k`, `1.2M`. Exact figures belong in the
 * usage popover, not in a badge two characters wide. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** Session spend. Sub-cent totals still deserve a real number — a session
 * that cost $0.004 reading `$0.00` looks like it cost nothing. */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/** A live Claude session reports back the fully-resolved model id it's
 * actually running as (e.g. "claude-haiku-4-5-20251001", "claude-opus-5[1m]")
 * rather than the short alias the picker offers ("haiku", "opus-5") — so
 * looking that id up in the curated catalog never matches once a session is
 * running, and the composer fell back to showing the raw id, date stamp and
 * all. This reconstructs the same "Haiku 4.5" / "Opus 5" shape the catalog
 * uses, so a running session's badge stays readable. Only meaningful for
 * Claude's id shape — callers should use it only as a `claude` fallback, not
 * a general-purpose formatter for other agents' ids. */
export function prettyClaudeModelId(id: string): string {
  const stripped = id
    .replace(/\[[^\]]*\]$/, "") // trailing capability tag, e.g. "[1m]"
    .replace(/-\d{8}$/, "") // trailing release date, e.g. "-20251001"
    .replace(/^claude-/, "");
  const parts = stripped.split("-").filter(Boolean);
  if (parts.length === 0) return id;
  const [family, ...version] = parts;
  const name = family.charAt(0).toUpperCase() + family.slice(1);
  return version.length > 0 ? `${name} ${version.join(".")}` : name;
}

/** What the mode pill reads — the same names Claude Code Desktop's own mode
 * picker uses (`claude --permission-mode`'s real choices), not an invented
 * set. `"auto"` is also the fallback for any id this doesn't recognize. */
export function modeLabel(mode: string): string {
  switch (mode) {
    case "manual":
      return "Manual";
    case "plan":
      return "Plan";
    case "acceptEdits":
      return "Accept edits";
    case "bypassPermissions":
      return "Bypass permissions";
    default:
      return "Auto";
  }
}

/** The words the status line cycles through while a turn is in flight. They
 * say nothing about what the agent is doing — that is the point: the line is
 * there to prove the turn is alive, and a rotating word does that without
 * pretending to narrate work the window can't see. */
const STATUS_VERBS = [
  "Thinking",
  "Pondering",
  "Musing",
  "Noodling",
  "Percolating",
  "Ruminating",
  "Cogitating",
  "Simmering",
  "Brewing",
  "Mulling",
  "Deliberating",
  "Conjuring",
  "Tinkering",
  "Puzzling",
  "Spelunking",
  "Marinating",
  "Churning",
  "Working",
];

/** How long one word holds before the next takes over. Slow enough to read,
 * quick enough that the line never looks frozen. */
const VERB_HOLD_MS = 3400;

/** Which word the status line is on, `elapsedMs` into a turn that started at
 * `startedAt`. Derived rather than stored, so every re-render of the same
 * moment agrees — and seeded off the start stamp so two turns in a row don't
 * open on the same word. */
export function statusVerb(startedAt: number, elapsedMs: number): string {
  const seed = Math.floor(Math.max(0, startedAt) / 1000);
  const step = Math.floor(Math.max(0, elapsedMs) / VERB_HOLD_MS);
  return STATUS_VERBS[(seed + step) % STATUS_VERBS.length]!;
}

/** A turn's age, as the status line writes it: `4s`, then `1m 12s` once
 * seconds alone stop being readable at a glance. */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export function stateLabel(state: TurnState, ended: boolean): string {
  if (ended) return "Ended";
  switch (state) {
    case "running":
      return "Working";
    case "awaiting_permission":
      return "Waiting";
    default:
      return "Ready";
  }
}

/** A one-line summary for a tool call: the argument that identifies it,
 * falling back to the tool name. */
export function toolSummary(input: unknown, name: string): string {
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "prompt"]) {
      const value = record[key];
      if (typeof value === "string") return value.split("\n")[0] ?? value;
    }
  }
  return name;
}

/** The last path segment, for a tool card's title — `/a/b/c.ts` → `c.ts`.
 * Falls back to the whole string for a bare filename or an empty path. */
export function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

export interface EditOp {
  old_string: string;
  new_string: string;
}

/** `Edit` and `MultiEdit` inputs differ in shape (one op vs. an `edits`
 * array) but the card renders them identically — one diff per op. */
export function normalizeEdit(
  name: string,
  input: unknown,
): { filePath: string; edits: EditOp[] } {
  const record = (input ?? {}) as Record<string, unknown>;
  const filePath = typeof record.file_path === "string" ? record.file_path : "";

  if (name === "MultiEdit" && Array.isArray(record.edits)) {
    const edits = record.edits
      .filter((edit): edit is Record<string, unknown> => edit !== null && typeof edit === "object")
      .map((edit) => ({
        old_string: typeof edit.old_string === "string" ? edit.old_string : "",
        new_string: typeof edit.new_string === "string" ? edit.new_string : "",
      }));
    return { filePath, edits };
  }

  return {
    filePath,
    edits: [
      {
        old_string: typeof record.old_string === "string" ? record.old_string : "",
        new_string: typeof record.new_string === "string" ? record.new_string : "",
      },
    ],
  };
}

/** Strips a leading line-number prefix from the `Read` tool's output —
 * Claude's own `cat -n` style (`"    12\tconst x = 1;"`) and the `"12: "`
 * style the harness normalizes opencode's `read` tool down to. Left alone
 * when a line doesn't match, so odd output degrades to showing the raw
 * text. */
export function stripLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+(?:\t|: )/, ""))
    .join("\n");
}

/** The permission card shows the argument that actually says what will
 * happen, not the whole input blob — for Bash the command, for edits the
 * path. */
export function permissionSummary(input: unknown): string {
  if (input !== null && typeof input === "object") {
    const record = input as Record<string, unknown>;
    const command = record["command"];
    if (typeof command === "string") return command;
    const filePath = record["file_path"];
    if (typeof filePath === "string") return filePath;
  }
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

/** Tool output can be megabytes; the transcript shows the head and says so.
 * Never splits a UTF-8 character: the cut walks back over continuation
 * bytes. */
export function truncate(text: string, limit: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= limit) return text;
  let end = limit;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const head = new TextDecoder().decode(bytes.slice(0, end));
  return `${head}\n… ${bytes.length - end} more bytes`;
}

/** The project's colour dot, from the backend's stable hue. */
export function projectColor(hue: number): string {
  return `hsl(${hue * 360} 62% 58%)`;
}
