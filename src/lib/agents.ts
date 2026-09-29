// How each harnessed agent is drawn: its logo and its accent colour, and its
// name when nothing better is known. Kept apart from the agent picker so
// anything that draws a session row — the sidebar, the phone app — can use it
// without the picker's state coming along.

export const AGENT_PROVIDER: Record<string, string> = {
  claude: "claude",
  codex: "openai",
  opencode: "opencode",
};

export const AGENT_ACCENT: Record<string, string> = {
  claude: "#e8835a",
  codex: "#b9b9c4",
  opencode: "#8e7cf6",
};

export function fallbackName(id: string): string {
  switch (id) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    default:
      return id;
  }
}
