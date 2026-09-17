// The small pieces every settings section is built from — the card, the row
// inside it, the section header, the switch. They live here rather than in
// `SettingsPage` so a section can be its own file (`AgentsSettings`) without
// importing the page that renders it.

import { ArrowUpDown, Monitor } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { Dispatch, ReactNode, SetStateAction } from "react";

/** `useState` mirrored to localStorage, so sections keep their choices
 * across reopens. Objects merge with their defaults; primitives replace. */
export function usePersistentState<T>(
  key: string,
  initial: T,
): [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return initial;
      const parsed = JSON.parse(raw) as T;
      if (
        typeof initial === "object" &&
        initial !== null &&
        !Array.isArray(initial) &&
        typeof parsed === "object" &&
        parsed !== null
      ) {
        return { ...initial, ...parsed };
      }
      return parsed;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // Unavailable storage: the window keeps the in-memory choice.
    }
  }, [key, value]);
  return [value, setValue];
}

/** localStorage key behind Settings > Files > Editor font size. */
export const EDITOR_FONT_SIZE_KEY = "egant.files.fontSize";

/** Dispatched on `window` after this window saves a new editor font size —
 * `storage` events only fire in *other* documents, so without this an open
 * file viewer would keep the old size until reload. */
export const EDITOR_FONT_SIZE_EVENT = "egant:editor-font-size";

/** The saved editor font size in px. Parses what the settings pills wrote
 * (`"13"`), clamps hand-edited values into a sane range, and falls back to
 * the pills' default when nothing parseable is stored. */
export function readEditorFontSize(): number {
  try {
    const raw = localStorage.getItem(EDITOR_FONT_SIZE_KEY);
    const n = raw == null ? NaN : Number(JSON.parse(raw));
    if (Number.isFinite(n)) return Math.min(24, Math.max(8, n));
  } catch {
    // Corrupt or unavailable storage: fall through to the default.
  }
  return 13;
}

function subscribeEditorFontSize(onChange: () => void): () => void {
  window.addEventListener("storage", onChange);
  window.addEventListener(EDITOR_FONT_SIZE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EDITOR_FONT_SIZE_EVENT, onChange);
  };
}

/** The editor font size in px, live: file and diff viewers re-render on the
 * next paint after Settings saves a new one, here or in another window. */
export function useEditorFontSize(): number {
  return useSyncExternalStore(subscribeEditorFontSize, readEditorFontSize);
}

export function SectionHead({
  title,
  count,
  sub,
  right,
}: {
  title: string;
  count?: number | string;
  sub: string;
  right?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-6">
      <div className="min-w-0">
        <h1 className="text-[15px] font-semibold text-[var(--ink)]">
          {title}
          {count != null && (
            <span className="ml-2 text-[13px] font-normal text-[var(--faint)]">{count}</span>
          )}
        </h1>
        <p className="mt-1.5 max-w-[660px] text-[13px] leading-relaxed text-[var(--muted)]">
          {sub}
        </p>
      </div>
      {right && <div className="flex shrink-0 items-center gap-4 pt-0.5">{right}</div>}
    </div>
  );
}

export function Card({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--card)]">
      <div className="divide-y divide-[var(--border)]">{children}</div>
    </div>
  );
}

export function Row({
  icon: Icon,
  title,
  sub,
  control,
}: {
  icon: LucideIcon;
  title: ReactNode;
  sub?: ReactNode;
  control?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3.5 px-4 py-3.5">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--card)] text-[var(--muted)]">
        <Icon size={16} strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-[var(--ink)]">{title}</div>
        {sub && <div className="mt-0.5 text-[12px] leading-relaxed text-[var(--muted)]">{sub}</div>}
      </div>
      {control}
    </div>
  );
}

export function Toggle({
  on,
  onChange,
  disabled,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-on={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className="switch"
    />
  );
}

export function Pills<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`cursor-pointer rounded-lg border px-2.5 py-1 text-[12px] whitespace-nowrap ${
            o.value === value
              ? "border-[var(--accent)] text-[var(--ink)]"
              : "border-[var(--border)] text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The device chip in section headers: this machine, live, with nothing to
 * switch to — every session in the window is a local process. */
export function DevicePill({ name }: { name: string }) {
  return (
    <span className="flex items-center gap-1.5 text-[13px] text-[var(--ink)]">
      <Monitor size={14} strokeWidth={2} className="text-[var(--muted)]" />
      <span className="font-medium whitespace-nowrap">{name}</span>
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
      <ArrowUpDown size={12} strokeWidth={2} className="text-[var(--faint)]" />
    </span>
  );
}

/** The separator between facts on a row's second line. */
export function Dot() {
  return <span className="mx-1.5 text-[var(--faint)]">·</span>;
}

/** A `<select>` styled like the rest of settings, with its own chevron —
 * the native arrow is suppressed by `appearance-none`. */
export function Select({
  value,
  onChange,
  disabled,
  title,
  className = "",
  children,
}: {
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        disabled={disabled}
        title={title}
        onChange={(e) => onChange(e.target.value)}
        className={`cursor-pointer appearance-none truncate rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pr-8 pl-3 text-[12px] text-[var(--ink)] outline-none hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-50 [&>option]:bg-[#1a1a1f] ${className}`}
      >
        {children}
      </select>
      <ArrowUpDown
        size={12}
        className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2 text-[var(--faint)]"
      />
    </div>
  );
}
