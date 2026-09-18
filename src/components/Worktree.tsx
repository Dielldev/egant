import { Check, ChevronDown, Folder, FolderTree, GitBranch, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fitMenu } from "../lib/popover";
import type { RepoRef, WorktreeInfo } from "../lib/types";
import { checkoutKind, currentRef, useEgant, workspaceRoot } from "../store";

/** Where the next session runs, as two chips under the launch composer.
 *
 * The left one picks the *kind* of checkout — the project folder as it stands,
 * or a fresh worktree — and the right one picks the ref that decides what that
 * means. Three outcomes from two controls (see `checkoutPlan`): a worktree cut
 * off the ref, an existing worktree the ref already lives in, or the folder
 * you opened.
 *
 * Nothing here checks a branch out in the folder you opened. A picker that can
 * move your working tree from under an editor is a different feature with a
 * different set of confirmations; a worktree gets you the same isolation
 * without touching what you are looking at.
 *
 * Hidden outside a repository: two chips about refs, over a folder that has
 * none, would be two controls that do nothing. */
export function CheckoutChips() {
  const snapshot = useEgant((s) => s.snapshot);
  const refs = useEgant((s) => s.refs);
  const fetchRefs = useEgant((s) => s.fetchRefs);
  const root = workspaceRoot(snapshot);
  const hasProject = snapshot?.activeProject != null;

  // The launch screen is where this lives, so "the project in front of you" is
  // the whole of it: refs reload when the folder changes and never again.
  useEffect(() => {
    if (hasProject) void fetchRefs(root);
  }, [root, hasProject, fetchRefs]);

  if (!hasProject || refs.length === 0) return null;

  return (
    <div className="flex min-w-0 items-center gap-2">
      <CheckoutMenu />
      <RefMenu />
    </div>
  );
}

/** The project folder, or a worktree of it. */
function CheckoutMenu() {
  const snapshot = useEgant((s) => s.snapshot);
  const picked = useEgant((s) => s.composerCheckout);
  const setComposerCheckout = useEgant((s) => s.setComposerCheckout);
  const kind = checkoutKind(picked, snapshot);
  const borrowedRow = useBorrowedWorktree();
  const borrowed = borrowedRow != null;

  // Named after the worktree itself when the picked ref is already checked
  // out somewhere — "Current worktree" alone doesn't say *which* one, and
  // that's exactly the thing this chip needs to say: the new chat lands in
  // the same folder as whatever else is already running there, shown in the
  // sidebar under that worktree.
  const localLabel = borrowedRow
    ? `New chat from ${worktreeFolderName(borrowedRow.worktreePath!)}`
    : "Current checkout";

  return (
    <Chip
      label={kind === "worktree" ? "New worktree" : localLabel}
      icon={
        kind === "worktree" || borrowed ? (
          <FolderTree size={13} strokeWidth={2} className="shrink-0" />
        ) : (
          <Folder size={13} strokeWidth={2} className="shrink-0" />
        )
      }
      title={
        kind === "worktree"
          ? "This session gets its own checkout, on a branch of its own"
          : borrowedRow
            ? `This chat runs in ${worktreeFolderName(borrowedRow.worktreePath!)}, alongside its other sessions`
            : "This session runs in the project folder, on the branch it is on"
      }
      menuWidth={196}
      menuHeight={96}
    >
      {(close) => (
        <div className="p-1">
          <MenuRow
            active={kind === "current"}
            onClick={() => {
              close();
              void setComposerCheckout("current");
            }}
          >
            {borrowed ? (
              <FolderTree size={13} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
            ) : (
              <Folder size={13} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
            )}
            <span className="min-w-0 flex-1 truncate">{localLabel}</span>
            {kind === "current" && <Check size={12} strokeWidth={2} className="shrink-0" />}
          </MenuRow>
          <MenuRow
            active={kind === "worktree"}
            onClick={() => {
              close();
              void setComposerCheckout("worktree");
            }}
          >
            <FolderTree size={13} strokeWidth={2} className="shrink-0 text-[var(--muted)]" />
            <span className="min-w-0 flex-1 truncate">New worktree</span>
            {kind === "worktree" && <Check size={12} strokeWidth={2} className="shrink-0" />}
          </MenuRow>
        </div>
      )}
    </Chip>
  );
}

/** The ref the session starts from: a worktree's base, or the branch of an
 * existing worktree to run in. */
function RefMenu() {
  const snapshot = useEgant((s) => s.snapshot);
  const refs = useEgant((s) => s.refs);
  const composerRef = useEgant((s) => s.composerRef);
  const setComposerRef = useEgant((s) => s.setComposerRef);
  const picked = useEgant((s) => s.composerCheckout);
  const kind = checkoutKind(picked, snapshot);
  const [query, setQuery] = useState("");

  const selected = composerRef ?? currentRef(refs);
  const needle = query.trim().toLowerCase();
  const visible = useMemo(
    () => refs.filter((row) => needle === "" || row.name.toLowerCase().includes(needle)),
    [refs, needle],
  );

  // "From main" only when a new worktree will be cut off it — otherwise the
  // ref is naming where the session already is, not what it forks from.
  const label = selected == null ? "Select ref" : kind === "worktree" ? `From ${selected}` : selected;

  return (
    <Chip
      label={label}
      icon={<GitBranch size={13} strokeWidth={2} className="shrink-0" />}
      title={
        kind === "worktree"
          ? "The branch the new worktree forks from"
          : "The branch this session runs on"
      }
      menuWidth={264}
      menuHeight={320}
      onOpen={() => setQuery("")}
    >
      {(close) => (
        <div className="flex min-h-0 flex-col">
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
              <MenuRow
                key={row.name}
                title={row.worktreePath ?? undefined}
                active={row.name === selected}
                onClick={() => {
                  close();
                  setComposerRef(row.name);
                }}
              >
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                <RefTag row={row} />
                {row.name === selected && <Check size={12} strokeWidth={2} className="shrink-0" />}
              </MenuRow>
            ))}
            {visible.length === 0 && (
              <div className="px-3 py-2 text-[11px] text-[var(--faint)]">No refs match</div>
            )}
          </div>
        </div>
      )}
    </Chip>
  );
}

/** What is already true of a ref, in one muted word. `current` beats
 * `worktree`: a branch can only be one of the two, and the folder you opened
 * is the more useful thing to know. */
function RefTag({ row }: { row: RepoRef }) {
  const tag = row.current ? "current" : row.worktreePath ? "worktree" : null;
  if (!tag) return null;
  return <span className="shrink-0 text-[10px] text-[var(--faint)]">{tag}</span>;
}

/** The ref row for the picked branch, when it already lives in a worktree —
 * which is what turns "Current checkout" into "New chat from <name>", and a
 * plain start into borrowing a directory. `null` when the pick is a plain
 * branch with no worktree of its own. */
function useBorrowedWorktree(): RepoRef | null {
  const refs = useEgant((s) => s.refs);
  const composerRef = useEgant((s) => s.composerRef);
  const selected = composerRef ?? currentRef(refs);
  return refs.find((row) => row.name === selected && row.worktreePath != null) ?? null;
}

/** The folder a worktree path ends in — the same name its sidebar folder
 * shows (`WorktreeInfo.name`), derived from the path itself since a
 * `RepoRef` only carries the path, not the generated name. */
function worktreeFolderName(path: string): string {
  return path.split("/").pop() || path;
}

/** One chip: a label on the launch wallpaper that opens a menu under itself.
 *
 * Dimmer than the machine and project labels above the composer — those name
 * where you are, these name what the next send will do — but still white over
 * a photograph, where the panel-tuned muted tones disappear. */
function Chip({
  label,
  icon,
  title,
  menuWidth,
  menuHeight,
  onOpen,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  title: string;
  menuWidth: number;
  menuHeight: number;
  onOpen?: () => void;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState({ openUpward: false, maxHeight: menuHeight });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        title={title}
        onClick={() => {
          if (!open) {
            setPlacement(fitMenu(rootRef, menuHeight));
            onOpen?.();
          }
          setOpen((o) => !o);
        }}
        className={`flex max-w-[220px] cursor-pointer items-center gap-1.5 rounded-md text-xs font-semibold ${
          open ? "text-white" : "text-white/70 hover:text-white"
        }`}
      >
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        <ChevronDown size={13} strokeWidth={2} className="shrink-0 text-white/80" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40 cursor-default" onClick={() => setOpen(false)} />
          <div
            style={{
              maxHeight: placement.maxHeight,
              width: menuWidth,
              transformOrigin: placement.openUpward ? "bottom left" : "top left",
            }}
            className={`menu absolute left-0 z-50 flex flex-col overflow-hidden rounded-xl text-xs ${
              placement.openUpward ? "menu-pop-up bottom-full mb-1.5" : "menu-pop top-full mt-1.5"
            }`}
          >
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </div>
  );
}

function MenuRow({
  title,
  active,
  onClick,
  children,
}: {
  title?: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
        active ? "bg-[var(--selected)] text-[var(--ink)]" : ""
      }`}
    >
      {children}
    </button>
  );
}

/** The branch a running session has to itself, for the stage header.
 *
 * Only drawn for a session that has a worktree: one running in the project
 * folder is on whatever branch the user put it on, and the workspace panel
 * already says which. */
export function WorktreeChip({ worktree }: { worktree: WorktreeInfo }) {
  return (
    <span
      title={`Running in its own worktree at ${worktree.path}, on ${worktree.branch} (cut from ${worktree.base})`}
      className="flex min-w-0 shrink-0 items-center gap-1 rounded-md bg-[var(--bubble)] px-1.5 py-0.5 text-[11px] text-[var(--muted)]"
    >
      <GitBranch size={11} strokeWidth={2} className="shrink-0" />
      <span className="max-w-[160px] truncate">{worktree.branch}</span>
    </span>
  );
}
