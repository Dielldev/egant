// Thin wrappers over the Tauri commands in `src-tauri/src/commands.rs`,
// plus the platform pickers (folder, image, attachments).

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { log, preview } from "./logger";
import type {
  AgentCatalogEntry,
  AgentInstallOutcome,
  AgentModel,
  AgentStatus,
  AgentUpdate,
  ClaudeUsage,
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
  getState: () => traced("get_state", "", () => invoke<WindowState>("get_state")),
  addProject: (
    path: string,
    agent?: string | null,
    model?: string | null,
    variant?: string | null,
    context?: number | null,
  ) =>
    traced("add_project", `path=${path} agent=${agent ?? "-"}`, () =>
      invoke<WindowState>("add_project", { path, agent, model, variant, context }),
    ),
  selectProject: (id: number) =>
    traced("select_project", `id=${id}`, () => invoke<WindowState>("select_project", { id })),
  toggleSidebar: () => traced("toggle_sidebar", "", () => invoke<WindowState>("toggle_sidebar")),
  clearActiveProject: () =>
    traced("clear_active_project", "", () => invoke<WindowState>("clear_active_project")),

  createSession: (
    agent?: string | null,
    model?: string | null,
    variant?: string | null,
    context?: number | null,
  ) =>
    traced("create_session", `agent=${agent ?? "-"} model=${model ?? "-"}`, () =>
      invoke<WindowState>("create_session", { agent, model, variant, context }),
    ),
  /** Opens a session that runs the agent's own CLI in a terminal instead of
   * driving it through a harness. Rejects when that CLI isn't installed. */
  createCliSession: (agent: string) =>
    traced("create_cli_session", `agent=${agent}`, () =>
      invoke<WindowState>("create_cli_session", { agent }),
    ),
  selectSession: (id: number) =>
    traced("select_session", `id=${id}`, () => invoke<WindowState>("select_session", { id })),
  closeSession: (id: number) =>
    traced("close_session", `id=${id}`, () => invoke<WindowState>("close_session", { id })),
  /** Returns the session's new title when this turn renamed it away from
   * "New session" — the sidebar patches the row with it right away. `images`
   * are paths already on disk (a pasted screenshot, saved via
   * `savePastedImage`) — each backend attaches them as real vision input,
   * not a `@path` mention left for the model to go read itself. */
  sendMessage: (id: number, text: string, images?: string[]) =>
    traced("send_message", `id=${id} ${preview(text)}`, () =>
      invoke<string | null>("send_message", { id, text, images }),
    ),
  interruptSession: (id: number) =>
    traced("interrupt_session", `id=${id}`, () => invoke<void>("interrupt_session", { id })),
  answerPermission: (id: number, requestId: string, decision: string) =>
    traced("answer_permission", `id=${id} decision=${decision}`, () =>
      // Tauri matches invoke payload keys against the command's Rust argument
      // names camelCased (`request_id` -> `requestId`); sending the
      // snake_case key here left the argument unbound on every call, so the
      // backend always fell through to "no decision" and never actually
      // answered a permission request — this is what looked like Allow/Deny
      // silently doing nothing.
      invoke<string | null>("answer_permission", { id, requestId, decision }),
    ),
  cyclePermissionMode: (id: number) =>
    traced("cycle_permission_mode", `id=${id}`, () =>
      invoke<string>("cycle_permission_mode", { id }),
    ),
  /** Jumps straight to a named mode (`default` | `plan` | `acceptEdits` |
   * `bypassPermissions`) — what the mode-info popover's rows call, instead of
   * stepping through `cyclePermissionMode` one click at a time. */
  setPermissionMode: (id: number, mode: string) =>
    traced("set_permission_mode", `id=${id} mode=${mode}`, () =>
      invoke<string>("set_permission_mode", { id, mode }),
    ),
  getTranscript: (id: number) =>
    traced("get_transcript", `id=${id}`, () => invoke<TranscriptDto>("get_transcript", { id })),

  getSettings: () => traced("get_settings", "", () => invoke<SettingsState>("get_settings")),
  setWallpaper: (path: string | null) =>
    traced("set_wallpaper", path ?? "(clear)", () =>
      invoke<SettingsState>("set_wallpaper", { path }),
    ),
  cycleDim: () => traced("cycle_dim", "", () => invoke<SettingsState>("cycle_dim")),
  setDefaultAgent: (agent: string) =>
    traced("set_default_agent", `agent=${agent}`, () =>
      invoke<SettingsState>("set_default_agent", { agent }),
    ),
  listAgents: () => traced("list_agents", "", () => invoke<AgentStatus[]>("list_agents")),
  /** Every agent the Agents tab lists, with CLI presence. A filesystem
   * probe like `listAgents`, over the wider install catalog. */
  listAgentCatalog: () =>
    traced("list_agent_catalog", "", () => invoke<AgentCatalogEntry[]>("list_agent_catalog")),
  /** Runs the catalog's own install command for one agent. Only the id
   * crosses the boundary — the command itself lives in the backend's table,
   * so nothing here can ask it to run arbitrary shell. Slow: a real install. */
  installAgent: (agent: string, method?: string | null) =>
    traced("install_agent", `agent=${agent} method=${method ?? "-"}`, () =>
      invoke<AgentInstallOutcome>("install_agent", { agent, method: method ?? null }),
    ),
  /** "Install latest" — the same source's update command, which for a package
   * manager differs from its install command. */
  updateAgent: (agent: string, method?: string | null) =>
    traced("update_agent", `agent=${agent} method=${method ?? "-"}`, () =>
      invoke<AgentInstallOutcome>("update_agent", { agent, method: method ?? null }),
    ),
  /** Whether an installed CLI is behind its published release. A network
   * lookup — called per installed agent in the background, never on render. */
  checkAgentUpdate: (agent: string) =>
    traced("check_agent_update", `agent=${agent}`, () =>
      invoke<AgentUpdate>("check_agent_update", { agent }),
    ),
  /** A live, spawn-based recheck of one agent's login — used by Settings >
   * Accounts (open, Refresh, and polling after "Add account"), never the
   * composer's hot paths, which stay on the cheap `listAgents` above. */
  checkAgentLogin: (agent: string) =>
    traced("check_agent_login", `agent=${agent}`, () =>
      invoke<AgentStatus>("check_agent_login", { agent }),
    ),
  /** Starts an agent's sign-in flow (browser tab or a Terminal window,
   * depending on the CLI) and returns once it's under way, not once it
   * succeeds — poll `checkAgentLogin` to see when it lands. */
  connectAgent: (agent: string) =>
    traced("connect_agent", `agent=${agent}`, () => invoke<void>("connect_agent", { agent })),
  listModels: (agent: string) =>
    traced("list_models", `agent=${agent}`, () => invoke<AgentModel[]>("list_models", { agent })),
  /** Claude's 5-hour and weekly usage, straight from Anthropic's usage
   * endpoint. `null` when Claude isn't logged in on this device. A network
   * call — the composer polls it, not the hot render path. */
  claudeUsageLimits: () =>
    traced("claude_usage_limits", "", () => invoke<ClaudeUsage | null>("claude_usage_limits")),
  wallpaperDataUrl: () =>
    traced("wallpaper_data_url", "", () => invoke<string | null>("wallpaper_data_url")),
  /** Keeps the native window's titlebar theme and macOS frosted-glass blur
   * in step with the Appearance setting (see `applyAppearance`). */
  syncWindowAppearance: (dark: boolean, glass: boolean) =>
    traced("sync_window_appearance", `dark=${dark} glass=${glass}`, () =>
      invoke<void>("sync_window_appearance", { dark, glass }),
    ),

  // Workspace panel — the file tree and the file tabs it opens.
  /** One directory. The tree expands lazily, so a folder nobody opened is
   * never walked. */
  listDir: (path: string) =>
    traced("list_dir", path, () => invoke<FileEntry[]>("list_dir", { path })),
  readFile: (path: string) =>
    traced("read_file", path, () => invoke<FileContent>("read_file", { path })),

  // Terminals. One real PTY per terminal tab; output arrives on `pty-output`
  // rather than as a return value, which is what makes the shell live.
  ptySpawn: (cwd: string, cols: number, rows: number) =>
    traced("pty_spawn", `cwd=${cwd}`, () => invoke<number>("pty_spawn", { cwd, cols, rows })),
  /** The same, but running one agent's own CLI rather than a shell — what a
   * CLI session's stage opens onto. Resolves the binary from the install
   * catalog and hands it the user's login-shell environment. */
  ptySpawnAgent: (cwd: string, agent: string, cols: number, rows: number) =>
    traced("pty_spawn_agent", `agent=${agent} cwd=${cwd}`, () =>
      invoke<number>("pty_spawn_agent", { cwd, agent, cols, rows }),
    ),
  ptyWrite: (id: number, data: string) =>
    invoke<void>("pty_write", { id, data }).catch((error: unknown) => {
      log.error("ipc", `← pty_write id=${id} failed: ${invokeError(error)}`, error);
      throw error;
    }),
  ptyResize: (id: number, cols: number, rows: number) =>
    traced("pty_resize", `id=${id}`, () => invoke<void>("pty_resize", { id, cols, rows })),
  ptyKill: (id: number) =>
    traced("pty_kill", `id=${id}`, () => invoke<void>("pty_kill", { id })),

  // Git, for the panel's Changes tab. Local operations go through libgit2 and
  // are cheap enough to call on every refresh; `gitPush` shells out to the
  // user's own git so it uses their credentials.
  changesList: (path: string) =>
    traced("changes_list", path, () => invoke<GitChange[]>("changes_list", { path })),
  repoStatus: (path: string) =>
    traced("repo_status", path, () => invoke<RepoStatus>("repo_status", { path })),
  diffFile: (root: string, path: string, staged: boolean) =>
    traced("diff_file", `${path} staged=${staged}`, () =>
      invoke<DiffHunk[]>("diff_file", { root, path, staged }),
    ),
  stageFiles: (root: string, paths: string[]) =>
    traced("stage_files", `${paths.length} files`, () =>
      invoke<void>("stage_files", { root, paths }),
    ),
  unstageFiles: (root: string, paths: string[]) =>
    traced("unstage_files", `${paths.length} files`, () =>
      invoke<void>("unstage_files", { root, paths }),
    ),
  stageAll: (root: string) =>
    traced("stage_all", "", () => invoke<void>("stage_all", { root })),
  /** Throws away working-tree changes. Unrecoverable — the panel confirms
   * before this is called. */
  discardFiles: (root: string, paths: string[]) =>
    traced("discard_files", `${paths.length} files`, () =>
      invoke<void>("discard_files", { root, paths }),
    ),
  commitChanges: (root: string, message: string) =>
    traced("commit_changes", preview(message, 80), () =>
      invoke<string>("commit_changes", { root, message }),
    ),
  gitPush: (root: string, remote: string, branch: string) =>
    traced("git_push", `${remote}/${branch}`, () =>
      invoke<string>("git_push", { root, remote, branch }),
    ),
  /** The first push of a branch with no upstream — `git push -u`. */
  gitPublish: (root: string, remote: string, branch: string) =>
    traced("git_publish", `${remote}/${branch}`, () =>
      invoke<string>("git_publish", { root, remote, branch }),
    ),
  gitPull: (root: string, remote: string, branch: string) =>
    traced("git_pull", `${remote}/${branch}`, () =>
      invoke<string>("git_pull", { root, remote, branch }),
    ),
  gitFetch: (root: string, remote: string) =>
    traced("git_fetch", remote, () => invoke<string>("git_fetch", { root, remote })),
  /** One side of a file as a data URL (`workdir` | `index` | `head`), for the
   * image diff. `null` means that side has no such file. */
  blobDataUrl: (root: string, path: string, source: "workdir" | "index" | "head") =>
    traced("blob_data_url", `${path}@${source}`, () =>
      invoke<string | null>("blob_data_url", { root, path, source }),
    ),
  /** The same side as text, for the preview a renderable file can offer
   * instead of its diff. */
  blobText: (root: string, path: string, source: "workdir" | "index" | "head") =>
    traced("blob_text", `${path}@${source}`, () =>
      invoke<string | null>("blob_text", { root, path, source }),
    ),
  /** Writes a pasted-image data URL to a temp file and hands back its path —
   * the composer turns that into an `@path` mention, the same way a picked
   * attachment does. */
  savePastedImage: (dataUrl: string) => {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl);
    if (!match) return Promise.reject(new Error("not an image data URL"));
    const [, mime, data] = match;
    const extension = mime.split("/")[1]?.replace("+xml", "") || "png";
    return traced("save_pasted_image", extension, () =>
      invoke<string>("save_pasted_image", { data, extension }),
    );
  },

  // GitHub, through the user's own `gh`.
  ghStatus: () => traced("gh_status", "", () => invoke<GhStatus>("gh_status")),
  prList: (root: string) =>
    traced("pr_list", "", () => invoke<PullRequest[]>("pr_list", { root })),
  prDetail: (root: string, number: number) =>
    traced("pr_detail", `#${number}`, () => invoke<PrDetail>("pr_detail", { root, number })),
  prCreate: (root: string, title: string, body: string, draft: boolean) =>
    traced("pr_create", `${preview(title, 80)} draft=${draft}`, () =>
      invoke<string>("pr_create", { root, title, body, draft }),
    ),
  prMerge: (root: string, number: number, method: "squash" | "merge" | "rebase") =>
    traced("pr_merge", `#${number} ${method}`, () =>
      invoke<string>("pr_merge", { root, number, method }),
    ),
  /** Hands a link to the platform browser — the PR conversation, a failed
   * check's log. */
  openUrl: (url: string) => traced("open_url", url, () => invoke<void>("open_url", { url })),
};

/** One IPC round trip, traced to the console: debug on start/success (with
 * timing), error on failure. `pty_write` skips this — it fires per
 * keystroke, so even a debug line per call would flood the console. */
async function traced<T>(command: string, detail: string, run: () => Promise<T>): Promise<T> {
  const suffix = detail ? ` ${detail}` : "";
  log.debug("ipc", `→ ${command}${suffix}`);
  const start = performance.now();
  try {
    const result = await run();
    log.debug("ipc", `← ${command} ok in ${Math.round(performance.now() - start)}ms`);
    return result;
  } catch (error: unknown) {
    log.error("ipc", `← ${command}${suffix} failed: ${invokeError(error)}`, error);
    throw error;
  }
}

function invokeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

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
