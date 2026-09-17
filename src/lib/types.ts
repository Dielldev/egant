// Mirror of `src-tauri/src/dto.rs`. Field names match the serde wire format
// (camelCase everywhere except the streaming event variants, which keep the
// backend's snake_case).

export interface Project {
  id: number;
  name: string;
  location: string;
  path: string;
  /** Stable per-path hue, 0.0..1.0. Render as `hsl(hue * 360, 62%, 58%)`. */
  hue: number;
}

export type TurnState = "idle" | "running" | "awaiting_permission";

export type Entry =
  | { kind: "user"; text: string }
  /** `at` is stamped by the fold when the reply opens, so it is absent on
   * entries restored from a backend snapshot. */
  | { kind: "assistant"; text: string; streaming: boolean; at?: number }
  | { kind: "thinking"; text: string; streaming: boolean; at?: number; elapsedMs?: number }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: unknown;
      output?: string | null;
      isError: boolean;
    }
  | { kind: "notice"; text: string; isError: boolean };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
}

/** Full transcript snapshot, as returned by `get_transcript`. */
export interface TranscriptDto {
  entries: Entry[];
  state: TurnState;
  sessionId: string | null;
  model: string | null;
  tools: string[];
  pending: PendingPermission | null;
  totalCostUsd: number;
  lastTurnMs: number;
  usage: SessionUsage;
}

/** What one turn put through the model. Mirrors the Rust `TurnUsage`. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** The window this turn's model ran with, or 0 when the agent didn't say. */
  contextWindow: number;
}

/** What a session has spent. Mirrors the Rust `SessionUsage`, and the same
 * split applies: the token counts and `turns` accumulate over the session,
 * while `contextTokens`/`contextWindow` describe only the newest turn —
 * the window holds one conversation, not the sum of every turn through it. */
export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  turns: number;
  contextTokens: number;
  contextWindow: number;
}

/** Live transcript state. `toolIndex` lets a result find its call without
 * scanning the whole transcript — same role as in the Rust fold. */
export interface TranscriptState extends TranscriptDto {
  toolIndex: Record<string, number>;
  /** When the turn now in flight started, or `null` while idle. Frontend-only:
   * the backend reports a turn's duration once it has ended, but the status
   * line has to count up *during* one, so the window stamps its own start. */
  turnStartedAt: number | null;
}

/** One streaming event, as emitted on `session-event`. Mirrors `HarnessEvent`
 * variant-for-variant so the fold below stays a mechanical port of
 * `Transcript::apply`. */
export type HarnessEvent =
  | { type: "ready"; session_id: string; model: string | null; cwd: string | null; tools: string[] }
  | { type: "assistant_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "assistant_message"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; output: string; is_error: boolean }
  | { type: "permission_request"; request_id: string; tool_name: string; input: unknown }
  | {
      type: "turn_ended";
      result: string | null;
      is_error: boolean;
      duration_ms: number;
      cost_usd: number;
      usage: TurnUsage;
    }
  | { type: "error"; message: string }
  | { type: "exited"; code: number | null };

export interface SessionEventPayload {
  sessionId: number;
  event: HarnessEvent;
}

export type SessionKind = "chat" | "cli";

export interface SessionInfo {
  id: number;
  title: string;
  projectId: number;
  cwd: string;
  branch: string | null;
  startedUnixMs: number;
  /** CLI flag form: `auto` | `manual` | `plan` | `acceptEdits` | `bypassPermissions`. */
  permissionMode: string;
  /** `chat` — egant renders the turns — or `cli`, where the stage is a
   * terminal running the agent's own CLI and there is no transcript at all. */
  kind: SessionKind;
  /** Agent running the session. A chat session names one of the harnesses
   * (`claude` | `codex` | `opencode`); a CLI session names any agent in the
   * install catalog (`pi`, `goose`, …). */
  agent: string;
  /** Model override requested at creation, if any. */
  modelOverride: string | null;
  /** Context window override requested at creation, if any. */
  context: number | null;
  ended: boolean;
  busy: boolean;
  model: string | null;
  totalCostUsd: number;
}

export interface SettingsState {
  wallpaper: string | null;
  wallpaperName: string | null;
  wallpaperDim: number;
  defaultAgent: string;
}

/** One row of `list_agents`: CLI presence and login state per agent. */
export interface AgentStatus {
  id: string;
  name: string;
  cli: string;
  executable: string | null;
  installed: boolean;
  installHint: string;
  connected: boolean;
  email: string | null;
}

/** One published way to install an agent — npm, Homebrew, the vendor's curl
 * script. Mirrors emdash's `installCommands`: several sources per agent, one
 * of them recommended. */
export interface AgentInstallOption {
  method: string;
  command: string;
  /** What "Install latest" runs. Never empty: an explicit update command,
   * the derived `npm …@latest`, or the install command itself. */
  updateCommand: string;
  recommended: boolean;
}

/** One row of `list_agent_catalog`: an agent the Agents tab can offer to
 * install, and whether this machine already has its CLI. Wider than
 * `AgentStatus`, which only covers the agents egant can drive. */
export interface AgentCatalogEntry {
  id: string;
  name: string;
  /** The binary actually probed for — often not the product name (Antigravity
   * installs `agy`, Continue installs `cn`). */
  cli: string;
  /** Brand key for `ProviderLogo`; unknown keys fall back to a letter tile. */
  vendor: string;
  website: string;
  supports: string[];
  /** egant renders this agent's turns in the chat UI, rather than it being a
   * terminal-only CLI. */
  chatUi: boolean;
  recommended: boolean;
  /** Empty when the vendor publishes no unattended install. */
  installOptions: AgentInstallOption[];
  installed: boolean;
  executable: string | null;
  /** The command line that opens this agent's own CLI, as a person would
   * type it (`pi`, `goose session`). */
  launchCommand: string;
}

/** What `install_agent` / `update_agent` report: the command's exit, its log
 * tail, and the freshly re-probed catalog row. */
export interface AgentInstallOutcome {
  success: boolean;
  output: string;
  status: AgentCatalogEntry;
}

/** `check_agent_update` — `latest` is `null` when the CLI has no registry we
 * read, or the lookup failed, in which case no badge is shown. */
export interface AgentUpdate {
  id: string;
  current: string | null;
  latest: string | null;
  updateAvailable: boolean;
  /** The install source "Install latest" runs. */
  method: string | null;
}

/** One row of `list_models`: a model the agent can run. */
export interface AgentModel {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  /** One-line blurb shown beside the name in the picker. */
  description: string;
  /** Context window in tokens (0 = unknown, hides the token badge). */
  context: number;
  /** The widest window this model can be asked for, which is what it actually
   * runs with here — Claude's larger models take a million through the `[1m]`
   * suffix on their id. Equal to `context` for everything that has no wider
   * window to ask for. */
  maxContext: number;
  /** Reasoning variants the model advertises. */
  variants: string[];
  /** The effort the model runs at when nothing asks for one, where the CLI
   * says (Codex does, per model); `""` otherwise. */
  defaultVariant: string;
  /** Whether this is the model the CLI itself would pick — what the picker's
   * "Default" row resolves to. Only Codex reports it. */
  cliDefault: boolean;
}

/** One rolling or weekly window's usage (`claude_usage_limits`). */
export interface UsageWindow {
  usedPercent: number;
  /** ISO 8601, or `null` when the endpoint didn't report one. */
  resetsAt: string | null;
}

/** Claude's 5-hour and weekly usage, for the composer's limit pill. `null`
 * fields mean the endpoint didn't report that window; the whole call comes
 * back `null` when Claude isn't logged in on this device. */
export interface ClaudeUsage {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  sevenDaySonnet: UsageWindow | null;
}

/** 200000 → "200K", 1048576 → "1M", 0 → "". Used for the composer's
 * `High · 200K` badge. */
export function formatContext(context: number): string {
  if (!context || context <= 0) return "";
  if (context >= 1_000_000) {
    const m = context / 1_000_000;
    return `${Number.isInteger(m) ? m.toString() : m.toFixed(1)}M`;
  }
  if (context >= 1000) {
    const k = context / 1000;
    return `${Number.isInteger(k) ? k.toString() : k.toFixed(1)}K`;
  }
  return String(context);
}

/** Parses a context size typed or picked in the UI: "200K", "1M", "200000",
 * "200_000", "200,000". Returns 0 when it doesn't parse. */
export function parseContext(input: string): number {
  const raw = input.trim().toLowerCase().replace(/[,_\s]/g, "");
  if (!raw) return 0;
  const m = raw.match(/^(\d+(?:\.\d+)?)(k|m|g)?$/);
  if (!m) return 0;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value <= 0) return 0;
  const mult = m[2] === "m" ? 1_000_000 : m[2] === "g" ? 1_000_000_000 : 1_000;
  // Bare digits without a suffix are already tokens — don't multiply.
  const n = m[2] ? Math.round(value * mult) : Math.round(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/** Presets offered by the picker's CONTEXT section and the Agents settings. */
export const CONTEXT_PRESETS = ["32K", "64K", "100K", "200K", "500K", "1M"];

/** One row of the workspace panel's file tree (`list_dir`). */
export interface FileEntry {
  name: string;
  /** Absolute path — what expands a folder and what a stage tab opens. */
  path: string;
  isDir: boolean;
}

/** A file as the stage's viewer tab shows it (`read_file`). `binary` and
 * `truncated` are the two honest answers the viewer gives instead of text. */
export interface FileContent {
  path: string;
  name: string;
  text: string;
  /** Size on disk, which `text` may be only the head of. */
  bytes: number;
  truncated: boolean;
  binary: boolean;
}

/** How git describes one changed path. Drives the row's status icon. */
export type GitChangeStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

/** One row of the panel's Changed or Staged section (`changes_list`). A path
 * that is both staged and edited again since appears twice — once per
 * section — which is what git itself reports. */
export interface GitChange {
  path: string;
  status: GitChangeStatus;
  /** The `git status --short` letter. */
  code: string;
  staged: boolean;
  additions: number;
  deletions: number;
}

/** Where the repository stands (`repo_status`). */
export interface RepoStatus {
  /** The repository's own root. Paths in `GitChange` are relative to this,
   * which is not always the folder the panel was pointed at. */
  root: string;
  branch: string | null;
  headSummary: string | null;
  ahead: number | null;
  behind: number | null;
  /** `null` when the repository has no remote, which is what hides "Push". */
  remote: string | null;
  /** Whether the branch tracks anything yet. A branch that doesn't is offered
   * "Publish" rather than "Push". */
  published: boolean;
}

/** Whether the GitHub CLI is there and signed in. Everything in the Pull
 * Requests section runs through it. */
export interface GhStatus {
  installed: boolean;
  authenticated: boolean;
  /** What to tell the user when one of the above is false. */
  hint: string;
}

export interface PullRequest {
  number: number;
  title: string;
  /** `OPEN` | `CLOSED` | `MERGED`. */
  state: string;
  draft: boolean;
  head: string;
  base: string;
  url: string;
  author: string;
  updated: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

/** One CI check. `bucket` is the four-way answer the UI colours by. */
export interface PrCheck {
  name: string;
  /** `pass` | `fail` | `pending` | `skipped`. */
  bucket: string;
  description: string;
  url: string | null;
}

export interface PrCommit {
  sha: string;
  message: string;
  author: string;
}

export interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface PrComment {
  author: string;
  body: string;
  at: string;
}

export interface PrDetail {
  pullRequest: PullRequest;
  body: string;
  /** `MERGEABLE` | `CONFLICTING` | `UNKNOWN`. */
  mergeable: string;
  /** `APPROVED` | `CHANGES_REQUESTED` | `REVIEW_REQUIRED` | empty. */
  reviewDecision: string;
  checks: PrCheck[];
  commits: PrCommit[];
  files: PrFile[];
  comments: PrComment[];
}

/** One line of a diff. `origin` is git's own marker: `+`, `-` or a space. */
export interface DiffLine {
  origin: string;
  content: string;
  /** `null` where the line doesn't exist on that side — a removed line has no
   * new number, an added line has no old one. */
  oldLineno: number | null;
  newLineno: number | null;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

/** A chunk of terminal output, as emitted on `pty-output`. */
export interface PtyOutput {
  id: number;
  data: string;
}

/** The shell behind a terminal tab has exited (`pty-exit`). */
export interface PtyExit {
  id: number;
}

export interface WindowState {
  projects: Project[];
  activeProject: number | null;
  sessions: SessionInfo[];
  activeSession: number | null;
  /** The computer's friendly name. Every label that names a place reads
   * `project @ machine`. */
  machineName: string;
  settings: SettingsState;
  sidebarVisible: boolean;
  /** `{agent: [modelId, ...]}` — models that have already failed with a
   * model/catalog-shaped error this run (a bad id, or a real model this
   * account's plan can't run). Resets on relaunch. */
  badModels: Record<string, string[]>;
}
