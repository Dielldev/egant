// How each harnessed agent is drawn: its logo and its accent colour, its name
// when nothing better is known, and how its effort levels read. Kept apart from the agent picker so
// anything that draws a session row — the sidebar, the phone app — can use it
// without the picker's state coming along.

export const AGENT_PROVIDER: Record<string, string> = {
  claude: "claude",
  codex: "openai",
  opencode: "opencode",
  antigravity: "antigravity",
};

export const AGENT_ACCENT: Record<string, string> = {
  claude: "#e8835a",
  codex: "#b9b9c4",
  opencode: "#8e7cf6",
  antigravity: "#5b8def",
};

export function fallbackName(id: string): string {
  switch (id) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "antigravity":
      return "Antigravity";
    default:
      return id;
  }
}

/** Tab labels. The full names ("Claude Code") don't fit three-across, and the
 * CLI is what's being picked, so the CLI's short name is the honest label. */
export const SHORT_NAMES: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

const VARIANT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  "x-high": "X-High",
  x_high: "X-High",
  max: "Max",
  ultra: "Ultra",
  ultracode: "Ultracode",
  ultrathink: "Ultrathink",
};

export function variantLabel(id: string): string {
  if (!id) return "";
  return (
    VARIANT_LABELS[id.toLowerCase()] ?? id.charAt(0).toUpperCase() + id.slice(1)
  );
}
