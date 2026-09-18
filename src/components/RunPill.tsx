import { GitBranch, Play } from "lucide-react";
import { useEffect, useState } from "react";
import { detectRunCommand, type RunCommand } from "../lib/runCommand";
import type { WorktreeInfo } from "../lib/types";
import { useEgant } from "../store";
import { queueTerminalCommand } from "./TerminalPane";

/** What a finished task offers next when the project says how to run itself.
 *
 * A pill under the reply — "Run website · npm run dev" — that opens a shell
 * in the session's own directory (the worktree, when the session has one)
 * and types the command for you. Worktree sessions are exactly where this
 * earns its keep: the work isn't in the folder you opened, and without the
 * branch on screen it's easy to run the wrong checkout in your own terminal.
 */
export function RunPill({ cwd, worktree }: { cwd: string; worktree: WorktreeInfo | null }) {
  const openTerminalTab = useEgant((s) => s.openTerminalTab);
  const [run, setRun] = useState<RunCommand | null>(null);

  useEffect(() => {
    let alive = true;
    setRun(null);
    if (!cwd) return;
    void detectRunCommand(cwd).then((found) => {
      if (alive) setRun(found);
    });
    return () => {
      alive = false;
    };
  }, [cwd]);

  if (!run) return null;

  const where = worktree ? ` in ${worktree.name} on ${worktree.branch}` : "";

  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <button
        type="button"
        title={`Run \`${run.command}\`${where} — opens a terminal${worktree ? " in this worktree" : ""} and runs it`}
        onClick={() => {
          const tabId = openTerminalTab(cwd);
          queueTerminalCommand(tabId, run.command);
        }}
        className="flex cursor-pointer items-center gap-2 rounded-full bg-[#f2f2f5] py-1.5 pr-3.5 pl-3 text-xs text-[#0c0c0e] hover:opacity-85"
      >
        <Play size={13} strokeWidth={2.5} fill="currentColor" className="shrink-0" />
        <span className="font-medium">{run.label}</span>
        <span className="font-mono opacity-60">{run.command}</span>
      </button>
      {worktree && (
        <span
          title={`This session runs in its own checkout at ${worktree.path}`}
          className="flex min-w-0 items-center gap-1 text-[11px] text-[var(--faint)]"
        >
          <GitBranch size={11} strokeWidth={2} className="shrink-0" />
          <span className="max-w-[220px] truncate">
            {worktree.name} · {worktree.branch}
          </span>
        </span>
      )}
    </div>
  );
}
