import { ask } from "@tauri-apps/plugin-dialog";
import { MessageSquare, TerminalSquare, X } from "lucide-react";
import { dropDraft, useDirtyFiles } from "../lib/editorDrafts";
import type { StageTab } from "../store";
import { CHAT_TAB, diffGroupSuffix, useEgant } from "../store";
import { ChangeStatusIcon } from "./ChangeStatus";
import { FileIcon } from "./FileIcon";

/** Stable empty list: a fresh `[]` per render would make the store's snapshot
 * a new value every time. */
const NO_TABS: StageTab[] = [];

/** The strip above the stage: the conversation, then whatever files and diffs
 * are open beside it. It appears only once something is opened — with nothing
 * but the chat there is nothing to switch between, and a tab strip naming one
 * thing is the window saying it twice. */
export function StageTabs({ sessionKey }: { sessionKey: number }) {
  const tabs = useEgant((s) => s.stageTabs[sessionKey] ?? NO_TABS);
  const showing = useEgant((s) => s.stageTab[sessionKey] ?? CHAT_TAB);
  const setStageTab = useEgant((s) => s.setStageTab);
  const closeStageTab = useEgant((s) => s.closeStageTab);
  const session = useEgant((s) =>
    s.snapshot?.sessions.find((entry) => entry.id === sessionKey),
  );
  const title = session?.title;
  const dirtyPaths = useDirtyFiles((s) => s.paths);

  if (tabs.length === 0) return null;

  // Closing a file with edits that never reached the disk asks first. With
  // Autosave on there is normally nothing to ask about — the editor writes on
  // its way out — but a save that was refused (the file changed on disk) leaves
  // the tab dirty, and that is exactly when losing it would hurt.
  const close = async (tab: StageTab) => {
    if (tab.kind === "file" && dirtyPaths[tab.path]) {
      const discard = await ask(`${tab.name} has unsaved changes.`, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard changes",
        cancelLabel: "Keep editing",
      });
      if (!discard) return;
      dropDraft(tab.path);
    }
    closeStageTab(sessionKey, tab.key);
  };

  return (
    <div className="flex w-full shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--border)] px-3 pb-1.5">
      <Tab
        // The first tab is whatever the session *is* — a transcript for a
        // chat session, the agent's terminal for a CLI one.
        icon={
          session?.kind === "cli" ? (
            <TerminalSquare size={12} strokeWidth={2} />
          ) : (
            <MessageSquare size={12} strokeWidth={2} />
          )
        }
        label={title ?? "Chat"}
        active={showing === CHAT_TAB}
        onClick={() => setStageTab(sessionKey, CHAT_TAB)}
      />
      {tabs.map((tab) => (
        <Tab
          key={tab.key}
          icon={<FileIcon name={tab.name} size={14} />}
          label={tab.name}
          // Which side of git this diff is — the same file can be open twice,
          // once against the index and once against HEAD.
          suffix={tab.group ? diffGroupSuffix(tab.group) : undefined}
          status={
            tab.status ? <ChangeStatusIcon status={tab.status} size={13} /> : undefined
          }
          hint={tab.group ? `${tab.path} ${diffGroupSuffix(tab.group)}` : tab.path}
          dirty={tab.kind === "file" && !!dirtyPaths[tab.path]}
          active={showing === tab.key}
          onClick={() => setStageTab(sessionKey, tab.key)}
          onClose={() => void close(tab)}
        />
      ))}
    </div>
  );
}

function Tab({
  icon,
  label,
  suffix,
  status,
  hint,
  dirty,
  active,
  onClick,
  onClose,
}: {
  icon: React.ReactNode;
  label: string;
  suffix?: string;
  status?: React.ReactNode;
  hint?: string;
  /** The file has edits that are not on disk yet. */
  dirty?: boolean;
  active: boolean;
  onClick: () => void;
  onClose?: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      title={hint ?? label}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onClick();
      }}
      // Middle-click closes, the way every tab strip does.
      onAuxClick={(e) => {
        if (e.button === 1 && onClose) {
          e.preventDefault();
          onClose();
        }
      }}
      className={`group flex max-w-[230px] min-w-0 shrink-0 cursor-pointer items-center gap-1.5 rounded-md py-1 pr-1 pl-2 text-[12px] ${
        active
          ? "bg-[var(--selected)] text-[var(--ink)]"
          : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
      }`}
    >
      <span className="flex shrink-0 items-center text-[var(--faint)]">{icon}</span>
      <span className="min-w-0 flex-1 truncate">
        {label}
        {suffix && <span className="ml-1 text-[11px] text-[var(--faint)]">{suffix}</span>}
      </span>
      {/* The status gives way to the close button on hover rather than sitting
        beside it, which would make the tab wider the moment you point at it. */}
      {status && <span className="shrink-0 group-hover:hidden">{status}</span>}
      {/* Same slot as the status, and the same give-way to the close button. */}
      {dirty && (
        <span
          title="Unsaved changes"
          className="mx-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--muted)] group-hover:hidden"
        />
      )}
      {onClose && (
        <button
          type="button"
          title="Close tab"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          className={`shrink-0 cursor-pointer rounded-sm p-0.5 hover:bg-[var(--hover)] hover:text-[var(--ink)] ${
            status || dirty ? "hidden group-hover:block" : "opacity-0 group-hover:opacity-100"
          }`}
        >
          <X size={10} strokeWidth={2.2} />
        </button>
      )}
    </div>
  );
}
