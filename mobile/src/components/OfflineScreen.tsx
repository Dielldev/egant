import { Loader2, WifiOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/** The app opened (from its cache) but the Mac didn't answer at all. It
 * retries on its own, and whenever the phone comes back to the app. */
export function OfflineScreen({ onRetry }: { onRetry: () => Promise<void> }) {
  const [trying, setTrying] = useState(false);
  // Read by the timer too, which would otherwise see only the first render's
  // value and could overlap two attempts.
  const inFlight = useRef(false);
  const retryRef = useRef(onRetry);
  retryRef.current = onRetry;

  useEffect(() => {
    const retry = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      setTrying(true);
      await retryRef.current();
      inFlight.current = false;
      setTrying(false);
    };
    const timer = window.setInterval(() => void retry(), 8000);
    const onVisible = () => {
      if (!document.hidden) void retry();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, []);

  const retryNow = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setTrying(true);
    await onRetry();
    inFlight.current = false;
    setTrying(false);
  };

  return (
    <div className="safe-top safe-bottom flex h-full flex-col items-center justify-center px-8 text-center">
      <WifiOff size={26} strokeWidth={1.75} className="mb-4 text-[var(--faint)]" />
      <h1 className="text-[18px] font-semibold text-[var(--ink)]">Can't reach your Mac</h1>
      <ul className="mt-3 max-w-[300px] space-y-1 text-left text-[13px] leading-relaxed text-[var(--muted)]">
        <li>• Is the Mac awake and online, with egant open?</li>
        <li>• Is Tailscale on, on the Mac? (And on this phone, unless it uses the public link.)</li>
        <li>• Is phone access still on in egant → Settings → Devices?</li>
      </ul>
      <button
        type="button"
        onClick={() => void retryNow()}
        className="mt-6 flex h-10 cursor-pointer items-center gap-2 rounded-full bg-[var(--bubble)] px-5 text-[13px] text-[var(--ink)]"
      >
        {trying && <Loader2 size={14} strokeWidth={2} className="animate-spin" />}
        Try again
      </button>
    </div>
  );
}
