import { AlertCircle } from "lucide-react";
import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useMobile } from "../store";

/** A passing problem — a send that failed, a session closed on the Mac —
 * floating under the top bar, gone after a few seconds or sooner on a tap. */
export function Toast() {
  const toast = useMobile((s) => s.toast);
  const dismiss = useMobile((s) => s.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  if (!toast) return null;
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 z-[60] flex justify-center px-4"
      style={{ top: "calc(env(safe-area-inset-top) + 62px)" }}
    >
      <button
        key={toast}
        type="button"
        onClick={dismiss}
        className="toast-in menu pointer-events-auto flex max-w-[420px] items-start gap-2.5 rounded-2xl px-4 py-3 text-left text-[14px] leading-5 text-[var(--ink)]"
      >
        <AlertCircle size={17} strokeWidth={2} className="mt-0.5 shrink-0 text-[var(--danger)]" />
        <span className="min-w-0">{toast}</span>
      </button>
    </div>,
    document.body,
  );
}
