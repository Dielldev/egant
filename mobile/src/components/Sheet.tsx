import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode, TouchEvent } from "react";
import { createPortal } from "react-dom";

/** How long a sheet takes to leave — matches `.sheet`'s transition. */
const EXIT_MS = 420;

/** A bottom sheet: rises over the page, dims it, and goes with a tap outside,
 * the close button, or a pull down on its handle. It stays mounted until it
 * has finished sliding away. */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  tall,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  /** Pinned under the scrolling part. */
  footer?: ReactNode;
  /** Takes most of the screen from the start (long lists). */
  tall?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(false);
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setMounted(true);
      // Two frames: one to lay it out below the screen, one to slide it in.
      const frame = requestAnimationFrame(() => requestAnimationFrame(() => setShown(true)));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), EXIT_MS);
    return () => clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const onTouchStart = (event: TouchEvent) => {
    start.current = event.touches[0]?.clientY ?? null;
  };
  const onTouchMove = (event: TouchEvent) => {
    if (start.current == null) return;
    setDrag(Math.max(0, (event.touches[0]?.clientY ?? 0) - start.current));
  };
  const onTouchEnd = () => {
    if (drag > 90) onClose();
    start.current = null;
    setDrag(0);
  };

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <div
        className="sheet-backdrop absolute inset-0"
        style={{ opacity: shown ? 1 : 0 }}
        onClick={onClose}
      />
      <div
        className={`sheet safe-bottom absolute inset-x-0 bottom-0 flex flex-col rounded-t-[28px] ${
          drag > 0 ? "dragging" : ""
        }`}
        style={{
          maxHeight: "calc(var(--app-height, 100dvh) - env(safe-area-inset-top) - 24px)",
          minHeight: tall ? "70%" : undefined,
          transform: shown ? `translateY(${drag}px)` : "translateY(100%)",
          transition: drag > 0 ? "none" : undefined,
        }}
      >
        <div
          className="shrink-0 touch-none px-5 pt-2 pb-1"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
        >
          <div className="mx-auto mb-2 h-[5px] w-9 rounded-full bg-[var(--faint)]/60" />
          {title != null && (
            <div className="flex min-h-9 items-center gap-3">
              <div className="min-w-0 flex-1 text-[17px] font-semibold text-[var(--ink)]">
                {title}
              </div>
              <button
                type="button"
                aria-label="Close"
                onClick={onClose}
                className="press flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--raised-2)] text-[var(--muted)]"
              >
                <X size={16} strokeWidth={2.4} />
              </button>
            </div>
          )}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-2">{children}</div>
        {footer && <div className="shrink-0 px-4 pt-2">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** A group of rows on a raised card, the way iOS lists settings. */
export function Group({ label, children, note }: { label?: string; children: ReactNode; note?: ReactNode }) {
  return (
    <section className="mb-5">
      {label && (
        <div className="px-4 pb-1.5 text-[13px] font-medium text-[var(--muted)]">{label}</div>
      )}
      <div className="overflow-hidden rounded-[18px] bg-[var(--raised)]">{children}</div>
      {note && <div className="px-4 pt-1.5 text-[12.5px] leading-snug text-[var(--faint)]">{note}</div>}
    </section>
  );
}

/** One row of a sheet's list: an optional leading mark, a label with a line
 * under it, whatever trails, and a check when it is the current choice. */
export function Choice({
  leading,
  label,
  detail,
  trailing,
  selected,
  disabled,
  danger,
  onClick,
}: {
  leading?: ReactNode;
  label: ReactNode;
  detail?: ReactNode;
  trailing?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="flex w-full items-center gap-3 border-b border-[var(--hairline)] px-4 py-3 text-left last:border-b-0 active:bg-[var(--hover)] disabled:opacity-45"
    >
      {leading && <span className="flex shrink-0 items-center justify-center">{leading}</span>}
      <span className="min-w-0 flex-1">
        <span
          className={`block text-[16px] leading-6 ${danger ? "text-[var(--danger)]" : "text-[var(--ink)]"}`}
        >
          {label}
        </span>
        {detail && (
          <span className="mt-0.5 block text-[13px] leading-[18px] text-[var(--muted)]">{detail}</span>
        )}
      </span>
      {trailing}
      {selected && <CheckMark />}
    </button>
  );
}

export function CheckMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" className="shrink-0 text-[var(--accent)]" aria-label="Selected">
      <path
        d="M5 12.5l4.2 4.2L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
