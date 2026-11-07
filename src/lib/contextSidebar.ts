import type { Entry, SessionUsage, TurnState } from "./types";

/** The context sidebar's sections, in their default order. The user can drag
 * them into any other order (`contextOrder` in the store). */
export const CONTEXT_SECTION_IDS = [
  "context",
  "background",
  "environment",
  "connectors",
  "changes",
] as const;
export type ContextSectionId = (typeof CONTEXT_SECTION_IDS)[number];

/** Fixed column width. The panel on its left is the resizable one. */
export const CONTEXT_WIDTH = 300;

/** A saved order, made safe to render: unknown ids dropped, duplicates
 * collapsed, and any section the saved list predates appended in its default
 * place — so adding a section in a later release never hides it behind an old
 * preference. */
export function normalizeContextOrder(saved: unknown): ContextSectionId[] {
  const known = new Set<string>(CONTEXT_SECTION_IDS);
  const seen = new Set<string>();
  const out: ContextSectionId[] = [];
  if (Array.isArray(saved)) {
    for (const id of saved) {
      if (typeof id === "string" && known.has(id) && !seen.has(id)) {
        seen.add(id);
        out.push(id as ContextSectionId);
      }
    }
  }
  for (const id of CONTEXT_SECTION_IDS) if (!seen.has(id)) out.push(id);
  return out;
}

/** Moves `id` to sit before (`after: false`) or after (`after: true`) `target`. */
export function moveContextSection(
  order: ContextSectionId[],
  id: ContextSectionId,
  target: ContextSectionId,
  after: boolean,
): ContextSectionId[] {
  if (id === target) return order;
  const rest = order.filter((x) => x !== id);
  const at = rest.indexOf(target);
  if (at < 0) return order;
  rest.splice(after ? at + 1 : at, 0, id);
  return rest;
}

/** Rough token count for text: ~4 characters a token. The agents report only
 * a total for the window, so the split below is built from this — it is an
 * estimate and the sidebar says so. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function jsonLength(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export interface ContextSlice {
  id: "messages" | "tools" | "system" | "free";
  label: string;
  tokens: number;
  /** Colour of its swatch and its stretch of the bar. */
  color: string;
  /** Built from an estimate rather than a reported figure. */
  estimated: boolean;
}

export interface ContextBreakdown {
  used: number;
  window: number;
  /** 0..1 */
  fraction: number;
  slices: ContextSlice[];
}

export const SLICE_COLORS = {
  messages: "#4b82e6",
  tools: "#e0793f",
  system: "#d9a73a",
  free: "var(--bubble)",
} as const;

/** What the window holds, for any agent.
 *
 * `used` and `window` are the agent's own report. How `used` divides is not:
 * no harness gives a per-category count, so the conversation's share is
 * estimated from its text — what you and the agent said, and separately what
 * tools were asked and returned — and what is left over is everything the
 * agent loads on its own (system prompt, tool definitions, instruction
 * files). The estimate is scaled down if it overshoots the reported total, so
 * the parts can never add up to more than the window holds.
 *
 * After a compaction only what came after the divider is counted, plus the
 * summary the agent kept (`tokensAfter`). */
export function contextBreakdown(
  entries: Entry[],
  usage: SessionUsage,
  window: number,
): ContextBreakdown {
  const used = Math.max(0, usage.contextTokens);
  const total = Math.max(window, used, 1);

  let start = 0;
  let carried = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.kind === "compaction") {
      start = i + 1;
      carried = entry.tokensAfter ?? 0;
      break;
    }
  }

  let chat = carried;
  let tools = 0;
  const walk = (list: Entry[]) => {
    for (const entry of list) {
      switch (entry.kind) {
        case "user":
        case "assistant":
        case "thinking":
          chat += estimateTokens(entry.text);
          break;
        case "tool":
          tools += Math.ceil((jsonLength(entry.input) + (entry.output?.length ?? 0)) / 4);
          if (entry.children) walk(entry.children);
          break;
        default:
          break;
      }
    }
  };
  walk(entries.slice(start));

  const estimated = chat + tools;
  const scale = estimated > used && estimated > 0 ? used / estimated : 1;
  const messages = Math.round(chat * scale);
  const toolTokens = Math.round(tools * scale);
  const system = Math.max(0, used - messages - toolTokens);

  const slices: ContextSlice[] = [
    { id: "messages", label: "Messages", tokens: messages, color: SLICE_COLORS.messages, estimated: true },
    { id: "tools", label: "Tool calls & results", tokens: toolTokens, color: SLICE_COLORS.tools, estimated: true },
    { id: "system", label: "System, tools & instructions", tokens: system, color: SLICE_COLORS.system, estimated: true },
    { id: "free", label: "Free space", tokens: Math.max(0, total - used), color: SLICE_COLORS.free, estimated: false },
  ];
  return { used, window: total, fraction: Math.min(1, used / total), slices };
}

/** How Claude names a server inside a tool id: anything outside
 * `[A-Za-z0-9_-]` becomes `_`. */
export function toolServerKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();
}

/** The MCP servers a live session has tools from, with how many each gave —
 * read off tool ids shaped `mcp__<server>__<tool>`. Keyed by `toolServerKey`. */
export function mcpToolCounts(tools: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const tool of tools) {
    const m = /^mcp__(.+?)__.+/.exec(tool);
    if (!m) continue;
    const key = m[1].toLowerCase();
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

/** A server key made readable when no configured name stands behind it:
 * `claude_ai_Gmail` → `Gmail`, `plugin_data_amplitude` → `Amplitude`. */
export function prettyServerName(key: string): string {
  const stripped = key
    .replace(/^claude[_-]ai[_-]/i, "")
    .replace(/^plugin[_-][^_-]+[_-]/i, "");
  const words = stripped.split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return key;
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** `/Users/me/dev/app` → `~/dev/app`, `C:\Users\me\dev` → `~\dev`. */
export function shortenHome(path: string): string {
  return path
    .replace(/^\/Users\/[^/]+/, "~")
    .replace(/^\/home\/[^/]+/, "~")
    .replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
}

// ---------------------------------------------------------------------------
// Background tasks
// ---------------------------------------------------------------------------

export type BackgroundKind = "agent" | "shell";

/** `running`: its call is still in flight. `background`: it was handed off and
 * the agent moved on; nothing egant has seen says it finished. The rest are
 * settled. */
export type BackgroundStatus = "running" | "background" | "done" | "failed" | "stopped";

export interface BackgroundTask {
  /** The launching tool call's id. */
  id: string;
  kind: BackgroundKind;
  title: string;
  status: BackgroundStatus;
  /** Tool calls a subagent has made so far. */
  steps: number;
  /** Whether the agent launched it to run in the background, as opposed to a
   * subagent it is waiting on. */
  detached: boolean;
}

/** `mcp__x__Tool` / `functions.bash` / `plugin:Task` → `tool`, lowercase. */
function toolBase(name: string): string {
  return (name.split("__").pop() ?? name)
    .split(/[:.]/)
    .pop()!
    .toLowerCase();
}

function field(input: unknown, keys: string[]): unknown {
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of keys) if (record[key] != null) return record[key];
  return undefined;
}

function textField(input: unknown, keys: string[]): string | null {
  const value = field(input, keys);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const SUBAGENT_TOOLS = new Set([
  "task", // Claude (older CLIs), opencode
  "agent", // Claude (newer CLIs)
  "subagent",
  "spawn_agent",
  "delegate",
  "invoke_subagent",
  "browser_subagent",
  "run_subagent",
]);

/** Whether a call starts a subagent — under whichever name the agent gives it.
 * Codex reports every collaboration step as a `collab_tool_call` item and says
 * which in `tool`; only the spawn starts an agent. */
function isSubagentCall(name: string, input: unknown): boolean {
  const base = toolBase(name);
  if (SUBAGENT_TOOLS.has(base) || base.includes("subagent")) return true;
  if (base === "collab_tool_call") return field(input, ["tool"]) === "spawn_agent";
  return false;
}

/** Tools that watch or stop a task launched earlier, mapped to what they do. */
const TASK_CONTROL: Record<string, "poll" | "stop"> = {
  bashoutput: "poll",
  taskoutput: "poll",
  killshell: "stop",
  killbash: "stop",
  taskstop: "stop",
};

function isShellBackground(name: string, input: unknown, output: string | null | undefined): boolean {
  if (toolBase(name) === "monitor") return true;
  const flag = field(input, ["run_in_background", "runInBackground", "is_background", "background"]);
  if (flag === true) return true;
  return !!output && /(?:running|started|moved|continu\w+) (?:in|to) (?:the )?background/i.test(output);
}

function taskIdFrom(output: string | null | undefined): string | null {
  if (!output) return null;
  const m =
    /background with ID:\s*([\w-]+)/i.exec(output) ??
    /\bagentId:\s*([\w-]+)/.exec(output) ??
    /\btask[_ ]id:?\s*([\w-]+)/i.exec(output);
  return m ? m[1] : null;
}

function settledStatus(word: string): BackgroundStatus | null {
  switch (word.toLowerCase()) {
    case "completed":
    case "complete":
    case "done":
    case "success":
    case "succeeded":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "killed":
    case "stopped":
    case "cancelled":
    case "canceled":
      return "stopped";
    default:
      return null;
  }
}

function countToolCalls(children: Entry[] | undefined): number {
  let n = 0;
  for (const entry of children ?? []) {
    if (entry.kind !== "tool") continue;
    n += 1 + countToolCalls(entry.children);
  }
  return n;
}

function firstLine(text: string, max = 90): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? text.trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** What the agent has running beside the conversation, for any agent: the
 * subagents it started and the shells and monitors it sent to the background.
 *
 * No harness has a task list of its own to read, so this reads the calls that
 * started them. A subagent the agent is waiting on is `running` until its call
 * returns. A task the agent *detached* returns at once with only a launch
 * acknowledgement, so it stays `background` until something says otherwise:
 * Claude's completion notice (`<task-notification>`), or a later call that
 * polled it or stopped it. Where an agent gives no such signal the task keeps
 * reading `background` — the sidebar says "not confirmed finished", not
 * "running". A call still unanswered once the turn is over was cut off, so it
 * reads `stopped`. */
export function backgroundTasks(entries: Entry[], turn: TurnState): BackgroundTask[] {
  // What later entries said about each task, keyed by task id and by the id of
  // the call that launched it.
  const verdicts = new Map<string, BackgroundStatus>();
  const note = (key: string | null | undefined, status: BackgroundStatus | null) => {
    if (key && status) verdicts.set(key, status);
  };
  const texts: string[] = [];
  for (const entry of entries) {
    if (entry.kind === "user" || entry.kind === "assistant" || entry.kind === "notice") {
      if (entry.text.includes("<task-notification>")) texts.push(entry.text);
    } else if (entry.kind === "tool") {
      const control = TASK_CONTROL[toolBase(entry.name)];
      if (!control) continue;
      const id = textField(entry.input, ["bash_id", "shell_id", "task_id", "taskId", "id"]);
      if (control === "stop") note(id, "stopped");
      else if (entry.output) {
        const m = /<status>\s*(\w+)\s*<\/status>/i.exec(entry.output);
        note(id, m ? settledStatus(m[1]) : null);
      }
    }
  }
  for (const text of texts) {
    for (const block of text.split("<task-notification>").slice(1)) {
      const status = /<status>\s*(\w+)\s*<\/status>/i.exec(block);
      const verdict = status ? settledStatus(status[1]) : null;
      note(/<task-id>\s*([\w-]+)\s*<\/task-id>/i.exec(block)?.[1], verdict);
      note(/<tool-use-id>\s*([\w-]+)\s*<\/tool-use-id>/i.exec(block)?.[1], verdict);
    }
  }

  const tasks: BackgroundTask[] = [];
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    const agent = isSubagentCall(entry.name, entry.input);
    const detachedShell = !agent && isShellBackground(entry.name, entry.input, entry.output);
    if (!agent && !detachedShell) continue;

    const launchedDetached =
      agent &&
      (field(entry.input, ["run_in_background", "runInBackground", "background"]) === true ||
        /launched successfully|working in the background/i.test(entry.output ?? ""));
    const detached = launchedDetached || detachedShell;

    const answered = entry.output != null;
    const taskId = taskIdFrom(entry.output);
    const verdict = verdicts.get(entry.id) ?? (taskId ? verdicts.get(taskId) : undefined);

    let status: BackgroundStatus;
    if (verdict) status = verdict;
    else if (!answered) status = turn === "idle" ? "stopped" : "running";
    else if (detached) status = "background";
    else status = entry.isError ? "failed" : "done";

    const title = agent
      ? (textField(entry.input, ["description", "title", "name"]) ??
        firstLine(textField(entry.input, ["prompt", "task", "message"]) ?? entry.name))
      : (textField(entry.input, ["description"]) ??
        firstLine(textField(entry.input, ["command", "cmd"]) ?? entry.name));

    tasks.push({
      id: entry.id,
      kind: agent ? "agent" : "shell",
      title,
      status,
      steps: countToolCalls(entry.children),
      detached,
    });
  }

  const live = (t: BackgroundTask) => t.status === "running" || t.status === "background";
  // Live first; each group newest first.
  return [...tasks.filter(live).reverse(), ...tasks.filter((t) => !live(t)).reverse()];
}

/** The tool call with this id, wherever it sits — a subagent's own subagents
 * included. */
export function findToolEntry(
  entries: Entry[],
  id: string,
): Extract<Entry, { kind: "tool" }> | null {
  for (const entry of entries) {
    if (entry.kind !== "tool") continue;
    if (entry.id === id) return entry;
    const inner = entry.children ? findToolEntry(entry.children, id) : null;
    if (inner) return inner;
  }
  return null;
}
