// The window's client-side state: the last `WindowState` snapshot, one live
// transcript per session, and the wallpaper. Events arriving on
// `session-event` are folded into the transcript mirror (see
// `lib/transcript.ts`); everything else round-trips through commands.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, pickProjectFolder, pickWallpaperImage } from "./lib/api";
import { log, preview } from "./lib/logger";
import { noteInterrupt, notifySession } from "./lib/notify";
import { isLinux } from "./lib/platform";
import {
  applyEvent,
  emptyTranscript,
  formatDecisionReply,
  fromDto,
  markRunning,
  pushUser,
  resolvePermission,
} from "./lib/transcript";
import { parseContext } from "./lib/types";
import type {
  AgentCatalogEntry,
  AgentModel,
  AgentStatus,
  CheckoutPlan,
  ClaudeUsage,
  DecisionRequest,
  DecisionResponse,
  DiffScope,
  GitChange,
  GitChangeStatus,
  PermissionDecision,
  PermissionReply,
  RepoRef,
  SessionEventPayload,
  QueuedMessage,
  SessionInfo,
  SessionQueuePayload,
  SessionTitledPayload,
  SyncEnvelope,
  TranscriptDto,
  TranscriptState,
  WindowState,
  WorktreeInfo,
  WorktreeRenamedPayload,
} from "./lib/types";

export type SettingsSection =
  | "devices"
  | "agents"
  | "accounts"
  | "appearance"
  | "files"
  | "notifications"
  | "shortcuts"
  | "appshots"
  | "archived";

/** Something the window has to say that the user didn't ask to see: a
 * worktree kept back rather than deleted with its session, a conversation
 * just archived. Not an error — nothing went wrong — so it gets its own
 * channel rather than borrowing the red one. */
export interface Notice {
  text: string;
  /** Set when the notice is about a kept worktree, which the window then
   * offers to delete after all. */
  worktree: WorktreeInfo | null;
  /** Set when the notice is about a conversation just archived, which the
   * window then offers to bring back. */
  undo?: { sessionId: number } | null;
}

/** Which side of the repository the next session runs on. `current` is the
 * folder the user opened; `worktree` cuts a fresh checkout for the session.
 * `null` follows the saved default — see [`checkoutKind`]. */
export type CheckoutKind = "current" | "worktree";

/** The effective checkout kind: the explicit pick, else what was saved. */
export function checkoutKind(
  picked: CheckoutKind | null,
  snapshot: WindowState | null,
): CheckoutKind {
  if (picked) return picked;
  return snapshot?.settings.worktreeDefault ? "worktree" : "current";
}

/** The branch the project folder is on, once the refs have loaded. */
export function currentRef(refs: RepoRef[]): string | null {
  return refs.find((row) => row.current)?.name ?? null;
}

/** What the two chips resolve to, in the backend's own words.
 *
 * Three outcomes from two controls: a fresh worktree off the picked ref; an
 * existing worktree the picked ref already lives in, borrowed as a working
 * directory; or the project folder as it stands. egant never checks a branch
 * out in the folder you opened — see `setComposerRef`. */
export function checkoutPlan(
  kind: CheckoutKind,
  picked: string | null,
  refs: RepoRef[],
): CheckoutPlan {
  if (kind === "worktree") return { kind: "newWorktree", base: picked };
  const row = refs.find((candidate) => candidate.name === picked);
  if (row?.worktreePath) {
    return { kind: "reuseWorktree", path: row.worktreePath, branch: row.name };
  }
  return { kind: "currentCheckout" };
}

/** Sidebar view options — ORGANIZE section. `byDevice` is zeron's default: one
 * section per machine (egant only ever has the one), `flat` is "None". */
export type SidebarOrganize = "byDevice" | "byProject" | "flat";
const SIDEBAR_ORGANIZE: readonly SidebarOrganize[] = ["byDevice", "byProject", "flat"];

/** The sessions the sidebar lists for a project filter — `null` is "All
 * projects". Shared by the list itself and by ‹ › navigation, so stepping
 * through conversations never leaves the folder the sidebar is showing. */
export function sessionsInProject(
  snapshot: WindowState | null,
  project: number | null,
): SessionInfo[] {
  const sessions = snapshot?.sessions ?? [];
  return project == null ? sessions : sessions.filter((s) => s.projectId === project);
}
/** Sidebar filter popover — SORT section. */
export type SidebarSort = "updated" | "created";

/** What a workspace-panel tab holds: the project's files, a shell, a diff of
 * the repository, its commit graph, or a real web page. */
export type PanelTabKind = "files" | "terminal" | "diffs" | "history" | "browser";

/** One tab in the workspace panel on the right. The Files tab is a tree of
 * the project; a terminal tab owns one PTY for as long as it is open. */
export interface PanelTab {
  id: string;
  kind: PanelTabKind;
  title: string;
  /** The shell's working directory, captured at creation so switching
   * conversations can't move a running shell out from under itself. The Files
   * tab ignores it and follows the conversation in front of you instead —
   * a tree, unlike a shell, has nothing running in it to disturb. */
  cwd: string;
  /** Which comparison a Diffs tab is showing. Per tab rather than per window,
   * so two of them can sit side by side on different scopes — which is the
   * point of being able to open a second one. */
  scope?: DiffScopeKind;
  /** What a branch scope measures against, when the user has picked something
   * other than the obvious answer. `undefined` follows the session's worktree
   * base, then the repository's own integration branch. */
  base?: string;
  /** The live PTY, once the pane has spawned its shell. Terminal tabs only. */
  ptyId?: number;
  /** Set when that shell exits, so the tab can say so instead of looking live. */
  exited?: boolean;
  /** Browser tabs only: the page's current address, once it has navigated
   * anywhere — `undefined` is the tab's own "new tab" screen, before it has
   * a webview at all. The tab's own id doubles as its webview's label. */
  url?: string;
  /** Browser tabs only: whether the page is between a navigation and its
   * load finishing. */
  loading?: boolean;
}

/** The comparisons a Diffs tab offers, in the order its menu lists them.
 * A commit scope is never in this list — a commit tab is opened by clicking a
 * row in History, and stays pinned to that commit. */
export type DiffScopeKind = "workingTree" | "branch" | "turn";

export const DIFF_SCOPES: readonly DiffScopeKind[] = ["workingTree", "branch", "turn"];

export function diffScopeLabel(scope: DiffScopeKind): string {
  switch (scope) {
    case "branch":
      return "Branch changes";
    case "turn":
      return "Latest turn";
    default:
      return "Working tree";
  }
}

export function diffScopeHint(scope: DiffScopeKind): string {
  switch (scope) {
    case "branch":
      return "Everything this branch adds over the one it was cut from, uncommitted work included";
    case "turn":
      return "What has changed since the last message was sent";
    default:
      return "Uncommitted work: the index against HEAD, and the disk against the index";
  }
}

/** The scope payload for a tab's kind, resolved against the session it is
 * showing — a branch scope needs to know what the branch was cut from, and a
 * turn scope needs to know whose turn. */
export function panelScope(
  kind: DiffScopeKind,
  session: SessionInfo | undefined,
  base?: string,
): DiffScope | undefined {
  switch (kind) {
    case "branch":
      // The tab's own pick first, then what this session's worktree was cut
      // from, and failing both the backend's answer for the repository.
      return { kind: "branch", base: base ?? session?.worktree?.base ?? null };
    case "turn":
      // No session to measure a turn against: fall back to uncommitted work
      // rather than asking the backend about a turn that doesn't exist.
      return session ? { kind: "turn", session: session.id } : undefined;
    default:
      return undefined;
  }
}

/** Which side of git a diff is showing. `disk` and `staged` are the working
 * tree's two sides — the only ones the panel can stage or discard — and the
 * rest are read-only comparisons a diff tab was opened onto. */
export type DiffGroup = "disk" | "staged" | "branch" | "turn" | "commit";

/** One tab on the stage beside the conversation: a file from the tree, or a
 * diff from the Changes tab. */
export interface StageTab {
  /** Unique within a conversation. A file is keyed by its path; a diff by its
   * group and path, so the same file can be open as a file and as a diff. */
  key: string;
  kind: "file" | "diff";
  /** Absolute for a file, repo-relative for a diff — which is how git names
   * it, and what `diff_file` expects. */
  path: string;
  name: string;
  /** Diffs only. */
  group?: DiffGroup;
  /** Diffs only: exactly what this tab is a diff *of*, captured when it was
   * opened. A tab that outlives the panel's own scope menu still shows what it
   * was opened to show. */
  scope?: DiffScope;
  status?: GitChangeStatus;
  /** Diffs only: the repository the path is relative to. */
  root?: string;
}

/** The suffix a diff tab carries after its filename, naming what it is a diff
 * of. A commit's is its short sha, which is the only one of these that names a
 * specific thing rather than a side. */
export function diffGroupSuffix(group: DiffGroup, sha?: string): string {
  switch (group) {
    case "staged":
      return "(Index)";
    case "branch":
      return "(Branch)";
    case "turn":
      return "(Latest turn)";
    case "commit":
      return `(${(sha ?? "").slice(0, 7)})`;
    default:
      return "(Working Tree)";
  }
}

/** The key a diff tab is addressed by. The sha is part of it so two commits'
 * versions of one file are two tabs, not one that keeps replacing itself. */
export function diffTabKey(group: DiffGroup, path: string, sha?: string): string {
  return sha ? `diff:${group}:${sha}:${path}` : `diff:${group}:${path}`;
}

/** The stage's tab strip addresses the conversation by this key; every other
 * key is an open file's path. */
export const CHAT_TAB = "chat";

export type AppearanceMode = "system" | "light" | "dark";
export type GlassMode = "default" | "frosted" | "clear" | "opaque";
export type BgEffect = "none" | "dither" | "ascii" | "halftone" | "scanlines";

export interface AppearanceState {
  mode: AppearanceMode;
  /** Palette id used when the light appearance is active. */
  lightTheme: string;
  /** Palette id used when the dark appearance is active. */
  darkTheme: string;
  /** `default` keeps the palette's intended color, otherwise a hex accent. */
  accent: string;
  glass: GlassMode;
  bgEffect: BgEffect;
}

// The workspace panel's hard ceiling — a fixed pixel position, not one
// computed off the window size, so how far it can be dragged never changes
// out from under the user. The chat stage has no matching floor: it's meant
// to flex into whatever room is left, the way Claude's own chat column does.
const PANEL_MAX_WIDTH = 560;

const APPEARANCE_KEY = "egant.appearance";

const DEFAULT_APPEARANCE: AppearanceState = {
  mode: "dark",
  lightTheme: "zeron-light",
  darkTheme: "zeron-dark",
  accent: "default",
  glass: "default",
  bgEffect: "none",
};

function loadAppearance(): AppearanceState {
  try {
    const raw = localStorage.getItem(APPEARANCE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<AppearanceState>;
    return { ...DEFAULT_APPEARANCE, ...parsed };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

/** Which appearance — light or dark — the window currently resolves to. */
export function resolveTheme(appearance: AppearanceState): "light" | "dark" {
  if (appearance.mode === "light") return "light";
  if (appearance.mode === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function luminance(hex: string): number {
  const m = hex.replace("#", "");
  const full = m.length === 3 ? m.split("").map((c) => c + c).join("") : m;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Paints the resolved appearance onto the document: palette, glass, accent
 * and toggle colors. Called on every change and on system theme flips. */
export function applyAppearance(appearance: AppearanceState): void {
  const theme = resolveTheme(appearance);
  const palette = theme === "light" ? appearance.lightTheme : appearance.darkTheme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = palette;
  root.dataset.glass = appearance.glass === "opaque" ? "opaque" : appearance.glass === "clear" ? "clear" : "frosted";
  // Linux has no native vibrancy; `tauri.linux.conf.json` uses an opaque
  // window. Tag the document so CSS can swap transparent washes for solid
  // fills + in-window blur without touching the macOS frosted path.
  if (isLinux()) {
    root.dataset.platform = "linux";
  } else {
    delete root.dataset.platform;
  }
  const toggleOn =
    appearance.accent === "default"
      ? theme === "light"
        ? "#17171c"
        : "#e0e0e0"
      : appearance.accent;
  root.style.setProperty("--toggle-on", toggleOn);
  root.style.setProperty(
    "--toggle-knob",
    luminance(toggleOn) > 0.45 ? "#0a0a0d" : "#ffffff",
  );
  root.style.setProperty(
    "--accent",
    appearance.accent === "default" ? "#8e7cf6" : appearance.accent,
  );

  // The window itself: titlebar theme and (macOS only) the real
  // frosted-glass blur behind the transparent stage. The blur stays on in
  // every Glass mode — including No Glass, where the sidebar is the one
  // surface that keeps its glass look and needs live blur behind it.
  // Fire-and-forget — a rejected invoke (e.g. no window yet on first
  // paint) just leaves the window at its previous state, which is harmless.
  void api.syncWindowAppearance(theme === "dark", true).catch(() => {});
}

interface EgantStore {
  snapshot: WindowState | null;
  transcripts: Record<number, TranscriptState>;
  wallpaperUrl: string | null;
  /** The sidebar's filter text — keystroke-rate, kept next to the list it
   * narrows. */
  filter: string;
  /** Whether the sidebar's filter popover (search + organize/sort/show) is
   * revealed. It stays hidden until asked for, which is why the header
   * carries a filter button. */
  filterOpen: boolean;
  /** Group sessions by machine or by project, or keep the one flat list. */
  sidebarOrganize: SidebarOrganize;
  setSidebarOrganize: (mode: SidebarOrganize) => void;
  /** Which project the sidebar lists — `null` is "All projects". Deliberately
   * not `snapshot.activeProject`: opening a session moves that to the
   * session's owner, which would silently narrow an "All projects" list to one
   * folder the moment anything was clicked. */
  sidebarProject: number | null;
  setSidebarProject: (project: number | null) => void;
  /** `updated` reads newest-first; `created` reads oldest-first. There is no
   * separate last-activity clock, so `updated` is `startedUnixMs` descending —
   * the closest proxy the backend tracks today. */
  sidebarSort: SidebarSort;
  setSidebarSort: (mode: SidebarSort) => void;
  /** Whether a row's meta line also names its git branch. */
  sidebarShowBranch: boolean;
  setSidebarShowBranch: (on: boolean) => void;
  /** Whether a row carries its harness logo beside the title. */
  sidebarShowHarness: boolean;
  setSidebarShowHarness: (on: boolean) => void;
  /** Whether a row's first line names `project @ machine`. */
  sidebarShowLocation: boolean;
  setSidebarShowLocation: (on: boolean) => void;
  /** Hides every session still on its project's own checkout, leaving only
   * the ones running in a worktree of their own — just the folders, not the
   * "normal" chats sitting outside any of them. */
  sidebarWorktreesOnly: boolean;
  setSidebarWorktreesOnly: (on: boolean) => void;
  /** Sidebar width in px — dragged from its right edge, clamped to a
   * sensible range. Persisted so a resize survives reopening the window. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  /** Which sidebar sections are collapsed, keyed `device:<machine>` or
   * `project:<id>` so switching how the list is organized never collapses a
   * section that just happens to share a key with another grouping. */
  collapsedGroups: Record<string, boolean>;
  toggleGroupCollapsed: (key: string) => void;
  /** The workspace panel on the right: the project's files and its
   * terminals. Closed until asked for — the window is a conversation first. */
  panelOpen: boolean;
  panelWidth: number;
  /** The panel filling everything right of the sidebar, with the conversation
   * slid out from under it. Persisted: it is a way of working (reading a diff
   * full width) rather than a mode you fall into by accident. */
  panelMaximized: boolean;
  togglePanelMaximized: () => void;
  setPanelWidth: (width: number) => void;
  /** Panel tabs are the window's, not a conversation's: a shell running a
   * build should not vanish because the sidebar moved to another thread. */
  panelTabs: PanelTab[];
  /** Active panel tab id, or `null` when the panel holds none. */
  panelTab: string | null;
  setPanelTab: (id: string) => void;
  /** Shows or hides the panel. With no tabs open it shows its two buttons,
   * Files and Terminal, rather than choosing one on the user's behalf. */
  togglePanel: () => void;
  /** Reveals the file tree — focuses the existing Files tab rather than
   * opening a second copy of the same tree. */
  openFilesTab: () => void;
  /** Opens a shell. `cwd` pins where it spawns — the Run pill passes its
   * session's working directory so the shell lands in the worktree, not
   * wherever the panel happened to point. Returns the new tab's id so the
   * caller can type into it. */
  openTerminalTab: (cwd?: string) => string;
  openHistoryTab: () => void;
  /** Opens a fresh Browser tab onto its own "new tab" screen — unlike Files
   * or Diffs, a second one is exactly the point (two pages open side by
   * side), so this never reuses an existing tab. Returns the new tab's id. */
  openBrowserTab: () => string;
  /** What a Browser tab's page reports about itself, off the `browser-nav`
   * event — the address bar and the tab strip's title are both driven from
   * this rather than owning their own copy of it. */
  updateBrowserTab: (
    id: string,
    patch: Partial<Pick<PanelTab, "url" | "loading" | "title">>,
  ) => void;
  /** Changes which comparison a Diffs tab is showing. */
  setPanelScope: (tabId: string, scope: DiffScopeKind) => void;
  /** Changes what a branch scope measures against. */
  setPanelBase: (tabId: string, base: string) => void;
  /** Same one-of-a-kind rule as the tree: one Changes tab per window. */
  openDiffsTab: () => void;
  closePanelTab: (id: string) => void;
  /** The pane reports the PTY it spawned back to the tab that owns it, which
   * is what lets closing the tab kill the shell. */
  attachPty: (id: string, ptyId: number) => void;
  markPtyExited: (ptyId: number) => void;

  /** What is open on the stage, per conversation: files from the tree and
   * diffs from the Changes tab, each conversation keeping its own set. */
  stageTabs: Record<number, StageTab[]>;
  /** Which stage tab each conversation is showing (`CHAT_TAB` or a tab key). */
  stageTab: Record<number, string>;
  openFile: (sessionId: number, path: string, name: string) => void;
  /** Opens a change as a diff tab, or focuses it if it is already open. */
  openDiff: (
    sessionId: number,
    root: string,
    change: GitChange,
    group: DiffGroup,
    scope?: DiffScope,
  ) => void;
  /** Opens one file's diff inside one commit, from a History row. */
  openCommitDiff: (sessionId: number, root: string, sha: string, change: GitChange) => void;
  closeStageTab: (sessionId: number, key: string) => void;
  setStageTab: (sessionId: number, key: string) => void;
  /** Bumped whenever something may have changed the working tree — a turn
   * ending, or the panel's own git actions. The Changes tab refetches on it
   * rather than polling. */
  changesToken: number;
  refreshChanges: () => void;

  /** The composer's `/model` or `/mode` asking a session's picker to open:
   * the picker watches `token`, so asking twice opens it twice. */
  pickerRequest: { sessionId: number; kind: "model" | "mode"; token: number } | null;
  /** Bumped to move focus; components watch the counter, not the value. */
  focusComposerToken: number;
  focusFilterToken: number;
  error: string | null;
  notice: Notice | null;
  dismissNotice: () => void;
  /** Deletes a worktree that closing its session decided to keep — the
   * notice's "Delete it anyway", taken after the user has read what is in it. */
  discardKeptWorktree: (worktree: WorktreeInfo) => Promise<void>;
  /** Whether new sessions get their own checkout of the project. Persisted:
   * it is a working habit, not a per-session decision, and the launch screen's
   * chip is the only place it is set. */
  setWorktreeDefault: (on: boolean) => Promise<void>;

  /** The launch composer's checkout chip. `null` follows the saved default;
   * picking from the menu sets it *and* saves it. */
  composerCheckout: CheckoutKind | null;
  setComposerCheckout: (kind: CheckoutKind) => Promise<void>;
  /** The ref the next session starts from — a worktree's base, or the branch
   * of an existing worktree to run in. `null` means the project folder's own
   * branch. */
  composerRef: string | null;
  setComposerRef: (name: string) => void;
  /** Local branches of the project in front of you, for the ref chip. */
  refs: RepoRef[];
  refsLoading: boolean;
  fetchRefs: (root: string) => Promise<void>;

  /** True from the moment "+"/⌘N is clicked until the resulting first
   * message actually creates a session. Keeps the picker's pick from being
   * discarded by an already-spawned session sitting behind the launch
   * screen — see `createSession` and `sendOnLaunch`. */
  startingNewSession: boolean;
  /** Set when the pending new session (above) was started from a worktree
   * folder's own "+" — the launch composer's checkout chips are for a fresh
   * pick, so this pins `sendOnLaunch` to reuse this exact worktree instead of
   * resolving `composerCheckout`/`composerRef`. Cleared wherever
   * `startingNewSession` is. */
  startingNewSessionWorktree: WorktreeInfo | null;

  /** `list_agents` snapshot: CLI presence and login per agent. Powers the
   * composer picker and the Agents/Accounts settings sections. */
  agents: AgentStatus[];
  /** Agent the next session starts with (`null` = saved default). */
  composerAgent: string | null;
  /** Model override for the next session (`""` = per-agent default). */
  composerModel: string;
  /** Reasoning variant for the next opencode session (`""` = per-agent default). */
  composerVariant: string;
  /** Context window override for the next session (`""` = per-agent default,
   * which itself falls back to the model's own window). Stored raw
   * ("200K"); parsed with `parseContext` when read. */
  composerContext: string;
  /** Whether the next session should start in `bypassPermissions` — the
   * picker's toggle, for before a session (and therefore its own Mode menu)
   * exists yet. Applied right after creation in `sendOnLaunch` /
   * `openFolderDialog`; an existing session flips it via `ModeInfo`'s own
   * Bypass permissions row instead. */
  composerBypass: boolean;
  setComposerAgent: (agent: string | null) => void;
  setComposerModel: (model: string) => void;
  setComposerVariant: (variant: string) => void;
  setComposerContext: (context: string) => void;
  setComposerBypass: (bypass: boolean) => void;
  fetchAgents: () => Promise<void>;
  /** `list_agent_catalog`: every agent egant knows how to install, with CLI
   * presence. Wider than `agents`, which only covers the drivable registry —
   * the picker needs it to show an installed agent that has no harness. */
  catalog: AgentCatalogEntry[];
  fetchCatalog: () => Promise<void>;
  /** Like `fetchAgents`, but follows the cheap presence-based list with a
   * live login recheck for the agents the CLI can answer fast (Claude,
   * Codex) — the same live check "Refresh" runs. `list_agents` alone only
   * knows a credentials file exists, which can read "connected" for an
   * account whose token expired days ago; this is what keeps Settings from
   * saying that. Called on Settings > Agents/Accounts open and once at
   * launch, never from a hot path. */
  verifyAgents: () => Promise<void>;
  /** Models for the picker's agent, with loading state. Refetched on picker
   * open so newly logged-in providers appear. */
  models: AgentModel[];
  modelsAgent: string | null;
  modelsLoading: boolean;
  fetchModels: (agent: string) => Promise<void>;
  /** Every catalog fetched, keyed by agent, and persisted to localStorage so
   * a fresh launch paints the list it showed last time instead of waiting on
   * a CLI. Switching tabs in the picker draws from here instantly and
   * revalidates behind it. */
  modelCache: Record<string, AgentModel[]>;
  /** Refreshes `modelCache` for an agent the picker isn't showing yet, so the
   * other tabs are already warm by the time they're clicked. Best-effort and
   * silent: failures surface through `fetchModels` if that tab is opened. */
  warmModels: (agent: string) => Promise<void>;

  /** Claude's 5-hour and weekly usage, for the composer's limit pill. `null`
   * before the first fetch, or when Claude isn't logged in on this device.
   * Refetched after a Claude turn ends and on a slow poll while a Claude
   * composer is showing — see `Composer`'s effect. */
  claudeUsage: ClaudeUsage | null;
  fetchClaudeUsage: () => Promise<void>;

  /** Which agents the composer offers (`egant.agents` in localStorage).
   * Settings > Agents writes it; the picker reads it. Defaults enable the
   * three drivable agents. */
  enabledAgents: Record<string, boolean>;
  setAgentEnabled: (id: string, on: boolean) => void;
  /** Which of the agents egant *can* render in the chat UI the user still
   * wants it to (`egant.chatUi` in localStorage). On by default — turning
   * one off is what makes picking that agent open its own CLI instead.
   * Agents egant has no harness for are never in here: `usesChatUi` reads
   * the catalog's `chatUi` first, and that is not a preference. */
  chatUiAgents: Record<string, boolean>;
  setChatUi: (id: string, on: boolean) => void;

  /** The agent whose CLI the launch dialog is offering to open, or `null`
   * when no dialog is up. Opening a terminal onto an agent is not something
   * to do on a stray click — the dialog is the confirmation, and it is the
   * one place that says what is about to run. */
  cliLaunch: string | null;
  askCliLaunch: (agent: string) => void;
  cancelCliLaunch: () => void;
  /** Opens a CLI session for `agent` in the active project and selects it.
   * Resolves `false` when it couldn't start — the error toast carries why. */
  startCliSession: (agent: string) => Promise<boolean>;
  /** Per-agent default model (`""` = CLI default). Settings > Agents writes
   * it; session creation falls back to it when the composer has no override. */
  defaultModels: Record<string, string>;
  setDefaultModel: (agent: string, model: string) => void;
  /** Per-agent default reasoning variant (`""` = CLI default). */
  defaultVariants: Record<string, string>;
  setDefaultVariant: (agent: string, variant: string) => void;
  /** Per-agent default context window (`""` = model/CLI default). Stored raw
   * ("200K"); parsed with `parseContext` when read. */
  defaultContexts: Record<string, string>;
  setDefaultContext: (agent: string, context: string) => void;
  /** Starred models (`${agent}:${modelId}` → true). Floats those models to
   * the top of the picker's list, and backs its per-row star toggle. */
  starredModels: Record<string, boolean>;
  toggleStarred: (agent: string, modelId: string) => void;

  /** Settings overlay: whether it covers the window and which section it
   * shows. Frontend-only; the sections themselves persist what they need. */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection, agentId?: string) => void;
  /** Which agent's sheet Settings > Agents should open on arrival, so the
   * composer's picker can deep-link into one. Cleared once consumed. */
  agentSheetId: string | null;
  setAgentSheetId: (id: string | null) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;

  /** Appearance (Settings > Appearance). Persisted to localStorage and
   * painted onto the document by `applyAppearance`. */
  appearance: AppearanceState;
  setAppearance: (patch: Partial<AppearanceState>) => void;

  setFilter: (filter: string) => void;
  openFilter: () => void;
  closeFilter: () => void;
  /** The full-screen search modal — every session and project, not just the
   * ones the sidebar's own scroll happens to have on screen. Separate from
   * the sidebar's filter popover, which only narrows that one list. */
  searchOpen: boolean;
  openSearch: () => void;
  closeSearch: () => void;
  requestFocusComposer: () => void;
  requestPicker: (sessionId: number, kind: "model" | "mode") => void;
  dismissError: () => void;

  /** Loads state, starts the event stream, and returns its cleanup. */
  init: () => Promise<UnlistenFn>;
  refresh: () => Promise<void>;
  ensureTranscript: (id: number) => Promise<void>;

  openFolderDialog: () => Promise<void>;
  selectProject: (id: number) => Promise<void>;
  /** Unpins the project selection — "All projects" in the sidebar switcher. */
  selectAllProjects: () => Promise<void>;
  toggleSidebar: () => Promise<void>;

  /** Optionally pins the session about to start to an existing worktree —
   * see `startingNewSessionWorktree`. */
  createSession: (worktree?: WorktreeInfo) => Promise<void>;
  selectSession: (id: number) => Promise<void>;
  closeSession: (id: number) => Promise<void>;
  /** Each session's queue: messages sent while its agent was busy, waiting
   * for the turn to end. The backend's; mirrored from what it answers and
   * from `session-queue`. */
  queues: Record<number, QueuedMessage[]>;
  /** Takes a queued message back out; resolves to its text, for the composer
   * to put back when the user wants to edit it. */
  unqueueMessage: (id: number, queuedId: number) => Promise<string | null>;
  /** Sends a queued message now — stopping the running turn if need be. */
  sendQueuedNow: (id: number, queuedId: number) => Promise<void>;
  /** Renames a session to what the user typed. Shown at once; put back if
   * the backend refuses it. */
  renameSession: (id: number, title: string) => Promise<void>;
  /** Out of the window, kept on disk — what the sidebar's corner button does,
   * with Undo on the notice that follows. */
  archiveSession: (id: number) => Promise<void>;
  /** Back into the window, selected. Resolves to whether it came back; the
   * reason it didn't is in `error`. */
  unarchiveSession: (id: number) => Promise<boolean>;
  /** Gone for good (Settings → Archived → Delete). Resolves like
   * `unarchiveSession`. */
  deleteArchivedSession: (id: number) => Promise<boolean>;
  selectPrevSession: () => Promise<void>;
  selectNextSession: () => Promise<void>;
  /** Send from the launch screen: opens a folder / session first if needed,
   * then delivers the text into the resulting session. */
  sendOnLaunch: (text: string, images?: string[]) => Promise<void>;
  send: (id: number, text: string, images?: string[]) => Promise<void>;
  interrupt: (id: number) => Promise<void>;
  /** Answers one outstanding request — a bare decision, or a reply carrying
   * what that decision takes (answers, feedback, a mode). */
  answerPermission: (
    id: number,
    requestId: string,
    reply: PermissionReply | PermissionDecision,
  ) => Promise<void>;
  /** Answers to `agent_request` entries the transcript fold pulled out of the
   * agent's own text — keyed `${sessionId}:${decisionId}` so a reload or a
   * session switch still shows the card as completed. The backend keeps the
   * same answers (and hands them back with each transcript), which is how a
   * prompt answered on a paired phone shows as answered here too; this map
   * is the window's copy, also kept in localStorage (`loadDecisionResponses`). */
  decisionResponses: Record<string, DecisionResponse>;
  /** Sessions with news since they were last on screen — a turn that
   * finished, or a question waiting — while another conversation was open.
   * This window's own reading, kept in localStorage (`egant.unread`); the
   * sidebar draws a dot for each. */
  unread: Record<number, true>;
  answerDecision: (
    sessionId: number,
    decision: DecisionRequest,
    response: DecisionResponse,
  ) => Promise<void>;
  cycleMode: (id: number) => Promise<void>;
  /** Jumps straight to a named mode, for the mode-info popover's rows. */
  setMode: (id: number, mode: string) => Promise<void>;
  /** Moves a running session onto another model and/or effort, keeping the
   * conversation. `""` for either means the CLI's own default. */
  setSessionModel: (id: number, model: string, variant: string) => Promise<void>;

  chooseWallpaper: () => Promise<void>;
  clearWallpaper: () => Promise<void>;
  cycleDim: () => Promise<void>;
}

function fail(set: (patch: Partial<EgantStore>) => void, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  log.error("store", message, error);
  set({ error: message });
}

function loadString(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function saveString(key: string, value: string | null): void {
  try {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Unavailable storage: the window keeps the in-memory choice.
  }
}

/** Agent id the next session starts with: the composer's pick, else the
 * saved backend default. */
export function selectNextAgent(
  snapshot: WindowState | null,
  composerAgent: string | null,
): string {
  if (composerAgent) return composerAgent;
  return snapshot?.settings.defaultAgent || "claude";
}

function loadBool(key: string, fallback: boolean): boolean {
  const raw = loadString(key);
  if (raw === null) return fallback;
  return raw === "true";
}

function loadNumber(key: string, fallback: number): number {
  const raw = loadString(key);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function loadRecord(key: string): Record<string, string> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, string>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function loadBoolRecord(key: string, fallback: Record<string, boolean>): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    if (typeof parsed !== "object" || parsed === null) return fallback;
    return { ...fallback, ...parsed };
  } catch {
    return fallback;
  }
}

/** Catalogs from earlier runs (`egant.modelCache`). Discovery costs a CLI
 * spawn for Codex and opencode, so the first open of a session used to sit on
 * "Loading models…" every single launch; with this it paints the list it
 * showed last time and refreshes behind it. Entries are shape-checked, since a
 * stale or hand-edited value would otherwise reach the picker's renderer. */
function loadModelCache(): Record<string, AgentModel[]> {
  try {
    const raw = localStorage.getItem("egant.modelCache");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, AgentModel[]> = {};
    for (const [agent, models] of Object.entries(parsed)) {
      if (
        Array.isArray(models) &&
        models.every(
          (m) =>
            m != null &&
            typeof m.id === "string" &&
            typeof m.name === "string" &&
            Array.isArray(m.variants),
        )
      ) {
        out[agent] = models as AgentModel[];
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveModelCache(cache: Record<string, AgentModel[]>) {
  try {
    localStorage.setItem("egant.modelCache", JSON.stringify(cache));
  } catch {
    // Unavailable storage: the run keeps its in-memory cache.
  }
}

function loadStarred(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem("egant.starredModels");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean>;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

/** Decision-prompt answers, keyed `${sessionId}:${decisionId}` — local-only
 * state, never round-tripped through the backend, so it survives a reload
 * the same way the starred-models map does. Malformed or foreign entries
 * (an older shape, hand-edited storage) are dropped rather than shown as a
 * broken card. */
function loadDecisionResponses(): Record<string, DecisionResponse> {
  try {
    const raw = localStorage.getItem("egant.decisionResponses");
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== "object" || parsed === null) return {};
    const out: Record<string, DecisionResponse> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (
        value !== null &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "decision" &&
        Array.isArray((value as { selectedOptionIds?: unknown }).selectedOptionIds)
      ) {
        out[key] = value as DecisionResponse;
      }
    }
    return out;
  } catch {
    return {};
  }
}

const UNREAD_KEY = "egant.unread";

function loadUnread(): Record<number, true> {
  try {
    const raw = localStorage.getItem(UNREAD_KEY);
    const ids: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(ids)) return {};
    const unread: Record<number, true> = {};
    for (const id of ids) if (typeof id === "number") unread[id] = true;
    return unread;
  } catch {
    return {};
  }
}

function saveUnread(unread: Record<number, true>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(Object.keys(unread).map(Number)));
  } catch {
    // keep the in-memory copy
  }
}

function saveDecisionResponses(responses: Record<string, DecisionResponse>): void {
  try {
    localStorage.setItem("egant.decisionResponses", JSON.stringify(responses));
  } catch {
    // Unavailable storage: the answer still reached the agent; only the
    // "already answered" replay across a reload is lost.
  }
}

const DECISIONS_IMPORTED_KEY = "egant.decisionResponsesImported";

/** Decision answers used to live only in this window's storage. Hands them
 * to the backend once, so a paired phone sees those prompts as answered too
 * rather than offering to send the agent a stale answer. Nothing is sent to
 * any agent. Retried next launch if it fails. */
async function importLegacyDecisions(responses: Record<string, DecisionResponse>): Promise<void> {
  if (loadString(DECISIONS_IMPORTED_KEY) === "1") return;
  const answers = Object.entries(responses).flatMap(([key, response]) => {
    const split = key.indexOf(":");
    const sessionId = Number(key.slice(0, split));
    const decisionId = key.slice(split + 1);
    return split > 0 && Number.isInteger(sessionId) && decisionId
      ? [{ sessionId, decisionId, response }]
      : [];
  });
  try {
    if (answers.length > 0) await api.importDecisionResponses(answers);
    saveString(DECISIONS_IMPORTED_KEY, "1");
  } catch (error) {
    log.warn("store", `decision answers not handed to the backend yet: ${String(error)}`);
  }
}

/** Model the next session for `agent` starts with: the composer's override,
 * else the per-agent default from Settings > Agents, else the CLI default. */
export function selectNextModel(
  composerModel: string,
  defaultModels: Record<string, string>,
  agent: string,
): string {
  const override = composerModel.trim();
  if (override) return override;
  return (defaultModels[agent] ?? "").trim();
}

/** Reasoning variant for `agent`: composer override, else per-agent default. */
export function selectNextVariant(
  composerVariant: string,
  defaultVariants: Record<string, string>,
  agent: string,
): string {
  const override = composerVariant.trim();
  if (override) return override;
  return (defaultVariants[agent] ?? "").trim();
}

/** Explicit context choice for `agent` (raw, e.g. "200K"): composer
 * override, else per-agent default, else `""` (model/CLI default). Parse
 * with `parseContext`; the model's own window is only a display fallback
 * and is never sent as an override. */
export function selectNextContext(
  composerContext: string,
  defaultContexts: Record<string, string>,
  agent: string,
): string {
  const override = composerContext.trim();
  if (override) return override;
  return (defaultContexts[agent] ?? "").trim();
}

export function starKey(agent: string, modelId: string): string {
  return `${agent}:${modelId}`;
}

/** Explicit context window in tokens for the next session, or `null` for
 * the model/CLI default. Only an explicit pick (composer or Settings)
 * travels to the backend — a model's own window is inherent. */
export function selectNextContextTokens(
  composerContext: string,
  defaultContexts: Record<string, string>,
  agent: string,
): number | null {
  const n = parseContext(selectNextContext(composerContext, defaultContexts, agent));
  return n > 0 ? n : null;
}

/** The launch screen owns the window until the first message lands: no
 * active session, an active transcript that is still empty, or "+" was just
 * clicked and hasn't been given a first message yet (`startingNewSession`) —
 * that last case overrides an already-active session so its picker stays
 * live instead of silently reusing the old session's agent/model. */
export function selectLaunching(
  snapshot: WindowState | null,
  transcripts: Record<number, TranscriptState>,
  startingNewSession: boolean,
): boolean {
  if (startingNewSession) return true;
  const activeId = snapshot?.activeSession;
  if (activeId == null) return true;
  // A CLI session's transcript is empty and always will be — its content is
  // a terminal, not a list of turns. Reading that emptiness as "hasn't
  // started yet" would bury the terminal under the launch composer forever.
  if (selectActiveSession(snapshot)?.kind === "cli") return false;
  const transcript = transcripts[activeId];
  return (
    transcript !== undefined &&
    transcript.entries.length === 0 &&
    !transcript.pending &&
    (transcript.pendingList ?? []).length === 0
  );
}

/** Whether the launch screen is what the user is looking at — `selectLaunching`
 * with the one exception App.tsx already makes: a file or diff open on the
 * stage takes it over, launch state or not.
 *
 * The workspace panel has nothing to show here (no conversation, no working
 * tree yet), so it is not offered on this screen and is hidden if it was open.
 * Its open/closed choice is left alone — it is derived away, not closed — so
 * the panel returns as it was the moment a conversation is back on the stage. */
export function selectOnLaunchScreen(
  s: Pick<EgantStore, "snapshot" | "transcripts" | "startingNewSession" | "stageTabs" | "stageTab">,
): boolean {
  if (!selectLaunching(s.snapshot, s.transcripts, s.startingNewSession)) return false;
  // The same key App.tsx files stage tabs under: `-1` before any conversation.
  const key = s.snapshot?.activeSession ?? -1;
  const showing = s.stageTab[key] ?? CHAT_TAB;
  return !(s.stageTabs[key] ?? []).some((tab) => tab.key === showing);
}

/** The session on the stage, if there is one. */
export function selectActiveSession(snapshot: WindowState | null): SessionInfo | null {
  if (!snapshot || snapshot.activeSession == null) return null;
  return snapshot.sessions.find((s) => s.id === snapshot.activeSession) ?? null;
}

/** Whether picking `agent` starts a chat session or opens its own CLI.
 *
 * Two different questions, deliberately resolved in one place: *can* egant
 * render this agent's turns (the catalog's `chatUi`, a fact about which
 * harnesses exist) and *does the user want it to* (`chatUiAgents`, a
 * preference that only applies to the agents where the first is true). An
 * agent egant has no harness for can only ever open its CLI, whatever the
 * preference record happens to hold for it. */
export function usesChatUi(
  catalog: AgentCatalogEntry[],
  chatUiAgents: Record<string, boolean>,
  agent: string,
): boolean {
  const entry = catalog.find((c) => c.id === agent);
  // Unknown to the catalog but known to the harness registry — the catalog
  // hasn't loaded yet, in practice. The three harnessed agents are the ones
  // this can be true of, so defaulting them to chat keeps the composer from
  // flickering into CLI mode on a cold start.
  const capable = entry ? entry.chatUi : HARNESSED.includes(agent);
  return capable && (chatUiAgents[agent] ?? true);
}

/** Agents egant ships a chat harness for. Mirrors the catalog's `chatUi`
 * column; only used before the catalog has crossed the IPC boundary. */
export const HARNESSED: readonly string[] = ["claude", "codex", "opencode"];

/** Where the workspace panel points: the active conversation's working
 * directory, else the selected project, else the first project open. The
 * panel is about the project in front of you, and those are the three
 * increasingly loose ways to name it. */
export function workspaceRoot(snapshot: WindowState | null): string {
  if (!snapshot) return "";
  const active = snapshot.sessions.find((session) => session.id === snapshot.activeSession);
  if (active?.cwd) return active.cwd;
  const project =
    snapshot.projects.find((candidate) => candidate.id === snapshot.activeProject) ??
    snapshot.projects[0];
  return project?.path ?? "";
}

/** The first shell is just "Terminal"; the rest are numbered. */
function terminalTitle(n: number): string {
  return n === 1 ? "Terminal" : `Terminal ${n}`;
}

/** Same numbering scheme as a terminal's, before a Browser tab has navigated
 * anywhere to be titled after. */
function browserTitle(n: number): string {
  return n === 1 ? "New Tab" : `New Tab ${n}`;
}

let panelTabSeq = 0;
/** Panel tab ids only have to be unique within this window's lifetime. */
function nextPanelTabId(): number {
  panelTabSeq += 1;
  return panelTabSeq;
}

export const useEgant = create<EgantStore>()((set, get) => {
  /** Patches one session row in the snapshot, if it is on screen. */
  function patchSession(id: number, patch: Partial<SessionInfo>): void {
    const snapshot = get().snapshot;
    if (!snapshot) return;
    set({
      snapshot: {
        ...snapshot,
        sessions: snapshot.sessions.map((session) =>
          session.id === id ? { ...session, ...patch } : session,
        ),
      },
    });
  }

  /** Carries the picker's "Bypass permissions" pick onto a session that just
   * started — the session itself always spawns in `auto` (the backend has no
   * concept of the picker's pending choice), so this is the one call that
   * actually applies it, right after creation and before the first turn goes
   * out. Best-effort: the session still starts either way, and its Mode menu
   * is still there to flip it from if this fails. */
  async function applyComposerBypass(id: number): Promise<void> {
    if (!get().composerBypass) return;
    try {
      const applied = await api.setPermissionMode(id, "bypassPermissions");
      patchSession(id, { permissionMode: applied });
    } catch (error) {
      log.error("store", `apply composer bypass to session ${id} failed: ${String(error)}`, error);
    }
  }

  /** Adds a tab to the stage (or focuses the one already there) and shows it.
   * A tab's identity is its key, so re-opening the same file or the same side
   * of the same diff never stacks duplicates. */
  function openStageTab(sessionId: number, tab: StageTab): void {
    const open = get().stageTabs[sessionId] ?? [];
    const stageTabs = open.some((existing) => existing.key === tab.key)
      ? get().stageTabs
      : { ...get().stageTabs, [sessionId]: [...open, tab] };
    set({ stageTabs, stageTab: { ...get().stageTab, [sessionId]: tab.key } });
  }

  /** Refetches the wallpaper image when the setting points somewhere new. */
  async function syncWallpaper(wallpaper: string | null): Promise<void> {
    if (!wallpaper) {
      if (get().wallpaperUrl) set({ wallpaperUrl: null });
      return;
    }
    try {
      const url = await api.wallpaperDataUrl();
      set({ wallpaperUrl: url });
    } catch (error) {
      log.warn("store", `wallpaper load failed: ${error instanceof Error ? error.message : String(error)}`);
      fail(set, error);
    }
  }

  /** Files can be opened from the panel before there is a conversation to
   * open them beside; those tabs wait under `-1`. The moment a conversation
   * becomes the active one, they belong to it — otherwise the tab the user
   * just opened would vanish the instant they sent their first message. */
  function adoptOrphanFileTabs(activeSession: number | null): void {
    if (activeSession == null || activeSession < 0) return;
    const { stageTabs, stageTab } = get();
    const orphans = stageTabs[-1] ?? [];
    if (orphans.length === 0) return;

    const existing = stageTabs[activeSession] ?? [];
    const taken = new Set(existing.map((tab) => tab.key));
    const merged = [...existing, ...orphans.filter((tab) => !taken.has(tab.key))];

    const { [-1]: _dropped, ...rest } = stageTabs;
    const { [-1]: orphanShowing, ...restShowing } = stageTab;
    set({
      stageTabs: { ...rest, [activeSession]: merged },
      stageTab: {
        ...restShowing,
        // Keep looking at whatever was on screen, now under the conversation
        // that has taken it over.
        [activeSession]: orphanShowing ?? stageTab[activeSession] ?? CHAT_TAB,
      },
    });
  }

  function applySnapshot(snapshot: WindowState): void {
    const prev = get().snapshot;
    set({ snapshot });
    adoptOrphanFileTabs(snapshot.activeSession);
    // Drop transcripts for sessions that no longer exist.
    const alive = new Set(snapshot.sessions.map((s) => s.id));
    const transcripts = get().transcripts;
    if (Object.keys(transcripts).some((id) => !alive.has(Number(id)))) {
      const next: Record<number, TranscriptState> = {};
      for (const [id, transcript] of Object.entries(transcripts)) {
        if (alive.has(Number(id))) next[Number(id)] = transcript;
      }
      set({ transcripts: next });
    }
    if (snapshot.activeSession != null) void get().ensureTranscript(snapshot.activeSession);
    // On screen is read — however it got there (a click, ⌘↑/↓, search, a
    // new session) — and a session that no longer exists has nothing unread.
    const unread = get().unread;
    const stale = Object.keys(unread)
      .map(Number)
      .filter((id) => id === snapshot.activeSession || !alive.has(id));
    if (stale.length > 0) {
      const next = { ...unread };
      for (const id of stale) delete next[id];
      set({ unread: next });
      saveUnread(next);
    }
    // "All projects" stays as it is; an explicit project filter follows a
    // folder that was just added, so the first send lands in a list that shows
    // it instead of a filter that hides the new session.
    const filtered = get().sidebarProject;
    if (filtered != null) {
      if (prev && snapshot.activeProject != null) {
        const known = new Set(prev.projects.map((p) => p.id));
        if (!known.has(snapshot.activeProject)) get().setSidebarProject(snapshot.activeProject);
      } else if (!prev) {
        // First look at the window: a filter saved last run that disagrees
        // with the conversation the backend reopened gives way to it, so the
        // open conversation is in the list.
        const open = snapshot.sessions.find((s) => s.id === snapshot.activeSession);
        if (open && open.projectId !== filtered) get().setSidebarProject(open.projectId);
      }
    }
    if (prev?.settings.wallpaper !== snapshot.settings.wallpaper) {
      void syncWallpaper(snapshot.settings.wallpaper);
    }
  }

  /** Carries a worktree's new name onto every session running in it, and onto
   * a new conversation about to join it — the sidebar groups by path, and
   * labels the group from whichever session it meets first. */
  function onWorktreeRenamed({ path, branch, name, previousBranch }: WorktreeRenamedPayload): void {
    log.info("store", `worktree ${previousBranch} renamed to ${branch}`);
    const rename = (worktree: WorktreeInfo): WorktreeInfo =>
      worktree.path === path ? { ...worktree, branch, name } : worktree;
    const { snapshot, startingNewSessionWorktree } = get();
    if (snapshot) {
      set({
        snapshot: {
          ...snapshot,
          sessions: snapshot.sessions.map((session) =>
            session.worktree?.path === path
              ? {
                  ...session,
                  worktree: rename(session.worktree),
                  branch: session.branch === previousBranch ? branch : session.branch,
                }
              : session,
          ),
        },
      });
    }
    if (startingNewSessionWorktree) {
      set({ startingNewSessionWorktree: rename(startingNewSessionWorktree) });
    }
  }

  /** Adopts a transcript snapshot, and the decision answers the backend keeps
   * with it — which may have been given on a paired phone. */
  function adoptTranscript(id: number, dto: TranscriptDto): void {
    set({
      transcripts: { ...get().transcripts, [id]: fromDto(dto) },
      queues: { ...get().queues, [id]: dto.queued ?? [] },
    });
    const answered = Object.entries(dto.decisionResponses ?? {}).filter(
      ([decisionId]) => !get().decisionResponses[`${id}:${decisionId}`],
    );
    if (answered.length > 0) {
      const decisionResponses = { ...get().decisionResponses };
      for (const [decisionId, response] of answered) {
        decisionResponses[`${id}:${decisionId}`] = response;
      }
      set({ decisionResponses });
      saveDecisionResponses(decisionResponses);
    }
  }

  /** A change made somewhere other than this window — a paired phone sent a
   * message, answered a permission, picked a decision — mirrored in from the
   * numbered stream every client follows (`session-sync`). This window's own
   * changes come back on it too and are skipped: they were applied the moment
   * they were made. */
  function onSessionSync(envelope: SyncEnvelope): void {
    if (envelope.origin === "desktop" || envelope.sessionId == null) return;
    const id = envelope.sessionId;
    const prev = get().transcripts[id];
    switch (envelope.type) {
      case "user_message":
        log.info("session-sync", `session ${id}: a message sent from another device`);
        if (prev) {
          set({ transcripts: { ...get().transcripts, [id]: pushUser(prev, envelope.payload.text) } });
        }
        patchSession(id, { busy: true, state: "running" });
        break;
      case "permissions": {
        const { state, pending } = envelope.payload;
        log.info("session-sync", `session ${id}: permissions answered on another device`);
        if (prev) {
          const next: TranscriptState = {
            ...prev,
            state,
            pending: pending[0] ?? null,
            pendingList: pending,
            turnStartedAt: state === "idle" ? null : (prev.turnStartedAt ?? Date.now()),
          };
          set({ transcripts: { ...get().transcripts, [id]: next } });
        }
        patchSession(id, {
          busy: state !== "idle",
          state,
          pendingCount: pending.length,
        });
        break;
      }
      case "decision": {
        const key = `${id}:${envelope.payload.decisionId}`;
        if (get().decisionResponses[key]) break;
        const decisionResponses = { ...get().decisionResponses, [key]: envelope.payload.response };
        set({ decisionResponses });
        saveDecisionResponses(decisionResponses);
        break;
      }
      case "interrupted":
        // Stopped from the phone: the turn end it causes is no news here.
        if ((prev?.state ?? "idle") !== "idle") noteInterrupt(id);
        break;
      case "transcript_reset":
        if (prev) {
          void api
            .getTranscript(id)
            .then((dto) => adoptTranscript(id, dto))
            .catch((error: unknown) => fail(set, error));
        }
        break;
      case "session":
        // Rows the agent changes already reach this window through
        // `session-event`; a phone's changes (its first message naming the
        // session, say) arrive only here.
        if (envelope.origin != null) void get().refresh();
        break;
      case "session_removed":
        void get().refresh();
        break;
      case "harness":
        // Never mirrored to the window: it has `session-event`.
        break;
    }
  }

  function onSessionEvent({ sessionId, event }: SessionEventPayload): void {
    // Lifecycle at info, everything per-token stays at debug (or off): deltas
    // fire per token and would flood the console mid-reply.
    switch (event.type) {
      case "turn_ended":
        if (event.is_error) log.error("session-event", `session ${sessionId} turn failed: ${event.result ?? "unknown error"}`);
        else log.info("session-event", `session ${sessionId} turn ended`);
        break;
      case "exited":
        log.info("session-event", `session ${sessionId} exited`);
        break;
      case "error":
        log.error("session-event", `session ${sessionId} error: ${event.message}`);
        break;
      case "permission_request":
        log.info("session-event", `session ${sessionId} permission: ${event.tool_name}`);
        break;
      case "tool_use":
        log.info("session-event", `session ${sessionId} tool: ${event.name}`);
        break;
      case "ready":
        log.info("session-event", `session ${sessionId} ready model=${event.model ?? "-"}`);
        break;
      case "assistant_message":
        log.debug("session-event", `session ${sessionId} message (${event.text.length} chars)`);
        break;
      default:
        log.debug("session-event", `session ${sessionId} ${event.type}`);
        break;
    }
    const prev = get().transcripts[sessionId] ?? emptyTranscript();
    const next = applyEvent(prev, event);
    set({ transcripts: { ...get().transcripts, [sessionId]: next } });
    // The sound and banner for a run that finished, stalled or failed. Reads
    // the transcript either side of the event, so it sees what the fold made
    // of it (a turn that ended on a question, say).
    notifySession(
      sessionId,
      event,
      prev,
      next,
      get().snapshot?.sessions.find((s) => s.id === sessionId)?.title ?? "",
    );
    // The session rows derive their live Badges from the same fold.
    const patch: Partial<SessionInfo> = {
      busy: next.state !== "idle",
      state: next.state,
      pendingCount: (next.pendingList ?? []).length,
      model: next.model,
      totalCostUsd: next.totalCostUsd,
    };
    // News for a conversation that isn't on screen: it finished, stalled on
    // the user, or died. The open one is read by definition.
    const news =
      event.type === "turn_ended" || event.type === "permission_request" || event.type === "exited";
    if (news && sessionId !== get().snapshot?.activeSession && !get().unread[sessionId]) {
      const unread = { ...get().unread, [sessionId]: true as const };
      set({ unread });
      saveUnread(unread);
    }
    if (event.type === "exited") patch.ended = true;
    // The agent's own word on its mode — after an approved plan, or Claude
    // entering plan mode by itself — so the chip never names a stale one.
    if (event.type === "mode_changed") patch.permissionMode = event.mode;
    patchSession(sessionId, patch);
    // The agent has just stopped editing: whatever the Changes tab is showing
    // is now out of date. Cheaper and steadier than watching the filesystem,
    // and it lands exactly when the user looks back at the panel.
    if (event.type === "turn_ended") {
      get().refreshChanges();
      // Only a Claude turn moves Claude's own usage windows.
      const session = get().snapshot?.sessions.find((s) => s.id === sessionId);
      if (session?.agent === "claude") void get().fetchClaudeUsage();
    }
  }

  return {
    snapshot: null,
    transcripts: {},
    wallpaperUrl: null,
    filter: "",
    filterOpen: false,
    searchOpen: false,
    sidebarOrganize: (() => {
      const saved = loadString("egant.sidebarOrganize") as SidebarOrganize | null;
      return saved && SIDEBAR_ORGANIZE.includes(saved) ? saved : "byDevice";
    })(),
    setSidebarOrganize: (sidebarOrganize) => {
      set({ sidebarOrganize });
      saveString("egant.sidebarOrganize", sidebarOrganize);
    },
    sidebarProject: (() => {
      const raw = loadString("egant.sidebarProject");
      const id = raw == null ? NaN : Number(raw);
      return Number.isInteger(id) ? id : null;
    })(),
    setSidebarProject: (sidebarProject) => {
      set({ sidebarProject });
      saveString("egant.sidebarProject", sidebarProject == null ? null : String(sidebarProject));
    },
    sidebarSort: (loadString("egant.sidebarSort") as SidebarSort | null) ?? "created",
    setSidebarSort: (sidebarSort) => {
      set({ sidebarSort });
      saveString("egant.sidebarSort", sidebarSort);
    },
    sidebarShowBranch: loadBool("egant.sidebarShowBranch", true),
    setSidebarShowBranch: (sidebarShowBranch) => {
      set({ sidebarShowBranch });
      saveString("egant.sidebarShowBranch", String(sidebarShowBranch));
    },
    sidebarShowHarness: loadBool("egant.sidebarShowHarness", true),
    setSidebarShowHarness: (sidebarShowHarness) => {
      set({ sidebarShowHarness });
      saveString("egant.sidebarShowHarness", String(sidebarShowHarness));
    },
    sidebarShowLocation: loadBool("egant.sidebarShowLocation", true),
    setSidebarShowLocation: (sidebarShowLocation) => {
      set({ sidebarShowLocation });
      saveString("egant.sidebarShowLocation", String(sidebarShowLocation));
    },
    sidebarWorktreesOnly: loadBool("egant.sidebarWorktreesOnly", false),
    setSidebarWorktreesOnly: (sidebarWorktreesOnly) => {
      set({ sidebarWorktreesOnly });
      saveString("egant.sidebarWorktreesOnly", String(sidebarWorktreesOnly));
    },
    sidebarWidth: loadNumber("egant.sidebarWidth", 250),
    setSidebarWidth: (width) => {
      const sidebarWidth = Math.round(Math.min(480, Math.max(200, width)));
      set({ sidebarWidth });
      saveString("egant.sidebarWidth", String(sidebarWidth));
    },
    collapsedGroups: loadBoolRecord("egant.collapsedGroups", {}),
    toggleGroupCollapsed: (key) => {
      const collapsedGroups = { ...get().collapsedGroups, [key]: !get().collapsedGroups[key] };
      set({ collapsedGroups });
      saveString("egant.collapsedGroups", JSON.stringify(collapsedGroups));
    },
    panelOpen: loadBool("egant.panelOpen", false),
    panelWidth: loadNumber("egant.panelWidth", 320),
    panelMaximized: loadBool("egant.panelMaximized", false),
    setPanelWidth: (width) => {
      // A flat cap, not one computed off the window or the sidebar: the panel
      // simply can't be dragged past this position, so it never has to fight
      // the chat stage for room — the stage just flexes into whatever's left
      // (see `min-w-0` on the stage in App.tsx).
      const panelWidth = Math.round(Math.min(PANEL_MAX_WIDTH, Math.max(240, width)));
      set({ panelWidth });
      saveString("egant.panelWidth", String(panelWidth));
    },
    panelTabs: [],
    panelTab: null,
    setPanelTab: (panelTab) => set({ panelTab }),
    togglePanel: () => {
      // No panel on the launch screen, so ⌘J has nothing to toggle there.
      // Flipping the saved flag anyway would change what the *next*
      // conversation opens with, with nothing on screen to explain it.
      if (selectOnLaunchScreen(get())) return;
      const panelOpen = !get().panelOpen;
      // With no tabs the panel shows its two buttons — Files or Terminal — so
      // opening it never has to guess which one was meant.
      set({ panelOpen });
      saveString("egant.panelOpen", String(panelOpen));
    },
    openFilesTab: () => {
      const { panelTabs } = get();
      const existing = panelTabs.find((tab) => tab.kind === "files");
      if (existing) {
        set({ panelOpen: true, panelTab: existing.id });
      } else {
        const tab: PanelTab = {
          id: `files-${nextPanelTabId()}`,
          kind: "files",
          title: "Files",
          cwd: workspaceRoot(get().snapshot),
        };
        // The tree belongs at the front: terminals come and go beside it.
        set({ panelOpen: true, panelTabs: [tab, ...panelTabs], panelTab: tab.id });
      }
      saveString("egant.panelOpen", "true");
    },
    openDiffsTab: () => {
      const { panelTabs } = get();
      const existing = panelTabs.find((tab) => tab.kind === "diffs");
      if (existing) {
        set({ panelOpen: true, panelTab: existing.id });
      } else {
        const tab: PanelTab = {
          id: `diffs-${nextPanelTabId()}`,
          kind: "diffs",
          // The tab is named after what it is showing, so two of them on
          // different scopes are told apart on the strip itself.
          title: diffScopeLabel("workingTree"),
          scope: "workingTree",
          cwd: workspaceRoot(get().snapshot),
        };
        set({ panelOpen: true, panelTabs: [...panelTabs, tab], panelTab: tab.id });
      }
      saveString("egant.panelOpen", "true");
      // Opening it is a good moment to be sure it is current.
      get().refreshChanges();
    },
    openHistoryTab: () => {
      const { panelTabs } = get();
      const existing = panelTabs.find((tab) => tab.kind === "history");
      if (existing) {
        set({ panelOpen: true, panelTab: existing.id });
      } else {
        const tab: PanelTab = {
          id: `history-${nextPanelTabId()}`,
          kind: "history",
          title: "History",
          cwd: workspaceRoot(get().snapshot),
        };
        set({ panelOpen: true, panelTabs: [...panelTabs, tab], panelTab: tab.id });
      }
      saveString("egant.panelOpen", "true");
    },
    togglePanelMaximized: () => {
      if (selectOnLaunchScreen(get())) return;
      const panelMaximized = !get().panelMaximized;
      // Maximizing is also a way of opening it: the button is on the panel's
      // own header, but a keyboard path to it should not leave the window
      // showing a panel that isn't there.
      set({ panelMaximized, panelOpen: panelMaximized ? true : get().panelOpen });
      saveString("egant.panelMaximized", String(panelMaximized));
      if (panelMaximized) saveString("egant.panelOpen", "true");
    },
    setPanelBase: (tabId, base) => {
      set({
        panelTabs: get().panelTabs.map((tab) => (tab.id === tabId ? { ...tab, base } : tab)),
      });
      get().refreshChanges();
    },
    setPanelScope: (tabId, scope) => {
      set({
        panelTabs: get().panelTabs.map((tab) =>
          tab.id === tabId ? { ...tab, scope, title: diffScopeLabel(scope) } : tab,
        ),
      });
      get().refreshChanges();
    },
    openTerminalTab: (cwd) => {
      const { panelTabs } = get();
      // The lowest number not already on the strip, so closing "Terminal" and
      // opening another doesn't produce a second "Terminal 2".
      const taken = new Set(panelTabs.map((tab) => tab.title));
      let n = 1;
      while (taken.has(terminalTitle(n))) n += 1;
      const tab: PanelTab = {
        id: `term-${nextPanelTabId()}`,
        kind: "terminal",
        title: terminalTitle(n),
        cwd: cwd || workspaceRoot(get().snapshot),
      };
      set({ panelOpen: true, panelTabs: [...panelTabs, tab], panelTab: tab.id });
      saveString("egant.panelOpen", "true");
      return tab.id;
    },
    openBrowserTab: () => {
      const { panelTabs } = get();
      const taken = new Set(panelTabs.map((tab) => tab.title));
      let n = 1;
      while (taken.has(browserTitle(n))) n += 1;
      const tab: PanelTab = {
        id: `browser-${nextPanelTabId()}`,
        kind: "browser",
        title: browserTitle(n),
        cwd: workspaceRoot(get().snapshot),
      };
      set({ panelOpen: true, panelTabs: [...panelTabs, tab], panelTab: tab.id });
      saveString("egant.panelOpen", "true");
      return tab.id;
    },
    updateBrowserTab: (id, patch) => {
      set({
        panelTabs: get().panelTabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
      });
    },
    closePanelTab: (id) => {
      const { panelTabs, panelTab } = get();
      const index = panelTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      // Closing a terminal tab ends its shell — the tab was the only thing
      // holding it open. A browser tab's webview is the same idea: the tab
      // id doubles as its label, and this is the only thing that tears it
      // down rather than just hiding it.
      const closing = panelTabs[index];
      if (closing.ptyId != null) void api.ptyKill(closing.ptyId).catch(() => {});
      if (closing.kind === "browser") void api.browserClose(closing.id).catch(() => {});
      const rest = panelTabs.filter((tab) => tab.id !== id);
      // Land on the neighbour rather than jumping to the end of the strip.
      const neighbour = rest[index] ?? rest[index - 1] ?? null;
      set({
        panelTabs: rest,
        panelTab: panelTab === id ? neighbour?.id ?? null : panelTab,
      });
    },
    // Both of these are also called by a CLI session's terminal, which has no
    // panel tab behind it — the early return keeps that from replacing the
    // tab list with an identical copy on every spawn, which the panel would
    // then re-run its whole tab-teardown effect over.
    attachPty: (id, ptyId) => {
      const panelTabs = get().panelTabs;
      if (!panelTabs.some((tab) => tab.id === id)) return;
      set({
        panelTabs: panelTabs.map((tab) =>
          tab.id === id ? { ...tab, ptyId, exited: false } : tab,
        ),
      });
    },
    markPtyExited: (ptyId) => {
      const panelTabs = get().panelTabs;
      if (!panelTabs.some((tab) => tab.ptyId === ptyId)) return;
      set({
        panelTabs: panelTabs.map((tab) =>
          tab.ptyId === ptyId ? { ...tab, exited: true } : tab,
        ),
      });
    },

    stageTabs: {},
    stageTab: {},
    openFile: (sessionId, path, name) => {
      openStageTab(sessionId, { key: path, kind: "file", path, name });
    },
    openDiff: (sessionId, root, change, group, scope) => {
      const name = change.path.split("/").pop() ?? change.path;
      openStageTab(sessionId, {
        key: diffTabKey(group, change.path),
        kind: "diff",
        path: change.path,
        name,
        group,
        scope,
        status: change.status,
        root,
      });
    },
    openCommitDiff: (sessionId, root, sha, change) => {
      const name = change.path.split("/").pop() ?? change.path;
      openStageTab(sessionId, {
        key: diffTabKey("commit", change.path, sha),
        kind: "diff",
        path: change.path,
        name,
        group: "commit",
        scope: { kind: "commit", sha },
        status: change.status,
        root,
      });
    },
    closeStageTab: (sessionId, key) => {
      const open = get().stageTabs[sessionId] ?? [];
      const index = open.findIndex((tab) => tab.key === key);
      if (index < 0) return;
      const rest = open.filter((tab) => tab.key !== key);
      const showing = get().stageTab[sessionId];
      // Closing the tab you are looking at falls to its neighbour, and back to
      // the conversation once the last one is gone.
      const next =
        showing === key ? (rest[index]?.key ?? rest[index - 1]?.key ?? CHAT_TAB) : showing;
      set({
        stageTabs: { ...get().stageTabs, [sessionId]: rest },
        stageTab: { ...get().stageTab, [sessionId]: next ?? CHAT_TAB },
      });
    },
    setStageTab: (sessionId, key) =>
      set({ stageTab: { ...get().stageTab, [sessionId]: key } }),
    changesToken: 0,
    refreshChanges: () => set({ changesToken: get().changesToken + 1 }),

    pickerRequest: null,
    focusComposerToken: 0,
    focusFilterToken: 0,
    error: null,
    notice: null,
    composerCheckout: null,
    composerRef: null,
    refs: [],
    refsLoading: false,
    startingNewSession: false,
    startingNewSessionWorktree: null,

    agents: [],
    composerAgent: loadString("egant.composerAgent"),
    composerModel: loadString("egant.composerModel") ?? "",
    composerVariant: loadString("egant.composerVariant") ?? "",
    composerContext: loadString("egant.composerContext") ?? "",
    setComposerAgent: (composerAgent) => {
      set({ composerAgent });
      saveString("egant.composerAgent", composerAgent);
    },
    setComposerModel: (composerModel) => {
      set({ composerModel });
      saveString("egant.composerModel", composerModel || null);
    },
    setComposerVariant: (composerVariant) => {
      set({ composerVariant });
      saveString("egant.composerVariant", composerVariant || null);
    },
    setComposerContext: (composerContext) => {
      set({ composerContext });
      saveString("egant.composerContext", composerContext || null);
    },
    composerBypass: loadBool("egant.composerBypass", false),
    setComposerBypass: (composerBypass) => {
      set({ composerBypass });
      saveString("egant.composerBypass", String(composerBypass));
    },
    catalog: [],
    fetchCatalog: async () => {
      try {
        const catalog = await api.listAgentCatalog();
        log.debug("store", `catalog loaded (${catalog.length} entries)`);
        set({ catalog });
      } catch {
        // The picker falls back to the drivable registry; no toast for a
        // list that only adds rows.
        log.warn("store", "catalog load failed; picker falls back to registry");
      }
    },
    fetchAgents: async () => {
      try {
        const agents = await api.listAgents();
        log.debug("store", `agents loaded (${agents.length} known)`);
        set({ agents });
      } catch (error) {
        fail(set, error);
      }
    },
    verifyAgents: async () => {
      log.debug("store", "verifying agent logins");
      try {
        set({ agents: await api.listAgents() });
      } catch (error) {
        fail(set, error);
        return;
      }
      const live = await Promise.all(
        ["claude", "codex"].map((id) => api.checkAgentLogin(id).catch(() => null)),
      );
      const agents = get().agents.map((agent) => {
        const fresh = live.find((status) => status?.id === agent.id);
        return fresh ?? agent;
      });
      log.debug("store", "agent login recheck done");
      set({ agents });
    },
    models: [],
    modelsAgent: null,
    modelsLoading: false,
    modelCache: loadModelCache(),
    fetchModels: async (agent) => {
      const cached = get().modelCache[agent];
      log.debug("store", `models for ${agent}${cached ? " (cached, refreshing)" : ""}`);
      // A cached catalog shows immediately and refreshes underneath; only an
      // agent never fetched this run gets the loading state.
      set({ models: cached ?? [], modelsAgent: agent, modelsLoading: cached == null });
      try {
        const fresh = await api.listModels(agent);
        log.debug("store", `models for ${agent} refreshed (${fresh.length})`);
        const modelCache = { ...get().modelCache, [agent]: fresh };
        set({ modelCache });
        saveModelCache(modelCache);
        if (get().modelsAgent === agent) set({ models: fresh });
      } catch (error) {
        // A failed refresh is no reason to empty a list that worked a moment
        // ago — only a first, cache-less fetch reports and clears.
        if (cached == null) {
          fail(set, error);
          if (get().modelsAgent === agent) set({ models: [] });
        }
      } finally {
        if (get().modelsAgent === agent) set({ modelsLoading: false });
      }
    },
    warmModels: async (agent) => {
      try {
        const fresh = await api.listModels(agent);
        const modelCache = { ...get().modelCache, [agent]: fresh };
        set({ modelCache });
        saveModelCache(modelCache);
        if (get().modelsAgent === agent) set({ models: fresh, modelsLoading: false });
      } catch {
        // Best-effort: the tab's own fetch reports it if it's ever opened.
      }
    },

    claudeUsage: null,
    // Silent on failure: an expired token or a network blip shouldn't pop
    // the same error toast a failed send would. The pill just stays hidden.
    fetchClaudeUsage: async () => {
      try {
        const usage = await api.claudeUsageLimits();
        log.debug("store", usage ? "claude usage refreshed" : "claude usage unavailable");
        set({ claudeUsage: usage });
      } catch {
        set({ claudeUsage: null });
      }
    },

    enabledAgents: loadBoolRecord("egant.agents", {
      claude: true,
      codex: true,
      opencode: true,
    }),
    setAgentEnabled: (id, on) => {
      const enabledAgents = { ...get().enabledAgents, [id]: on };
      set({ enabledAgents });
      try {
        localStorage.setItem("egant.agents", JSON.stringify(enabledAgents));
      } catch {
        // keep in-memory choice
      }
    },

    chatUiAgents: loadBoolRecord("egant.chatUi", {}),
    setChatUi: (id, on) => {
      const chatUiAgents = { ...get().chatUiAgents, [id]: on };
      set({ chatUiAgents });
      try {
        localStorage.setItem("egant.chatUi", JSON.stringify(chatUiAgents));
      } catch {
        // keep in-memory choice
      }
    },

    cliLaunch: null,
    askCliLaunch: (agent) => set({ cliLaunch: agent }),
    cancelCliLaunch: () => set({ cliLaunch: null }),

    startCliSession: async (agent) => {
      log.info("store", `starting CLI session for ${agent}`);
      // Same rule as a chat session: there is nothing to run a CLI *in*
      // until a folder is open, so ask for one first rather than failing.
      if (get().snapshot?.activeProject == null) {
        const path = await pickProjectFolder().catch((error: unknown) => {
          fail(set, error);
          return null;
        });
        if (!path) return false;
        try {
          // The project has to exist before the CLI session can name it, and
          // `addProject` starts a chat session of its own on the way in —
          // that one is left as the launch screen's empty session, exactly as
          // it would be if the folder had been opened from the sidebar.
          applySnapshot(await api.addProject(path));
        } catch (error) {
          fail(set, error);
          return false;
        }
      }
      try {
        // A CLI session is a terminal in a directory, so the chips mean the
        // same thing here as they do for a chat: the shell opens in whatever
        // checkout the user picked.
        const checkout = checkoutPlan(
          checkoutKind(get().composerCheckout, get().snapshot),
          get().composerRef,
          get().refs,
        );
        applySnapshot(await api.createCliSession(agent, checkout));
        set({ cliLaunch: null, startingNewSession: false, startingNewSessionWorktree: null });
        return true;
      } catch (error) {
        fail(set, error);
        return false;
      }
    },
    defaultModels: loadRecord("egant.defaultModels"),
    setDefaultModel: (agent, model) => {
      const defaultModels = { ...get().defaultModels };
      if (!model) delete defaultModels[agent];
      else defaultModels[agent] = model;
      set({ defaultModels });
      try {
        localStorage.setItem("egant.defaultModels", JSON.stringify(defaultModels));
      } catch {
        // keep in-memory choice
      }
    },
    defaultVariants: loadRecord("egant.defaultVariants"),
    setDefaultVariant: (agent, variant) => {
      const defaultVariants = { ...get().defaultVariants };
      if (!variant) delete defaultVariants[agent];
      else defaultVariants[agent] = variant;
      set({ defaultVariants });
      try {
        localStorage.setItem("egant.defaultVariants", JSON.stringify(defaultVariants));
      } catch {
        // keep in-memory choice
      }
    },
    defaultContexts: loadRecord("egant.defaultContexts"),
    setDefaultContext: (agent, context) => {
      const defaultContexts = { ...get().defaultContexts };
      if (!context.trim()) delete defaultContexts[agent];
      else defaultContexts[agent] = context.trim();
      set({ defaultContexts });
      try {
        localStorage.setItem("egant.defaultContexts", JSON.stringify(defaultContexts));
      } catch {
        // keep in-memory choice
      }
    },
    decisionResponses: loadDecisionResponses(),
    unread: loadUnread(),
    starredModels: loadStarred(),
    toggleStarred: (agent, modelId) => {
      const key = starKey(agent, modelId);
      const starredModels = { ...get().starredModels };
      if (starredModels[key]) delete starredModels[key];
      else starredModels[key] = true;
      set({ starredModels });
      try {
        localStorage.setItem("egant.starredModels", JSON.stringify(starredModels));
      } catch {
        // keep in-memory choice
      }
    },

    settingsOpen: false,
    settingsSection: "devices",
    agentSheetId: null,
    setAgentSheetId: (agentSheetId) => set({ agentSheetId }),
    openSettings: (section, agentId) =>
      set((s) => ({
        settingsOpen: true,
        settingsSection: section ?? s.settingsSection,
        agentSheetId: agentId ?? null,
      })),
    closeSettings: () => set({ settingsOpen: false }),
    setSettingsSection: (settingsSection) => set({ settingsSection }),

    appearance: loadAppearance(),
    setAppearance: (patch) => {
      const appearance = { ...get().appearance, ...patch };
      set({ appearance });
      try {
        localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
      } catch {
        // Private browsing or a full disk: the window keeps the in-memory
        // choice and tries again on the next change.
      }
      applyAppearance(appearance);
    },

    setFilter: (filter) => set({ filter }),
    openFilter: () =>
      set((s) => ({ filterOpen: true, focusFilterToken: s.focusFilterToken + 1 })),
    // Closing clears the needle too: a hidden filter that still narrows the
    // list would be a list with rows missing for no visible reason.
    closeFilter: () => set({ filterOpen: false, filter: "" }),
    openSearch: () => set({ searchOpen: true }),
    closeSearch: () => set({ searchOpen: false }),
    requestFocusComposer: () => set((s) => ({ focusComposerToken: s.focusComposerToken + 1 })),
    requestPicker: (sessionId, kind) =>
      set((s) => ({ pickerRequest: { sessionId, kind, token: (s.pickerRequest?.token ?? 0) + 1 } })),
    dismissError: () => set({ error: null }),
    dismissNotice: () => set({ notice: null }),

    discardKeptWorktree: async (worktree) => {
      try {
        await api.discardWorktree(worktree);
        log.info("store", `discarded worktree ${worktree.branch}`);
        set({ notice: null });
      } catch (error) {
        fail(set, error);
      }
    },

    setComposerCheckout: async (kind) => {
      // Coming back to the project folder with a ref picked that only a
      // worktree could have reached: drop the pick, or the chip would name a
      // branch the session is not going to be on. The folder's own branch
      // takes over, which is what "Current checkout" means.
      const picked = get().composerRef;
      const row = get().refs.find((candidate) => candidate.name === picked);
      const stranded = kind === "current" && row != null && !row.current && row.worktreePath == null;
      set({ composerCheckout: kind, ...(stranded ? { composerRef: null } : {}) });
      await get().setWorktreeDefault(kind === "worktree");
    },

    setComposerRef: (name) => {
      const row = get().refs.find((candidate) => candidate.name === name);
      // A ref that is neither what the project folder is on nor already
      // checked out somewhere can only be acted on by cutting a worktree off
      // it: egant never moves the branch of the folder you opened. Rather than
      // leave the chips in a state that means nothing, the pick carries the
      // checkout chip with it — visibly, so the consequence is on screen.
      const strandedRef = row != null && !row.current && row.worktreePath == null;
      const kind = checkoutKind(get().composerCheckout, get().snapshot);
      set({
        composerRef: name,
        composerCheckout: strandedRef && kind === "current" ? "worktree" : get().composerCheckout,
      });
    },

    fetchRefs: async (root) => {
      if (!root) {
        set({ refs: [], refsLoading: false });
        return;
      }
      set({ refsLoading: true });
      try {
        const refs = await api.repoRefs(root);
        // A ref picked in another project (or a branch deleted since) names
        // nothing here — drop it rather than send it to the backend.
        const picked = get().composerRef;
        const stale = picked != null && !refs.some((row) => row.name === picked);
        set({ refs, refsLoading: false, ...(stale ? { composerRef: null } : {}) });
      } catch (error) {
        // A folder that isn't a repository is the ordinary case, not a
        // failure: the chips hide themselves and the session runs where it
        // always did.
        log.info("store", `no refs for ${root}: ${String(error)}`);
        set({ refs: [], refsLoading: false, composerRef: null });
      }
    },

    setWorktreeDefault: async (on) => {
      try {
        const settings = await api.setWorktreeDefault(on);
        const snapshot = get().snapshot;
        if (snapshot) set({ snapshot: { ...snapshot, settings } });
      } catch (error) {
        fail(set, error);
      }
    },

    init: async () => {
      log.info("store", "initialising egant");
      const snapshot = await api.getState();
      log.info(
        "store",
        `initialised (${snapshot.projects.length} projects, ${snapshot.sessions.length} sessions)`,
      );
      applySnapshot(snapshot);
      void get().verifyAgents();
      // A filesystem probe, no spawns — and it is what names the agents the
      // harness registry has never heard of. Without it a restored Goose CLI
      // session sits in the sidebar labelled `goose` until something else
      // happens to open the agent picker.
      void get().fetchCatalog();
      const unlistenEvents = await listen<SessionEventPayload>("session-event", (e) =>
        onSessionEvent(e.payload),
      );
      const unlistenRenames = await listen<WorktreeRenamedPayload>("worktree-renamed", (e) =>
        onWorktreeRenamed(e.payload),
      );
      // A title a small model wrote after a session's first turn.
      const unlistenTitles = await listen<SessionTitledPayload>("session-titled", (e) =>
        patchSession(e.payload.sessionId, { title: e.payload.title }),
      );
      // The app sent the next queued message; what is left waiting.
      const unlistenQueues = await listen<SessionQueuePayload>("session-queue", (e) =>
        set({ queues: { ...get().queues, [e.payload.sessionId]: e.payload.queued } }),
      );
      // What a paired phone does to a session: its messages, its answers.
      const unlistenSync = await listen<SyncEnvelope>("session-sync", (e) =>
        onSessionSync(e.payload),
      );
      void importLegacyDecisions(get().decisionResponses);
      return () => {
        unlistenEvents();
        unlistenRenames();
        unlistenTitles();
        unlistenQueues();
        unlistenSync();
      };
    },

    refresh: async () => {
      try {
        applySnapshot(await api.getState());
      } catch (error) {
        fail(set, error);
      }
    },

    ensureTranscript: async (id) => {
      if (get().transcripts[id]) return;
      log.debug("store", `fetching transcript for session ${id}`);
      try {
        adoptTranscript(id, await api.getTranscript(id));
      } catch (error) {
        fail(set, error);
      }
    },

    openFolderDialog: async () => {
      const path = await pickProjectFolder().catch((error: unknown) => {
        fail(set, error);
        return null;
      });
      if (!path) return;
      try {
        const agent = selectNextAgent(get().snapshot, get().composerAgent);
        const model =
          selectNextModel(get().composerModel, get().defaultModels, agent) || null;
        const variant =
          selectNextVariant(get().composerVariant, get().defaultVariants, agent) || null;
        const context = selectNextContextTokens(
          get().composerContext,
          get().defaultContexts,
          agent,
        );
        applySnapshot(await api.addProject(path, agent, model, variant, context));
        const id = get().snapshot?.activeSession;
        if (id != null) await applyComposerBypass(id);
      } catch (error) {
        fail(set, error);
      }
    },

    selectProject: async (id) => {
      set({ startingNewSession: false, startingNewSessionWorktree: null });
      // Picking a folder from the launch screen's chip while the sidebar lists
      // another one: the list follows, or the new session would land in a
      // folder the sidebar isn't showing.
      if (get().sidebarProject != null) get().setSidebarProject(id);
      try {
        applySnapshot(await api.selectProject(id));
      } catch (error) {
        fail(set, error);
      }
    },

    selectAllProjects: async () => {
      set({ startingNewSession: false, startingNewSessionWorktree: null });
      try {
        applySnapshot(await api.clearActiveProject());
      } catch (error) {
        fail(set, error);
      }
    },

    toggleSidebar: async () => {
      try {
        applySnapshot(await api.toggleSidebar());
      } catch (error) {
        fail(set, error);
      }
    },

    // "+" / ⌘N does not spawn a session itself — it only asks for the
    // launch screen back, so the picker there is choosing for a session
    // that doesn't exist yet. `sendOnLaunch` does the actual creation, once
    // there's a first message and therefore a settled agent/model. Spawning
    // here instead (as this used to) would lock in whatever the *previous*
    // session's model happened to be, and a model picked afterwards on the
    // resulting empty-transcript screen would silently do nothing — that
    // screen's session already existed and was already running the old
    // model.
    createSession: async (worktree) => {
      const snapshot = get().snapshot;
      if (!snapshot || snapshot.activeProject == null) {
        await get().openFolderDialog();
        return;
      }
      set({ startingNewSession: true, startingNewSessionWorktree: worktree ?? null });
    },

    selectSession: async (id) => {
      set({ startingNewSession: false, startingNewSessionWorktree: null });
      try {
        const snapshot = await api.selectSession(id);
        applySnapshot(snapshot);
        // Post-validation: selecting a session also moves the project
        // selection to its owner on the backend — confirm both landed.
        if (snapshot.activeSession !== id) {
          fail(set, new Error("the conversation did not switch — try again"));
        } else {
          const session = snapshot.sessions.find((s) => s.id === id);
          // Landing on a conversation outside the listed folder (search, a
          // deep link) moves the list to it, so the row you opened is on screen.
          const listed = get().sidebarProject;
          if (session && listed != null && listed !== session.projectId) {
            get().setSidebarProject(session.projectId);
          }
          if (session && snapshot.activeProject !== session.projectId) {
            fail(
              set,
              new Error(
                `opened ${session.title} but the project still shows elsewhere — try again`,
              ),
            );
          }
        }
      } catch (error) {
        fail(set, error);
      }
    },

    closeSession: async (id) => {
      try {
        const result = await api.closeSession(id);
        applySnapshot(result.state);
        // Only ever set when the worktree was kept: a session that ran in the
        // project folder, or whose checkout was removed as expected, closes
        // without a word.
        if (result.notice) set({ notice: { text: result.notice, worktree: result.kept } });
      } catch (error) {
        fail(set, error);
      }
    },

    queues: {},

    unqueueMessage: async (id, queuedId) => {
      const current = get().queues[id] ?? [];
      set({ queues: { ...get().queues, [id]: current.filter((q) => q.id !== queuedId) } });
      try {
        return await api.unqueueMessage(id, queuedId);
      } catch (error) {
        set({ queues: { ...get().queues, [id]: current } });
        fail(set, error);
        return null;
      }
    },

    sendQueuedNow: async (id, queuedId) => {
      try {
        // Stopping the turn to send this is the user's own doing: its end is
        // no news worth a sound.
        if ((get().transcripts[id]?.state ?? "idle") !== "idle") noteInterrupt(id);
        const result = await api.sendQueuedNow(id, queuedId);
        set({ queues: { ...get().queues, [id]: result.queue } });
        if (!result.queued) adoptTranscript(id, await api.getTranscript(id));
        if (result.title) patchSession(id, { title: result.title });
      } catch (error) {
        fail(set, error);
      }
    },

    renameSession: async (id, title) => {
      const before = get().snapshot?.sessions.find((s) => s.id === id)?.title;
      const wanted = title.replace(/\s+/g, " ").trim();
      if (!wanted || wanted === before) return;
      patchSession(id, { title: wanted });
      try {
        patchSession(id, { title: await api.renameSession(id, wanted) });
      } catch (error) {
        if (before !== undefined) patchSession(id, { title: before });
        fail(set, error);
      }
    },

    archiveSession: async (id) => {
      const title = get().snapshot?.sessions.find((s) => s.id === id)?.title ?? "conversation";
      try {
        applySnapshot(await api.archiveSession(id));
        set({ notice: { text: `Archived “${title}”`, worktree: null, undo: { sessionId: id } } });
      } catch (error) {
        fail(set, error);
      }
    },

    unarchiveSession: async (id) => {
      try {
        const snapshot = await api.unarchiveSession(id);
        // Brought back to be looked at: off the launch screen, and into a
        // list that shows it.
        set({ startingNewSession: false, startingNewSessionWorktree: null });
        applySnapshot(snapshot);
        const session = snapshot.sessions.find((s) => s.id === id);
        const listed = get().sidebarProject;
        if (session && listed != null && listed !== session.projectId) {
          get().setSidebarProject(session.projectId);
        }
        // The notice that offered this has done its job.
        if (get().notice?.undo?.sessionId === id) set({ notice: null });
        return true;
      } catch (error) {
        fail(set, error);
        return false;
      }
    },

    deleteArchivedSession: async (id) => {
      try {
        const result = await api.deleteArchivedSession(id);
        applySnapshot(result.state);
        if (result.notice) set({ notice: { text: result.notice, worktree: result.kept } });
        return true;
      } catch (error) {
        fail(set, error);
        return false;
      }
    },

    selectPrevSession: async () => {
      const snapshot = get().snapshot;
      if (!snapshot) return;
      const listed = sessionsInProject(snapshot, get().sidebarProject);
      const index = listed.findIndex((s) => s.id === snapshot.activeSession);
      const target = index > 0 ? listed[index - 1] : undefined;
      if (!target) return;
      set({ startingNewSession: false, startingNewSessionWorktree: null });
      try {
        applySnapshot(await api.selectSession(target.id));
      } catch (error) {
        fail(set, error);
      }
    },

    selectNextSession: async () => {
      const snapshot = get().snapshot;
      if (!snapshot) return;
      const listed = sessionsInProject(snapshot, get().sidebarProject);
      const index = listed.findIndex((s) => s.id === snapshot.activeSession);
      const target =
        index >= 0 && index < listed.length - 1 ? listed[index + 1] : undefined;
      if (!target) return;
      set({ startingNewSession: false, startingNewSessionWorktree: null });
      try {
        applySnapshot(await api.selectSession(target.id));
      } catch (error) {
        fail(set, error);
      }
    },

    sendOnLaunch: async (text, images) => {
      if (!text.trim() && !images?.length) return;
      log.info("store", `send on launch: ${preview(text)}`);
      try {
        const forceNew = get().startingNewSession;
        const pendingWorktree = get().startingNewSessionWorktree;
        let id = forceNew ? null : get().snapshot?.activeSession ?? null;
        // Defensive: never send into a session that belongs to another
        // project. If the backend ever hands back a stale pairing again
        // (sidebar on `meme-cam`, active thread still in `egant`), treat it
        // as no session and create fresh in the selected project instead of
        // continuing the wrong thread.
        const snapshotBefore = get().snapshot;
        if (id != null && snapshotBefore?.activeProject != null) {
          const stale = snapshotBefore.sessions.find((s) => s.id === id);
          if (stale && stale.projectId !== snapshotBefore.activeProject) {
            id = null;
          }
        }
        if (id == null) {
          if (get().snapshot?.activeProject == null) {
            const path = await pickProjectFolder().catch((error: unknown) => {
              fail(set, error);
              return null;
            });
            if (!path) return;
            const agent = selectNextAgent(get().snapshot, get().composerAgent);
            const model =
              selectNextModel(get().composerModel, get().defaultModels, agent) || null;
            const variant =
              selectNextVariant(get().composerVariant, get().defaultVariants, agent) ||
              null;
            const context = selectNextContextTokens(
              get().composerContext,
              get().defaultContexts,
              agent,
            );
            // A folder picked in the dialog has no chips behind it yet — its
            // refs were never loaded — so the saved default decides, which is
            // what omitting the plan asks the backend for.
            applySnapshot(await api.addProject(path, agent, model, variant, context));
          } else {
            const agent = selectNextAgent(get().snapshot, get().composerAgent);
            const model =
              selectNextModel(get().composerModel, get().defaultModels, agent) || null;
            const variant =
              selectNextVariant(get().composerVariant, get().defaultVariants, agent) ||
              null;
            const context = selectNextContextTokens(
              get().composerContext,
              get().defaultContexts,
              agent,
            );
            // A worktree folder's own "+" pins the checkout to that exact
            // worktree, bypassing the composer's chips entirely — those chips
            // are for a fresh pick, and this session already has one.
            const checkout = pendingWorktree
              ? { kind: "reuseWorktree" as const, path: pendingWorktree.path, branch: pendingWorktree.branch }
              : checkoutPlan(
                  checkoutKind(get().composerCheckout, get().snapshot),
                  get().composerRef,
                  get().refs,
                );
            applySnapshot(
              await api.createSession(agent, model, variant, context, checkout),
            );
          }
          id = get().snapshot?.activeSession ?? null;
          if (id == null) return;
          await applyComposerBypass(id);
        }
        if (forceNew) set({ startingNewSession: false, startingNewSessionWorktree: null });
        await get().ensureTranscript(id);
        await get().send(id, text, images);
      } catch (error) {
        fail(set, error);
      }
    },

    send: async (id, text, images) => {
      if (!text.trim() && !images?.length) return;
      log.info("store", `send to session ${id}: ${preview(text)}`);
      // Never send into a session that belongs to another project. If the
      // backend ever hands back a stale pairing again (sidebar on `Arka`,
      // active thread still in `egant`), refuse rather than continuing the
      // wrong thread — the agent would truthfully answer with its own folder
      // and look like it doesn't know where it is.
      const snapshot = get().snapshot;
      if (snapshot?.activeProject != null) {
        const stale = snapshot.sessions.find((s) => s.id === id);
        if (stale && stale.projectId !== snapshot.activeProject) {
          fail(
            set,
            new Error(
              `not sending into ${stale.title} — it belongs to another project; select its project first`,
            ),
          );
          // Roll back the optimistic echo above? It hasn't happened yet —
          // return before echoing so the transcript stays clean.
          return;
        }
      }
      // An image-only turn still needs something in the bubble — matches the
      // caption the backend synthesizes for the same case, so the optimistic
      // echo below never flashes empty before the real transcript arrives.
      const echoText =
        text.trim() || (images?.length === 1 ? "Here's an image." : `Here are ${images?.length ?? 0} images.`);
      // Echo immediately so the message appears on keypress — unless the
      // agent is busy, when the backend queues it rather than dropping the
      // bubble into the middle of the reply still streaming.
      const prev = get().transcripts[id] ?? emptyTranscript();
      const busy = prev.state !== "idle";
      if (!busy) {
        set({ transcripts: { ...get().transcripts, [id]: pushUser(prev, echoText) } });
        patchSession(id, { busy: true, state: "running" });
      }
      try {
        const result = await api.sendMessage(id, text, images);
        if (result.title) patchSession(id, { title: result.title });
        if (result.queued) {
          set({ queues: { ...get().queues, [id]: result.queue } });
        } else if (busy) {
          // The turn ended between the keypress and the send: it went out
          // at once, with no echo here — take the backend's transcript.
          adoptTranscript(id, await api.getTranscript(id));
          patchSession(id, { busy: true, state: "running" });
        }
      } catch (error) {
        fail(set, error);
      }
    },

    interrupt: async (id) => {
      log.info("store", `interrupt session ${id}`);
      // Stopping a run ends its turn as an error (or a completion); that is the
      // user's own doing, so the notification for it is suppressed. Only when a
      // turn is actually in flight — an idle Stop has no turn end to swallow.
      if ((get().transcripts[id]?.state ?? "idle") !== "idle") noteInterrupt(id);
      try {
        await api.interruptSession(id);
      } catch (error) {
        fail(set, error);
      }
    },

    answerPermission: async (id, requestId, replyOrDecision) => {
      const reply: PermissionReply =
        typeof replyOrDecision === "string" ? { decision: replyOrDecision } : replyOrDecision;
      const decision = reply.decision;
      // Stale rows (already resolved by an earlier click, or a snapshot that
      // arrived mid-answer) carry nothing to send — bail before touching IPC
      // so a double-click can never flash the error bar.
      if (!requestId || !decision) return;
      log.info("store", `answer permission session ${id} ${requestId} ${decision}`);
      const prev = get().transcripts[id];
      if (prev) {
        // Optimistic: drop the answered row so the table reacts on click.
        // Reconciled against the backend below (opencode Allow clears the
        // whole table and retries; Claude clears just the row).
        set({
          transcripts: { ...get().transcripts, [id]: resolvePermission(prev, requestId) },
        });
      }
      // "Deny & stop" ends the turn the way Stop does; the failed turn end it
      // produces is not news to the person who asked for it.
      if (decision === "deny" && reply.stop) noteInterrupt(id);
      // An answer the user wrote — a question's picks, a plan's verdict, a
      // note for the agent — can be refused for what it says, and then they
      // need to hear why. A bare Allow or Deny can only fail in transit.
      const wroteSomething =
        decision === "answer" || decision === "approve-plan" || reply.feedback != null;
      try {
        // Only opencode's "always" and an approved plan change the mode, and
        // the backend names the new one — nothing to guess at up front.
        const newMode = await api.answerPermission(id, requestId, reply);
        if (newMode) patchSession(id, { permissionMode: newMode });
        adoptTranscript(id, await api.getTranscript(id));
      } catch (error) {
        // Otherwise seamless, never red: the click already updated the UI
        // optimistically and the backend treats already-answered rows as
        // no-ops, so a failure here is a transport blip, not something to
        // shout about. Re-sync quietly; the row comes back if the answer
        // never landed.
        log.error("store", `answer permission failed: ${String(error)}`, error);
        if (wroteSomething) fail(set, error);
        try {
          adoptTranscript(id, await api.getTranscript(id));
        } catch {
          // Still quiet — the next session-event re-syncs anyway.
        }
      }
    },

    answerDecision: async (id, decision, response) => {
      const key = `${id}:${decision.id}`;
      // Already answered (a stale re-submit from a double click, or a second
      // event for a request the store already resolved) — idempotent no-op
      // rather than sending the agent the same decision twice.
      if (get().decisionResponses[key]) return;
      log.info("store", `answer decision session ${id} ${decision.id}: ${preview(formatDecisionReply(decision, response))}`);
      const decisionResponses = { ...get().decisionResponses, [key]: response };
      set({ decisionResponses });
      saveDecisionResponses(decisionResponses);
      // Same turn-clock treatment `send` gives a typed message — the card
      // already shows the pick inline, so this skips `pushUser`'s echoed
      // bubble and just gets the status line moving.
      const prev = get().transcripts[id] ?? emptyTranscript();
      set({ transcripts: { ...get().transcripts, [id]: markRunning(prev) } });
      patchSession(id, { busy: true });
      try {
        // The backend records the answer and sends the reply in one step, so
        // a paired phone can neither miss it nor answer the same prompt twice.
        const title = await api.answerDecision(
          id,
          decision.id,
          response,
          formatDecisionReply(decision, response),
        );
        if (title) patchSession(id, { title });
      } catch (error) {
        fail(set, error);
      }
    },

    cycleMode: async (id) => {
      log.debug("store", `cycle permission mode session ${id}`);
      try {
        const mode = await api.cyclePermissionMode(id);
        patchSession(id, { permissionMode: mode });
      } catch (error) {
        fail(set, error);
      }
    },

    setMode: async (id, mode) => {
      log.debug("store", `set permission mode session ${id} ${mode}`);
      try {
        const applied = await api.setPermissionMode(id, mode);
        patchSession(id, { permissionMode: applied });
      } catch (error) {
        fail(set, error);
      }
    },

    setSessionModel: async (id, model, variant) => {
      log.debug("store", `switch model session ${id} model=${model || "default"} variant=${variant || "default"}`);
      const session = get().snapshot?.sessions.find((s) => s.id === id);
      if (!session) return;
      // Settings' context pick for this agent still applies to the new model;
      // the old model's window might not.
      const context = selectNextContextTokens("", get().defaultContexts, session.agent);
      try {
        await api.setSessionModel(id, model || null, variant || null, context);
        patchSession(id, { modelOverride: model || null, variant: variant || null, context });
        // Same as the backend: the badge names the pick until the agent's next
        // turn reports the model it actually resolved to.
        const transcript = get().transcripts[id];
        if (transcript) {
          set({ transcripts: { ...get().transcripts, [id]: { ...transcript, model: model || null } } });
        }
      } catch (error) {
        fail(set, error);
      }
    },

    chooseWallpaper: async () => {
      const path = await pickWallpaperImage().catch((error: unknown) => {
        fail(set, error);
        return null;
      });
      if (!path) return;
      try {
        const settings = await api.setWallpaper(path);
        const snapshot = get().snapshot;
        if (snapshot) set({ snapshot: { ...snapshot, settings } });
        await syncWallpaper(settings.wallpaper);
      } catch (error) {
        fail(set, error);
      }
    },

    clearWallpaper: async () => {
      try {
        const settings = await api.setWallpaper(null);
        const snapshot = get().snapshot;
        if (snapshot) set({ snapshot: { ...snapshot, settings } });
        await syncWallpaper(null);
      } catch (error) {
        fail(set, error);
      }
    },

    cycleDim: async () => {
      try {
        const settings = await api.cycleDim();
        const snapshot = get().snapshot;
        if (snapshot) set({ snapshot: { ...snapshot, settings } });
      } catch (error) {
        fail(set, error);
      }
    },

  };
});
