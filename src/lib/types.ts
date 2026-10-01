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

// ---------------------------------------------------------------------------
// Agent-initiated interaction requests — structured prompts the agent embeds
// in its reply asking the user to decide something before it continues (see
// `extractDecisions` in `lib/transcript.ts` for how one of these is recognized
// inside an assistant message). `type` is the extension point: a future kind
// — confirmation, free-text question, file selection, permission / tool /
// code-execution approval — adds one variant to `AgentRequest`/`AgentResponse`
// and a case in `AgentRequestCard` (TranscriptView.tsx); nothing else in the
// chat pipeline needs to change.
// ---------------------------------------------------------------------------

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface DecisionRequest {
  type: "decision";
  id: string;
  title: string;
  description?: string;
  options: DecisionOption[];
  selectionMode: "single" | "multiple";
  /** Offers a free-text "something else" alongside the listed options. */
  allowCustomInput?: boolean;
}

export interface DecisionResponse {
  type: "decision";
  /** Ids from `DecisionRequest.options`, in the order the user picked them —
   * empty when only custom text was given. */
  selectedOptionIds: string[];
  /** What the user wrote in the free-text option, when offered and used. */
  customText?: string;
}

/** One request kind today; a future kind joins this union. */
export type AgentRequest = DecisionRequest;

/** Mirrors `AgentRequest` one-for-one: every request kind answers with its
 * own response shape. */
export type AgentResponse = DecisionResponse;

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
      /** The output's real size, when what arrived was cut down to what a
       * card shows (the phone app's transcripts). Absent on the desktop. */
      outputBytes?: number;
    }
  | { kind: "notice"; text: string; isError: boolean }
  /** The divider a compaction leaves: everything above it now reaches the
   * model only as a summary. `tokensBefore` is the whole prompt the
   * conversation last sent; `tokensAfter` what is left of the conversation
   * itself, without the system prompt — not the same measure. */
  | { kind: "compaction"; auto: boolean; tokensBefore: number; tokensAfter: number | null }
  /** An interactive prompt the agent raised inline — never sent by the
   * backend as its own wire message; folded out of an `assistant` entry's
   * text (see `lib/transcript.ts`), which is what makes it survive a reload
   * without any change to the Rust side. `response` is always `null` here —
   * the answer is looked up separately (the store's `decisionResponses`,
   * keyed by session + `request.id`) so it persists independent of the
   * transcript mirror being rebuilt from a snapshot. */
  | { kind: "agent_request"; id: string; request: AgentRequest; response: AgentResponse | null };

export interface PendingPermission {
  requestId: string;
  toolName: string;
  input: unknown;
  patterns: string[];
  alwaysPatterns: string[];
  /** The CLI's own "don't ask again" options (Claude only). An "always"
   * answer hands back one of them — see `alwaysAllowUpdate`. Absent on
   * snapshots from older backends. */
  suggestions?: PermissionUpdate[];
  /** What the call does, in the agent's words. */
  description?: string | null;
  /** The path that made the agent ask, when one did. */
  blockedPath?: string | null;
}

/** One permission update, as Claude's CLI offers it in a request's
 * suggestions and accepts back with an approval. */
export interface PermissionUpdate {
  type: "addRules" | "addDirectories" | "setMode" | (string & {});
  rules?: { toolName: string; ruleContent?: string }[];
  behavior?: string;
  /** `localSettings` (the project's `.claude/settings.local.json`),
   * `projectSettings`, `userSettings` or `session`. */
  destination?: string;
  directories?: string[];
  mode?: string;
}

/** One question in Claude's AskUserQuestion tool input. */
export interface AskQuestion {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

/** Full transcript snapshot, as returned by `get_transcript`. */
export interface TranscriptDto {
  entries: Entry[];
  state: TurnState;
  sessionId: string | null;
  model: string | null;
  tools: string[];
  pending: PendingPermission | null;
  /** Every outstanding request. `pending` mirrors the first entry. */
  pendingList: PendingPermission[];
  totalCostUsd: number;
  lastTurnMs: number;
  usage: SessionUsage;
  /** Answers to this transcript's decision prompts, keyed by prompt id. Kept
   * by the backend so every device agrees on which prompts are settled. */
  decisionResponses?: Record<string, DecisionResponse>;
  /** Messages waiting for the running turn to end, oldest first. */
  queued?: QueuedMessage[];
  /** What the running turn is busy with, when the agent says. Absent from
   * older backends. */
  progress?: TurnProgress | null;
}

/** What a running turn spends time on besides thinking and replying — what
 * the status line says instead of a rotating verb. Mirrors the Rust
 * `TurnProgress`. `retryAtMs` is when the next attempt goes out (Unix ms). */
export type TurnProgress =
  | { kind: "compacting" }
  | { kind: "retrying"; attempt: number; maxRetries: number; retryAtMs: number; reason: string };

/** A message sent while the agent was busy, waiting its turn. */
export interface QueuedMessage {
  id: number;
  text: string;
  imageCount: number;
}

/** What sending a message did: the session's new title when it named the
 * session, and its queue when the message joined it. */
export interface SendResult {
  title: string | null;
  queued: boolean;
  queue: QueuedMessage[];
}

/** The `session-queue` event: the app sent the next queued message. */
export interface SessionQueuePayload {
  sessionId: number;
  queued: QueuedMessage[];
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

/** How the user answered one row of the permission table. `answer` is for
 * a question (AskUserQuestion) and `approve-plan` for a plan (ExitPlanMode);
 * neither takes a plain allow. */
export type PermissionDecision = "allow" | "allow-always" | "deny" | "answer" | "approve-plan";

/** A permission answer with whatever its decision carries. */
export interface PermissionReply {
  decision: PermissionDecision;
  /** `answer`: the pick for each question, keyed by the question's text —
   * several labels for a multi-select question. */
  answers?: Record<string, string | string[]>;
  /** `answer`: a remark per question, keyed the same way. */
  notes?: Record<string, string>;
  /** `deny`: what the agent reads instead of the stock refusal. */
  feedback?: string;
  /** `deny`: also end the turn. */
  stop?: boolean;
  /** `approve-plan`: the mode to carry on in. */
  mode?: string;
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
  /** `bytes` is set when `output` was cut down in transit (the phone's
   * stream): the output's real size. */
  | { type: "tool_result"; id: string; output: string; is_error: boolean; bytes?: number }
  | {
      type: "permission_request";
      request_id: string;
      tool_name: string;
      input: unknown;
      patterns?: string[];
      always_patterns?: string[];
      suggestions?: PermissionUpdate[];
      description?: string | null;
      blocked_path?: string | null;
    }
  /** The agent now runs under another permission mode (CLI flag form). */
  | { type: "mode_changed"; mode: string }
  | {
      type: "turn_ended";
      result: string | null;
      is_error: boolean;
      duration_ms: number;
      cost_usd: number;
      usage: TurnUsage;
    }
  /** A live context-window reading. Replaces the previous one; the meter's
   * `contextTokens`/`contextWindow` come from here, never from a turn's
   * summed spend. */
  | { type: "context_update"; context_tokens: number; context_window: number }
  /** What the running turn is busy with, or `null` once that is over. */
  | { type: "progress"; progress: TurnProgress | null }
  /** The agent summarized the conversation to make room in its window. */
  | { type: "compacted"; auto: boolean; tokens_before: number; tokens_after: number | null }
  /** The agent answered this turn with another model; `message` says why. */
  | { type: "model_fallback"; from: string; to: string; message: string }
  | { type: "error"; message: string }
  | { type: "exited"; code: number | null };

export interface SessionEventPayload {
  sessionId: number;
  event: HarnessEvent;
}

/** Who caused a synced change: `desktop`, `client:<id>` for one page load of
 * a paired phone, or `null` for the agent itself. */
export type SyncOrigin = string | null;

/** One change on the numbered stream every client follows (`src-tauri/src/
 * sync.rs`). The window receives the kinds it does not already learn through
 * `session-event` as `session-sync` — a message sent from a paired phone, a
 * permission answered there — and the phone reads every kind, harness events
 * included, from its event stream. */
export type SyncEnvelope = {
  seq: number;
  ts: number;
  sessionId: number | null;
  origin: SyncOrigin;
} & (
  | { type: "harness"; payload: HarnessEvent }
  | { type: "user_message"; payload: { text: string } }
  | { type: "permissions"; payload: { state: TurnState; pending: PendingPermission[] } }
  | { type: "decision"; payload: { decisionId: string; response: DecisionResponse } }
  | { type: "session"; payload: unknown }
  | { type: "session_removed"; payload: Record<string, never> }
  | { type: "interrupted"; payload: Record<string, never> }
  | { type: "transcript_reset"; payload: Record<string, never> }
);

/** The `session-titled` event: a small model titled a session after its
 * first turn, replacing the first message's opening line. */
export interface SessionTitledPayload {
  sessionId: number;
  title: string;
}

/** The `worktree-renamed` event: a session's first turn said what it is
 * about, and the worktree at `path` moved off its placeholder branch
 * (`egant/quiet-quartz` → `egant/fix-login-flow`). The folder doesn't move. */
export interface WorktreeRenamedPayload {
  path: string;
  branch: string;
  name: string;
  previousBranch: string;
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
  /** Model the session was started on, or last switched to, if any. */
  modelOverride: string | null;
  /** Reasoning effort the session runs at, if one was picked. */
  variant: string | null;
  /** Context window override requested at creation, if any. */
  context: number | null;
  /** The isolated checkout this session runs in, when it has one. `cwd` names
   * the same directory; this is what says *why* the session is somewhere other
   * than its project folder. */
  worktree: WorktreeInfo | null;
  /** The paired phone that started this session, by name; `null` for one
   * started on this machine. The sidebar's "By device" groups on it. */
  device: string | null;
  ended: boolean;
  /** A turn is in flight or blocked on the user; `state` says which. */
  busy: boolean;
  /** `running` while the agent works, `awaiting_permission` while it waits
   * on the user — a permission, a question, a plan. */
  state: TurnState;
  /** Requests waiting on the user. */
  pendingCount: number;
  model: string | null;
  totalCostUsd: number;
}

/** Which comparison a diff is showing. Mirrors the backend's own enum, and
 * travels with the tab that shows it — a diff tab carries what it is a diff
 * *of*, so reopening one never guesses. */
export type DiffScope =
  | { kind: "workingTree"; staged: boolean }
  | { kind: "branch"; base: string | null }
  | { kind: "turn"; session: number }
  | { kind: "commit"; sha: string };

/** One row of the repository's commit graph. */
export interface Commit {
  sha: string;
  parents: string[];
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Seconds since the epoch, UTC. */
  authoredUnix: number;
  refs: CommitRef[];
}

export interface CommitRef {
  kind: "branch" | "remote" | "tag";
  label: string;
}

export interface HistoryPage {
  commits: Commit[];
  /** The commit the repository is on, so the list can mark it. */
  headSha: string | null;
  /** Pass back as `cursor` for the next page; `null` at the end. */
  nextCursor: number | null;
}

/** One local branch in the composer's ref picker, and where it is checked out. */
export interface RepoRef {
  name: string;
  /** On the project folder itself right now. */
  current: boolean;
  /** The worktree this branch is checked out in, if any — which is what makes
   * it startable without any git running at all. */
  worktreePath: string | null;
}

/** Where a starting session should run. Mirrors the backend's own enum: the
 * composer's two chips resolve to exactly one of these. */
export type CheckoutPlan =
  | { kind: "currentCheckout" }
  | { kind: "reuseWorktree"; path: string; branch: string }
  | { kind: "newWorktree"; base: string | null };

/** A session's own checkout of its repository, on a branch egant made for it. */
export interface WorktreeInfo {
  path: string;
  /** `egant/quiet-quartz` until the first turn renames it after the
   * session's subject (`egant/fix-login-flow`). */
  branch: string;
  /** The branch without its prefix — what the sidebar shows. Not necessarily
   * the folder's name, which keeps its generated one. */
  name: string;
  /** The branch it was cut from. */
  base: string;
  /** The repository it belongs to: the project folder, or a parent of it. */
  repoRoot: string;
}

/** What closing a session answers with. The worktree is given back as part of
 * the same call, so the snapshot here already reflects whatever happened to
 * it. */
/** One archived session (Settings → Archived). Mirrors `ArchivedSessionDto`:
 * read from disk, since an archived session has no row in the window. */
export interface ArchivedSession {
  id: number;
  title: string;
  /** The folder it belongs to — restoring needs that project open. */
  projectPath: string;
  projectName: string;
  agent: string;
  kind: SessionKind;
  startedUnixMs: number;
  archivedAtMs: number;
  branch: string | null;
  /** The worktree kept for it, when it ran in one. */
  worktree: WorktreeInfo | null;
  device: string | null;
}

export interface CloseResult {
  state: WindowState;
  /** Set when the worktree was kept rather than removed — it says where it is
   * and what is in it. */
  notice: string | null;
  /** The kept worktree, for the notice's "Delete it anyway". */
  kept: WorktreeInfo | null;
}

export interface SettingsState {
  wallpaper: string | null;
  wallpaperName: string | null;
  wallpaperDim: number;
  defaultAgent: string;
  /** Whether new sessions get their own worktree. The launch screen's toggle
   * writes it, so the choice is made once rather than per session. */
  worktreeDefault: boolean;
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
  /** Whether the text survives being edited and written back byte for byte:
   * whole (not the head of a big file) and genuinely UTF-8. */
  editable: boolean;
  /** The file's modification time when it was read. A save is made against it
   * and refused if the file has moved on. */
  modifiedMs: number;
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
  /** What the current branch tracks, e.g. `origin/main`. `null` when it
   * tracks nothing. */
  upstream: string | null;
  /** When the repo last fetched, seconds since the epoch. `null` when never —
   * the panel reads that as "behind may be stale, fetch to check". */
  lastFetchedUnix: number | null;
  /** The branch this repository integrates into — what a branch-scope diff
   * measures against when nothing else names a base. */
  defaultBase: string | null;
}

/** Which side of a conflict to keep. `both` only makes sense for a content
 * conflict — a delete conflict has nothing to combine. */
export type ConflictSide = "ours" | "theirs" | "both";

/** The two-letter `git status` shape of one unmerged path. `bothModified` is
 * the ordinary case; the rest are a delete/modify conflict from either side. */
export type UnmergedKind =
  | "bothModified"
  | "bothAdded"
  | "bothDeleted"
  | "addedByUs"
  | "addedByThem"
  | "deletedByUs"
  | "deletedByThem";

export interface UnmergedFile {
  path: string;
  kind: UnmergedKind;
}

/** Where a stalled merge/rebase stands (`conflict_status`). `operation` is
 * `"none"` when nothing is in progress, which can still leave `files`
 * non-empty — e.g. right after a `stash pop` that collided. */
export interface ConflictStatus {
  operation: "merge" | "rebase" | "none";
  files: UnmergedFile[];
}

/** One `<<<<<<<`/`=======`/`>>>>>>>` region in a conflicted file
 * (`conflict_blocks`), for the quick-action buttons drawn over it. */
export interface ConflictBlock {
  index: number;
  startLine: number;
  endLine: number;
  oursLabel: string;
  theirsLabel: string;
  ours: string;
  theirs: string;
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

/** A Browser tab's page changed — navigated, or finished loading — as
 * emitted on `browser-nav`. Drives the address bar and the tab's title. */
export interface BrowserNav {
  label: string;
  url: string;
  loading: boolean;
}

/** What Settings → Devices shows about Tailscale (`mobile_status`). */
export interface TailscaleStatus {
  installed: boolean;
  /** The daemon's own word for its state: `Running`, `Stopped`, `NeedsLogin`… */
  backendState: string | null;
  running: boolean;
  /** This Mac on the tailnet, e.g. `diells-macbook-air.tail1234.ts.net`. */
  dnsName: string | null;
  /** Whether the tailnet issues HTTPS certificates. */
  httpsEnabled: boolean;
  /** `tailscale serve` already sends egant's HTTPS port to egant. */
  serving: boolean;
  /** Another `tailscale serve` entry holds the port. */
  portConflict: boolean;
  /** The Funnel port opening egant to the internet: the public link is live. */
  funnelPort: number | null;
  /** Every Funnel port (443, 8443, 10000) already serves something else. */
  funnelBlocked: boolean;
  error: string | null;
}

/** The public link: Tailscale Funnel in front of phone access, so a phone
 * opens egant from any network with nothing installed. */
export interface MobilePublicLink {
  /** Wanted: it comes back whenever phone access does. */
  on: boolean;
  live: boolean;
  /** `https://<mac>.<tailnet>.ts.net`, while live. */
  url: string | null;
  /** Why it couldn't open — often naming the Tailscale page that fixes it. */
  error: string | null;
  /** What to run by hand when egant can't open it itself. */
  command: string;
  /** When egant opened it in this run. */
  openedMs: number | null;
}

/** A phone paired with this Mac. */
export interface MobileDevice {
  id: string;
  name: string;
  createdMs: number;
  lastSeenMs: number;
  /** Has an event stream open right now. */
  connected: boolean;
}

/** Phone access, as Settings → Devices shows it. */
export interface MobileStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  error: string | null;
  tailscale: TailscaleStatus;
  /** Where a QR code sends a phone: the public link, while it is live. */
  url: string | null;
  /** This Mac's tailnet-only address, once `tailscale serve` is up. */
  tailnetUrl: string | null;
  public: MobilePublicLink;
  /** The website preview: the second port that shows a phone a site. */
  preview: MobilePreview;
  /** The phone app on this Mac, for trying it in a desktop browser. */
  localUrl: string;
  serveCommand: string;
  devices: MobileDevice[];
}

/** The website preview beside the phone link (`PreviewDto`). */
export interface MobilePreview {
  /** Its listener is up on this Mac. */
  running: boolean;
  /** A phone on the tailnet can reach it. */
  tailnet: boolean;
  /** The Funnel port it is open on, for a phone on the public link. */
  publicPort: number | null;
  /** Why it can't be reached, where that is known. */
  error: string | null;
}

/** A pairing code and the QR code that carries it (`mobile_create_pairing`). */
export interface MobilePairing {
  /** `ABCDE-FGHJK`, for typing into a phone that can't scan. */
  code: string;
  url: string | null;
  /** `url` is the public link: the phone needs nothing installed. */
  public: boolean;
  localUrl: string;
  qrSvg: string | null;
  expiresAtMs: number;
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
