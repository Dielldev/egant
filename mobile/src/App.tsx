import { useEffect } from "react";
import { LogoLoader } from "@egant/components/Logo";
import { OfflineScreen } from "./components/OfflineScreen";
import { PairScreen } from "./components/PairScreen";
import { PreviewSheet } from "./components/PreviewSheet";
import { Shell } from "./components/Shell";
import { useMobile } from "./store";
import { startStream, stopStream } from "./stream";

export function App() {
  const phase = useMobile((s) => s.phase);

  useEffect(() => {
    void boot();
  }, []);

  switch (phase) {
    case "boot":
      return (
        <div className="flex h-full items-center justify-center">
          <LogoLoader width={72} label="Connecting to your Mac" />
        </div>
      );
    case "unpaired":
      return <PairScreen onPaired={() => void boot()} />;
    case "offline":
      return <OfflineScreen onRetry={boot} />;
    case "ready":
      return (
        <>
          <Shell />
          {/* Beside the shell, not in it: a touch on the preview's own bar
            must not read as a swipe for the drawer. */}
          <PreviewSheet />
        </>
      );
  }
}

let booting = false;

/** Pairs with a code the QR link carried, if any, then loads everything from
 * the Mac and starts following it. */
async function boot(): Promise<void> {
  if (booting) return;
  booting = true;
  try {
    const store = useMobile.getState();
    const code = takePairCode();
    if (code && !(await store.pair(code))) return;
    stopStream();
    if (!(await store.refresh())) return;
    startStream();
    // A session named in the address (a reload, say) that has since gone.
    const { openSession, sessions, navigate } = useMobile.getState();
    if (openSession != null && !sessions.some((session) => session.id === openSession)) {
      navigate(null);
    }
  } finally {
    booting = false;
  }
}

/** The one-time code a scanned QR link carries in its fragment (never sent
 * to any server on its own). Taken out of the address at once: it is spent
 * the moment it is used, and has no business in history or a bookmark. */
function takePairCode(): string | null {
  const match = /^#pair=([A-Za-z0-9-]{10,11})$/.exec(window.location.hash);
  if (!match) return null;
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return match[1] ?? null;
}
