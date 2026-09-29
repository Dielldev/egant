import { Share, X } from "lucide-react";
import { useEffect, useState } from "react";

const DISMISSED_KEY = "egant.installHintDismissed";

/** The event Chrome fires when the app can be installed. Not in the DOM
 * typings yet. */
interface InstallPrompt extends Event {
  prompt: () => Promise<void>;
}

let deferredPrompt: InstallPrompt | null = null;
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event as InstallPrompt;
});

export function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

export function isIos(): boolean {
  const ua = navigator.userAgent;
  // iPadOS asks for the desktop site and reports itself as a Mac with touch.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Suggests adding egant to the Home Screen, once, in the browser tab the QR
 * code opened. Installed, it opens like an app and stays paired. */
export function InstallHint() {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const [canPrompt, setCanPrompt] = useState(deferredPrompt != null);

  useEffect(() => {
    const onPrompt = () => setCanPrompt(true);
    window.addEventListener("beforeinstallprompt", onPrompt);
    return () => window.removeEventListener("beforeinstallprompt", onPrompt);
  }, []);

  if (dismissed || isStandalone()) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(DISMISSED_KEY, "1");
    } catch {
      // Unavailable storage: it just shows again next time.
    }
  };

  return (
    <div className="mx-1 mb-3 flex items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--card)] p-3 text-[13px]">
      <div className="min-w-0 flex-1">
        <div className="font-medium text-[var(--ink)]">Add egant to your Home Screen</div>
        <div className="mt-1 text-[12px] leading-relaxed text-[var(--muted)]">
          {isIos() ? (
            <>
              Tap <Share size={12} strokeWidth={2} className="inline align-[-2px]" /> Share, then
              “Add to Home Screen”. It opens like an app and remembers this Mac.
            </>
          ) : (
            "Install it from the browser menu. It opens like an app and remembers this Mac."
          )}
        </div>
        {canPrompt && deferredPrompt && (
          <button
            type="button"
            onClick={() => {
              void deferredPrompt?.prompt().then(() => {
                deferredPrompt = null;
                setCanPrompt(false);
              });
            }}
            className="mt-2 cursor-pointer rounded-full bg-[#f2f2f5] px-3 py-1 text-[12px] text-[#0c0c0e]"
          >
            Install
          </button>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss"
        onClick={dismiss}
        className="-mt-1 -mr-1 cursor-pointer p-1 text-[var(--faint)]"
      >
        <X size={14} strokeWidth={2} />
      </button>
    </div>
  );
}
