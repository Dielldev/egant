import { Component, type ErrorInfo, type ReactNode } from "react";
import { log } from "../lib/logger";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/** Catches render-time crashes anywhere below it in the tree.
 *
 * The window is transparent by design (`App.tsx`'s root is `bg-transparent`,
 * with the native macOS blur painted behind it by `sync_window_appearance`)
 * — that's what makes the frosted-glass chrome look right. But it also means
 * an uncaught render error leaves nothing to paint: React unmounts the whole
 * tree by default, and a transparent window with nothing rendered shows
 * straight through to the desktop, with only the OS's own traffic-light
 * buttons left on screen — a crash that looks like the app vanished rather
 * than like an error. This fallback is deliberately opaque so a crash always
 * reads as a crash.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    log.error("app", "egant crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[#0c0c0e] p-8 text-center">
        <div className="text-[13px] font-semibold text-[#e0e0e0]">
          Something went wrong
        </div>
        <div className="max-w-[480px] font-mono text-[11px] leading-relaxed text-[#8b8b95]">
          {error.message}
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="cursor-pointer rounded-lg bg-[#2a2a30] px-3 py-1.5 text-[12px] text-[#e0e0e0] hover:bg-[#35353c]"
        >
          Reload
        </button>
      </div>
    );
  }
}
