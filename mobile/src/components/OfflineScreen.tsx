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
    <div className="relative h-full">
      <div className="safe-top safe-bottom relative z-10 flex h-full flex-col items-center justify-center px-7 text-center">
        <div className="fade-up flex flex-col items-center text-[var(--ink)]">
          <span className="mb-5 flex h-16 w-16 items-center justify-center rounded-full bg-[var(--raised)]">
            <WifiOff size={26} strokeWidth={1.8} />
          </span>
          <h1 className="text-[26px] leading-8 font-semibold tracking-[-0.02em]">Can't reach your Mac</h1>
        </div>
        <ul className="composer fade-up mt-6 w-full max-w-[340px] space-y-2 rounded-[24px] px-5 py-4 text-left text-[14px] leading-relaxed text-[var(--muted)]">
          <li>Is the Mac awake and online, with egant open?</li>
          <li>Is Tailscale on, on the Mac? (And on this phone, unless it uses the public link.)</li>
          <li>Is phone access still on in egant → Settings → Devices?</li>
        </ul>
        <button
          type="button"
          onClick={() => void retryNow()}
          className="press mt-6 flex h-12 items-center gap-2 rounded-full bg-[var(--ink)] px-6 text-[15px] font-semibold text-[var(--stage)]"
        >
          {trying && <Loader2 size={16} strokeWidth={2.4} className="animate-spin" />}
          Try again
        </button>
      </div>
    </div>
  );
}
