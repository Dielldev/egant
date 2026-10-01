// The renderable shape of a conversation, folded on the frontend.
// A mechanical port of `Transcript::apply` in `crates/harness/src/transcript.rs`:
// the backend owns the canonical transcript, the window owns this mirror and
// folds each `session-event` into it so streaming costs one small payload per
// token instead of a full snapshot per token.

import type {
  AskQuestion,
  DecisionOption,
  DecisionRequest,
  DecisionResponse,
  Entry,
  HarnessEvent,
  PendingPermission,
  PermissionUpdate,
  SessionUsage,
  TranscriptDto,
  TranscriptState,
  TurnProgress,
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
    pendingList: [],
    totalCostUsd: 0,
    lastTurnMs: 0,
    usage: emptyUsage(),
    toolIndex: {},
    turnStartedAt: null,
    progress: null,
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
 * never disagree. Spend accumulates; the context reading is owned by
 * `context_update` events and left alone here, because a turn's totals sum
 * every API call in a multi-step turn. */
export function recordUsage(session: SessionUsage, turn: TurnUsage): SessionUsage {
  const turnTotal =
    turn.inputTokens + turn.outputTokens + turn.cacheCreationTokens + turn.cacheReadTokens;
  // A turn the backend never accounted for — interrupted before it settled,
  // or run on a wire that reports no tokens — must not inflate the turn count.
  if (turnTotal <= 0) return session;
  return {
    inputTokens: session.inputTokens + turn.inputTokens,
    outputTokens: session.outputTokens + turn.outputTokens,
    cacheCreationTokens: session.cacheCreationTokens + turn.cacheCreationTokens,
    cacheReadTokens: session.cacheReadTokens + turn.cacheReadTokens,
    totalTokens: session.totalTokens + turnTotal,
    turns: session.turns + 1,
    // Replaced by `context_update`, not added: see `SessionUsage`.
    contextTokens: session.contextTokens,
    contextWindow: turn.contextWindow > 0 ? turn.contextWindow : session.contextWindow,
  };
}

/** A snapshot fetched over IPC gains its tool index by scanning once. */
export function fromDto(dto: TranscriptDto): TranscriptState {
  // The backend only ever stores plain assistant text — a decision request
  // embedded in it (see `extractDecisions` below) is entirely a frontend
  // reading of that text, so a restored snapshot has to be split exactly the
  // same way the live fold splits it, or a reload would show the raw fence
  // instead of the card.
  const entries = dto.entries.flatMap((entry) =>
    entry.kind === "assistant" && !entry.streaming ? splitAssistant(entry) : [entry],
  );
  const toolIndex: Record<string, number> = {};
  entries.forEach((entry, index) => {
    if (entry.kind === "tool") toolIndex[entry.id] = index;
  });
  // Snapshots from backends written before the table carry `pending` but no
  // `pendingList` — mirror the single row so the table still renders it.
  const pendingList =
    dto.pendingList ??
    (dto.pending != null ? [{ ...dto.pending }] : []);
  const pending = pendingList[0] ?? dto.pending ?? null;
  // A turn already in flight when the window adopts the snapshot started
  // before this clock existed; counting from now is the honest answer
  // available, and it only ever affects a mid-turn reload.
  return {
    ...dto,
    entries,
    pending,
    pendingList,
    toolIndex,
    turnStartedAt: dto.state === "idle" ? null : Date.now(),
    progress: dto.progress ?? null,
  };
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
 * same transition; no event will restate it. With a request id, clears just
 * that table row (and keeps awaiting while rows remain); without one, clears
 * the whole table (legacy single-card callers). */
export function resolvePermission(
  prev: TranscriptState,
  requestId?: string,
): TranscriptState {
  if (requestId == null) {
    return {
      ...prev,
      pending: null,
      pendingList: [],
      state: "running",
      turnStartedAt: prev.turnStartedAt ?? Date.now(),
    };
  }
  const pendingList = (prev.pendingList ?? []).filter((p) => p.requestId !== requestId);
  const pending = pendingList[0] ?? null;
  return {
    ...prev,
    pending,
    pendingList,
    state: pendingList.length > 0 ? "awaiting_permission" : "running",
    turnStartedAt: prev.turnStartedAt ?? Date.now(),
  };
}

/** Marks the turn as running without adding a transcript entry. Answering a
 * decision prompt already has its own inline representation — the card
 * flips into its completed state in place — so this drives the turn clock
 * and status line the same way `pushUser` does for a typed message, without
 * echoing a redundant user bubble underneath the card. */
export function markRunning(prev: TranscriptState): TranscriptState {
  return {
    ...prev,
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

/** The events that end whatever a turn was waiting on (`progress`): the agent
 * produced something, or the turn is over. A retry that went through shows up
 * as the reply it brought back, not as a frame of its own. */
const MOVES_ON = new Set<HarnessEvent["type"]>([
  "assistant_delta",
  "thinking_delta",
  "assistant_message",
  "tool_use",
  "tool_result",
  "permission_request",
  "compacted",
  "turn_ended",
  "exited",
]);

function foldEvent(prev: TranscriptState, event: HarnessEvent): TranscriptState {
  // Shallow copies; the helpers below mutate the copies, never `prev`.
  const s: TranscriptState = {
    ...prev,
    entries: [...prev.entries],
    toolIndex: { ...prev.toolIndex },
  };
  // Anything the agent produces, or the turn ending, means whatever it was
  // waiting on is over — the same rule as `Transcript::apply`.
  if (MOVES_ON.has(event.type)) s.progress = null;

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
      finalizeAssistantEntry(s.entries, s.entries.length - 1);
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
          s.entries[index] = {
            ...entry,
            output: event.output,
            isError: event.is_error,
            ...(event.bytes !== undefined ? { outputBytes: event.bytes } : {}),
          };
        }
      }
      return s;
    }

    case "permission_request": {
      const incoming: PendingPermission = {
        requestId: event.request_id,
        toolName: event.tool_name,
        input: event.input,
        patterns: event.patterns ?? [],
        alwaysPatterns: event.always_patterns ?? [],
        suggestions: event.suggestions ?? [],
        description: event.description ?? null,
        blockedPath: event.blocked_path ?? null,
      };
      // Re-asks replace; new ids append — the table holds every outstanding
      // prompt, and `pending` mirrors the first for legacy readers.
      const pendingList = [...(s.pendingList ?? [])];
      const at = pendingList.findIndex((p) => p.requestId === incoming.requestId);
      if (at >= 0) pendingList[at] = incoming;
      else pendingList.push(incoming);
      return {
        ...s,
        state: "awaiting_permission",
        pending: pendingList[0] ?? null,
        pendingList,
      };
    }

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

    case "progress":
      return { ...s, progress: event.progress };

    // The window holds the summary now, not the conversation it summarized:
    // the conversation's own new size stands in until the next request
    // measures the whole prompt again (see `Transcript::apply`).
    case "compacted": {
      settleStreaming(s.entries);
      s.entries.push({
        kind: "compaction",
        auto: event.auto,
        tokensBefore: event.tokens_before,
        tokensAfter: event.tokens_after,
      });
      if (event.tokens_after != null) {
        s.usage = { ...s.usage, contextTokens: event.tokens_after };
      }
      return s;
    }

    case "model_fallback":
      return {
        ...s,
        entries: [...s.entries, { kind: "notice", text: event.message, isError: false }],
      };

    case "error":
      return {
        ...s,
        entries: [...s.entries, { kind: "notice", text: event.message, isError: true }],
      };

    // The mode belongs to the session row, not the conversation: the store
    // patches the row from the same event.
    case "mode_changed":
      return prev;

    case "context_update": {
      const usage = { ...s.usage, contextTokens: event.context_tokens };
      if (event.context_window > 0) usage.contextWindow = event.context_window;
      return { ...s, usage };
    }

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
  // A new block has begun, so the one before it is done — the same rule as
  // `append_streaming` in Rust. Without it the thinking before a reply never
  // settles: nothing later settles past the reply sitting after it.
  settleStreaming(s.entries);
  s.entries.push(
    thinking
      ? { kind: "thinking", text: delta, streaming: true, at: Date.now() }
      : { kind: "assistant", text: delta, streaming: true, at: Date.now() },
  );
}

/** Closes every still-open entry at the tail. Stops at the first settled one:
 * anything older was closed by an earlier call. An assistant entry that
 * settles here goes through the same decision-fence split an explicit
 * `assistant_message` gets — a streamed reply that never got one (the turn
 * ended, or a tool call interrupted it) must not skip the split just because
 * it closed a different way. */
function settleStreaming(entries: Entry[]): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === "assistant" && entry.streaming) {
      entries[i] = { ...entry, streaming: false };
      finalizeAssistantEntry(entries, i);
      continue;
    }
    if (entry.kind === "thinking" && entry.streaming) {
      entries[i] =
        entry.at !== undefined
          ? { ...entry, streaming: false, elapsedMs: Date.now() - entry.at }
          : { ...entry, streaming: false };
      continue;
    }
    break;
  }
}

// ---------------------------------------------------------------------------
// Decision prompts embedded in assistant text — a ```decision fenced block
// (or a ```json block that opts in with `"type": "decision"`) is the agent's
// way of pausing to ask the user to choose. Recognized here, on the settled
// text, rather than as a distinct wire event: it works identically across
// every harness (Claude, Codex, opencode all stream plain assistant text the
// same way) and survives a reload for free, since the Rust transcript only
// ever has to remember the raw text.
// ---------------------------------------------------------------------------

const DECISION_FENCE_RE = /```(decision|json)[ \t]*\r?\n([\s\S]*?)\r?\n?```/gi;

/** Small deterministic string hash (djb2-ish), used only to mint a stable id
 * for a decision payload that didn't supply its own — same input, same id,
 * across every reload. Not cryptographic; doesn't need to be. */
function simpleHash(input: string): string {
  let h = 0;
  for (let i = 0; i < input.length; i++) {
    h = (Math.imul(31, h) + input.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

/** Normalizes one fenced block's parsed JSON into a `DecisionRequest`, or
 * `null` when it isn't one — malformed JSON, no options, or (for a bare
 * ```json fence) no explicit `"type": "decision"` opt-in. The `json` fence
 * has to opt in explicitly: unlike a ```decision fence, its language alone
 * says nothing about intent, and treating every JSON example the agent shows
 * as a live prompt would misfire on ordinary sample output. */
function tryNormalizeDecision(lang: string, body: string, fallbackSeed: string): DecisionRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const raw = parsed as Record<string, unknown>;
  if (lang.toLowerCase() === "json" && raw.type !== "decision") return null;
  if (!Array.isArray(raw.options)) return null;

  const options: DecisionOption[] = [];
  raw.options.forEach((item, i) => {
    if (item === null || typeof item !== "object") return;
    const o = item as Record<string, unknown>;
    const label = typeof o.label === "string" && o.label.trim() ? o.label : null;
    if (!label) return;
    options.push({
      id: typeof o.id === "string" && o.id ? o.id : `opt-${i}`,
      label,
      description: typeof o.description === "string" ? o.description : undefined,
    });
  });
  if (options.length === 0) return null;

  // Accepts the exact shape this app's own docs describe (`title`) as well
  // as the shape a question-asking tool call would carry (`question`,
  // `multiSelect`), so either convention an agent reaches for just works.
  const title =
    (typeof raw.title === "string" && raw.title.trim()) ||
    (typeof raw.question === "string" && raw.question.trim()) ||
    "Choose an option";
  const multi = raw.selectionMode === "multiple" || raw.multiSelect === true;

  return {
    type: "decision",
    id: typeof raw.id === "string" && raw.id ? raw.id : `dec-${simpleHash(body)}-${fallbackSeed}`,
    title,
    description: typeof raw.description === "string" ? raw.description : undefined,
    options,
    selectionMode: multi ? "multiple" : "single",
    allowCustomInput: raw.allowCustomInput === true,
  };
}

/** Pulls every decision fence out of an assistant message's text, returning
 * the prose with those fences removed (trimmed) alongside the requests they
 * parsed into. A fence that fails to parse — or isn't a decision — is left
 * exactly as written, so it still renders as an ordinary code block instead
 * of silently vanishing. */
export function extractDecisions(text: string): { text: string; decisions: DecisionRequest[] } {
  const decisions: DecisionRequest[] = [];
  const cleaned = text.replace(DECISION_FENCE_RE, (match: string, lang: string, body: string) => {
    const request = tryNormalizeDecision(lang, body.trim(), String(decisions.length));
    if (!request) return match;
    decisions.push(request);
    return "";
  });
  return { text: cleaned.trim(), decisions };
}

/** Splits one settled assistant entry into the entries it should actually
 * render as: itself, unchanged, when it carries no decision fence; otherwise
 * its stripped prose (dropped entirely when nothing is left) followed by one
 * `agent_request` entry per fence, in the order they appeared. Shared by the
 * live fold and `fromDto`, so a freshly streamed reply and one restored from
 * a snapshot always land on the same structure. */
function splitAssistant(entry: Extract<Entry, { kind: "assistant" }>): Entry[] {
  const { text, decisions } = extractDecisions(entry.text);
  if (decisions.length === 0) return [entry];
  const out: Entry[] = [];
  if (text.length > 0) out.push({ ...entry, text });
  for (const request of decisions) {
    out.push({ kind: "agent_request", id: request.id, request, response: null });
  }
  return out;
}

/** Applies `splitAssistant` in place at `index`, growing `entries` in place
 * when the entry there turns out to carry a decision fence. */
function finalizeAssistantEntry(entries: Entry[], index: number): void {
  const entry = entries[index];
  if (entry?.kind !== "assistant") return;
  const replacement = splitAssistant(entry);
  if (replacement.length === 1 && replacement[0] === entry) return;
  entries.splice(index, 1, ...replacement);
}

/** The plain-text turn a decision answer becomes on the wire — sending a new
 * user turn is the one continuation mechanism every harness shares, so it's
 * also how the agent "sees" the answer and carries on. The pick is already
 * shown inline by the card itself, so this never has to also appear as its
 * own chat bubble — see `markRunning`. */
export function formatDecisionReply(prompt: DecisionRequest, response: DecisionResponse): string {
  const picks = response.selectedOptionIds.map(
    (id) => prompt.options.find((o) => o.id === id)?.label ?? id,
  );
  const lines = [`Decision — ${prompt.title}`, `Selected: ${picks.length > 0 ? picks.join(", ") : "(none)"}`];
  if (response.customText) lines.push(`Note: ${response.customText}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Permission requests: questions, plans, and what "always allow" saves
// ---------------------------------------------------------------------------

/** Claude's built-in tools whose permission request is really a question for
 * the person. Mirrors `egant_harness::{ASK_USER_QUESTION, EXIT_PLAN_MODE}`. */
export const ASK_USER_QUESTION = "AskUserQuestion";
export const EXIT_PLAN_MODE = "ExitPlanMode";

export function isInteractiveTool(toolName: string): boolean {
  return toolName === ASK_USER_QUESTION || toolName === EXIT_PLAN_MODE;
}

/** Whether a pending request gets a card of its own (a question, a plan)
 * rather than a row in the permission table. A question whose input isn't
 * the tool's shape stays in the table, where it can at least be refused. */
export function isCardRequest(pending: PendingPermission): boolean {
  return (
    isInteractiveTool(pending.toolName) &&
    (pending.toolName !== ASK_USER_QUESTION || askQuestions(pending.input).length > 0)
  );
}

/** The one suggestion an "always allow" answer applies — the rule the CLI
 * proposed, else access to the directory it named, never a mode switch. The
 * backend makes the same pick (`egant_harness::always_allow_update`); this is
 * so the button can say what it will save. */
export function alwaysAllowUpdate(suggestions: PermissionUpdate[] | undefined): PermissionUpdate | null {
  const list = suggestions ?? [];
  return (
    list.find((s) => s.type === "addRules") ?? list.find((s) => s.type === "addDirectories") ?? null
  );
}

/** Where a permission update is kept, as a few words after the rule. */
function destinationLabel(destination: string | undefined): string {
  switch (destination) {
    case "localSettings":
      return "in this project";
    case "projectSettings":
      return "in this project, for everyone";
    case "userSettings":
      return "in every project";
    case "session":
      return "for this chat";
    default:
      return "";
  }
}

/** What "Always allow" will do for one request, in the button's words and a
 * fuller tooltip. `null` when the request has nothing wider to approve. */
export function describeAlwaysAllow(
  pending: PendingPermission,
  agent: string,
): { label: string; detail: string } | null {
  if (agent === "opencode") {
    return {
      label: "Always allow",
      detail: "opencode can't save a rule: this stops it asking for anything in this chat (Bypass permissions).",
    };
  }
  const update = alwaysAllowUpdate(pending.suggestions);
  if (update?.type === "addRules") {
    const rule = update.rules?.[0];
    if (rule) {
      const text = rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
      const where = destinationLabel(update.destination);
      return {
        label: `Always allow ${text}`,
        detail: `Saves ${text} as an allowed rule${where ? ` ${where}` : ""}, so it won't ask for it again. Everything else still asks.`,
      };
    }
  }
  if (update?.type === "addDirectories" && update.directories?.[0]) {
    const dir = update.directories[0];
    const where = destinationLabel(update.destination);
    return {
      label: "Always allow this folder",
      detail: `Allows working in ${dir}${where ? ` ${where}` : ""}.`,
    };
  }
  // No rule offered: the backend remembers this request's patterns for the
  // rest of the run instead (`remember_patterns`).
  const patterns = [...(pending.patterns ?? []), ...(pending.alwaysPatterns ?? [])].filter(
    (p, i, all) => p && all.indexOf(p) === i,
  );
  return {
    label: "Allow for this chat",
    detail:
      patterns.length > 0
        ? `Won't ask again for ${patterns.join(", ")} until the app restarts.`
        : "Won't ask again for this until the app restarts.",
  };
}

/** The questions of an AskUserQuestion request, or `[]` when its input isn't
 * the shape the tool takes. */
export function askQuestions(input: unknown): AskQuestion[] {
  const questions = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(questions)) return [];
  return questions.flatMap((raw): AskQuestion[] => {
    if (raw === null || typeof raw !== "object") return [];
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string" || !Array.isArray(q.options)) return [];
    const options = q.options.flatMap((o): AskQuestion["options"] => {
      if (o === null || typeof o !== "object") return [];
      const opt = o as Record<string, unknown>;
      if (typeof opt.label !== "string") return [];
      return [{ label: opt.label, description: typeof opt.description === "string" ? opt.description : undefined }];
    });
    return [
      {
        question: q.question,
        header: typeof q.header === "string" ? q.header : undefined,
        options,
        multiSelect: q.multiSelect === true,
      },
    ];
  });
}

/** The plan an ExitPlanMode request carries, and the file it was written to. */
export function planOf(input: unknown): { plan: string | null; path: string | null } {
  const obj = (input ?? {}) as Record<string, unknown>;
  return {
    plan: typeof obj.plan === "string" && obj.plan.trim() !== "" ? obj.plan : null,
    path: typeof obj.planFilePath === "string" ? obj.planFilePath : null,
  };
}

/** The picks the CLI reported back for an answered question, parsed from the
 * tool's result (`"Which color?"="Blue"`). Keyed by question text. */
export function answeredPicks(output: string | null | undefined): Record<string, string> {
  const picks: Record<string, string> = {};
  if (!output) return picks;
  const re = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
  for (const match of output.matchAll(re)) {
    picks[match[1]!] = match[2]!;
  }
  return picks;
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

/** What the status line says while a turn is busy with something other than
 * thinking — `label` in place of the rotating verb, `detail` after the clock —
 * or `null` when there is nothing particular to say. `waiting` is true while
 * nothing is being computed (a retry's delay), so the line stops shimmering
 * the way it does for "Waiting on you". */
export function progressLine(
  progress: TurnProgress | null | undefined,
  now: number,
): { label: string; detail: string | null; waiting: boolean } | null {
  if (!progress) return null;
  if (progress.kind === "compacting") {
    return { label: "Compacting conversation", detail: null, waiting: false };
  }
  // The CLI counts retries, not attempts: retry 1 is the second try.
  const left = Math.ceil((progress.retryAtMs - now) / 1000);
  const of = progress.maxRetries > 0 ? ` of ${progress.maxRetries}` : "";
  return {
    label: left > 0 ? `Retrying in ${left}s` : "Retrying",
    detail: `retry ${progress.attempt}${of} · ${progress.reason}`,
    waiting: left > 0,
  };
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
    for (const key of ["command", "file_path", "filePath", "path", "pattern", "url", "prompt"]) {
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

/** Tool family, resolved case-insensitively so Claude (`Edit`), opencode
 * (`edit`) and Codex (`exec`, file-change items) all land in the same bucket.
 * Used by the activity rows to decide whether a call edits a file, creates
 * one, reads one, runs a command, or is something else entirely. */
export type ToolCategory = "edit" | "write" | "read" | "command" | "other";

export function toolCategory(name: string): ToolCategory {
  switch (name.toLowerCase()) {
    case "edit":
    case "multiedit":
    case "apply_patch":
    case "patch":
      return "edit";
    case "write":
    case "create":
      return "write";
    case "read":
    case "view":
      return "read";
    case "bash":
    case "exec":
    case "shell":
    case "command":
    case "terminal":
      return "command";
    default:
      return "other";
  }
}

function strField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

/** The file a tool call touches, across every harness dialect: Claude's
 * `file_path`, opencode's `filePath`, Codex's `path`/`file`, and a bare
 * `filePath` some tools use. Empty when the call touches no file. */
export function toolFilePath(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return strField(record, ["file_path", "filePath", "path", "file", "filename", "file_name"]);
}

/** The shell command a command tool runs (`command` everywhere). */
export function toolCommand(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  const value = record["command"];
  return typeof value === "string" ? value : "";
}

/** The new file content a Write/Create call carries (`content` on both
 * harnesses, with `text`/`body` as fallbacks for future shapes). */
export function toolWriteContent(input: unknown): string {
  if (input === null || typeof input !== "object") return "";
  const record = input as Record<string, unknown>;
  return strField(record, ["content", "text", "body", "code", "newString", "new_string"]);
}

export interface EditOp {
  old_string: string;
  new_string: string;
}

/** `Edit` and `MultiEdit` inputs differ in shape (one op vs. an `edits`
 * array) but the card renders them identically — one diff per op.
 * Case-insensitive on the tool name and tolerant of camelCase inputs so
 * opencode's `edit` (`filePath`/`oldString`/`newString`) lands here too. */
export function normalizeEdit(
  name: string,
  input: unknown,
): { filePath: string; edits: EditOp[] } {
  const record = (input ?? {}) as Record<string, unknown>;
  const filePath = toolFilePath(record);

  const getOld = (o: Record<string, unknown>): string =>
    strField(o, ["old_string", "oldString", "old_text", "oldText"]);
  const getNew = (o: Record<string, unknown>): string =>
    strField(o, ["new_string", "newString", "new_text", "newText", "diff", "content"]);

  if (name.toLowerCase() === "multiedit" && Array.isArray(record.edits)) {
    const edits = record.edits
      .filter((edit): edit is Record<string, unknown> => edit !== null && typeof edit === "object")
      .map((edit) => ({
        old_string: getOld(edit),
        new_string: getNew(edit),
      }));
    return { filePath, edits };
  }

  // An `apply_patch`-style call carries a single `diff` rather than an
  // old/new pair — render it as a pure addition so it still gets +N counts.
  const patch = strField(record, ["diff", "patch"]);
  if (patch && !getOld(record) && !getNew(record)) {
    return { filePath, edits: [{ old_string: "", new_string: patch }] };
  }

  return {
    filePath,
    edits: [
      {
        old_string: getOld(record),
        new_string: getNew(record),
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
    const filePath =
      record["file_path"] ?? record["filePath"] ?? record["path"] ?? record["file"];
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
 * bytes. `totalBytes` is the text's real size when it arrived already cut
 * down (a tool output on the phone), so the note still counts truthfully. */
export function truncate(text: string, limit: number, totalBytes?: number): string {
  const bytes = new TextEncoder().encode(text);
  const total = Math.max(bytes.length, totalBytes ?? 0);
  if (total <= limit) return text;
  let end = Math.min(limit, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
  const head = new TextDecoder().decode(bytes.slice(0, end));
  return `${head}\n… ${total - end} more bytes`;
}

/** The project's colour dot, from the backend's stable hue. */
export function projectColor(hue: number): string {
  return `hsl(${hue * 360} 62% 58%)`;
}
