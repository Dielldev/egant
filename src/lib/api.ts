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
  ArchivedSession,
  CheckoutPlan,
  ClaudeUsage,
  CloseResult,
  ConflictBlock,
  ConflictSide,
  ConflictStatus,
  DecisionResponse,
  DiffHunk,
  DiffScope,
  FileContent,
  FileEntry,
  GhStatus,
  GitChange,
  HistoryPage,
  MobilePairing,
  MobileStatus,
  PermissionReply,
  PrDetail,
  SendResult,
  PullRequest,
  RevertPlan,
  RepoRef,
  RepoStatus,
  SettingsState,
  TranscriptDto,
  WindowState,
  WorktreeInfo,
} from "./types";

export const api = {
  getState: () => traced("get_state", "", () => invoke<WindowState>("get_state")),
  addProject: (
    path: string,
    agent?: string | null,
    model?: string | null,
    variant?: string | null,
    context?: number | null,
    checkout?: CheckoutPlan,
  ) =>
    traced("add_project", `path=${path} agent=${agent ?? "-"}`, () =>
      invoke<WindowState>("add_project", { path, agent, model, variant, context, checkout }),
    ),
  selectProject: (id: number) =>
    traced("select_project", `id=${id}`, () => invoke<WindowState>("select_project", { id })),
  toggleSidebar: () => traced("toggle_sidebar", "", () => invoke<WindowState>("toggle_sidebar")),
  clearActiveProject: () =>
    traced("clear_active_project", "", () => invoke<WindowState>("clear_active_project")),

  /** `checkout` is where the session runs — the composer's two chips, resolved.
   * Omitted, the backend falls back to the saved default. */
  createSession: (
    agent?: string | null,
    model?: string | null,
    variant?: string | null,
    context?: number | null,
    checkout?: CheckoutPlan,
  ) =>
    traced("create_session", `agent=${agent ?? "-"} model=${model ?? "-"}`, () =>
      invoke<WindowState>("create_session", { agent, model, variant, context, checkout }),
    ),
  /** Opens a session that runs the agent's own CLI in a terminal instead of
   * driving it through a harness. Rejects when that CLI isn't installed. */
  createCliSession: (agent: string, checkout?: CheckoutPlan) =>
    traced("create_cli_session", `agent=${agent}`, () =>
      invoke<WindowState>("create_cli_session", { agent, checkout }),
    ),
  selectSession: (id: number) =>
    traced("select_session", `id=${id}`, () => invoke<WindowState>("select_session", { id })),
  /** Closing also gives the session's worktree back; see `CloseResult`.
   * `force` is the user answering "delete it anyway" to a worktree that was
   * kept the first time. */
  closeSession: (id: number, force?: boolean) =>
    traced("close_session", `id=${id}`, () =>
      invoke<CloseResult>("close_session", { id, force }),
    ),
  /** Takes a session out of the window but keeps it on disk (Settings →
   * Archived), its worktree untouched. */
  archiveSession: (id: number) =>
    traced("archive_session", `id=${id}`, () => invoke<WindowState>("archive_session", { id })),
  /** Renames a session; resolves to the title as saved (whitespace
   * collapsed). Nothing generated replaces it afterwards. */
  renameSession: (id: number, title: string) =>
    traced("rename_session", `id=${id}`, () => invoke<string>("rename_session", { id, title })),
  /** Brings an archived session back and selects it. */
  unarchiveSession: (id: number) =>
    traced("unarchive_session", `id=${id}`, () => invoke<WindowState>("unarchive_session", { id })),
  listArchivedSessions: () =>
    traced("list_archived_sessions", "", () => invoke<ArchivedSession[]>("list_archived_sessions")),
  /** Deletes an archived session for good; its worktree goes the way a closed
   * session's does (kept with a notice when it holds work, unless `force`). */
  deleteArchivedSession: (id: number, force?: boolean) =>
    traced("delete_archived_session", `id=${id}`, () =>
      invoke<CloseResult>("delete_archived_session", { id, force }),
    ),
  /** Removes a worktree that closing its session decided to keep. Takes the
   * worktree's own fields because the session that owned it is already gone. */
  discardWorktree: (worktree: WorktreeInfo) =>
    traced("discard_worktree", `branch=${worktree.branch}`, () =>
      invoke<void>("discard_worktree", {
        repoRoot: worktree.repoRoot,
        path: worktree.path,
        branch: worktree.branch,
        base: worktree.base,
      }),
    ),
  /** Returns the session's new title when this turn renamed it away from
   * "New session" — the sidebar patches the row with it right away. `images`
   * are paths already on disk (a pasted screenshot, saved via
   * `savePastedImage`) — each backend attaches them as real vision input,
   * not a `@path` mention left for the model to go read itself. */
  sendMessage: (id: number, text: string, images?: string[]) =>
    traced("send_message", `id=${id} ${preview(text)}`, () =>
      invoke<SendResult>("send_message", { id, text, images }),
    ),
  /** Takes a queued message back out; resolves to its text, or `null` when it
   * already went out. */
  /** What reverting a turn would do, without doing it. */
  previewTurnRevert: (id: number, turn: number) =>
    traced("preview_turn_revert", `id=${id} turn=${turn}`, () =>
      invoke<RevertPlan>("preview_turn_revert", { id, turn }),
    ),
  /** Puts the files a turn changed back the way they were when it began. */
  revertTurn: (id: number, turn: number) =>
    traced("revert_turn", `id=${id} turn=${turn}`, () =>
      invoke<{ files: number }>("revert_turn", { id, turn }),
    ),
  unqueueMessage: (id: number, queuedId: number) =>
    traced("unqueue_message", `id=${id} queued=${queuedId}`, () =>
      invoke<string | null>("unqueue_message", { id, queuedId }),
    ),
  /** Sends a queued message now, stopping the running turn if there is one. */
  sendQueuedNow: (id: number, queuedId: number) =>
    traced("send_queued_now", `id=${id} queued=${queuedId}`, () =>
      invoke<SendResult>("send_queued_now", { id, queuedId }),
    ),
  interruptSession: (id: number) =>
    traced("interrupt_session", `id=${id}`, () => invoke<void>("interrupt_session", { id })),
  /** Answers one outstanding request; resolves to the session's new mode when
   * the answer changed it (opencode's "always", an approved plan). */
  answerPermission: (id: number, requestId: string, reply: PermissionReply) =>
    traced("answer_permission", `id=${id} decision=${reply.decision}`, () =>
      // Tauri matches invoke payload keys against the command's Rust argument
      // names camelCased (`request_id` -> `requestId`); sending the
      // snake_case key here left the argument unbound on every call, so the
      // backend always fell through to "no decision" and never actually
      // answered a permission request — this is what looked like Allow/Deny
      // silently doing nothing.
      invoke<string | null>("answer_permission", { id, requestId, ...reply }),
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
  /** Moves a session onto another model and effort mid-conversation; `null`
   * for either is the CLI's own default. */
  setSessionModel: (
    id: number,
    model: string | null,
    variant: string | null,
    context: number | null,
  ) =>
    traced("set_session_model", `id=${id} model=${model ?? "(default)"} variant=${variant ?? "(default)"}`, () =>
      invoke<void>("set_session_model", { id, model, variant, context }),
    ),
  getTranscript: (id: number) =>
    traced("get_transcript", `id=${id}`, () => invoke<TranscriptDto>("get_transcript", { id })),
  /** Records a decision answer and sends `text` (the reply the agent reads)
   * as the next turn. Resolves to the session's new title when the reply
   * named it. An answer a paired phone already gave wins: nothing is sent. */
  answerDecision: (id: number, decisionId: string, response: DecisionResponse, text: string) =>
    traced("answer_decision", `id=${id} decision=${decisionId}`, () =>
      invoke<string | null>("answer_decision", { id, decisionId, response, text }),
    ),
  /** Hands the backend decision answers this window kept before the backend
   * did. Nothing is sent to any agent. */
  importDecisionResponses: (
    answers: { sessionId: number; decisionId: string; response: DecisionResponse }[],
  ) =>
    traced("import_decision_responses", `${answers.length} answers`, () =>
      invoke<number>("import_decision_responses", { answers }),
    ),

  // Phone access — Settings → Devices. See `src-tauri/src/mobile`.
  /** `refresh` re-asks Tailscale rather than reusing the last few seconds. */
  mobileStatus: (refresh = false) =>
    traced("mobile_status", `refresh=${refresh}`, () =>
      invoke<MobileStatus>("mobile_status", { refresh }),
    ),
  mobileSetEnabled: (enabled: boolean) =>
    traced("mobile_set_enabled", `enabled=${enabled}`, () =>
      invoke<MobileStatus>("mobile_set_enabled", { enabled }),
    ),
  /** Retries `tailscale serve`, after Tailscale was installed or HTTPS enabled. */
  mobileSetupTailscale: () =>
    traced("mobile_setup_tailscale", "", () => invoke<MobileStatus>("mobile_setup_tailscale")),
  mobileSetPublic: (on: boolean) =>
    traced("mobile_set_public", `on=${on}`, () => invoke<MobileStatus>("mobile_set_public", { on })),
  mobileCreatePairing: () =>
    traced("mobile_create_pairing", "", () => invoke<MobilePairing>("mobile_create_pairing")),
  mobileRevokeDevice: (id: string) =>
    traced("mobile_revoke_device", `id=${id}`, () =>
      invoke<MobileStatus>("mobile_revoke_device", { id }),
    ),

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
  /** Local branches for the composer's ref picker, most recently committed to
   * first, each saying where it is checked out. */
  repoRefs: (root: string) =>
    traced("repo_refs", `root=${root}`, () => invoke<RepoRef[]>("repo_refs", { root })),
  setWorktreeDefault: (on: boolean) =>
    traced("set_worktree_default", `on=${on}`, () =>
      invoke<SettingsState>("set_worktree_default", { on }),
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
  /** Every file under `root` the composer's `@` menu can mention, relative
   * to it — what git lists (so nothing `.gitignore` leaves out), or a walk
   * outside a repository. */
  listFiles: (root: string) =>
    traced("list_files", root, () => invoke<string[]>("list_files", { root })),
  /** One directory. The tree expands lazily, so a folder nobody opened is
   * never walked. */
  listDir: (path: string, showAll = true) =>
    traced("list_dir", path, () => invoke<FileEntry[]>("list_dir", { path, showAll })),
  readFile: (path: string) =>
    traced("read_file", path, () => invoke<FileContent>("read_file", { path })),
  /** Saves text over an existing file and resolves to its new modification
   * time. `expectedModifiedMs` is the version the text was edited from; a file
   * that has changed since rejects with a `conflict:` error. `null` skips the
   * check ("Overwrite"). */
  writeFile: (path: string, text: string, expectedModifiedMs: number | null) =>
    traced("write_file", path, () =>
      invoke<number>("write_file", { path, text, expectedModifiedMs }),
    ),

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

  // The Browser panel tab: one native webview per tab, layered over the
  // window and positioned to match a placeholder `<div>` (see
  // `BrowserPane.tsx`). Navigation lands as `browser-nav` events rather than
  // return values, mirroring how PTY output arrives above — a real page's
  // own link clicks and redirects have to reach the tab the same way a typed
  // address does.
  /** Creates (or, for a tab reopened after the panel closed, just moves and
   * shows) a tab's webview. Returns the address it resolved to. */
  browserOpen: (label: string, url: string, x: number, y: number, width: number, height: number) =>
    traced("browser_open", `${label} ${url}`, () =>
      invoke<string>("browser_open", { label, url, x, y, width, height }),
    ),
  /** The address bar's Enter — resolves what was typed (a URL, a bare host,
   * or a search) and navigates the tab to it. */
  browserNavigate: (label: string, url: string) =>
    traced("browser_navigate", `${label} ${url}`, () =>
      invoke<string>("browser_navigate", { label, url }),
    ),
  browserReload: (label: string) =>
    traced("browser_reload", label, () => invoke<void>("browser_reload", { label })),
  browserGoBack: (label: string) =>
    traced("browser_go_back", label, () => invoke<void>("browser_go_back", { label })),
  browserGoForward: (label: string) =>
    traced("browser_go_forward", label, () => invoke<void>("browser_go_forward", { label })),
  /** Keeps a tab's webview lined up with its placeholder on every layout
   * change — silent and frequent, so untraced like `ptyWrite`. */
  browserSetBounds: (label: string, x: number, y: number, width: number, height: number) =>
    invoke<void>("browser_set_bounds", { label, x, y, width, height }).catch((error: unknown) => {
      log.error("ipc", `← browser_set_bounds ${label} failed: ${invokeError(error)}`, error);
      throw error;
    }),
  browserSetVisible: (label: string, visible: boolean) =>
    traced("browser_set_visible", `${label} visible=${visible}`, () =>
      invoke<void>("browser_set_visible", { label, visible }),
    ),
  browserClose: (label: string) =>
    traced("browser_close", label, () => invoke<void>("browser_close", { label })),

  // Git, for the panel's Changes tab. Local operations go through libgit2 and
  // are cheap enough to call on every refresh; `gitPush` shells out to the
  // user's own git so it uses their credentials.
  /** Changed files. `scope` picks the comparison — uncommitted work by
   * default, otherwise what this branch adds, what the last turn did, or one
   * commit. Only the default scope has a staged side to it. */
  changesList: (path: string, scope?: DiffScope) =>
    traced("changes_list", `${path} ${scope?.kind ?? "workingTree"}`, () =>
      invoke<GitChange[]>("changes_list", { path, scope }),
    ),
  repoStatus: (path: string) =>
    traced("repo_status", path, () => invoke<RepoStatus>("repo_status", { path })),
  diffFile: (root: string, path: string, scope?: DiffScope) =>
    traced("diff_file", `${path} ${scope?.kind ?? "workingTree"}`, () =>
      invoke<DiffHunk[]>("diff_file", { root, path, scope }),
    ),
  /** A page of the commit graph, newest first. */
  gitHistory: (root: string, cursor?: number, limit?: number) =>
    traced("git_history", `${root} cursor=${cursor ?? 0}`, () =>
      invoke<HistoryPage>("git_history", { root, cursor, limit }),
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
  /** Merges the upstream into the current branch — the explicit answer to a
   * diverged branch, where fast-forward pull refuses. Creates a merge
   * commit; conflicts come back as an error and leave the tree conflicted. */
  gitMerge: (root: string, upstream: string) =>
    traced("git_merge", upstream, () => invoke<string>("git_merge", { root, upstream })),
  /** Rebases the current branch onto its upstream. Rewrites local commits;
   * the panel confirms before calling this. */
  gitRebase: (root: string, upstream: string) =>
    traced("git_rebase", upstream, () => invoke<string>("git_rebase", { root, upstream })),
  gitFetch: (root: string, remote: string) =>
    traced("git_fetch", remote, () => invoke<string>("git_fetch", { root, remote })),

  // Conflict resolution — a stalled merge/rebase and the toolbar over it.
  /** Whether a merge/rebase is stalled and which paths it left unmerged. */
  conflictStatus: (root: string) =>
    traced("conflict_status", root, () => invoke<ConflictStatus>("conflict_status", { root })),
  /** The conflict markers inside one file, for the inline quick-action
   * buttons. Empty for a delete conflict, which has no markers at all. */
  conflictBlocks: (root: string, path: string) =>
    traced("conflict_blocks", path, () =>
      invoke<ConflictBlock[]>("conflict_blocks", { root, path }),
    ),
  /** Resolves one file entirely to `side` and stages it. */
  resolveConflictFile: (root: string, path: string, side: ConflictSide) =>
    traced("resolve_conflict_file", `${path} side=${side}`, () =>
      invoke<void>("resolve_conflict_file", { root, path, side }),
    ),
  /** Resolves one conflict block inside a file, leaving any other block in it
   * alone. Auto-stages the file once no marker is left in it. */
  resolveConflictBlock: (root: string, path: string, index: number, side: ConflictSide) =>
    traced("resolve_conflict_block", `${path}#${index} side=${side}`, () =>
      invoke<void>("resolve_conflict_block", { root, path, index, side }),
    ),
  /** "Keep All Local" / "Accept All Incoming": resolves every unmerged file to
   * one side, then finishes the operation the same way `continueConflictOperation`
   * does. */
  resolveAllConflicts: (root: string, side: ConflictSide) =>
    traced("resolve_all_conflicts", `side=${side}`, () =>
      invoke<string>("resolve_all_conflicts", { root, side }),
    ),
  /** `rebase --continue` / a no-edit merge commit, once every file is clean. */
  continueConflictOperation: (root: string) =>
    traced("continue_conflict_operation", root, () =>
      invoke<string>("continue_conflict_operation", { root }),
    ),
  /** "Abort & Reset": backs out of the stalled merge/rebase entirely. */
  abortConflictOperation: (root: string) =>
    traced("abort_conflict_operation", root, () =>
      invoke<string>("abort_conflict_operation", { root }),
    ),

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
  /** Opens the system page that decides whether egant may show banners. */
  openNotificationSettings: () =>
    traced("open_notification_settings", "", () => invoke<void>("open_notification_settings")),
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
