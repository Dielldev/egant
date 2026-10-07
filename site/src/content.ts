import launchShot from "../../docs/screenshots/1-launch.png";
import workspaceShot from "../../docs/screenshots/2-chat-and-editor.png";
import diffShot from "../../docs/screenshots/3-diff-and-browser.png";
import phoneShot from "../../docs/screenshots/4-phone.png";
import wallCats from "./assets/shots/wall-cats.jpg";
import wallSky from "./assets/shots/wall-sky.jpg";
import wallTorii from "./assets/shots/wall-torii.jpg";
import chatShot from "./assets/shots/chat.jpg";
import editorShot from "./assets/shots/editor.jpg";
import libraryShot from "./assets/shots/library.jpg";
import runShot from "./assets/shots/run-website.jpg";

export const REPO = "https://github.com/Dielldev/egant";

/** The release asset keeps a version-less name so this link never goes stale. */
export const DOWNLOAD = {
  url: `${REPO}/releases/latest/download/egant-macos-arm64.dmg`,
  label: "Download for macOS",
  detail: "Apple Silicon · 10 MB",
};

export type Agent = { name: string; provider: string; kind: "chat" | "cli" };

/** Chat agents get egant's native transcript; CLI agents run in a real PTY. */
export const AGENTS: Agent[] = [
  { name: "Claude Code", provider: "claude", kind: "chat" },
  { name: "Codex", provider: "codex", kind: "chat" },
  { name: "opencode", provider: "opencode", kind: "chat" },
  { name: "Antigravity", provider: "antigravity", kind: "chat" },
  { name: "Cursor", provider: "cursor", kind: "cli" },
  { name: "Devin", provider: "devin", kind: "cli" },
  { name: "Grok", provider: "grok", kind: "cli" },
  { name: "Copilot", provider: "copilot", kind: "cli" },
  { name: "Goose", provider: "goose", kind: "cli" },
  { name: "Qwen", provider: "qwen", kind: "cli" },
  { name: "Pi", provider: "pi", kind: "cli" },
  { name: "Hermes", provider: "nous", kind: "cli" },
];

export type Shot = { label: string; title: string; body: string; src: string; alt: string };

export const HERO_SHOT: Shot = {
  label: "Launch",
  title: "Pick an agent, pick a model, go.",
  body: "egant finds the CLIs on your machine and shows which are logged in.",
  src: launchShot,
  alt: "egant launch screen",
};

/** The tabbed tour of the app, in the order a session usually goes. */
export const SHOWCASE: Shot[] = [
  {
    label: "Chat",
    title: "Every tool call, right where it happened.",
    body: "Replies stream token by token, reads and edits show up as file chips, and the composer keeps the worktree, branch, permission mode and context meter in view.",
    src: chatShot,
    alt: "An opencode conversation with tool calls in egant",
  },
  {
    label: "Editor",
    title: "The code, one tab away.",
    body: "Open files as tabs beside the conversation, with a syntax-highlighted editor, autosave and the file tree in the panel.",
    src: editorShot,
    alt: "The editor with open tabs and the file tree",
  },
  {
    label: "Run website",
    title: "Run it without leaving the chat.",
    body: "When an agent builds a site, a Run website pill starts the dev server for that worktree. Edits show their line counts as they land.",
    src: runShot,
    alt: "A finished turn with file edits and the Run website pill",
  },
  {
    label: "Review",
    title: "See what changed. See it running.",
    body: "Unified or split working-tree diffs, commit and push from the app, and preview the site in the window.",
    src: diffShot,
    alt: "Working tree diff and an in-app website preview",
  },
  {
    label: "Library",
    title: "MCP servers and skills, set up once.",
    body: "Add a server or a skill in the Library and egant writes it into every selected agent's own config file, in that agent's format.",
    src: libraryShot,
    alt: "The Library's MCP tab with added and recommended servers",
  },
  {
    label: "Workspace",
    title: "The conversation, next to the code.",
    body: "Press ⌘J for the panel: file tree, git changes, pull requests and real terminals.",
    src: workspaceShot,
    alt: "A conversation beside the file editor and file tree",
  },
];

export type Wallpaper = { name: string; src: string };

/** Real launch screens, each with its own wallpaper and the scanlines effect. */
export const WALLPAPERS: Wallpaper[] = [
  { name: "Rooftop cats", src: wallCats },
  { name: "Above the clouds", src: wallSky },
  { name: "Torii in bloom", src: wallTorii },
];

export const PHONE_SHOT = phoneShot;

/** A handful of the app's palettes (src/index.css), with the colours the
 * preview needs. `accent` is each palette's own most colourful solid. */
export type Theme = {
  id: string;
  name: string;
  stage: string;
  sidebar: string;
  ink: string;
  muted: string;
  border: string;
  bubble: string;
  accent: string;
};

export const THEMES: Theme[] = [
  { id: "zeron-dark", name: "Zeron Dark", stage: "#0d0d0d", sidebar: "rgba(9,9,9,0.94)", ink: "#e0e0e0", muted: "#8b8b95", border: "rgba(255,255,255,0.06)", bubble: "rgba(255,255,255,0.09)", accent: "#8e7cf6" },
  { id: "zeron-light", name: "Zeron Light", stage: "#f2f2f5", sidebar: "rgba(244,244,247,0.9)", ink: "#17171c", muted: "#62626c", border: "rgba(0,0,0,0.08)", bubble: "rgba(0,0,0,0.06)", accent: "#8e7cf6" },
  { id: "sand", name: "Sand", stage: "#efe9dd", sidebar: "rgba(243,238,229,0.92)", ink: "#221c12", muted: "#6f6350", border: "rgba(90,70,40,0.14)", bubble: "rgba(90,70,40,0.09)", accent: "#b3803f" },
  { id: "midnight", name: "Midnight", stage: "#02040a", sidebar: "rgba(4,6,14,0.96)", ink: "#e4eafc", muted: "#8b96b5", border: "rgba(140,170,255,0.1)", bubble: "rgba(140,170,255,0.12)", accent: "#8ca0ff" },
  { id: "catppuccin-mocha", name: "Catppuccin Mocha", stage: "#1e1e2e", sidebar: "rgba(17,17,27,0.94)", ink: "#cdd6f4", muted: "#a6adc8", border: "rgba(203,166,247,0.12)", bubble: "rgba(203,166,247,0.1)", accent: "#cba6f7" },
  { id: "tokyo-night", name: "Tokyo Night", stage: "#1a1b26", sidebar: "rgba(16,17,26,0.95)", ink: "#c0caf5", muted: "#a9b1d6", border: "rgba(122,162,247,0.1)", bubble: "rgba(122,162,247,0.09)", accent: "#7aa2f7" },
  { id: "dracula", name: "Dracula", stage: "#282a36", sidebar: "rgba(33,34,44,0.95)", ink: "#f8f8f2", muted: "#b3b4c6", border: "rgba(189,147,249,0.12)", bubble: "rgba(189,147,249,0.1)", accent: "#bd93f9" },
  { id: "nord", name: "Nord", stage: "#2e3440", sidebar: "rgba(24,28,35,0.95)", ink: "#d8dee9", muted: "#9aa5b1", border: "rgba(136,192,208,0.12)", bubble: "rgba(136,192,208,0.1)", accent: "#88c0d0" },
  { id: "rose-pine-moon", name: "Rosé Pine Moon", stage: "#232136", sidebar: "rgba(19,18,29,0.95)", ink: "#e0def4", muted: "#908caa", border: "rgba(234,154,151,0.12)", bubble: "rgba(234,154,151,0.1)", accent: "#ea9a97" },
  { id: "gruvbox-dark", name: "Gruvbox Dark", stage: "#282828", sidebar: "rgba(20,20,20,0.95)", ink: "#ebdbb2", muted: "#a89984", border: "rgba(184,187,38,0.12)", bubble: "rgba(250,189,47,0.1)", accent: "#fabd2f" },
  { id: "synthwave-84", name: "SynthWave '84", stage: "#262335", sidebar: "rgba(18,16,26,0.95)", ink: "#f2e9e9", muted: "#b893ce", border: "rgba(255,126,219,0.14)", bubble: "rgba(255,126,219,0.12)", accent: "#ff7edb" },
  { id: "github-dark", name: "GitHub Dark", stage: "#0d1117", sidebar: "rgba(9,13,17,0.95)", ink: "#c9d1d9", muted: "#8b949e", border: "rgba(88,166,255,0.12)", bubble: "rgba(88,166,255,0.1)", accent: "#58a6ff" },
];

/** Appearance > Glass, as the app names its modes. */
export const GLASS_MODES = ["default", "frosted", "clear", "opaque"] as const;
export type GlassMode = (typeof GLASS_MODES)[number];

/** Appearance > Background effect. */
export const EFFECTS = ["none", "dither", "halftone", "scanlines", "ascii"] as const;
export type Effect = (typeof EFFECTS)[number];

export const QUICKSTART = [
  "git clone https://github.com/Dielldev/egant.git",
  "cd egant",
  "npm install",
  "npm run tauri dev",
];
