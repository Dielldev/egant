// Thin wrappers over the Tauri commands in `src-tauri/src/commands.rs`,
// plus the platform pickers (folder, image, attachments).

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentModel,
  AgentStatus,
  SettingsState,
  TranscriptDto,
  WindowState,
} from "./types";

export const api = {
  getState: () => invoke<WindowState>("get_state"),
  addProject: (
    path: string,
    agent?: string | null,
    model?: string | null,
    variant?: string | null,
    context?: number | null,
  ) =>
    invoke<WindowState>("add_project", { path, agent, model, variant, context }),
  selectProject: (id: number) => invoke<WindowState>("select_project", { id }),
  toggleSidebar: () => invoke<WindowState>("toggle_sidebar"),
  clearActiveProject: () => invoke<WindowState>("clear_active_project"),

  createSession: (
    agent?: string | null,
    model?: string | null,
    variant?: string | null,
    context?: number | null,
  ) =>
    invoke<WindowState>("create_session", { agent, model, variant, context }),
  selectSession: (id: number) => invoke<WindowState>("select_session", { id }),
  closeSession: (id: number) => invoke<WindowState>("close_session", { id }),
  /** Returns the session's new title when this turn renamed it away from
   * "New session" — the sidebar patches the row with it right away. */
  sendMessage: (id: number, text: string) =>
    invoke<string | null>("send_message", { id, text }),
  interruptSession: (id: number) => invoke<void>("interrupt_session", { id }),
  answerPermission: (id: number, allow: boolean) =>
    invoke<void>("answer_permission", { id, allow }),
  cyclePermissionMode: (id: number) => invoke<string>("cycle_permission_mode", { id }),
  /** Jumps straight to a named mode (`default` | `plan` | `acceptEdits` |
   * `bypassPermissions`) — what the mode-info popover's rows call, instead of
   * stepping through `cyclePermissionMode` one click at a time. */
  setPermissionMode: (id: number, mode: string) =>
    invoke<string>("set_permission_mode", { id, mode }),
  getTranscript: (id: number) => invoke<TranscriptDto>("get_transcript", { id }),

  getSettings: () => invoke<SettingsState>("get_settings"),
  setWallpaper: (path: string | null) => invoke<SettingsState>("set_wallpaper", { path }),
  cycleDim: () => invoke<SettingsState>("cycle_dim"),
  setDefaultAgent: (agent: string) =>
    invoke<SettingsState>("set_default_agent", { agent }),
  listAgents: () => invoke<AgentStatus[]>("list_agents"),
  /** A live, spawn-based recheck of one agent's login — used by Settings >
   * Accounts (open, Refresh, and polling after "Add account"), never the
   * composer's hot paths, which stay on the cheap `listAgents` above. */
  checkAgentLogin: (agent: string) => invoke<AgentStatus>("check_agent_login", { agent }),
  /** Starts an agent's sign-in flow (browser tab or a Terminal window,
   * depending on the CLI) and returns once it's under way, not once it
   * succeeds — poll `checkAgentLogin` to see when it lands. */
  connectAgent: (agent: string) => invoke<void>("connect_agent", { agent }),
  listModels: (agent: string) => invoke<AgentModel[]>("list_models", { agent }),
  wallpaperDataUrl: () => invoke<string | null>("wallpaper_data_url"),
  /** Keeps the native window's titlebar theme and macOS frosted-glass blur
   * in step with the Appearance setting (see `applyAppearance`). */
  syncWindowAppearance: (dark: boolean, glass: boolean) =>
    invoke<void>("sync_window_appearance", { dark, glass }),
};

/** "Open folder…" in the sidebar's project menu: the platform folder
 * picker. */
export async function pickProjectFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Open" });
  return typeof picked === "string" ? picked : null;
}

/** The wallpaper picker. The backend turns away non-images with an error. */
export async function pickWallpaperImage(): Promise<string | null> {
  const picked = await open({
    multiple: false,
    title: "Set wallpaper",
    filters: [
      {
        name: "Images",
        extensions: [
          "png",
          "jpg",
          "jpeg",
          "gif",
          "webp",
          "bmp",
          "svg",
          "ico",
          "tif",
          "tiff",
          "avif",
          "heic",
          "heif",
        ],
      },
    ],
  });
  return typeof picked === "string" ? picked : null;
}

/** The paperclip in the composer: drops what comes back into the message as `@path`
 * mentions, which is how the agent is told to read a file. */
export async function pickAttachments(): Promise<string[]> {
  const picked = await open({ multiple: true, title: "Attach" });
  if (!picked) return [];
  return Array.isArray(picked) ? picked : [picked];
}
