import { useEffect } from "react";
import { useMobile } from "../store";

/** A passing problem — a send that failed, a session closed on the Mac —
 * gone after a few seconds, or sooner on a tap. */
export function Toast() {
  const toast = useMobile((s) => s.toast);
  const dismiss = useMobile((s) => s.dismissToast);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(dismiss, 5000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);
  if (!toast) return null;
  return (
    <button
      type="button"
      onClick={dismiss}
      className="mb-2 w-full cursor-pointer rounded-lg bg-[rgba(224,112,112,0.14)] px-3 py-2 text-left text-[12px] text-[var(--danger)]"
    >
      {toast}
    </button>
  );
}
