import { listen } from "@tauri-apps/api/event";
import { ArrowLeft, ArrowRight, ExternalLink, Globe, Loader2, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { BrowserNav } from "../lib/types";
import type { PanelTab } from "../store";
import { useEgant } from "../store";

/** How long a tab that just stopped being the visible one keeps its webview
 * alive before it's actually discarded. Long enough that flipping back to a
 * tab you just left — or a quick ⌘K, ⌘J⌘J — resumes instantly with scroll
 * position and all; short enough that a tab nobody has looked at in a few
 * seconds stops costing anything. At most one browser webview is ever alive
 * for longer than this window, which is the whole point: a background tab
 * this app isn't showing shouldn't burn memory, CPU or battery just for
 * having been opened once. */
const SUSPEND_GRACE_MS = 5_000;

/** Pending discards, keyed by tab id — module-level rather than component
 * state because the timer has to outlive `BrowserPane` unmounting (closing
 * the workspace panel unmounts every tab's pane at once, and the grace
 * period still has to run to completion for whichever one was showing). */
const suspendTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelSuspend(tabId: string): void {
  const timer = suspendTimers.get(tabId);
  if (timer == null) return;
  clearTimeout(timer);
  suspendTimers.delete(tabId);
}

/** Arms a tab's discard. Safe to call redundantly — a still-pending timer is
 * just reset, not stacked into a second one. */
function scheduleSuspend(tabId: string): void {
  cancelSuspend(tabId);
  suspendTimers.set(
    tabId,
    setTimeout(() => {
      suspendTimers.delete(tabId);
      void api.browserClose(tabId);
    }, SUSPEND_GRACE_MS),
  );
}

/** The page's host, for the tab strip's title — `https://github.com/a/b`
 * reads as "github.com" there, the same shorthand a real browser tab uses.
 * Falls back to the raw string on anything `URL` won't parse, which only
 * happens on a malformed value from the backend, never on user input (that
 * always goes through `resolve_url` on the Rust side first). */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

/** One button in the toolbar — back/forward/reload/open-externally all share
 * this rather than repeating the class string four times. */
function ToolButton({
  icon,
  title,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className="shrink-0 cursor-pointer rounded-md p-1 text-[var(--faint)] hover:bg-[var(--hover)] hover:text-[var(--ink)] disabled:pointer-events-none disabled:opacity-35"
    >
      {icon}
    </button>
  );
}

/** A "New Tab" screen before a Browser tab has gone anywhere — the same idea
 * as the panel's own empty-state chooser, scaled down to one tab. */
function NewTabSplash() {
  return (
    <div className="pointer-events-none flex h-full flex-col items-center justify-center gap-2 text-[var(--faint)]">
      <Globe size={22} strokeWidth={1.6} />
      <span className="text-[12.5px]">Enter an address above to start browsing</span>
    </div>
  );
}

/** The panel's Browser tab: a real web page, via a native webview layered
 * over the window and kept lined up with the empty `<div>` below the
 * toolbar. `active` is how the panel hides a tab without unmounting it — a
 * CSS `hidden` class alone would do nothing here, since the webview isn't
 * part of this DOM at all; hiding it is a real command (see
 * `browser_set_visible` in `src-tauri/src/browser.rs`).
 *
 * At most one browser tab's webview is ever alive for more than
 * `SUSPEND_GRACE_MS`: the moment a tab stops being the visible one it's
 * hidden, and — unless it becomes the visible one again within the grace
 * window — discarded outright, so an open-but-unwatched tab costs nothing
 * once that window passes. Coming back to a discarded tab just re-navigates
 * to its last known address, which is the one place this trades a little UX
 * (lost scroll position, an unsaved form) for a lot of idle memory, CPU and
 * battery back. The tab's own id doubles as its webview's label; closing the
 * tab for real (`closePanelTab` in the store) is the only thing distinct
 * from this ordinary discard-and-resume cycle. */
export function BrowserPane({ tab, active }: { tab: PanelTab; active: boolean }) {
  const updateBrowserTab = useEgant((s) => s.updateBrowserTab);
  const searchOpen = useEgant((s) => s.searchOpen);
  const cliLaunch = useEgant((s) => s.cliLaunch);

  const placeholderRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(tab.url ?? "");
  const addressFocused = useRef(false);
  const [error, setError] = useState<string | null>(null);

  // Read inside effect cleanups below instead of the prop directly — a
  // cleanup closes over whatever `tab.url` was when its effect last *ran*,
  // which goes stale the moment a navigation updates the store without this
  // effect re-firing (see why that dependency is left out, below).
  const urlRef = useRef(tab.url);
  urlRef.current = tab.url;

  // Only the two overlays that render above everything via plain DOM
  // stacking — a native child webview ignores DOM z-index entirely, so
  // without this a page would visually cover the search modal or the CLI
  // launch dialog while one was open on top of it.
  const shouldShow = active && !searchOpen && !cliLaunch;

  const syncBounds = useCallback(() => {
    const el = placeholderRef.current;
    if (!el || !urlRef.current) return;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    void api.browserSetBounds(tab.id, rect.x, rect.y, rect.width, rect.height);
  }, [tab.id]);

  // Every layout change the placeholder can go through: its own resize (the
  // panel's drag handle, maximizing) fires the observer; a window resize that
  // leaves the placeholder's own size untouched but slides the whole panel
  // sideways needs the separate listener.
  useEffect(() => {
    const el = placeholderRef.current;
    if (!el) return;
    const observer = new ResizeObserver(syncBounds);
    observer.observe(el);
    window.addEventListener("resize", syncBounds);
    syncBounds();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
    };
  }, [syncBounds]);

  // The suspend/resume lifecycle: becoming the visible tab cancels any
  // pending discard and (re)opens the webview at the placeholder's current
  // rect — `browser_open` is idempotent, so this is a no-op reposition when
  // the grace period hadn't elapsed yet, and a fresh navigate back to the
  // last known address when it had. Stopping being the visible tab — losing
  // focus to another panel tab, the panel closing, Settings opening over it —
  // hides it immediately and arms the discard timer; the cleanup below runs
  // in every one of those cases; unmounting while already hidden runs no
  // cleanup, correctly, because that transition already hid and armed it.
  //
  // `tab.url` is deliberately not a dependency: this effect's job is
  // resuming a tab when it *becomes* the visible one, not reacting to every
  // navigation while it already is one (`go()` below drives those
  // navigations directly) — including it would hide and reopen the webview
  // on every address typed into an already-visible tab.
  useEffect(() => {
    if (!shouldShow) return;
    cancelSuspend(tab.id);
    if (urlRef.current) {
      const rect = placeholderRef.current?.getBoundingClientRect();
      void api.browserOpen(
        tab.id,
        urlRef.current,
        rect?.x ?? 0,
        rect?.y ?? 0,
        rect?.width ?? 800,
        rect?.height ?? 600,
      );
    }
    return () => {
      void api.browserSetVisible(tab.id, false);
      if (urlRef.current) scheduleSuspend(tab.id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, shouldShow]);

  // The page's own navigation — a typed address, a link clicked inside it, a
  // redirect — all land here rather than as a return value from any one
  // call, since the frontend isn't the only thing that can move the page.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<BrowserNav>("browser-nav", ({ payload }) => {
      if (payload.label !== tab.id) return;
      updateBrowserTab(tab.id, {
        url: payload.url,
        loading: payload.loading,
        title: hostnameOf(payload.url),
      });
      if (!addressFocused.current) setAddress(payload.url);
    }).then((off) => {
      if (cancelled) off();
      else unlisten = off;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [tab.id, updateBrowserTab]);

  const go = useCallback(
    async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) return;
      setError(null);
      try {
        let resolved: string;
        if (tab.url) {
          // Already has a webview: a plain navigation.
          resolved = await api.browserNavigate(tab.id, trimmed);
        } else {
          // First address this tab has ever gone to — the webview doesn't
          // exist yet, so it's created at exactly the placeholder's rect
          // rather than at some default it would immediately have to jump
          // out of.
          const rect = placeholderRef.current?.getBoundingClientRect();
          resolved = await api.browserOpen(
            tab.id,
            trimmed,
            rect?.x ?? 0,
            rect?.y ?? 0,
            rect?.width ?? 800,
            rect?.height ?? 600,
          );
        }
        setAddress(resolved);
        updateBrowserTab(tab.id, { url: resolved, loading: true, title: hostnameOf(resolved) });
      } catch (problem) {
        setError(problem instanceof Error ? problem.message : String(problem));
      }
    },
    [tab.id, tab.url, updateBrowserTab],
  );

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex h-[34px] shrink-0 items-center gap-1 border-b border-[var(--border)] px-2">
        <ToolButton
          icon={<ArrowLeft size={13} strokeWidth={2} />}
          title="Back"
          disabled={!tab.url}
          onClick={() => void api.browserGoBack(tab.id)}
        />
        <ToolButton
          icon={<ArrowRight size={13} strokeWidth={2} />}
          title="Forward"
          disabled={!tab.url}
          onClick={() => void api.browserGoForward(tab.id)}
        />
        <ToolButton
          icon={
            tab.loading ? (
              <Loader2 size={13} strokeWidth={2} className="animate-spin" />
            ) : (
              <RotateCw size={13} strokeWidth={2} />
            )
          }
          title="Reload"
          disabled={!tab.url}
          onClick={() => void api.browserReload(tab.id)}
        />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void go(address);
          }}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md bg-[var(--card)] px-2 py-1"
        >
          <Globe size={12} strokeWidth={2} className="shrink-0 text-[var(--faint)]" />
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => {
              addressFocused.current = true;
              e.target.select();
            }}
            onBlur={() => {
              addressFocused.current = false;
            }}
            placeholder="Search or enter an address"
            spellCheck={false}
            autoFocus={!tab.url}
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-[var(--ink)] outline-none placeholder:text-[var(--faint)]"
          />
        </form>
        <ToolButton
          icon={<ExternalLink size={13} strokeWidth={2} />}
          title="Open in default browser"
          disabled={!tab.url}
          onClick={() => {
            if (tab.url) void api.openUrl(tab.url);
          }}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={placeholderRef} className="absolute inset-0">
          {!tab.url && <NewTabSplash />}
        </div>
        {error && (
          <div className="pointer-events-none absolute inset-x-2 bottom-2 rounded-md bg-[rgba(224,112,112,0.14)] px-2 py-1.5 text-[11px] text-[var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
