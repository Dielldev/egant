import { ChevronDown } from "lucide-react";
import type { ReactNode } from "react";
import { SHORT_NAMES, fallbackName, variantLabel } from "@egant/lib/agents";
import { AgentGlyph } from "./bits";

/** The bar across the top: a button each side and the title between, truly
 * centred. `clear` has no bar at all (an empty new chat); otherwise it is
 * frosted stage, so a thread scrolls away beneath it. */
export function TopBar({
  clear,
  left,
  center,
  right,
}: {
  clear?: boolean;
  left?: ReactNode;
  center?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header
      className={`safe-top relative z-20 shrink-0 ${
        clear ? "" : "bar-glass border-b border-[var(--hairline)]"
      }`}
    >
      <div className="grid h-[54px] grid-cols-[52px_minmax(0,1fr)_52px] items-center px-1">
        <div className="flex justify-start">{left}</div>
        <div className="flex min-w-0 justify-center">{center}</div>
        <div className="flex justify-end">{right}</div>
      </div>
    </header>
  );
}

export function IconButton({
  label,
  onClick,
  children,
  badge,
  pressed,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
  /** A dot in the corner — something in the drawer needs you. */
  badge?: boolean;
  /** A toggle, and whether it is on. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`press relative flex h-11 w-11 items-center justify-center rounded-full text-[var(--ink)] active:bg-[var(--hover)] ${
        pressed ? "bg-[var(--raised-2)]" : ""
      }`}
    >
      {children}
      {badge && (
        <span className="absolute top-2 right-2 h-2.5 w-2.5 rounded-full border-2 border-[var(--stage)] bg-amber-400" />
      )}
    </button>
  );
}

/** Two strokes, the second shorter: the drawer. */
export function MenuIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M4 8.5h16M4 15.5h10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** The new chat's agent and model, as ChatGPT names its model up top — a tap
 * away from changing either. */
export function ModelTitle({
  agent,
  model,
  variant,
  onClick,
}: {
  agent: string;
  model: string;
  variant?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="press flex h-10 min-w-0 items-center gap-2 rounded-full px-3 text-[var(--ink)] active:bg-[var(--hover)]"
    >
      <AgentGlyph agent={agent} size={16} />
      <span className="shrink-0 text-[17px] font-semibold tracking-[-0.01em]">
        {SHORT_NAMES[agent] ?? fallbackName(agent)}
      </span>
      <span className="min-w-0 truncate text-[16px] text-[var(--muted)]">
        {model}
        {variant ? ` · ${variantLabel(variant)}` : ""}
      </span>
      <ChevronDown size={16} strokeWidth={2.4} className="shrink-0 text-[var(--faint)]" />
    </button>
  );
}

/** An open chat's title, with its agent and model under it. */
export function SessionTitle({
  title,
  agent,
  model,
  variant,
  onClick,
}: {
  title: string;
  agent: string;
  model: string;
  variant?: string | null;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="press flex min-w-0 max-w-full flex-col items-center rounded-2xl px-3 py-1 active:bg-[var(--hover)]"
    >
      <span className="max-w-full truncate text-[15px] leading-5 font-semibold text-[var(--ink)]">
        {title}
      </span>
      <span className="flex max-w-full min-w-0 items-center gap-1.5 text-[12.5px] leading-4 text-[var(--muted)]">
        <AgentGlyph agent={agent} size={11} />
        <span className="min-w-0 truncate">
          {model}
          {variant ? ` · ${variantLabel(variant)}` : ""}
        </span>
        {onClick && <ChevronDown size={12} strokeWidth={2.4} className="shrink-0 text-[var(--faint)]" />}
      </span>
    </button>
  );
}
