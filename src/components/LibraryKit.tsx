// Pieces the Library's MCP and Skills tabs share: the right-hand sheet, the
// agent checklist every sync goes through, and the small controls around
// them. Styled after Settings > Agents, which the Library sits beside.

import { AlertTriangle, Check, Search, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useEgant } from "../store";
import { ProviderLogo } from "./ProviderLogo";

/** Agent id → the vendor its logo is drawn from, out of the install
 * catalog Settings > Agents already loads. */
export function useVendorOf(): (agentId: string) => string {
  const catalog = useEgant((s) => s.catalog);
  const fetchCatalog = useEgant((s) => s.fetchCatalog);
  useEffect(() => {
    if (catalog.length === 0) void fetchCatalog();
  }, [catalog.length, fetchCatalog]);
  return (agentId) => catalog.find((c) => c.id === agentId)?.vendor ?? agentId;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The drawer a card opens. `Esc` closes it, captured so it doesn't also
 * close the Library behind it (App listens at bubble phase). */
export function Sheet({
  eyebrow,
  onClose,
  children,
  footer,
}: {
  eyebrow: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[90] flex justify-end" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="menu relative m-3 flex w-full max-w-[580px] flex-col overflow-hidden rounded-2xl">
        <div className="flex shrink-0 items-center justify-between px-5 pt-4 pb-1">
          <span className="text-[12px] text-[var(--muted)]">{eyebrow}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="cursor-pointer rounded-md p-1 text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--ink)]"
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 pt-3 pb-6">
          {children}
        </div>
        {footer && (
          <div className="flex shrink-0 items-center gap-2 border-t border-[var(--border)] px-5 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

export interface ChecklistAgent {
  id: string;
  name: string;
  /** The second line: where it writes. */
  detail: string;
  /** Not on this machine — shown, but can't be ticked. */
  unavailable?: boolean;
  /** Can't be changed, with the reason (a config egant won't rewrite). */
  lockedReason?: string | null;
}

/** Which agents a server or skill goes to. Agents not on this machine fold
 * away behind a toggle so the list stays about the ones that matter. */
export function AgentChecklist({
  agents,
  selected,
  onChange,
}: {
  agents: ChecklistAgent[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const vendorOf = useVendorOf();
  const [showAll, setShowAll] = useState(false);
  const here = agents.filter((a) => !a.unavailable);
  const missing = agents.filter((a) => a.unavailable);
  const rows = showAll ? agents : here;
  const toggle = (id: string) =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  const pickable = here.filter((a) => !a.lockedReason);
  const allOn = pickable.length > 0 && pickable.every((a) => selected.includes(a.id));

  return (
    <section>
      <div className="mb-2 flex items-center">
        <h3 className="text-[13px] text-[var(--muted)]">Sync to agents</h3>
        {pickable.length > 1 && (
          <button
            type="button"
            onClick={() =>
              onChange(
                allOn
                  ? selected.filter((id) => !pickable.some((a) => a.id === id))
                  : [...new Set([...selected, ...pickable.map((a) => a.id)])],
              )
            }
            className="ml-auto cursor-pointer text-[12px] text-[var(--faint)] hover:text-[var(--ink)]"
          >
            {allOn ? "Select none" : "Select all"}
          </button>
        )}
      </div>
      <div className="divide-y divide-[var(--border)] overflow-hidden rounded-xl border border-[var(--border)]">
        {rows.map((agent) => {
          const on = selected.includes(agent.id);
          const disabled = agent.unavailable || !!agent.lockedReason;
          return (
            <button
              key={agent.id}
              type="button"
              disabled={disabled}
              onClick={() => toggle(agent.id)}
              className="flex w-full cursor-pointer items-center gap-3 px-3.5 py-2.5 text-left hover:bg-[var(--hover)] disabled:cursor-default disabled:hover:bg-transparent"
            >
              <span className={disabled && !on ? "opacity-45" : ""}>
                <ProviderLogo provider={vendorOf(agent.id)} size={24} />
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={`block text-[13px] ${disabled && !on ? "text-[var(--faint)]" : "text-[var(--ink)]"}`}
                >
                  {agent.name}
                  {agent.unavailable && (
                    <span className="ml-1.5 text-[11px] text-[var(--faint)]">Not installed</span>
                  )}
                </span>
                <span
                  className={`block truncate text-[11.5px] ${agent.lockedReason ? "text-amber-300" : "text-[var(--faint)]"}`}
                  title={agent.lockedReason ?? agent.detail}
                >
                  {agent.lockedReason ?? agent.detail}
                </span>
              </span>
              <Checkbox on={on} dim={disabled} />
            </button>
          );
        })}
        {here.length === 0 && !showAll && (
          <div className="px-3.5 py-3 text-[12.5px] text-[var(--faint)]">
            None of the supported agents are installed on this machine.
          </div>
        )}
      </div>
      {missing.length > 0 && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-1.5 cursor-pointer text-[12px] text-[var(--faint)] hover:text-[var(--ink)]"
        >
          {showAll ? "Hide agents that aren't installed" : `Show ${missing.length} more not installed`}
        </button>
      )}
    </section>
  );
}

export function Checkbox({ on, dim }: { on: boolean; dim?: boolean }) {
  return (
    <span
      className={`flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-[5px] border ${
        on
          ? "border-[var(--accent)] bg-[var(--accent)] text-white"
          : "border-[var(--border)] bg-[var(--card)]"
      } ${dim ? "opacity-50" : ""}`}
    >
      {on && <Check size={12} strokeWidth={3} />}
    </span>
  );
}

/** The agents something is synced to, as a row of overlapping logos. */
export function AgentLogos({ ids, max = 6 }: { ids: string[]; max?: number }) {
  const vendorOf = useVendorOf();
  const catalog = useEgant((s) => s.catalog);
  const nameOf = (id: string) => catalog.find((c) => c.id === id)?.name ?? id;
  const shown = ids.slice(0, max);
  return (
    <span className="flex items-center" title={ids.map(nameOf).join(", ")}>
      {shown.map((id, i) => (
        <span
          key={id}
          className={`rounded-md ring-2 ring-[var(--stage)] ${i > 0 ? "-ml-1.5" : ""}`}
        >
          <ProviderLogo provider={vendorOf(id)} size={18} />
        </span>
      ))}
      {ids.length > max && (
        <span className="ml-1 text-[11px] text-[var(--faint)]">+{ids.length - max}</span>
      )}
    </span>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative min-w-0 flex-1 md:max-w-[320px]">
      <Search
        size={14}
        strokeWidth={2}
        className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-[var(--faint)]"
      />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-[var(--border)] bg-[var(--card)] py-1.5 pr-3 pl-8 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)]"
      />
    </div>
  );
}

export const INPUT =
  "w-full rounded-lg border border-[var(--border)] bg-[var(--card)] px-3 py-1.5 text-[13px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)] focus:border-[var(--accent)] disabled:opacity-60";

export function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12.5px] text-[var(--muted)]">
        {label}
        {required && <span className="ml-0.5 text-amber-300">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-[11.5px] text-[var(--faint)]">{hint}</span>}
    </label>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "good"; children: ReactNode }) {
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed whitespace-pre-wrap ${
        tone === "warn"
          ? "border-amber-400/25 bg-amber-500/10 text-amber-200"
          : "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
      }`}
    >
      {tone === "warn" ? (
        <AlertTriangle size={13} strokeWidth={2} className="mt-0.5 shrink-0" />
      ) : (
        <Check size={13} strokeWidth={2.5} className="mt-0.5 shrink-0" />
      )}
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export function PrimaryButton({
  busy,
  disabled,
  onClick,
  children,
}: {
  busy?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled || busy}
      onClick={onClick}
      className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-[var(--ink)] px-3.5 py-1.5 text-[13px] font-medium text-[var(--stage)] hover:opacity-90 disabled:cursor-default disabled:opacity-50"
    >
      {children}
    </button>
  );
}

export function GhostButton({
  onClick,
  disabled,
  danger,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-[var(--border)] px-3 py-1.5 text-[13px] hover:bg-[var(--hover)] disabled:cursor-default disabled:opacity-50 ${
        danger ? "text-red-300" : "text-[var(--ink)]"
      }`}
    >
      {children}
    </button>
  );
}

export function GroupTitle({ title, count }: { title: string; count?: number }) {
  return (
    <h2 className="mt-6 mb-2 px-0.5 text-[12px] font-medium text-[var(--muted)]">
      {title}
      {count != null && ` (${count})`}
    </h2>
  );
}

/** One card in a Library grid. */
export function LibraryCard({
  icon,
  title,
  tag,
  description,
  footer,
  action,
  onOpen,
}: {
  icon: ReactNode;
  title: string;
  tag?: ReactNode;
  description: ReactNode;
  footer?: ReactNode;
  action?: ReactNode;
  onOpen: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      className="flex cursor-pointer flex-col gap-2 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3.5 text-left outline-none hover:bg-[var(--hover)] focus-visible:border-[var(--accent)]"
    >
      <div className="flex items-center gap-2.5">
        {icon}
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-[var(--ink)]">
          {title}
        </span>
        {tag}
        {action}
      </div>
      <p className="line-clamp-2 min-h-[2.6em] text-[12px] leading-relaxed text-[var(--muted)]">
        {description}
      </p>
      {footer && <div className="flex items-center gap-2 text-[11.5px] text-[var(--faint)]">{footer}</div>}
    </div>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-md border border-[var(--border)] px-1.5 py-px font-mono text-[10.5px] text-[var(--faint)]">
      {children}
    </span>
  );
}

/** A letter tile for things with no logo of their own. */
export function Monogram({ text }: { text: string }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--hover)] text-[12px] font-semibold text-[var(--muted)] uppercase">
      {text.replace(/[^a-z0-9]/gi, "").slice(0, 1) || "?"}
    </span>
  );
}
