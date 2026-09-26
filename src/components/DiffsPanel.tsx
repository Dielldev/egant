import {
  AlignJustify,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  FoldVertical,
  GitBranch,
  GitCompare,
  ListTree,
  Loader2,
  Minus,
  Plus,
  RefreshCcw,
  Search,
  Undo2,
  UnfoldVertical,
  Upload,
  WrapText,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { modShortcut } from "../lib/platform";
import type { DiffHunk, DiffScope, GitChange, RepoStatus } from "../lib/types";
import type { DiffScopeKind } from "../store";
import {
  DIFF_SCOPES,
  diffScopeHint,
  diffScopeLabel,
  diffTabKey,
  panelScope,
  useEgant,
} from "../store";
import { ChangeStatusIcon, DiffLineStats, splitPath } from "./ChangeStatus";
import { ConflictToolbar } from "./ConflictResolution";
import type { DiffStyle } from "./DiffHunks";
import { DiffHunks } from "./DiffHunks";
import { FileIcon } from "./FileIcon";
import { languageFor } from "./FileView";
import { PullRequests } from "./PullRequests";

/** Which section of the panel a row belongs to. `disk` is the working tree
 * against the index; `staged` is the index against HEAD. */
/** How many files a scope can hold before it stops opening them all by
 * itself. Above this, reading is a deliberate act: fifty diffs fetched for a
 * scroll nobody made is fifty round trips wasted. */
const AUTO_UNFOLD = 8;

/** The working tree's two sides. Only this scope has them: every other
 * comparison is one list of what differs between two points. */
type Section = "disk" | "staged";

/** The panel's Diffs tab.
 *
 * Its scope decides what it is a diff *of*. The working tree — the default —
 * is the only one you can act on: it has an index behind it, so it has two
 * sections, checkboxes and the commit box pinned under all of it. The other
 * two compare two points in history, which is a question with one answer and
 * nothing to stage.
 *
 * Nothing here polls. It reads on open, on any action it takes itself, and
 * whenever a turn ends, since that is when the agent has stopped editing. */
export function DiffsPanel({
  root,
  tabId,
  scope = "workingTree",
}: {
  root: string;
  tabId: string;
  scope?: DiffScopeKind;
}) {
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  // Two errors, not one: a failed git action (pull/push/…) must survive the
  // re-read it triggers — otherwise the reload's success clears the very
  // message it was meant to show (the flash-then-gone red banner). Load
  // failures live separately so either can appear without erasing the other.
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError ?? loadError;
  const dismissError = () => {
    setActionError(null);
    setLoadError(null);
  };
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    disk: true,
    staged: true,
    pullRequests: false,
  });
  const [selected, setSelected] = useState<Record<Section, Set<string>>>({
    disk: new Set(),
    staged: new Set(),
  });
  const [viewMode, setViewMode] = useState<Record<Section, ViewMode>>(() => ({
    disk: loadViewMode("disk"),
    staged: loadViewMode("staged"),
  }));
  // How diffs read, not what they are: shared with the stage's diff tabs
  // through the same two keys, so a preference set in one holds in the other.
  const [style, setStyle] = useState<DiffStyle>(() =>
    localStorage.getItem("egant.diffStyle") === "split" ? "split" : "unified",
  );
  const [wrap, setWrap] = useState(() => localStorage.getItem("egant.diffWrap") === "true");
  /** Fold-all: every file shut, whatever the list would have opened by itself. */
  const [folded, setFolded] = useState(false);
  /** Files the user has opened or shut by hand, over whatever the default is. */
  const [unfolded, setUnfolded] = useState<Record<string, boolean>>({});

  const changesToken = useEgant((s) => s.changesToken);
  const refreshChanges = useEgant((s) => s.refreshChanges);
  const openDiff = useEgant((s) => s.openDiff);
  const sessionKey = useEgant((s) => s.snapshot?.activeSession ?? -1);
  const showing = useEgant((s) => s.stageTab[s.snapshot?.activeSession ?? -1] ?? "");
  const session = useEgant((s) =>
    s.snapshot?.sessions.find((row) => row.id === s.snapshot?.activeSession),
  );
  const tab = useEgant((s) => s.panelTabs.find((row) => row.id === tabId));
  // What the backend is asked for. `undefined` is the working tree, which is
  // also what a turn scope falls back to when there is no session to have
  // taken a turn.
  const payload = panelScope(scope, session, tab?.base);
  const readOnly = payload !== undefined;
  const group = payload?.kind === "branch" ? "branch" : "turn";

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    Promise.all([api.changesList(root, payload), api.repoStatus(root)])
      .then(([rows, repo]) => {
        if (cancelled) return;
        setChanges(rows);
        setStatus(repo);
        // Notably *not* clearing the action error here: this re-read also
        // runs right after a failed pull/push, and its success must not
        // erase the failure it is reporting on.
        setLoadError(null);
        // A path that has just been staged, committed or discarded is no
        // longer selectable; keeping it selected would arm the next action
        // against a file that isn't there.
        setSelected((prev) => ({
          disk: keepPresent(prev.disk, rows, false),
          staged: keepPresent(prev.staged, rows, true),
        }));
      })
      .catch((problem: unknown) => {
        if (cancelled) return;
        setChanges(null);
        setLoadError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      cancelled = true;
    };
    // `payload` is rebuilt every render; its identity is the scope and the
    // session it names, which is what the list actually depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, changesToken, scope, session?.id, session?.worktree?.base, tab?.base]);

  const unstaged = useMemo(() => (changes ?? []).filter((c) => !c.staged), [changes]);
  const staged = useMemo(() => (changes ?? []).filter((c) => c.staged), [changes]);

  /** Runs a git action, then re-reads: every action here changes what the
   * sections should say. Returns false when it failed, which is what stops a
   * failed commit from going on to report itself as pushed. A failure sticks
   * until the next successful action or an explicit dismiss — the re-read in
   * `finally` must not clear it. */
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        setActionError(null);
        return true;
      } catch (problem) {
        setActionError(problem instanceof Error ? problem.message : String(problem));
        return false;
      } finally {
        setBusy(false);
        refreshChanges();
      }
    },
    [refreshChanges],
  );

  const chooseViewMode = (section: Section, mode: ViewMode) => {
    setViewMode((prev) => ({ ...prev, [section]: mode }));
    try {
      localStorage.setItem(`egant.changesView.${section}`, mode);
    } catch {
      // Unavailable storage: the choice still holds for this window.
    }
  };

  const toggleRow = (section: Section, path: string) =>
    setSelected((prev) => {
      const next = new Set(prev[section]);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { ...prev, [section]: next };
    });

  const toggleAll = (section: Section, rows: GitChange[]) =>
    setSelected((prev) => {
      const all = prev[section].size === rows.length && rows.length > 0;
      return { ...prev, [section]: all ? new Set() : new Set(rows.map((r) => r.path)) };
    });

  const toggleSection = (key: string) =>
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  /** Whether a file's own diff is open. A short list opens itself — the whole
   * point of reading diffs here is not to click twice for every file — and a
   * long one stays shut rather than fetching fifty diffs nobody has looked at
   * yet. Fold-all overrides the default; a click overrides fold-all. */
  const isUnfolded = (path: string, total: number) =>
    unfolded[path] ?? (!folded && total <= AUTO_UNFOLD);

  const toggleFile = (path: string, total: number) =>
    setUnfolded((prev) => ({ ...prev, [path]: !isUnfolded(path, total) }));

  const toggleFoldAll = () => {
    setFolded((prev) => !prev);
    // The per-file picks were answers to a question that has just been asked
    // again; keeping them would make the button do nothing for half the list.
    setUnfolded({});
  };

  const chooseStyle = (next: DiffStyle) => {
    setStyle(next);
    try {
      localStorage.setItem("egant.diffStyle", next);
    } catch {
      // Unavailable storage: the choice still holds for this window.
    }
  };

  const chooseWrap = (next: boolean) => {
    setWrap(next);
    try {
      localStorage.setItem("egant.diffWrap", String(next));
    } catch {
      // As above.
    }
  };

  if (!root) {
    return <div className="px-3 py-2 text-[13px] text-[var(--faint)]">No folder open.</div>;
  }

  const clean = changes !== null && changes.length === 0;
  const repoRoot = status?.root ?? root;
  const errorUpstream = status?.upstream ?? null;
  const describedError = error ? describeActionError(error, errorUpstream) : null;

  if (readOnly) {
    const rows = changes ?? [];
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <ScopeBar
          tabId={tabId}
          scope={scope}
          status={status}
          base={tab?.base}
          style={style}
          onStyle={chooseStyle}
          wrap={wrap}
          onWrap={chooseWrap}
          folded={folded}
          onFoldAll={toggleFoldAll}
        />
        <GitStatusBar status={status} busy={busy} run={run} root={root} />
        {describedError && (
          <div className="mx-2 mb-1.5 flex shrink-0 items-start gap-2 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] text-[var(--danger)]">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5 break-words">
              <span>{describedError.title}</span>
              {describedError.detail && describedError.detail !== describedError.title && (
                <span className="text-[11px] opacity-70 whitespace-pre-line">
                  {describedError.detail}
                </span>
              )}
            </span>
            <button
              type="button"
              title="Dismiss"
              aria-label="Dismiss error"
              onClick={dismissError}
              className="shrink-0 cursor-pointer rounded p-0.5 opacity-70 hover:opacity-100"
            >
              <X size={12} strokeWidth={2.2} />
            </button>
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <SectionHeader
            label={diffScopeLabel(scope)}
            count={rows.length}
            collapsed={!expanded.disk}
            onToggle={() => toggleSection("disk")}
            viewMode={viewMode.disk}
            onViewMode={(mode) => chooseViewMode("disk", mode)}
          />
          {!expanded.disk ? null : rows.length === 0 ? (
            <Empty
              label={scope === "turn" ? "Nothing yet this turn" : "Nothing on this branch"}
              detail={diffScopeHint(scope)}
            />
          ) : (
            <ChangesList
              changes={rows}
              mode={viewMode.disk}
              root={repoRoot}
              isActive={(change) => showing === diffTabKey(group, change.path)}
              isSelected={() => false}
              isUnfolded={(change) => isUnfolded(change.path, rows.length)}
              onToggleFold={(change) => toggleFile(change.path, rows.length)}
              onOpen={(change) => openDiff(sessionKey, root, change, group, payload)}
              renderDiff={(change) => (
                <FileDiff
                  root={repoRoot}
                  path={change.path}
                  scope={payload}
                  style={style}
                  wrap={wrap}
                  token={changesToken}
                />
              )}
            />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ScopeBar
        tabId={tabId}
        scope={scope}
        status={status}
        base={tab?.base}
        style={style}
        onStyle={chooseStyle}
        wrap={wrap}
        onWrap={chooseWrap}
        folded={folded}
        onFoldAll={toggleFoldAll}
      />
      <GitStatusBar status={status} busy={busy} run={run} root={root} />
      <ConflictToolbar
        root={root}
        token={changesToken}
        onOpenFile={(path) => {
          const change = (changes ?? []).find((row) => row.path === path) ?? {
            path,
            status: "conflicted" as const,
            code: "U",
            staged: false,
            additions: 0,
            deletions: 0,
          };
          openDiff(sessionKey, root, change, "disk");
        }}
        onResolved={refreshChanges}
      />

      {describedError && (
        <div className="mx-2 mb-1.5 flex shrink-0 items-start gap-2 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] text-[var(--danger)]">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5 break-words">
            <span>{describedError.title}</span>
            {describedError.detail && describedError.detail !== describedError.title && (
              <span className="text-[11px] opacity-70 whitespace-pre-line">
                {describedError.detail}
              </span>
            )}
          </span>
          <button
            type="button"
            title="Dismiss"
            aria-label="Dismiss error"
            onClick={dismissError}
            className="shrink-0 cursor-pointer rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X size={12} strokeWidth={2.2} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <SectionHeader
          label="Changed"
          count={unstaged.length}
          collapsed={!expanded.disk}
          onToggle={() => toggleSection("disk")}
          selection={selectionState(selected.disk.size, unstaged.length)}
          onToggleAll={() => toggleAll("disk", unstaged)}
          viewMode={viewMode.disk}
          onViewMode={(mode) => chooseViewMode("disk", mode)}
        />
        {expanded.disk && (
          <div className="flex shrink-0 flex-col">
            {unstaged.length === 0 ? (
              <Empty
                label={clean ? "Working tree clean" : "Nothing unstaged"}
                detail={clean ? "No uncommitted file changes." : undefined}
              />
            ) : (
              <>
                <ActionCard
                  selectedCount={selected.disk.size}
                  busy={busy}
                  confirmLabel="Discard"
                  confirmDetail="Throws the changes away for good — there is no undo."
                  onConfirm={(paths) => void run(() => api.discardFiles(root, paths))}
                  paths={(scope) =>
                    scope === "selection" ? [...selected.disk] : unstaged.map((r) => r.path)
                  }
                  actions={(scope) => (
                    <PrimaryAction
                      label={scope === "selection" ? "Stage" : "Stage all"}
                      icon={<Plus size={12} strokeWidth={2.2} />}
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          scope === "selection"
                            ? api.stageFiles(root, [...selected.disk])
                            : api.stageAll(root),
                        )
                      }
                    />
                  )}
                />
                <ChangesList
                  changes={unstaged}
                  mode={viewMode.disk}
                  root={repoRoot}
                  isActive={(change) => showing === diffTabKey("disk", change.path)}
                  isSelected={(change) => selected.disk.has(change.path)}
                  onToggleSelect={(change) => toggleRow("disk", change.path)}
                  isUnfolded={(change) => isUnfolded(change.path, unstaged.length)}
                  onToggleFold={(change) => toggleFile(change.path, unstaged.length)}
                  onOpen={(change) => openDiff(sessionKey, root, change, "disk")}
                  renderDiff={(change) => (
                    <FileDiff
                      root={repoRoot}
                      path={change.path}
                      scope={{ kind: "workingTree", staged: false }}
                      style={style}
                      wrap={wrap}
                      token={changesToken}
                    />
                  )}
                />
              </>
            )}
          </div>
        )}

        <SectionHeader
          label="Staged"
          count={staged.length}
          collapsed={!expanded.staged}
          onToggle={() => toggleSection("staged")}
          selection={selectionState(selected.staged.size, staged.length)}
          onToggleAll={() => toggleAll("staged", staged)}
          viewMode={viewMode.staged}
          onViewMode={(mode) => chooseViewMode("staged", mode)}
        />
        {expanded.staged && (
          <div className="flex shrink-0 flex-col">
            {staged.length === 0 ? (
              <Empty label="Nothing staged" detail="Stage a change to commit only that." />
            ) : (
              <>
                <ActionCard
                  selectedCount={selected.staged.size}
                  busy={busy}
                  paths={(scope) =>
                    scope === "selection" ? [...selected.staged] : staged.map((r) => r.path)
                  }
                  actions={(scope) => (
                    <PrimaryAction
                      label={scope === "selection" ? "Unstage" : "Unstage all"}
                      icon={<Minus size={12} strokeWidth={2.2} />}
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api.unstageFiles(
                            root,
                            scope === "selection"
                              ? [...selected.staged]
                              : staged.map((r) => r.path),
                          ),
                        )
                      }
                    />
                  )}
                />
                <ChangesList
                  changes={staged}
                  mode={viewMode.staged}
                  root={repoRoot}
                  isActive={(change) => showing === diffTabKey("staged", change.path)}
                  isSelected={(change) => selected.staged.has(change.path)}
                  onToggleSelect={(change) => toggleRow("staged", change.path)}
                  isUnfolded={(change) => isUnfolded(`staged:${change.path}`, staged.length)}
                  onToggleFold={(change) => toggleFile(`staged:${change.path}`, staged.length)}
                  onOpen={(change) => openDiff(sessionKey, root, change, "staged")}
                  renderDiff={(change) => (
                    <FileDiff
                      root={repoRoot}
                      path={change.path}
                      scope={{ kind: "workingTree", staged: true }}
                      style={style}
                      wrap={wrap}
                      token={changesToken}
                    />
                  )}
                />
              </>
            )}
          </div>
        )}

        <SectionHeader
          label="Pull requests"
          collapsed={!expanded.pullRequests}
          onToggle={() => toggleSection("pullRequests")}
        />
        {expanded.pullRequests && (
          <PullRequests root={root} status={status} onRefresh={refreshChanges} />
        )}
      </div>

      {!clean && changes !== null && (
        <CommitBox
          root={root}
          status={status}
          autoStage={staged.length === 0}
          run={run}
          busy={busy}
        />
      )}
    </div>
  );
}

/** Which comparison this tab is showing, and the menu that changes it.
 *
 * The tab on the strip is named after its scope too, so a second Diffs tab on
 * a different scope is told apart without opening either — which is the reason
 * for being able to open a second one at all. */
function ScopeBar({
  tabId,
  scope,
  status,
  base,
  style,
  onStyle,
  wrap,
  onWrap,
  folded,
  onFoldAll,
}: {
  tabId: string;
  scope: DiffScopeKind;
  status: RepoStatus | null;
  base: string | undefined;
  style: DiffStyle;
  onStyle: (style: DiffStyle) => void;
  wrap: boolean;
  onWrap: (wrap: boolean) => void;
  folded: boolean;
  onFoldAll: () => void;
}) {
  const setPanelScope = useEgant((s) => s.setPanelScope);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="flex h-[34px] shrink-0 items-center gap-1 px-2">
      <div ref={rootRef} className="relative shrink-0">
        <button
          type="button"
          title={diffScopeHint(scope)}
          onClick={() => setOpen((o) => !o)}
          className={`flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] font-medium hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
            open ? "bg-[var(--hover)] text-[var(--ink)]" : "text-[var(--muted)]"
          }`}
        >
          <GitCompare size={13} strokeWidth={2} className="shrink-0" />
          <span className="truncate">{diffScopeLabel(scope)}</span>
          <ChevronDown size={12} strokeWidth={2} className="shrink-0" />
        </button>
        {open && (
          <div className="menu menu-pop absolute top-full left-0 z-50 mt-1.5 w-[250px] rounded-xl p-1 text-xs">
            {DIFF_SCOPES.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPanelScope(tabId, option);
                }}
                className={`flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left hover:bg-[var(--hover)] ${
                  option === scope ? "bg-[var(--selected)]" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[12.5px] font-medium text-[var(--ink)]">
                    {diffScopeLabel(option)}
                  </span>
                  <span className="mt-0.5 block text-[11px] leading-relaxed text-[var(--muted)]">
                    {diffScopeHint(option)}
                  </span>
                </span>
                {option === scope && (
                  <Check size={13} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--ink)]" />
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Only the branch scope has two ends to name. The others compare
        against a point in time, which the scope's own label already says. */}
      {scope === "branch" && <BaseChip tabId={tabId} status={status} base={base} />}

      <div className="ml-auto flex shrink-0 items-center gap-0.5">
        <ToolbarToggle
          title={style === "split" ? "Side by side · on" : "Side by side"}
          on={style === "split"}
          onClick={() => onStyle(style === "split" ? "unified" : "split")}
        >
          <Columns2 size={13} strokeWidth={2} />
        </ToolbarToggle>
        <ToolbarToggle
          title={wrap ? "Wrap long lines · on" : "Wrap long lines"}
          on={wrap}
          onClick={() => onWrap(!wrap)}
        >
          <WrapText size={13} strokeWidth={2} />
        </ToolbarToggle>
        <ToolbarToggle
          title={folded ? "Unfold every file" : "Fold every file"}
          on={false}
          onClick={onFoldAll}
        >
          {folded ? (
            <UnfoldVertical size={13} strokeWidth={2} />
          ) : (
            <FoldVertical size={13} strokeWidth={2} />
          )}
        </ToolbarToggle>
      </div>
    </div>
  );
}

/** `this-branch → main ⌄` — what a branch scope is measured against, and the
 * one control that changes it.
 *
 * The arrow reads the way the comparison does: everything on the left that the
 * right does not already have. Picking a base holds for this tab only, so two
 * Diffs tabs can measure the same branch against two different things. */
function BaseChip({
  tabId,
  status,
  base,
}: {
  tabId: string;
  status: RepoStatus | null;
  base: string | undefined;
}) {
  const refs = useEgant((s) => s.refs);
  const fetchRefs = useEgant((s) => s.fetchRefs);
  const setPanelBase = useEgant((s) => s.setPanelBase);
  const session = useEgant((s) =>
    s.snapshot?.sessions.find((row) => row.id === s.snapshot?.activeSession),
  );
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const root = status?.root ?? "";

  useEffect(() => {
    if (open && root) void fetchRefs(root);
  }, [open, root, fetchRefs]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The same order the backend resolves in, so the chip never names one thing
  // while the diff measures another.
  const current = session?.worktree?.branch ?? status?.branch ?? "HEAD";
  const against = base ?? session?.worktree?.base ?? status?.defaultBase ?? null;
  const needle = query.trim().toLowerCase();
  const visible = refs.filter((row) => needle === "" || row.name.toLowerCase().includes(needle));

  return (
    <div ref={rootRef} className="relative flex min-w-0 items-center">
      <span
        // The branch names the comparison; the tooltip names the checkout it
        // is being read from, which for a worktree session is not the folder
        // the project menu shows.
        title={root ? `Reading ${root}` : undefined}
        className="max-w-[180px] shrink truncate font-mono text-[11.5px] text-[var(--muted)]"
      >
        {current}
      </span>
      <span className="mx-1.5 shrink-0 text-[var(--faint)]">→</span>
      <button
        type="button"
        title="What this branch is measured against"
        onClick={() => {
          if (!open) setQuery("");
          setOpen((o) => !o);
        }}
        className={`flex min-w-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 font-mono text-[11.5px] hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
          open ? "bg-[var(--hover)] text-[var(--ink)]" : "text-[var(--muted)]"
        }`}
      >
        <span className="max-w-[150px] truncate">{against ?? "pick a base"}</span>
        <ChevronDown size={11} strokeWidth={2} className="shrink-0" />
      </button>
      {open && (
        <div className="menu menu-pop absolute top-full left-0 z-50 mt-1.5 flex max-h-[320px] w-[250px] flex-col overflow-hidden rounded-xl text-xs">
          <div className="shrink-0 px-2 pt-2 pb-1.5">
            <div className="flex items-center gap-2 rounded-lg bg-[var(--card)] px-2.5 py-1.5">
              <Search size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search refs…"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1">
            {visible.map((row) => (
              <button
                key={row.name}
                type="button"
                onClick={() => {
                  setOpen(false);
                  setPanelBase(tabId, row.name);
                }}
                className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
                  row.name === against ? "bg-[var(--selected)] text-[var(--ink)]" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.current && (
                  <span className="shrink-0 text-[10px] text-[var(--faint)]">current</span>
                )}
                {row.name === against && <Check size={12} strokeWidth={2} className="shrink-0" />}
              </button>
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-[var(--faint)]">No refs match</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** One of the toolbar's square buttons. `on` is a state the user set, not a
 * hover — it stays lit so the toolbar says how the diffs below are being read
 * without having to look at them. */
function ToolbarToggle({
  title,
  on,
  onClick,
  children,
}: {
  title: string;
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`cursor-pointer rounded-md p-1 hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
        on ? "bg-[var(--selected)] text-[var(--ink)]" : "text-[var(--faint)]"
      }`}
    >
      {children}
    </button>
  );
}

/** Where the branch stands, and what you can do about it.
 *
 * `behind` is only as fresh as the last fetch — that is why Pull stays
 * enabled even when it reads zero: `git pull --ff-only` fetches first, so it
 * still picks up commits someone else pushed since the last check. The hint
 * underneath says exactly that when the view may be stale.
 *
 * When both sides moved (ahead and behind), fast-forwarding is impossible by
 * definition — the banner then offers the two explicit ways to rejoin them,
 * Merge and Rebase, instead of letting Pull fail with git's raw complaint. */
function GitStatusBar({
  status,
  busy,
  run,
  root,
}: {
  status: RepoStatus | null;
  busy: boolean;
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  root: string;
}) {
  const [active, setActive] = useState<
    "fetch" | "pull" | "push" | "publish" | "merge" | "rebase" | null
  >(null);
  const [confirming, setConfirming] = useState<"merge" | "rebase" | null>(null);
  const branch = status?.branch ?? null;
  const remote = status?.remote ?? null;
  const published = status?.published ?? false;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const upstream = status?.upstream ?? (remote && branch ? `${remote}/${branch}` : null);
  const lastFetched = status?.lastFetchedUnix ?? null;
  const checked = lastCheckedLabel(lastFetched);
  // Five minutes without a check is when "0 behind" stops being an answer
  // and starts being a guess.
  const stale = lastFetched == null || Date.now() / 1000 - lastFetched > 5 * 60;

  const canFetch = Boolean(remote);
  const canSync = Boolean(remote && branch && published);
  const diverged = canSync && ahead > 0 && behind > 0;

  const doAction = (
    kind: "fetch" | "pull" | "push" | "publish" | "merge" | "rebase",
    action: () => Promise<unknown>,
  ) => {
    if (busy) return;
    setActive(kind);
    setConfirming(null);
    void run(action).finally(() => setActive(null));
  };

  return (
    <div className="flex shrink-0 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 px-3">
        <GitBranch size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        <span
          className="min-w-0 flex-1 truncate text-[13px] text-[var(--muted)]"
          title={status?.headSummary ?? undefined}
        >
          {branch ?? "detached"}
        </span>

        {published && (ahead > 0 || behind > 0) && (
          <span className="flex shrink-0 items-center gap-1.5 text-[12px] text-[var(--faint)] tabular-nums">
            {ahead > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowUp size={10} strokeWidth={2.4} />
                {ahead}
              </span>
            )}
            {behind > 0 && (
              <span className="flex items-center gap-0.5">
                <ArrowDown size={10} strokeWidth={2.4} />
                {behind}
              </span>
            )}
          </span>
        )}

        {remote && branch && !published && (
          <button
            type="button"
            title={`Publish ${branch} to ${remote}`}
            disabled={busy}
            onClick={() => doAction("publish", () => api.gitPublish(root, remote, branch))}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
          >
            {active === "publish" ? (
              <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />
            ) : (
              <Upload size={11} strokeWidth={2.2} />
            )}
            Publish
          </button>
        )}

        {canFetch && (!branch || !published) && (
          <div className="flex shrink-0 items-center gap-0.5">
            <IconAction
              label={remote ? `Fetch ${remote} — check for remote changes` : "Fetch"}
              disabled={busy}
              spinning={active === "fetch"}
              onClick={() => doAction("fetch", () => api.gitFetch(root, remote as string))}
            >
              <RefreshCcw size={13} strokeWidth={2} />
            </IconAction>
          </div>
        )}

        {canSync && (
          <div className="flex shrink-0 items-center gap-0.5">
            <IconAction
              label={
                upstream
                  ? `Fetch ${remote} — check whether ${upstream} moved · ${checked}`
                  : `Fetch ${remote} · ${checked}`
              }
              disabled={busy}
              spinning={active === "fetch"}
              onClick={() => doAction("fetch", () => api.gitFetch(root, remote as string))}
            >
              <RefreshCcw size={13} strokeWidth={2} />
            </IconAction>
            <IconAction
              label={
                diverged
                  ? `Diverged — fast-forward pull can't join the two sides, merge or rebase below`
                  : behind > 0
                    ? `Pull ${behind} from ${upstream ?? remote} (fast-forward only)`
                    : upstream
                      ? `Pull from ${upstream} — fetches first, so it still picks up new commits (fast-forward only)`
                      : "Pull (fast-forward only)"
              }
              disabled={busy}
              spinning={active === "pull"}
              highlight={behind > 0}
              onClick={() =>
                doAction("pull", () => api.gitPull(root, remote as string, branch as string))
              }
            >
              <ArrowDown size={13} strokeWidth={2} />
            </IconAction>
            <IconAction
              label={ahead > 0 ? `Push ${ahead} to ${upstream ?? remote}` : "Nothing to push"}
              disabled={busy || ahead === 0}
              spinning={active === "push"}
              onClick={() =>
                doAction("push", () => api.gitPush(root, remote as string, branch as string))
              }
            >
              <ArrowUp size={13} strokeWidth={2} />
            </IconAction>
          </div>
        )}
      </div>

      {canSync && diverged && (
        <div className="mx-2 mb-1.5 flex shrink-0 flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-2">
          <span className="text-[12px] leading-snug text-[var(--muted)]">
            Diverged — {ahead} local plus {behind} from {upstream ?? remote}. A fast-forward
            pull can&apos;t join two sides that both moved.
          </span>
          {confirming === null ? (
            <div className="flex items-center justify-end gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming("rebase")}
                title={`Replay your ${ahead} commit${ahead === 1 ? "" : "s"} on top of ${upstream}`}
                className="cursor-pointer rounded-full px-2.5 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
              >
                Rebase
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming("merge")}
                title={`Join ${upstream} into ${branch} with a merge commit`}
                className="flex cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
              >
                {active === "merge" ? (
                  <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />
                ) : (
                  <ArrowDown size={11} strokeWidth={2.2} />
                )}
                Merge
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] leading-snug text-[var(--ink)]">
                {confirming === "merge"
                  ? `Merge ${upstream} into ${branch}? This creates a merge commit.`
                  : `Rebase ${branch} onto ${upstream}? This rewrites your ${ahead} local commit${ahead === 1 ? "" : "s"} — don't do it if you've already pushed them.`}
              </span>
              <div className="flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(null)}
                  className="cursor-pointer rounded-full px-2 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    confirming === "merge"
                      ? doAction("merge", () => api.gitMerge(root, upstream as string))
                      : doAction("rebase", () => api.gitRebase(root, upstream as string))
                  }
                  className="flex cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
                >
                  {(confirming === "merge" && active === "merge") ||
                  (confirming === "rebase" && active === "rebase") ? (
                    <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />
                  ) : null}
                  {confirming === "merge" ? "Merge" : "Rebase"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {canSync && !diverged && behind > 0 && (
        <div className="mx-2 mb-1.5 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5">
          <span className="min-w-0 truncate text-[12px] text-[var(--muted)]">
            {behind} behind {upstream ?? remote} — someone committed since you last pulled.
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              doAction("pull", () => api.gitPull(root, remote as string, branch as string))
            }
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
          >
            {active === "pull" ? (
              <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />
            ) : (
              <ArrowDown size={11} strokeWidth={2.2} />
            )}
            Pull
          </button>
        </div>
      )}

      {canSync && behind === 0 && stale && (
        <div className="mx-2 mb-1.5 flex shrink-0 items-center justify-between gap-2 px-1">
          <span className="min-w-0 truncate text-[11.5px] text-[var(--faint)]">
            {checked === "never checked"
              ? `Not checked with ${remote} yet — fetch to see if ${upstream ?? "the remote"} changed.`
              : `${checked} — fetch to see if ${upstream ?? "the remote"} changed.`}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => doAction("fetch", () => api.gitFetch(root, remote as string))}
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 text-[11.5px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
          >
            {active === "fetch" ? (
              <Loader2 size={11} strokeWidth={2} className="animate-spin" />
            ) : (
              <RefreshCcw size={11} strokeWidth={2} />
            )}
            Fetch
          </button>
        </div>
      )}
    </div>
  );
}

/** "checked 2m ago" / "never checked" for the fetch hint. */
function lastCheckedLabel(lastFetchedUnix: number | null | undefined): string {
  if (lastFetchedUnix == null) return "never checked";
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - lastFetchedUnix);
  if (seconds < 60) return "checked just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `checked ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `checked ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `checked ${days}d ago`;
  return `checked on ${new Date(lastFetchedUnix * 1000).toLocaleDateString()}`;
}

/** Git's raw failure, minus the noise: the `git exited with status N` wrapper,
 * `hint:` coaching lines, and fetch progress (`From …`, `* branch …`) go away.
 * What's left is the line a person would actually read. */
function cleanGitError(raw: string): string {
  const withoutPrefix = raw.replace(/^git exited with status -?\d+:\s*/i, "");
  const kept = withoutPrefix
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !/^hint:/i.test(line) &&
        !/^from\s+\S+/i.test(line) &&
        !/^\*\s+branch\s+.*->\s*FETCH_HEAD/i.test(line) &&
        !/^fetching\s+/i.test(line),
    );
  return kept.join("\n").trim() || raw.trim();
}

/** A raw action failure as the banner shows it: a plain sentence first, and
 * the cleaned git output underneath only when it adds something. */
function describeActionError(raw: string, upstream: string | null): {
  title: string;
  detail: string | null;
} {
  const lower = raw.toLowerCase();
  const clean = cleanGitError(raw);
  const where = upstream ?? "the remote branch";

  if (
    lower.includes("not possible to fast-forward") ||
    lower.includes("diverging branches") ||
    lower.includes("can't be fast-forwarded") ||
    lower.includes("cannot be fast-forwarded")
  ) {
    return {
      title: `Diverged — ${where} and your branch both moved, so a fast-forward pull can't join them. Merge or rebase from the banner above, then push.`,
      detail: clean,
    };
  }
  if (lower.includes("non-fast-forward") || lower.includes("fetch first")) {
    return {
      title: `Push rejected — ${where} moved since you last fetched. Fetch, then merge or rebase before pushing.`,
      detail: clean,
    };
  }
  if (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("permission denied (publickey)") ||
    lower.includes("invalid username or password") ||
    lower.includes("could not resolve hostname")
  ) {
    return {
      title: "Couldn't reach the remote — check your connection and sign-in (SSH key / gh auth login), then retry.",
      detail: clean,
    };
  }
  if (lower.includes("no tracking information") || lower.includes("no upstream")) {
    return {
      title: "This branch has no upstream yet — Publish it first.",
      detail: null,
    };
  }
  if (
    lower.includes("local changes would be overwritten") ||
    lower.includes("commit your changes or stash") ||
    lower.includes("you have unstaged changes") ||
    lower.includes("cannot rebase: you have unstaged")
  ) {
    return {
      title: "Uncommitted changes are in the way — commit or stash them first, then retry.",
      detail: clean,
    };
  }
  if (lower.includes("conflict") || lower.includes("automatic merge failed")) {
    const rebase = lower.includes("rebase");
    return {
      title: rebase
        ? "Rebase stopped on conflicts — resolve the marked files in a terminal, then `git rebase --continue` (or `--abort` to back out)."
        : "Merge conflicts — resolve the marked files, stage them, then commit the result.",
      detail: clean,
    };
  }
  return { title: clean, detail: null };
}

function IconAction({
  label,
  disabled,
  spinning,
  highlight,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  spinning?: boolean;
  highlight?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`cursor-pointer rounded-md p-1.5 hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent ${
        highlight ? "bg-[var(--selected)] text-[var(--ink)]" : "text-[var(--muted)]"
      } ${spinning ? "pointer-events-none opacity-60" : ""}`}
    >
      {spinning ? <Loader2 size={13} strokeWidth={2} className="animate-spin" /> : children}
    </button>
  );
}

/** Drops paths that are no longer in their section. */
function keepPresent(selection: Set<string>, rows: GitChange[], staged: boolean): Set<string> {
  const present = new Set(rows.filter((row) => row.staged === staged).map((row) => row.path));
  return new Set([...selection].filter((path) => present.has(path)));
}

type SelectionState = "none" | "partial" | "all";

function selectionState(chosen: number, total: number): SelectionState {
  if (total === 0 || chosen === 0) return "none";
  return chosen === total ? "all" : "partial";
}

function SectionHeader({
  label,
  count,
  collapsed,
  onToggle,
  selection,
  onToggleAll,
  viewMode,
  onViewMode,
}: {
  label: string;
  /** Absent on a section with no count worth showing. */
  count?: number;
  collapsed: boolean;
  onToggle: () => void;
  selection?: SelectionState;
  onToggleAll?: () => void;
  viewMode?: ViewMode;
  onViewMode?: (mode: ViewMode) => void;
}) {
  return (
    <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-t border-[var(--border)] px-3 first:border-t-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 cursor-pointer items-center gap-1.5 text-[var(--muted)] hover:text-[var(--ink)]"
      >
        <ChevronDown
          size={14}
          strokeWidth={2}
          className={`shrink-0 transition-transform duration-200 ${collapsed ? "-rotate-90" : ""}`}
        />
        <span className="truncate text-[14px]">{label}</span>
        {count !== undefined && (
          <span className="shrink-0 rounded-full bg-[var(--bubble)] px-1.5 py-px text-[11.5px] tabular-nums">
            {count}
          </span>
        )}
      </button>
      {count !== undefined && count > 0 && selection && onToggleAll && (
        <div className="flex shrink-0 items-center gap-2">
          {viewMode && onViewMode && (
            <button
              type="button"
              title={viewMode === "flat" ? "Switch to tree view" : "Switch to flat list"}
              aria-label={`${
                viewMode === "flat" ? "Switch to tree view" : "Switch to flat list"
              } (${label})`}
              onClick={() => onViewMode(viewMode === "flat" ? "tree" : "flat")}
              className="cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              {viewMode === "flat" ? (
                <AlignJustify size={13} strokeWidth={2} />
              ) : (
                <ListTree size={13} strokeWidth={2} />
              )}
            </button>
          )}
          <Checkbox
            state={selection}
            label={`Select all ${label.toLowerCase()}`}
            onClick={onToggleAll}
          />
        </div>
      )}
    </div>
  );
}

/** The bar above a section's rows: what the next action applies to, and the
 * actions themselves. It says "All files" until rows are ticked, at which
 * point every button narrows to the selection — so a click can never do more
 * than the bar says it will. */
function ActionCard({
  selectedCount,
  busy,
  paths,
  actions,
  confirmLabel,
  confirmDetail,
  onConfirm,
}: {
  selectedCount: number;
  busy: boolean;
  paths: (scope: "selection" | "all") => string[];
  actions: (scope: "selection" | "all") => React.ReactNode;
  /** Optional destructive action (discard), which asks before it runs. */
  confirmLabel?: string;
  confirmDetail?: string;
  onConfirm?: (paths: string[]) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const scope = selectedCount > 0 ? "selection" : "all";
  const targets = paths(scope);

  if (confirming && onConfirm) {
    return (
      <div className="mx-2 mb-1 flex flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-2">
        <span className="text-[12.5px] text-[var(--ink)]">
          {confirmLabel} {targets.length} file{targets.length === 1 ? "" : "s"}?
        </span>
        {confirmDetail && (
          <span className="text-[12px] text-[var(--faint)]">{confirmDetail}</span>
        )}
        <div className="flex items-center justify-end gap-1.5">
          <QuietAction label="Cancel" onClick={() => setConfirming(false)} />
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              onConfirm(targets);
            }}
            className="cursor-pointer rounded-full bg-[rgba(224,112,112,0.16)] px-2.5 py-0.5 text-[12px] text-[var(--danger)] hover:opacity-85"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-2 mb-1 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-[var(--border)] bg-[var(--card)] px-2.5 py-1.5">
      <span className="min-w-0 truncate text-[12px] text-[var(--faint)]">
        {selectedCount > 0
          ? `${selectedCount} file${selectedCount === 1 ? "" : "s"} selected`
          : "All files"}
      </span>
      <div className="flex shrink-0 items-center gap-1.5">
        {onConfirm && (
          <QuietAction
            label={scope === "selection" ? "Discard" : "Discard all"}
            icon={<Undo2 size={12} strokeWidth={2.2} />}
            danger
            disabled={busy || targets.length === 0}
            onClick={() => setConfirming(true)}
          />
        )}
        {actions(scope)}
      </div>
    </div>
  );
}

function PrimaryAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
    >
      {icon}
      {label}
    </button>
  );
}

function QuietAction({
  label,
  icon,
  danger,
  disabled,
  onClick,
}: {
  label: string;
  icon?: React.ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={`flex shrink-0 cursor-pointer items-center gap-1 rounded-full px-1.5 py-0.5 text-[12px] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40 ${
        danger ? "text-[var(--danger)]" : "text-[var(--muted)]"
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

/** Flat is every change as its own row; tree groups them under the folders
 * they live in. Per section, because the two usually hold different amounts. */
export type ViewMode = "flat" | "tree";

function loadViewMode(section: Section): ViewMode {
  try {
    return localStorage.getItem(`egant.changesView.${section}`) === "tree" ? "tree" : "flat";
  } catch {
    return "flat";
  }
}

/** A folder in the tree view, or a change at the end of one. */
interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
  change?: GitChange;
}

/** Groups changed paths under their directories. Only folders that actually
 * contain a change appear, so the tree is a picture of the change rather than
 * of the project. */
function buildTree(changes: GitChange[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const byPath = new Map<string, TreeNode>();

  for (const change of changes) {
    const parts = change.path.split("/").filter(Boolean);
    let prefix = "";
    let parent: TreeNode | null = null;

    parts.forEach((segment, index) => {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      const leaf = index === parts.length - 1;
      const key = `${leaf ? "f" : "d"}:${prefix}`;
      let node = byPath.get(key);
      if (!node) {
        node = { name: segment, path: prefix, children: [], change: leaf ? change : undefined };
        byPath.set(key, node);
        (parent ? parent.children : roots).push(node);
      }
      parent = node;
    });
  }

  const sort = (nodes: TreeNode[]): TreeNode[] => {
    nodes.sort((a, b) => {
      const aDir = a.change === undefined;
      const bDir = b.change === undefined;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
    for (const node of nodes) sort(node.children);
    return nodes;
  };
  return sort(roots);
}

/** A section's rows, flat or as a tree. */
function ChangesList({
  changes,
  mode,
  root,
  isActive,
  isSelected,
  onToggleSelect,
  isUnfolded,
  onToggleFold,
  renderDiff,
  onOpen,
}: {
  changes: GitChange[];
  mode: ViewMode;
  root: string;
  isActive: (change: GitChange) => boolean;
  isSelected: (change: GitChange) => boolean;
  /** Absent in the read-only scopes: a branch's diff is not something you can
   * stage half of. Rows then keep their status icon instead of trading it for
   * a checkbox on hover. */
  onToggleSelect?: (change: GitChange) => void;
  isUnfolded?: (change: GitChange) => boolean;
  onToggleFold?: (change: GitChange) => void;
  /** The file's own diff, drawn under its row while it is unfolded. */
  renderDiff?: (change: GitChange) => React.ReactNode;
  onOpen: (change: GitChange) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = useMemo(() => (mode === "tree" ? buildTree(changes) : []), [changes, mode]);

  if (mode === "flat") {
    return (
      <>
        {changes.map((change) => (
          <ChangeRow
            key={change.path}
            change={change}
            root={root}
            active={isActive(change)}
            selected={isSelected(change)}
            unfolded={isUnfolded?.(change)}
            onToggleFold={onToggleFold && (() => onToggleFold(change))}
            body={isUnfolded?.(change) ? renderDiff?.(change) : null}
            onToggleSelect={onToggleSelect && (() => onToggleSelect(change))}
            onOpen={() => onOpen(change)}
          />
        ))}
      </>
    );
  }

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (nodes: TreeNode[], depth: number): React.ReactNode =>
    nodes.map((node) =>
      node.change ? (
        <ChangeRow
          key={node.path}
          change={node.change}
          root={root}
          depth={depth}
          // In a tree the folders above already say where the file is.
          nameOnly
          active={isActive(node.change)}
          selected={isSelected(node.change)}
          unfolded={isUnfolded?.(node.change)}
          onToggleFold={onToggleFold && (() => onToggleFold(node.change as GitChange))}
          body={isUnfolded?.(node.change) ? renderDiff?.(node.change as GitChange) : null}
          onToggleSelect={onToggleSelect && (() => onToggleSelect(node.change as GitChange))}
          onOpen={() => onOpen(node.change as GitChange)}
        />
      ) : (
        <div key={node.path} className="flex flex-col">
          <button
            type="button"
            onClick={() => toggle(node.path)}
            style={{ paddingLeft: 8 + depth * 12 }}
            className="flex h-[26px] w-full cursor-pointer items-center gap-1 pr-2 text-left text-[13px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            {collapsed.has(node.path) ? (
              <ChevronRight size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
            ) : (
              <ChevronDown size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
            )}
            <FileIcon
              name={node.name}
              isDir
              open={!collapsed.has(node.path)}
              size={15}
            />
            <span className="min-w-0 truncate">{node.name}</span>
          </button>
          {!collapsed.has(node.path) && render(node.children, depth + 1)}
        </div>
      ),
    );

  return <>{render(tree, 0)}</>;
}

/** One changed path. Reads filename-first with the directory trailing behind
 * it, because in a column this narrow the name is what you are looking for and
 * the path is only there to tell two of them apart. */
function ChangeRow({
  change,
  root,
  active,
  selected,
  depth = 0,
  nameOnly = false,
  unfolded,
  onToggleFold,
  body,
  onToggleSelect,
  onOpen,
}: {
  change: GitChange;
  root: string;
  active: boolean;
  selected: boolean;
  /** Indent, for the tree view. */
  depth?: number;
  /** Drops the trailing directory, which the tree has already shown. */
  nameOnly?: boolean;
  /** Whether this file's own diff is showing under it. */
  unfolded?: boolean;
  onToggleFold?: () => void;
  /** The diff itself, when there is one to draw. */
  body?: React.ReactNode;
  /** Absent where selecting means nothing — see `ChangesList`. */
  onToggleSelect?: () => void;
  /** Opens the file as a diff on the stage — the full-width read, for when
   * the panel's column is not enough. */
  onOpen: () => void;
}) {
  const { filename, directory } = splitPath(change.path);
  // The row's own click unfolds the diff underneath it; the stage is one
  // button further, on hover. A pane that shows diffs should not make you
  // leave it to read one.
  const activate = onToggleFold ?? onOpen;
  return (
    <div className="flex flex-col">
    <div
      role="button"
      tabIndex={0}
      title={`${root}/${change.path}`}
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") activate();
      }}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`group flex h-[30px] w-full cursor-pointer items-center justify-between gap-2 rounded-md pr-2 ${
        active ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        {onToggleFold && (
          <span className="shrink-0 text-[var(--faint)]">
            {unfolded ? (
              <ChevronDown size={12} strokeWidth={2} />
            ) : (
              <ChevronRight size={12} strokeWidth={2} />
            )}
          </span>
        )}
        <FileIcon name={filename} size={15} />
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="max-w-full shrink-0 truncate text-[14px] text-[var(--ink)]">
            {filename}
          </span>
          {directory && !nameOnly && (
            <span className="min-w-0 shrink truncate text-[12px] text-[var(--faint)]">
              {directory}
            </span>
          )}
        </span>
      </span>

      <span className="flex shrink-0 items-center gap-1.5">
        {onToggleFold && (
          <button
            type="button"
            title="Open as a tab"
            onClick={(e) => {
              e.stopPropagation();
              onOpen();
            }}
            className="hidden cursor-pointer rounded p-0.5 text-[var(--faint)] group-hover:block hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <ArrowUpRight size={13} strokeWidth={2} />
          </button>
        )}
        <DiffLineStats additions={change.additions} deletions={change.deletions} />
        {/* The status gives way to the checkbox on hover, so the row never
          changes width just because the pointer is over it. */}
        <span className="relative flex size-4 items-center justify-center">
          <span
            className={
              onToggleSelect ? (selected ? "opacity-0" : "group-hover:opacity-0") : undefined
            }
          >
            <ChangeStatusIcon status={change.status} size={16} />
          </span>
          {onToggleSelect && (
            <span
              className={`absolute inset-0 flex items-center justify-center ${
                selected ? "" : "opacity-0 group-hover:opacity-100"
              }`}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Checkbox
                state={selected ? "all" : "none"}
                label={`Select ${filename}`}
                onClick={onToggleSelect}
              />
            </span>
          )}
        </span>
      </span>
    </div>
      {body}
    </div>
  );
}

/** One file's diff, under its row. Fetched when the row is unfolded and again
 * whenever the working tree may have moved, which is the same signal the list
 * above it refreshes on. */
function FileDiff({
  root,
  path,
  scope,
  style,
  wrap,
  token,
}: {
  root: string;
  path: string;
  scope: DiffScope | undefined;
  style: DiffStyle;
  wrap: boolean;
  token: number;
}) {
  const [hunks, setHunks] = useState<DiffHunk[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // `scope` is a fresh object every render; what the fetch depends on is the
  // comparison it names (including `staged` / `base` / `session` / `sha`).
  const scopeKey = JSON.stringify(scope ?? null);

  useEffect(() => {
    let cancelled = false;
    api
      .diffFile(root, path, scope)
      .then((result) => {
        if (!cancelled) {
          setHunks(result);
          setError(null);
        }
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root, path, scopeKey, token]);

  if (error) {
    return <div className="px-3 py-1.5 text-[11px] text-[var(--danger)]">{error}</div>;
  }
  if (hunks === null) {
    return <div className="px-3 py-1.5 text-[11px] text-[var(--faint)]">Reading…</div>;
  }
  if (hunks.length === 0) {
    return (
      <div className="px-3 py-1.5 text-[11px] text-[var(--faint)]">
        Nothing to show — the file is binary, or unchanged on this side.
      </div>
    );
  }
  return (
    <div className="mb-1 overflow-x-auto rounded-md border border-[var(--border)]">
      <DiffHunks hunks={hunks} language={languageFor(path)} style={style} wrap={wrap} />
    </div>
  );
}

function Checkbox({
  state,
  label,
  onClick,
}: {
  state: SelectionState;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "all" ? "true" : state === "partial" ? "mixed" : "false"}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`flex size-[15px] shrink-0 cursor-pointer items-center justify-center rounded-[4px] border ${
        state === "none"
          ? "border-[var(--faint)]"
          : "border-transparent bg-[var(--toggle-on)] text-[var(--toggle-knob)]"
      }`}
    >
      {state === "all" && <Check size={11} strokeWidth={3} />}
      {state === "partial" && <Minus size={11} strokeWidth={3} />}
    </button>
  );
}

function Empty({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex shrink-0 flex-col gap-0.5 px-3 py-2">
      <span className="text-[13px] text-[var(--muted)]">{label}</span>
      {detail && <span className="text-[12px] text-[var(--faint)]">{detail}</span>}
    </div>
  );
}

type CommitPhase = "idle" | "committing" | "pushing" | "done";

/** The commit box, pinned to the bottom of the column. One button: it commits
 * and pushes, because a commit that never leaves this machine helps nobody —
 * and with nothing staged it stages everything first, which is the common
 * case. Without a remote to push to there is only the commit to make, and the
 * button says so rather than offering something that would fail. */
function CommitBox({
  root,
  status,
  autoStage,
  run,
  busy,
}: {
  root: string;
  status: RepoStatus | null;
  autoStage: boolean;
  /** Returns false when the action failed, which is what stops a failed
   * commit from going on to report itself as pushed. */
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  busy: boolean;
}) {
  const [message, setMessage] = useState("");
  const [description, setDescription] = useState("");
  const [phase, setPhase] = useState<CommitPhase>("idle");

  const remote = status?.remote ?? null;
  const branch = status?.branch ?? null;
  const canPush = Boolean(remote && branch);
  const full = description.trim() ? `${message.trim()}\n\n${description.trim()}` : message.trim();
  const working = phase === "committing" || phase === "pushing";

  const commit = async () => {
    setPhase("committing");
    const committed = await run(async () => {
      if (autoStage) await api.stageAll(root);
      await api.commitChanges(root, full);
    });
    if (!committed) {
      // The error is already on screen; the message stays in the box so it
      // isn't lost along with the attempt.
      setPhase("idle");
      return;
    }
    setMessage("");
    setDescription("");

    if (!remote || !branch) {
      setPhase("done");
      setTimeout(() => setPhase("idle"), 2000);
      return;
    }
    setPhase("pushing");
    // A branch nobody has pushed yet needs its upstream set; after that it is
    // an ordinary push.
    const pushed = await run(() =>
      status?.published
        ? api.gitPush(root, remote, branch)
        : api.gitPublish(root, remote, branch),
    );
    setPhase(pushed ? "done" : "idle");
    if (pushed) setTimeout(() => setPhase("idle"), 2000);
  };

  const submitOnCmdEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && message.trim() && !working) {
      e.preventDefault();
      void commit();
    }
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-[var(--border)] px-2 py-2">
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={submitOnCmdEnter}
        placeholder="Commit message"
        disabled={working}
        className="w-full rounded-md bg-[var(--card)] px-2.5 py-1.5 text-[14px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={submitOnCmdEnter}
        placeholder="Description"
        rows={2}
        disabled={working}
        className="w-full resize-none rounded-md bg-[var(--card)] px-2.5 py-1.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
      />
      <button
        type="button"
        disabled={!message.trim() || busy || working}
        onClick={() => void commit()}
        title={
          canPush
            ? `Commit and push to ${remote}/${branch} · ${modShortcut("⏎")}`
            : `Commit · ${modShortcut("⏎")}`
        }
        className="flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-full bg-[#f2f2f5] px-3 py-1.5 text-[13px] text-[#0c0c0e] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
      >
        {working && <Loader2 size={13} strokeWidth={2} className="animate-spin" />}
        {phase === "committing"
          ? "Committing…"
          : phase === "pushing"
            ? "Pushing…"
            : phase === "done"
              ? canPush
                ? "Pushed"
                : "Committed"
              : canPush
                ? "Commit & Push"
                : "Commit"}
      </button>
    </div>
  );
}
