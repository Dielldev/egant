import {
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  Loader2,
  MinusCircle,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { GhStatus, PrCheck, PrDetail, PullRequest, RepoStatus } from "../lib/types";
import { DiffLineStats, splitPath } from "./ChangeStatus";
import { FileIcon } from "./FileIcon";

type MergeMethod = "squash" | "merge" | "rebase";

/** The panel's third section: the pull requests this repository has open, and
 * the one you would open from the branch you are on.
 *
 * Everything here runs through the user's own `gh`, so it uses the account
 * they are already signed in as — there is no second sign-in to keep in step,
 * and no token for this window to hold. What `gh` can't do in one call (the
 * conversation on a PR, a failed check's log) links out to the browser rather
 * than being half-rebuilt here. */
export function PullRequests({
  root,
  status,
  onRefresh,
}: {
  root: string;
  status: RepoStatus | null;
  onRefresh: () => void;
}) {
  const [gh, setGh] = useState<GhStatus | null>(null);
  const [prs, setPrs] = useState<PullRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [token, setToken] = useState(0);

  const reload = useCallback(() => setToken((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    void api
      .ghStatus()
      .then((result) => {
        if (!cancelled) setGh(result);
      })
      .catch(() => {
        if (!cancelled) {
          setGh({ installed: false, authenticated: false, hint: "GitHub CLI unavailable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!root || !gh?.authenticated) return;
    let cancelled = false;
    setLoading(true);
    api
      .prList(root)
      .then((rows) => {
        if (cancelled) return;
        setPrs(rows);
        setError(null);
      })
      .catch((problem: unknown) => {
        if (cancelled) return;
        setPrs([]);
        // A repository with no GitHub remote is not an error worth shouting
        // about — it is just a repository with no pull requests.
        const message = problem instanceof Error ? problem.message : String(problem);
        setError(/no git remote|not a git repository|could not determine/i.test(message) ? null : message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, gh?.authenticated, token]);

  if (gh && !gh.authenticated) {
    return (
      <div className="flex shrink-0 flex-col gap-0.5 px-3 py-2">
        <span className="text-[13px] text-[var(--muted)]">
          {gh.installed ? "Not signed in to GitHub" : "GitHub CLI not installed"}
        </span>
        <span className="text-[12px] text-[var(--faint)]">{gh.hint}</span>
      </div>
    );
  }

  const mine = prs?.find((pr) => pr.head === status?.branch) ?? null;

  return (
    <div className="flex shrink-0 flex-col">
      {error && (
        <div className="mx-2 mb-1 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] text-[var(--danger)]">
          {error}
        </div>
      )}

      {loading && prs === null && (
        <div className="px-3 py-2 text-[12px] text-[var(--faint)]">Asking GitHub…</div>
      )}

      {prs?.map((pr) => (
        <PrEntry
          key={pr.number}
          pr={pr}
          root={root}
          open={expanded === pr.number}
          onToggle={() => setExpanded(expanded === pr.number ? null : pr.number)}
          onMerged={() => {
            reload();
            onRefresh();
          }}
        />
      ))}

      {prs !== null && prs.length === 0 && !loading && (
        <div className="px-3 py-2 text-[12px] text-[var(--faint)]">No open pull requests</div>
      )}

      {/* The branch you are on has no PR yet: the one thing this section can
        do that the list can't show. */}
      {prs !== null && !mine && status?.branch && (
        <CreatePr
          root={root}
          branch={status.branch}
          open={creating}
          onOpen={() => setCreating(true)}
          onCancel={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function PrEntry({
  pr,
  root,
  open,
  onToggle,
  onMerged,
}: {
  pr: PullRequest;
  root: string;
  open: boolean;
  onToggle: () => void;
  onMerged: () => void;
}) {
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [methodOpen, setMethodOpen] = useState(false);

  useEffect(() => {
    if (!open || detail) return;
    let cancelled = false;
    api
      .prDetail(root, pr.number)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((problem: unknown) => {
        if (!cancelled) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, detail, root, pr.number]);

  const merge = async () => {
    setMerging(true);
    try {
      await api.prMerge(root, pr.number, method);
      setError(null);
      onMerged();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setMerging(false);
    }
  };

  const failing = detail?.checks.some((check) => check.bucket === "fail") ?? false;
  const pending = detail?.checks.some((check) => check.bucket === "pending") ?? false;
  const conflicting = detail?.mergeable === "CONFLICTING";

  return (
    <div className="flex flex-col">
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") onToggle();
        }}
        className="group flex w-full cursor-pointer items-center gap-1.5 px-2 py-1.5 hover:bg-[var(--hover)]"
      >
        {open ? (
          <ChevronDown size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        ) : (
          <ChevronRight size={13} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
        )}
        <GitPullRequest
          size={14}
          strokeWidth={2}
          className="shrink-0"
          color={pr.draft ? "var(--faint)" : "var(--diff-add-fg)"}
        />
        <span className="min-w-0 flex-1 truncate text-[14px] text-[var(--ink)]">{pr.title}</span>
        <span className="shrink-0 text-[12px] text-[var(--faint)] tabular-nums">#{pr.number}</span>
      </div>

      {open && (
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          <div className="flex items-center gap-1.5 text-[12px] text-[var(--faint)]">
            <span className="min-w-0 truncate">
              {pr.author && `${pr.author} · `}
              {pr.head} → {pr.base}
              {pr.draft && " · draft"}
            </span>
            <button
              type="button"
              title="Open on GitHub"
              onClick={() => void api.openUrl(pr.url).catch(() => {})}
              className="shrink-0 cursor-pointer rounded-md p-1 hover:bg-[var(--hover)] hover:text-[var(--ink)]"
            >
              <ExternalLink size={12} strokeWidth={2} />
            </button>
          </div>

          {error && <span className="text-[12px] text-[var(--danger)]">{error}</span>}
          {!detail && !error && (
            <span className="text-[12px] text-[var(--faint)]">Loading…</span>
          )}

          {detail && (
            <>
              {detail.checks.length > 0 && (
                <Group label="Checks">
                  {detail.checks.map((check, index) => (
                    <CheckRow key={index} check={check} />
                  ))}
                </Group>
              )}

              {detail.commits.length > 0 && (
                <Group label={`Commits (${detail.commits.length})`}>
                  {detail.commits.map((commit) => (
                    <div key={commit.sha} className="flex items-baseline gap-2 py-[2px]">
                      <span className="shrink-0 font-mono text-[11px] text-[var(--faint)]">
                        {commit.sha}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--muted)]">
                        {commit.message}
                      </span>
                    </div>
                  ))}
                </Group>
              )}

              {detail.files.length > 0 && (
                <Group label={`Files (${detail.files.length})`}>
                  {detail.files.map((file) => {
                    const { filename, directory } = splitPath(file.path);
                    return (
                      <div key={file.path} className="flex items-center gap-1.5 py-[2px]">
                        <FileIcon name={filename} size={13} />
                        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--muted)]">
                          {filename}
                          {directory && (
                            <span className="ml-1.5 text-[11px] text-[var(--faint)]">
                              {directory}
                            </span>
                          )}
                        </span>
                        <DiffLineStats
                          additions={file.additions}
                          deletions={file.deletions}
                        />
                      </div>
                    );
                  })}
                </Group>
              )}

              {detail.comments.length > 0 && (
                <Group label={`Comments (${detail.comments.length})`}>
                  {detail.comments.map((comment, index) => (
                    <div key={index} className="flex flex-col gap-0.5 py-1">
                      <span className="text-[11.5px] text-[var(--faint)]">{comment.author}</span>
                      <span className="line-clamp-3 text-[12.5px] whitespace-pre-wrap text-[var(--muted)]">
                        {comment.body}
                      </span>
                    </div>
                  ))}
                </Group>
              )}

              {/* The merge footer says what would stop it before offering it,
                because "Merge" failing after the fact is the worst way to
                learn a check is red. */}
              <div className="flex items-center gap-1.5 pt-0.5">
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--faint)]">
                  {conflicting
                    ? "Has conflicts"
                    : failing
                      ? "Checks failing"
                      : pending
                        ? "Checks running"
                        : detail.reviewDecision === "CHANGES_REQUESTED"
                          ? "Changes requested"
                          : "Ready to merge"}
                </span>
                <div className="relative flex shrink-0 items-stretch gap-px">
                  <button
                    type="button"
                    disabled={merging || conflicting}
                    onClick={() => void merge()}
                    className="flex cursor-pointer items-center gap-1 rounded-l-full bg-[rgba(255,255,255,0.1)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
                  >
                    {merging ? (
                      <Loader2 size={11} strokeWidth={2} className="animate-spin" />
                    ) : (
                      <GitMerge size={11} strokeWidth={2} />
                    )}
                    {method === "squash" ? "Squash & merge" : method === "rebase" ? "Rebase & merge" : "Merge"}
                  </button>
                  <button
                    type="button"
                    title="Choose how to merge"
                    disabled={merging}
                    onClick={() => setMethodOpen((open) => !open)}
                    className="cursor-pointer rounded-r-full bg-[rgba(255,255,255,0.1)] px-1.5 text-[var(--ink)] hover:opacity-85"
                  >
                    <ChevronDown size={11} strokeWidth={2.4} />
                  </button>
                  {methodOpen && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setMethodOpen(false)} />
                      <div className="menu menu-pop-up absolute right-0 bottom-full z-50 mb-1.5 flex w-[176px] flex-col overflow-hidden rounded-xl p-1.5 text-[12.5px]">
                        {(["squash", "merge", "rebase"] as MergeMethod[]).map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => {
                              setMethod(option);
                              setMethodOpen(false);
                            }}
                            className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
                          >
                            <span className="min-w-0 flex-1 truncate">
                              {option === "squash"
                                ? "Squash & merge"
                                : option === "merge"
                                  ? "Create a merge commit"
                                  : "Rebase & merge"}
                            </span>
                            {method === option && (
                              <Check size={12} strokeWidth={2} className="shrink-0" />
                            )}
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col">
      <span className="pb-0.5 text-[10.5px] font-semibold tracking-[0.07em] text-[var(--faint)] uppercase">
        {label}
      </span>
      {children}
    </div>
  );
}

function CheckRow({ check }: { check: PrCheck }) {
  const icon =
    check.bucket === "pass" ? (
      <CheckCircle2 size={13} strokeWidth={2} color="var(--diff-add-fg)" />
    ) : check.bucket === "fail" ? (
      <XCircle size={13} strokeWidth={2} color="var(--diff-del-fg)" />
    ) : check.bucket === "skipped" ? (
      <MinusCircle size={13} strokeWidth={2} color="var(--faint)" />
    ) : (
      <CircleDot size={13} strokeWidth={2} color="var(--diff-mod-fg)" />
    );

  return (
    <div className="flex items-center gap-1.5 py-[2px]">
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--muted)]">
        {check.name}
      </span>
      {check.url && (
        <button
          type="button"
          title="Open this check"
          onClick={() => void api.openUrl(check.url as string).catch(() => {})}
          className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        >
          <ExternalLink size={11} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}

/** Opening a pull request for the branch you are on. `gh` pushes the branch
 * itself if it has no upstream yet, so this works from a branch that has never
 * left the machine. */
function CreatePr({
  root,
  branch,
  open,
  onOpen,
  onCancel,
  onCreated,
}: {
  root: string;
  branch: string;
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        className="mx-2 my-1 flex cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-[12.5px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      >
        <GitPullRequest size={13} strokeWidth={2} />
        Create pull request from {branch}
      </button>
    );
  }

  const create = async () => {
    setBusy(true);
    try {
      await api.prCreate(root, title.trim(), body.trim(), draft);
      setTitle("");
      setBody("");
      setError(null);
      onCreated();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-2 my-1 flex flex-col gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--card)] p-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Pull request title"
        disabled={busy}
        className="w-full rounded-md bg-[rgba(255,255,255,0.05)] px-2 py-1.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="Description"
        rows={3}
        disabled={busy}
        className="w-full resize-none rounded-md bg-[rgba(255,255,255,0.05)] px-2 py-1.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
      />
      {error && <span className="text-[12px] text-[var(--danger)]">{error}</span>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setDraft(!draft)}
          className="flex cursor-pointer items-center gap-1.5 text-[12px] text-[var(--muted)] hover:text-[var(--ink)]"
        >
          <span
            className={`flex size-[13px] items-center justify-center rounded-[4px] border ${
              draft
                ? "border-transparent bg-[var(--toggle-on)] text-[var(--toggle-knob)]"
                : "border-[var(--faint)]"
            }`}
          >
            {draft && <Check size={10} strokeWidth={3} />}
          </span>
          Draft
        </button>
        <div className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="cursor-pointer rounded-full px-2 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy || !title.trim()}
          className="flex cursor-pointer items-center gap-1 rounded-full bg-[#f2f2f5] px-3 py-0.5 text-[12px] text-[#0c0c0e] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
        >
          {busy && <Loader2 size={11} strokeWidth={2} className="animate-spin" />}
          Create
        </button>
      </div>
    </div>
  );
}
