import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { FileEntry } from "../lib/types";
import { CHAT_TAB, useEgant } from "../store";
import { FileIcon } from "./FileIcon";
import { useFilesSettings } from "./SettingsKit";

/** One visible row: an entry plus how deep it sits. The tree is flattened for
 * rendering so the list is one scrollable column rather than nested scroll
 * containers. */
interface Row {
  entry: FileEntry;
  depth: number;
}

/** The workspace panel's Files tab: the project as a tree, expanding a
 * directory at a time. Nothing is walked until it is opened — a `node_modules`
 * nobody clicked costs nothing — and clicking a file opens it as a tab on the
 * stage rather than previewing it in this column, which is too narrow to read
 * code in. */
export function FileTree({ root }: { root: string }) {
  const [children, setChildren] = useState<Record<string, FileEntry[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  // Settings > Files > Show all files. Off, hidden and git-ignored entries are
  // left out of every listing, so flipping it re-reads the tree.
  const { showAll } = useFilesSettings();

  const openFile = useEgant((s) => s.openFile);
  const stageKey = useEgant((s) => s.snapshot?.activeSession ?? -1);
  const showing = useEgant((s) => s.stageTab[s.snapshot?.activeSession ?? -1] ?? CHAT_TAB);

  // What the newest listing was asked with: a reply to an older question (the
  // filter flipped while it was in flight) must not land in the new tree.
  const asked = useRef(showAll);
  asked.current = showAll;

  const load = useCallback(
    async (path: string) => {
      setLoading((prev) => new Set(prev).add(path));
      try {
        const rows = await api.listDir(path, showAll);
        if (asked.current !== showAll) return;
        setChildren((prev) => ({ ...prev, [path]: rows }));
        setError(null);
      } catch (problem) {
        if (asked.current !== showAll) return;
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        setLoading((prev) => {
          const next = new Set(prev);
          next.delete(path);
          return next;
        });
      }
    },
    [showAll],
  );

  // A new root is a new tree: everything expanded under the old one is gone.
  useEffect(() => {
    setChildren({});
    setExpanded(new Set());
    if (root) void load(root);
    // Only when the root changes; the filter has its own effect below, which
    // keeps open folders open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [root]);

  // Show all files flipped: re-read the root and everything open under it, so
  // the tree comes back the way it was, minus (or plus) the hidden entries.
  const firstFilter = useRef(true);
  useEffect(() => {
    if (firstFilter.current) {
      firstFilter.current = false;
      return;
    }
    setChildren({});
    if (root) void load(root);
    for (const path of expanded) void load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll]);

  const toggle = (entry: FileEntry) => {
    const next = new Set(expanded);
    if (next.has(entry.path)) {
      next.delete(entry.path);
    } else {
      next.add(entry.path);
      // Fetched once and kept — Refresh is what re-reads a directory.
      if (!children[entry.path]) void load(entry.path);
    }
    setExpanded(next);
  };

  const refresh = () => {
    setChildren({});
    // Re-read the root and everything still open under it, so the tree comes
    // back the way the user left it rather than collapsed.
    if (root) void load(root);
    for (const path of expanded) void load(path);
  };

  const rows = useMemo(() => {
    const out: Row[] = [];
    const walk = (path: string, depth: number) => {
      for (const entry of children[path] ?? []) {
        out.push({ entry, depth });
        if (entry.isDir && expanded.has(entry.path)) walk(entry.path, depth + 1);
      }
    };
    walk(root, 0);
    return out;
  }, [children, expanded, root]);

  if (!root) {
    return (
      <div className="px-3 py-2 text-[13px] text-[var(--faint)]">
        No folder open.
      </div>
    );
  }

  const rootName = root.split("/").filter(Boolean).pop() ?? root;
  const loadingRoot = loading.has(root) && !children[root];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-2.5 pt-1 pb-1.5">
        <span
          title={root}
          className="min-w-0 flex-1 truncate text-[11px] font-semibold tracking-[0.07em] text-[var(--faint)] uppercase"
        >
          {rootName}
        </span>
        <button
          type="button"
          title="Reload the tree"
          onClick={refresh}
          className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCw size={12} strokeWidth={2} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {error && (
          <div className="mx-1.5 mb-1 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] text-[var(--danger)]">
            {error}
          </div>
        )}
        {loadingRoot && (
          <div className="px-3 py-2 text-[13px] text-[var(--faint)]">Reading…</div>
        )}
        {!loadingRoot && rows.length === 0 && !error && (
          <div className="px-3 py-2 text-[13px] text-[var(--faint)]">Empty folder</div>
        )}
        {rows.map(({ entry, depth }) => (
          <TreeRow
            key={entry.path}
            entry={entry}
            depth={depth}
            open={expanded.has(entry.path)}
            busy={loading.has(entry.path)}
            selected={showing === entry.path}
            onClick={() =>
              entry.isDir ? toggle(entry) : openFile(stageKey, entry.path, entry.name)
            }
          />
        ))}
      </div>
    </div>
  );
}

function TreeRow({
  entry,
  depth,
  open,
  busy,
  selected,
  onClick,
}: {
  entry: FileEntry;
  depth: number;
  open: boolean;
  busy: boolean;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={entry.name}
      onClick={onClick}
      // The indent is padding rather than a margin so the hover band still
      // runs the full width of the column, the way a file tree should.
      style={{ paddingLeft: 6 + depth * 12 }}
      className={`flex h-[26px] w-full cursor-pointer items-center gap-1.5 pr-2 text-left text-[14px] ${
        selected
          ? "bg-[var(--selected)] text-[var(--ink)]"
          : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      }`}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center text-[var(--faint)]">
        {entry.isDir ? (
          open ? (
            <ChevronDown size={13} strokeWidth={2} />
          ) : (
            <ChevronRight size={13} strokeWidth={2} />
          )
        ) : null}
      </span>
      <FileIcon name={entry.name} isDir={entry.isDir} open={open} size={16} />
      <span className={`min-w-0 flex-1 truncate ${busy ? "opacity-60" : ""}`}>
        {entry.name}
      </span>
    </button>
  );
}
