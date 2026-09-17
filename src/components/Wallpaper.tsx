import { useEgant } from "../store";

/** What sits behind the stage, in the two states the window has.
 *
 * On the launch screen the image reads full-bleed and dissolves into black
 * around the middle of the window. Once a conversation is open the stage
 * carries only `--stage-tint` — a barely-there wash of the palette's stage
 * color — over macOS's real window blur (see `sync_window_appearance`), so
 * the desktop reads through as frosted glass with just enough of the theme's
 * color to still feel like that theme. Appearance > Glass > Opaque clears
 * that native blur, so this falls back to a flat, fully solid `--stage` fill
 * instead. The user's dim setting veils the launch screen only. */
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
  const glass = useEgant((s) => s.appearance.glass);

  // Conversation state: a barely-there theme tint over the native blur by
  // default, nearly nothing in Clear, or a flat opaque fill once glass is
  // turned off.
  if (!launch) {
    return (
      <div
        className="absolute inset-0"
        style={{
          background:
            glass === "opaque"
              ? "var(--stage)"
              : glass === "clear"
                ? "transparent"
                : "var(--stage-tint)",
        }}
      />
    );
  }

  // Appearance > Background effect: a texture draped over the artwork.
  // (The launch-screen image stays visible in every Glass mode, including
  // No Glass — only the conversation stage goes fully solid there.)
  const effect =
    bgEffect === "none" ? null : (
      <div className={`bg-effect bg-effect-${bgEffect}`} />
    );

  if (!wallpaperUrl) {
    return (
      <div className={`absolute inset-0 bg-[var(--stage)] ${exiting ? "dissolve-out" : ""}`}>
        <div
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(to bottom, transparent 0%, transparent 30%, #000 60%, #000 100%)",
          }}
        />
      </div>
    );
  }

  const veil = (dim * 0.4).toFixed(3);
  // Split structure (pure CSS, no Tailwind): the image element only lives in
  // the top 88% — nothing image-related below that, just blank black ground.
  // The bottom of that top section feather-melts into the blank with a long
  // eased ramp (mask + multi-stop scrim), so the dissolve reads smooth with
  // no straight-line seam.
  const sectionFade =
    "linear-gradient(to bottom, #000 0%, #000 45%, transparent 100%)";
  return (
    <div
      className={exiting ? "dissolve-out" : undefined}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        background: "#000",
      }}
    >
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "88%",
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
            display: "block",
            width: "100%",
            height: "100%",
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
            background: `linear-gradient(to bottom, rgba(0,0,0,${veil}) 0%, rgba(0,0,0,${veil}) 30%, rgba(0,0,0,0.55) 65%, rgba(0,0,0,0.9) 88%, #000 100%)`,
          }}
        />
      </div>
    </div>
  );
}
