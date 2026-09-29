import { useState } from "react";
import { wallpaperUrl } from "../api";
import { BUILT_IN_BACKGROUNDS, usePrefs } from "../prefs";
import type { Background } from "../prefs";
import { useMobile } from "../store";

const FALLBACK = BUILT_IN_BACKGROUNDS[0].src;

/** The picture a background choice stands for right now: the Mac's own
 * wallpaper while it has one, a photo from this phone, or one of the
 * built-in ones — and the first built-in whenever the choice has nothing to
 * show. `null` for no picture at all. */
export function useBackgroundSrc(choice?: Background): string | null {
  const background = usePrefs((s) => choice ?? s.background);
  const photo = usePrefs((s) => s.photo);
  const wallpaper = useMobile((s) => s.wallpaper);
  switch (background) {
    case "none":
      return null;
    case "mac":
      return wallpaper ? wallpaperUrl(wallpaper) : FALLBACK;
    case "photo":
      return photo ?? FALLBACK;
    default:
      return BUILT_IN_BACKGROUNDS.find((b) => b.id === background)?.src ?? FALLBACK;
  }
}

/** The new-chat screen's picture, full-bleed behind the greeting — the
 * desktop's launch-screen wallpaper, on a phone. Darkened as far as the dim
 * setting says, and always toward the bottom, so the composer and the
 * suggestions over it stay readable. It dissolves away as a chat begins. */
export function Backdrop({ visible = true }: { visible?: boolean }) {
  const src = useBackgroundSrc();
  const dim = usePrefs((s) => s.dim);
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<string | null>(null);

  // A Mac wallpaper this browser can't draw (HEIC outside Safari, say) or
  // that has gone: the built-in picture instead.
  const shown = src && failed === src ? FALLBACK : src;

  return (
    <div
      aria-hidden
      className="backdrop-fade pointer-events-none absolute inset-0 overflow-hidden bg-[var(--stage)]"
      style={{ opacity: visible ? 1 : 0 }}
    >
      {shown ? (
        <>
          <img
            key={shown}
            src={shown}
            alt=""
            draggable={false}
            onLoad={() => setLoaded(shown)}
            onError={() => setFailed(src)}
            className="absolute inset-0 h-full w-full object-cover transition-opacity duration-700"
            style={{ opacity: loaded === shown ? 1 : 0, objectPosition: "center 40%" }}
          />
          <div
            className="absolute inset-0"
            style={{
              background: `linear-gradient(to bottom,
                rgba(0,0,0,${(0.28 + dim * 0.3).toFixed(3)}) 0%,
                rgba(0,0,0,${(dim * 0.55).toFixed(3)}) 22%,
                rgba(0,0,0,${(dim * 0.6).toFixed(3)}) 52%,
                rgba(0,0,0,${Math.min(0.85, 0.35 + dim * 0.6).toFixed(3)}) 80%,
                rgba(0,0,0,${Math.min(0.92, 0.55 + dim * 0.5).toFixed(3)}) 100%)`,
            }}
          />
        </>
      ) : (
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(120% 60% at 50% 0%, color-mix(in srgb, var(--accent) 16%, transparent) 0%, transparent 70%)",
          }}
        />
      )}
    </div>
  );
}
