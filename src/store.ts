// The window's client-side state: the last `WindowState` snapshot, one live
// transcript per session, and the wallpaper. Events arriving on
// `session-event` are folded into the transcript mirror (see
// `lib/transcript.ts`); everything else round-trips through commands.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, pickProjectFolder, pickWallpaperImage } from "./lib/api";
import { log, preview } from "./lib/logger";
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
  ClaudeUsage,
  DecisionRequest,
  DecisionResponse,
  GitChange,
  GitChangeStatus,
  SessionEventPayload,
  SessionInfo,
  TranscriptState,
  WindowState,
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

/** Sidebar filter popover — ORGANIZE section. */
export type SidebarOrganize = "flat" | "byProject";
/** Sidebar filter popover — SORT section. */
export type SidebarSort = "updated" | "created";

/** What a workspace-panel tab holds: the project's files, a shell, or what git
 * says has changed. */
export type PanelTabKind = "files" | "terminal" | "changes";

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
  /** The live PTY, once the pane has spawned its shell. Terminal tabs only. */
  ptyId?: number;
  /** Set when that shell exits, so the tab can say so instead of looking live. */
  exited?: boolean;
}

/** Which side of git a diff is showing: the working tree against the index
 * (`disk`), or the index against HEAD (`staged`). */
export type DiffGroup = "disk" | "staged";

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
  status?: GitChangeStatus;
  /** Diffs only: the repository the path is relative to. */
  root?: string;
}

/** The suffix a diff tab carries after its filename, naming which side of git
 * it shows. */
export function diffGroupSuffix(group: DiffGroup): string {
  return group === "staged" ? "(Index)" : "(Working Tree)";
}

/** The key a diff tab is addressed by. */
export function diffTabKey(group: DiffGroup, path: string): string {
  return `diff:${group}:${path}`;
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
  /** Group sessions under their project, or keep the one flat list. */
  sidebarOrganize: SidebarOrganize;
  setSidebarOrganize: (mode: SidebarOrganize) => void;
  /** `updated` reads newest-first; `created` reads oldest-first. There is no
   * separate last-activity clock, so `updated` is `startedUnixMs` descending —
   * the closest proxy the backend tracks today. */
  sidebarSort: SidebarSort;
  setSidebarSort: (mode: SidebarSort) => void;
  /** Whether a row's meta line also names its git branch. */
  sidebarShowBranch: boolean;
  setSidebarShowBranch: (on: boolean) => void;
  /** Whether a row's meta line also spells out the harness name (its logo
   * shows regardless — this only adds the text). */
  sidebarShowHarness: boolean;
  setSidebarShowHarness: (on: boolean) => void;
  /** Sidebar width in px — dragged from its right edge, clamped to a
   * sensible range. Persisted so a resize survives reopening the window. */
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  /** Which project groups are collapsed in the "by project" sidebar, keyed
   * by project id as a string (localStorage round-trips through JSON, which
   * only has string keys). A project with a lot of history collapses down
   * to just its header, the way a folder does. */
  collapsedProjects: Record<string, boolean>;
  toggleProjectCollapsed: (projectId: number) => void;
  /** The workspace panel on the right: the project's files and its
   * terminals. Closed until asked for — the window is a conversation first. */
  panelOpen: boolean;
  panelWidth: number;
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
  openTerminalTab: () => void;
  /** Same one-of-a-kind rule as the tree: one Changes tab per window. */
  openChangesTab: () => void;
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
  openDiff: (sessionId: number, root: string, change: GitChange, group: DiffGroup) => void;
  closeStageTab: (sessionId: number, key: string) => void;
  setStageTab: (sessionId: number, key: string) => void;
  /** Bumped whenever something may have changed the working tree — a turn
   * ending, or the panel's own git actions. The Changes tab refetches on it
   * rather than polling. */
  changesToken: number;
  refreshChanges: () => void;

  /** Bumped to move focus; components watch the counter, not the value. */
  focusComposerToken: number;
  focusFilterToken: number;
  error: string | null;

  /** True from the moment "+"/⌘N is clicked until the resulting first
   * message actually creates a session. Keeps the picker's pick from being
   * discarded by an already-spawned session sitting behind the launch
   * screen — see `createSession` and `sendOnLaunch`. */
  startingNewSession: boolean;

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

  createSession: () => Promise<void>;
  selectSession: (id: number) => Promise<void>;
  closeSession: (id: number) => Promise<void>;
  selectPrevSession: () => Promise<void>;
  selectNextSession: () => Promise<void>;
  /** Send from the launch screen: opens a folder / session first if needed,
   * then delivers the text into the resulting session. */
  sendOnLaunch: (text: string, images?: string[]) => Promise<void>;
  send: (id: number, text: string, images?: string[]) => Promise<void>;
  interrupt: (id: number) => Promise<void>;
  answerPermission: (id: number, requestId: string, decision: string) => Promise<void>;
  /** Answers to `agent_request` entries the transcript fold pulled out of the
   * agent's own text — keyed `${sessionId}:${decisionId}` so a reload or a
   * session switch (which rebuilds the transcript mirror from a snapshot
   * that carries no notion of "answered") still shows the card as completed.
   * Persisted to localStorage; see `loadDecisionResponses`. */
  decisionResponses: Record<string, DecisionResponse>;
  answerDecision: (
    sessionId: number,
    decision: DecisionRequest,
    response: DecisionResponse,
  ) => Promise<void>;
  cycleMode: (id: number) => Promise<void>;
  /** Jumps straight to a named mode, for the mode-info popover's rows. */
  setMode: (id: number, mode: string) => Promise<void>;

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

function saveDecisionResponses(responses: Record<string, DecisionResponse>): void {
  try {
    localStorage.setItem("egant.decisionResponses", JSON.stringify(responses));
  } catch {
    // Unavailable storage: the answer still reached the agent; only the
    // "already answered" replay across a reload is lost.
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
    if (prev?.settings.wallpaper !== snapshot.settings.wallpaper) {
      void syncWallpaper(snapshot.settings.wallpaper);
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
    // The session rows derive their live Badges from the same fold.
    const patch: Partial<SessionInfo> = {
      busy: next.state !== "idle",
      model: next.model,
      totalCostUsd: next.totalCostUsd,
    };
    if (event.type === "exited") patch.ended = true;
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
    sidebarOrganize: (loadString("egant.sidebarOrganize") as SidebarOrganize | null) ?? "byProject",
    setSidebarOrganize: (sidebarOrganize) => {
      set({ sidebarOrganize });
      saveString("egant.sidebarOrganize", sidebarOrganize);
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
    sidebarWidth: loadNumber("egant.sidebarWidth", 250),
    setSidebarWidth: (width) => {
      const sidebarWidth = Math.round(Math.min(480, Math.max(200, width)));
      set({ sidebarWidth });
      saveString("egant.sidebarWidth", String(sidebarWidth));
    },
    collapsedProjects: loadBoolRecord("egant.collapsedProjects", {}),
    toggleProjectCollapsed: (projectId) => {
      const key = String(projectId);
      const collapsedProjects = {
        ...get().collapsedProjects,
        [key]: !get().collapsedProjects[key],
      };
      set({ collapsedProjects });
      localStorage.setItem("egant.collapsedProjects", JSON.stringify(collapsedProjects));
    },
    panelOpen: loadBool("egant.panelOpen", false),
    panelWidth: loadNumber("egant.panelWidth", 320),
    setPanelWidth: (width) => {
      const panelWidth = Math.round(Math.min(720, Math.max(240, width)));
      set({ panelWidth });
      saveString("egant.panelWidth", String(panelWidth));
    },
    panelTabs: [],
    panelTab: null,
    setPanelTab: (panelTab) => set({ panelTab }),
    togglePanel: () => {
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
    openChangesTab: () => {
      const { panelTabs } = get();
      const existing = panelTabs.find((tab) => tab.kind === "changes");
      if (existing) {
        set({ panelOpen: true, panelTab: existing.id });
      } else {
        const tab: PanelTab = {
          id: `changes-${nextPanelTabId()}`,
          kind: "changes",
          title: "Changes",
          cwd: workspaceRoot(get().snapshot),
        };
        set({ panelOpen: true, panelTabs: [...panelTabs, tab], panelTab: tab.id });
      }
      saveString("egant.panelOpen", "true");
      // Opening it is a good moment to be sure it is current.
      get().refreshChanges();
    },
    openTerminalTab: () => {
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
        cwd: workspaceRoot(get().snapshot),
      };
      set({ panelOpen: true, panelTabs: [...panelTabs, tab], panelTab: tab.id });
      saveString("egant.panelOpen", "true");
    },
    closePanelTab: (id) => {
      const { panelTabs, panelTab } = get();
      const index = panelTabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      // Closing a terminal tab ends its shell — the tab was the only thing
      // holding it open.
      const closing = panelTabs[index];
      if (closing.ptyId != null) void api.ptyKill(closing.ptyId).catch(() => {});
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
    openDiff: (sessionId, root, change, group) => {
      const name = change.path.split("/").pop() ?? change.path;
      openStageTab(sessionId, {
        key: diffTabKey(group, change.path),
        kind: "diff",
        path: change.path,
        name,
        group,
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

    focusComposerToken: 0,
    focusFilterToken: 0,
    error: null,
    startingNewSession: false,

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
        applySnapshot(await api.createCliSession(agent));
        set({ cliLaunch: null, startingNewSession: false });
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
    dismissError: () => set({ error: null }),

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
      return await listen<SessionEventPayload>("session-event", (e) => onSessionEvent(e.payload));
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
        const dto = await api.getTranscript(id);
        set({ transcripts: { ...get().transcripts, [id]: fromDto(dto) } });
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
      set({ startingNewSession: false });
      try {
        applySnapshot(await api.selectProject(id));
      } catch (error) {
        fail(set, error);
      }
    },

    selectAllProjects: async () => {
      set({ startingNewSession: false });
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
    createSession: async () => {
      const snapshot = get().snapshot;
      if (!snapshot || snapshot.activeProject == null) {
        await get().openFolderDialog();
        return;
      }
      set({ startingNewSession: true });
    },

    selectSession: async (id) => {
      set({ startingNewSession: false });
      try {
        const snapshot = await api.selectSession(id);
        applySnapshot(snapshot);
        // Post-validation: selecting a session also moves the project
        // selection to its owner on the backend — confirm both landed.
        if (snapshot.activeSession !== id) {
          fail(set, new Error("the conversation did not switch — try again"));
        } else {
          const session = snapshot.sessions.find((s) => s.id === id);
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
        applySnapshot(await api.closeSession(id));
      } catch (error) {
        fail(set, error);
      }
    },

    selectPrevSession: async () => {
      const snapshot = get().snapshot;
      if (!snapshot) return;
      const index = snapshot.sessions.findIndex((s) => s.id === snapshot.activeSession);
      const target = index > 0 ? snapshot.sessions[index - 1] : undefined;
      if (!target) return;
      set({ startingNewSession: false });
      try {
        applySnapshot(await api.selectSession(target.id));
      } catch (error) {
        fail(set, error);
      }
    },

    selectNextSession: async () => {
      const snapshot = get().snapshot;
      if (!snapshot) return;
      const index = snapshot.sessions.findIndex((s) => s.id === snapshot.activeSession);
      const target =
        index >= 0 && index < snapshot.sessions.length - 1
          ? snapshot.sessions[index + 1]
          : undefined;
      if (!target) return;
      set({ startingNewSession: false });
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
            applySnapshot(await api.createSession(agent, model, variant, context));
          }
          id = get().snapshot?.activeSession ?? null;
          if (id == null) return;
          await applyComposerBypass(id);
        }
        if (forceNew) set({ startingNewSession: false });
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
      // Echo immediately so the message appears on keypress.
      const prev = get().transcripts[id] ?? emptyTranscript();
      set({ transcripts: { ...get().transcripts, [id]: pushUser(prev, echoText) } });
      patchSession(id, { busy: true });
      try {
        const title = await api.sendMessage(id, text, images);
        if (title) patchSession(id, { title });
      } catch (error) {
        fail(set, error);
      }
    },

    interrupt: async (id) => {
      log.info("store", `interrupt session ${id}`);
      try {
        await api.interruptSession(id);
      } catch (error) {
        fail(set, error);
      }
    },

    answerPermission: async (id, requestId, decision) => {
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
      // "Allow always" flips the session to bypassPermissions — reflect it
      // immediately so the mode chip reads the mode the agent runs under,
      // then reconcile with whatever the backend reports.
      if (decision === "allow-always") {
        patchSession(id, { permissionMode: "bypassPermissions" });
      }
      try {
        const newMode = await api.answerPermission(id, requestId, decision);
        if (newMode) patchSession(id, { permissionMode: newMode });
        const dto = await api.getTranscript(id);
        set({ transcripts: { ...get().transcripts, [id]: fromDto(dto) } });
      } catch (error) {
        // Seamless, never red: the click already updated the UI optimistically
        // and the backend treats already-answered rows as no-ops, so a failure
        // here is a transport blip, not something to shout about. Re-sync
        // quietly; the row comes back if the answer never landed.
        log.error("store", `answer permission failed: ${String(error)}`, error);
        try {
          const dto = await api.getTranscript(id);
          set({ transcripts: { ...get().transcripts, [id]: fromDto(dto) } });
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
        const title = await api.sendMessage(id, formatDecisionReply(decision, response));
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
