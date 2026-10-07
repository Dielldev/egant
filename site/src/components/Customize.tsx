import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Image, Layers, Palette, SunMoon } from "lucide-react";
import { EFFECTS, GLASS_MODES, THEMES } from "../content";
import type { Effect, GlassMode, Theme } from "../content";
import { prefersReducedMotion, useInView } from "../useReveal";
import { Mark } from "./Mark";
import { Reveal } from "./Reveal";
import { Wallpapers } from "./Wallpapers";

const POINTS = [
  { icon: Palette, title: "23 themes", body: "Catppuccin, Tokyo Night, Dracula, Nord, Rosé Pine, Gruvbox and more — light and dark." },
  { icon: Image, title: "Your wallpaper", body: "Pick any image for the launch screen and set how far it dims." },
  { icon: Layers, title: "Glass", body: "Real macOS vibrancy, frosted, clear, or fully opaque." },
  { icon: SunMoon, title: "Accent & mode", body: "Any accent colour, and separate light and dark themes that follow the system." },
];

/** How much of the theme's own ground shows over the wallpaper, per glass mode. */
const GLASS: Record<GlassMode, { tint: number; blur: number }> = {
  default: { tint: 72, blur: 18 },
  frosted: { tint: 55, blur: 34 },
  clear: { tint: 30, blur: 6 },
  opaque: { tint: 100, blur: 0 },
};

function themeVars(t: Theme, glass: GlassMode): CSSProperties {
  const g = GLASS[glass];
  return {
    "--p-stage": t.stage,
    "--p-ink": t.ink,
    "--p-muted": t.muted,
    "--p-border": t.border,
    "--p-bubble": t.bubble,
    "--p-accent": t.accent,
    "--p-tint": `color-mix(in srgb, ${t.stage} ${g.tint}%, transparent)`,
    "--p-side": `color-mix(in srgb, ${t.stage} ${Math.min(100, g.tint + 12)}%, black ${glass === "opaque" ? 6 : 0}%)`,
    "--p-blur": `${g.blur}px`,
  } as CSSProperties;
}

export function Customize() {
  const [themeIdx, setThemeIdx] = useState(0);
  const [glass, setGlass] = useState<GlassMode>("default");
  const [effect, setEffect] = useState<Effect>("none");
  const [touched, setTouched] = useState(false);
  const [ref, seen] = useInView<HTMLDivElement>(0.3);
  const theme = THEMES[themeIdx];

  // Cycles through the palettes on its own until someone picks one.
  useEffect(() => {
    if (!seen || touched || prefersReducedMotion()) return;
    const t = window.setInterval(() => setThemeIdx((i) => (i + 1) % THEMES.length), 2200);
    return () => window.clearInterval(t);
  }, [seen, touched]);

  const pick = (i: number) => {
    setTouched(true);
    setThemeIdx(i);
  };

  return (
    <section className="section" id="themes">
      <Reveal className="section-head">
        <p className="eyebrow">Appearance</p>
        <h2>
          Make it yours. <span className="dim">Down to the glass.</span>
        </h2>
        <p className="lead">
          Bring your own wallpaper, pick from 23 themes, tune the glass and add a background effect. Your phone uses the same wallpaper.
        </p>
      </Reveal>

      <Wallpapers />

      <div className="customize">
        <Reveal className="preview-wrap">
          <div className="preview" style={themeVars(theme, glass)} ref={ref}>
            <div className="preview-wallpaper" />
            {effect !== "none" && <div className={`fx fx-${effect}`} />}
            <div className="preview-window">
              <aside className="preview-side">
                <div className="preview-brand">
                  <Mark width={14} /> egant
                </div>
                {["Add checkout flow", "Fix flaky tests", "Refactor auth"].map((s, i) => (
                  <div key={s} className={`preview-row ${i === 0 ? "on" : ""}`}>
                    <span className={`preview-dot ${i < 2 ? "live" : ""}`} />
                    {s}
                  </div>
                ))}
              </aside>
              <div className="preview-stage">
                <div className="preview-bubble">Add a checkout page with Stripe test mode.</div>
                <div className="preview-text">
                  On it — scaffolding the route and wiring up <code>useStripe()</code>.
                </div>
                <div className="preview-tool">
                  <span>Edit</span> checkout.tsx <b>+48 −3</b>
                </div>
                <div className="preview-status">
                  <span className="preview-pulse" /> Working…
                </div>
                <div className="preview-composer">
                  Ask anything… <span className="preview-send">↑</span>
                </div>
              </div>
            </div>
            <div className="preview-name glass">{theme.name}</div>
          </div>
        </Reveal>

        <Reveal delay={120} className="controls">
          <div className="control">
            <p className="eyebrow">Theme</p>
            <div className="swatches">
              {THEMES.map((t, i) => (
                <button
                  key={t.id}
                  className={`swatch ${i === themeIdx ? "on" : ""}`}
                  style={{ background: `linear-gradient(135deg, ${t.stage} 50%, ${t.accent} 50%)` }}
                  onClick={() => pick(i)}
                  aria-label={t.name}
                  title={t.name}
                />
              ))}
            </div>
          </div>
          <div className="control">
            <p className="eyebrow">Glass</p>
            <div className="segmented glass">
              {GLASS_MODES.map((g) => (
                <button key={g} className={g === glass ? "on" : ""} onClick={() => setGlass(g)}>
                  {g}
                </button>
              ))}
            </div>
          </div>
          <div className="control">
            <p className="eyebrow">Background effect</p>
            <div className="segmented glass">
              {EFFECTS.map((e) => (
                <button key={e} className={e === effect ? "on" : ""} onClick={() => setEffect(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
          <ul className="points">
            {POINTS.map(({ icon: Icon, title, body }) => (
              <li key={title}>
                <Icon size={16} strokeWidth={1.75} />
                <span>
                  <b>{title}</b> {body}
                </span>
              </li>
            ))}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
