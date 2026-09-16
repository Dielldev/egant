// Thin wrappers over the Tauri commands in `src-tauri/src/commands.rs`,
// plus the platform pickers (folder, image, attachments).

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type {
  AgentModel,
  AgentStatus,
  DiffHunk,
  FileContent,
  FileEntry,
  GhStatus,
  GitChange,
  PrDetail,
  PullRequest,
  RepoStatus,
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

  // Workspace panel — the file tree and the file tabs it opens.
  /** One directory. The tree expands lazily, so a folder nobody opened is
   * never walked. */
  listDir: (path: string) => invoke<FileEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<FileContent>("read_file", { path }),

  // Terminals. One real PTY per terminal tab; output arrives on `pty-output`
  // rather than as a return value, which is what makes the shell live.
  ptySpawn: (cwd: string, cols: number, rows: number) =>
    invoke<number>("pty_spawn", { cwd, cols, rows }),
  ptyWrite: (id: number, data: string) => invoke<void>("pty_write", { id, data }),
  ptyResize: (id: number, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  ptyKill: (id: number) => invoke<void>("pty_kill", { id }),

  // Git, for the panel's Changes tab. Local operations go through libgit2 and
  // are cheap enough to call on every refresh; `gitPush` shells out to the
  // user's own git so it uses their credentials.
  changesList: (path: string) => invoke<GitChange[]>("changes_list", { path }),
  repoStatus: (path: string) => invoke<RepoStatus>("repo_status", { path }),
  diffFile: (root: string, path: string, staged: boolean) =>
    invoke<DiffHunk[]>("diff_file", { root, path, staged }),
  stageFiles: (root: string, paths: string[]) => invoke<void>("stage_files", { root, paths }),
  unstageFiles: (root: string, paths: string[]) => invoke<void>("unstage_files", { root, paths }),
  stageAll: (root: string) => invoke<void>("stage_all", { root }),
  /** Throws away working-tree changes. Unrecoverable — the panel confirms
   * before this is called. */
  discardFiles: (root: string, paths: string[]) => invoke<void>("discard_files", { root, paths }),
  commitChanges: (root: string, message: string) =>
    invoke<string>("commit_changes", { root, message }),
  gitPush: (root: string, remote: string, branch: string) =>
    invoke<string>("git_push", { root, remote, branch }),
  /** The first push of a branch with no upstream — `git push -u`. */
  gitPublish: (root: string, remote: string, branch: string) =>
    invoke<string>("git_publish", { root, remote, branch }),
  gitPull: (root: string, remote: string, branch: string) =>
    invoke<string>("git_pull", { root, remote, branch }),
  gitFetch: (root: string, remote: string) => invoke<string>("git_fetch", { root, remote }),
  /** One side of a file as a data URL (`workdir` | `index` | `head`), for the
   * image diff. `null` means that side has no such file. */
  blobDataUrl: (root: string, path: string, source: "workdir" | "index" | "head") =>
    invoke<string | null>("blob_data_url", { root, path, source }),
  /** The same side as text, for the preview a renderable file can offer
   * instead of its diff. */
  blobText: (root: string, path: string, source: "workdir" | "index" | "head") =>
    invoke<string | null>("blob_text", { root, path, source }),

  // GitHub, through the user's own `gh`.
  ghStatus: () => invoke<GhStatus>("gh_status"),
  prList: (root: string) => invoke<PullRequest[]>("pr_list", { root }),
  prDetail: (root: string, number: number) => invoke<PrDetail>("pr_detail", { root, number }),
  prCreate: (root: string, title: string, body: string, draft: boolean) =>
    invoke<string>("pr_create", { root, title, body, draft }),
  prMerge: (root: string, number: number, method: "squash" | "merge" | "rebase") =>
    invoke<string>("pr_merge", { root, number, method }),
  /** Hands a link to the platform browser — the PR conversation, a failed
   * check's log. */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
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
