import {
  Blocks,
  ChevronLeft,
  ChevronRight,
  FolderPlus,
  FoldVertical,
  Paperclip,
  Plug,
  Plus,
  SquareSlash,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef } from "react";
import type { SessionInfo } from "../lib/types";
import { AGENT_ACCENT, AGENT_PROVIDER } from "./AgentPicker";
import { ProviderGlyph } from "./ProviderLogo";
import { formatModelTitle } from "./UsageSettings";

/** Which page of the menu is showing: the quick-navigation list, or the chats
 * to pass context from. */
export type PlusView = "root" | "context";

/** The "+" at the left of the composer: one place for everything that adds to
 * the message or jumps somewhere to set it up — files, a folder, a slash
 * command, context from another chat, and the Library's MCP servers and
 * skills. */
export function ComposerPlusMenu({
  view,
  onView,
  sessions,
  hasContext,
  align,
  onAddFiles,
  onAddFolder,
  onSlash,
  onPassContext,
  onOpenMcp,
  onOpenSkills,
}: {
  /** Null while closed. */
  view: PlusView | null;
  onView: (view: PlusView | null) => void;
  /** Chats context can be passed from — every session but this one. */
  sessions: SessionInfo[];
  hasContext: boolean;
  /** Which edge of the button the panel hangs from. In a conversation the
   * button is at the far left of the box and the panel grows rightward; on
   * the launch screen it is at the right end, so it must grow leftward. */
  align: "left" | "right";
  onAddFiles: () => void;
  onAddFolder: () => void;
  onSlash: () => void;
  onPassContext: (session: SessionInfo) => void;
  onOpenMcp: () => void;
  onOpenSkills: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const open = view != null;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onView(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Esc steps back out of the chat list before it closes the menu.
      onView(view === "context" ? "root" : null);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, view, onView]);

  /** Runs `action` and closes the menu — every row but the chat-list one. */
  const run = (action: () => void) => () => {
    onView(null);
    action();
  };

  return (
    <div className="relative" ref={rootRef}>
      <button
        type="button"
        title="Add files, context and more"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => onView(open ? null : "root")}
        className={`flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors ${
          open || hasContext
            ? "bg-[var(--hover)] text-[var(--ink)]"
            : "text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
        }`}
      >
        <Plus
          size={18}
          strokeWidth={2}
          className={`transition-transform duration-150 ${open ? "rotate-45" : ""}`}
        />
      </button>
      {open && (
        // `.menu` is the opaque raised panel the other popovers use; `--card`
        // is only a faint tint, so the composer text and wallpaper would show
        // straight through it.
        <div
          role="menu"
          className={`menu menu-pop-up absolute bottom-full z-50 mb-2 w-64 max-w-[calc(100vw-2rem)] rounded-xl p-1.5 text-[13px] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {view === "root" ? (
            <>
              <Row icon={Paperclip} label="Add files or photos" onClick={run(onAddFiles)} />
              <Row icon={FolderPlus} label="Add folder" onClick={run(onAddFolder)} />
              <Row icon={SquareSlash} label="Slash commands" onClick={run(onSlash)} />
              {sessions.length > 0 && (
                <Row
                  icon={FoldVertical}
                  label="Pass context"
                  detail={hasContext ? "attached" : undefined}
                  chevron
                  onClick={() => onView("context")}
                />
              )}
              <div className="my-1 h-px bg-[var(--border)]" />
              <Row icon={Plug} label="MCP servers" chevron onClick={run(onOpenMcp)} />
              <Row icon={Blocks} label="Skills" chevron onClick={run(onOpenSkills)} />
            </>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => onView("root")}
                className="flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[11px] font-semibold tracking-wider text-[var(--faint)] uppercase hover:bg-[var(--hover)]"
              >
                <ChevronLeft size={13} strokeWidth={2.2} />
                Pass context from
              </button>
              <div className="max-h-64 overflow-y-auto">
                {sessions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="menuitem"
                    onClick={run(() => onPassContext(s))}
                    className="group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-[var(--hover)]"
                  >
                    <ProviderGlyph
                      provider={AGENT_PROVIDER[s.agent] ?? s.agent}
                      size={15}
                      color={AGENT_ACCENT[s.agent]}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-[var(--ink)] group-hover:text-[var(--accent)]">
                        {s.title}
                      </div>
                      <div className="truncate text-[10px] text-[var(--muted)]">
                        {formatModelTitle(s.modelOverride || s.model || s.agent)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  detail,
  chevron,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  detail?: string;
  chevron?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[var(--ink)] transition-colors hover:bg-[var(--hover)]"
    >
      <Icon size={16} strokeWidth={1.8} className="shrink-0 text-[var(--muted)]" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && <span className="shrink-0 text-[11px] text-[var(--accent)]">{detail}</span>}
      {chevron && <ChevronRight size={14} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />}
    </button>
  );
}
