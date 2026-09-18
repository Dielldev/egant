import { AlertTriangle, Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { ConflictBlock, ConflictSide, ConflictStatus, UnmergedKind } from "../lib/types";
import type { StageTab } from "../store";
import { useEgant } from "../store";

/** What each unmerged-file combination means, for the toolbar's file list. */
function kindLabel(kind: UnmergedKind): string {
  switch (kind) {
    case "bothModified":
      return "both sides edited it";
    case "bothAdded":
      return "both sides added it";
    case "bothDeleted":
      return "both sides deleted it";
    case "addedByUs":
      return "you added it, they didn't";
    case "addedByThem":
      return "they added it, you didn't";
    case "deletedByUs":
      return "you deleted it, they edited it";
    case "deletedByThem":
      return "they deleted it, you edited it";
  }
}

/** The global "Conflict Resolution Toolbar": shows itself whenever a
 * merge/rebase is stalled, or unmerged files are sitting in the index without
 * one (e.g. left behind by a `stash pop` that collided).
 *
 * `onOpenFile` hands off to whatever already opens a diff tab — the toolbar
 * doesn't know about the stage, only about paths — and `onResolved` is the
 * same re-read the panel's other git actions trigger, so the Changes list
 * catches up the moment a file stops being conflicted. */
export function ConflictToolbar({
  root,
  token,
  onOpenFile,
  onResolved,
}: {
  root: string;
  /** Bumped by the same signal that tells the rest of the panel to re-read —
   * a turn ending, a stage/commit, another action here. */
  token: number;
  onOpenFile: (path: string) => void;
  onResolved: () => void;
}) {
  const [status, setStatus] = useState<ConflictStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmingAbort, setConfirmingAbort] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!root) return;
    api
      .conflictStatus(root)
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [root]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, token]);

  const runAction = useCallback(
    async (name: string, action: () => Promise<unknown>) => {
      setBusy(name);
      setError(null);
      try {
        await action();
        onResolved();
        reload();
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      } finally {
        setBusy(null);
        setConfirmingAbort(false);
      }
    },
    [onResolved, reload],
  );

  if (!status || (status.operation === "none" && status.files.length === 0)) return null;

  const canContinue = status.files.length === 0 && status.operation !== "none";
  const verb = status.operation === "rebase" ? "Rebase" : status.operation === "merge" ? "Merge" : "Merge";

  return (
    <div className="mx-2 mb-1.5 flex shrink-0 flex-col gap-2 rounded-lg border border-[rgba(224,144,76,0.35)] bg-[rgba(224,144,76,0.08)] px-2.5 py-2">
      <div className="flex items-center gap-2">
        <AlertTriangle size={13} strokeWidth={2} className="shrink-0 text-[var(--diff-conflict-fg)]" />
        <span className="min-w-0 flex-1 text-[12.5px] leading-snug text-[var(--ink)]">
          {status.operation === "none"
            ? `${status.files.length} unresolved conflict${status.files.length === 1 ? "" : "s"}`
            : `${verb} stopped on ${status.files.length} conflict${status.files.length === 1 ? "" : "s"}`}
          {status.files.length > 0 && " — resolve each file below, then continue."}
        </span>
      </div>

      {status.files.length > 0 && (
        <div className="flex flex-col gap-0.5 rounded-md bg-[var(--card)] p-1">
          {status.files.map((file) => (
            <div key={file.path} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-[var(--hover)]">
              <button
                type="button"
                onClick={() => onOpenFile(file.path)}
                title={kindLabel(file.kind)}
                className="min-w-0 flex-1 cursor-pointer truncate text-left text-[12px] text-[var(--ink)] hover:underline"
              >
                {file.path}
              </button>
              <span className="hidden shrink-0 text-[11px] text-[var(--faint)] sm:inline">
                {kindLabel(file.kind)}
              </span>
              <ToolbarPill
                label="Ours"
                busy={busy === `ours:${file.path}`}
                disabled={busy !== null}
                onClick={() =>
                  runAction(`ours:${file.path}`, () => api.resolveConflictFile(root, file.path, "ours"))
                }
              />
              <ToolbarPill
                label="Theirs"
                busy={busy === `theirs:${file.path}`}
                disabled={busy !== null}
                onClick={() =>
                  runAction(`theirs:${file.path}`, () => api.resolveConflictFile(root, file.path, "theirs"))
                }
              />
            </div>
          ))}
        </div>
      )}

      {error && <span className="text-[11.5px] whitespace-pre-line text-[var(--danger)]">{error}</span>}

      {confirmingAbort ? (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <span className="mr-auto text-[12px] text-[var(--ink)]">
            Abort the {status.operation === "none" ? "resolution" : status.operation}? This discards every
            change you&apos;ve made to resolve it.
          </span>
          <button
            type="button"
            onClick={() => setConfirmingAbort(false)}
            className="cursor-pointer rounded-full px-2 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => runAction("abort", () => api.abortConflictOperation(root))}
            className="flex cursor-pointer items-center gap-1 rounded-full bg-[var(--danger)] px-2.5 py-0.5 text-[12px] text-white hover:opacity-85 disabled:cursor-default disabled:opacity-40"
          >
            {busy === "abort" && <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />}
            Abort &amp; Reset
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <button
            type="button"
            disabled={busy !== null || status.operation === "none"}
            title={status.operation === "none" ? "Nothing in progress to abort" : undefined}
            onClick={() => setConfirmingAbort(true)}
            className="cursor-pointer rounded-full px-2.5 py-0.5 text-[12px] text-[var(--danger)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40"
          >
            Abort &amp; Reset
          </button>
          <button
            type="button"
            disabled={busy !== null || status.files.length === 0}
            title="Accept every local (--ours) block, stage the files, and continue"
            onClick={() => runAction("keep-local", () => api.resolveAllConflicts(root, "ours"))}
            className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
          >
            {busy === "keep-local" && <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />}
            Keep All Local Changes
          </button>
          <button
            type="button"
            disabled={busy !== null || status.files.length === 0}
            title="Accept every incoming (--theirs) block, stage the files, and continue"
            onClick={() => runAction("accept-incoming", () => api.resolveAllConflicts(root, "theirs"))}
            className="flex cursor-pointer items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
          >
            {busy === "accept-incoming" && <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />}
            Accept All Incoming Changes
          </button>
          <button
            type="button"
            disabled={busy !== null || !canContinue}
            title={canContinue ? undefined : "Resolve every file before continuing"}
            onClick={() => runAction("continue", () => api.continueConflictOperation(root))}
            className="flex cursor-pointer items-center gap-1 rounded-full bg-[var(--bubble)] px-2.5 py-0.5 text-[12px] text-[var(--ink)] hover:opacity-85 disabled:cursor-default disabled:opacity-40"
          >
            {busy === "continue" ? (
              <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />
            ) : (
              <Check size={11} strokeWidth={2.2} />
            )}
            Continue
          </button>
        </div>
      )}
    </div>
  );
}

function ToolbarPill({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 cursor-pointer rounded px-1.5 py-0.5 text-[11px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
    >
      {busy ? <Loader2 size={11} strokeWidth={2.2} className="animate-spin" /> : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Inline per-file conflict view
// ---------------------------------------------------------------------------

type Segment =
  | { kind: "context"; lines: string[] }
  | { kind: "conflict"; block: ConflictBlock };

/** Splits a file's text into runs of ordinary lines and conflict blocks,
 * using the same 0-indexed, no-trailing-newline line numbering the backend's
 * `parse_markers` reports — so a block's start/end line always lines up with
 * where `text.split("\n")` puts it. */
function segmentsOf(text: string, blocks: ConflictBlock[]): Segment[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  const segments: Segment[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.startLine > cursor) {
      segments.push({ kind: "context", lines: lines.slice(cursor, block.startLine) });
    }
    segments.push({ kind: "conflict", block });
    cursor = block.endLine + 1;
  }
  if (cursor < lines.length) {
    segments.push({ kind: "context", lines: lines.slice(cursor) });
  }
  return segments;
}

/** The file view a conflicted diff tab opens onto, in place of the ordinary
 * diff: the file's raw text, with every `<<<<<<<`/`=======`/`>>>>>>>` region
 * drawn as two labeled panes and a floating "Accept Current / Accept Incoming
 * / Accept Both" action row above them — the CodeLens-style quick actions the
 * toolbar's per-file buttons resolve a whole file at once, and these resolve
 * one block at a time. */
export function ConflictFileView({ tab }: { tab: StageTab }) {
  const root = tab.root ?? "";
  const [text, setText] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<ConflictBlock[] | null>(null);
  const [kind, setKind] = useState<UnmergedKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const refreshChanges = useEgant((s) => s.refreshChanges);
  const changesToken = useEgant((s) => s.changesToken);

  const reload = useCallback(() => {
    if (!root) return;
    setError(null);
    Promise.all([
      api.blobText(root, tab.path, "workdir"),
      api.conflictBlocks(root, tab.path),
      api.conflictStatus(root),
    ])
      .then(([fileText, fileBlocks, status]) => {
        setText(fileText ?? "");
        setBlocks(fileBlocks);
        setKind(status.files.find((file) => file.path === tab.path)?.kind ?? null);
      })
      .catch((problem: unknown) => {
        setError(problem instanceof Error ? problem.message : String(problem));
      });
  }, [root, tab.path]);

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, changesToken]);

  const resolveWhole = async (side: ConflictSide) => {
    setBusy("file");
    setError(null);
    try {
      await api.resolveConflictFile(root, tab.path, side);
      refreshChanges();
      reload();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(null);
    }
  };

  const resolveBlock = async (index: number, side: ConflictSide) => {
    setBusy(`block:${index}`);
    setError(null);
    try {
      await api.resolveConflictBlock(root, tab.path, index, side);
      refreshChanges();
      reload();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    } finally {
      setBusy(null);
    }
  };

  if (text === null || blocks === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6">
        <span className={`text-xs ${error ? "text-[var(--danger)]" : "text-[var(--faint)]"}`}>
          {error ?? "Reading…"}
        </span>
      </div>
    );
  }

  const hasMarkers = blocks.length > 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-[38px] shrink-0 items-center justify-between gap-2 border-b border-[var(--border)] px-4">
        <span className="flex min-w-0 items-center gap-1.5 truncate text-[11px] font-semibold tracking-[0.08em] text-[var(--faint)] uppercase">
          <AlertTriangle size={12} strokeWidth={2} className="shrink-0 text-[var(--diff-conflict-fg)]" />
          Conflict — {tab.name}
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <FileActionButton
            label="Accept Current"
            busy={busy === "file"}
            disabled={busy !== null}
            onClick={() => resolveWhole("ours")}
          />
          <FileActionButton
            label="Accept Incoming"
            busy={busy === "file"}
            disabled={busy !== null}
            onClick={() => resolveWhole("theirs")}
          />
          {hasMarkers && (
            <FileActionButton
              label="Accept Both"
              busy={busy === "file"}
              disabled={busy !== null}
              onClick={() => resolveWhole("both")}
            />
          )}
        </div>
      </div>

      {error && (
        <div className="mx-3 mt-2 shrink-0 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[12px] whitespace-pre-line text-[var(--danger)]">
          {error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-[13px] leading-[1.5]">
        {!hasMarkers ? (
          <div className="flex flex-col gap-3 px-1 py-4">
            <span className="text-[12.5px] text-[var(--muted)]">
              No merge markers in this file —{" "}
              {kind ? kindLabel(kind) : "one side changed it, the other deleted it"}. Choose the side to
              keep above.
            </span>
            <pre className="whitespace-pre-wrap break-words text-[var(--ink)]">{text}</pre>
          </div>
        ) : (
          segmentsOf(text, blocks).map((segment, index) =>
            segment.kind === "context" ? (
              <pre key={index} className="whitespace-pre-wrap break-words text-[var(--ink)]">
                {segment.lines.join("\n")}
              </pre>
            ) : (
              <ConflictBlockCard
                key={index}
                block={segment.block}
                busy={busy === `block:${segment.block.index}`}
                disabled={busy !== null}
                onResolve={(side) => resolveBlock(segment.block.index, side)}
              />
            ),
          )
        )}
      </div>
    </div>
  );
}

function FileActionButton({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex cursor-pointer items-center gap-1 rounded-md bg-[var(--card)] px-2 py-1 text-[11.5px] text-[var(--ink)] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-40"
    >
      {busy && <Loader2 size={11} strokeWidth={2.2} className="animate-spin" />}
      {label}
    </button>
  );
}

/** One conflict block: the CodeLens-style quick-action row, then the two
 * sides stacked so their difference reads the way a person would scan it —
 * current on top, since it's the one already on disk. */
function ConflictBlockCard({
  block,
  busy,
  disabled,
  onResolve,
}: {
  block: ConflictBlock;
  busy: boolean;
  disabled: boolean;
  onResolve: (side: ConflictSide) => void;
}) {
  return (
    <div className="my-2 overflow-hidden rounded-md border border-[rgba(224,144,76,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-2 bg-[rgba(224,144,76,0.12)] px-2 py-1">
        <span className="text-[11px] text-[var(--diff-conflict-fg)]">Conflict</span>
        <div className="flex items-center gap-1">
          <BlockActionPill label="Accept Current" busy={busy} disabled={disabled} onClick={() => onResolve("ours")} />
          <BlockActionPill
            label="Accept Incoming"
            busy={busy}
            disabled={disabled}
            onClick={() => onResolve("theirs")}
          />
          <BlockActionPill label="Accept Both" busy={busy} disabled={disabled} onClick={() => onResolve("both")} />
        </div>
      </div>
      <div className="bg-[rgba(80,200,120,0.06)] px-2 py-0.5 text-[10.5px] text-[var(--diff-add-fg)]">
        Current — {block.oursLabel || "HEAD"}
      </div>
      <pre className="whitespace-pre-wrap break-words bg-[rgba(80,200,120,0.04)] px-2 py-1 text-[var(--ink)]">
        {block.ours.length > 0 ? block.ours : " "}
      </pre>
      <div className="bg-[rgba(224,112,112,0.06)] px-2 py-0.5 text-[10.5px] text-[var(--diff-del-fg)]">
        Incoming — {block.theirsLabel || "merge"}
      </div>
      <pre className="whitespace-pre-wrap break-words bg-[rgba(224,112,112,0.04)] px-2 py-1 text-[var(--ink)]">
        {block.theirs.length > 0 ? block.theirs : " "}
      </pre>
    </div>
  );
}

function BlockActionPill({
  label,
  busy,
  disabled,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded px-1.5 py-0.5 text-[10.5px] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:cursor-default disabled:opacity-40"
    >
      {busy ? <Loader2 size={10} strokeWidth={2.2} className="animate-spin" /> : label}
    </button>
  );
}
