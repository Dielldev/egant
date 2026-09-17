import {
  AlignJustify,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  GitBranch,
  ListTree,
  Loader2,
  Minus,
  Plus,
  RefreshCcw,
  Undo2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import type { GitChange, RepoStatus } from "../lib/types";
import type { DiffGroup } from "../store";
import { diffTabKey, useEgant } from "../store";
import { ChangeStatusIcon, DiffLineStats, splitPath } from "./ChangeStatus";
import { FileIcon } from "./FileIcon";
import { PullRequests } from "./PullRequests";

/** Which section of the panel a row belongs to. `disk` is the working tree
 * against the index; `staged` is the index against HEAD. */
type Section = DiffGroup;

/** The panel's Changes tab: what git says you have done, in the sections git
 * actually has, with the commit box pinned under all of it — committing is
 * what this column is for, and it should never be somewhere you have to
 * scroll to find.
 *
 * Nothing here polls. It reads on open, on any action it takes itself, and
 * whenever a turn ends, since that is when the agent has stopped editing. */
export function ChangesPanel({ root }: { root: string }) {
  const [changes, setChanges] = useState<GitChange[] | null>(null);
  const [status, setStatus] = useState<RepoStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  const changesToken = useEgant((s) => s.changesToken);
  const refreshChanges = useEgant((s) => s.refreshChanges);
  const openDiff = useEgant((s) => s.openDiff);
  const sessionKey = useEgant((s) => s.snapshot?.activeSession ?? -1);
  const showing = useEgant((s) => s.stageTab[s.snapshot?.activeSession ?? -1] ?? "");

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    Promise.all([api.changesList(root), api.repoStatus(root)])
      .then(([rows, repo]) => {
        if (cancelled) return;
        setChanges(rows);
        setStatus(repo);
        setError(null);
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
        setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      cancelled = true;
    };
  }, [root, changesToken]);

  const unstaged = useMemo(() => (changes ?? []).filter((c) => !c.staged), [changes]);
  const staged = useMemo(() => (changes ?? []).filter((c) => c.staged), [changes]);

  /** Runs a git action, then re-reads: every action here changes what the
   * sections should say. Returns false when it failed, which is what stops a
   * failed commit from going on to report itself as pushed. */
  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setBusy(true);
      try {
        await action();
        setError(null);
        return true;
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
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

  if (!root) {
    return <div className="px-3 py-2 text-[13px] text-[var(--faint)]">No folder open.</div>;
  }

  const clean = changes !== null && changes.length === 0;
  const repoRoot = status?.root ?? root;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <GitStatusBar status={status} busy={busy} run={run} root={root} />

      {error && (
        <div className="mx-2 mb-1.5 shrink-0 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] text-[var(--danger)]">
          {error}
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
                  onOpen={(change) => openDiff(sessionKey, root, change, "disk")}
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
                  onOpen={(change) => openDiff(sessionKey, root, change, "staged")}
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

/** Where the branch stands, and what you can do about it. Fetch and pull are
 * only offered once a branch has an upstream; before that the only sensible
 * move is to publish it. */
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
  const branch = status?.branch ?? null;
  const remote = status?.remote ?? null;
  const published = status?.published ?? false;
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;

  return (
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
          onClick={() => void run(() => api.gitPublish(root, remote, branch))}
          className="flex shrink-0 cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
        >
          <Upload size={11} strokeWidth={2.2} />
          Publish
        </button>
      )}

      {remote && branch && published && (
        <div className="flex shrink-0 items-center gap-0.5">
          <IconAction
            label="Fetch"
            disabled={busy}
            onClick={() => void run(() => api.gitFetch(root, remote))}
          >
            <RefreshCcw size={13} strokeWidth={2} />
          </IconAction>
          <IconAction
            label={behind > 0 ? `Pull ${behind}` : "Nothing to pull"}
            disabled={busy || behind === 0}
            onClick={() => void run(() => api.gitPull(root, remote, branch))}
          >
            <ArrowDown size={13} strokeWidth={2} />
          </IconAction>
          <IconAction
            label={ahead > 0 ? `Push ${ahead}` : "Nothing to push"}
            disabled={busy || ahead === 0}
            onClick={() => void run(() => api.gitPush(root, remote, branch))}
          >
            <ArrowUp size={13} strokeWidth={2} />
          </IconAction>
        </div>
      )}
    </div>
  );
}

function IconAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
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
      className="cursor-pointer rounded-md p-1.5 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {children}
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
  onOpen,
}: {
  changes: GitChange[];
  mode: ViewMode;
  root: string;
  isActive: (change: GitChange) => boolean;
  isSelected: (change: GitChange) => boolean;
  onToggleSelect: (change: GitChange) => void;
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
            onToggleSelect={() => onToggleSelect(change)}
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
          onToggleSelect={() => onToggleSelect(node.change as GitChange)}
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
  onToggleSelect: () => void;
  onOpen: () => void;
}) {
  const { filename, directory } = splitPath(change.path);
  return (
    <div
      role="button"
      tabIndex={0}
      title={`${root}/${change.path}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      style={{ paddingLeft: 8 + depth * 12 }}
      className={`group flex h-[30px] w-full cursor-pointer items-center justify-between gap-2 rounded-md pr-2 ${
        active ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
      }`}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
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
        <DiffLineStats additions={change.additions} deletions={change.deletions} />
        {/* The status gives way to the checkbox on hover, so the row never
          changes width just because the pointer is over it. */}
        <span className="relative flex size-4 items-center justify-center">
          <span className={`${selected ? "opacity-0" : "group-hover:opacity-0"}`}>
            <ChangeStatusIcon status={change.status} size={16} />
          </span>
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
        </span>
      </span>
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
        title={canPush ? `Commit and push to ${remote}/${branch} · ⌘⏎` : "Commit · ⌘⏎"}
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
