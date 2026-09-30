import { ExternalLink, Loader2, Monitor, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import { api } from "../api";
import { useMobile } from "../store";
import { IconButton } from "./Header";

/** How long a site is given before the pane admits it is still waiting. */
const SLOW_MS = 8_000;
/** How long a link stays offered after a browser refused to open it on its
 * own — the Mac's is good for a minute. */
const LINK_MS = 50_000;

/** The width the site is laid out at in the desktop view: a laptop screen.
 * A phone turned sideways is only about 850px wide, so most sites would still
 * draw their tablet or phone design there — this is where their desktop
 * design starts. */
const DESKTOP_WIDTH = 1280;

/** What the site in the frame may do. Everything a website in development
 * plausibly needs (sign-in pop-ups, forms, downloads) — except steer this app:
 * there is no `allow-top-navigation`. It keeps its own origin, which is not
 * this app's, so it can't reach this app's cookies or API either. */
const SANDBOX = [
  "allow-scripts",
  "allow-same-origin",
  "allow-forms",
  "allow-popups",
  "allow-popups-to-escape-sandbox",
  "allow-modals",
  "allow-downloads",
  "allow-pointer-lock",
  "allow-presentation",
].join(" ");

/** What a frame from another origin has to be told it may ask the phone for. */
const ALLOW = [
  "camera",
  "microphone",
  "geolocation",
  "fullscreen",
  "clipboard-read",
  "clipboard-write",
  "autoplay",
  "web-share",
].join("; ");

/** Whether the phone itself is turned sideways.
 *
 * Asked of the device, not of the page's shape: with the keyboard up a
 * portrait page can be wider than it is tall, and the site must not jump to
 * its desktop layout every time a field in it is tapped. */
function deviceIsLandscape(): boolean {
  const type = window.screen?.orientation?.type;
  if (type) return type.startsWith("landscape");
  // Older iOS: -90 and 90 are sideways.
  const legacy = (window as unknown as { orientation?: number }).orientation;
  if (typeof legacy === "number") return Math.abs(legacy) === 90;
  return window.matchMedia("(orientation: landscape)").matches;
}

function useLandscape(): boolean {
  const [landscape, setLandscape] = useState(deviceIsLandscape);
  useEffect(() => {
    const update = () => setLandscape(deviceIsLandscape());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    window.screen?.orientation?.addEventListener?.("change", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
      window.screen?.orientation?.removeEventListener?.("change", update);
    };
  }, []);
  return landscape;
}

/** The size of an element while `active`, kept current. */
function useSize(active: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!active || !el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);
  return [ref, size] as const;
}

/** The website a chat is running, shown inside the app the way a preview pane
 * shows it beside a chat: full screen over the conversation, with the ways
 * out — close (or the phone's back gesture), reload, open in a browser tab.
 *
 * Turn the phone sideways and it shows the site's desktop layout: the frame
 * is laid out at a laptop's width and scaled down to fit, so the site's own
 * media queries (and `innerWidth`) see a desktop. The monitor button flips
 * that either way, whatever way the phone is held.
 *
 * The site itself is served by the Mac from an origin and port of its own (see
 * `src-tauri/src/mobile/preview.rs`); this only frames it. */
export function PreviewSheet() {
  const preview = useMobile((s) => s.preview);
  const busy = useMobile((s) => s.previewBusy);
  const close = useMobile((s) => s.closePreview);
  const reload = useMobile((s) => s.reloadPreview);
  const showToast = useMobile((s) => s.showToast);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const [browserLink, setBrowserLink] = useState<string | null>(null);
  // Which layout was asked for by hand; `null` follows the way the phone is held.
  const [manual, setManual] = useState<"phone" | "desktop" | null>(null);
  const landscape = useLandscape();
  const open = preview != null;
  const [stage, size] = useSize(open);
  const key = preview?.key;

  // A new link is a new load.
  useEffect(() => {
    setLoaded(false);
    setSlow(false);
    setBrowserLink(null);
    if (key == null) return;
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => clearTimeout(timer);
  }, [key]);

  // A choice made by hand is for the preview it was made in.
  useEffect(() => {
    if (!open) setManual(null);
  }, [open]);

  useEffect(() => {
    if (!browserLink) return;
    const timer = setTimeout(() => setBrowserLink(null), LINK_MS);
    return () => clearTimeout(timer);
  }, [browserLink]);

  useEffect(() => {
    if (!preview) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [preview, close]);

  if (!preview) return null;

  const path = preview.target.path && preview.target.path !== "/" ? preview.target.path : "";
  const desktop = (manual ?? (landscape ? "desktop" : "phone")) === "desktop";

  // The desktop view: the frame is as wide as a laptop screen (or as the pane,
  // if that is wider still) and as tall as makes it fill the pane once scaled.
  const frameWidth = Math.max(DESKTOP_WIDTH, size.w);
  const scale = size.w > 0 ? size.w / frameWidth : 1;
  const frameStyle: CSSProperties =
    desktop && size.w > 0
      ? {
          width: frameWidth,
          height: size.h / scale,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
        }
      : { width: "100%", height: "100%" };

  const openInBrowser = async () => {
    // The tab is opened inside the tap, so it is never taken for a pop-up, and
    // pointed at its link once that arrives (the frame spent the first one).
    const tab = window.open("", "_blank");
    try {
      const { url } = await api.openPreview(preview.sessionId, preview.target);
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        setBrowserLink(url);
      }
    } catch (error) {
      tab?.close();
      showToast(error instanceof Error ? error.message : String(error));
    }
  };

  return createPortal(
    <div
      className="fixed inset-x-0 z-50 flex flex-col bg-[var(--stage)]"
      style={{
        top: "var(--app-top, 0px)",
        height: "var(--app-height, 100dvh)",
        // Turned sideways, the notch and the rounded corners are at the ends.
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Website preview"
    >
      <header className="safe-top bar-glass relative z-10 shrink-0 border-b border-[var(--hairline)]">
        <div
          className={`grid grid-cols-[52px_minmax(0,1fr)_140px] items-center px-1 ${
            landscape ? "h-[44px]" : "h-[54px]"
          }`}
        >
          <div className="flex justify-start">
            <IconButton label="Close preview" onClick={close}>
              <X size={22} strokeWidth={1.9} />
            </IconButton>
          </div>
          <div className="flex min-w-0 flex-col items-center leading-tight">
            <span className="text-[15px] font-semibold text-[var(--ink)]">
              {desktop ? "Desktop preview" : "Preview"}
            </span>
            <span className="max-w-full truncate font-mono text-[12px] text-[var(--muted)]">
              localhost:{preview.port}
              {path}
              {desktop && size.w > 0 ? ` · ${Math.round(frameWidth)}px` : ""}
            </span>
          </div>
          <div className="flex justify-end">
            <IconButton
              label={desktop ? "Show the phone version" : "Show the desktop version"}
              pressed={desktop}
              onClick={() => setManual(desktop ? "phone" : "desktop")}
            >
              <Monitor size={20} strokeWidth={1.9} />
            </IconButton>
            <IconButton label="Reload" onClick={() => void reload()}>
              {busy ? (
                <Loader2 size={19} strokeWidth={2} className="animate-spin" />
              ) : (
                <RotateCw size={19} strokeWidth={1.9} />
              )}
            </IconButton>
            <IconButton label="Open in a browser tab" onClick={() => void openInBrowser()}>
              <ExternalLink size={20} strokeWidth={1.9} />
            </IconButton>
          </div>
        </div>
      </header>

      <div className="relative min-h-0 flex-1 overflow-hidden bg-[var(--stage)]">
        {/* What the frame is laid out in: the pane, above the home indicator. */}
        <div
          ref={stage}
          className="absolute inset-x-0 top-0 overflow-hidden"
          style={{ bottom: "env(safe-area-inset-bottom)" }}
        >
          <iframe
            key={preview.key}
            src={preview.url}
            title="Website preview"
            className="absolute top-0 left-0 border-0 bg-white"
            style={frameStyle}
            sandbox={SANDBOX}
            allow={ALLOW}
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
          />
        </div>
        {!loaded && (
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[var(--stage)] px-8 text-center text-[14px] text-[var(--muted)]">
            <Loader2 size={22} strokeWidth={2} className="animate-spin" />
            <span>{slow ? "Still waiting for your site…" : "Opening your site…"}</span>
            {slow && (
              <span className="text-[12.5px] leading-snug text-[var(--faint)]">
                Make sure it is still running on your Mac, then reload.
              </span>
            )}
          </div>
        )}
        {browserLink && (
          <a
            href={browserLink}
            target="_blank"
            rel="noopener noreferrer"
            className="press absolute bottom-6 left-1/2 flex h-11 -translate-x-1/2 items-center gap-2 rounded-full bg-[var(--ink)] px-5 text-[14px] font-medium whitespace-nowrap text-[var(--stage)] shadow-[0_8px_30px_rgba(0,0,0,0.35)]"
          >
            <ExternalLink size={15} strokeWidth={2.2} />
            Tap to open in a browser tab
          </a>
        )}
      </div>
    </div>,
    document.body,
  );
}
