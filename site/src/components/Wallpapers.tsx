import { useEffect, useState } from "react";
import { WALLPAPERS } from "../content";
import { prefersReducedMotion } from "../useReveal";
import { Reveal } from "./Reveal";

/** Real launch screens with different wallpapers, slowly cross-fading. */
export function Wallpapers() {
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (held || prefersReducedMotion()) return;
    const t = window.setInterval(() => setActive((i) => (i + 1) % WALLPAPERS.length), 4200);
    return () => window.clearInterval(t);
  }, [held]);

  return (
    <Reveal className="wallpapers">
      <div className="wallpaper-frame glass">
        {WALLPAPERS.map((w, i) => (
          <img
            key={w.name}
            src={w.src}
            alt={`egant's launch screen with the ${w.name} wallpaper`}
            loading="lazy"
            className={i === active ? "on" : ""}
          />
        ))}
        <div className="wallpaper-label glass">
          Wallpaper · <span>{WALLPAPERS[active].name}</span> · scanlines
        </div>
      </div>
      <div className="wallpaper-thumbs">
        {WALLPAPERS.map((w, i) => (
          <button
            key={w.name}
            className={`wallpaper-thumb glass ${i === active ? "on" : ""}`}
            onClick={() => {
              setActive(i);
              setHeld(true);
            }}
            aria-label={`Show the ${w.name} wallpaper`}
          >
            <img src={w.src} alt="" loading="lazy" />
          </button>
        ))}
      </div>
    </Reveal>
  );
}
