import type { Entry, SessionUsage } from "./types";

/** The context sidebar's sections, in their default order. The user can drag
 * them into any other order (`contextOrder` in the store). */
export const CONTEXT_SECTION_IDS = ["context", "environment", "connectors", "changes"] as const;
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
