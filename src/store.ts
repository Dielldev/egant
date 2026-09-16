// The window's client-side state: the last `WindowState` snapshot, one live
// transcript per session, and the wallpaper. Events arriving on
// `session-event` are folded into the transcript mirror (see
// `lib/transcript.ts`); everything else round-trips through commands.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, pickProjectFolder, pickWallpaperImage } from "./lib/api";
import { applyEvent, emptyTranscript, fromDto, pushUser, resolvePermission } from "./lib/transcript";
import { parseContext } from "./lib/types";
import type {
  AgentModel,
  AgentStatus,
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
  setComposerAgent: (agent: string | null) => void;
  setComposerModel: (model: string) => void;
  setComposerVariant: (variant: string) => void;
  setComposerContext: (context: string) => void;
  fetchAgents: () => Promise<void>;
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

  /** Which agents the composer offers (`egant.agents` in localStorage).
   * Settings > Agents writes it; the picker reads it. Defaults enable the
   * three drivable agents. */
  enabledAgents: Record<string, boolean>;
  setAgentEnabled: (id: string, on: boolean) => void;
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
  /** Starred models (`${agent}:${modelId}` → true). Powers the ★ tab and the
   * per-row star toggle in the picker. */
  starredModels: Record<string, boolean>;
  toggleStarred: (agent: string, modelId: string) => void;

  /** Settings overlay: whether it covers the window and which section it
   * shows. Frontend-only; the sections themselves persist what they need. */
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setSettingsSection: (section: SettingsSection) => void;

  /** Appearance (Settings > Appearance). Persisted to localStorage and
   * painted onto the document by `applyAppearance`. */
  appearance: AppearanceState;
  setAppearance: (patch: Partial<AppearanceState>) => void;

  setFilter: (filter: string) => void;
  openFilter: () => void;
  closeFilter: () => void;
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
  sendOnLaunch: (text: string) => Promise<void>;
  send: (id: number, text: string) => Promise<void>;
  interrupt: (id: number) => Promise<void>;
  answerPermission: (id: number, allow: boolean) => Promise<void>;
  cycleMode: (id: number) => Promise<void>;
  /** Jumps straight to a named mode, for the mode-info popover's rows. */
  setMode: (id: number, mode: string) => Promise<void>;

  chooseWallpaper: () => Promise<void>;
  clearWallpaper: () => Promise<void>;
  cycleDim: () => Promise<void>;
}

function fail(set: (patch: Partial<EgantStore>) => void, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
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
  const transcript = transcripts[activeId];
  return (
    transcript !== undefined && transcript.entries.length === 0 && !transcript.pending
  );
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
      fail(set, error);
    }
  }

  function applySnapshot(snapshot: WindowState): void {
    const prev = get().snapshot;
    set({ snapshot });
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
  }

  return {
    snapshot: null,
    transcripts: {},
    wallpaperUrl: null,
    filter: "",
    filterOpen: false,
    sidebarOrganize: (loadString("egant.sidebarOrganize") as SidebarOrganize | null) ?? "flat",
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
    fetchAgents: async () => {
      try {
        set({ agents: await api.listAgents() });
      } catch (error) {
        fail(set, error);
      }
    },
    verifyAgents: async () => {
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
      set({ agents });
    },
    models: [],
    modelsAgent: null,
    modelsLoading: false,
    fetchModels: async (agent) => {
      set({ modelsLoading: true });
      try {
        set({ models: await api.listModels(agent), modelsAgent: agent });
      } catch (error) {
        fail(set, error);
        set({ models: [], modelsAgent: agent });
      } finally {
        set({ modelsLoading: false });
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
    openSettings: (section) =>
      set((s) => ({
        settingsOpen: true,
        settingsSection: section ?? s.settingsSection,
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
    requestFocusComposer: () => set((s) => ({ focusComposerToken: s.focusComposerToken + 1 })),
    dismissError: () => set({ error: null }),

    init: async () => {
      const snapshot = await api.getState();
      applySnapshot(snapshot);
      void get().verifyAgents();
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
        applySnapshot(await api.selectSession(id));
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

    sendOnLaunch: async (text) => {
      if (!text.trim()) return;
      try {
        const forceNew = get().startingNewSession;
        let id = forceNew ? null : get().snapshot?.activeSession ?? null;
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
        }
        if (forceNew) set({ startingNewSession: false });
        await get().ensureTranscript(id);
        await get().send(id, text);
      } catch (error) {
        fail(set, error);
      }
    },

    send: async (id, text) => {
      if (!text.trim()) return;
      // Echo immediately so the message appears on keypress.
      const prev = get().transcripts[id] ?? emptyTranscript();
      set({ transcripts: { ...get().transcripts, [id]: pushUser(prev, text) } });
      patchSession(id, { busy: true });
      try {
        const title = await api.sendMessage(id, text);
        if (title) patchSession(id, { title });
      } catch (error) {
        fail(set, error);
      }
    },

    interrupt: async (id) => {
      try {
        await api.interruptSession(id);
      } catch (error) {
        fail(set, error);
      }
    },

    answerPermission: async (id, allow) => {
      const prev = get().transcripts[id];
      if (prev) {
        set({ transcripts: { ...get().transcripts, [id]: resolvePermission(prev) } });
      }
      try {
        await api.answerPermission(id, allow);
      } catch (error) {
        fail(set, error);
      }
    },

    cycleMode: async (id) => {
      try {
        const mode = await api.cyclePermissionMode(id);
        patchSession(id, { permissionMode: mode });
      } catch (error) {
        fail(set, error);
      }
    },

    setMode: async (id, mode) => {
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
