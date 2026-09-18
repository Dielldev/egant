import { ChevronDown, ChevronRight, GitBranch, Loader2, RefreshCcw, Tag } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { Commit, CommitRef, GitChange } from "../lib/types";
import { diffTabKey, useEgant } from "../store";
import { ChangeStatusIcon, DiffLineStats, splitPath } from "./ChangeStatus";
import { FileIcon } from "./FileIcon";

/** How many commits a page asks for. Enough to fill the column twice over on a
 * tall window, so the first scroll is never a wait. */
const PAGE = 60;

/** The panel's History tab: the repository's commit graph, newest first.
 *
 * A row opens to the files that commit changed, and a file from there opens as
 * a diff on the stage — the same path the Diffs tab takes, which is why a
 * commit's files are not a second kind of diff viewer here. Expanding is what
 * loads them: a page of sixty commits is sixty file lists nobody asked for. */
export function HistoryPanel({ root }: { root: string }) {
  const [commits, setCommits] = useState<Commit[] | null>(null);
  const [headSha, setHeadSha] = useState<string | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const changesToken = useEgant((s) => s.changesToken);

  const load = useCallback(
    async (from: number | null) => {
      if (!root) return;
      setLoading(true);
      try {
        const page = await api.gitHistory(root, from ?? 0, PAGE);
        setCommits((prev) => (from ? [...(prev ?? []), ...page.commits] : page.commits));
        setHeadSha(page.headSha);
        setCursor(page.nextCursor);
        setError(null);
      } catch (problem) {
        setCommits(null);
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        setLoading(false);
      }
    },
    [root],
  );

  // Reloaded when a turn ends as well as on open: an agent that commits
  // something should not leave the list a commit behind.
  useEffect(() => {
    void load(null);
  }, [load, changesToken]);

  if (!root) {
    return <div className="px-3 py-2 text-[13px] text-[var(--faint)]">No folder open.</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[30px] shrink-0 items-center justify-between gap-2 px-2.5">
        <span className="truncate text-[11px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
          History
        </span>
        <button
          type="button"
          title="Re-read the graph"
          onClick={() => void load(null)}
          className="cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <RefreshCcw size={12} strokeWidth={2} />
        </button>
      </div>

      {error && (
        <div className="mx-2 mb-1.5 shrink-0 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {commits?.length === 0 && (
          <div className="px-2.5 py-2 text-[12px] text-[var(--faint)]">
            No commits yet.
          </div>
        )}
        {commits?.map((commit) => (
          <CommitRow
            key={commit.sha}
            commit={commit}
            root={root}
            isHead={commit.sha === headSha}
            expanded={open === commit.sha}
            onToggle={() => setOpen((current) => (current === commit.sha ? null : commit.sha))}
          />
        ))}
        {cursor !== null && (
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(cursor)}
            className="mt-1 flex w-full cursor-pointer items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            {loading && <Loader2 size={12} strokeWidth={2} className="animate-spin" />}
            Load more
          </button>
        )}
        {commits === null && loading && (
          <div className="px-2.5 py-2 text-[12px] text-[var(--faint)]">Reading…</div>
        )}
      </div>
    </div>
  );
}

/** One commit: subject, who and when, and the refs that point at it. Expanding
 * it fetches what it changed. */
function CommitRow({
  commit,
  root,
  isHead,
  expanded,
  onToggle,
}: {
  commit: Commit;
  root: string;
  isHead: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [files, setFiles] = useState<GitChange[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const openCommitDiff = useEgant((s) => s.openCommitDiff);
  const sessionKey = useEgant((s) => s.snapshot?.activeSession ?? -1);
  const showing = useEgant((s) => s.stageTab[s.snapshot?.activeSession ?? -1] ?? "");

  useEffect(() => {
    if (!expanded || files !== null) return;
    let cancelled = false;
    api
      .changesList(root, { kind: "commit", sha: commit.sha })
      .then((rows) => {
        if (!cancelled) setFiles(rows);
      })
      .catch((problem: unknown) => {
        if (!cancelled) setError(problem instanceof Error ? problem.message : String(problem));
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, files, root, commit.sha]);

  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        title={`${commit.sha}\n${commit.authorName} <${commit.authorEmail}>`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggle();
        }}
        className="flex w-full cursor-pointer items-start gap-1.5 rounded-md px-1.5 py-1.5 text-left hover:bg-[var(--hover)]"
      >
        <span className="mt-[3px] shrink-0 text-[var(--faint)]">
          {expanded ? (
            <ChevronDown size={13} strokeWidth={2} />
          ) : (
            <ChevronRight size={13} strokeWidth={2} />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--ink)]">
              {commit.subject}
            </span>
            {isHead && (
              <span className="shrink-0 rounded-[4px] bg-[var(--bubble)] px-1 text-[10px] text-[var(--muted)]">
                HEAD
              </span>
            )}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--faint)]">
            <span className="shrink-0 font-mono">{commit.sha.slice(0, 7)}</span>
            <span className="min-w-0 truncate">{commit.authorName}</span>
            <span className="shrink-0">·</span>
            <span className="shrink-0">{when(commit.authoredUnix)}</span>
          </span>
          {commit.refs.length > 0 && (
            <span className="flex flex-wrap items-center gap-1">
              {commit.refs.map((reference) => (
                <RefChip key={`${reference.kind}:${reference.label}`} reference={reference} />
              ))}
            </span>
          )}
        </span>
      </div>

      {expanded && (
        <div className="flex flex-col pb-1 pl-4">
          {error && <span className="px-2 py-1 text-[11px] text-[var(--danger)]">{error}</span>}
          {files === null && !error && (
            <span className="px-2 py-1 text-[11px] text-[var(--faint)]">Reading…</span>
          )}
          {files?.length === 0 && (
            <span className="px-2 py-1 text-[11px] text-[var(--faint)]">
              Nothing changed in this commit.
            </span>
          )}
          {files?.map((change) => {
            const { filename, directory } = splitPath(change.path);
            const active = showing === diffTabKey("commit", change.path, commit.sha);
            return (
              <div
                key={change.path}
                role="button"
                tabIndex={0}
                title={change.path}
                onClick={() => openCommitDiff(sessionKey, root, commit.sha, change)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    openCommitDiff(sessionKey, root, commit.sha, change);
                  }
                }}
                className={`flex h-[28px] w-full cursor-pointer items-center justify-between gap-2 rounded-md px-1.5 ${
                  active ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"
                }`}
              >
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <FileIcon name={filename} size={14} />
                  <span className="min-w-0 truncate text-[13px] text-[var(--ink)]">{filename}</span>
                  {directory && (
                    <span className="min-w-0 shrink truncate text-[11px] text-[var(--faint)]">
                      {directory}
                    </span>
                  )}
                </span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <DiffLineStats additions={change.additions} deletions={change.deletions} />
                  <ChangeStatusIcon status={change.status} size={15} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RefChip({ reference }: { reference: CommitRef }) {
  const tag = reference.kind === "tag";
  return (
    <span
      title={`${reference.kind}: ${reference.label}`}
      className="flex min-w-0 items-center gap-1 rounded-[4px] bg-[var(--bubble)] px-1 py-px text-[10px] text-[var(--muted)]"
    >
      {tag ? (
        <Tag size={9} strokeWidth={2} className="shrink-0" />
      ) : (
        <GitBranch size={9} strokeWidth={2} className="shrink-0" />
      )}
      <span className="max-w-[140px] truncate">{reference.label}</span>
    </span>
  );
}

/** How long ago, in the coarsest unit that still says something. A commit list
 * is scanned, not read: "3d" lands faster than a timestamp, and the full date
 * is on the row's tooltip for when it matters. */
function when(unix: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - unix);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(unix * 1000).toLocaleDateString();
}
