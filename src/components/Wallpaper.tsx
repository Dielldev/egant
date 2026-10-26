import { useEgant } from "../store";

/** Where the launch picture starts to melt into the ground, and where it is
 * gone, as fractions of the stage's height. */
const FADE_FROM = 0.35;
const FADE_TO = 0.91;

/** A mask that is opaque down to `from`, transparent from `to`, and eased
 * between (smoothstep: zero slope at both ends, so there is no visible seam
 * where the fade begins or finishes). */
function fadeToGround(from: number, to: number): string {
  const steps = 10;
  const stops: string[] = [`#000 ${from * 100}%`];
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const alpha = 1 - t * t * (3 - 2 * t);
    stops.push(`rgba(0,0,0,${alpha.toFixed(3)}) ${((from + (to - from) * t) * 100).toFixed(1)}%`);
  }
  stops.push(`transparent ${to * 100}%`);
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/** What sits behind the stage, in the two states the window has.
 *
 * On the launch screen the image reads full-bleed and dissolves into black
 * around the middle of the window. Once a conversation is open the stage
 * carries only `--stage-tint` — a barely-there wash of the palette's stage
 * color — over macOS's real window blur (see `sync_window_appearance`), so
 * the desktop reads through as frosted glass with just enough of the theme's
 * color to still feel like that theme. Appearance > Glass > Opaque clears
 * that native blur, so this falls back to a flat, fully solid `--stage` fill
 * instead. On Linux there is no native vibrancy, so conversation grounds stay
 * solid stage fills (CSS glass still blurs in-window wallpaper). The user's
 * dim setting veils the launch screen only. */
export function Wallpaper({
  launch,
  exiting,
}: {
  launch?: boolean;
  /** The composer just docked: dissolve the picture into the conversation's
   * flat stage tint instead of cutting it out in one frame. */
  exiting?: boolean;
}) {
  const wallpaperUrl = useEgant((s) => s.wallpaperUrl);
  const dim = useEgant((s) => s.snapshot?.settings.wallpaperDim ?? 0.55);
  const bgEffect = useEgant((s) => s.appearance.bgEffect);

  // Conversation state: a barely-there theme tint over the native blur by
  // default, nearly nothing in Clear, or a flat opaque fill once glass is
  // turned off. Platforms with no native desktop blur (linux, and Windows
  // without Acrylic/Mica) swap in a solid stage in CSS — see `.stage-ground`.
  if (!launch) {
    return <div className="stage-ground absolute inset-0" />;
  }

  // Appearance > Background effect: a texture draped over the artwork.
  // (The launch-screen image stays visible in every Glass mode, including
  // No Glass — only the conversation stage goes fully solid there.)
  const effect =
    bgEffect === "none" ? null : (
      <div className={`bg-effect bg-effect-${bgEffect}`} />
    );

  // No picture to show: the same glass ground the conversation has, rather
  // than a solid black pane beside a translucent sidebar. (Only Opaque, and
  // Linux with no native blur, get a flat fill — as in the conversation.)
  if (!wallpaperUrl) {
    return (
      <div className={`stage-ground absolute inset-0 ${exiting ? "dissolve-out" : ""}`} />
    );
  }

  const veil = (dim * 0.4).toFixed(3);
  // The picture fills the stage but only the upper part of it is really
  // shown: it holds at full strength to FADE_FROM, then melts into the blank
  // ground along a smoothstep ramp (no visible start or end to the fade) and is
  // gone by FADE_TO, so the lower part of the window is the theme's own stage
  // color — black in a dark palette, light in a light one — flowing up into the
  // picture rather than the picture running to the bottom edge. The image
  // itself sits taller than the stage and is lifted by 10%, which carries the
  // scene up and away from the composer.
  const sectionFade = fadeToGround(FADE_FROM, FADE_TO);
  return (
    <div
      className={exiting ? "dissolve-out" : undefined}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "var(--stage)",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          overflow: "hidden",
          maskImage: sectionFade,
          WebkitMaskImage: sectionFade,
        }}
      >
        <img
          key={wallpaperUrl}
          src={wallpaperUrl}
          alt=""
          draggable={false}
          className="wallpaper-fade-in"
          style={{
            position: "absolute",
            top: "-10%",
            left: 0,
            display: "block",
            width: "100%",
            height: "110%",
            objectFit: "cover",
            objectPosition: "center 90%",
            userSelect: "none",
          }}
        />
        {effect}
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: `rgba(0,0,0,${veil})`,
          }}
        />
      </div>
    </div>
  );
}
